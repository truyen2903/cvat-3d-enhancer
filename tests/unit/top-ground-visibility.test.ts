import { BufferGeometry, Float32BufferAttribute } from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  Cvat3dPreRenderEnhancer,
  type CvatInternalCanvas3dLike,
  type ThreeObject3DLike,
} from '../../src/integration/cvat/runtime/pre-render-enhancer';

function fixture() {
  const geometry = new BufferGeometry();
  geometry.setAttribute(
    'position',
    new Float32BufferAttribute([0, 0, -1.6, 10, 0, -1.6, 10, 0, 0.5, 12, 0, -1.62], 3)
  );
  geometry.setAttribute('color', new Float32BufferAttribute(new Float32Array(12).fill(0.5), 3));
  geometry.setDrawRange(0, 4);
  const makePoints = (): ThreeObject3DLike => ({
    type: 'Points',
    geometry: geometry as unknown as ThreeObject3DLike['geometry'],
    material: { size: 0.05, color: { r: 1, g: 1, b: 1, set: vi.fn() } },
  });
  const main = makePoints(),
    top = makePoints(),
    side = makePoints(),
    front = makePoints();
  const scene = (point: ThreeObject3DLike) => ({ background: null, children: [point] });
  const canvas: CvatInternalCanvas3dLike = {
    model: { data: { imageID: 10 } },
    view: {
      views: {
        perspective: { scene: scene(main) },
        top: { scene: scene(top) },
        side: { scene: scene(side) },
        front: { scene: scene(front) },
      },
      drawnObjects: {
        1: { data: { clientID: 1, points: [0, 0, -1.5, 0, 0, 0, 2, 2, 0.6] }, cuboid: {} },
      },
    },
  };
  const enhancer = new Cvat3dPreRenderEnhancer({
    whiteBackground: false,
    enableScattering: false,
    colorPointsByCuboid: false,
    hideGroundPoints: true,
  });
  const originalPositions = geometry.getAttribute('position').array.slice();
  const originalColors = geometry.getAttribute('color').array.slice();
  enhancer.ensureHooked(canvas);
  return { geometry, main, top, side, front, canvas, enhancer, originalPositions, originalColors };
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('Top-only ground visibility with shared native BufferGeometry', () => {
  it('filters a private Top copy and leaves main, Side and Front buffers and draw ranges untouched', () => {
    const f = fixture();
    expect(f.top.geometry).not.toBe(f.geometry);
    expect(f.top.geometry!.attributes!.position!.array).not.toBe(
      f.geometry.getAttribute('position').array
    );
    expect(f.top.geometry!.drawRange!.count).toBe(2);
    for (const point of [f.main, f.side, f.front]) {
      expect(point.geometry).toBe(f.geometry);
      expect(point.geometry!.drawRange!.count).toBe(4);
    }
    expect(f.geometry.getAttribute('position').array).toEqual(f.originalPositions);
    expect(f.geometry.getAttribute('color').array).toEqual(f.originalColors);
  });

  it('restores all Top points when disabled and reuses the same isolated copy when enabled again', () => {
    const f = fixture();
    const copy = f.top.geometry;
    f.enhancer.setOptions({ ...f.enhancer.getOptions(), hideGroundPoints: false }, f.canvas);
    expect(copy!.drawRange!.count).toBe(4);
    expect(copy!.attributes!.position!.array).toEqual(f.originalPositions);
    f.enhancer.setOptions({ ...f.enhancer.getOptions(), hideGroundPoints: true }, f.canvas);
    expect(f.top.geometry).toBe(copy);
    expect(copy!.drawRange!.count).toBe(2);
    expect(f.geometry.drawRange.count).toBe(4);
  });

  it('keeps a newly opened Top filtered and a Side clone unfiltered without changing shared geometry', () => {
    const f = fixture();
    document.body.innerHTML =
      '<div class="cvat-canvas3d-topview"><canvas id="top"></canvas></div><div class="cvat-canvas3d-sideview"><canvas id="side"></canvas></div>';
    const zoomTop: ThreeObject3DLike = { ...f.main };
    const zoomSide: ThreeObject3DLike = { ...f.side, geometry: f.top.geometry };
    const internal = f.enhancer as unknown as {
      handlePointsBeforeRender: (
        point: ThreeObject3DLike,
        renderer: unknown,
        scene: unknown,
        camera: unknown
      ) => void;
    };
    internal.handlePointsBeforeRender(
      zoomTop,
      { domElement: document.getElementById('top') },
      {},
      { isOrthographicCamera: true }
    );
    internal.handlePointsBeforeRender(
      zoomSide,
      { domElement: document.getElementById('side') },
      {},
      { isOrthographicCamera: true }
    );
    expect(zoomTop.geometry!.drawRange!.count).toBe(2);
    expect(zoomSide.geometry).toBe(f.geometry);
    expect(zoomSide.geometry!.drawRange!.count).toBe(4);
    expect(f.top.geometry!.drawRange!.count).toBe(2);
  });

  it('does not rescan shared view buffers on every render when ground hiding is off', () => {
    const f = fixture();
    f.enhancer.setOptions({ ...f.enhancer.getOptions(), hideGroundPoints: false }, f.canvas);
    const internal = f.enhancer as unknown as {
      applyPointCloudBoxColors: (
        point: ThreeObject3DLike,
        boxes: unknown[],
        isTop?: boolean
      ) => void;
    };
    const process = vi.spyOn(internal, 'applyPointCloudBoxColors');
    for (let i = 0; i < 3; i++) {
      f.main.onBeforeRender?.({}, f.canvas.view!.views!.perspective!.scene, {
        isPerspectiveCamera: true,
      });
      f.top.onBeforeRender?.({}, f.canvas.view!.views!.top!.scene, { isOrthographicCamera: true });
    }
    expect(process).not.toHaveBeenCalled();
  });
});
