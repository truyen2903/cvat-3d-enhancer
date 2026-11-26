/** Shared, page-local styles for Meow's native CVAT controls and temporary portals. */
const STYLE_ID = 'meow-ui-style';
const cleanups = new WeakMap<Document, Set<() => void>>();

export function registerMeowCleanup(doc: Document, cleanup: () => void): () => void {
  let callbacks = cleanups.get(doc);
  if (!callbacks) {
    callbacks = new Set();
    cleanups.set(doc, callbacks);
  }
  callbacks.add(cleanup);
  return () => callbacks.delete(cleanup);
}

export function removeMeowUi(doc: Document): void {
  for (const cleanup of cleanups.get(doc) ?? []) cleanup();
  cleanups.delete(doc);
  doc
    .querySelectorAll(
      '#meow-ui-style, [data-meow-owned], #meow-toast-stack, #cvat-3d-enhancer-workspace-settings-section'
    )
    .forEach((el) => el.remove());
}

/** Copy CVAT's generated Ant Design class and theme when mounting a body portal. */
export function decorateMeowSurface(el: HTMLElement): void {
  const doc = el.ownerDocument;
  el.classList.add('meow-surface');
  const sample = doc.querySelector(
    '.cvat-workspace-settings [class*="css-"], .cvat-objects-sidebar [class*="css-"], .cvat-workspace-settings[class*="css-"], .ant-btn[class*="css-"]'
  );
  const hash = sample?.getAttribute('class')?.match(/\bcss-[\w-]+\b/)?.[0];
  if (hash) el.classList.add(hash);
  el.classList.toggle(
    'meow-dark',
    Boolean(
      doc.querySelector(
        '.dark, .dark-theme, .cvat-dark-theme, .ant-theme-dark, [data-theme="dark"], [data-color-scheme="dark"]'
      )
    )
  );
}

