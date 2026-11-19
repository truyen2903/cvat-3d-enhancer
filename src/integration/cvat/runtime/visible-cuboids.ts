import { invalidateHoverSpatialIndex } from './hover-lock';

interface RuntimeView {
  drawnObjects?: Record<string, { cuboid?: Record<string, unknown> }>;
  getAllVisibleCuboids?: (...args: unknown[]) => unknown[];
  notify?: (model: unknown, reason: string) => void;
  [CACHE_MARKER]?: () => void;
}

interface VisibilityWatch {
  generation: number;
  restore: () => void;
}

const versionedViews = new WeakMap<object, () => boolean>();

export function canReuseVisibleCuboidBounds(view: unknown): boolean {
  return typeof view === 'object' && view !== null && (versionedViews.get(view)?.() ?? false);
}

const CACHE_MARKER = Symbol.for('meowVisibleCuboids');

/** Instance-only cache for CVAT's perspective picking list; unsupported meshes stay native. */
export function cacheVisibleCuboids(input: unknown): (() => void) | null {
  const view = input as RuntimeView | null;
  if (
    !view ||
    typeof view.getAllVisibleCuboids !== 'function' ||
    typeof view.notify !== 'function' ||
    !view.drawnObjects
  ) {
    return null;
  }
  if (view[CACHE_MARKER]) return view[CACHE_MARKER];
  const native = view.getAllVisibleCuboids;
  const watches = new Map<object, VisibilityWatch>();
  let generation = 0;
  let source: RuntimeView['drawnObjects'] = view.drawnObjects;
  let cached: unknown[] | null = null;
  let enabled = true;
  let notifyDepth = 0;
  const invalidate = (): void => {
    if (!enabled) return;
    cached = null;
    invalidateHoverSpatialIndex();
  };
  const restoreWatches = (): void => {
    for (const watch of watches.values()) watch.restore();
    watches.clear();
  };
  const wrapped = (...args: unknown[]): unknown[] => {
    if (!enabled || notifyDepth > 0 || (args[0] !== undefined && args[0] !== 'perspective')) {
      return native.apply(view, args);
    }
    if (source !== view.drawnObjects) {
      source = view.drawnObjects;
      invalidate();
    }
    if (cached) return cached;
    // Call native outside the optimization catch: never retry a native exception.
    const result = native.apply(view, args);
    try {
      generation += 1;
      const expected: unknown[] = [];
      for (const entry of Object.values(view.drawnObjects ?? {})) {
        const mesh = entry.cuboid?.perspective;
        if (!mesh || typeof mesh !== 'object') throw new Error('Unsupported cuboid');
        const visibleMesh = mesh as { visible?: unknown };
        if (visibleMesh.visible) expected.push(mesh);
        const existing = watches.get(mesh);
        if (existing) {
          existing.generation = generation;
          continue;
        }
        const descriptor = Object.getOwnPropertyDescriptor(mesh, 'visible');
        // Accessors/nonconfigurable fields may have side effects; leave that build native.
        if (!descriptor?.configurable || !descriptor.writable || !('value' in descriptor)) {
          throw new Error('Unsupported visibility descriptor');
        }
        let value: unknown = descriptor.value;
        const get = (): unknown => value;
        Object.defineProperty(mesh, 'visible', {
          configurable: true,
          enumerable: descriptor.enumerable,
          get,
          set(next: unknown) {
            if (next !== value) {
              value = next;
              invalidate();
            }
          },
        });
        watches.set(mesh, {
          generation,
          restore: () => {
            if (Object.getOwnPropertyDescriptor(mesh, 'visible')?.get === get) {
              Reflect.defineProperty(mesh, 'visible', { ...descriptor, value });
            }
          },
        });
      }
      for (const [mesh, watch] of watches) {
        if (watch.generation !== generation) {
          watch.restore();
          watches.delete(mesh);
        }
      }
      if (result.length !== expected.length || result.some((mesh, i) => mesh !== expected[i])) {
        throw new Error('Unsupported visible cuboid algorithm');
      }
      cached = result;
    } catch {
      // An unfamiliar runtime shape disables caching, without changing native results.
      restoreWatches();
      enabled = false;
    }
    return result;
  };
  const notify = view.notify;
  const wrappedNotify = (model: unknown, reason: string): void => {
    // Invalidate every reason, including version-specific group/merge/split/draw reasons.
    invalidate();
    notifyDepth += 1;
    try {
      notify?.call(view, model, reason);
    } finally {
      notifyDepth -= 1;
      invalidate();
    }
  };
  const dispose = (): void => {
    enabled = false;
    versionedViews.delete(view);
    cached = null;
    source = undefined;
    invalidateHoverSpatialIndex();
    restoreWatches();
    if (view.getAllVisibleCuboids === wrapped) Reflect.set(view, 'getAllVisibleCuboids', native);
    if (view.notify === wrappedNotify) Reflect.set(view, 'notify', notify);
    Reflect.deleteProperty(view, CACHE_MARKER);
  };
  try {
    if (!Reflect.set(view, CACHE_MARKER, dispose)) return null;
    if (
      !Reflect.set(view, 'getAllVisibleCuboids', wrapped) ||
      !Reflect.set(view, 'notify', wrappedNotify)
    ) {
      dispose();
      return null;
    }
    versionedViews.set(view, () => enabled && notifyDepth === 0);
    return dispose;
  } catch {
    dispose();
    return null;
  }
}
