import { useEffect, useRef, useState } from "react";

import type { ConversationFilters } from "./inboxApi";

/**
 * Search and filters above the conversation list (ADR-042 §3–4).
 *
 * The search box waits for a short pause in typing before asking the server,
 * and needs at least two characters — the server's own minimum — so a single
 * keystroke never becomes a request.
 */

interface InboxFiltersProps {
  filters: ConversationFilters;
  onChange: (next: ConversationFilters) => void;
  tags: string[];
  isFiltering: boolean;
}

export const INBOX_SEARCH_INPUT_ID = "inbox-search";
const SEARCH_DELAY_MS = 300;

export function InboxFilters({ filters, onChange, tags, isFiltering }: InboxFiltersProps) {
  const [query, setQuery] = useState(filters.q ?? "");
  const latest = useRef({ filters, onChange });

  useEffect(() => {
    latest.current = { filters, onChange };
  });

  useEffect(() => {
    const trimmed = query.trim();
    const wanted = trimmed.length >= 2 ? trimmed : undefined;
    if (wanted === latest.current.filters.q) return;
    const timer = setTimeout(() => {
      const { filters: current, onChange: change } = latest.current;
      const next = { ...current };
      if (wanted === undefined) delete next.q;
      else next.q = wanted;
      change(next);
    }, SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [query]);

  function set<K extends keyof ConversationFilters>(key: K, value: ConversationFilters[K] | "") {
    const next = { ...filters };
    if (value === "" || value === undefined) delete next[key];
    else next[key] = value as ConversationFilters[K];
    onChange(next);
  }

  return (
    <div className="inbox__filters" role="search">
      <label className="inbox__srOnly" htmlFor={INBOX_SEARCH_INPUT_ID}>
        Search conversations
      </label>
      <input
        id={INBOX_SEARCH_INPUT_ID}
        type="search"
        className="inbox__search"
        placeholder="Search name, email or message…  ( / )"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            setQuery("");
            event.currentTarget.blur();
          }
        }}
      />

      <div className="inbox__filterRow">
        <div className="inbox__segmented" role="group" aria-label="Assignee">
          {(
            [
              ["", "All"],
              ["me", "Mine"],
              ["unassigned", "Unassigned"],
            ] as const
          ).map(([value, label]) => (
            <button
              key={label}
              type="button"
              className="inbox__segment"
              aria-pressed={(filters.assignee ?? "") === value}
              onClick={() => set("assignee", value)}
            >
              {label}
            </button>
          ))}
        </div>

        <label className="inbox__srOnly" htmlFor="inbox-status-filter">
          Status
        </label>
        <select
          id="inbox-status-filter"
          className="inbox__select"
          value={filters.status ?? ""}
          onChange={(event) => set("status", event.target.value as ConversationFilters["status"] | "")}
        >
          <option value="">Any status</option>
          <option value="open">Open</option>
          <option value="closed">Closed</option>
        </select>

        {tags.length > 0 && (
          <>
            <label className="inbox__srOnly" htmlFor="inbox-tag-filter">
              Tag
            </label>
            <select
              id="inbox-tag-filter"
              className="inbox__select"
              value={filters.tag ?? ""}
              onChange={(event) => set("tag", event.target.value)}
            >
              <option value="">Any tag</option>
              {tags.map((tag) => (
                <option key={tag} value={tag}>
                  {tag}
                </option>
              ))}
            </select>
          </>
        )}

        {isFiltering && (
          <span className="inbox__filtering" role="status">
            Updating…
          </span>
        )}
      </div>
    </div>
  );
}
