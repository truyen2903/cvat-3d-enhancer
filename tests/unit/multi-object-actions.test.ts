import { describe, expect, it, vi } from 'vitest';
import type { CvatObjectStateLike } from '../../src/integration/cvat/runtime/pre-render-enhancer';
import {
  FilterHistory,
  MultiObjectRunner,
  availableActions,
  composeAddFilter,
  composeOnlyFilter,
  objectIdLogic,
  planBottomAlign,
  planSizeSync,
  planSourceSync,
  planSwap,
  resolvePair,
} from '../../src/integration/cvat/runtime/multi-object-actions';
import {
  collectNeighborPins,
  type CvatStoreLike,
} from '../../src/integration/cvat/runtime/cvat-annotation-write';

const LABEL = {
  id: 1,
  name: 'car',
  attributes: [
    { id: 10, name: 'sitting', mutable: true },
    { id: 11, name: 'ride_state', mutable: true },
    { id: 12, name: 'color', mutable: false },
  ],
};

function shape(
  id: number,
  points: number[],
  extra: Partial<CvatObjectStateLike> = {}
): CvatObjectStateLike {
  const state: CvatObjectStateLike = {
    clientID: id,
    frame: 5,
    objectType: 'shape',
    shapeType: 'cuboid',
    points: [...points, 0, 0, 0, 0, 0, 0, 0],
    attributes: { 10: 'a', 11: 'b', 12: 'fixed' + id },
    occluded: false,
    label: LABEL,
    updateFlags: { reset: vi.fn() },
    ...extra,
  };
  state.save = vi.fn(async () => state);
  return state;
}
const P_A = [1, 2, 3, 0, 0, 0.5, 4, 2, 1.5];
const P_B = [10, 20, 30, 0, 0, 1.5, 3, 1.8, 1.2];

describe('multi-object planners', () => {
  it('swaps position, rotation and size but keeps each own tail and immutable attributes', () => {
    const a = shape(1, P_A);
    const b = shape(2, P_B);
    const plan = planSwap(a, b, false);
    expect(plan.writes[0]!.points!.slice(0, 9)).toEqual(P_B);
    expect(plan.writes[1]!.points!.slice(0, 9)).toEqual(P_A);
    expect(plan.writes[0]!.attributes).toBeUndefined();
    expect(plan.attributesBlocked).toBe(false);
  });
  it('swaps only mutable attributes and occluded when requested', () => {
    const a = shape(1, P_A, { attributes: { 10: 'x', 11: 'y', 12: 'keep1' }, occluded: true });
    const b = shape(2, P_B, { attributes: { 10: 'p', 11: 'q', 12: 'keep2' } });
    const [wa, wb] = planSwap(a, b, true).writes;
    expect(wa!.attributes).toEqual({ 10: 'p', 11: 'q' });
    expect(wb!.attributes).toEqual({ 10: 'x', 11: 'y' });
    expect(wa!.occluded).toBe(false);
    expect(wb!.occluded).toBe(true);
  });
  it('blocks the attribute swap on label mismatch but still swaps geometry', () => {
    const a = shape(1, P_A);
    const b = shape(2, P_B, { label: { ...LABEL, id: 2, name: 'bus' } });
    const plan = planSwap(a, b, true);
    expect(plan.attributesBlocked).toBe(true);
    expect(plan.writes).toHaveLength(2);
    expect(plan.writes.every((w) => w.attributes === undefined && w.points)).toBe(true);
  });
  it('source→target sync copies size and mutable attributes, not position or yaw', () => {
    const source = shape(1, P_A, { attributes: { 10: 'S', 11: 'T', 12: 'imm' }, occluded: true });
    const target = shape(2, P_B);
    const [write] = planSourceSync(source, target).writes;
    expect(write!.points!.slice(0, 9)).toEqual([...P_B.slice(0, 6), 4, 2, 1.5]);
    expect(write!.attributes).toEqual({ 10: 'S', 11: 'T' });
    expect(write!.occluded).toBe(true);
  });
  it('source→target sync skips attributes across labels', () => {
    const source = shape(1, P_A);
    const target = shape(2, P_B, { label: { ...LABEL, id: 3, name: 'bus' } });
    const plan = planSourceSync(source, target);
    expect(plan.attributesBlocked).toBe(true);
    expect(plan.writes[0]!.attributes).toBeUndefined();
    expect(plan.writes[0]!.points![6]).toBe(4);
  });
  it('pins bottoms to the source bottom while keeping each H', () => {
    const source = shape(1, [0, 0, 10, 0, 0, 0, 4, 2, 2]); // bottom 9
    const o1 = shape(2, [5, 5, 0, 0, 0, 0, 1, 1, 1]);
    const o2 = shape(3, [6, 6, 0, 0, 0, 0, 1, 1, 3]);
    const { writes } = planBottomAlign(source, [o1, o2]);
    expect(writes.map((w) => w.points![2])).toEqual([9.5, 10.5]);
    expect(writes.map((w) => w.points![8])).toEqual([1, 3]);
  });
  it('syncs size keeping bottoms and skips other labels', () => {
    const source = shape(1, [0, 0, 10, 0, 0, 0, 4, 2, 2]);
    const same = shape(2, [5, 5, 1, 0, 0, 0.3, 1, 1, 1]); // bottom 0.5
    const other = shape(3, [6, 6, 0, 0, 0, 0, 1, 1, 1], {
      label: { ...LABEL, id: 9, name: 'bus' },
    });
    const plan = planSizeSync(source, [same, other]);
    expect(plan.skipped).toBe(1);
    expect(plan.writes).toHaveLength(1);
    const p = plan.writes[0]!.points!;
    expect(p.slice(6, 9)).toEqual([4, 2, 2]);
    expect(p[2]! - p[8]! / 2).toBeCloseTo(0.5);
    expect(p[5]).toBe(0.3);
  });
});

