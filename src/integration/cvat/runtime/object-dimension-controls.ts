import type { CuboidDimensionKey, DimensionSyncResult } from './pre-render-enhancer';
import type { RideStateSyncResult } from './ride-state-sync';
import { showMeowToast } from './meow-toast';
import { decorateMeowSurface, ensureMeowStyle, registerMeowCleanup, setMeowIcon } from './meow-ui';

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
  dimension: CuboidDimensionKey,
  wholeTrack?: boolean,
  yawRange?: readonly [number, number]
) => Promise<DimensionSyncResult> | DimensionSyncResult;

export interface RideStateControl {
  isAvailable: (clientID: number, card?: HTMLElement) => boolean;
  sync: (clientID: number) => Promise<RideStateSyncResult>;
  getYawRangeOptions?: (clientID: number) => { frames: readonly number[]; currentFrame: number };
  getAttributes?: (clientID: number) => readonly { id: number; name: string }[];
  syncAttribute?: (clientID: number, attributeID: number) => Promise<RideStateSyncResult>;
}

export interface DimensionSyncControlOptions {
  enableDimensionSync?: boolean;
  enableHeadingFlip?: boolean;
  targetCards?: Iterable<HTMLElement> | null;
}

type SidebarAction = CuboidDimensionKey | 'RIDE_STATE' | 'ATTRIBUTES' | 'MORE';

interface ButtonConfig {
  readonly key: SidebarAction;
  readonly className: string;
  readonly title: string;
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
    title: 'Đồng bộ cao (H)',
  },
  {
    key: 'W',
    className: 'cvat-object-item-button-sync-w',
    title: 'Đồng bộ rộng (W)',
  },
  {
    key: 'L',
    className: 'cvat-object-item-button-sync-l',
    title: 'Đồng bộ dài (L)',
  },
  {
    key: 'RIDE_STATE',
    className: 'cvat-object-item-button-sync-ride-state',
    title: 'ride_state toàn track',
  },
  {
    key: 'FLIP_180',
    className: 'cvat-object-item-button-flip-180',
    title: 'Lật 180°; Shift+click: toàn track',
  },
  {
    key: 'SWAP_LW',
    className: 'cvat-object-item-button-swap-lw',
    title: 'Đổi L↔W; Shift+click: toàn track',
  },
  {
    key: 'YAW_INTERPOLATE',
    className: 'cvat-object-item-button-yaw-interpolate',
    title: 'Nội suy yaw; Shift+click: chọn khoảng',
  },
  {
    key: 'ATTRIBUTES',
    className: 'cvat-object-item-button-sync-attributes',
    title: 'Thuộc tính toàn track',
  },
];

const BUTTON_CONFIG_BY_KEY = new Map<SidebarAction, ButtonConfig>(
  DIMENSION_BUTTON_CONFIGS.map((cfg) => [cfg.key, cfg])
);

const MORE_CONFIG: ButtonConfig = {
  key: 'MORE',
  className: 'meow-sidebar-more',
  title: 'Thêm thao tác',
};
const INLINE_ACTIONS = new Set<SidebarAction>(['H', 'W', 'L', 'FLIP_180']);

const CONFIG_VARIANTS: readonly ConfigVariant[] = Array.from({ length: 8 }, (_, mask) => {
  const enableDim = (mask & 4) !== 0;
  const enableFlip = (mask & 2) !== 0;
  const enableRide = (mask & 1) !== 0;
  const configs = DIMENSION_BUTTON_CONFIGS.filter((cfg) =>
    cfg.key === 'RIDE_STATE'
      ? enableRide
      : cfg.key === 'FLIP_180' || cfg.key === 'SWAP_LW' || cfg.key === 'YAW_INTERPOLATE'
        ? enableFlip
        : enableDim
  );
  return {
    configs: [
      ...configs.filter((cfg) => INLINE_ACTIONS.has(cfg.key)),
      ...(configs.some((cfg) => !INLINE_ACTIONS.has(cfg.key)) ? [MORE_CONFIG] : []),
    ],
    enabled: new Set(configs.map((cfg) => cfg.key)),
    signature: configs.map((cfg) => cfg.key).join(','),
  };
});

