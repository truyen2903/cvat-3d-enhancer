import { describe, expect, it, vi } from 'vitest';
import {
  type CameraFrame,
  eulerXYZToMatrix,
  hitTestCuboidEdge,
  matrixToEulerXYZ,
  nudgeCuboidPoints,
  OrthoCuboidEditor,
  readCameraFrame,
  resizeCuboidPointsByEdge,
  rotateCuboidPointsAroundViewAxis,
} from '../../src/integration/cvat/runtime/ortho-cuboid-editor';

/** Top-view camera: looking down -Z, screen right = +X, screen up = +Y. 10x10 m visible. */
const topCamera = {
  left: -5,
  right: 5,
  top: 5,
  bottom: -5,
  zoom: 1,
  isOrthographicCamera: true,
  matrixWorld: { elements: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 10, 1] },
};
const frame = readCameraFrame(topCamera) as CameraFrame;
// Box at origin: length 4 (x), width 2 (y), height 1 (z), no rotation
const box = [0, 0, 0, 0, 0, 0, 4, 2, 1, 0, 0, 0, 0, 0, 0, 0];

describe('Ortho cuboid editor math', () => {
  it('round-trips Euler XYZ <-> matrix', () => {
    const e = matrixToEulerXYZ(eulerXYZToMatrix(0.1, -0.2, 1.3));
    expect(e[0]).toBeCloseTo(0.1);
    expect(e[1]).toBeCloseTo(-0.2);
    expect(e[2]).toBeCloseTo(1.3);
  });

  it('nudges along screen axes and rotates CCW around view axis', () => {
    const moved = nudgeCuboidPoints(box, frame, -0.5, 0.25);
    expect(moved.slice(0, 3)).toEqual([-0.5, 0.25, 0]);
    expect(moved.slice(6)).toEqual(box.slice(6));

    const rotated = rotateCuboidPointsAroundViewAxis(box, frame, 0.1);
    expect(rotated[5]).toBeCloseTo(0.1); // +yaw = CCW seen from above
    expect(rotated[3]).toBeCloseTo(0);
    expect(rotated[4]).toBeCloseTo(0);
  });

  it('hits edges but leaves corners to CVAT', () => {
    const upp = 10 / 1000; // 1000px wide canvas
    // Right edge (x = +2), middle
    const right = hitTestCuboidEdge(box, frame, [2.02, 0], upp);
    expect(right).toMatchObject({ axis: 0, sign: 1 });
    // Bottom edge (y = -1)
    expect(hitTestCuboidEdge(box, frame, [0.5, -1], upp)).toMatchObject({ axis: 1, sign: -1 });
    // Corner -> not handled
    expect(hitTestCuboidEdge(box, frame, [2, 1], upp)).toBeNull();
    // Inside / far away -> nothing
    expect(hitTestCuboidEdge(box, frame, [0, 0], upp)).toBeNull();
  });

  it('resizes from one edge keeping the opposite edge fixed', () => {
    const hit = hitTestCuboidEdge(box, frame, [2, 0], 0.01)!;
    const next = resizeCuboidPointsByEdge(box, hit, [1, 0.3]);
    expect(next[6]).toBeCloseTo(5); // length 4 -> 5
    expect(next[0]).toBeCloseTo(0.5); // center shifts by half
    expect(next[0]! - next[6]! / 2).toBeCloseTo(-2); // left edge fixed
    expect(next[7]).toBe(2);

    const leftHit = hitTestCuboidEdge(box, frame, [-2, 0], 0.01)!;
    const shrunk = resizeCuboidPointsByEdge(box, leftHit, [10, 0]);
    expect(shrunk[6]).toBeCloseTo(0.01); // clamped to min size
  });
});