describe('filter composition', () => {
  it('adds the cluster with OR to a non-empty filter and keeps the keypoint filter', () => {
    const current = [{ '==': [{ var: 'label' }, 'car'] }, { kp: 1 }];
    const next = composeAddFilter(current, [7, 3, 7]);
    expect(next[0]).toEqual({ or: [current[0], { in: [{ var: 'objectID' }, [3, 7]] }] });
    expect(next[1]).toEqual({ kp: 1 });
  });
  it('uses just the id filter when nothing is active and keeps string filters as strings', () => {
    expect(composeAddFilter([], [2])).toEqual([objectIdLogic([2])]);
    const next = composeAddFilter([JSON.stringify({ '>': [{ var: 'width' }, 1] })], [2]);
    expect(typeof next[0]).toBe('string');
    expect(JSON.parse(next[0] as string).or).toHaveLength(2);
  });
  it('only-filter replaces everything and history restores previous filters LIFO', () => {
    expect(composeOnlyFilter([5, 4])).toEqual([{ in: [{ var: 'objectID' }, [4, 5]] }]);
    const history = new FilterHistory(2);
    history.push([1]);
    history.push([2]);
    history.push([3]);
    expect(history.size).toBe(2);
    expect(history.pop()).toEqual([3]);
    expect(history.pop()).toEqual([2]);
    expect(history.pop()).toBeUndefined();
  });
});

describe('availability and pair resolution', () => {
  it('pairs the active source with exactly one other selected object', () => {
    expect(resolvePair([2], 1)).toEqual({ source: 1, first: 1, second: 2 });
    expect(resolvePair([1, 2], 1)).toEqual({ source: 1, first: 1, second: 2 });
    expect(resolvePair([2, 3], 1)).toBeNull();
    expect(resolvePair([2, 3], null)).toEqual({ source: null, first: 2, second: 3 });
  });
  it('offers cluster actions only with a selection and source actions only with a source', () => {
    const ids = (a: Parameters<typeof availableActions>[0]) => availableActions(a).map((d) => d.id);
    const base = { selectionSize: 3, pair: false, hasSource: false, filterHistorySize: 0 };
    expect(ids(base)).toEqual(
      expect.arrayContaining(['filter-add', 'filter-only', 'hide', 'show', 'add-surroundings'])
    );
    expect(ids(base)).not.toContain('pin-bottom');
    expect(ids(base)).not.toContain('filter-restore');
    expect(ids({ ...base, hasSource: true, filterHistorySize: 1 })).toEqual(
      expect.arrayContaining(['pin-bottom', 'sync-size', 'filter-restore'])
    );
    expect(ids({ ...base, selectionSize: 1, pair: true, hasSource: true })).toContain(
      'swap-geometry'
    );
  });
});

