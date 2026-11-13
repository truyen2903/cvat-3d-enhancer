import { describe, expect, it, vi } from 'vitest';
import {
  Cvat3dPreRenderEnhancer,
  type CvatInternalCanvas3dLike,
  type ThreeObject3DLike,
} from '../../src/integration/cvat/runtime/pre-render-enhancer';

function cloud(): ThreeObject3DLike {
  return {
    type: 'Points',
    geometry: {
      attributes: {
        position: { array: new Float32Array([0, 0, 0]) },
        color: { array: new Float32Array([1, 1, 1]) },
      },
    },
    material: { size: 0.05, color: { r: 1, g: 1, b: 1, set: vi.fn() } },
  };
}
const entry = { data: { clientID: 1, points: [0, 0, 0, 0, 0, 0, 2, 2, 2] }, cuboid: {} };

describe('frame point-cloud processing', () => {
  it('processes a synchronous frame load once after native objects update, even across shared views', () => {
    const initial = cloud();
    const next = cloud();
    const canvas: CvatInternalCanvas3dLike = {
      model: { data: { imageID: 1 } },
      view: {
        views: {
          perspective: { scene: { background: null, children: [initial] } },
          top: { scene: { background: null, children: [initial] } },
        },
        drawnObjects: { 1: entry },
        onSceneImageLoaded: (points) => {
          for (const view of Object.values(canvas.view!.views!)) view!.scene!.children = [points];
        },
        notify: (_model, reason) => {
          if (reason !== 'image_changed') return;
          canvas.model!.data!.imageID = 2;
          canvas.view!.drawnObjects = {};
          canvas.view!.render!();
          canvas.view!.onSceneImageLoaded!(next);
          canvas.view!.render!();
          canvas.view!.drawnObjects = { 1: entry };
          canvas.view!.notify!({}, 'objects_updated');
          canvas.view!.render!();
        },
        render: vi.fn(),
      },
    };
    const enhancer = new Cvat3dPreRenderEnhancer({
      whiteBackground: false,
      enableScattering: true,
      colorPointsByCuboid: true,
    });
    const internal = enhancer as unknown as {
      applyPointCloudBoxColors: (points: ThreeObject3DLike, boxes: unknown[]) => void;
    };
    const process = vi.spyOn(internal, 'applyPointCloudBoxColors');
    enhancer.ensureHooked(canvas);
    process.mockClear();
    canvas.view!.notify!({}, 'image_changed');
    expect(process).toHaveBeenCalledTimes(1);
    expect(process.mock.calls[0]![0].geometry).toBe(next.geometry);
    canvas.view!.render!();
    expect(process).toHaveBeenCalledTimes(1);
  });

  it('waits for an asynchronous image load without processing the previous cloud again', () => {
    const initial = cloud();
    const next = cloud();
    const canvas: CvatInternalCanvas3dLike = {
      model: { data: { imageID: 1 } },
      view: {
        views: { perspective: { scene: { background: null, children: [initial] } } },
        drawnObjects: { 1: entry },
        notify: () => {
          canvas.model!.data!.imageID = 2;
        },
        onSceneImageLoaded: (points) => {
          canvas.view!.views!.perspective!.scene!.children = [points];
        },
        render: vi.fn(),
      },
    };
    const enhancer = new Cvat3dPreRenderEnhancer();
    const process = vi.spyOn(
      enhancer as unknown as {
        applyPointCloudBoxColors: (points: ThreeObject3DLike) => void;
      },
      'applyPointCloudBoxColors'
    );
    enhancer.ensureHooked(canvas);
    process.mockClear();
    canvas.view!.notify!({}, 'image_changed');
    canvas.view!.render!();
    expect(process).not.toHaveBeenCalled();
    canvas.view!.onSceneImageLoaded!(next);
    canvas.view!.notify!({}, 'objects_updated');
    expect(process).toHaveBeenCalledOnce();
    expect(process.mock.calls[0]![0]).toBe(next);
  });

  it('settles empty filter results and restores boxes on clear without repeated point processing', () => {
    const point = cloud();
    const canvas: CvatInternalCanvas3dLike = {
      view: {
        views: { perspective: { scene: { background: null, children: [point] } } },
        drawnObjects: { 1: entry },
        notify: vi.fn(),
        render: vi.fn(),
      },
    };
    const enhancer = new Cvat3dPreRenderEnhancer({
      whiteBackground: false,
      enableScattering: true,
      colorPointsByCuboid: true,
    });
    const process = vi.spyOn(
      enhancer as unknown as {
        applyPointCloudBoxColors: (points: ThreeObject3DLike) => void;
      },
      'applyPointCloudBoxColors'
    );
    enhancer.ensureHooked(canvas);
    process.mockClear();
    const snapshots: NonNullable<CvatInternalCanvas3dLike['view']>['drawnObjects'][] = [
      {},
      { 1: entry },
      {},
      { 1: entry },
    ];
    for (const objects of snapshots) {
      canvas.view!.drawnObjects = objects;
      canvas.view!.notify!({}, 'objects_updated');
      const calls = process.mock.calls.length;
      for (let i = 0; i < 5; i++) {
        canvas.view!.notify!({}, 'objects_updated');
        enhancer.markViewStructureChanged();
        canvas.view!.render!();
      }
      expect(process).toHaveBeenCalledTimes(calls);
    }
    expect(process).toHaveBeenCalledTimes(4);
    expect(point.geometry!.attributes!.color!.array[0]).not.toBe(1);
  });

  it('discovers point objects only once per scene while processing a new frame', () => {
    let reads = 0;
    const point = cloud();
    const branch: ThreeObject3DLike = {
      get children() {
        reads++;
        return [point];
      },
    };
    const scene = { background: null, children: [branch] };
    const canvas: CvatInternalCanvas3dLike = {
      model: { data: { imageID: 1 } },
      view: { views: { perspective: { scene } }, drawnObjects: { 1: entry } },
    };
    const enhancer = new Cvat3dPreRenderEnhancer();
    enhancer.ensureHooked(canvas);
    reads = 0;
    enhancer.markDirty();
    canvas.model!.data!.imageID = 2;
    enhancer.applyOnceIfNeeded(canvas.view!, canvas.model);
    // Discovery accesses children twice, and plane optimization may inspect it too.
    // Multiple point-cloud passes used to revisit this subtree three extra times.
    expect(reads).toBeLessThanOrEqual(6);
  });

  it('still applies a loaded cloud on the next render when no objects notification is available', () => {
    const initial = cloud(),
      next = cloud();
    const canvas: CvatInternalCanvas3dLike = {
      view: {
        views: { perspective: { scene: { background: null, children: [initial] } } },
        drawnObjects: { 1: entry },
        render: vi.fn(),
        onSceneImageLoaded: (points) => {
          canvas.view!.views!.perspective!.scene!.children = [points];
        },
      },
    };
    const enhancer = new Cvat3dPreRenderEnhancer({
      whiteBackground: false,
      enableScattering: true,
      colorPointsByCuboid: false,
    });
    enhancer.ensureHooked(canvas);
    canvas.view!.onSceneImageLoaded!(next);
    expect(next.geometry!.attributes!.color!.array[0]).toBe(1);
    canvas.view!.render!();
    // Scattering on black background produces white unboxed points.
    expect(next.geometry!.attributes!.color!.needsUpdate).toBe(true);
  });
});
