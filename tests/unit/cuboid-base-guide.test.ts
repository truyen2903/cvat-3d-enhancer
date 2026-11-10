import { BoxGeometry, Mesh, OrthographicCamera } from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CuboidBaseGuide,
  projectCuboidBaseGuide,
  projectRenderedCuboidBaseGuide,
} from '../../src/integration/cvat/runtime/cuboid-base-guide';
import { DEFAULT_ORTHO_CAMERA_FRAMES } from '../../src/integration/cvat/runtime/ortho-cuboid-editor';
import type {
  CameraFrame,
  OrthoCameraLike,
} from '../../src/integration/cvat/runtime/ortho-cuboid-editor';

const points = [0, 0, 0, 0, 0, 0, 4, 2, 2];
function cameraFor(frame: CameraFrame): OrthoCameraLike {
  return {
    isOrthographicCamera: true,
    left: -frame.halfW,
    right: frame.halfW,
    top: frame.halfH,
    bottom: -frame.halfH,
    matrixWorld: {
      elements: [...frame.right, 0, ...frame.up, 0, ...frame.back, 0, ...frame.position, 1],
    },
  };
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('cuboid lowest slice guide', () => {
  it.each(['side', 'front'] as const)('extends the lowest slice across the %s viewport', (view) => {
    const line = projectCuboidBaseGuide(points, DEFAULT_ORTHO_CAMERA_FRAMES[view], 200, 200)!;
    expect(line.x1).toBe(0);
    expect(line.x2).toBe(200);
    expect(line.y1).toBeCloseTo(110);
    expect(line.y2).toBeCloseTo(110);
  });

  it('stays horizontal at the final projected row when the box is tilted', () => {
    const tilted = [...points];
    tilted[4] = Math.PI / 6;
    const line = projectCuboidBaseGuide(tilted, DEFAULT_ORTHO_CAMERA_FRAMES.side, 200, 200)!;
    const lowestCornerY = 100 + 10 * (2 * Math.sin(Math.PI / 6) + Math.cos(Math.PI / 6));
    expect(line.y1).toBeCloseTo(lowestCornerY);
    expect(line.y2).toBeCloseTo(lowestCornerY);
    expect(line.x1).toBe(0);
    expect(line.x2).toBe(200);
  });

  it('uses the actual lowest slice even when the cuboid is inverted', () => {
    const inverted = [...points];
    inverted[3] = Math.PI;
    const line = projectCuboidBaseGuide(inverted, DEFAULT_ORTHO_CAMERA_FRAMES.front, 200, 200)!;
    expect(line.y1).toBeCloseTo(110);
    expect(line.y2).toBeCloseTo(110);
  });

  it('projects using camera zoom, translation and viewport size', () => {
    const frame = {
      ...DEFAULT_ORTHO_CAMERA_FRAMES.side,
      halfW: 5,
      halfH: 5,
      position: [2, -10, 1] as [number, number, number],
    };
    expect(projectCuboidBaseGuide(points, frame, 400, 200)).toEqual({
      x1: 0,
      y1: 140,
      x2: 400,
      y2: 140,
    });
  });

  it('skips Top view, missing geometry and invalid/offscreen bases', () => {
    expect(projectCuboidBaseGuide(points, DEFAULT_ORTHO_CAMERA_FRAMES.top, 200, 200)).toBeNull();
    expect(projectCuboidBaseGuide([], DEFAULT_ORTHO_CAMERA_FRAMES.side, 200, 200)).toBeNull();
    expect(
      projectCuboidBaseGuide([NaN, ...points.slice(1)], DEFAULT_ORTHO_CAMERA_FRAMES.side, 200, 200)
    ).toBeNull();
    expect(
      projectCuboidBaseGuide(
        [0, 0, -100, ...points.slice(3)],
        DEFAULT_ORTHO_CAMERA_FRAMES.side,
        200,
        200
      )
    ).toBeNull();
  });

  it('uses the live rendered mesh in an unexpanded Y-up view, ignoring stale annotation points', () => {
    const mesh = new Mesh(new BoxGeometry(1, 1, 1));
    mesh.scale.set(4, 2, 2);
    mesh.position.set(0, 2, 0);
    mesh.updateMatrixWorld(true);
    const camera = new OrthographicCamera(-10, 10, 10, -10, 0.1, 100);
    camera.position.z = 10;
    camera.updateMatrixWorld(true);
    const line = projectRenderedCuboidBaseGuide(mesh, camera, 217, 233)!;
    expect(line.y1).toBeCloseTo(104.85);
    expect(line.y2).toBeCloseTo(104.85);
    mesh.position.y = 3;
    mesh.updateMatrixWorld(true);
    const moved = projectRenderedCuboidBaseGuide(mesh, camera, 217, 233)!;
    expect(moved.y1).toBeCloseTo(93.2);
    camera.zoom = 2;
    camera.updateProjectionMatrix();
    const zoomed = projectRenderedCuboidBaseGuide(mesh, camera, 217, 233)!;
    expect(zoomed.y1).toBeCloseTo(69.9);
    expect(zoomed.y1).toBe(zoomed.y2);
    mesh.geometry.dispose();
  });

  it('anchors a thin overlay to the canvas viewport outside transformed panel ancestors', () => {
    document.body.innerHTML =
      '<div style="transform:translate(40px,60px);padding:20px"><canvas width="217" height="233"></canvas></div>';
    const canvas = document.querySelector('canvas')!;
    vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({
      left: 60,
      top: 80,
      width: 217,
      height: 233,
      right: 277,
      bottom: 313,
      x: 60,
      y: 80,
      toJSON() {},
    });
    const mesh = new Mesh(new BoxGeometry(1, 1, 1));
    mesh.scale.set(4, 2, 2);
    mesh.updateMatrixWorld(true);
    const camera = new OrthographicCamera(-10, 10, 10, -10, 0.1, 100);
    camera.position.z = 10;
    camera.updateMatrixWorld(true);
    const guide = new CuboidBaseGuide(document);
    try {
      guide.update(canvas, camera, [0, 500, 0, 0, 0, 0, 4, 2, 2], mesh);
      const svg = document.querySelector<SVGSVGElement>('.cvat-3d-enhancer-base-guide')!;
      expect(svg.parentElement).toBe(document.documentElement);
      expect(svg.style.top).toBe('80px');
      expect(svg.style.left).toBe('60px');
      expect(svg.getAttribute('viewBox')).toBe('0 0 217 233');
      expect(svg.querySelectorAll('line')).toHaveLength(1);
      expect(svg.firstElementChild!.getAttribute('stroke-width')).toBe('1');
      expect(svg.firstElementChild!.getAttribute('y1')).toBe('128.15');
    } finally {
      guide.clear();
      mesh.geometry.dispose();
    }
  });

  it('tracks the rendered canvas, hides on deselection and cleans up on disposal', () => {
    document.body.innerHTML = '<div><canvas></canvas></div>';
    const canvas = document.querySelector('canvas')!;
    vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({
      x: 20,
      y: 30,
      left: 20,
      top: 30,
      right: 237,
      bottom: 263,
      width: 217,
      height: 233,
      toJSON() {},
    });
    const guide = new CuboidBaseGuide(document);
    const camera = cameraFor(DEFAULT_ORTHO_CAMERA_FRAMES.side);
    guide.update(canvas, camera, points);
    const svg = document.querySelector<SVGSVGElement>('.cvat-3d-enhancer-base-guide')!;
    expect(svg.style.pointerEvents).toBe('none');
    expect(svg.lastElementChild!.getAttribute('stroke')).toBe('#ef4444');
    expect(svg.lastElementChild!.hasAttribute('stroke-dasharray')).toBe(false);
    expect(svg.style.left).toBe('20px');
    expect(svg.style.width).toBe('217px');
    expect(svg.querySelector('line')!.getAttribute('y1')).toBe('128.15');
    guide.update(canvas, camera, null);
    expect(svg.style.display).toBe('none');
    guide.update(canvas, camera, points);
    expect(svg.style.display).toBe('block');
    expect(document.querySelectorAll('.cvat-3d-enhancer-base-guide')).toHaveLength(1);
    canvas.remove();
    guide.prune();
    expect(svg.isConnected).toBe(false);
    guide.clear();
  });
});
