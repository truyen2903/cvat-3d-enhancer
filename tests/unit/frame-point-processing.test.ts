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
          canvas.view!.onSceneImageLoaded!(next);
          canvas.view!.drawnObjects = { 1: entry };
          canvas.view!.notify!({}, 'objects_updated');
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
