import { describe, expect, it, vi } from 'vitest';
import {
  ActiveObjectCameraFollower,
  attachActiveObjectCameraFollow,
  type FollowViewLike,
} from '../../src/integration/cvat/runtime/camera-follow';

function makeView(points: number[], frame: number) {
  const setLookAt = vi.fn();
  const position = { x: 10, y: 10, z: 10, clone: () => ({ x: 0, y: 0, z: 0 }) };
  const view: FollowViewLike = {
    views: {
      perspective: {
        camera: { position },
        controls: {
          getTarget: (out) => Object.assign(out, { x: 1, y: 2, z: 3 }),
          getPosition: (out) => Object.assign(out, { x: 10, y: 10, z: 10 }),
          setLookAt,
        },
      },
    },
    drawnObjects: { 5: { state: { points, frame } } },
    render: vi.fn(),
  };
  return { view, setLookAt };
}

describe('Active object camera follow', () => {
  it('translates camera by the active box delta on frame change only', () => {
    let active: string | null = '5';
    let enabled = true;
    const follower = new ActiveObjectCameraFollower(
      () => active,
      () => enabled
    );
    const { view, setLookAt } = makeView([0, 0, 0, 0, 0, 0, 4, 2, 1.5], 10);
    expect(attachActiveObjectCameraFollow(view, follower, () => null)).toBe(true);

    view.render!(); // first sight -> only tracks
    expect(setLookAt).not.toHaveBeenCalled();

    // Same-frame drag: no camera move
    view.drawnObjects![5] = { state: { points: [1, 0, 0], frame: 10 } };
    view.render!();
    expect(setLookAt).not.toHaveBeenCalled();

    // Next frame: box moved from (1,0,0) to (4,2,0) -> camera shifts by (3,2,0)
    view.drawnObjects![5] = { state: { points: [4, 2, 0], frame: 11 } };
    view.render!();
    expect(setLookAt).toHaveBeenCalledWith(13, 12, 10, 4, 4, 3, false);

    // Disabled -> no movement
    enabled = false;
    view.drawnObjects![5] = { state: { points: [9, 9, 9], frame: 12 } };
    view.render!();
    expect(setLookAt).toHaveBeenCalledTimes(1);

    // Deactivated -> no movement
    enabled = true;
    active = null;
    view.drawnObjects![5] = { state: { points: [20, 20, 20], frame: 13 } };
    view.render!();
    expect(setLookAt).toHaveBeenCalledTimes(1);
  });
});
