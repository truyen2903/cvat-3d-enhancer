interface State {
  clientID: number;
  updated?: unknown;
}
interface IncrementalView {
  drawnObjects: Record<number, { data: { updated?: unknown } }>;
  setupObjectsIncremental: (states: State[]) => void;
  deactivateObject: () => void;
  createObjects: (states: State[]) => void;
  updateObjects: (states: State[]) => void;
  deleteObjects: (ids: number[]) => void;
  activateObject: () => void;
  [PATCH_MARKER]?: () => void;
}
const PATCH_MARKER = Symbol.for('meowIncrementalObjects');
const REQUIRED_METHODS = [
  'setupObjectsIncremental',
  'deactivateObject',
  'createObjects',
  'updateObjects',
  'deleteObjects',
  'activateObject',
] as const;

/** Replace only the quadratic deleted-ID search; retain native partition and mutation order. */
export function accelerateIncrementalObjects(input: unknown): (() => void) | null {
  const view = input as IncrementalView | null;
  if (!view?.drawnObjects || REQUIRED_METHODS.some((key) => typeof view[key] !== 'function')) {
    return null;
  }
  if (view[PATCH_MARKER]) return view[PATCH_MARKER];
  const native = view.setupObjectsIncremental;
  let enabled = true;
  const wrapped = (states: State[]): void => {
    if (!enabled) return native.call(view, states);
    let created: State[];
    let updated: State[];
    let deleted: number[];
    if (!Array.isArray(states) || REQUIRED_METHODS.some((key) => typeof view[key] !== 'function')) {
      return native.call(view, states);
    }
    try {
      created = states.filter((state) => !(state.clientID in view.drawnObjects));
      updated = states.filter(
        (state) =>
          state.clientID in view.drawnObjects &&
          view.drawnObjects[state.clientID]!.data.updated !== state.updated
      );
      const ids = new Set<number>();
      for (const state of states) ids.add(state.clientID);
      deleted = Object.keys(view.drawnObjects)
        .map((key) => +key)
        // Native strict equality never matches NaN, whereas Set.has does.
        .filter((id) => Number.isNaN(id) || !ids.has(id));
    } catch {
      return native.call(view, states);
    }
    // Do not retry after mutations: a native private method may already have changed the scene.
    view.deactivateObject();
    view.createObjects(created);
    view.updateObjects(updated);
    view.deleteObjects(deleted);
    view.activateObject();
  };
  const dispose = (): void => {
    enabled = false;
    if (view.setupObjectsIncremental === wrapped)
      Reflect.set(view, 'setupObjectsIncremental', native);
    Reflect.deleteProperty(view, PATCH_MARKER);
  };
  try {
    if (!Reflect.set(view, PATCH_MARKER, dispose)) return null;
    if (!Reflect.set(view, 'setupObjectsIncremental', wrapped)) {
      dispose();
      return null;
    }
    return dispose;
  } catch {
    dispose();
    return null;
  }
}
