import type { CuboidDimensionKey, DimensionSyncResult } from './pre-render-enhancer';
import type { RideStateSyncResult } from './ride-state-sync';
import { showMeowToast } from './meow-toast';

const ROW_CLASS = 'cvat-3d-enhancer-dim-sync-row';
const CARD_ID_PREFIX = 'cvat-objects-sidebar-state-item-';
const CARD_SELECTOR = '.cvat-objects-sidebar-state-item, [id^="cvat-objects-sidebar-state-item-"]';
const LOCK_SELECTOR =
  '.cvat-object-item-button-lock-enabled, .cvat-object-item-button-lock.anticon-lock, .cvat-object-item-button-lock[aria-label="lock"]';
const CUBOID_TRACK_PATTERN = /^cuboid\s+track$/i;

export const VIEWPORT_DEFER_THRESHOLD = 64;
const MAX_EAGER_TARGET_CARDS = 128;
const INITIAL_EAGER_MOUNT_LIMIT = 32;

type SyncDimension = (
  clientID: number,
  dimension: CuboidDimensionKey
) => Promise<DimensionSyncResult> | DimensionSyncResult;

export interface RideStateControl {
  isAvailable: (clientID: number, card?: HTMLElement) => boolean;
  sync: (clientID: number) => Promise<RideStateSyncResult>;
}

export interface DimensionSyncControlOptions {
  enableDimensionSync?: boolean;
  enableHeadingFlip?: boolean;
  targetCards?: Iterable<HTMLElement> | null;
}

type SidebarAction = CuboidDimensionKey | 'RIDE_STATE';

interface ButtonConfig {
  readonly key: SidebarAction;
  readonly className: string;
  readonly title: string;
  readonly svgPath: string;
}

interface RowHandlerState {
  onSync: SyncDimension;
  enabled: ReadonlySet<SidebarAction>;
  rideState?: RideStateControl;
  busy: boolean;
  configSignature: string;
}

interface ConfigVariant {
  readonly configs: readonly ButtonConfig[];
  readonly enabled: ReadonlySet<SidebarAction>;
  readonly signature: string;
}

interface ViewportCardMountController {
  readonly root: Element | null;
  readonly observer: IntersectionObserver;
  readonly observedCards: WeakSet<HTMLElement>;
  onSync: SyncDimension;
  options: {
    enableDimensionSync?: boolean;
    enableHeadingFlip?: boolean;
  };
  rideState?: RideStateControl;
}

const handlers = new WeakMap<HTMLElement, RowHandlerState>();
const buttonTemplates = new WeakMap<Document, Map<SidebarAction, HTMLTemplateElement>>();
const viewportControllers = new WeakMap<Document, ViewportCardMountController>();

