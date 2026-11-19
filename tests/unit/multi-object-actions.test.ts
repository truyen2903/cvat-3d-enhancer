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
  writeStatesAtFrame,
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

function trackState(
  frame: number,
  table: Record<number, { keyframe: boolean; outside?: boolean }>,
  order: string[]
): CvatObjectStateLike {
  const make = (f: number): CvatObjectStateLike => {
    const info = table[f] ?? { keyframe: true };
    const snap: CvatObjectStateLike = {
      clientID: 1,
      frame: f,
      objectType: 'track',
      shapeType: 'cuboid',
      keyframe: info.keyframe,
      outside: info.outside ?? false,
      points: [f, 0, 0, 0, 0, 0, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0],
      updateFlags: { reset: vi.fn() },
    };
    snap.save = vi.fn(async () => {
      order.push(`save@${snap.frame}:${snap.keyframe ? 'kf' : ''}`);
      return snap;
    });
    return snap;
  };
  const state = make(frame);
  state.attributes = { 10: 'a' };
  state.label = LABEL;
  state.save = vi.fn(async () => {
    order.push(`save@${frame}:main`);
    return state;
  });
  state.__internal = { save: vi.fn((f: number) => make(f)) };
  return state;
}

describe('neighbor pinning for current-frame track writes', () => {
  it('pins only interpolated, non-outside neighbors', () => {
    const order: string[] = [];
    const state = trackState(
      5,
      {
        4: { keyframe: true },
        5: { keyframe: false },
        6: { keyframe: false },
      },
      order
    );
    expect(collectNeighborPins(state, 5).map((p) => p.frame)).toEqual([6]);
    const outside = trackState(
      5,
      { 4: { keyframe: false }, 6: { keyframe: false, outside: true } },
      order
    );
    expect(collectNeighborPins(outside, 5).map((p) => p.frame)).toEqual([4]);
  });
  it('does not read frames before 0 or after the last frame', () => {
    const order: string[] = [];
    const state = trackState(0, { 1: { keyframe: false } }, order);
    expect(collectNeighborPins(state, 0, 0)).toEqual([]);
    expect(state.__internal!.save).not.toHaveBeenCalled();
  });
  it('turns both neighbors into keyframes before saving frame f, via ObjectState.save', async () => {
    const order: string[] = [];
    const state = trackState(
      5,
      { 4: { keyframe: false }, 5: { keyframe: false }, 6: { keyframe: false } },
      order
    );
    const summary = await writeStatesAtFrame([{ state, points: [9, 9, 9, 0, 0, 0, 2, 2, 2] }], 5);
    expect(order).toEqual(['save@4:kf', 'save@6:kf', 'save@5:main']);
    expect(summary).toMatchObject({ written: 1, pinnedNeighbors: 2, failed: 0 });
    expect(state.points!.slice(0, 9)).toEqual([9, 9, 9, 0, 0, 0, 2, 2, 2]);
    expect(state.points).toHaveLength(16);
  });
  it('needs no pinning for plain shapes and skips locked or outside objects', async () => {
    const a = shape(1, P_A);
    const locked = shape(2, P_B, { lock: true });
    const gone = shape(3, P_B, { outside: true });
    const summary = await writeStatesAtFrame(
      [
        { state: a, points: P_B },
        { state: locked, points: P_A },
        { state: gone, points: P_A },
      ],
      5
    );
    expect(summary).toMatchObject({
      written: 1,
      pinnedNeighbors: 0,
      skippedLocked: 1,
      skippedOutside: 1,
    });
    expect(locked.save).not.toHaveBeenCalled();
  });
});

function fakeStore(states: CvatObjectStateLike[], filters: unknown[] = []) {
  const actions: { type: string; payload?: Record<string, unknown> }[] = [];
  const get = vi.fn(async () => states);
  const job = {
    stopFrame: 100,
    annotations: { get },
    actions: { get: vi.fn(async () => ({ undo: [1] })) },
  };
  const store: CvatStoreLike = {
    getState: () => ({
      annotation: {
        job: { instance: job },
        player: { frame: { number: 5 } },
        annotations: { states, filters, activatedStateID: 1 },
      },
      settings: { workspace: { showAllInterpolationTracks: false } },
    }),
    dispatch: (action) => {
      actions.push(action);
      if (action.type === 'CHANGE_ANNOTATIONS_FILTERS')
        filters = [...(action.payload!.filters as [])];
    },
  };
  return { store, actions, get };
}