const ACTION_NAMES: Readonly<Record<SidebarAction, string>> = {
  MORE: 'Thêm thao tác',
  H: 'đồng bộ cao (H)',
  W: 'đồng bộ rộng (W)',
  L: 'đồng bộ dài (L)',
  FLIP_180: 'lật hướng 180°',
  SWAP_LW: 'đổi L↔W và xoay 90°',
  YAW_INTERPOLATE: 'nội suy riêng yaw',
  ATTRIBUTES: 'thuộc tính toàn track',
  RIDE_STATE: 'ride_state toàn track',
};
const feedbackTimers = new WeakMap<HTMLElement, ReturnType<typeof setTimeout>>();

/** Visible per-button state so a click is acknowledged even without reading the toast. */
function setButtonFeedback(button: HTMLElement, state: 'busy' | 'done' | 'failed' | 'idle'): void {
  const previous = feedbackTimers.get(button);
  if (previous !== undefined) clearTimeout(previous);
  feedbackTimers.delete(button);
  button.dataset.enhancerState = state;
  button.setAttribute('aria-busy', state === 'busy' ? 'true' : 'false');
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
  button.className = `ant-btn ant-btn-sm ant-btn-text meow-dimension-button cvat-object-item-button-sync-dim ${cfg.className}`;
  decorateMeowSurface(button);
  button.classList.remove('meow-surface', 'meow-dark');
  button.dataset.enhancerSyncDim = cfg.key;
  button.setAttribute(
    'aria-label',
    cfg.key === 'MORE' ? 'Thêm thao tác' : `sync-${cfg.key.toLowerCase()}`
  );
  button.title = cfg.key === 'MORE' ? cfg.title : actionTooltip(cfg.key);
  if (cfg.key === 'MORE') {
    button.setAttribute('aria-haspopup', 'menu');
    button.setAttribute('aria-expanded', 'false');
  }
  if (cfg.key === 'MORE' || cfg.key === 'FLIP_180') {
    setMeowIcon(button, cfg.key === 'MORE' ? 'more' : 'flip');
    if (cfg.key === 'FLIP_180') button.appendChild(doc.createTextNode('180°'));
  } else {
    // Letter strokes keep the dimension segment readable at 16px.
    const paths: Partial<Record<SidebarAction, string>> = {
      H: 'M6 4v16M18 4v16M6 12h12',
      W: 'm3 4 4 16 5-12 5 12 4-16',
      L: 'M6 4v16h13',
      SWAP_LW: 'M3 7h18l-4-4M21 17H3l4 4',
      YAW_INTERPOLATE: 'M4 4v16h16M7 15l5-7 4 4 5-8',
      ATTRIBUTES: 'M4 5h16M4 12h16M4 19h16',
      RIDE_STATE: 'm4 12 5 5L20 6',
    };
    const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', '16');
    svg.setAttribute('height', '16');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.75');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    const path = doc.createElementNS(svg.namespaceURI, 'path');
    path.setAttribute('d', paths[cfg.key] ?? '');
    svg.appendChild(path);
    button.appendChild(svg);
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

function actionTooltip(key: SidebarAction): string {
  const hints: Partial<Record<SidebarAction, string>> = {
    H: 'Cao (H): đồng bộ các keyframe cùng thuộc tính',
    W: 'Rộng (W): đồng bộ các keyframe cùng thuộc tính',
    L: 'Dài (L): đồng bộ các keyframe cùng thuộc tính',
    FLIP_180: 'Lật 180°: frame này; Shift+click: toàn track',
    SWAP_LW: 'Đổi L↔W + xoay 90°: frame này; Shift+click: toàn track',
    YAW_INTERPOLATE: 'Nội suy yaw giữa keyframe liền kề; Shift+click: chọn khoảng',
    ATTRIBUTES: 'Chọn thuộc tính hiện tại để áp dụng toàn track',
    RIDE_STATE: 'Áp dụng ride_state hiện tại cho toàn track, kể cả outside',
  };
  return hints[key] ?? 'Thêm thao tác';
}

interface SidebarMenu {
  element: HTMLElement;
  row: HTMLElement | null;
  close: (focus?: boolean) => void;
}
const sidebarMenus = new WeakMap<Document, SidebarMenu>();

function ensureSidebarLifecycle(doc: Document): SidebarMenu {
  const existing = sidebarMenus.get(doc);
  if (existing) return existing;
  const element = doc.createElement('div');
  element.id = 'meow-sidebar-menu';
  element.className = 'ant-dropdown-menu meow-menu';
  element.dataset.meowOwned = 'true';
  element.setAttribute('role', 'menu');
  element.setAttribute('aria-label', 'Thao tác track');
  const state: SidebarMenu = { element, row: null, close: () => undefined };
  sidebarMenus.set(doc, state);
  registerMeowCleanup(doc, () => {
    state.close();
    for (const button of [
      ...Array.from(element.querySelectorAll<HTMLElement>('button')),
      ...Array.from(doc.querySelectorAll<HTMLElement>(`.${ROW_CLASS} button`)),
    ]) {
      const timer = feedbackTimers.get(button);
      if (timer !== undefined) clearTimeout(timer);
      feedbackTimers.delete(button);
    }
    buttonTemplates.delete(doc);
    viewportControllers.get(doc)?.observer.disconnect();
    viewportControllers.delete(doc);
    sidebarMenus.delete(doc);
    for (const row of doc.querySelectorAll<HTMLElement>(`.${ROW_CLASS}`)) {
      row.removeEventListener('click', handleRowClick);
      row.remove();
    }
  });
  return state;
}

function placePopover(panel: HTMLElement, anchor: HTMLElement): void {
  const rect = anchor.getBoundingClientRect();
  const win = anchor.ownerDocument.defaultView;
  const width = panel.offsetWidth || 240;
  const height = panel.offsetHeight || 160;
  panel.style.left = `${Math.max(8, Math.min(rect.right - width, (win?.innerWidth ?? 800) - width - 8))}px`;
  panel.style.top = `${Math.max(8, rect.bottom + height + 4 > (win?.innerHeight ?? 600) ? rect.top - height - 4 : rect.bottom + 4)}px`;
}

function showSidebarMenu(row: HTMLElement, anchor: HTMLButtonElement): void {
  const doc = row.ownerDocument;
  const state = ensureSidebarLifecycle(doc);
  const wasOpen = state.row === row && state.element.isConnected;
  state.close();
  if (wasOpen) return;
  const handler = handlers.get(row);
  if (!handler || handler.busy || anchor.disabled) return;
  const menu = state.element;
  decorateMeowSurface(menu);
  menu.replaceChildren();
  state.row = row;
  for (const cfg of DIMENSION_BUTTON_CONFIGS) {
    if (INLINE_ACTIONS.has(cfg.key) || !handler.enabled.has(cfg.key)) continue;
    const button = createButton(doc, cfg) as HTMLButtonElement;
    button.classList.add('ant-dropdown-menu-item', 'meow-sidebar-item');
    button.setAttribute('role', 'menuitem');
    const label = doc.createElement('span');
    label.textContent =
      (
        {
          SWAP_LW: 'Đổi L↔W',
          YAW_INTERPOLATE: 'Nội suy yaw',
          ATTRIBUTES: 'Thuộc tính',
          RIDE_STATE: 'ride_state',
        } as Partial<Record<SidebarAction, string>>
      )[cfg.key] ?? cfg.key;
    const hint = doc.createElement('span');
    hint.className = 'meow-sidebar-hint';
    hint.textContent =
      cfg.key === 'SWAP_LW'
        ? 'Shift: toàn track'
        : cfg.key === 'YAW_INTERPOLATE'
          ? 'Shift: chọn khoảng'
          : 'Toàn track';
    button.append(label, hint);
    button.onclick = (event) => {
      event.stopPropagation();
      state.close(true);
      runSidebarAction(row, button, event.shiftKey);
    };
    menu.appendChild(button);
  }
  anchor.setAttribute('aria-expanded', 'true');
  const onOutside = (event: Event): void => {
    if (
      event.target instanceof Node &&
      !menu.contains(event.target) &&
      !anchor.contains(event.target)
    )
      state.close();
  };
  const onKey = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopImmediatePropagation();
      state.close(true);
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const buttons = Array.from(menu.querySelectorAll<HTMLButtonElement>('button'));
      const current = buttons.indexOf(doc.activeElement as HTMLButtonElement);
      buttons[
        (current + (event.key === 'ArrowDown' ? 1 : buttons.length - 1)) % buttons.length
      ]?.focus();
    } else if (event.key === 'Tab') state.close();
  };
  const onMove = (): void => state.close();
  const observer = new MutationObserver(() => {
    if (!row.isConnected) state.close();
  });
  state.close = (focus = false) => {
    doc.removeEventListener('pointerdown', onOutside, true);
    doc.removeEventListener('keydown', onKey, true);
    doc.removeEventListener('scroll', onMove, true);
    doc.defaultView?.removeEventListener('resize', onMove);
    observer.disconnect();
    menu.remove();
    anchor.setAttribute('aria-expanded', 'false');
    state.row = null;
    if (focus && anchor.isConnected) anchor.focus();
    state.close = () => undefined;
  };
  doc.body.appendChild(menu);
  placePopover(menu, anchor);
  doc.addEventListener('pointerdown', onOutside, true);
  doc.addEventListener('keydown', onKey, true);
  doc.addEventListener('scroll', onMove, true);
  doc.defaultView?.addEventListener('resize', onMove);
  observer.observe(row.parentNode ?? row, { childList: true });
  menu.querySelector<HTMLButtonElement>('button')?.focus();
}

