import { describe, expect, it } from 'vitest';
import { accelerateIncrementalObjects } from '../../src/integration/cvat/runtime/incremental-objects';

type State = { clientID: number; updated?: number };
function fixture(drawnObjects: Record<number, { data: State }>) {
  const calls: unknown[] = [];
  const view = {
    drawnObjects,
    deactivateObject() {
      calls.push('deactivate');
    },
    createObjects(states: State[]) {
      calls.push(['create', states]);
    },
    updateObjects(states: State[]) {
      calls.push(['update', states]);
    },
    deleteObjects(ids: number[]) {
      calls.push(['delete', ids]);
    },
    activateObject() {
      calls.push('activate');
    },
    setupObjectsIncremental(states: State[]) {
      const created = states.filter((state) => !(state.clientID in this.drawnObjects));
      const updated = states.filter(
        (state) =>
          state.clientID in this.drawnObjects &&
          this.drawnObjects[state.clientID]!.data.updated !== state.updated
      );
      const deleted = Object.keys(this.drawnObjects)
        .map((key) => +key)
        .filter((clientID) => states.findIndex((state) => state.clientID === clientID) === -1);
      this.deactivateObject();
      this.createObjects(created);
      this.updateObjects(updated);
      this.deleteObjects(deleted);
      this.activateObject();
    },
  };
  return { view, calls };
}

describe('incremental object runtime patch', () => {
  it('matches native created/updated/deleted arrays and method order on randomized scenes', () => {
    let seed = 74;
    const random = () => (seed = (1664525 * seed + 1013904223) >>> 0) / 2 ** 32;
    for (let run = 0; run < 100; run++) {
      const drawn: Record<number, { data: State }> = {};
      const states: State[] = [];
      for (let id = 0; id < 100; id++) {
        if (random() > 0.2) drawn[id] = { data: { clientID: id, updated: id % 2 } };
        if (random() > 0.2) states.push({ clientID: id, updated: random() > 0.5 ? 0 : 1 });
      }
      const native = fixture(drawn);
      const patched = fixture(drawn);
      const cleanup = accelerateIncrementalObjects(patched.view);
      native.view.setupObjectsIncremental(states);
      patched.view.setupObjectsIncremental(states);
      expect(patched.calls).toEqual(native.calls);
      cleanup?.();
    }
  });

  it('does not call findIndex per drawn object and is idempotent', () => {
    const { view } = fixture({ 1: { data: { clientID: 1 } } });
    const cleanup = accelerateIncrementalObjects(view);
    const wrapped = view.setupObjectsIncremental;
    accelerateIncrementalObjects(view);
    expect(view.setupObjectsIncremental).toBe(wrapped);
    const states = [{ clientID: 1 }];
    states.findIndex = () => {
      throw new Error('quadratic search');
    };
    expect(() => view.setupObjectsIncremental(states)).not.toThrow();
    cleanup?.();
    expect(view.setupObjectsIncremental).not.toBe(wrapped);
  });
});

it('leaves incomplete and frozen runtimes native', () => {
  const { view } = fixture({});
  const native = view.setupObjectsIncremental;
  const incomplete = { ...view, updateObjects: undefined };
  expect(accelerateIncrementalObjects(incomplete)).toBeNull();
  expect(incomplete.setupObjectsIncremental).toBe(native);
  expect(accelerateIncrementalObjects(Object.freeze(view))).toBeNull();
  expect(view.setupObjectsIncremental).toBe(native);
});

it('preserves duplicate states, inherited keys, undefined stamps and NaN strict equality', () => {
  const drawn = { ...{ 1: { data: { clientID: 1 } } }, NaN: { data: { clientID: NaN } } };
  Object.setPrototypeOf(drawn, { 4: { data: { clientID: 4, updated: 0 } } });
  const states = [
    { clientID: 1 },
    { clientID: 1, updated: 0 },
    { clientID: 4, updated: 1 },
    { clientID: NaN },
  ];
  const native = fixture(drawn);
  const patched = fixture(drawn);
  accelerateIncrementalObjects(patched.view);
  native.view.setupObjectsIncremental(states);
  patched.view.setupObjectsIncremental(states);
  expect(patched.calls).toEqual(native.calls);
});