describe('MultiObjectRunner', () => {
  it('swaps geometry through ObjectState.save and refreshes Redux states + undo history once', async () => {
    const a = shape(1, P_A);
    const b = shape(2, P_B);
    const { store, actions } = fakeStore([a, b]);
    const afterWrite = vi.fn();
    const toast = vi.fn();
    const runner = new MultiObjectRunner({ getStore: () => store, afterWrite, toast });
    expect(await runner.run('swap-geometry', [2], 1)).toBe(true);
    expect(a.points!.slice(0, 9)).toEqual(P_B);
    expect(b.points!.slice(0, 9)).toEqual(P_A);
    expect(a.save).toHaveBeenCalledTimes(1);
    expect(actions.map((x) => x.type)).toEqual(['UPDATE_ANNOTATIONS_SUCCESS']);
    expect(actions[0]!.payload!.history).toEqual({ undo: [1] });
    expect(afterWrite).toHaveBeenCalledTimes(1);
    expect(toast).toHaveBeenLastCalledWith(expect.stringContaining('Đã tráo'), 'success');
  });
  it('reports the label mismatch for attribute swap', async () => {
    const a = shape(1, P_A);
    const b = shape(2, P_B, { label: { ...LABEL, id: 2, name: 'bus' } });
    const { store } = fakeStore([a, b]);
    const toast = vi.fn();
    const runner = new MultiObjectRunner({ getStore: () => store, afterWrite: vi.fn(), toast });
    await runner.run('swap-attributes', [2], 1);
    expect(toast).toHaveBeenLastCalledWith(expect.stringContaining('khác label'), 'success');
    expect(a.attributes![10]).toBe('a');
  });
  it('adds to / replaces the CVAT filter, keeps history and restores it', async () => {
    const a = shape(1, P_A);
    const base = { '==': [{ var: 'label' }, 'car'] };
    const { store, actions } = fakeStore([a], [base]);
    const runner = new MultiObjectRunner({
      getStore: () => store,
      afterWrite: vi.fn(),
      toast: vi.fn(),
    });
    await runner.run('filter-add', [4, 5], 1);
    expect(actions[0]).toEqual({
      type: 'CHANGE_ANNOTATIONS_FILTERS',
      payload: { filters: [{ or: [base, objectIdLogic([4, 5])] }] },
    });
    expect(actions[1]!.type).toBe('FETCH_ANNOTATIONS_SUCCESS');
    await runner.run('filter-only', [9], 1);
    expect(actions[2]!.payload).toEqual({ filters: [objectIdLogic([9])] });
    await runner.run('filter-restore', [9], 1);
    expect(actions[4]!.payload).toEqual({ filters: [{ or: [base, objectIdLogic([4, 5])] }] });
    expect(runner.filterHistory.size).toBe(1);
  });
  it('hides objects with the hidden flag, including filtered-out ones from the unfiltered source', async () => {
    const a = shape(1, P_A);
    const b = shape(2, P_B);
    const { store } = fakeStore([a]);
    const unfiltered = vi.fn(async () => [a, b]);
    const state = store.getState() as {
      annotation: { job: { instance: { annotations: { get: unknown } } } };
    };
    state.annotation.job.instance.annotations.get = unfiltered;
    const runner = new MultiObjectRunner({
      getStore: () => store,
      afterWrite: vi.fn(),
      toast: vi.fn(),
    });
    await runner.run('hide', [1, 2], 1);
    expect(a.hidden).toBe(true);
    expect(b.hidden).toBe(true);
    expect(a.updateFlags!.hidden).toBe(true);
  });
  it('pins bottoms and syncs size using the active object as source', async () => {
    const source = shape(1, [0, 0, 10, 0, 0, 0, 4, 2, 2]);
    const other = shape(2, [5, 5, 0, 0, 0, 0, 1, 1, 1]);
    const { store } = fakeStore([source, other]);
    const runner = new MultiObjectRunner({
      getStore: () => store,
      afterWrite: vi.fn(),
      toast: vi.fn(),
    });
    await runner.run('pin-bottom', [1, 2], 1);
    expect(other.points![2]).toBe(9.5);
    await runner.run('sync-size', [1, 2], 1);
    expect(other.points!.slice(6, 9)).toEqual([4, 2, 2]);
    expect(other.points![2]! - other.points![8]! / 2).toBeCloseTo(9);
  });
  it('refuses cluster alignment without a source', async () => {
    const { store } = fakeStore([shape(2, P_B)]);
    const toast = vi.fn();
    const runner = new MultiObjectRunner({ getStore: () => store, afterWrite: vi.fn(), toast });
    expect(await runner.run('pin-bottom', [2], null)).toBe(false);
    expect(toast).toHaveBeenCalledWith(expect.stringContaining('gốc'), 'error');
  });
});
