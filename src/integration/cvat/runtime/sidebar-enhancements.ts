import { injectCvatObjectDimensionSyncControls } from './object-dimension-controls';
import {
  syncTrackCuboidDimension,
  readRenderOptionsFromClientSettings,
  writeRenderOptionsToClientSettings,
  injectCvatWorkspaceSettingsControls,
} from './pre-render-enhancer';
import type {
  CuboidDimensionKey,
  CvatObjectStateLike,
  DimensionSyncResult,
} from './pre-render-enhancer';

const CARD_SELECTOR = '.cvat-objects-sidebar-state-item, [id^="cvat-objects-sidebar-state-item-"]';
interface FiberLike {
  memoizedProps?: Record<string, unknown>;
  return?: FiberLike | null;
}
export interface SidebarObjectContext {
  state: CvatObjectStateLike;
  refresh: (() => unknown) | null;
}

/** Read only the requested annotation's sidebar props; never inspect canvas/point-cloud data. */
export function resolveSidebarObjectContext(
  doc: Document,
  clientID: number
): SidebarObjectContext | null {
  if (!Number.isSafeInteger(clientID) || clientID < 0) return null;
  const card =
    doc.getElementById(`cvat-objects-sidebar-state-item-${clientID}`) ??
    [...doc.querySelectorAll<HTMLElement>(CARD_SELECTOR)].find(
      (item) => item.dataset.clientId === String(clientID)
    );
  if (!card) return null;
  const key = Object.keys(card).find(
    (name) => name.startsWith('__reactFiber$') || name.startsWith('__reactInternalInstance$')
  );
  let fiber = key
    ? ((card as unknown as Record<string, unknown>)[key] as FiberLike | undefined)
    : undefined;
  for (let depth = 0; fiber && depth < 20; depth++, fiber = fiber?.return ?? undefined) {
    const props = fiber.memoizedProps;
    const candidate = props?.objectState;
    if (!candidate || typeof candidate !== 'object') continue;
    const state = candidate as CvatObjectStateLike;
    if (state.clientID !== clientID || state.shapeType !== 'cuboid') continue;
    const refresh = props?.refreshAnnotations;
    return { state, refresh: typeof refresh === 'function' ? () => refresh() : null };
  }
  return null;
}

export async function syncSidebarObjectDimension(
  doc: Document,
  clientID: number,
  dimension: CuboidDimensionKey
): Promise<DimensionSyncResult> {
  const context = resolveSidebarObjectContext(doc, clientID);
  if (!context) throw new Error('CVAT sidebar ObjectState is unavailable');
  const result = await syncTrackCuboidDimension(clientID, dimension, {
    stateOnCurrentFrame: context.state,
  });
  if (result.syncedFrames > 0) await context.refresh?.();
  return result;
}

/** Resolve CVAT's own focus action without using its combined focus/Quick-filter handler. */
function resolveSidebarFocus(card: Element): (() => void) | null {
  const key = Object.keys(card).find(
    (name) => name.startsWith('__reactFiber$') || name.startsWith('__reactInternalInstance$')
  );
  let fiber = key
    ? ((card as unknown as Record<string, unknown>)[key] as FiberLike | undefined)
    : undefined;
  for (let depth = 0; fiber && depth < 20; depth++, fiber = fiber?.return ?? undefined) {
    const focus = fiber.memoizedProps?.focus;
    const activateSingle = fiber.memoizedProps?.activateSingle;
    if (typeof focus === 'function')
      return () => {
        if (typeof activateSingle === 'function') activateSingle();
        focus();
      };
  }
  return null;
}

/** Preserve native double-click focus while bypassing CVAT's combined Quick-filter handler. */
export function installSidebarQuickFilterGuard(
  doc: Document,
  win: Window,
  isEnabled: () => boolean = () => true,
  onFocus: () => void = () => undefined
): () => void {
  const guard = (event: MouseEvent): void => {
    if (!isEnabled()) return;
    const target = event.target as Element | null;
    if (target?.ownerDocument !== doc || event.button !== 0) return;
    const card = target.closest?.(CARD_SELECTOR);
    if (
      !card ||
      target.closest(
        'input,textarea,select,button,a,[role="button"],.ant-select,.anticon,[contenteditable="true"]'
      )
    )
      return;
    if (event.type !== 'dblclick' && event.detail < 2) return;
    const focus = resolveSidebarFocus(card);
    // Unknown CVAT builds retain their original behavior rather than losing focus.
    if (!focus) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (event.type === 'dblclick') {
      onFocus();
      focus();
    }
  };
  const types = ['mousedown', 'click', 'dblclick'] as const;
  for (const type of types) win.addEventListener(type, guard, true);
  return () => {
    for (const type of types) win.removeEventListener(type, guard, true);
  };
}

/** Standalone sidebar integration, also usable when the 3D renderer adapter is unavailable. */
export function installSidebarEnhancements(doc: Document, win: Window): () => void {
  let options = readRenderOptionsFromClientSettings(win.localStorage);
  const removeGuard = installSidebarQuickFilterGuard(
    doc,
    win,
    () => options.disableSidebarQuickFilter ?? true
  );
  const mount = () => {
    options = readRenderOptionsFromClientSettings(win.localStorage);
    injectCvatObjectDimensionSyncControls(
      doc,
      (id, dim) => syncSidebarObjectDimension(doc, id, dim),
      options
    );
    injectCvatWorkspaceSettingsControls(
      doc,
      () => options,
      (next) => {
        options = writeRenderOptionsToClientSettings(next, win.localStorage);
        mount();
      }
    );
  };
  mount();
  let pending = false;
  let disposed = false;
  const observer = new MutationObserver((records) => {
    if (
      !records.some(
        (record) =>
          record.type === 'childList' || (record.target as Element).closest?.(CARD_SELECTOR)
      )
    )
      return;
    if (pending) return;
    pending = true;
    queueMicrotask(() => {
      pending = false;
      if (!disposed) mount();
    });
  });
  observer.observe(doc.documentElement, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['class', 'id', 'aria-label', 'data-client-id'],
  });
  return () => {
    disposed = true;
    observer.disconnect();
    removeGuard();
  };
}
