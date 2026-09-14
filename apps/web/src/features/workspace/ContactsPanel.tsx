import type { WorkspaceContact } from "./useWorkspaceOverview";

/**
 * The people this organization has actually talked to (ADR-033 §6).
 *
 * Derived from conversations rather than read from a contact book, because
 * Serviqo has no contact book: `Customer` is created by the widget when a
 * visitor first writes in (ADR-019), and the only way to know one exists is
 * that they have a conversation. The panel says so in its own subtitle rather
 * than implying an address list nobody has imported.
 *
 * Read-only, and that is the honest shape of it. There is no endpoint to
 * rename a customer, merge two of them, or add a note — so there are no
 * controls here that would 404 on click.
 */

interface ContactsPanelProps {
  contacts: WorkspaceContact[];
  isLoading: boolean;
  /** False when the figures cover only the most recent page of conversations. */
  isComplete: boolean;
}

export function ContactsPanel({ contacts, isLoading, isComplete }: ContactsPanelProps) {
  return (
    <section className="ws__panel" aria-labelledby="ws-contacts-heading">
      <div className="ws__panelHead">
        <h2 className="ws__sectionTitle" id="ws-contacts-heading">
          Contacts
        </h2>
        {!isLoading && contacts.length > 0 && (
          <span className="ws__muted">
            {contacts.length} {contacts.length === 1 ? "person" : "people"}
          </span>
        )}
      </div>

      <p className="ws__muted ws__panelLede">
        Everyone who has written in from your website. Serviqo creates a contact the first time somebody starts a
        chat — there is nothing to import.
      </p>

      {isLoading ? (
        <p className="ws__muted" role="status">
          Loading contacts…
        </p>
      ) : contacts.length === 0 ? (
        <div className="ws__empty">
          <p className="ws__emptyTitle">No contacts yet</p>
          <p className="ws__muted">The first visitor to use your widget appears here.</p>
        </div>
      ) : (
        <>
          <div className="ws__tableWrap">
            <table className="ws__table">
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col">Email</th>
                  <th scope="col" className="ws__num">
                    Conversations
                  </th>
                  <th scope="col">Last in touch</th>
                </tr>
              </thead>
              <tbody>
                {contacts.map((contact) => (
                  <tr key={contact.id}>
                    <td>
                      {/*
                        Never invented. A visitor who gave no name is shown as
                        an anonymous visitor, which is what they are — putting
                        their email or an id in the name column would be this
                        client fabricating an identity the customer withheld.
                      */}
                      <span className="ws__strong">{contact.name ?? "Anonymous visitor"}</span>
                    </td>
                    <td className="ws__mono">{contact.email ?? "—"}</td>
                    <td className="ws__num">{contact.conversationCount}</td>
                    <td className="ws__muted">{formatDate(contact.lastMessageAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {!isComplete && (
            <p className="ws__note">
              Built from the most recent conversations — this organization has more than one page of them, so
              older contacts are not listed yet.
            </p>
          )}
        </>
      )}
    </section>
  );
}

/** Guarded, for the reason the overview's formatter is: the value comes off the wire. */
function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}