const DIMENSION_BUTTON_CONFIGS: readonly ButtonConfig[] = [
  {
    key: 'H',
    className: 'cvat-object-item-button-sync-h',
    title: 'Sync Height (H) across frames with 100% identical attributes',
    svgPath:
      'M2 7V3C2 2.45 2.45 2 3 2H7V4H4V7H2ZM22 7V3C22 2.45 21.55 2 21 2H17V4H20V7H22ZM2 17V21C2 21.55 2.45 22 3 22H7V20H4V17H2ZM22 17V21C22 21.55 21.55 22 21 22H17V20H20V17H22ZM7.5 6H10.2V10.7H13.8V6H16.5V18H13.8V13.1H10.2V18H7.5V6Z',
  },
  {
    key: 'W',
    className: 'cvat-object-item-button-sync-w',
    title: 'Sync Width (W) across frames with 100% identical attributes',
    svgPath:
      'M2 7V3C2 2.45 2.45 2 3 2H7V4H4V7H2ZM22 7V3C22 2.45 21.55 2 21 2H17V4H20V7H22ZM2 17V21C2 21.55 2.45 22 3 22H7V20H4V17H2ZM22 17V21C22 21.55 21.55 22 21 22H17V20H20V17H22ZM5.5 6H8.1L9.6 13.8L11.2 6H13.4L15 13.8L16.5 6H19.1L16.4 18H13.9L12.3 10.6L10.7 18H8.2L5.5 6Z',
  },
  {
    key: 'L',
    className: 'cvat-object-item-button-sync-l',
    title: 'Sync Length (L) across frames with 100% identical attributes',
    svgPath:
      'M2 7V3C2 2.45 2.45 2 3 2H7V4H4V7H2ZM22 7V3C22 2.45 21.55 2 21 2H17V4H20V7H22ZM2 17V21C2 21.55 2.45 22 3 22H7V20H4V17H2ZM22 17V21C22 21.55 21.55 22 21 22H17V20H20V17H22ZM8.5 6H11.3V15.5H16.8V18H8.5V6Z',
  },
  {
    key: 'RIDE_STATE',
    className: 'cvat-object-item-button-sync-ride-state',
    title: 'Apply current ride_state to all frames of this track (Áp dụng cho mọi frame)',
    svgPath: 'M3 3H14V6H6V18H18V12H21V21H3V3ZM10 10L13 13L20 5L22 7L13 17L8 12L10 10Z',
  },
  {
    key: 'FLIP_180',
    className: 'cvat-object-item-button-flip-180',
    title: 'Flip heading 180° on current frame (Lật đầu xe 180° ở frame hiện tại)',
    svgPath:
      'M12 2L16 6H13V11H11V6H8L12 2ZM12 22L8 18H11V13H13V18H16L12 22ZM5.64 5.64L7.05 7.05C5.17 8.93 4.69 11.74 5.62 14.12L3.77 14.9C2.5 11.74 3.16 8.12 5.64 5.64ZM18.36 18.36L16.95 16.95C18.83 15.07 19.31 12.26 18.38 9.88L20.23 9.1C21.5 12.26 20.84 15.88 18.36 18.36Z',
  },
];

const BUTTON_CONFIG_BY_KEY = new Map<SidebarAction, ButtonConfig>(
  DIMENSION_BUTTON_CONFIGS.map((cfg) => [cfg.key, cfg])
);

const CONFIG_VARIANTS: readonly ConfigVariant[] = Array.from({ length: 8 }, (_, mask) => {
  const enableDim = (mask & 4) !== 0;
  const enableFlip = (mask & 2) !== 0;
  const enableRide = (mask & 1) !== 0;
  const configs = DIMENSION_BUTTON_CONFIGS.filter((cfg) =>
    cfg.key === 'RIDE_STATE' ? enableRide : cfg.key === 'FLIP_180' ? enableFlip : enableDim
  );
  return {
    configs,
    enabled: new Set(configs.map((cfg) => cfg.key)),
    signature: configs.map((cfg) => cfg.key).join(','),
  };
});

const ACTION_NAMES: Readonly<Record<SidebarAction, string>> = {
  H: 'đồng bộ chiều cao (H)',
  W: 'đồng bộ chiều rộng (W)',
  L: 'đồng bộ chiều dài (L)',
  FLIP_180: 'lật hướng 180°',
  RIDE_STATE: 'áp dụng ride_state cho mọi frame',
};
const feedbackTimers = new WeakMap<HTMLElement, ReturnType<typeof setTimeout>>();

/** Visible per-button state so a click is acknowledged even without reading the toast. */
function setButtonFeedback(button: HTMLElement, state: 'busy' | 'done' | 'failed' | 'idle'): void {
  const previous = feedbackTimers.get(button);
  if (previous !== undefined) clearTimeout(previous);
  feedbackTimers.delete(button);
  button.dataset.enhancerState = state;
  button.setAttribute('aria-busy', state === 'busy' ? 'true' : 'false');
  button.style.color =
    state === 'done'
      ? '#389e0d'
      : state === 'failed'
        ? '#cf1322'
        : state === 'busy'
          ? '#1677ff'
          : 'inherit';
  button.style.cursor = state === 'busy' ? 'progress' : 'pointer';
  if (state === 'done' || state === 'failed') {
    feedbackTimers.set(
      button,
      setTimeout(() => setButtonFeedback(button, 'idle'), 1600)
    );
  }
}

function isAsciiDigits(value: string): boolean {
  if (value.length === 0) return false;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 48 || code > 57) return false;
  }
  return true;
}

