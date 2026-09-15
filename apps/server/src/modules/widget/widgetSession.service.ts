import { generateSecret, sha256 } from "../../lib/crypto/tokens";
import { env } from "../../lib/env";
import { WidgetSessionRefusedError } from "../../lib/errors";
import { logger } from "../../lib/logger";
import { customerRepository } from "../customers/customer.repository";
import { organizationRepository } from "../organizations/organization.repository";
import { normalizeOrigin } from "../organizations/widgetConfig";
import { toPublicChatSettings } from "../organizations/widgetAppearance";
import { agentPresence } from "../../realtime/presence";
import { decideOrigin } from "./originPolicy";
import { issueWidgetToken, verifyWidgetToken } from "./widgetToken";

import type { AuthLogger } from "../auth/authLogging";
import type { CustomerDocument } from "../customers/customer.model";
import type { CreateWidgetSessionInput } from "./widget.validation";

/**
 * Opening a widget session (ADR-019 §6, §10, §12) — the operation that turns
 * a public widget key into a visitor credential.
 *
 * The complete flow, and every step is a gate:
 *
 *   widget key -> organization -> active? -> origin allowed?
 *              -> resume or create Customer -> issue token -> minimal response
 *
 * `AuthLogger` is imported from the auth module rather than duplicated,
 * following `organizationOnboarding.service.ts`. The name is now doubly wrong
 * for a customer-facing service; ADR-016 §9 already fixed that it moves to
 * `lib/` when a third domain needs it, and this is that third domain — but
 * moving it here would churn nine auth files inside a slice that has no other
 * reason to touch them.
 */

/** One message for every refusal, so no branch is distinguishable by its text. */
const GENERIC_FAILURE_MESSAGE = "This chat widget is not available.";

/**
 * Serviqo's own origin, where every organisation's hosted chat link is served
 * (ADR-038 §2). Computed once: `CLIENT_URL` is read at boot and does not
 * change underneath a running process.
 */
const FIRST_PARTY_ORIGIN = normalizeOrigin(env.CLIENT_URL);

/**
 * Why a session was refused. Reaches the log and NEVER a response body
 * (ADR-019 §12) — `unknown_widget_key` in particular is the one that would
 * turn this endpoint into a tenant-enumeration oracle.
 */
type RefusalReason =
  | "unknown_widget_key"
  | "organization_not_active"
  | "origin_not_allowed"
  | "origin_malformed"
  | "customer_blocked";

/** What the widget learns. Deliberately small — see `toSessionCustomer` below. */
export interface WidgetSessionCustomer {
  id: string;
  name: string | null;
  email: string | null;
  phone: string | null;
}

export interface WidgetSessionResult {
  token: string;
  expiresInSeconds: number;
  customer: WidgetSessionCustomer;
  /**
   * The visitor's long-lived key, present ONLY on the response that minted it
   * (ADR-038 §3). The browser stores it; the server keeps only its hash, so it
   * can never be sent again — a response that echoed it on every session would
   * put a durable credential in every response a proxy might log.
   */
  visitorKey?: string;
  /** How the chat looks and whether anyone is available (ADR-040 §1–2), so an embed needs no second request. */
  appearance: ReturnType<typeof toPublicChatSettings>["appearance"];
  availability: ReturnType<typeof toPublicChatSettings>["availability"];
}

/** What the request carried outside its body. The header is a claim, not an identity. */
export interface WidgetSessionContext {
  /** The `Origin` header, verbatim and untrusted. `undefined` when absent. */
  origin: string | undefined;
}

export interface WidgetSessionService {
  createSession(
    input: CreateWidgetSessionInput,
    context: WidgetSessionContext,
    log?: AuthLogger,
  ): Promise<WidgetSessionResult>;
}

/**
 * Projects a customer document down to what a widget needs.
 *
 * An allowlist rather than a redaction: fields are named in, so a field added
 * to the model later cannot appear here by default. `organizationId`,
 * `lastSeenAt`, `createdAt`, `updatedAt`, and `__v` are all absent
 * deliberately — the token already binds the tenant, so the client has no use
 * for its id and no business holding one (ADR-019 §12).
 *
 * `id` is the caller's OWN identifier — the subject of the token they are
 * holding — so returning it discloses nothing to the party receiving it, and
 * it is the handle that makes a support report actionable.
 */
function toSessionCustomer(customer: CustomerDocument): WidgetSessionCustomer {
  return {
    id: customer._id.toString(),
    name: customer.name,
    email: customer.email,
    phone: customer.phone,
  };
}

