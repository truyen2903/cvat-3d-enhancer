/**
 * Official CVAT write path for Meow edits.
 *
 * Writes go through `ObjectState.save()` (the same call cvat-ui's `updateAnnotationsAsync` makes),
 * so cvat-core records them in its action history. cvat-ui only enables Undo/Redo (button and
 * Ctrl+Z) from the `history` snapshot held in Redux, which is refreshed by the
 * `UPDATE_ANNOTATIONS_SUCCESS` action; `refreshCvatAnnotations` mirrors that thunk's tail
 * (`job.actions.get()` + `job.annotations.get(...)` + the same action) because the thunk itself is
 * not reachable from the page. Filters follow `filters-modal.tsx`: `CHANGE_ANNOTATIONS_FILTERS`
 * followed by a re-fetch of the current frame (`FETCH_ANNOTATIONS_SUCCESS`).
 */
import type { CvatObjectStateLike } from './pre-render-enhancer';

export interface CvatJobLike {
  readonly startFrame?: number;
  readonly stopFrame?: number;
  readonly annotations?: {
    get?: (
      frame: number,
      allTracks: boolean,
      filters: readonly unknown[]
    ) => Promise<CvatObjectStateLike[]> | CvatObjectStateLike[];
  };
  readonly actions?: { get?: () => Promise<unknown> | unknown };
}

export interface CvatStoreLike {
  getState: () => Record<string, unknown>;
  dispatch: (action: { type: string; payload?: Record<string, unknown> }) => unknown;
}