function clientId(card: Element): number | null {
  const raw = card.getAttribute('data-client-id');
  if (raw !== null && isAsciiDigits(raw)) {
    const parsed = Number(raw);
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
  }
  const idAttr = card.id;
  if (idAttr.startsWith(CARD_ID_PREFIX)) {
    const suffix = idAttr.slice(CARD_ID_PREFIX.length);
    if (isAsciiDigits(suffix)) {
      const parsed = Number(suffix);
      return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
    }
  }
  return null;
}

function createButtonTemplate(doc: Document, cfg: ButtonConfig): HTMLTemplateElement {
  const template = doc.createElement('template');
  const button = doc.createElement('button');
  button.type = 'button';
  button.className = `anticon cvat-object-item-button-sync-dim ${cfg.className}`;
  button.dataset.enhancerSyncDim = cfg.key;
  button.setAttribute('aria-label', `sync-${cfg.key.toLowerCase()}`);
  button.title = cfg.title;
  // Do not depend on Ant Design's versioned CSS or the keyframe button's disabled styles.
  button.style.cssText =
    'display: inline-flex !important; align-items: center; justify-content: center; ' +
    'visibility: visible !important; width: 28px; height: 24px; padding: 3px; margin: 0; ' +
    'border: 0; background: transparent; color: inherit; font-size: 14px; cursor: pointer;';
  const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '18');
  svg.setAttribute('height', '18');
  svg.setAttribute('fill', 'currentColor');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.style.cssText = 'display: block !important; visibility: visible !important; flex-shrink: 0;';
  const path = doc.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', cfg.svgPath);
  svg.appendChild(path);
  button.appendChild(svg);
  if (cfg.key === 'RIDE_STATE') {
    button.appendChild(doc.createTextNode('RS'));
    button.style.width = '48px';
    button.style.gap = '2px';
  }
  template.content.appendChild(button);
  return template;
}

function createButton(doc: Document, cfg: ButtonConfig): HTMLElement {
  let docMap = buttonTemplates.get(doc);
  if (!docMap) {
    docMap = new Map<SidebarAction, HTMLTemplateElement>();
    buttonTemplates.set(doc, docMap);
  }
  let template = docMap.get(cfg.key);
  if (!template) {
    template = createButtonTemplate(doc, cfg);
    docMap.set(cfg.key, template);
  }
  return (template.content.firstElementChild as HTMLButtonElement).cloneNode(true) as HTMLElement;
}

