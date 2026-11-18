import { injectCvatObjectDimensionSyncControls } from './object-dimension-controls';
import { getRideStateAttribute, syncTrackRideState } from './ride-state-sync';
import {
  CLIENT_SETTINGS_STORAGE_KEY,
  ENHANCER_STANDALONE_STORAGE_KEY,
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

const CARD_ID_PREFIX = 'cvat-objects-sidebar-state-item-';
const CARD_SELECTOR = '.cvat-objects-sidebar-state-item, [id^="cvat-objects-sidebar-state-item-"]';
const INTERACTIVE_TARGET_SELECTOR =
  'input,textarea,select,button,a,[role="button"],.ant-select,.anticon,[contenteditable="true"]';
const IGNORED_MUTATION_SELECTOR =
  '.cvat-3d-enhancer-dim-sync-row, #cvat-3d-enhancer-workspace-settings-section, [data-enhancer-workspace-settings="true"], #meow-toast-stack, .ant-select-dropdown';

interface FiberLike {
  memoizedProps?: Record<string, unknown>;
  return?: FiberLike | null;
}

export interface SidebarObjectContext {
  state: CvatObjectStateLike;
  refresh: (() => unknown) | null;
}

let cachedFiberKey: string | null = null;

function getReactFiber(el: Element): FiberLike | undefined {
  const record = el as unknown as Record<string, unknown>;
  if (cachedFiberKey !== null && cachedFiberKey in record) {
    return record[cachedFiberKey] as FiberLike | undefined;
  }
  for (const name of Object.keys(el)) {
    if (name.startsWith('__reactFiber$') || name.startsWith('__reactInternalInstance$')) {
      cachedFiberKey = name;
      return record[name] as FiberLike | undefined;
    }
  }
  return undefined;
}

function isAsciiDigits(value: string): boolean {
  if (value.length === 0) return false;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 48 || code > 57) return false;
  }
  return true;
}