/* --------------------------------------------------------------------------------------------
 * Fake cvat-core modeled on the real sources (annotations-history.ts, annotations-collection.ts
 * `saveStates`, annotations-objects/track.ts + shape.ts, object-state.ts): property setters raise
 * update flags, `save()` records one history entry per changed property with its frame, and a
 * transaction accepts actions of a single frame only.
 * ------------------------------------------------------------------------------------------ */

interface HistoryItem {
  action: string;
  clientIds: number[];
  frame: number | null;
  undo: () => void;
  redo: () => void;
}

class FakeHistory {
  public frozen = false;
  public undoStack: HistoryItem[] = [];
  public redoStack: HistoryItem[] = [];
  private transaction: HistoryItem[] | null = null;

  public freeze(frozen: boolean): void {
    this.frozen = frozen;
  }
  public get() {
    return {
      undo: this.undoStack.map((i) => [i.action, i.frame] as [string, number | null]),
      redo: this.redoStack.map((i) => [i.action, i.frame] as [string, number | null]),
    };
  }
  public do(
    action: string,
    undo: () => void,
    redo: () => void,
    clientIds: number[],
    frame: number | null
  ): void {
    if (this.frozen) return;
    const item = { action, undo, redo, clientIds, frame };
    if (this.transaction) {
      if (this.transaction.length && this.transaction[0]!.frame !== frame)
        throw new Error('All history actions in a transaction must target the same frame');
      this.transaction.push(item);
      return;
    }
    this.undoStack.push(item);
    this.redoStack = [];
  }
  public beginTransaction(): boolean {
    if (this.transaction) return false;
    this.transaction = [];
    return true;
  }
  public endTransaction(): void {
    const items = this.transaction;
    this.transaction = null;
    if (!items || !items.length) return;
    this.undoStack.push({
      action: 'Changed objects',
      clientIds: items.flatMap((i) => i.clientIds),
      frame: items[0]!.frame,
      undo: () => [...items].reverse().forEach((i) => i.undo()),
      redo: () => items.forEach((i) => i.redo()),
    });
    this.redoStack = [];
  }
  public abortTransaction(): void {
    const items = this.transaction;
    this.transaction = null;
    [...(items ?? [])].reverse().forEach((i) => i.undo());
  }
  public undo(): void {
    const item = this.undoStack.pop();
    if (!item) return;
    item.undo();
    this.redoStack.push(item);
  }
  public redo(): void {
    const item = this.redoStack.pop();
    if (!item) return;
    item.redo();
    this.undoStack.push(item);
  }
}

interface Shapeish {
  points: number[];
  attributes: Record<string, string>;
  occluded: boolean;
}

class FakeObject {
  public hidden = false;
  public lock = false;
  public shapes: Record<number, Shapeish> = {};
  public constructor(
    public readonly clientID: number,
    public readonly objectType: 'track' | 'shape',
    private readonly history: FakeHistory,
    public readonly frameOfShape: number
  ) {}

  private interpolated(frame: number): Shapeish {
    if (frame in this.shapes) return this.shapes[frame]!;
    const keys = Object.keys(this.shapes)
      .map(Number)
      .sort((a, b) => a - b);
    const left = [...keys].reverse().find((k) => k < frame);
    const right = keys.find((k) => k > frame);
    if (left !== undefined && right !== undefined) {
      const t = (frame - left) / (right - left);
      const a = this.shapes[left]!;
      const b = this.shapes[right]!;
      return {
        points: a.points.map((v, i) => v + (b.points[i]! - v) * t),
        attributes: { ...a.attributes },
        occluded: a.occluded,
      };
    }
    return this.shapes[left ?? right!]!;
  }

  public snapshot(frame: number): FakeState {
    const s = this.interpolated(frame);
    return new FakeState(this, frame, {
      points: [...s.points],
      attributes: { ...s.attributes },
      occluded: s.occluded,
      keyframe: frame in this.shapes,
      hidden: this.hidden,
      lock: this.lock,
    });
  }

  private put(frame: number, next: Shapeish | undefined, action: string): void {
    const prev = this.shapes[frame];
    const apply = (value: Shapeish | undefined) => {
      if (value) this.shapes[frame] = value;
      else delete this.shapes[frame];
    };
    apply(next);
    this.history.do(
      action,
      () => apply(prev),
      () => apply(next),
      [this.clientID],
      frame
    );
  }

