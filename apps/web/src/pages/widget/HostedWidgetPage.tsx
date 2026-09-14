import { useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";

import { BrandMark } from "@/components/ui/icons";
import {
  ChatLinkNotFoundError,
  fetchWidgetDirectoryEntry,
} from "@/features/hostedChat/widgetDirectoryApi";
import { initWidget } from "@/widget/widget";

import type { WidgetDirectoryEntry } from "@/features/hostedChat/widgetDirectoryApi";
import type { InitWidgetOptions } from "@/widget/widget";

import "./HostedWidgetPage.css";

/**
 * An organisation's customer chat link: `/widget/<slug>` (ADR-038 §6).
 *
 * The whole customer experience in Serviqo. A person opens the link their
 * support team gave them, and is talking to that organisation — no sign-up, no
 * sign-in, no code, no password (ADR-037). The link decides the organisation;
 * nothing on this page lets them see or reach any other.
 *
 * Two steps, both of which already existed for the embed:
 *
 * 1. The slug is looked up to find the organisation's name and widget key.
 * 2. The widget core mounts full-page with that key. From there it is the
 *    embed's own code — anonymous session, remembered visitor, conversation,
 *    live replies — presented as a page instead of a bubble.
 *
 * Deliberately ungated and outside every auth guard. A staff member who opens
 * their own organisation's link while signed in sees exactly what a customer
 * sees, which is the point of opening it.
 */

type PageState =
  | { status: "loading" }
  | { status: "ready"; entry: WidgetDirectoryEntry }
  | { status: "not_found" }
  | { status: "unavailable" };

export interface HostedWidgetPageProps {
  /** Injected by tests so the socket runs against a fake. */
  widgetOptions?: Pick<InitWidgetOptions, "socketFactory">;
}

export function HostedWidgetPage({ widgetOptions }: HostedWidgetPageProps) {
  const { slug = "" } = useParams<{ slug: string }>();
  const [state, setState] = useState<PageState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const chatContainer = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const controller = new AbortController();

    fetchWidgetDirectoryEntry(slug, controller.signal)
      .then((entry) => setState({ status: "ready", entry }))
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setState({ status: error instanceof ChatLinkNotFoundError ? "not_found" : "unavailable" });
      });

    return () => controller.abort();
  }, [slug, attempt]);

  const entry = state.status === "ready" ? state.entry : null;

  /*
    The widget owns its own DOM inside a shadow root, so React hands it a
    container and stays out of it. Keyed on the widget key: a different
    organisation is a different mount, never the same one re-pointed.
  */
  useEffect(() => {
    if (entry === null || chatContainer.current === null) return;

    const origin = window.location.origin;
    const handle = initWidget(
      { widgetKey: entry.widgetKey, apiBase: `${origin}/api/v1/widget`, socketOrigin: origin },
      { ...widgetOptions, presentation: "page", container: chatContainer.current, title: entry.name },
    );

    return () => handle?.destroy();
    // widgetOptions is a test seam fixed for the page's life.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entry?.widgetKey, entry?.name]);

  useEffect(() => {
    document.title = entry !== null ? `Chat with ${entry.name}` : "Chat";
  }, [entry]);

  return (
    <div className="hostedChat">
      <header className="hostedChat__bar">
        {/*
          The organisation leads once the link has resolved. Before that — and
          for a link that leads nowhere — there is no organisation to name, so
          Serviqo's own mark holds the space rather than an empty badge.
        */}
        {entry !== null ? (
          <>
            <span className="hostedChat__org">
              <span className="hostedChat__orgMark" aria-hidden="true">
                {initialOf(entry.name)}
              </span>
              <span className="hostedChat__orgName">{entry.name}</span>
            </span>
            <span className="hostedChat__poweredBy">
              <span className="brand__mark hostedChat__brandMark" aria-hidden="true">
                <BrandMark />
              </span>
              Powered by Serviqo
            </span>
          </>
        ) : (
          <span className="brand">
            <span className="brand__mark" aria-hidden="true">
              <BrandMark />
            </span>
            Serviqo
          </span>
        )}
      </header>

      <main className="hostedChat__main">
        {state.status === "loading" && (
          <p className="hostedChat__state" role="status">
            Opening chat…
          </p>
        )}

        {state.status === "not_found" && (
          <div className="hostedChat__state" role="alert">
            <h1 className="hostedChat__stateTitle">This chat isn&rsquo;t available</h1>
            <p>Check the link you were given, or contact the organisation another way.</p>
          </div>
        )}

        {state.status === "unavailable" && (
          <div className="hostedChat__state" role="alert">
            <h1 className="hostedChat__stateTitle">We couldn&rsquo;t connect</h1>
            <p>Check your connection and try again.</p>
            <button type="button" className="hostedChat__retry" onClick={() => setAttempt((n) => n + 1)}>
              Try again
            </button>
          </div>
        )}

        {entry !== null && (
          <div className="hostedChat__chat" ref={chatContainer} aria-label={`Chat with ${entry.name}`} />
        )}
      </main>
    </div>
  );
}

function initialOf(name: string): string {
  return name.trim().charAt(0).toUpperCase();
}
