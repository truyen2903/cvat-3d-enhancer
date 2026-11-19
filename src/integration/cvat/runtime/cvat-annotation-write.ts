/**
 * Official CVAT write path for Meow edits. Every API used here was checked against the cvat-ai/cvat
 * `develop` sources; see the "verified API" table in docs/compatibility.md (section 16).
 *
 * Undo model (one Ctrl+Z per Meow action):
 * - `job.annotations.saveStates(states)` is cvat-core's batch save. It wraps every per-object
 *   change in ONE `AnnotationHistory` transaction (annotations-collection.ts, `saveStates`), which is
 *   exactly what cvat-ui's `updateAnnotationsBatchAsync` (multi-selection move) relies on. The
 *   resulting history entry undoes / redoes all objects together through the native Ctrl+Z.
 * - A transaction can only hold actions of ONE frame (annotations-history.ts, `HistoryTransaction.add`).
 *   Neighbor-frame keyframe pins therefore run first with history frozen (`job.actions.freeze`), so
 *   they never create separate undo steps. Undoing the action restores the edited frame; the pins are
 *   extra keyframes on the exact interpolated values, so the track geometry is unchanged.
 * - CVAT builds without `saveStates` fall back to per-object `ObjectState.save()` (one history entry
 *   per object) and the caller is told how many Ctrl+Z presses are needed. The history instance is
 *   private to cvat-core, so Meow cannot register its own grouped entry from the page.
 *
 * Redux refresh follows cvat-ui's own thunks: `fetchAnnotationsAsync` dispatches
 * `FETCH_ANNOTATIONS_SUCCESS {states, intervals, history}` and `updateAnnotationsAsync` dispatches
 * `UPDATE_ANNOTATIONS_SUCCESS {states, history}`. `history` (from `job.actions.get()`) is what enables
 * the toolbar Undo/Redo buttons.
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
    saveStates?: (states: CvatObjectStateLike[]) => Promise<unknown> | unknown;
  };
  readonly actions?: {
    get?: () => Promise<unknown> | unknown;
    freeze?: (frozen: boolean) => Promise<unknown> | unknown;
  };
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
  /** `annotation.workspace` (cvat-ui `Workspace` enum value, e.g. "Standard 3D" or "Review"). */
  readonly workspace: string | null;
  /** Ground-truth objects are merged into Redux states by cvat-ui; a full replace would drop them. */
  readonly groundTruthShown: boolean;
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
  const jobRecord = record(annotation?.job);
  const job = jobRecord?.instance as CvatJobLike | undefined;
  const settings = record(root?.settings);
  const workspace = record(settings?.workspace);
  const frame = player?.number;
  const filters = annotations?.filters;
  const states = annotations?.states;
  const activated = annotations?.activatedStateID;
  const control = record(annotation?.canvas)?.activeControl;
  const gtInstance = record(jobRecord?.groundTruthInfo)?.groundTruthInstance;
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
    workspace: typeof annotation?.workspace === 'string' ? annotation.workspace : null,
    groundTruthShown: record(settings?.shapes)?.showGroundTruth === true && !!gtInstance,
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

export type RefreshResult = 'ok' | 'stale' | 'failed';

export interface RefreshTarget {
  readonly frame: number | null;
  readonly job: CvatJobLike | null;
}

/**
 * Re-sync cvat-ui's Redux annotation state (states + undo history) after direct writes.
 * `fetch` mirrors `fetchAnnotationsAsync`, `update` mirrors `updateAnnotationsAsync`'s tail (it keeps
 * ground-truth states that are merged into Redux, so it is used when those are shown).
 * Nothing is dispatched when the frame or job changed while we were awaiting (`stale`): CVAT's own
 * frame change already fetched that frame, and replacing its states with ours would corrupt Redux.
 */
