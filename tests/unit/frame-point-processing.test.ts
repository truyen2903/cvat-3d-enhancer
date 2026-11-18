import { describe, expect, it, vi } from 'vitest';
import {
  Cvat3dPreRenderEnhancer,
  computeDrawnObjectsVisibilityToken,
  findPointsObjectsInScene,
  type CvatDrawnObjectEntry,
  type CvatInternalCanvas3dLike,
  type ThreeObject3DLike,
  type ThreeSceneLike,
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

describe('outside/hidden toggles on the current frame', () => {
  it('recolors points when a box becomes outside or visible again, but not while dragging', () => {
    const point = cloud();
    const box = { data: { clientID: 1, points: [0, 0, 0, 0, 0, 0, 2, 2, 2], outside: false } };
    const canvas: CvatInternalCanvas3dLike = {
      model: { data: { imageID: 1 } },
      view: {
        views: { perspective: { scene: { background: null, children: [point] } } },
        drawnObjects: { 1: box as never },
        notify: vi.fn(),
        render: vi.fn(),
      },
    };
    const enhancer = new Cvat3dPreRenderEnhancer({
      whiteBackground: false,
      enableScattering: true,
      colorPointsByCuboid: true,
    });
    enhancer.ensureHooked(canvas);
    const colors = point.geometry!.attributes!.color!.array;
    const inside = Array.from(colors);
    expect(inside).not.toEqual([1, 1, 1]);

    box.data.outside = true;
    canvas.view!.notify!({}, 'objects_updated');
    expect(Array.from(colors)).toEqual([1, 1, 1]);

    box.data.outside = false;
    canvas.view!.notify!({}, 'objects_updated');
    expect(Array.from(colors)).toEqual(inside);

    // Same-frame geometry edits keep the frozen snapshot (no full recolor per drag event).
    box.data.points[0] = 50;
    canvas.view!.notify!({}, 'objects_updated');
    expect(Array.from(colors)).toEqual(inside);
  });

  it('skips cuboid subtrees (numeric clientID names and Mesh/LineSegments/ArrowHelper) and caches scene Points in O(1)', () => {
    let cuboidChildrenReads = 0;
    const firstPoint = cloud();
    const secondPoint = cloud();
    const children: ThreeObject3DLike[] = [firstPoint];

    for (let id = 1; id <= 2000; id += 1) {
      children.push({
        name: String(id),
        get children(): ThreeObject3DLike[] {
          cuboidChildrenReads += 1;
          return [];
        },
      });
    }
    children.push({
      type: 'Mesh',
      name: 'topPlane',
      get children(): ThreeObject3DLike[] {
        cuboidChildrenReads += 1;
        return [];
      },
    });
    children.push({
      type: 'ArrowHelper',
      get children(): ThreeObject3DLike[] {
        cuboidChildrenReads += 1;
        return [];
      },
    });

    const scene: ThreeSceneLike = {
      background: null,
      children,
    };

    expect(findPointsObjectsInScene(scene)).toEqual([firstPoint]);
    expect(findPointsObjectsInScene(scene)).toEqual([firstPoint]);
    expect(cuboidChildrenReads).toBe(0);

    // Replacing the direct Points child invalidates the O(1) anchor and returns the new cloud
    scene.children[0] = secondPoint;
    expect(findPointsObjectsInScene(scene)).toEqual([secondPoint]);
    expect(cuboidChildrenReads).toBe(0);
  });

  it('avoids O(N) visibility signature scans on objects_updated when colorPointsByCuboid and hideGroundPoints are off', () => {
    let visibilityFlagReads = 0;
    const drawnObjects: Record<number, CvatDrawnObjectEntry> = {};
    for (let id = 1; id <= 2000; id += 1) {
      const mat = { depthWrite: true };
      drawnObjects[id] = {
        data: {
          clientID: id,
          points: [0, 0, 0, 0, 0, 0, 2, 2, 2],
          get hidden(): boolean {
            visibilityFlagReads += 1;
            return false;
          },
          get outside(): boolean {
            visibilityFlagReads += 1;
            return false;
          },
        },
        cuboid: {
          perspective: { material: mat },
        },
      } as unknown as CvatDrawnObjectEntry;
    }

    const point = cloud();
    const canvas: CvatInternalCanvas3dLike = {
      model: { data: { imageID: 1 } },
      view: {
        views: { perspective: { scene: { background: null, children: [point] } } },
        drawnObjects,
        notify: vi.fn(),
        render: vi.fn(),
      },
    };

    const enhancer = new Cvat3dPreRenderEnhancer({
      whiteBackground: false,
      enableScattering: false,
      colorPointsByCuboid: false,
      hideGroundPoints: false,
    });
    enhancer.ensureHooked(canvas);
    expect(drawnObjects[1]!.cuboid.perspective!.material!.depthWrite).toBe(false);

    visibilityFlagReads = 0;
    // Simulate filtering down to 50 existing cuboids + 1 newly created cuboid
    const filtered: Record<number, CvatDrawnObjectEntry> = {};
    for (let id = 1; id <= 50; id += 1) {
      filtered[id] = drawnObjects[id]!;
    }
    const addedMat = { depthWrite: true };
    filtered[9999] = {
      data: {
        clientID: 9999,
        points: [1, 1, 1, 0, 0, 0, 2, 2, 2],
        get hidden(): boolean {
          visibilityFlagReads += 1;
          return false;
        },
        get outside(): boolean {
          visibilityFlagReads += 1;
          return false;
        },
      },
      cuboid: {
        perspective: { material: addedMat },
      },
    } as unknown as CvatDrawnObjectEntry;

    canvas.view!.drawnObjects = filtered;
    canvas.view!.notify!({}, 'objects_updated');
    expect(visibilityFlagReads).toBe(0);
    expect(addedMat.depthWrite).toBe(false);
  });

  it('computes order-independent compact visibility tokens in a single pass when colorPointsByCuboid is enabled', () => {
    const a: Record<string, CvatDrawnObjectEntry> = {};
    a['10'] = { data: { clientID: 10, points: [], hidden: false, outside: false }, cuboid: {} };
    a['2'] = { data: { clientID: 2, points: [], hidden: true, outside: false }, cuboid: {} };
    a['99'] = { data: { clientID: 99, points: [], hidden: false, outside: true }, cuboid: {} };

    const b: Record<string, CvatDrawnObjectEntry> = {};
    b['99'] = a['99']!;
    b['10'] = a['10']!;
    b['2'] = a['2']!;

    const tokA = computeDrawnObjectsVisibilityToken(
      a as unknown as Record<number, CvatDrawnObjectEntry>
    );
    const tokB = computeDrawnObjectsVisibilityToken(
      b as unknown as Record<number, CvatDrawnObjectEntry>
    );
    expect(tokA).toBe(tokB);
    expect(tokA.length).toBeLessThanOrEqual(40);

    // Swapping hidden state between two IDs must produce a distinct token even with identical visibleCount
    const swapped: Record<string, CvatDrawnObjectEntry> = {
      '10': { data: { clientID: 10, points: [], hidden: true, outside: false }, cuboid: {} },
      '2': { data: { clientID: 2, points: [], hidden: false, outside: false }, cuboid: {} },
      '99': a['99']!,
    };
    expect(
      computeDrawnObjectsVisibilityToken(swapped as unknown as Record<number, CvatDrawnObjectEntry>)
    ).not.toBe(tokA);

    // Ensure notify('objects_updated') reuses the computed token inside applyOnceIfNeeded (single pass)
    let hiddenReads = 0;
    const tracked = {
      1: {
        data: {
          clientID: 1,
          points: [0, 0, 0, 0, 0, 0, 2, 2, 2],
          get hidden(): boolean {
            hiddenReads += 1;
            return this._hidden;
          },
          _hidden: false,
        },
        cuboid: {},
      },
    };
    const canvas: CvatInternalCanvas3dLike = {
      model: { data: { imageID: 1 } },
      view: {
        views: { perspective: { scene: { background: null, children: [cloud()] } } },
        drawnObjects: tracked as unknown as Record<number, CvatDrawnObjectEntry>,
        notify: vi.fn(),
        render: vi.fn(),
      },
    };
    const enhancer = new Cvat3dPreRenderEnhancer({
      whiteBackground: false,
      enableScattering: true,
      colorPointsByCuboid: true,
    });
    enhancer.ensureHooked(canvas);
    hiddenReads = 0;
    tracked[1].data._hidden = true;
    canvas.view!.notify!({}, 'objects_updated');
    // 1 read during token computation + 1 read inside compileOrientedCuboids = at most 2 reads (not 3)
    expect(hiddenReads).toBeLessThanOrEqual(2);
  });

  it('reuses point classification hits across Perspective and Top views and caches ground elevation across filter changes', () => {
    const pos = new Float32Array([
      0,
      0,
      -1.6, // inside Box #1 near ground -> kept & colored
      4,
      0,
      -1.6, // inside Box #2 near ground -> kept & colored
      10,
      0,
      -1.6, // unboxed ground -> hidden in Top, solid white in Perspective
      10,
      0,
      0.8, // unboxed elevated -> kept in Top & Perspective
    ]);
    const col = new Float32Array(12).fill(0.5);
    const sharedGeom = {
      attributes: {
        position: { array: pos, needsUpdate: false },
        color: { array: col, needsUpdate: false },
      },
      drawRange: { start: 0, count: 4 },
      setDrawRange(start: number, count: number) {
        this.drawRange.start = start;
        this.drawRange.count = count;
      },
    };

    const perspPoints: ThreeObject3DLike = {
      type: 'Points',
      geometry: sharedGeom,
      material: { size: 0.05, color: { r: 1, g: 1, b: 1, set: vi.fn() } },
    };
    const topPoints: ThreeObject3DLike = {
      type: 'Points',
      geometry: sharedGeom,
      material: { size: 0.5, color: { r: 1, g: 1, b: 1, set: vi.fn() } },
    };

    const box1 = {
      data: {
        clientID: 1,
        labelColor: '#ff0000',
        points: [0, 0, -1.5, 0, 0, 0, 2, 2, 0.8],
        hidden: false,
        outside: false,
      },
      cuboid: {},
    };
    const box2 = {
      data: {
        clientID: 2,
        labelColor: '#00ff00',
        points: [4, 0, -1.5, 0, 0, 0, 2, 2, 0.8],
        hidden: false,
        outside: false,
      },
      cuboid: {},
    };

    const canvas: CvatInternalCanvas3dLike = {
      model: { data: { imageID: 7 } },
      view: {
        views: {
          perspective: { scene: { background: null, children: [perspPoints] } },
          top: { scene: { background: null, children: [topPoints] } },
        },
        drawnObjects: { 1: box1, 2: box2 },
        notify: vi.fn(),
        render: vi.fn(),
      },
    };

    const enhancer = new Cvat3dPreRenderEnhancer({
      whiteBackground: false,
      enableScattering: true,
      colorPointsByCuboid: true,
      hideGroundPoints: true,
    });
    enhancer.ensureHooked(canvas);

    // Initially: Point 0 (Box 1), Point 1 (Box 2), Point 3 (elevated) kept in Top -> 3 vertices
    expect(topPoints.geometry!.drawRange!.count).toBe(3);
    expect(perspPoints.geometry!.drawRange!.count).toBe(4);

    // Filter hides Box 2 -> Point 1 at z=-1.6 becomes unboxed ground and is stripped in Top -> 2 vertices
    box2.data.hidden = true;
    canvas.view!.notify!({}, 'objects_updated');
    expect(topPoints.geometry!.drawRange!.count).toBe(2);

    // Filter clears (Box 2 visible again) -> Point 1 restored in Top -> 3 vertices
    box2.data.hidden = false;
    canvas.view!.notify!({}, 'objects_updated');
    expect(topPoints.geometry!.drawRange!.count).toBe(3);
  });
});