function extractCardClientId(card: Element): number | null {
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

function resolveTargetCard(
  doc: Document,
  clientID: number,
  cardHint?: Element | null
): Element | null {
  if (cardHint && cardHint.ownerDocument === doc) {
    const hintedId = extractCardClientId(cardHint);
    if (hintedId === null || hintedId === clientID) {
      return cardHint;
    }
  }
  return (
    doc.getElementById(`cvat-objects-sidebar-state-item-${clientID}`) ??
    doc.querySelector<HTMLElement>(
      `.cvat-objects-sidebar-state-item[data-client-id="${clientID}"], [data-client-id="${clientID}"]`
    )
  );
}

function resolveSidebarCardStateOnly(
  card: Element,
  expectedId: number
): CvatObjectStateLike | null {
  let fiber = getReactFiber(card);
  for (let depth = 0; fiber && depth < 20; depth++, fiber = fiber?.return ?? undefined) {
    const candidate = fiber.memoizedProps?.objectState;
    if (!candidate || typeof candidate !== 'object') continue;
    const state = candidate as CvatObjectStateLike;
    if (state.clientID !== expectedId) continue;
    if (state.shapeType !== 'cuboid') return null;
    return state;
  }
  return null;
}

/** Read only the requested annotation's sidebar props; never inspect canvas/point-cloud data. */
export function resolveSidebarObjectContext(
  doc: Document,
  clientID: number,
  cardHint?: Element | null
): SidebarObjectContext | null {
  if (!Number.isSafeInteger(clientID) || clientID < 0) return null;
  const card = resolveTargetCard(doc, clientID, cardHint);
  if (!card) return null;
  let fiber = getReactFiber(card);
  for (let depth = 0; fiber && depth < 20; depth++, fiber = fiber?.return ?? undefined) {
    const props = fiber.memoizedProps;
    const candidate = props?.objectState;
    if (!candidate || typeof candidate !== 'object') continue;
    const state = candidate as CvatObjectStateLike;
    if (state.clientID !== clientID) continue;
    if (state.shapeType !== 'cuboid') return null;
    const refresh = props?.refreshAnnotations;
    const updateState = props?.updateState;
    return {
      state,
      refresh:
        typeof refresh === 'function'
          ? () => refresh()
          : typeof updateState === 'function' && state.__internal?.save
            ? () => {
                state.updateFlags?.reset?.();
                const fresh = state.__internal!.save!(state.frame ?? 0, state);
                return updateState(fresh);
              }
            : null,
    };
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

export function sidebarHasRideState(
  doc: Document,
  clientID: number,
  cardHint?: Element | null
): boolean {
  if (!Number.isSafeInteger(clientID) || clientID < 0) return false;
  const card = resolveTargetCard(doc, clientID, cardHint);
  if (!card) return false;
  return Boolean(getRideStateAttribute(resolveSidebarCardStateOnly(card, clientID)));
}

export async function syncSidebarRideState(doc: Document, clientID: number) {
  const context = resolveSidebarObjectContext(doc, clientID);
  if (!context) throw new Error('CVAT sidebar ObjectState is unavailable');
  const result = await syncTrackRideState(clientID, context.state);
  if (result.updatedKeyframes > 0) await context.refresh?.();
  return result;
}

/** Resolve CVAT's own focus action without using its combined focus/Quick-filter handler. */
function resolveSidebarFocus(card: Element): (() => void) | null {
  let fiber = getReactFiber(card);
  for (let depth = 0; fiber && depth < 20; depth++, fiber = fiber?.return ?? undefined) {
    const focus = fiber.memoizedProps?.focus ?? fiber.memoizedProps?.focusAndExpand;
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
    if (event.button !== 0 || (event.type !== 'dblclick' && event.detail < 2) || !isEnabled())
      return;
    const target = event.target as Element | null;
    if (!target || target.ownerDocument !== doc) return;
    const card = target.closest?.(CARD_SELECTOR);
    if (!card || target.closest(INTERACTIVE_TARGET_SELECTOR)) return;
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

function isEnhancerInternalNode(node: Node): boolean {
  if (node.nodeType !== 1) return false;
  const el = node as Element;
  return (
    el.classList.contains('cvat-3d-enhancer-dim-sync-row') ||
    el.id === 'cvat-3d-enhancer-workspace-settings-section' ||
    el.id === 'meow-toast-stack' ||
    el.id === 'meow-toast-style' ||
    el.getAttribute('data-enhancer-workspace-settings') === 'true'
  );
}

function isOnlyEnhancerAddedMutation(record: MutationRecord): boolean {
  if (record.removedNodes.length > 0 || record.addedNodes.length === 0) return false;
  for (let i = 0; i < record.addedNodes.length; i++) {
    if (!isEnhancerInternalNode(record.addedNodes[i]!)) return false;
  }
  return true;
}

/** Standalone sidebar integration, also usable when the 3D renderer adapter is unavailable. */
export function installSidebarEnhancements(doc: Document, win: Window): () => void {
  let options = readRenderOptionsFromClientSettings(win.localStorage);
  const removeGuard = installSidebarQuickFilterGuard(
    doc,
    win,
    () => options.disableSidebarQuickFilter ?? true
  );

  const rideStateBridge = {
    isAvailable: (id: number, card?: HTMLElement) => sidebarHasRideState(doc, id, card),
    sync: (id: number) => syncSidebarRideState(doc, id),
  };
  const handleSync = (id: number, dim: CuboidDimensionKey) =>
    syncSidebarObjectDimension(doc, id, dim);

  let observer: MutationObserver | null = null;
  const reconcile = (
    targetCards: Iterable<HTMLElement> | null,
    includeWorkspaceSettings: boolean
  ): void => {
    injectCvatObjectDimensionSyncControls(
      doc,
      handleSync,
      targetCards
        ? {
            enableDimensionSync: options.enableDimensionSync,
            enableHeadingFlip: options.enableHeadingFlip,
            targetCards,
          }
        : options,
      rideStateBridge
    );
    if (includeWorkspaceSettings) {
      injectCvatWorkspaceSettingsControls(
        doc,
        () => options,
        (next) => {
          options = writeRenderOptionsToClientSettings(next, win.localStorage);
          reconcile(null, true);
        }
      );
    }
    observer?.takeRecords();
  };

  reconcile(null, true);

  let disposed = false;
  let rafId: number | null = null;
  let microtaskPending = false;
  let fullSidebarScan = false;
  let dirtySettings = false;
  const dirtyCards = new Set<HTMLElement>();

  const flush = (): void => {
    if (disposed) return;
    const scanAll = fullSidebarScan;
    const syncSettings = dirtySettings;
    fullSidebarScan = false;
    dirtySettings = false;

    if (scanAll) {
      dirtyCards.clear();
      reconcile(null, syncSettings);
      return;
    }

    if (dirtyCards.size > 0) {
      const connected: HTMLElement[] = [];
      for (const card of dirtyCards) {
        if (card.isConnected) connected.push(card);
      }
      dirtyCards.clear();
      if (connected.length > 0) {
        reconcile(connected, syncSettings);
        return;
      }
    }

    if (syncSettings) {
      reconcile([], true);
    }
  };

  const scheduleFlush = (): void => {
    if (disposed || rafId !== null || microtaskPending) return;
    if (typeof win.requestAnimationFrame === 'function') {
      rafId = win.requestAnimationFrame(() => {
        rafId = null;
        flush();
      });
    } else {
      microtaskPending = true;
      queueMicrotask(() => {
        microtaskPending = false;
        flush();
      });
    }
  };

  const onStorage = (event: StorageEvent): void => {
    if (
      event.key === null ||
      event.key === CLIENT_SETTINGS_STORAGE_KEY ||
      event.key === ENHANCER_STANDALONE_STORAGE_KEY
    ) {
      options = readRenderOptionsFromClientSettings(win.localStorage);
      fullSidebarScan = true;
      dirtySettings = true;
      scheduleFlush();
    }
  };
  win.addEventListener('storage', onStorage);

  const MAX_DIRTY_CARDS = 128;

  const addDirtyCard = (card: HTMLElement): void => {
    if (fullSidebarScan) return;
    if (dirtyCards.size >= MAX_DIRTY_CARDS) {
      fullSidebarScan = true;
      dirtyCards.clear();
      return;
    }
    dirtyCards.add(card);
  };

  const collectAddedElement = (el: Element): void => {
    if (el.matches(CARD_SELECTOR)) {
      addDirtyCard(el as HTMLElement);
      return;
    }
    if (
      el.classList.contains('cvat-workspace-settings') ||
      el.querySelector('.cvat-workspace-settings') !== null
    ) {
      dirtySettings = true;
    }
    if (el.classList.contains('cvat-objects-sidebar')) {
      fullSidebarScan = true;
      dirtyCards.clear();
      return;
    }
    if (!fullSidebarScan) {
      if (el.childElementCount <= 4) {
        const innerCards = el.querySelectorAll<HTMLElement>(CARD_SELECTOR);
        if (innerCards.length > 0) {
          for (let i = 0; i < innerCards.length; i++) {
            addDirtyCard(innerCards[i]!);
          }
          return;
        }
      } else if (el.querySelector(CARD_SELECTOR) !== null) {
        fullSidebarScan = true;
        dirtyCards.clear();
      }
    }
  };

  observer = new MutationObserver((records) => {
    for (let i = 0; i < records.length; i++) {
      const record = records[i]!;
      const targetEl =
        record.target.nodeType === 1 ? (record.target as Element) : record.target.parentElement;
      if (!targetEl) continue;
      if (targetEl.closest(IGNORED_MUTATION_SELECTOR)) continue;
      if (record.type === 'childList' && isOnlyEnhancerAddedMutation(record)) continue;

      const card = targetEl.closest<HTMLElement>(CARD_SELECTOR);
      if (card) {
        addDirtyCard(card);
        continue;
      }

      if (targetEl.closest('.cvat-workspace-settings')) {
        dirtySettings = true;
        continue;
      }

      if (record.type === 'childList') {
        const inSidebar = Boolean(targetEl.closest('.cvat-objects-sidebar'));
        if (inSidebar && record.addedNodes.length > MAX_DIRTY_CARDS) {
          fullSidebarScan = true;
          dirtyCards.clear();
          continue;
        }
        for (let j = 0; j < record.addedNodes.length; j++) {
          const added = record.addedNodes[j]!;
          if (added.nodeType !== 1) continue;
          collectAddedElement(added as Element);
        }
        if (inSidebar && record.addedNodes.length === 0 && record.removedNodes.length > 0) {
          // Cards removed during filter/frame update; IntersectionObserver handles remaining cards.
          continue;
        }
      }
    }

    if (fullSidebarScan || dirtySettings || dirtyCards.size > 0) {
      scheduleFlush();
    }
  });

  observer.observe(doc.documentElement, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['class', 'id', 'aria-label', 'data-client-id'],
  });

  return () => {
    disposed = true;
    if (rafId !== null && typeof win.cancelAnimationFrame === 'function') {
      win.cancelAnimationFrame(rafId);
    }
    rafId = null;
    observer?.disconnect();
    win.removeEventListener('storage', onStorage);
    removeGuard();
  };
}