  /** Mirrors Track.save / Shape.save: locked objects return early without changes. */
  public save(frame: number, data: FakeState): FakeState {
    if (this.lock && data.lock) return this.snapshot(frame);
    if (this.objectType === 'shape' && frame !== this.frameOfShape)
      throw new Error('Received frame is not equal to the frame of the shape');
    const f = data.updateFlags;
    const current = this.interpolated(frame);
    if (f.hidden) {
      const prev = this.hidden;
      this.hidden = data.hidden;
      const next = data.hidden;
      this.history.do(
        'Changed hidden',
        () => (this.hidden = prev),
        () => (this.hidden = next),
        [this.clientID],
        frame
      );
    }
    if (f.points) this.put(frame, { ...current, points: [...data.points] }, 'Changed points');
    if (f.occluded)
      this.put(frame, { ...this.interpolated(frame), occluded: data.occluded }, 'Changed occluded');
    if (f.attributes)
      this.put(
        frame,
        { ...this.interpolated(frame), attributes: { ...data.attributes } },
        'Changed attributes'
      );
    if (f.keyframe && this.objectType === 'track') {
      const was = frame in this.shapes;
      if (data.keyframe && !was)
        this.put(frame, { ...this.interpolated(frame) }, 'Changed keyframe');
      else if (!data.keyframe && was) this.put(frame, undefined, 'Changed keyframe');
    }
    data.updateFlags.reset();
    return this.snapshot(frame);
  }
}

class FakeState {
  public readonly updateFlags: Record<string, boolean> & { reset: () => void };
  public readonly objectType: string;
  public readonly shapeType = 'cuboid';
  public readonly clientID: number;
  public readonly label = LABEL;
  public readonly outside = false;
  public readonly __internal: { save: (frame: number, state: FakeState) => FakeState };
  private data: {
    points: number[];
    attributes: Record<string, string>;
    occluded: boolean;
    keyframe: boolean;
    hidden: boolean;
    lock: boolean;
  };

  public constructor(
    private readonly model: FakeObject,
    public readonly frame: number,
    data: FakeState['data']
  ) {
    this.data = data;
    this.clientID = model.clientID;
    this.objectType = model.objectType;
    const flags: Record<string, boolean> = {};
    Object.defineProperty(flags, 'reset', {
      value: () => {
        for (const key of Object.keys(flags)) delete flags[key];
      },
    });
    this.updateFlags = flags as FakeState['updateFlags'];
    this.__internal = { save: (f, s) => model.save(f, s) };
  }
  public get points(): number[] {
    return this.data.points;
  }
  public set points(v: number[]) {
    this.updateFlags.points = true;
    this.data.points = v;
  }
  public get attributes(): Record<string, string> {
    return this.data.attributes;
  }
  public set attributes(v: Record<string, string>) {
    this.updateFlags.attributes = true;
    Object.assign(this.data.attributes, v);
  }
  public get occluded(): boolean {
    return this.data.occluded;
  }
  public set occluded(v: boolean) {
    this.updateFlags.occluded = true;
    this.data.occluded = v;
  }
  public get keyframe(): boolean {
    return this.data.keyframe;
  }
  public set keyframe(v: boolean) {
    this.updateFlags.keyframe = true;
    this.data.keyframe = v;
  }
  public get hidden(): boolean {
    return this.data.hidden;
  }
  public set hidden(v: boolean) {
    this.updateFlags.hidden = true;
    this.data.hidden = v;
  }
  public get lock(): boolean {
    return this.data.lock;
  }
  public async save(): Promise<FakeState> {
    return this.model.save(this.frame, this);
  }
}

const tail = [0, 0, 0, 0, 0, 0, 0];
function shapeish(points: number[], attributes: Record<string, string>): Shapeish {
  return { points: [...points, ...tail], attributes, occluded: false };
}