export interface CvatAnnotationContext {
  readonly job: CvatJobLike | null;
  readonly frame: number | null;
  readonly lastFrame: number | undefined;
  readonly filters: readonly unknown[];
  readonly showAllInterpolationTracks: boolean;
  readonly states: readonly CvatObjectStateLike[];
  readonly activatedStateID: number | null;
  readonly activeControl: string | null;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

export function readCvatContext(store: CvatStoreLike | null): CvatAnnotationContext {
  const root = record(store?.getState());
  const annotation = record(root?.annotation);
  const annotations = record(annotation?.annotations);
  const player = record(record(annotation?.player)?.frame);
  const job = record(annotation?.job)?.instance as CvatJobLike | undefined;
  const workspace = record(record(root?.settings)?.workspace);
  const frame = player?.number;
  const filters = annotations?.filters;
  const states = annotations?.states;
  const activated = annotations?.activatedStateID;
  const control = record(annotation?.canvas)?.activeControl;
  return {
    job: job ?? null,
    frame: typeof frame === 'number' && Number.isSafeInteger(frame) ? frame : null,
    lastFrame:
      typeof job?.stopFrame === 'number' && Number.isSafeInteger(job.stopFrame)
        ? job.stopFrame
        : undefined,
    filters: Array.isArray(filters) ? filters : [],
    showAllInterpolationTracks: workspace?.showAllInterpolationTracks === true,
    states: Array.isArray(states) ? (states as CvatObjectStateLike[]) : [],
    activatedStateID:
      typeof activated === 'number' && Number.isFinite(activated) ? activated : null,
    activeControl: typeof control === 'string' ? control : null,
  };
}

/** Annotation reads below never touch the server: cvat-core serves them from its in-memory collection. */
export async function readUnfilteredFrameStates(
  store: CvatStoreLike | null
): Promise<CvatObjectStateLike[] | null> {
  const ctx = readCvatContext(store);
  const get = ctx.job?.annotations?.get;
  if (!ctx.job || typeof get !== 'function' || ctx.frame === null) return null;
  try {
    const states = await get.call(
      ctx.job.annotations,
      ctx.frame,
      ctx.showAllInterpolationTracks,
      []
    );
    return Array.isArray(states) ? states : null;
  } catch {
    return null;
  }
}

function zRange(states: readonly CvatObjectStateLike[]): [number, number] {
  let min = Infinity;
  let max = -Infinity;
  for (const state of states) {
    const z = (state as { zOrder?: unknown }).zOrder;
    if (typeof z !== 'number') continue;
    if (z < min) min = z;
    if (z > max) max = z;
  }
  return min <= max ? [min, max] : [0, 0];
}

/** Re-sync cvat-ui's Redux annotation state (states + undo history) after direct writes. */
export async function refreshCvatAnnotations(
  store: CvatStoreLike | null,
  kind: 'update' | 'fetch' = 'update'
): Promise<boolean> {
  if (!store) return false;
  const ctx = readCvatContext(store);
  const get = ctx.job?.annotations?.get;
  if (!ctx.job || typeof get !== 'function' || ctx.frame === null) return false;
  try {
    const states = await get.call(
      ctx.job.annotations,
      ctx.frame,
      ctx.showAllInterpolationTracks,
      ctx.filters
    );
    if (!Array.isArray(states)) return false;
    const [minZ, maxZ] = zRange(states);
    if (kind === 'fetch') {
      store.dispatch({ type: 'FETCH_ANNOTATIONS_SUCCESS', payload: { states, minZ, maxZ } });
      return true;
    }
    const getHistory = ctx.job.actions?.get;
    const history =
      typeof getHistory === 'function' ? await getHistory.call(ctx.job.actions) : undefined;
    store.dispatch({
      type: 'UPDATE_ANNOTATIONS_SUCCESS',
      payload: { states, history, minZ, maxZ },
    });
    return true;
  } catch {
    return false;
  }
}

/** Same two steps as `applyFilters` in CVAT's filters-modal: change filters, then re-fetch. */
export async function applyCvatFilters(
  store: CvatStoreLike | null,
  filters: readonly unknown[]
): Promise<boolean> {
  if (!store) return false;
  store.dispatch({ type: 'CHANGE_ANNOTATIONS_FILTERS', payload: { filters: [...filters] } });
  return refreshCvatAnnotations(store, 'fetch');
}

export interface StateWrite {
  readonly state: CvatObjectStateLike;
  readonly points?: readonly number[];
  readonly attributes?: Readonly<Record<number | string, string>>;
  readonly occluded?: boolean;
  readonly hidden?: boolean;
}

export interface WriteSummary {
  written: number;
  pinnedNeighbors: number;
  skippedLocked: number;
  skippedOutside: number;
  failed: number;
}

/**
 * Neighbor frames (f-1, f+1) of a track that are interpolated (inside the track, not outside and
 * not keyframes). Linear interpolation means pinning them to their current values keeps every
 * other interpolated frame on exactly the same line once frame f becomes a keyframe.
 */
export function collectNeighborPins(
  state: CvatObjectStateLike,
  frame: number,
  lastFrame?: number
): CvatObjectStateLike[] {
  const read = state.__internal?.save;
  if (typeof read !== 'function' || !state.updateFlags?.reset) {
    throw new Error('CVAT track snapshot access is unavailable');
  }
  const pins: CvatObjectStateLike[] = [];
  for (const neighbor of [frame - 1, frame + 1]) {
    if (neighbor < 0 || (lastFrame !== undefined && neighbor > lastFrame)) continue;
    state.updateFlags.reset();
    let snapshot: CvatObjectStateLike;
    try {
      snapshot = read(neighbor, state);
    } catch {
      continue;
    }
    if (
      snapshot.outside ||
      snapshot.keyframe ||
      !snapshot.points ||
      snapshot.points.length < 9 ||
      !snapshot.points.every(Number.isFinite) ||
      !snapshot.updateFlags?.reset ||
      typeof snapshot.save !== 'function'
    )
      continue;
    pins.push(snapshot);
  }
  return pins;
}

/**
 * Write current-frame changes for many objects. Neighbor pinning for tracks happens first (all
 * snapshots are read before any write), then each object is saved once through `ObjectState.save()`.
 * The caller refreshes Redux once afterwards with `refreshCvatAnnotations`.
 */
export async function writeStatesAtFrame(
  writes: readonly StateWrite[],
  frame: number,
  lastFrame?: number
): Promise<WriteSummary> {
  const summary: WriteSummary = {
    written: 0,
    pinnedNeighbors: 0,
    skippedLocked: 0,
    skippedOutside: 0,
    failed: 0,
  };
  const todo: StateWrite[] = [];
  for (const write of writes) {
    const state = write.state;
    if (state.lock && write.hidden === undefined) summary.skippedLocked += 1;
    else if (state.outside && write.hidden === undefined) summary.skippedOutside += 1;
    else if (typeof state.save !== 'function') summary.failed += 1;
    else todo.push(write);
  }

  const pins: CvatObjectStateLike[] = [];
  const ready: StateWrite[] = [];
  for (const write of todo) {
    const changesShape =
      write.points !== undefined || write.attributes !== undefined || write.occluded !== undefined;
    if (changesShape && write.state.objectType === 'track') {
      try {
        pins.push(...collectNeighborPins(write.state, frame, lastFrame));
      } catch {
        // Without a snapshot we cannot prove neighbors stay put, so never write this track.
        summary.failed += 1;
        continue;
      }
    }
    ready.push(write);
  }
  for (const pin of pins) {
    try {
      pin.updateFlags!.reset!();
      pin.points = [...pin.points!];
      pin.keyframe = true;
      pin.updateFlags!.points = true;
      pin.updateFlags!.keyframe = true;
      await pin.save!();
      summary.pinnedNeighbors += 1;
    } catch {
      summary.failed += 1;
    }
  }

  for (const write of ready) {
    const state = write.state;
    try {
      state.updateFlags?.reset?.();
      const flags = state.updateFlags;
      if (write.points) {
        const tail = (state.points ?? []).slice(write.points.length);
        state.points = [...write.points, ...tail];
        if (flags) flags.points = true;
      }
      if (write.attributes) {
        state.attributes = { ...state.attributes, ...write.attributes };
        if (flags) flags.attributes = true;
      }
      if (write.occluded !== undefined) {
        state.occluded = write.occluded;
        if (flags) flags.occluded = true;
      }
      if (write.hidden !== undefined) {
        state.hidden = write.hidden;
        if (flags) flags.hidden = true;
      }
      await state.save!();
      summary.written += 1;
    } catch {
      summary.failed += 1;
    }
  }
  return summary;
}