export async function refreshCvatAnnotations(
  store: CvatStoreLike | null,
  expected: RefreshTarget,
  kind: 'update' | 'fetch' = 'fetch'
): Promise<RefreshResult> {
  if (!store) return 'failed';
  const ctx = readCvatContext(store);
  const get = ctx.job?.annotations?.get;
  if (!ctx.job || typeof get !== 'function' || ctx.frame === null) return 'failed';
  if (ctx.frame !== expected.frame || ctx.job !== expected.job) return 'stale';
  try {
    const states = await get.call(
      ctx.job.annotations,
      ctx.frame,
      ctx.showAllInterpolationTracks,
      ctx.filters
    );
    if (!Array.isArray(states)) return 'failed';
    const getHistory = ctx.job.actions?.get;
    const history =
      typeof getHistory === 'function' ? await getHistory.call(ctx.job.actions) : undefined;
    const after = readCvatContext(store);
    if (after.frame !== expected.frame || after.job !== expected.job) return 'stale';
    // minZ/maxZ are not read by current cvat-ui reducers (they recompute the range); older builds
    // took them from the payload, so they are kept as harmless extras.
    const [minZ, maxZ] = zRange(states);
    store.dispatch({
      type: kind === 'fetch' ? 'FETCH_ANNOTATIONS_SUCCESS' : 'UPDATE_ANNOTATIONS_SUCCESS',
      payload: { states, history, minZ, maxZ },
    });
    return 'ok';
  } catch {
    return 'failed';
  }
}

/**
 * Same two steps as `applyFilters` in CVAT's filters-modal: `CHANGE_ANNOTATIONS_FILTERS`, then a
 * full re-fetch. Refused (false) when ground-truth states are shown because a full replace of the
 * Redux states would drop them.
 */
export async function applyCvatFilters(
  store: CvatStoreLike | null,
  filters: readonly unknown[]
): Promise<boolean> {
  if (!store) return false;
  const before = readCvatContext(store);
  if (before.groundTruthShown) return false;
  store.dispatch({ type: 'CHANGE_ANNOTATIONS_FILTERS', payload: { filters: [...filters] } });
  // `stale` still means the filter was applied: CVAT's own frame change re-fetches with it.
  return (
    (await refreshCvatAnnotations(store, { frame: before.frame, job: before.job })) !== 'failed'
  );
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
  /** Strict batch refused before touching anything (a member was locked / outside / unwritable). */
  refused: boolean;
  /**
   * `transaction`: one native undo step (`saveStates`). `per-object`: CVAT without `saveStates`,
   * one undo step per saved object (see `undoSteps`).
   */
  historyMode: 'transaction' | 'per-object' | 'none';
  /** Number of native Ctrl+Z presses that revert this action. */
  undoSteps: number;
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
      // Track.save(frame, state) with no update flags set only returns `new ObjectState(this.get(frame))`.
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

export interface WriteOptions {
  readonly job?: CvatJobLike | null;
  readonly lastFrame?: number;
  /**
   * All-or-nothing: if any member cannot be written (locked, outside, ground truth, no snapshot
   * access) nothing is written at all. Used for swaps where a half-applied result would duplicate
   * geometry.
   */
  readonly strict?: boolean;
}

interface Before {
  readonly points?: number[];
  readonly attributes?: Record<number | string, string | undefined>;
  readonly occluded?: boolean;
  readonly hidden?: boolean;
}

function snapshotBefore(write: StateWrite): Before {
  const state = write.state;
  const attributes: Record<number | string, string | undefined> = {};
  for (const key of Object.keys(write.attributes ?? {})) attributes[key] = state.attributes?.[key];
  return {
    ...(write.points ? { points: [...(state.points ?? [])] } : {}),
    ...(write.attributes ? { attributes } : {}),
    ...(write.occluded !== undefined ? { occluded: !!state.occluded } : {}),
    ...(write.hidden !== undefined ? { hidden: !!state.hidden } : {}),
  };
}

function applyToState(state: CvatObjectStateLike, change: Before): void {
  // ObjectState property setters raise their own update flags (object-state.ts).
  state.updateFlags?.reset?.();
  if (change.points) state.points = [...change.points];
  if (change.attributes) {
    const defined: Record<string, string> = {};
    for (const [key, value] of Object.entries(change.attributes))
      if (value !== undefined) defined[key] = value;
    state.attributes = { ...state.attributes, ...defined };
  }
  if (change.occluded !== undefined) state.occluded = change.occluded;
  if (change.hidden !== undefined) state.hidden = change.hidden;
}

function nextFor(write: StateWrite): Before {
  const state = write.state;
  return {
    ...(write.points
      ? { points: [...write.points, ...(state.points ?? []).slice(write.points.length)] }
      : {}),
    ...(write.attributes ? { attributes: { ...write.attributes } } : {}),
    ...(write.occluded !== undefined ? { occluded: write.occluded } : {}),
    ...(write.hidden !== undefined ? { hidden: write.hidden } : {}),
  };
}

async function setFrozen(job: CvatJobLike | null | undefined, frozen: boolean): Promise<boolean> {
  const freeze = job?.actions?.freeze;
  if (typeof freeze !== 'function') return false;
  await freeze.call(job!.actions, frozen);
  return true;
}

function emptySummary(): WriteSummary {
  return {
    written: 0,
    pinnedNeighbors: 0,
    skippedLocked: 0,
    skippedOutside: 0,
    failed: 0,
    refused: false,
    historyMode: 'none',
    undoSteps: 0,
  };
}

/**
 * Write current-frame changes for many objects as ONE undo step when CVAT supports it (see the
 * file header). Neighbor pinning for tracks happens first with history frozen; the edits then go
 * through a single `saveStates` transaction. The caller refreshes Redux once afterwards.
 */
export async function writeStatesAtFrame(
  writes: readonly StateWrite[],
  frame: number,
  options: WriteOptions = {}
): Promise<WriteSummary> {
  const { job, lastFrame, strict = false } = options;
  const summary = emptySummary();
  const todo: StateWrite[] = [];
  for (const write of writes) {
    const state = write.state;
    // Shape/Track.save() return early without changes when the object is locked.
    if (state.lock) summary.skippedLocked += 1;
    else if (state.outside) summary.skippedOutside += 1;
    else if (state.isGroundTruth || typeof state.save !== 'function') summary.failed += 1;
    else todo.push(write);
  }
  const skipped = summary.skippedLocked + summary.skippedOutside + summary.failed;
  if (strict && skipped > 0) {
    summary.refused = true;
    return summary;
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
        if (strict) {
          summary.refused = true;
          return summary;
        }
        continue;
      }
    }
    ready.push(write);
  }
  if (!ready.length) return summary;

  const saveStates = job?.annotations?.saveStates;
  const batch = typeof saveStates === 'function';
  const frozen = pins.length > 0 && batch ? await setFrozen(job, true) : false;
  try {
    for (const pin of pins) {
      try {
        pin.updateFlags!.reset!();
        pin.points = [...pin.points!];
        pin.keyframe = true;
        await pin.save!();
        summary.pinnedNeighbors += 1;
        if (!frozen) summary.undoSteps += 1;
      } catch {
        // A track whose neighbor could not be pinned must not be edited: abort before any edit.
        summary.failed += 1;
        summary.refused = true;
        return summary;
      }
    }
  } finally {
    if (frozen) await setFrozen(job, false).catch(() => undefined);
  }

  if (batch) return writeTransaction(ready, summary, saveStates!, job!);
  return writePerObject(ready, summary, strict);
}

