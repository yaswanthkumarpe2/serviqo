import { InsufficientPermissionError, NotFoundError } from "../lib/errors";
import { customerRepository } from "../modules/customers/customer.repository";
import { organizationRepository } from "../modules/organizations/organization.repository";
import { userRepository } from "../modules/users/user.repository";

import type { RequestHandler } from "express";

/**
 * The signed-in customer boundary (ADR-034 §4).
 *
 * Turns "who is calling" into "which Customer, in which tenant" — the pair
 * every conversation and message service already takes. It is the
 * authenticated sibling of `requireWidgetToken`, which does the same job for
 * an anonymous visitor holding a widget token.
 *
 * Mounted after `requireAccessToken`:
 *
 *   router.get("/conversations", requireAccessToken, requireCustomerAccount, handler)
 *
 * so "who may reach this route?" is answered by reading the route file.
 *
 * The customer record is resolved or CREATED here, lazily, rather than at
 * registration. Registration happens before any organization may exist and
 * before the person has said anything, and a customer row created at that
 * moment would be a record of somebody who has never been in touch. Creating
 * it on first use means the collection holds people who actually arrived.
 */

/** One message for every refusal, so no branch is distinguishable by its text. */
const GENERIC_FAILURE_MESSAGE = "You do not have permission to perform this action";

/**
 * Said when the deployment has no organization for customers to talk to.
 *
 * Its own message, and a 404 rather than a 403, because it is the one refusal
 * here that is not about the caller at all — nothing they can do changes it,
 * and telling them "no permission" would send them looking for a mistake they
 * did not make.
 */
const NO_ORGANIZATION_MESSAGE = "Support is not available yet.";

type RefusalReason = "no_principal" | "unknown_user" | "user_not_entitled" | "not_a_customer";

export const requireCustomerAccount: RequestHandler = async (req, _res, next) => {
  function refuse(reason: RefusalReason): void {
    req.log.info(
      { event: "auth.customer_account.denied", reason, userId: req.principal?.userId },
      "Request refused at the customer-account boundary",
    );
    next(new InsufficientPermissionError(GENERIC_FAILURE_MESSAGE));
  }

  const userId = req.principal?.userId;
  if (userId === undefined) {
    return refuse("no_principal");
  }

  const user = await userRepository.findById(userId);
  if (user === null) {
    return refuse("unknown_user");
  }

  /*
    The same exists/active/verified gate every other authenticated surface
    applies (ADR-015 §7). A valid signature identifies a user; it does not
    entitle them, and an account that has been disabled stops being served on
    its very next request rather than at token expiry.
  */
  if (user.status !== "active" || user.emailVerifiedAt === null) {
    return refuse("user_not_entitled");
  }

  /*
    An AGENT reaching the customer surface is refused rather than quietly
    given a customer record of their own. They have an inbox; this is the
    other side of it, and letting one account hold both roles would make
    "who sent this message" a question with two answers.
  */
  if (user.kind !== "customer") {
    return refuse("not_a_customer");
  }

  const organization = await organizationRepository.findDefaultForCustomers();
  if (organization === null) {
    return next(new NotFoundError(NO_ORGANIZATION_MESSAGE));
  }

  const organizationId = organization._id.toString();

  /*
    Resolve, or create once. The unique partial index on
    `{ organizationId, userId }` is the authority here, not this lookup: two
    simultaneous first requests both find nothing and both try to create, and
    the index is what stops the second from succeeding. The retry below turns
    that loss into the same answer the winner got.
  */
  let customer = await customerRepository.findByUserAndOrganization(userId, organizationId);

  if (customer === null) {
    try {
      customer = await customerRepository.create({
        organizationId,
        userId,
        // Copied from the account, so an agent sees a name rather than an id.
        // Not a lookup key in either direction — see `customer.model.ts`.
        name: user.name,
        email: user.email,
      });
    } catch {
      /*
        Lost the race. Re-reading is the whole recovery: the winner's document
        is the one that exists, and both requests must end up pointing at it
        rather than at two customers for one person.
      */
      customer = await customerRepository.findByUserAndOrganization(userId, organizationId);
      if (customer === null) {
        return refuse("not_a_customer");
      }
    }
  }

  req.customerContext = { customerId: customer._id.toString(), organizationId };
  next();
};
