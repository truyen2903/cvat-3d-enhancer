import { describe, expect, it, vi } from 'vitest';
import type { CvatObjectStateLike } from '../../src/integration/cvat/runtime/pre-render-enhancer';
import { syncTrackCuboidDimension } from '../../src/integration/cvat/runtime/pre-render-enhancer';
import {
  reorientCuboid,
  interpolateTrackYaw,
  reorientTrack,
} from '../../src/integration/cvat/runtime/track-editing';
import { syncTrackMutableAttribute } from '../../src/integration/cvat/runtime/ride-state-sync';

function track() {
  const states = Array.from({ length: 5 }, (_, frame): CvatObjectStateLike => ({
    clientID: 1,
    frame,
    objectType: 'track',
    shapeType: 'cuboid',
    points: [
      frame,
      frame + 2,
      frame + 3,
      0,
      0,
      ((frame === 4 ? -170 : 170) * Math.PI) / 180,
      4,
      2,
      frame + 1,
    ],
    attributes: { 1: frame === 2 ? 'yes' : 'no', 2: String(frame) },
    updateFlags: {
      reset() {
        this.points = false;
        this.attributes = false;
      },
    },
  }));
  const current = states[2]!;
  current.label = {
    attributes: [
      { id: 1, name: 'sitting', mutable: true },
      { id: 2, name: 'other', mutable: false },
    ],
  };
  const save = vi.fn((frame: number, state: CvatObjectStateLike) => {
    if (state.updateFlags?.points) states[frame]!.points = [...state.points!];
    return states[frame]!;
  });
  for (const state of states) state.save = vi.fn(() => state);
  current.__internal = {
    export: () => ({
      shapes: [states[0]!, states[4]!].map((s) => ({ frame: s.frame!, points: [...s.points!] })),
    }),
    save,
  };
  return { states, current, save };
}

describe('track editing', () => {
  it('syncs H while preserving each bottom face', async () => {
    const { states, current } = track();
    states[0]!.attributes = { ...current.attributes };
    states[4]!.attributes = { ...current.attributes };
    const bottoms = states.map((s) => s.points![2]! - s.points![8]! / 2);
    await syncTrackCuboidDimension(1, 'H', { stateOnCurrentFrame: current });
    for (const frame of [0, 2, 4]) {
      expect(states[frame]!.points![8]).toBe(3);
      expect(states[frame]!.points![2]! - states[frame]!.points![8]! / 2).toBe(bottoms[frame]);
    }
  });
  it('flips all keyframes without touching other coordinates or interpolated frames', async () => {
    const { states, current } = track();
    const before = states.map((s) => [...s.points!]);
    expect(await reorientTrack(1, current, 'flip', true)).toBe(2);
    for (const f of [0, 4]) {
      expect(states[f]!.points!.filter((_, i) => i !== 5)).toEqual(
        before[f]!.filter((_, i) => i !== 5)
      );
      expect(states[f]!.points![5]).toBeCloseTo(((f === 0 ? 350 : 10) * Math.PI) / 180);
    }
    expect(states[1]!.points).toEqual(before[1]);
  });
  it('swaps L/W and rotates by 90°, wrapping yaw to [0, 2π)', () => {
    const points = [1, 2, 3, 0, 0, (7 * Math.PI) / 4, 4, 2, 1];
    const next = reorientCuboid(points, 'swap');
    expect(next).toEqual([1, 2, 3, 0, 0, Math.PI / 4, 2, 4, 1]);
    expect(points[6]).toBe(4);
  });
  it('interpolates shortest yaw across ±π, keeping position, tilt and size', async () => {
    const { states, current } = track();
    const before = states.map((s) => [...s.points!]);
    expect(await interpolateTrackYaw(1, current)).toBe(3);
    for (const f of [1, 2, 3]) {
      expect(states[f]!.points![5]).toBeCloseTo(((170 + 5 * f) * Math.PI) / 180);
      expect(states[f]!.points!.filter((_, i) => i !== 5)).toEqual(
        before[f]!.filter((_, i) => i !== 5)
      );
    }
  });
  it('applies only a selected mutable attribute including outside keyframes', async () => {
    const { states, current } = track();
    states[4]!.outside = true;
    const before = states.map((s) => [...s.points!]);
    expect((await syncTrackMutableAttribute(1, current, 1)).updatedKeyframes).toBe(2);
    for (const f of [0, 4]) {
      expect(states[f]!.attributes).toEqual({ 1: 'yes', 2: String(f) });
      expect(states[f]!.points).toEqual(before[f]);
    }
    expect(states[4]!.outside).toBe(true);
    await expect(syncTrackMutableAttribute(1, current, 2)).rejects.toThrow();
  });
  it('accepts explicit keyframe boundaries and rejects invalid endpoints', async () => {
    const { states, current } = track();
    current.__internal!.export = () => ({ shapes: [0, 2, 4].map((frame) => ({ frame })) });
    const before = [...states[3]!.points!];
    expect(await interpolateTrackYaw(1, current, [0, 2])).toBe(1);
    expect(states[3]!.points).toEqual(before);
    await expect(interpolateTrackYaw(1, current, [1, 4])).rejects.toThrow();
  });
  it('refreshes bulk edits once without emitting a second canvas geometry save', async () => {
    const { current } = track();
    const canvas = document.createElement('canvas') as HTMLCanvasElement & {
      updatePosition: () => void;
    };
    canvas.updatePosition = vi.fn();
    const event = vi.fn();
    canvas.addEventListener('canvas.edited', event);
    const onAfterSync = vi.fn();
    await syncTrackCuboidDimension(1, 'FLIP_180', {
      wholeTrack: true,
      stateOnCurrentFrame: current,
      perspectiveCanvas: canvas,
      onAfterSync,
    });
    expect(canvas.updatePosition).not.toHaveBeenCalled();
    expect(event).not.toHaveBeenCalled();
    expect(onAfterSync).toHaveBeenCalledOnce();
  });
  it('refuses locked tracks and unsafe ranges before writing', async () => {
    const { states, current, save } = track();
    current.lock = true;
    await expect(reorientTrack(1, current, 'flip', true)).rejects.toThrow();
    await expect(syncTrackMutableAttribute(1, current, 1)).rejects.toThrow();
    current.lock = false;
    states[3]!.outside = true;
    await expect(interpolateTrackYaw(1, current)).rejects.toThrow();
    expect(save.mock.calls.every(([, s]) => !s.updateFlags?.points)).toBe(true);
  });
});