async function writeTransaction(
  ready: readonly StateWrite[],
  summary: WriteSummary,
  saveStates: NonNullable<NonNullable<CvatJobLike['annotations']>['saveStates']>,
  job: CvatJobLike
): Promise<WriteSummary> {
  for (const write of ready) applyToState(write.state, nextFor(write));
  try {
    await saveStates.call(
      job.annotations,
      ready.map((write) => write.state)
    );
    summary.written = ready.length;
    summary.historyMode = 'transaction';
    summary.undoSteps += 1;
  } catch {
    // saveStates aborts its transaction, rolling every object back; nothing was written.
    summary.failed += ready.length;
  }
  return summary;
}

async function writePerObject(
  ready: readonly StateWrite[],
  summary: WriteSummary,
  strict: boolean
): Promise<WriteSummary> {
  summary.historyMode = 'per-object';
  const done: { write: StateWrite; before: Before }[] = [];
  for (const write of ready) {
    const before = snapshotBefore(write);
    try {
      applyToState(write.state, nextFor(write));
      await write.state.save!();
      done.push({ write, before });
      summary.written += 1;
      summary.undoSteps += 1;
    } catch {
      summary.failed += 1;
      if (strict) {
        for (const item of done.reverse()) {
          try {
            applyToState(item.write.state, item.before);
            await item.write.state.save!();
            summary.written -= 1;
            summary.undoSteps += 1;
          } catch {
            // best effort: the user can still Ctrl+Z the partial result
          }
        }
        return summary;
      }
    }
  }
  return summary;
}