function handleRowClick(event: MouseEvent): void {
  const row = event.currentTarget as HTMLElement | null;
  if (!row) return;
  const activeHandler = handlers.get(row);
  if (!activeHandler) return;
  const target = event.target as Element | null;
  const button = target?.closest<HTMLButtonElement>('button[data-enhancer-sync-dim]');
  if (!button || !row.contains(button)) return;
  event.stopPropagation();
  event.preventDefault();
  const doc = row.ownerDocument;
  const currentCard = row.closest<HTMLElement>(CARD_SELECTOR);
  const id = currentCard ? clientId(currentCard) : null;
  if (id === null) return;
  const actionKey = button.dataset.enhancerSyncDim as SidebarAction | undefined;
  const cfg = actionKey ? BUTTON_CONFIG_BY_KEY.get(actionKey) : undefined;
  if (!cfg || !activeHandler.enabled.has(cfg.key)) return;
  const name = ACTION_NAMES[cfg.key];
  if (currentCard?.querySelector(LOCK_SELECTOR)) {
    showMeowToast(doc, `#${id}: object đang bị khóa — mở khóa để ${name}`, 'error');
    return;
  }
  if (activeHandler.busy) {
    showMeowToast(doc, `#${id}: đang xử lý thao tác trước, vui lòng chờ…`, 'info');
    return;
  }
  activeHandler.busy = true;
  button.disabled = true;
  setButtonFeedback(button, 'busy');
  // Acknowledge the click immediately; native saves can take a moment on long tracks.
  const toast = showMeowToast(doc, `#${id}: đang ${name}…`, 'loading');
  void Promise.resolve()
    .then(async () => {
      if (cfg.key === 'RIDE_STATE') {
        const result = await activeHandler.rideState?.sync(id);
        if (!result) throw new Error('ride_state is unavailable');
        const outsideNote = result.outsideKeyframes
          ? `, gồm ${result.outsideKeyframes} keyframe outside`
          : '';
        const message =
          result.updatedKeyframes > 0
            ? `#${id}: ride_state = ${result.targetValue} cho toàn track (đã cập nhật ${result.updatedKeyframes}/${result.totalKeyframes} keyframe${outsideNote})`
            : `#${id}: ride_state = ${result.targetValue} đã đồng nhất trên ${result.totalKeyframes} keyframe${outsideNote} — không cần thay đổi`;
        button.title = `ride_state = ${result.targetValue} across all frames (${result.updatedKeyframes}/${result.totalKeyframes} keyframes updated)`;
        return { ok: true, message };
      }
      const result = await activeHandler.onSync(id, cfg.key);
      if (result.syncedFrames > 0) {
        const message =
          cfg.key === 'FLIP_180'
            ? `#${id}: đã lật 180° ở frame hiện tại (Yaw = ${result.targetValue === null ? '' : ((result.targetValue * 180) / Math.PI).toFixed(1)}°)`
            : `#${id}: ${cfg.key} = ${result.targetValue?.toFixed(2) ?? ''} đã đồng bộ ${result.syncedFrames} keyframe` +
              (result.skippedAttributeMismatchFrames
                ? ` (bỏ qua ${result.skippedAttributeMismatchFrames} do khác attribute)`
                : '');
        button.title =
          cfg.key === 'FLIP_180'
            ? `Flipped 180° on current frame (Yaw = ${result.targetValue === null ? '' : ((result.targetValue * 180) / Math.PI).toFixed(1)}°)`
            : `${cfg.key} = ${result.targetValue?.toFixed(2) ?? ''} synced to ${result.syncedFrames} keyframe(s) (${result.skippedAttributeMismatchFrames} skipped due to different attributes)`;
        return { ok: true, message };
      }
      const message = `#${id}: ${name} — không có frame nào được cập nhật`;
      button.title = `${cfg.title} — No frames updated; check track state and runtime compatibility`;
      return { ok: false, message };
    })
    .then(({ ok, message }) => {
      toast.update(message, ok ? 'success' : 'info');
      setButtonFeedback(button, ok ? 'done' : 'idle');
    })
    .catch((error: unknown) => {
      const reason = error instanceof Error && error.message ? `: ${error.message}` : '';
      button.title = `${cfg.title} — Sync failed; check runtime compatibility`;
      toast.update(`#${id}: ${name} thất bại${reason}`, 'error');
      setButtonFeedback(button, 'failed');
    })
    .finally(() => {
      activeHandler.busy = false;
      button.disabled = Boolean(row.closest(CARD_SELECTOR)?.querySelector(LOCK_SELECTOR));
    });
}

function hasDirectRow(card: HTMLElement): boolean {
  const last = card.lastElementChild;
  if (last && last.classList.contains(ROW_CLASS)) return true;
  const children = card.children;
  for (let i = children.length - 1; i >= 0; i--) {
    if (children[i]?.classList.contains(ROW_CLASS)) return true;
  }
  return false;
}

function findCardRow(card: HTMLElement): HTMLElement | null {
  const last = card.lastElementChild;
  if (last instanceof HTMLElement && last.classList.contains(ROW_CLASS)) return last;
  const children = card.children;
  for (let i = children.length - 1; i >= 0; i--) {
    const child = children[i];
    if (child instanceof HTMLElement && child.classList.contains(ROW_CLASS)) return child;
  }
  return card.querySelector<HTMLElement>(`.${ROW_CLASS}`);
}

function isButtonHealthy(el: Element | null, expectedKey: SidebarAction): boolean {
  if (!el || el.tagName !== 'BUTTON') return false;
  if ((el as HTMLElement).dataset.enhancerSyncDim !== expectedKey) return false;
  const svg = el.firstElementChild;
  if (!svg || svg.tagName.toLowerCase() !== 'svg') return false;
  const path = svg.firstElementChild;
  return Boolean(path && path.tagName.toLowerCase() === 'path');
}

