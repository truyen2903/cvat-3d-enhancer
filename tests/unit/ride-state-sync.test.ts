import { describe, expect, it, vi } from 'vitest';
import type { CvatObjectStateLike } from '../../src/integration/cvat/runtime/pre-render-enhancer';
import { syncTrackRideState } from '../../src/integration/cvat/runtime/ride-state-sync';

function track(target = 'true') {
  const snapshots = [0, 5, 10].map((frame) => {
    const state: CvatObjectStateLike = {
      clientID: 1,
      frame,
      points: [frame, 2, 3, 0, 0, 0, 4, 2, 1],
      attributes: { 6260: 'false', 6261: frame === 5 ? 'bicycle' : 'motorcycle' },
      outside: frame === 10,
      occluded: frame === 5,
      updateFlags: { reset: vi.fn() },
      save: vi.fn(async () => state),
    };
    return state;
  });
  const current: CvatObjectStateLike = {
    clientID: 1,
    frame: 3,
    shapeType: 'cuboid',
    objectType: 'track',
    label: { attributes: [{ id: 6260, name: 'ride_state', mutable: true }] },
    attributes: { 6260: target, 6261: 'motorcycle' },
    updateFlags: { reset: vi.fn() },
    __internal: {
      export: () => ({ shapes: snapshots.map((state) => ({ frame: state.frame! })) }),
      save: vi.fn((frame) => snapshots.find((state) => state.frame === frame)!),
    },
  };
  return { current, snapshots };
}

describe('ride_state across a track', () => {
  it('sets only ride_state at every keyframe, including outside states and earlier frames', async () => {
    const { current, snapshots } = track();
    const before = snapshots.map((state) => ({
      points: [...state.points!],
      outside: state.outside,
      occluded: state.occluded,
      type: state.attributes![6261],
    }));
    const result = await syncTrackRideState(1, current);
    expect(result).toEqual({
      clientID: 1,
      targetValue: 'true',
      updatedKeyframes: 3,
      totalKeyframes: 3,
    });
    snapshots.forEach((state, index) => {
      expect(state.attributes).toEqual({ 6260: 'true', 6261: before[index]!.type });
      expect(state.points).toEqual(before[index]!.points);
      expect(state.outside).toBe(before[index]!.outside);
      expect(state.occluded).toBe(before[index]!.occluded);
      expect(state.updateFlags!.points).toBeUndefined();
      expect(state.updateFlags!.attributes).toBe(true);
      expect(state.save).toHaveBeenCalledOnce();
    });
    expect(current.attributes![6260]).toBe('true');
  });

  it('propagates unchecked values and does not save already matching keyframes', async () => {
    const { current, snapshots } = track('false');
    snapshots[1]!.attributes![6260] = 'true';
    expect((await syncTrackRideState(1, current)).updatedKeyframes).toBe(1);
    expect(snapshots[0]!.save).not.toHaveBeenCalled();
    expect(snapshots[1]!.save).toHaveBeenCalledOnce();
    expect(snapshots[2]!.save).not.toHaveBeenCalled();
    expect((await syncTrackRideState(1, current)).updatedKeyframes).toBe(0);
  });

  it.each(['locked', 'missing attribute', 'wrong track', 'invalid value', 'unsupported save'])(
    'refuses %s before changing any attributes',
    async (reason) => {
      const { current, snapshots } = track();
      if (reason === 'locked') current.lock = true;
      if (reason === 'missing attribute') current.label = { attributes: [] };
      if (reason === 'wrong track') current.clientID = 2;
      if (reason === 'invalid value') current.attributes![6260] = 'unknown';
      if (reason === 'unsupported save') snapshots[2]!.save = undefined;
      await expect(syncTrackRideState(1, current)).rejects.toThrow();
      for (const state of snapshots) {
        expect(state.attributes![6260]).toBe('false');
        if (state.save) expect(state.save).not.toHaveBeenCalled();
      }
    }
  );
});
