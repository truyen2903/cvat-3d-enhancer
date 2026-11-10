import { describe, expect, it, vi } from 'vitest';
import {
  ActiveObjectCameraFollower,
  attachActiveObjectCameraFollow,
  type FollowViewLike,
  translatePerspectiveCamera,
} from '../../src/integration/cvat/runtime/camera-follow';

function makeView(points: number[], frame: number) {
  const position = { x: 10, y: 10, z: 10, clone: () => ({ x: 0, y: 0, z: 0 }) };
  const target = { x: 1, y: 2, z: 3 };
  const setLookAt = vi.fn(
    (px: number, py: number, pz: number, tx: number, ty: number, tz: number) => {
      Object.assign(position, { x: px, y: py, z: pz });
      Object.assign(target, { x: tx, y: ty, z: tz });
    }
  );
  const view: FollowViewLike = {
    views: {
      perspective: {
        camera: { position },
        controls: {
          getTarget: (out) => Object.assign(out, target),
          getPosition: (out) => Object.assign(out, { x: position.x, y: position.y, z: position.z }),
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
  it('waits for the current frame data and follows exactly once when objects arrive late', () => {
    const { view, setLookAt } = makeView([0, 0, 0], 10);
    view.drawnObjects = { 5: { data: { points: [0, 0, 0], frame: 10 } } };
    const model = { data: { imageID: 10 } };
    const follower = new ActiveObjectCameraFollower(
      () => '5',
      () => true
    );
    follower.tick(view, model);
    model.data.imageID = 11;
    follower.tick(view, model);
    expect(setLookAt).not.toHaveBeenCalled();
    view.drawnObjects[5] = { data: { points: [4, 2, 0], frame: 11 } };
    follower.tick(view, model);
    follower.tick(view, model);
    expect(setLookAt).toHaveBeenCalledOnce();
    expect(setLookAt).toHaveBeenLastCalledWith(14, 12, 10, 5, 4, 3, false);
    model.data.imageID = 13;
    view.drawnObjects[5] = { data: { points: [7, 3, 0], frame: 12 } };
    follower.tick(view, model);
    expect(setLookAt).toHaveBeenCalledOnce();
    view.drawnObjects[5] = { data: { points: [10, 3, 0], frame: 13 } };
    follower.tick(view, model);
    expect(setLookAt).toHaveBeenLastCalledWith(20, 13, 10, 11, 5, 3, false);
  });

  it('uses matching native data when an adapter retains a stale state snapshot', () => {
    const { view, setLookAt } = makeView([0, 0, 0], 10);
    const model = { data: { imageID: 10 } };
    const follower = new ActiveObjectCameraFollower(
      () => '5',
      () => true
    );
    follower.tick(view, model);
    model.data.imageID = 11;
    view.drawnObjects![5] = {
      state: { frame: 10, points: [0, 0, 0] },
      data: { frame: 11, points: [3, 0, 0] },
    };
    follower.tick(view, model);
    expect(setLookAt).toHaveBeenLastCalledWith(13, 10, 10, 4, 2, 3, false);
  });

  it('resets the old object anchor even if the newly selected object is not drawn yet', () => {
    let active = '5';
    const { view, setLookAt } = makeView([0, 0, 0], 10);
    const follower = new ActiveObjectCameraFollower(
      () => active,
      () => true
    );
    follower.tick(view);
    active = '6';
    follower.tick(view);
    active = '5';
    view.drawnObjects![5] = { state: { frame: 12, points: [20, 0, 0] } };
    follower.tick(view);
    expect(setLookAt).not.toHaveBeenCalled();
  });

  it('retries an unapplied frame delta instead of moving only the camera while controls initialize', () => {
    const { view, setLookAt } = makeView([0, 0, 0], 10);
    const controls = view.views!.perspective!.controls!;
    const follower = new ActiveObjectCameraFollower(
      () => '5',
      () => true
    );
    follower.tick(view);
    view.views!.perspective!.controls = {};
    view.drawnObjects![5] = { state: { frame: 11, points: [3, 0, 0] } };
    follower.tick(view);
    expect(view.views!.perspective!.camera!.position!.x).toBe(10);
    view.views!.perspective!.controls = controls;
    follower.tick(view);
    expect(setLookAt).toHaveBeenCalledOnce();
  });

  it('translates from the current camera pose rather than a pending focus animation endpoint', () => {
    const { view, setLookAt } = makeView([0, 0, 0], 10);
    const controls = view.views!.perspective!.controls!;
    const getPosition = vi.fn((out, end) =>
      Object.assign(out, end ? { x: 100, y: 100, z: 100 } : { x: 10, y: 10, z: 10 })
    );
    const getTarget = vi.fn((out, end) =>
      Object.assign(out, end ? { x: 90, y: 90, z: 90 } : { x: 1, y: 2, z: 3 })
    );
    controls.getPosition = getPosition;
    controls.getTarget = getTarget;
    expect(translatePerspectiveCamera(view, 2, 0, 0)).toBe(true);
    expect(getPosition.mock.calls[0]![1]).toBe(false);
    expect(getTarget.mock.calls[0]![1]).toBe(false);
    expect(setLookAt).toHaveBeenCalledWith(12, 10, 10, 3, 2, 3, false);
  });

  it('does not let a detached view consume the camera anchor for the current job', () => {
    const { view, setLookAt } = makeView([0, 0, 0], 10);
    let current = true;
    const follower = new ActiveObjectCameraFollower(
      () => '5',
      () => true
    );
    attachActiveObjectCameraFollow(
      view,
      follower,
      () => null,
      () => current
    );
    view.render!();
    current = false;
    view.drawnObjects![5] = { state: { frame: 20, points: [100, 0, 0] } };
    view.render!();
    expect(setLookAt).not.toHaveBeenCalled();
    current = true;
    view.drawnObjects![5] = { state: { frame: 11, points: [3, 0, 0] } };
    view.render!();
    expect(setLookAt).toHaveBeenCalledWith(13, 10, 10, 4, 2, 3, false);
  });
});