function areRowButtonsHealthy(row: HTMLElement, configs: readonly ButtonConfig[]): boolean {
  const children = row.children;
  if (children.length !== configs.length) return false;
  for (let i = 0; i < configs.length; i++) {
    if (!isButtonHealthy(children[i] ?? null, configs[i]!.key)) return false;
  }
  return true;
}

function reconcileRowButtons(
  doc: Document,
  row: HTMLElement,
  configs: readonly ButtonConfig[]
): void {
  for (const child of Array.from(row.children)) {
    const key = (child as HTMLElement).dataset?.enhancerSyncDim as SidebarAction | undefined;
    if (!key || !configs.some((cfg) => cfg.key === key)) {
      child.remove();
    }
  }
  for (let i = 0; i < configs.length; i++) {
    const cfg = configs[i]!;
    let button = row.querySelector<HTMLElement>(`[data-enhancer-sync-dim="${cfg.key}"]`);
    if (!button?.querySelector('svg path')) {
      const replacement = createButton(doc, cfg);
      if (button) {
        button.replaceWith(replacement);
      } else {
        row.insertBefore(replacement, row.children[i] ?? null);
      }
      button = replacement;
    } else if (row.children[i] !== button) {
      row.insertBefore(button, row.children[i] ?? null);
    }
  }
}

function reconcileSingleCard(
  doc: Document,
  card: HTMLElement,
  onSync: SyncDimension,
  enableDim: boolean,
  enableFlip: boolean,
  rideState?: RideStateControl
): number {
  const id = clientId(card);
  if (id === null) return 0;

  if (!enableDim && !enableFlip && !rideState) {
    findCardRow(card)?.remove();
    return 0;
  }

  const typeText = card
    .querySelector('.cvat-objects-sidebar-state-item-object-type-text')
    ?.textContent?.trim();
  if (typeText && !CUBOID_TRACK_PATTERN.test(typeText)) {
    findCardRow(card)?.remove();
    return 0;
  }

  const hasRide = Boolean(rideState?.isAvailable(id, card));
  const mask = (enableDim ? 4 : 0) | (enableFlip ? 2 : 0) | (hasRide ? 1 : 0);
  const variant = CONFIG_VARIANTS[mask]!;
  if (variant.configs.length === 0) {
    findCardRow(card)?.remove();
    return 0;
  }

  let mounted = 0;
  let row = findCardRow(card);
  if (!row) {
    row = doc.createElement('div');
    row.className = ROW_CLASS;
    row.setAttribute('role', 'group');
    row.setAttribute('aria-label', 'Cuboid dimensions');
    // Keep the controls outside CVAT's version-specific keyframe/state grid.
    card.appendChild(row);
    mounted = 1;
  }

  let handler = handlers.get(row);
  if (!handler) {
    row.className = ROW_CLASS;
    row.setAttribute('role', 'group');
    row.setAttribute('aria-label', 'Cuboid dimensions');
    row.style.cssText =
      'display: flex !important; visibility: visible !important; justify-content: space-around; ' +
      'align-items: center; flex-wrap: wrap; width: 100%; min-height: 26px;';
    handler = {
      onSync,
      enabled: variant.enabled,
      rideState,
      busy: false,
      configSignature: variant.signature,
    };
    handlers.set(row, handler);
    // Replace rows cloned/restored by the host: their DOM survives, their listeners do not.
    row.replaceChildren(...variant.configs.map((cfg) => createButton(doc, cfg)));
    row.addEventListener('click', handleRowClick);
  } else {
    handler.onSync = onSync;
    handler.enabled = variant.enabled;
    handler.rideState = rideState;
    if (
      handler.configSignature !== variant.signature ||
      !areRowButtonsHealthy(row, variant.configs)
    ) {
      reconcileRowButtons(doc, row, variant.configs);
      handler.configSignature = variant.signature;
    }
  }

  const locked = Boolean(card.querySelector(LOCK_SELECTOR));
  const flag = locked ? '1' : '0';
  if (row.dataset.enhancerLocked !== flag) row.dataset.enhancerLocked = flag;
  const disabled = locked || handler.busy;
  const opacity = locked ? '0.5' : '1';
  const children = row.children;
  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    if (!(child instanceof HTMLButtonElement)) continue;
    if (child.disabled !== disabled) child.disabled = disabled;
    if (child.style.opacity !== opacity) child.style.opacity = opacity;
  }
  return mounted;
}