export function createWidgetSessionService(): WidgetSessionService {
  return {
    async createSession(
      input: CreateWidgetSessionInput,
      context: WidgetSessionContext,
      log: AuthLogger = logger,
    ): Promise<WidgetSessionResult> {
      function refuse(reason: RefusalReason, organizationId?: string): never {
        /*
          The distinctions exist here, for operators, and nowhere else.

          Safe fields only: an event name, the reason, and — where one was
          resolved — a server-side organization id. Deliberately absent: the
          widget key (it identifies a tenant and is a value someone
          configured), the visitor token and the issued token (both
          credentials), and the name or email the visitor typed
          (ADR-019 §12).
        */
        log.info(
          {
            event: "widget.session.refused",
            reason,
            ...(organizationId === undefined ? {} : { organizationId }),
          },
          "Widget session refused",
        );
        throw new WidgetSessionRefusedError(GENERIC_FAILURE_MESSAGE);
      }

      /*
        THE tenant resolution, and the only one. ADR-010 §7: organizationId is
        derived server-side from the widget credential, never read from the
        request body. `widget.validation.ts` makes the body incapable of
        carrying one; this is where the server supplies it instead.
      */
      const organization = await organizationRepository.findByWidgetKey(input.widgetKey);

      if (organization === null) {
        return refuse("unknown_widget_key");
      }

      /*
        A suspended tenant serves nobody. Checked here rather than trusted
        from the key, because a key stays valid across a suspension — it is an
        identifier, and suspending an organization must not require rotating
        every embed on the tenant's website.
      */
      if (organization.status !== "active") {
        return refuse("organization_not_active", organization._id.toString());
      }

      /*
        The origin is checked AFTER the tenant is resolved, because the list is
        per-tenant — and the header is compared against it rather than used to
        find it. Checked BEFORE any customer is created, so a disallowed
        origin cannot write a document.
      */
      const originDecision = decideOrigin(context.origin, organization.allowedOrigins, FIRST_PARTY_ORIGIN);
      if (!originDecision.allowed) {
        return refuse(originDecision.reason, organization._id.toString());
      }

      const organizationId = organization._id.toString();
      const details = { name: input.name, email: input.email, phone: input.phone };

      /*
        Resume, or start fresh (ADR-019 §6).

        Every failure to resume falls through to creating a new anonymous
        customer, and NONE of them is an error. A browser holding tenant A's
        token and then visiting tenant B's website is completely ordinary, and
        the correct outcome is that A's token buys nothing in B — a new B
        customer — rather than a refusal that would tell the caller their
        token was recognised.

        Three independent things must hold to resume, and the last is the
        cross-tenant control:

        1. The token verifies: signature under the WIDGET key, pinned HS256,
           issuer, audience, expiry, and well-formed claims.
        2. Its `org` claim equals the tenant the WIDGET KEY resolved. The
           claim is compared, never trusted to select — which is why a token
           from A cannot reach into B by asserting B.
        3. The customer still exists inside that tenant, proved by a query
           carrying both ids (`findByIdAndOrganization`), never by a fetch
           followed by a comparison.
      */
      let customer: CustomerDocument | null = null;

      if (input.visitorToken !== undefined) {
        const principal = await verifyWidgetToken(input.visitorToken);

        if (principal !== null && principal.organizationId === organizationId) {
          customer = await customerRepository.recordVisit(principal.customerId, organizationId, details);
        }
      }

      /*
        The second way back (ADR-038 §3): the visitor key. Tried only when the
        token did not resume, so a visitor with a live token never has their
        key looked at. Scoped by `organizationId` inside the query, so a key
        from another organisation matches nothing here and falls through to a
        new customer, exactly as a foreign token does.
      */
      if (customer === null && input.visitorKey !== undefined) {
        customer = await customerRepository.recordVisitByVisitorKey(sha256(input.visitorKey), organizationId, details);
      }

      /*
        A merged record points at the customer it became (ADR-043 §4). One hop,
        inside this organisation: the visitor on the duplicate's device carries
        on as the merged customer.
      */
      if (customer !== null && customer.mergedIntoCustomerId !== null) {
        customer = await customerRepository.findByIdAndOrganization(customer.mergedIntoCustomerId, organizationId);
      }

      /*
        A blocked visitor is refused, not given a fresh identity (ADR-043 §3).
        Clearing the browser's storage does start a new anonymous visitor —
        that is the nature of chat without accounts, and the ADR says so.
      */
      if (customer !== null && customer.blockedAt !== null) {
        return refuse("customer_blocked", organizationId);
      }

      const resumed = customer !== null;
      let visitorKey: string | undefined;

      if (customer === null) {
        visitorKey = generateSecret();
        customer = await customerRepository.create({
          organizationId,
          name: input.name ?? null,
          email: input.email ?? null,
          phone: input.phone ?? null,
          visitorKeyHash: sha256(visitorKey),
        });
      } else if (input.visitorKey === undefined) {
        /*
          Resumed by token, and the browser offered no key: most likely a
          customer from before ADR-038. Give them one now, so next week works
          too. `attachVisitorKey` is set-once, and a `false` (another tab won)
          means the key is not handed out — a key the database did not store
          would be a credential for nothing.
        */
        const candidate = generateSecret();
        if (await customerRepository.attachVisitorKey(customer._id, organizationId, sha256(candidate))) {
          visitorKey = candidate;
        }
      }

      const customerId = customer._id.toString();

      const { token, expiresInSeconds } = await issueWidgetToken({ customerId, organizationId });

      /*
        Server-side identifiers only. The token is NOT logged — not here, not
        at debug, not ever — because it is a credential, and neither is the
        name or email the visitor supplied, because those are the person's
        own data and this line triages nothing with them. Whether the session
        resumed IS logged: it is the one fact that explains why a tenant's
        customer count did or did not grow.
      */
      log.info(
        { event: "widget.session.created", organizationId, customerId, resumed },
        "Widget session issued",
      );

      return {
        token,
        expiresInSeconds,
        customer: toSessionCustomer(customer),
        ...(visitorKey === undefined ? {} : { visitorKey }),
        ...toPublicChatSettings(organization, agentPresence.isOnline(organizationId)),
      };
    },
  };
}
