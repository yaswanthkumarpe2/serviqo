/**
 * The widget's own stylesheet, scoped entirely to its shadow root
 * (ADR-021 §3). Nothing here can leak onto the host page, and nothing on
 * the host page can reach in — no descendant selector crosses a shadow
 * boundary in either direction.
 *
 * Colors match `PROJECT_CONTEXT.md` §20's approved palette (Canvas, Surface,
 * Text, Brand Emerald). Typography is a system-font stack rather than the
 * dashboard's Google-Fonts import: pulling a third-party font request into
 * every tenant's visitor's page is a network dependency and a privacy
 * exposure this bundle does not need to add (ADR-021 §2).
 */
export const WIDGET_STYLES = `
  :host, * {
    box-sizing: border-box;
  }

  .root {
    --sq-canvas: #F7F8F5;
    --sq-surface: #FFFFFF;
    --sq-text: #17211D;
    --sq-brand: #14684A;
    --sq-brand-dark: #0F4F38;
    --sq-border: #E3E6E1;
    --sq-muted: #5B665F;
    --sq-error: #B3261E;

    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    color: var(--sq-text);
    position: fixed;
    inset: auto 20px 20px auto;
    z-index: 2147483000;
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 12px;
  }

  .launcher {
    width: 56px;
    height: 56px;
    border-radius: 999px;
    border: none;
    background: var(--sq-brand);
    color: #fff;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    box-shadow: 0 8px 24px rgba(23, 33, 29, 0.24);
    transition: background-color 120ms ease, transform 120ms ease;
  }
  .launcher:hover {
    background: var(--sq-brand-dark);
    transform: translateY(-1px);
  }
  .launcher:focus-visible {
    outline: 2px solid var(--sq-brand-dark);
    outline-offset: 3px;
  }
  .launcher svg {
    width: 26px;
    height: 26px;
  }

  .panel {
    width: 360px;
    max-width: calc(100vw - 40px);
    max-height: min(560px, calc(100vh - 100px));
    background: var(--sq-surface);
    border: 1px solid var(--sq-border);
    border-radius: 16px;
    box-shadow: 0 16px 48px rgba(23, 33, 29, 0.2);
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  .panel[hidden] {
    display: none;
  }

  .panel__header {
    background: var(--sq-brand);
    color: #fff;
    padding: 16px 16px 14px;
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 8px;
  }
  .panel__title {
    margin: 0;
    font-size: 15px;
    font-weight: 600;
  }
  .panel__subtitle {
    margin: 2px 0 0;
    font-size: 12.5px;
    color: rgba(255, 255, 255, 0.85);
  }
  .panel__close {
    background: transparent;
    border: none;
    color: #fff;
    cursor: pointer;
    padding: 4px;
    border-radius: 6px;
    display: flex;
    line-height: 0;
  }
  .panel__close:hover {
    background: rgba(255, 255, 255, 0.16);
  }
  .panel__close:focus-visible {
    outline: 2px solid #fff;
    outline-offset: 2px;
  }

  .panel__body {
    padding: 20px 18px;
    overflow-y: auto;
    flex: 1;
    background: var(--sq-canvas);
  }

  .state {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 8px;
  }
  .state h3 {
    margin: 0;
    font-size: 17px;
    font-weight: 600;
  }
  .state p {
    margin: 0;
    font-size: 13.5px;
    color: var(--sq-muted);
    line-height: 1.5;
  }

  .spinner {
    width: 22px;
    height: 22px;
    border-radius: 999px;
    border: 2.5px solid var(--sq-border);
    border-top-color: var(--sq-brand);
    animation: sq-spin 700ms linear infinite;
    margin-bottom: 4px;
  }
  @keyframes sq-spin {
    to { transform: rotate(360deg); }
  }

  .error p {
    color: var(--sq-error);
  }

  .retry {
    margin-top: 4px;
    background: var(--sq-brand);
    color: #fff;
    border: none;
    border-radius: 8px;
    padding: 8px 14px;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
  }
  .retry:hover {
    background: var(--sq-brand-dark);
  }
  .retry:focus-visible {
    outline: 2px solid var(--sq-brand-dark);
    outline-offset: 2px;
  }

  .details {
    margin-top: 14px;
    width: 100%;
    border-top: 1px solid var(--sq-border);
    padding-top: 12px;
  }
  .details summary {
    cursor: pointer;
    font-size: 12.5px;
    font-weight: 600;
    color: var(--sq-brand-dark);
    list-style: none;
  }
  .details summary::-webkit-details-marker {
    display: none;
  }
  .details[open] summary {
    margin-bottom: 8px;
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin-bottom: 10px;
  }
  .field label {
    font-size: 12px;
    font-weight: 600;
    color: var(--sq-muted);
  }
  .field input {
    font: inherit;
    font-size: 13.5px;
    padding: 8px 10px;
    border-radius: 8px;
    border: 1px solid var(--sq-border);
    background: var(--sq-surface);
    color: var(--sq-text);
  }
  .field input:focus-visible {
    outline: 2px solid var(--sq-brand);
    outline-offset: 1px;
  }

  .submit {
    background: var(--sq-brand);
    color: #fff;
    border: none;
    border-radius: 8px;
    padding: 8px 14px;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    align-self: flex-start;
  }
  .submit:hover {
    background: var(--sq-brand-dark);
  }
  .submit:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }

  .thanks {
    font-size: 13px;
    color: var(--sq-brand-dark);
    font-weight: 600;
  }

  @media (max-width: 480px) {
    .root {
      inset: 0;
      align-items: stretch;
      padding: 0;
    }
    .launcher {
      position: absolute;
      right: 20px;
      bottom: 20px;
    }
    .panel {
      position: absolute;
      inset: 0;
      width: 100%;
      max-width: 100%;
      max-height: 100%;
      border-radius: 0;
      border: none;
    }
  }
`;