function handleRowClick(event: MouseEvent): void {
  const row = event.currentTarget as HTMLElement | null;
  const button = (event.target as Element | null)?.closest<HTMLButtonElement>(
    'button[data-enhancer-sync-dim]'
  );
  if (!row || !button || !row.contains(button)) return;
  event.stopPropagation();
  event.preventDefault();
  if (button.dataset.enhancerSyncDim === 'MORE') {
    showSidebarMenu(row, button);
    return;
  }
  runSidebarAction(row, button, event.shiftKey);
}

function runSidebarAction(row: HTMLElement, button: HTMLButtonElement, wholeTrack: boolean): void {
  const activeHandler = handlers.get(row);
  if (!activeHandler || !row.isConnected) return;
  const doc = row.ownerDocument;
  const currentCard = row.closest<HTMLElement>(CARD_SELECTOR);
  const id = currentCard ? clientId(currentCard) : null;
  if (id === null) return;
  const actionKey = button.dataset.enhancerSyncDim as SidebarAction | undefined;
  const cfg = actionKey ? BUTTON_CONFIG_BY_KEY.get(actionKey) : undefined;
  if (!cfg || !activeHandler.enabled.has(cfg.key)) return;
  const name = ACTION_NAMES[cfg.key];
  if (currentCard?.querySelector(LOCK_SELECTOR)) {
    showMeowToast(doc, `#${id}: đang khóa; mở khóa để ${name}`, 'error');
    return;
  }
  if (activeHandler.busy) {
    showMeowToast(doc, `#${id}: đang xử lý…`, 'info');
    return;
  }
  activeHandler.busy = true;
  button.disabled = true;
  setButtonFeedback(button, 'busy');
  // Acknowledge the click immediately; native saves can take a moment on long tracks.
  const toast = showMeowToast(doc, `#${id}: đang ${name}…`, 'loading');
  void Promise.resolve()
    .then(async () => {
      if (cfg.key === 'ATTRIBUTES') {
        const attributes = activeHandler.rideState?.getAttributes?.(id) ?? [];
        if (!attributes.length || !activeHandler.rideState?.syncAttribute)
          throw new Error('Không có thuộc tính mutable');
        const attributeID = await chooseMutableAttribute(currentCard!, attributes);
        if (attributeID === null) return { ok: false, message: `#${id}: đã hủy` };
        const result = await activeHandler.rideState.syncAttribute(id, attributeID);
        const label = attributes.find((a) => a.id === attributeID)?.name ?? String(attributeID);
        return {
          ok: true,
          message: `#${id}: ${label} = ${result.targetValue}, đã cập nhật ${result.updatedKeyframes}/${result.totalKeyframes} keyframe`,
        };
      }
      if (cfg.key === 'RIDE_STATE') {
        const result = await activeHandler.rideState?.sync(id);
        if (!result) throw new Error('Không có ride_state');
        const message = `#${id}: ride_state = ${result.targetValue} · ${result.updatedKeyframes}/${result.totalKeyframes} keyframe${result.outsideKeyframes ? ` (outside: ${result.outsideKeyframes})` : ''}`;
        button.title = message;
        return { ok: true, message };
      }
      let yawRange: readonly [number, number] | undefined;
      if (cfg.key === 'YAW_INTERPOLATE' && wholeTrack) {
        const options = activeHandler.rideState?.getYawRangeOptions?.(id);
        if (!options) throw new Error('Không đọc được keyframe');
        const selected = await chooseYawRange(currentCard!, options.frames, options.currentFrame);
        if (!selected) return { ok: false, message: `#${id}: đã hủy` };
        yawRange = selected;
      }
      if (cfg.key === 'MORE') return { ok: false, message: 'Đã hủy' };
      const result = await (yawRange
        ? activeHandler.onSync(id, cfg.key, false, yawRange)
        : wholeTrack
          ? activeHandler.onSync(id, cfg.key, true)
          : activeHandler.onSync(id, cfg.key));
      if (result.syncedFrames > 0) {
        const message =
          cfg.key === 'FLIP_180' && !wholeTrack
            ? `#${id}: lật 180° frame này (yaw = ${result.targetValue === null ? '' : ((result.targetValue * 180) / Math.PI).toFixed(1)}°)`
            : `#${id}: ${name}: ${result.syncedFrames} frame${wholeTrack ? ' (toàn track)' : ''}` +
              (result.skippedAttributeMismatchFrames
                ? `; bỏ ${result.skippedAttributeMismatchFrames} khác thuộc tính`
                : '');
        return { ok: true, message };
      }
      const message = `#${id}: ${name}: 0 frame thay đổi`;
      button.title = `${actionTooltip(cfg.key)} — Không có frame thay đổi; kiểm tra track và tương thích CVAT`;
      return { ok: false, message };
    })
    .then(({ ok, message }) => {
      if (!row.isConnected) return;
      toast.update(message, ok ? 'success' : 'info');
      setButtonFeedback(button, ok ? 'done' : 'idle');
    })
    .catch((error: unknown) => {
      if (!row.isConnected) return;
      const reason = error instanceof Error && error.message ? `: ${error.message}` : '';
      button.title = `${actionTooltip(cfg.key)} — Đồng bộ lỗi; kiểm tra tương thích CVAT`;
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
    row.className = `${ROW_CLASS} meow-dimension-row meow-surface`;
    row.setAttribute('role', 'group');
    row.setAttribute('aria-label', 'Kích thước và hướng box');
    // Keep the controls outside CVAT's version-specific keyframe/state grid.
    card.appendChild(row);
    mounted = 1;
  }

  let handler = handlers.get(row);
  if (!handler) {
    row.className = `${ROW_CLASS} meow-dimension-row meow-surface`;
    row.setAttribute('role', 'group');
    row.setAttribute('aria-label', 'Kích thước và hướng box');
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
      if (sidebarMenus.get(doc)?.row === row) sidebarMenus.get(doc)?.close();
      reconcileRowButtons(doc, row, variant.configs);
      handler.configSignature = variant.signature;
    }
  }

  const locked = Boolean(card.querySelector(LOCK_SELECTOR));
  const flag = locked ? '1' : '0';
  if (row.dataset.enhancerLocked !== flag) row.dataset.enhancerLocked = flag;
  const disabled = locked || handler.busy;
  const children = row.children;
  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    if (!(child instanceof HTMLButtonElement)) continue;
    if (child.disabled !== disabled) child.disabled = disabled;
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
  ensureMeowStyle(doc);
  ensureSidebarLifecycle(doc);
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

/** Created only on demand, inside the native object card; no attribute scans while idle. */
function chooseMutableAttribute(
  card: HTMLElement,
  attributes: readonly { id: number; name: string }[]
): Promise<number | null> {
  return new Promise((resolve) => {
    const doc = card.ownerDocument;
    const panel = doc.createElement('div');
    panel.className = 'cvat-3d-enhancer-attribute-picker meow-picker';
    const select = doc.createElement('select');
    select.setAttribute('aria-label', 'Thuộc tính áp dụng toàn track');
    for (const attribute of attributes) {
      const option = doc.createElement('option');
      option.value = String(attribute.id);
      option.textContent = attribute.name;
      select.appendChild(option);
    }
    const apply = doc.createElement('button');
    apply.textContent = 'Áp dụng toàn track';
    const cancel = doc.createElement('button');
    cancel.textContent = 'Hủy';
    apply.type = cancel.type = 'button';
    for (const button of [apply, cancel]) {
      button.className = 'ant-btn ant-btn-sm';
      button.setAttribute('aria-label', button.textContent ?? 'Áp dụng');
    }
    const finish = (value: number | null): void => {
      cleanup();
      resolve(value);
    };
    const cleanup = mountPicker(card, panel, () => finish(null));
    panel.addEventListener('click', (event) => event.stopPropagation());
    panel.addEventListener('dblclick', (event) => event.stopPropagation());
    apply.onclick = () => finish(Number(select.value));
    cancel.onclick = () => finish(null);
    panel.append(select, apply, cancel);
    placePopover(panel, card.querySelector<HTMLElement>('[data-enhancer-sync-dim="MORE"]') ?? card);
    select.focus();
  });
}

function chooseYawRange(
  card: HTMLElement,
  frames: readonly number[],
  currentFrame: number
): Promise<readonly [number, number] | null> {
  return new Promise((resolve) => {
    const doc = card.ownerDocument;
    const panel = doc.createElement('div');
    panel.className = 'cvat-3d-enhancer-attribute-picker meow-picker';
    const start = doc.createElement('select');
    const end = doc.createElement('select');
    start.setAttribute('aria-label', 'Keyframe đầu');
    end.setAttribute('aria-label', 'Keyframe cuối');
    for (const frame of frames) {
      for (const select of [start, end]) {
        const option = doc.createElement('option');
        option.value = String(frame);
        option.textContent = String(frame);
        select.appendChild(option);
      }
    }
    start.value = String(frames.filter((f) => f < currentFrame).at(-1) ?? frames[0]);
    end.value = String(frames.find((f) => f > currentFrame) ?? frames.at(-1));
    const apply = doc.createElement('button');
    apply.textContent = 'Nội suy yaw';
    const cancel = doc.createElement('button');
    cancel.textContent = 'Hủy';
    apply.type = cancel.type = 'button';
    for (const button of [apply, cancel]) {
      button.className = 'ant-btn ant-btn-sm';
      button.setAttribute('aria-label', button.textContent ?? 'Áp dụng');
    }
    const finish = (value: readonly [number, number] | null): void => {
      cleanup();
      resolve(value);
    };
    const cleanup = mountPicker(card, panel, () => finish(null));
    panel.addEventListener('click', (event) => event.stopPropagation());
    panel.addEventListener('dblclick', (event) => event.stopPropagation());
    apply.onclick = () => finish([Number(start.value), Number(end.value)]);
    cancel.onclick = () => finish(null);
    panel.append(start, end, apply, cancel);
    placePopover(panel, card.querySelector<HTMLElement>('[data-enhancer-sync-dim="MORE"]') ?? card);
    start.focus();
  });
}

/** Temporary body portal: card layout is unchanged and pending pickers settle on teardown. */
function mountPicker(card: HTMLElement, panel: HTMLElement, cancel: () => void): () => void {
  const doc = card.ownerDocument;
  decorateMeowSurface(panel);
  panel.dataset.meowOwned = 'true';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'Chọn phạm vi áp dụng');
  const onKey = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopImmediatePropagation();
    cancel();
  };
  const onOutside = (event: Event): void => {
    if (event.target instanceof Node && !panel.contains(event.target)) cancel();
  };
  const initialId = clientId(card);
  const observer = new MutationObserver(() => {
    if (!card.isConnected || !panel.isConnected || clientId(card) !== initialId) cancel();
  });
  const onMove = (): void => cancel();
  const unregister = registerMeowCleanup(doc, cancel);
  doc.body.appendChild(panel);
  doc.addEventListener('keydown', onKey, true);
  doc.addEventListener('pointerdown', onOutside, true);
  observer.observe(doc.body, { childList: true, subtree: true });
  observer.observe(card, { attributes: true, attributeFilter: ['id', 'data-client-id'] });
  doc.addEventListener('scroll', onMove, true);
  doc.defaultView?.addEventListener('resize', onMove);
  return () => {
    unregister();
    observer.disconnect();
    doc.removeEventListener('keydown', onKey, true);
    doc.removeEventListener('pointerdown', onOutside, true);
    doc.removeEventListener('scroll', onMove, true);
    doc.defaultView?.removeEventListener('resize', onMove);
    panel.remove();
    card.querySelector<HTMLButtonElement>('[data-enhancer-sync-dim="MORE"]')?.focus();
  };
}