export function ensureMeowStyle(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
.meow-base-guide,
.meow-qc-margin,
.meow-track-ghosts {
  position: fixed;
  pointer-events: none;
  z-index: 1000;
  margin: 0;
  padding: 0;
  border: 0;
}
.meow-base-guide {
  overflow: hidden;
}
.meow-surface {
  --meow-bg: var(--ant-color-bg-elevated, Canvas);
  --meow-text: var(--ant-color-text, CanvasText);
  --meow-border: var(--ant-color-border, #d9d9d9);
  --meow-hover: var(--ant-control-item-bg-hover, rgba(128, 128, 128, 0.12));
  --meow-blue: var(--ant-color-primary, #1677ff);
  color: var(--meow-text);
  font: 12px/1.5 var(--ant-font-family, system-ui, sans-serif);
  box-sizing: border-box;
  color-scheme: light;
}
.meow-surface.meow-dark,
.dark .meow-surface,
.dark-theme .meow-surface,
.cvat-dark-theme .meow-surface,
[data-theme="dark"] .meow-base-guide,
.meow-qc-margin,
.meow-track-ghosts {
  position: fixed;
  pointer-events: none;
  z-index: 1000;
  margin: 0;
  padding: 0;
  border: 0;
}
.meow-base-guide {
  overflow: hidden;
}
.meow-surface {
  --meow-bg: var(--ant-color-bg-elevated, #1f1f1f);
  --meow-text: var(--ant-color-text, rgba(255, 255, 255, 0.85));
  --meow-border: var(--ant-color-border, #424242);
  color-scheme: dark;
}
.meow-surface button {
  font: inherit;
  color: inherit;
  cursor: pointer;
  box-sizing: border-box;
}
.meow-surface button:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.meow-surface button:focus-visible,
.meow-surface select:focus-visible,
.meow-workspace-summary:focus-visible {
  outline: 2px solid var(--meow-blue);
  outline-offset: 2px;
}
.meow-surface svg {
  display: block;
  flex-shrink: 0;
}
.meow-dimension-row {
  color: inherit;
  color-scheme: inherit;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 4px;
  min-height: 26px;
  flex-wrap: nowrap;
  width: 100%;
}
.meow-dimension-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  height: 24px;
  min-width: 26px;
  padding: 2px 5px;
  border: 1px solid transparent;
  border-radius: 4px;
  background: transparent;
}
.meow-dimension-button:hover,
.meow-selection-button:hover,
.meow-selection-menu-item:hover,
.meow-sidebar-item:hover {
  background: var(--meow-hover);
}
.meow-dimension-row > [data-enhancer-sync-dim="H"],
.meow-dimension-row > [data-enhancer-sync-dim="W"],
.meow-dimension-row > [data-enhancer-sync-dim="L"] {
  border-color: var(--meow-border);
  border-radius: 0;
  margin-right: -5px;
}
.meow-dimension-row > [data-enhancer-sync-dim="H"] {
  border-radius: 4px 0 0 4px;
}
.meow-dimension-row > [data-enhancer-sync-dim="L"] {
  border-radius: 0 4px 4px 0;
  margin-right: 0;
}
.meow-surface [data-enhancer-state="done"] {
  color: var(--ant-color-success, #389e0d);
}
.meow-surface [data-enhancer-state="failed"] {
  color: var(--ant-color-error, #cf1322);
}
.meow-surface [data-enhancer-state="busy"] {
  color: var(--meow-blue);
  cursor: progress;
}
.meow-menu,
.meow-picker,
.meow-selection-menu {
  position: fixed;
  z-index: 2147483100;
  background: var(--meow-bg);
  color: var(--meow-text);
  border: 1px solid var(--meow-border);
  border-radius: 6px;
  box-shadow: 0 4px 16px #0003;
  padding: 4px;
  max-height: calc(100vh - 16px);
  overflow: auto;
  max-width: calc(100vw - 16px);
}
.meow-menu {
  min-width: 220px;
}
.meow-sidebar-item,
.meow-selection-menu-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  text-align: left;
  border: 0;
  background: transparent;
  padding: 4px 8px;
  border-radius: 4px;
  min-height: 26px;
}
.meow-sidebar-hint {
  margin-left: auto;
  opacity: 0.6;
  font-size: 11px;
}
.meow-picker {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  max-width: 320px;
  padding: 8px;
}
.meow-picker select {
  font: inherit;
  color: inherit;
  background: var(--meow-bg);
  border: 1px solid var(--meow-border);
  border-radius: 4px;
  padding: 3px;
  max-width: 150px;
}
.meow-picker button {
  border: 1px solid var(--meow-border);
  border-radius: 4px;
  background: transparent;
  padding: 2px 8px;
}
#meow-toast-stack {
  position: fixed;
  right: 16px;
  bottom: 16px;
  z-index: 2147483000;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 6px;
  pointer-events: none;
  max-width: min(420px, calc(100vw - 32px));
}
.meow-toast {
  pointer-events: auto;
  display: flex;
  align-items: center;
  gap: 6px;
  max-width: 100%;
  padding: 6px 10px;
  border: 1px solid var(--meow-border);
  border-radius: 6px;
  background: var(--meow-bg);
  color: var(--meow-text);
  box-shadow: 0 2px 8px #0002;
  animation: meow-toast-in 0.14s ease-out;
}
.meow-toast-text {
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  min-width: 0;
}
.meow-toast-icon {
  flex: none;
  color: var(--meow-blue);
}
.meow-toast[data-kind="error"] .meow-toast-icon {
  color: var(--ant-color-error, #cf1322);
}
.meow-toast[data-kind="success"] .meow-toast-icon {
  color: var(--ant-color-success, #389e0d);
}
.meow-toast-spinner {
  width: 12px;
  height: 12px;
  border: 2px solid var(--meow-border);
  border-top-color: var(--meow-blue);
  border-radius: 50%;
  animation: meow-toast-spin 0.7s linear infinite;
  flex: none;
}
.meow-selection-toolbar {
  position: fixed;
  z-index: 2147482500;
  display: flex;
  align-items: center;
  gap: 4px;
  max-width: calc(100vw - 24px);
  padding: 4px 6px;
  background: var(--meow-bg);
  border: 1px solid var(--meow-border);
  border-radius: 20px;
  box-shadow: 0 2px 8px #0002;
}
.meow-selection-count {
  padding: 0 4px;
  white-space: nowrap;
  font-weight: 600;
}
.meow-selection-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  border: 0;
  border-radius: 12px;
  background: transparent;
  padding: 2px 6px;
  min-height: 24px;
}
.meow-selection-icon-button {
  width: 26px;
  padding: 2px;
}
.meow-selection-menu {
  min-width: 256px;
  max-height: min(480px, calc(100vh - 16px));
  overflow-y: auto;
}
.meow-selection-group + .meow-selection-group {
  border-top: 1px solid var(--meow-border);
  margin-top: 4px;
  padding-top: 4px;
}
.meow-selection-group-label {
  opacity: 0.65;
  font-size: 11px;
  padding: 2px 8px;
  font-weight: 600;
}
.meow-selection-marquee {
  position: fixed;
  z-index: 2147482400;
  pointer-events: none;
  border: 1px dashed var(--ant-color-primary, #1677ff);
  background: rgba(22, 119, 255, 0.1);
}
.meow-selection-marquee.is-removing {
  border-color: var(--ant-color-error, #ff4d4f);
  background: rgba(255, 77, 79, 0.1);
}
.meow-workspace-settings {
  margin-top: 12px;
  border-top: 1px solid var(--meow-border);
}
.meow-workspace-summary {
  padding: 10px 0;
  cursor: pointer;
  font-weight: 600;
}
.meow-workspace-body {
  display: grid;
  gap: 10px;
  padding-bottom: 8px;
}
.meow-workspace-group {
  border: 0;
  padding: 0;
  margin: 0;
  min-width: 0;
}
.meow-workspace-group-title {
  font-weight: 600;
  font-size: 12px;
  margin-bottom: 4px;
}
.meow-workspace-option {
  position: relative;
  margin-bottom: 6px;
}
.meow-workspace-label {
  position: relative;
  display: inline-flex;
  align-items: center;
  cursor: pointer;
  user-select: none;
}
.meow-workspace-checkbox {
  position: relative;
  display: inline-block;
  line-height: 1;
  cursor: pointer;
}
.meow-workspace-input {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  margin: 0;
  opacity: 0;
  cursor: pointer;
  z-index: 1;
}
.meow-workspace-description {
  display: block;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  opacity: 0.65;
  font-size: 12px;
  margin-left: 24px;
}
@keyframes meow-toast-spin {
  to {
    transform: rotate(360deg);
  }
}
@keyframes meow-toast-in {
  from {
    opacity: 0;
    transform: translateY(6px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}
@media (prefers-reduced-motion: reduce) {
  .meow-toast,
  .meow-toast-spinner {
    animation: none !important;
  }
}
`;
  (doc.head ?? doc.documentElement).appendChild(style);
}

const ICON_PATHS = {
  more: 'M4 12h.01M12 12h.01M20 12h.01',
  success: 'm5 12 4 4L19 6',
  info: 'M12 11v7M12 6h.01',
  error: 'M12 5v9M12 19h.01',
  close: 'm6 6 12 12M6 18 18 6',
  flip: 'M4 10a8 8 0 1 1 1 8M4 4v6h6',
  filter: 'M3 4h18l-7 8v7l-4 2v-9Z',
  hide: 'm3 3 18 18M10 5h2c6 0 10 7 10 7s-2 4-6 6M6 6c-3 2-5 6-5 6s4 7 11 7h2',
  swap: 'M3 7h18l-4-4M21 17H3l4 4',
} as const;

export function setMeowIcon(button: HTMLElement, name: keyof typeof ICON_PATHS): void {
  const svg = button.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '16');
  svg.setAttribute('height', '16');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', name === 'more' ? '3' : '1.75');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  const path = button.ownerDocument.createElementNS(svg.namespaceURI, 'path');
  path.setAttribute('d', ICON_PATHS[name]);
  svg.appendChild(path);
  button.replaceChildren(svg);
}
