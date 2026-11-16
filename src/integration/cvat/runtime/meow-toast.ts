/**
 * Lightweight in-page notifications for Meow actions.
 *
 * CVAT's Ant Design notification API is not reachable from the page bridge in every build,
 * so this renders its own small, non-interactive toast stack. Toasts never capture pointer
 * input over the canvas and are announced through an ARIA live region.
 */

export type MeowToastKind = 'loading' | 'success' | 'info' | 'error';

export interface MeowToastHandle {
  update: (message: string, kind?: MeowToastKind) => void;
  dismiss: () => void;
}

const CONTAINER_ID = 'meow-toast-stack';
const STYLE_ID = 'meow-toast-style';
const MAX_TOASTS = 4;
const DURATION_MS: Record<MeowToastKind, number> = {
  loading: 0,
  success: 2200,
  info: 2200,
  error: 5000,
};
const ACCENT: Record<MeowToastKind, string> = {
  loading: '#1677ff',
  success: '#389e0d',
  info: '#1677ff',
  error: '#cf1322',
};
const ICON: Record<MeowToastKind, string> = {
  loading: '',
  success: '✓',
  info: 'i',
  error: '!',
};

function ensureStyle(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent =
    '@keyframes meow-toast-spin{to{transform:rotate(360deg)}}' +
    '@keyframes meow-toast-in{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}' +
    '.meow-toast{animation:meow-toast-in .14s ease-out}' +
    '@media (prefers-reduced-motion: reduce){.meow-toast,.meow-toast-spinner{animation:none!important}}';
  (doc.head ?? doc.documentElement).appendChild(style);
}

function ensureContainer(doc: Document): HTMLElement | null {
  const root = doc.body ?? doc.documentElement;
  if (!root) return null;
  let container = doc.getElementById(CONTAINER_ID);
  if (!container) {
    container = doc.createElement('div');
    container.id = CONTAINER_ID;
    container.setAttribute('role', 'status');
    container.setAttribute('aria-live', 'polite');
    container.style.cssText =
      'position:fixed;right:16px;bottom:16px;z-index:2147483000;display:flex;' +
      'flex-direction:column;align-items:flex-end;gap:6px;pointer-events:none;max-width:min(380px,calc(100vw - 32px));';
    root.appendChild(container);
  }
  return container;
}

function paint(doc: Document, el: HTMLElement, message: string, kind: MeowToastKind): void {
  el.dataset.kind = kind;
  el.style.borderLeftColor = ACCENT[kind];
  const icon = doc.createElement('span');
  icon.setAttribute('aria-hidden', 'true');
  if (kind === 'loading') {
    icon.className = 'meow-toast-spinner';
    icon.style.cssText =
      'flex:none;width:12px;height:12px;border:2px solid #d6e4ff;border-top-color:#1677ff;' +
      'border-radius:50%;animation:meow-toast-spin .7s linear infinite;';
  } else {
    icon.textContent = ICON[kind];
    icon.style.cssText =
      `flex:none;width:16px;height:16px;border-radius:50%;background:${ACCENT[kind]};color:#fff;` +
      'font:700 11px/16px system-ui,sans-serif;text-align:center;';
  }
  const text = doc.createElement('span');
  text.textContent = message;
  text.style.cssText = 'min-width:0;overflow-wrap:anywhere;';
  el.replaceChildren(icon, text);
}

/** Show a toast; `loading` toasts stay until updated or dismissed. */
export function showMeowToast(
  doc: Document,
  message: string,
  kind: MeowToastKind = 'info'
): MeowToastHandle {
  const noop: MeowToastHandle = { update: () => undefined, dismiss: () => undefined };
  const container = ensureContainer(doc);
  if (!container) return noop;
  ensureStyle(doc);

  const el = doc.createElement('div');
  el.className = 'meow-toast';
  el.style.cssText =
    'display:flex;align-items:center;gap:8px;padding:8px 12px;border-radius:6px;' +
    'background:#fff;color:#1f1f1f;border-left:4px solid;box-shadow:0 4px 14px rgba(0,0,0,.18);' +
    'font:13px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif;';
  container.appendChild(el);
  while (container.childElementCount > MAX_TOASTS) container.firstElementChild?.remove();

  const view = doc.defaultView;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const dismiss = (): void => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    el.remove();
  };
  const update = (nextMessage: string, nextKind: MeowToastKind = kind): void => {
    if (!el.isConnected) container.appendChild(el);
    paint(doc, el, nextMessage, nextKind);
    if (timer !== null) clearTimeout(timer);
    timer = null;
    const duration = DURATION_MS[nextKind];
    if (duration > 0) timer = (view ?? globalThis).setTimeout(dismiss, duration);
  };
  update(message, kind);
  return { update, dismiss };
}