describe('OrthoCuboidEditor keyboard', () => {
  it('swallows WASDQE only while a view is maximized and debounces commits', () => {
    vi.useFakeTimers();
    let maximized: 'top' | null = 'top';
    let points = [...box];
    const previewPoints = vi.fn((_id: number, p: number[]) => {
      points = p;
    });
    const commitPoints = vi.fn();
    const editor = new OrthoCuboidEditor(
      {
        getMaximizedView: () => maximized,
        getActivePoints: () => ({ clientID: 7, points }),
        getViewCamera: () => topCamera,
        previewPoints,
        commitPoints,
      },
      document,
      window
    );
    const uninstall = editor.install();
    const cvatListener = vi.fn();
    document.addEventListener('keydown', cvatListener);

    const ev = new KeyboardEvent('keydown', { code: 'KeyD', bubbles: true, cancelable: true });
    document.body.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    expect(cvatListener).not.toHaveBeenCalled();
    expect(previewPoints).toHaveBeenCalledTimes(1);
    expect(points[0]).toBeGreaterThan(0);

    document.body.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyQ', bubbles: true }));
    expect(points[5]).toBeGreaterThan(0);
    expect(commitPoints).not.toHaveBeenCalled();
    vi.advanceTimersByTime(300);
    expect(commitPoints).toHaveBeenCalledTimes(1);

    // Ctrl+S must still reach CVAT
    document.body.dispatchEvent(
      new KeyboardEvent('keydown', { code: 'KeyS', ctrlKey: true, bubbles: true })
    );
    expect(cvatListener).toHaveBeenCalledTimes(1);

    // Not maximized -> CVAT gets keys normally
    maximized = null;
    document.body.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW', bubbles: true }));
    expect(cvatListener).toHaveBeenCalledTimes(2);

    document.removeEventListener('keydown', cvatListener);
    uninstall();
    vi.useRealTimers();
  });

  it('suppresses WASDQE even when CVAT registered window capture listeners or zoomed via DOM class', () => {
    document.body.innerHTML = `
      <div class="cvat-canvas3d-topview cvat-3d-enhancer-view-maximized">
        <canvas width="866" height="712"></canvas>
      </div>
    `;
    let points = [...box];
    const previewPoints = vi.fn((_id: number, p: number[]) => {
      points = p;
    });
    const editor = new OrthoCuboidEditor(
      {
        getMaximizedView: () => null, // rely on DOM detection
        getActivePoints: () => ({ clientID: 7, points }),
        getViewCamera: () => null, // rely on fallback camera frame
        previewPoints,
        commitPoints: vi.fn(),
      },
      document,
      window
    );
    const uninstall = editor.install();

    // Simulate CVAT registering a capture listener on window (e.g. remove object on 'd')
    const cvatWindowCapture = vi.fn();
    window.addEventListener('keydown', cvatWindowCapture, true);

    const ev = new KeyboardEvent('keydown', { key: 'd', bubbles: true, cancelable: true });
    document.body.dispatchEvent(ev);
    expect(cvatWindowCapture).not.toHaveBeenCalled();
    expect(previewPoints).toHaveBeenCalledTimes(1);

    // Un-zoom in DOM -> CVAT capture listener receives 'd' again
    document
      .querySelector('.cvat-canvas3d-topview')!
      .classList.remove('cvat-3d-enhancer-view-maximized');
    document.body.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'd', bubbles: true, cancelable: true })
    );
    expect(cvatWindowCapture).toHaveBeenCalledTimes(1);

    window.removeEventListener('keydown', cvatWindowCapture, true);
    uninstall();
  });

  it('drags cuboid edges in Top/Side/Front canvas to resize along one axis while keeping opposite edge fixed', () => {
    document.body.innerHTML = `
      <div class="cvat-canvas3d-topview">
        <canvas width="1000" height="1000"></canvas>
      </div>
    `;
    const canvas = document.querySelector<HTMLCanvasElement>('.cvat-canvas3d-topview canvas')!;
    vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 1000,
      bottom: 1000,
      width: 1000,
      height: 1000,
      toJSON: () => ({}),
    });

    let points = [...box];
    const previewPoints = vi.fn((_id: number, p: number[]) => {
      points = p;
    });
    const commitPoints = vi.fn((_id: number, p: number[]) => {
      points = p;
    });

    const editor = new OrthoCuboidEditor(
      {
        getMaximizedView: () => null,
        getActivePoints: () => ({ clientID: 7, points }),
        getViewCamera: () => topCamera,
        previewPoints,
        commitPoints,
      },
      document,
      window
    );
    const uninstall = editor.install();

    // Right edge of box (x = +2 in [-5, 5] frustum -> pixel x = 700, y = 500)
    canvas.dispatchEvent(
      new MouseEvent('pointermove', { clientX: 700, clientY: 500, buttons: 0, bubbles: true })
    );
    expect(canvas.style.cursor).toBe('ew-resize');

    canvas.dispatchEvent(
      new MouseEvent('pointerdown', { clientX: 700, clientY: 500, button: 0, bubbles: true })
    );
    // Drag 100px right (+1.0m in world X)
    window.dispatchEvent(
      new MouseEvent('pointermove', { clientX: 800, clientY: 500, buttons: 1, bubbles: true })
    );
    expect(previewPoints).toHaveBeenCalled();
    expect(points[6]).toBeCloseTo(5); // length 4 -> 5
    expect(points[0]).toBeCloseTo(0.5); // center shifted +0.5m, left edge fixed at -2m

    window.dispatchEvent(
      new MouseEvent('pointerup', { clientX: 800, clientY: 500, button: 0, bubbles: true })
    );
    expect(commitPoints).toHaveBeenCalledTimes(1);

    uninstall();
  });
});