function createWorld(options: { saveStates?: boolean; frame?: number } = {}) {
  const history = new FakeHistory();
  const frame = { value: options.frame ?? 5 };
  const objects = new Map<number, FakeObject>();
  // 1: track keyframes at 0 and 10 only (frames 4..6 interpolated); 2: track with keyframes 4, 5, 6;
  // 3: plain shape on frame 5.
  const t1 = new FakeObject(1, 'track', history, 0);
  t1.shapes[0] = shapeish([0, 0, 0, 0, 0, 0, 4, 2, 2], { 10: 'a1', 11: 'b1' });
  t1.shapes[10] = shapeish([10, 0, 0, 0, 0, 0, 4, 2, 2], { 10: 'a1', 11: 'b1' });
  const t2 = new FakeObject(2, 'track', history, 0);
  for (const f of [4, 5, 6])
    t2.shapes[f] = shapeish([f, 20, 0, 0, 0, 0.5, 3, 1.8, 1.2], { 10: 'a2', 11: 'b2' });
  const s3 = new FakeObject(3, 'shape', history, 5);
  s3.shapes[5] = shapeish([50, 50, 5, 0, 0, 0, 2, 2, 2], { 10: 'a3', 11: 'b3' });
  for (const o of [t1, t2, s3]) objects.set(o.clientID, o);

  const job = {
    stopFrame: 20,
    annotations: {
      get: vi.fn(async (f: number) =>
        [...objects.values()]
          .filter((o) => o.objectType === 'track' || o.frameOfShape === f)
          .map((o) => o.snapshot(f))
      ),
      ...(options.saveStates === false
        ? {}
        : {
            saveStates: vi.fn(async (states: FakeState[]) => {
              const own = history.beginTransaction();
              try {
                for (const state of states) objects.get(state.clientID)!.save(state.frame, state);
              } catch (error) {
                if (own) history.abortTransaction();
                throw error;
              } finally {
                if (own) history.endTransaction();
              }
            }),
          }),
    },
    actions: {
      get: vi.fn(async () => history.get()),
      freeze: vi.fn(async (frozen: boolean) => history.freeze(frozen)),
      undo: vi.fn(async () => history.undo()),
      redo: vi.fn(async () => history.redo()),
    },
  };

  const redux: Record<string, unknown> = {
    states: [] as unknown[],
    history: history.get(),
    filters: [] as unknown[],
  };
  const dispatched: { type: string; payload?: Record<string, unknown> }[] = [];
  const root = {
    annotation: {
      job: { instance: job } as Record<string, unknown>,
      player: {
        frame: {
          get number() {
            return frame.value;
          },
        },
      },
      get annotations() {
        return { ...redux, activatedStateID: 1 };
      },
      canvas: { activeControl: 'cursor' },
      workspace: 'Standard 3D',
    },
    settings: {
      workspace: { showAllInterpolationTracks: false },
      shapes: {} as Record<string, unknown>,
    },
  };
  const store: CvatStoreLike = {
    getState: () => root,
    dispatch: (action) => {
      dispatched.push(action);
      if (
        action.type === 'FETCH_ANNOTATIONS_SUCCESS' ||
        action.type === 'UPDATE_ANNOTATIONS_SUCCESS'
      ) {
        redux.states = action.payload!.states;
        redux.history = action.payload!.history;
      }
      if (action.type === 'CHANGE_ANNOTATIONS_FILTERS') redux.filters = action.payload!.filters;
    },
  };
  /** cvat-ui undoActionAsync / redoActionAsync: job.actions.undo(), then fetchAnnotationsAsync. */
  const nativeStep = async (kind: 'undo' | 'redo') => {
    await job.actions[kind]();
    store.dispatch({
      type: 'FETCH_ANNOTATIONS_SUCCESS',
      payload: {
        states: await job.annotations.get(frame.value),
        history: await job.actions.get(),
      },
    });
  };
  const load = async () => {
    redux.states = await job.annotations.get(frame.value);
  };
  return {
    history,
    objects,
    job,
    store,
    dispatched,
    redux,
    frame,
    nativeStep,
    load,
    t1,
    t2,
    s3,
    root,
  };
}

function makeRunner(store: CvatStoreLike) {
  const toast = vi.fn();
  const afterWrite = vi.fn();
  return {
    runner: new MultiObjectRunner({ getStore: () => store, afterWrite, toast }),
    toast,
    afterWrite,
  };
}

