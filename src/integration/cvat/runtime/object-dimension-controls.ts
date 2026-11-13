import type { CuboidDimensionKey, DimensionSyncResult } from './pre-render-enhancer';
import type { RideStateSyncResult } from './ride-state-sync';

const ROW_CLASS = 'cvat-3d-enhancer-dim-sync-row';
const CARD_SELECTOR = '.cvat-objects-sidebar-state-item, [id^="cvat-objects-sidebar-state-item-"]';
const LOCK_SELECTOR =
  '.cvat-object-item-button-lock-enabled, .cvat-object-item-button-lock.anticon-lock, .cvat-object-item-button-lock[aria-label="lock"]';
type SyncDimension = (
  clientID: number,
  dimension: CuboidDimensionKey
) => Promise<DimensionSyncResult> | DimensionSyncResult;
export interface RideStateControl {
  isAvailable: (clientID: number) => boolean;
  sync: (clientID: number) => Promise<RideStateSyncResult>;
}
type SidebarAction = CuboidDimensionKey | 'RIDE_STATE';
const handlers = new WeakMap<
  HTMLElement,
  {
    onSync: SyncDimension;
    enabled: ReadonlySet<SidebarAction>;
    rideState?: RideStateControl;
    busy: boolean;
  }
>();

const DIMENSION_BUTTON_CONFIGS: readonly {
  readonly key: SidebarAction;
  readonly className: string;
  readonly title: string;
  readonly svgPath: string;
}[] = [
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

function clientId(card: Element): number | null {
  const raw = card.getAttribute('data-client-id');
  const match = /^cvat-objects-sidebar-state-item-(\d+)$/.exec(card.id);
  const value = raw !== null && /^\d+$/.test(raw) ? Number(raw) : match ? Number(match[1]) : NaN;
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function createButton(doc: Document, cfg: (typeof DIMENSION_BUTTON_CONFIGS)[number]): HTMLElement {
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
  return button;
}

/** Mount and repair controls without depending on Ant grid spans or keyframe buttons. */
export function injectCvatObjectDimensionSyncControls(
  doc: Document,
  onSync: SyncDimension,
  options: { enableDimensionSync?: boolean; enableHeadingFlip?: boolean } = {},
  rideState?: RideStateControl
): number {
  let mountedCount = 0;
  for (const card of doc.querySelectorAll<HTMLElement>(CARD_SELECTOR)) {
    const id = clientId(card);
    if (id === null) continue;
    const configs = DIMENSION_BUTTON_CONFIGS.filter((cfg) =>
      cfg.key === 'RIDE_STATE'
        ? Boolean(rideState?.isAvailable(id))
        : cfg.key === 'FLIP_180'
          ? options.enableHeadingFlip !== false
          : options.enableDimensionSync !== false
    );
    const enabled = new Set(configs.map((cfg) => cfg.key));
    if (!configs.length) {
      card.querySelector(`.${ROW_CLASS}`)?.remove();
      continue;
    }
    const typeText = card
      .querySelector('.cvat-objects-sidebar-state-item-object-type-text')
      ?.textContent?.trim();
    if (typeText && !/^cuboid\s+track$/i.test(typeText)) {
      card.querySelector(`.${ROW_CLASS}`)?.remove();
      continue;
    }

    let row = card.querySelector<HTMLElement>(`.${ROW_CLASS}`);
    if (!row) {
      row = doc.createElement('div');
      row.className = ROW_CLASS;
      row.setAttribute('role', 'group');
      row.setAttribute('aria-label', 'Cuboid dimensions');
      // Keep the controls outside CVAT's version-specific keyframe/state grid.
      card.appendChild(row);
      mountedCount += 1;
    }

    let handler = handlers.get(row);
    if (!handler) {
      row.className = ROW_CLASS;
      row.setAttribute('role', 'group');
      row.setAttribute('aria-label', 'Cuboid dimensions');
      row.style.cssText =
        'display: flex !important; visibility: visible !important; justify-content: space-around; ' +
        'align-items: center; flex-wrap: wrap; width: 100%; min-height: 26px;';
      handler = { onSync, enabled, rideState, busy: false };
      handlers.set(row, handler);
      // Replace rows cloned/restored by the host: their DOM survives, their listeners do not.
      row.replaceChildren(...configs.map((cfg) => createButton(doc, cfg)));
      const activeHandler = handler;
      row.addEventListener('click', (event) => {
        const target = event.target as Element | null;
        const button = target?.closest<HTMLButtonElement>('button[data-enhancer-sync-dim]');
        if (!button || !row.contains(button)) return;
        event.stopPropagation();
        event.preventDefault();
        const currentCard = row.closest(CARD_SELECTOR);
        const id = currentCard ? clientId(currentCard) : null;
        if (id === null || currentCard?.querySelector(LOCK_SELECTOR)) return;
        const cfg = DIMENSION_BUTTON_CONFIGS.find(
          (item) => item.key === button.dataset.enhancerSyncDim
        );
        if (!cfg || !activeHandler.enabled.has(cfg.key) || activeHandler.busy) return;
        activeHandler.busy = true;
        button.disabled = true;
        void Promise.resolve()
          .then(async () => {
            if (cfg.key === 'RIDE_STATE') {
              const result = await activeHandler.rideState?.sync(id);
              if (!result) throw new Error('ride_state is unavailable');
              button.title = `ride_state = ${result.targetValue} across all frames (${result.updatedKeyframes}/${result.totalKeyframes} keyframes updated)`;
              return null;
            }
            return activeHandler.onSync(id, cfg.key);
          })
          .then((result) => {
            if (!result) return;
            if (result.syncedFrames > 0) {
              button.title =
                cfg.key === 'FLIP_180'
                  ? `Flipped 180° on current frame (Yaw = ${result.targetValue === null ? '' : ((result.targetValue * 180) / Math.PI).toFixed(1)}°)`
                  : `${cfg.key} = ${result.targetValue?.toFixed(2) ?? ''} synced to ${result.syncedFrames} keyframe(s) (${result.skippedAttributeMismatchFrames} skipped due to different attributes)`;
            } else {
              button.title = `${cfg.title} — No frames updated; check track state and runtime compatibility`;
            }
          })
          .catch(() => {
            button.title = `${cfg.title} — Sync failed; check runtime compatibility`;
          })
          .finally(() => {
            activeHandler.busy = false;
            button.disabled = Boolean(row.closest(CARD_SELECTOR)?.querySelector(LOCK_SELECTOR));
          });
      });
    } else {
      handler.onSync = onSync;
      handler.enabled = enabled;
      handler.rideState = rideState;
      for (const button of row.querySelectorAll<HTMLElement>('[data-enhancer-sync-dim]')) {
        if (!configs.some((cfg) => cfg.key === button.dataset.enhancerSyncDim)) button.remove();
      }
      for (const cfg of configs) {
        const button = row.querySelector<HTMLElement>(`[data-enhancer-sync-dim="${cfg.key}"]`);
        if (!button?.querySelector('svg path')) {
          const replacement = createButton(doc, cfg);
          if (button) button.replaceWith(replacement);
          else row.appendChild(replacement);
        }
      }
    }
    const locked = Boolean(card.querySelector(LOCK_SELECTOR));
    const flag = locked ? '1' : '0';
    if (row.dataset.enhancerLocked !== flag) row.dataset.enhancerLocked = flag;
    for (const button of row.querySelectorAll<HTMLButtonElement>(
      'button[data-enhancer-sync-dim]'
    )) {
      const disabled = locked || handler.busy;
      if (button.disabled !== disabled) button.disabled = disabled;
      const opacity = locked ? '0.5' : '1';
      if (button.style.opacity !== opacity) button.style.opacity = opacity;
    }
  }
  return mountedCount;
}