function findScrollContainer(firstCard: Element, doc: Document): Element | null {
  let current = firstCard.parentElement;
  for (let depth = 0; current && current !== doc.documentElement && depth < 12; depth++) {
    if (current.clientHeight > 0 && current.scrollHeight > current.clientHeight) {
      return current;
    }
    current = current.parentElement;
  }
  return null;
}

function resolveIntersectionObserverCtor(doc: Document): typeof IntersectionObserver | undefined {
  const winObserver = (
    doc.defaultView as (Window & { IntersectionObserver?: typeof IntersectionObserver }) | null
  )?.IntersectionObserver;
  if (typeof winObserver === 'function') return winObserver;
  if (typeof globalThis.IntersectionObserver === 'function') {
    return globalThis.IntersectionObserver;
  }
  return undefined;
}

function getOrCreateViewportController(
  doc: Document,
  scrollContainer: Element | null,
  ObserverCtor: typeof IntersectionObserver,
  onSync: SyncDimension,
  options: { enableDimensionSync?: boolean; enableHeadingFlip?: boolean },
  rideState?: RideStateControl
): ViewportCardMountController {
  const existing = viewportControllers.get(doc);
  if (existing && existing.root === scrollContainer) {
    existing.onSync = onSync;
    existing.options = options;
    existing.rideState = rideState;
    return existing;
  }
  existing?.observer.disconnect();
  const observedCards = new WeakSet<HTMLElement>();
  const runtimeRef: Pick<ViewportCardMountController, 'onSync' | 'options' | 'rideState'> = {
    onSync,
    options,
    rideState,
  };
  const observer = new ObserverCtor(
    (entries) => {
      const enableDim = runtimeRef.options.enableDimensionSync !== false;
      const enableFlip = runtimeRef.options.enableHeadingFlip !== false;
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const target = entry.target;
        if (!(target instanceof HTMLElement)) continue;
        observer.unobserve(target);
        observedCards.delete(target);
        if (target.isConnected) {
          reconcileSingleCard(
            doc,
            target,
            runtimeRef.onSync,
            enableDim,
            enableFlip,
            runtimeRef.rideState
          );
        }
      }
    },
    {
      root: scrollContainer,
      rootMargin: '300px 0px',
    }
  );
  const controller: ViewportCardMountController = {
    root: scrollContainer,
    observer,
    observedCards,
    get onSync() {
      return runtimeRef.onSync;
    },
    set onSync(next: SyncDimension) {
      runtimeRef.onSync = next;
    },
    get options() {
      return runtimeRef.options;
    },
    set options(next: { enableDimensionSync?: boolean; enableHeadingFlip?: boolean }) {
      runtimeRef.options = next;
    },
    get rideState() {
      return runtimeRef.rideState;
    },
    set rideState(next: RideStateControl | undefined) {
      runtimeRef.rideState = next;
    },
  };
  viewportControllers.set(doc, controller);
  return controller;
}