describe('neighbor pinning for current-frame track writes', () => {
  it('pins only interpolated, non-outside neighbors', () => {
    const w = createWorld();
    const state = w.t1.snapshot(5) as unknown as CvatObjectStateLike;
    expect(collectNeighborPins(state, 5).map((p) => p.frame)).toEqual([4, 6]);
    const keyed = w.t2.snapshot(5) as unknown as CvatObjectStateLike;
    expect(collectNeighborPins(keyed, 5)).toEqual([]);
  });
  it('does not read frames before 0 or after the last frame', () => {
    const w = createWorld();
    const state = w.t1.snapshot(0) as unknown as CvatObjectStateLike;
    const spy = vi.spyOn(state.__internal!, 'save' as never);
    expect(collectNeighborPins(state, 0, 0)).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('one-step undo for multi-object actions (saveStates transaction)', () => {
  it('swaps two objects and undoes / redoes everything with a single history step', async () => {
    const w = createWorld();
    await w.load();
    const { runner, toast } = makeRunner(w.store);
    const beforeT1 = w.t1.snapshot(5).points.slice(0, 9);
    const beforeT2 = w.t2.snapshot(5).points.slice(0, 9);
    expect(await runner.run('swap-attributes', [2], 1)).toBe(true);
    expect(toast).toHaveBeenLastCalledWith(expect.stringContaining('Đã tráo'), 'success');

    // after: positions swapped, attributes swapped
    expect(w.t1.snapshot(5).points.slice(0, 9)).toEqual(beforeT2);
    expect(w.t2.snapshot(5).points.slice(0, 9)).toEqual(beforeT1);
    expect(w.t1.snapshot(5).attributes).toMatchObject({ 10: 'a2', 11: 'b2' });
    expect(w.t1.shapes[5]).toBeDefined(); // frame 5 became a keyframe
    // ONE history entry on frame 5; the neighbor pins were recorded nowhere (history frozen)
    expect(w.history.undoStack).toHaveLength(1);
    expect(w.history.undoStack[0]!.frame).toBe(5);
    expect(w.history.frozen).toBe(false);
    // Redux got the full state list and the history that enables Undo/Redo
    const last = w.dispatched.at(-1)!;
    expect(last.type).toBe('FETCH_ANNOTATIONS_SUCCESS');
    expect((last.payload!.history as { undo: unknown[] }).undo).toHaveLength(1);
    expect((w.redux.states as unknown[]).length).toBe(3);

    // pins: frames 4 and 6 of track 1 are now keyframes on the exact old interpolated values
    expect(w.t1.shapes[4]!.points.slice(0, 9)).toEqual([4, 0, 0, 0, 0, 0, 4, 2, 2].map((v) => v));
    expect(w.t1.shapes[6]!.points.slice(0, 9)).toEqual([6, 0, 0, 0, 0, 0, 4, 2, 2]);

    await w.nativeStep('undo');
    expect(w.t1.snapshot(5).points.slice(0, 9)).toEqual(beforeT1);
    expect(w.t2.snapshot(5).points.slice(0, 9)).toEqual(beforeT2);
    expect(w.t1.snapshot(5).attributes).toMatchObject({ 10: 'a1', 11: 'b1' });
    expect(w.t2.snapshot(5).attributes).toMatchObject({ 10: 'a2', 11: 'b2' });
    expect(w.t1.shapes[5]).toBeUndefined(); // keyframe flag of frame f restored
    // geometry of the pinned neighbors is unchanged by the undo
    expect(w.t1.snapshot(4).points.slice(0, 3)).toEqual([4, 0, 0]);
    expect(w.t1.snapshot(6).points.slice(0, 3)).toEqual([6, 0, 0]);
    const afterUndo = w.redux.history as { undo: unknown[]; redo: unknown[] };
    expect(afterUndo.undo).toHaveLength(0);
    expect(afterUndo.redo).toHaveLength(1);

    await w.nativeStep('redo');
    expect(w.t1.snapshot(5).points.slice(0, 9)).toEqual(beforeT2);
    expect(w.t2.snapshot(5).points.slice(0, 9)).toEqual(beforeT1);
    expect(w.t1.shapes[5]).toBeDefined();
    const afterRedo = w.redux.history as { undo: unknown[]; redo: unknown[] };
    expect(afterRedo.undo).toHaveLength(1);
    expect(afterRedo.redo).toHaveLength(0);
  });

  it('a native edit after a Meow action undoes first, then the Meow action in one step', async () => {
    const w = createWorld();
    await w.load();
    const { runner } = makeRunner(w.store);
    const original = w.s3.snapshot(5).points.slice(0, 9);
    await runner.run('sync-size', [1, 3], 1);
    const synced = w.s3.snapshot(5).points.slice(0, 9);
    expect(synced.slice(6)).toEqual([4, 2, 2]);

    // native edit through ObjectState.save(), as cvat-ui's updateAnnotationsAsync does
    const state = w.s3.snapshot(5);
    state.points = [60, 60, 0, 0, 0, 0, 4, 2, 2, ...tail];
    await state.save();
    expect(w.history.undoStack).toHaveLength(2);

    await w.nativeStep('undo');
    expect(w.s3.snapshot(5).points.slice(0, 9)).toEqual(synced);
    await w.nativeStep('undo');
    expect(w.s3.snapshot(5).points.slice(0, 9)).toEqual(original);
    expect(w.history.undoStack).toHaveLength(0);
  });

  it('pin-bottom over several objects is one undo step as well', async () => {
    const w = createWorld();
    await w.load();
    const { runner } = makeRunner(w.store);
    await runner.run('pin-bottom', [1, 2, 3], 1);
    expect(w.history.undoStack).toHaveLength(1);
    expect(w.s3.snapshot(5).points[2]).toBeCloseTo(0);
    expect(w.t2.snapshot(5).points[2]).toBeCloseTo(-0.4);
    await w.nativeStep('undo');
    expect(w.s3.snapshot(5).points[2]).toBe(5);
    expect(w.t2.snapshot(5).points[2]).toBe(0);
  });

  it('hide / show are a single step too and refuse locked objects', async () => {
    const w = createWorld();
    await w.load();
    w.s3.lock = true;
    await w.load();
    const { runner, toast } = makeRunner(w.store);
    await runner.run('hide', [1, 2, 3], 1);
    expect(w.t1.hidden && w.t2.hidden).toBe(true);
    expect(w.s3.hidden).toBe(false);
    expect(toast).toHaveBeenLastCalledWith(expect.stringContaining('1 object bị khóa'), 'success');
    expect(w.history.undoStack).toHaveLength(1);
    await w.nativeStep('undo');
    expect(w.t1.hidden || w.t2.hidden).toBe(false);
  });
});

describe('safety rules', () => {
  it('refuses a swap with a locked member without touching either object', async () => {
    const w = createWorld();
    w.s3.lock = true;
    await w.load();
    const { runner, toast } = makeRunner(w.store);
    const before = w.t1.snapshot(5).points.slice();
    expect(await runner.run('swap-geometry', [3], 1)).toBe(false);
    expect(toast).toHaveBeenLastCalledWith(expect.stringContaining('Đã hủy'), 'error');
    expect(w.t1.snapshot(5).points).toEqual(before);
    expect(w.history.undoStack).toHaveLength(0);
    expect(w.job.annotations.saveStates).not.toHaveBeenCalled();
  });

  it('aborts when the frame changes while the unfiltered states are being read', async () => {
    const w = createWorld();
    // Redux only knows track 1; object 3 must be read through job.annotations.get (async)
    w.redux.states = [w.t1.snapshot(5)];
    const get = w.job.annotations.get;
    w.job.annotations.get = vi.fn(async (f: number) => {
      const result = await get(f);
      w.frame.value = 6; // user stepped the frame during the await
      return result;
    });
    const { runner, toast } = makeRunner(w.store);
    expect(await runner.run('sync-size', [3], 1)).toBe(false);
    expect(toast).toHaveBeenLastCalledWith(expect.stringContaining('đổi frame'), 'error');
    expect(w.history.undoStack).toHaveLength(0);
    expect(w.dispatched.filter((a) => a.type.endsWith('_SUCCESS'))).toHaveLength(0);
  });

  it('does not replace Redux states when the frame changed during the Redux refresh', async () => {
    const w = createWorld();
    await w.load();
    const { runner } = makeRunner(w.store);
    const history = w.job.actions.get;
    w.job.actions.get = vi.fn(async () => {
      w.frame.value = 6;
      return history();
    });
    await runner.run('pin-bottom', [3], 1);
    expect(w.dispatched).toHaveLength(0);
  });

  it('rolls back everything if the transaction fails (no partial write, no history)', async () => {
    const w = createWorld();
    await w.load();
    const { runner } = makeRunner(w.store);
    const before = w.t2.snapshot(5).points.slice();
    const original = w.s3.save.bind(w.s3);
    w.s3.save = (f, d) => {
      if (d.updateFlags.points) throw new Error('boom');
      return original(f, d);
    };
    const ok = await runner.run('swap-geometry', [3], 1);
    expect(ok).toBe(false);
    expect(w.t2.snapshot(5).points).toEqual(before);
    expect(w.t1.snapshot(5).points.slice(0, 9)).toEqual([5, 0, 0, 0, 0, 0, 4, 2, 2]);
    expect(w.history.undoStack).toHaveLength(0);
  });

  it('refuses to edit in the Review workspace', async () => {
    const w = createWorld();
    await w.load();
    const { runner, toast } = makeRunner(w.store);
    w.root.annotation.workspace = 'Review';
    expect(await runner.run('hide', [1], 1)).toBe(false);
    expect(toast).toHaveBeenLastCalledWith(expect.stringContaining('Review'), 'error');
  });
});

describe('older CVAT without job.annotations.saveStates', () => {
  it('falls back to per-object saves and tells how many Ctrl+Z presses are needed', async () => {
    const w = createWorld({ saveStates: false });
    await w.load();
    const { runner, toast } = makeRunner(w.store);
    expect(await runner.run('swap-geometry', [2], 1)).toBe(true);
    expect(w.history.undoStack.length).toBeGreaterThan(1);
    expect(toast).toHaveBeenLastCalledWith(expect.stringContaining('không gộp undo'), 'success');
    expect(w.dispatched.at(-1)!.type).toBe('FETCH_ANNOTATIONS_SUCCESS');
  });

  it('a strict swap that fails halfway is rolled back', async () => {
    const w = createWorld({ saveStates: false });
    await w.load();
    const { runner } = makeRunner(w.store);
    const original = w.s3.save.bind(w.s3);
    w.s3.save = (f, d) => {
      if (d.updateFlags.points) throw new Error('boom');
      return original(f, d);
    };
    const before1 = w.t1.snapshot(5).points.slice(0, 9);
    const before3 = w.s3.snapshot(5).points.slice(0, 9);
    await runner.run('swap-geometry', [3], 1);
    expect(w.t1.snapshot(5).points.slice(0, 9)).toEqual(before1);
    expect(w.s3.snapshot(5).points.slice(0, 9)).toEqual(before3);
  });
});

describe('filters', () => {
  it('adds to / replaces the CVAT filter, keeps history and restores it', async () => {
    const w = createWorld();
    await w.load();
    const base = { '==': [{ var: 'label' }, 'car'] };
    w.redux.filters = [base];
    const { runner } = makeRunner(w.store);
    await runner.run('filter-add', [4, 5], 1);
    expect(w.dispatched[0]).toEqual({
      type: 'CHANGE_ANNOTATIONS_FILTERS',
      payload: { filters: [{ or: [base, objectIdLogic([4, 5])] }] },
    });
    expect(w.dispatched[1]!.type).toBe('FETCH_ANNOTATIONS_SUCCESS');
    await runner.run('filter-only', [9], 1);
    expect(w.dispatched[2]!.payload).toEqual({ filters: [objectIdLogic([9])] });
    await runner.run('filter-restore', [9], 1);
    expect(w.dispatched[4]!.payload).toEqual({
      filters: [{ or: [base, objectIdLogic([4, 5])] }],
    });
    expect(runner.filterHistory.size).toBe(1);
  });

  it('refuses to change filters while ground truth is shown (a fetch would drop its states)', async () => {
    const w = createWorld();
    await w.load();
    w.root.annotation.job.groundTruthInfo = { groundTruthInstance: {} };
    w.root.settings.shapes.showGroundTruth = true;
    const { runner, toast } = makeRunner(w.store);
    expect(await runner.run('filter-only', [1], 1)).toBe(false);
    expect(w.dispatched).toHaveLength(0);
    expect(runner.filterHistory.size).toBe(0);
    expect(toast).toHaveBeenLastCalledWith(expect.stringContaining('Ground truth'), 'error');
  });
});
