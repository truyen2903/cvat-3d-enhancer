import { decorateMeowSurface, ensureMeowStyle, registerMeowCleanup, setMeowIcon } from './meow-ui';

export type MeowToastKind = 'loading' | 'success' | 'info' | 'error';

export interface MeowToastHandle {
  update: (message: string, kind?: MeowToastKind) => void;
  dismiss: () => void;
}

const CONTAINER_ID = 'meow-toast-stack';
const MAX_TOASTS = 3;
const dismissers = new WeakMap<Element, () => void>();
const DURATION_MS: Record<MeowToastKind, number> = {
  loading: 0,
  success: 2200,
  info: 2200,
  error: 5000,
};
function ensureContainer(doc: Document): HTMLElement | null {
  const root = doc.body ?? doc.documentElement;
  if (!root) return null;
  let container = doc.getElementById(CONTAINER_ID);
  if (!container) {
    container = doc.createElement('div');
    container.id = CONTAINER_ID;
    container.setAttribute('role', 'status');
    container.setAttribute('aria-live', 'polite');
    decorateMeowSurface(container);
    root.appendChild(container);
  }
  return container;
}

function paint(doc: Document, el: HTMLElement, message: string, kind: MeowToastKind): void {
  el.dataset.kind = kind;
  el.title = message;
  const icon = doc.createElement('span');
  icon.setAttribute('aria-hidden', 'true');
  if (kind === 'loading') {
    icon.className = 'meow-toast-spinner';
  } else {
    setMeowIcon(icon, kind);
    icon.className = 'meow-toast-icon';
  }
  const text = doc.createElement('span');
  text.textContent = message;
  text.className = 'meow-toast-text';
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
  ensureMeowStyle(doc);
  decorateMeowSurface(container);

  const el = doc.createElement('div');
  el.className = 'meow-toast';
  container.appendChild(el);

  const view = doc.defaultView;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let retired = false;
  const unregister = registerMeowCleanup(doc, () => {
    retired = true;
    dismiss();
  });
  const dismiss = (): void => {
    unregister();
    if (timer !== null) clearTimeout(timer);
    timer = null;
    el.remove();
  };
  const update = (nextMessage: string, nextKind: MeowToastKind = kind): void => {
    if (retired || !container.isConnected) return;
    // An evicted toast must never return above the stack limit.
    if (!el.isConnected) return;
    paint(doc, el, nextMessage, nextKind);
    if (timer !== null) clearTimeout(timer);
    timer = null;
    const duration = DURATION_MS[nextKind];
    if (duration > 0) timer = (view ?? globalThis).setTimeout(dismiss, duration);
  };
  dismissers.set(el, () => {
    retired = true;
    dismiss();
  });
  while (container.childElementCount > MAX_TOASTS) {
    const oldest = container.firstElementChild;
    if (!oldest) break;
    dismissers.get(oldest)?.();
  }
  update(message, kind);
  return { update, dismiss };
}