function reconcileDeferredCardList(
  doc: Document,
  cards: ArrayLike<HTMLElement>,
  ObserverCtor: typeof IntersectionObserver,
  onSync: SyncDimension,
  options: DimensionSyncControlOptions,
  enableDim: boolean,
  enableFlip: boolean,
  rideState?: RideStateControl
): number {
  const scrollContainer = findScrollContainer(cards[0]!, doc);
  const controller = getOrCreateViewportController(
    doc,
    scrollContainer,
    ObserverCtor,
    onSync,
    {
      enableDimensionSync: options.enableDimensionSync,
      enableHeadingFlip: options.enableHeadingFlip,
    },
    rideState
  );
  const containerScrollHeight = scrollContainer ? scrollContainer.scrollHeight : 0;
  const containerClientHeight = scrollContainer
    ? scrollContainer.clientHeight
    : (doc.defaultView?.innerHeight ?? 800);
  const estimatedCardHeight =
    containerScrollHeight > 0 ? Math.max(24, containerScrollHeight / cards.length) : 36;
  const scrollTop = scrollContainer ? Math.max(0, scrollContainer.scrollTop) : 0;
  const eagerStart = Math.max(0, Math.floor((scrollTop - 300) / estimatedCardHeight));
  const rawEnd = Math.ceil((scrollTop + containerClientHeight + 300) / estimatedCardHeight);
  const eagerEnd = Math.min(
    cards.length,
    Math.max(eagerStart + 1, Math.min(rawEnd, eagerStart + INITIAL_EAGER_MOUNT_LIMIT))
  );

  let mountedCount = 0;
  for (let i = 0; i < cards.length; i++) {
    const card = cards[i]!;
    if ((i >= eagerStart && i < eagerEnd) || hasDirectRow(card)) {
      if (controller.observedCards.has(card)) {
        controller.observer.unobserve(card);
        controller.observedCards.delete(card);
      }
      mountedCount += reconcileSingleCard(doc, card, onSync, enableDim, enableFlip, rideState);
      if (!hasDirectRow(card) && !controller.observedCards.has(card)) {
        controller.observedCards.add(card);
        controller.observer.observe(card);
      }
    } else if (!controller.observedCards.has(card)) {
      controller.observedCards.add(card);
      controller.observer.observe(card);
    }
  }
  return mountedCount;
}

/** Mount and repair controls without depending on Ant grid spans or keyframe buttons. */
export function injectCvatObjectDimensionSyncControls(
  doc: Document,
  onSync: SyncDimension,
  options: DimensionSyncControlOptions = {},
  rideState?: RideStateControl
): number {
  const enableDim = options.enableDimensionSync !== false;
  const enableFlip = options.enableHeadingFlip !== false;

  if (options.targetCards != null) {
    const targetList = Array.isArray(options.targetCards)
      ? options.targetCards
      : Array.from(options.targetCards);
    if (targetList.length === 0) return 0;
    if (targetList.length > MAX_EAGER_TARGET_CARDS) {
      const ObserverCtor = resolveIntersectionObserverCtor(doc);
      if (ObserverCtor) {
        return reconcileDeferredCardList(
          doc,
          targetList,
          ObserverCtor,
          onSync,
          options,
          enableDim,
          enableFlip,
          rideState
        );
      }
    }
    let mountedCount = 0;
    for (let i = 0; i < targetList.length; i++) {
      mountedCount += reconcileSingleCard(
        doc,
        targetList[i]!,
        onSync,
        enableDim,
        enableFlip,
        rideState
      );
    }
    return mountedCount;
  }

  const sidebar = doc.querySelector<HTMLElement>('.cvat-objects-sidebar');
  if (!enableDim && !enableFlip && !rideState) {
    const activeController = viewportControllers.get(doc);
    if (activeController) {
      activeController.observer.disconnect();
      viewportControllers.delete(doc);
    }
    const scope = sidebar ?? doc;
    for (const row of scope.querySelectorAll<HTMLElement>(`.${ROW_CLASS}`)) {
      row.remove();
    }
    return 0;
  }

  let cards: NodeListOf<HTMLElement>;
  if (sidebar) {
    cards = sidebar.querySelectorAll<HTMLElement>('.cvat-objects-sidebar-state-item');
    if (cards.length === 0) {
      cards = sidebar.querySelectorAll<HTMLElement>(CARD_SELECTOR);
    }
  } else {
    cards = doc.querySelectorAll<HTMLElement>(CARD_SELECTOR);
  }

  if (cards.length === 0) return 0;

  if (cards.length > VIEWPORT_DEFER_THRESHOLD) {
    const ObserverCtor = resolveIntersectionObserverCtor(doc);
    if (ObserverCtor) {
      return reconcileDeferredCardList(
        doc,
        cards,
        ObserverCtor,
        onSync,
        options,
        enableDim,
        enableFlip,
        rideState
      );
    }
  }

  let mountedCount = 0;
  for (let i = 0; i < cards.length; i++) {
    mountedCount += reconcileSingleCard(doc, cards[i]!, onSync, enableDim, enableFlip, rideState);
  }
  return mountedCount;
}
