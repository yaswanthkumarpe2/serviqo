import { INBOX_SHORTCUTS } from "./useInboxShortcuts";

/** The list the `?` shortcut opens (ADR-042 §5). */
export function ShortcutsHelp({ onClose }: { onClose: () => void }) {
  return (
    <div className="inbox__shortcuts" role="dialog" aria-modal="false" aria-labelledby="inbox-shortcuts-title">
      <div className="inbox__shortcutsHead">
        <h3 id="inbox-shortcuts-title" className="inbox__shortcutsTitle">
          Keyboard shortcuts
        </h3>
        <button type="button" className="inbox__tagRemove" aria-label="Close keyboard shortcuts" onClick={onClose}>
          ×
        </button>
      </div>
      <dl className="inbox__shortcutList">
        {INBOX_SHORTCUTS.map((shortcut) => (
          <div key={shortcut.keys} className="inbox__shortcutRow">
            <dt>
              <kbd>{shortcut.keys}</kbd>
            </dt>
            <dd>{shortcut.action}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
