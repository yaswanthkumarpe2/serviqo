import { useState } from "react";

import { TagIcon } from "@/features/workspace/workspaceIcons";

/**
 * The tags on the open conversation, editable in place (ADR-042 §3).
 *
 * The client normalises the way the server does — lowercase, single spaces —
 * so what the agent sees after pressing Enter is what will be stored.
 */

interface ConversationTagsProps {
  tags: string[];
  suggestions: string[];
  disabled: boolean;
  onChange: (tags: string[]) => void;
}

const TAG_PATTERN = /^[a-z0-9]+(?:[ _-][a-z0-9]+)*$/;
const MAX_TAGS = 10;

function normalizeTag(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, " ");
}

export function ConversationTags({ tags, suggestions, disabled, onChange }: ConversationTagsProps) {
  const [draft, setDraft] = useState("");
  const [problem, setProblem] = useState<string | null>(null);

  function add() {
    const tag = normalizeTag(draft);
    if (tag.length === 0) return;
    if (!TAG_PATTERN.test(tag) || tag.length > 32) {
      setProblem("Tags use letters, numbers, spaces, - and _ (up to 32).");
      return;
    }
    if (tags.length >= MAX_TAGS && !tags.includes(tag)) {
      setProblem(`A conversation can have up to ${MAX_TAGS} tags.`);
      return;
    }
    setProblem(null);
    setDraft("");
    if (!tags.includes(tag)) onChange([...tags, tag]);
  }

  return (
    <div className="inbox__tags">
      <TagIcon aria-hidden="true" className="inbox__tagsIcon" />
      <ul className="inbox__tagList" aria-label="Tags">
        {tags.map((tag) => (
          <li key={tag} className="inbox__tag">
            {tag}
            <button
              type="button"
              className="inbox__tagRemove"
              aria-label={`Remove tag ${tag}`}
              disabled={disabled}
              onClick={() => onChange(tags.filter((existing) => existing !== tag))}
            >
              ×
            </button>
          </li>
        ))}
      </ul>
      <label className="inbox__srOnly" htmlFor="inbox-add-tag">
        Add a tag
      </label>
      <input
        id="inbox-add-tag"
        className="inbox__tagInput"
        list="inbox-tag-suggestions"
        placeholder={tags.length === 0 ? "Add a tag" : "Add"}
        value={draft}
        disabled={disabled}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === ",") {
            event.preventDefault();
            add();
          }
        }}
        onBlur={add}
      />
      <datalist id="inbox-tag-suggestions">
        {suggestions
          .filter((tag) => !tags.includes(tag))
          .map((tag) => (
            <option key={tag} value={tag} />
          ))}
      </datalist>
      {problem !== null && (
        <p className="inbox__tagProblem" role="alert">
          {problem}
        </p>
      )}
    </div>
  );
}
