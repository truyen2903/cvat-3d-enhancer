import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PageBridgeRuntimeHost } from '../../src/entrypoints/page-bridge';
import type { ActiveObjectCameraFollower } from '../../src/integration/cvat/runtime/camera-follow';
import type { OrthoCameraLike } from '../../src/integration/cvat/runtime/ortho-cuboid-editor';
import type {
  Cvat3dPreRenderEnhancer,
  CvatDrawnObjectEntry,
  CvatInternalCanvas3dLike,
  CvatObjectStateLike,
  ThreeSceneLike,
} from '../../src/integration/cvat/runtime/pre-render-enhancer';

function mockCanvasRect(canvas: HTMLCanvasElement, width = 320, height = 240): void {
  vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    right: width,
    bottom: height,
    width,
    height,
    toJSON() {},
  });
}

function createMockScene(): ThreeSceneLike {
  return {
    background: { r: 0, g: 0, b: 0, set: vi.fn() },
    children: [],
  };
}

function createOrthoCamera(): OrthoCameraLike {
  return {
    isOrthographicCamera: true,
    left: -12,
    right: 12,
    top: 12,
    bottom: -12,
    matrixWorld: {
      elements: [1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, -15, 0, 1],
    },
  };
}

describe('100,000 IDs/frame scale & O(1)/O(log N) complexity invariants', () => {
  beforeEach(() => {
    window.localStorage.clear();
    delete (window as { cvatUI?: unknown }).cvatUI;
    document.body.innerHTML = `
      <div id="root">
        <div class="cvat-canvas3d-perspective">
          <div class="cvat-canvas-container">
            <canvas width="800" height="600" data-frame-number="10"></canvas>
          </div>
        </div>
        <div class="cvat-canvas3d-orthographic-view cvat-canvas3d-topview"><canvas></canvas></div>
        <div class="cvat-canvas3d-orthographic-view cvat-canvas3d-sideview"><canvas></canvas></div>
        <div class="cvat-canvas3d-orthographic-view cvat-canvas3d-frontview"><canvas></canvas></div>
        <div class="cvat-annotations-filters-input">
          <input id="cvat-filter-box" type="text" />
        </div>
        <div class="cvat-objects-sidebar"></div>
      </div>
    `;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete (window as { cvatUI?: unknown }).cvatUI;
  });

  it('1. caches DOM-backed getDrawnObjects() across 100,000 cuboids in <= 2 calls and runs 60 frames < 50ms', () => {
    const TOTAL_CUBOIDS = 100_000;
    const ACTIVE_ID = 77_777;

    const perspScene = createMockScene();
    const topScene = createMockScene();
    const sideScene = createMockScene();
    const frontScene = createMockScene();

    const perspCanvas = document.querySelector<
      HTMLCanvasElement & {
        scene?: ThreeSceneLike;
        getDrawnObjects?: () => CvatDrawnObjectEntry[];
      }
    >('.cvat-canvas3d-perspective canvas')!;
    const topCanvas = document.querySelector<HTMLCanvasElement & { scene?: ThreeSceneLike }>(
      '.cvat-canvas3d-topview canvas'
    )!;
    const sideCanvas = document.querySelector<HTMLCanvasElement & { scene?: ThreeSceneLike }>(
      '.cvat-canvas3d-sideview canvas'
    )!;
    const frontCanvas = document.querySelector<HTMLCanvasElement & { scene?: ThreeSceneLike }>(
      '.cvat-canvas3d-frontview canvas'
    )!;

    perspCanvas.scene = perspScene;
    topCanvas.scene = topScene;
    sideCanvas.scene = sideScene;
    frontCanvas.scene = frontScene;

    mockCanvasRect(topCanvas);
    mockCanvasRect(sideCanvas);
    mockCanvasRect(frontCanvas);

    const sharedPoints = [2, 1, 0, 0, 0, 0, 4.4, 1.8, 1.6];
    const drawnList: CvatDrawnObjectEntry[] = new Array<CvatDrawnObjectEntry>(TOTAL_CUBOIDS);
    for (let i = 0; i < TOTAL_CUBOIDS; i += 1) {
      drawnList[i] = {
        data: {
          clientID: i,
          points: sharedPoints,
        },
        state:
          i === ACTIVE_ID
            ? {
                clientID: i,
                frame: 10,
                shapeType: 'cuboid',
                points: sharedPoints,
              }
            : undefined,
        cuboid: {},
      };
    }

    const getDrawnObjectsSpy = vi.fn(() => drawnList);
    perspCanvas.getDrawnObjects = getDrawnObjectsSpy;

    // Active object selected in sidebar (pure DOM-backed mode without Redux store)
    const activeCard = document.createElement('div');
    activeCard.id = `cvat-objects-sidebar-state-item-${ACTIVE_ID}`;
    activeCard.className = 'cvat-objects-sidebar-state-item cvat-objects-sidebar-state-active-item';
    document.querySelector('.cvat-objects-sidebar')!.appendChild(activeCard);

    const host = new PageBridgeRuntimeHost(
      'scale_100k_dom_drawn_objects_token_999999',
      window as never,
      document
    );
    const internal = host as unknown as {
      preRenderEnhancer: Cvat3dPreRenderEnhancer;
      cameraFollower: ActiveObjectCameraFollower;
      getActiveCanvas3dInstance: () => CvatInternalCanvas3dLike | null;
    };

    let renderListener:
      ((canvas: HTMLCanvasElement, camera: unknown, scene?: ThreeSceneLike) => void) | null = null;
    const setListenerSpy = vi.spyOn(internal.preRenderEnhancer, 'setCanvasRenderListener');

    const stop = host.start();
    try {
      renderListener = setListenerSpy.mock.calls[0]?.[0] ?? null;
      expect(renderListener).toBeTypeOf('function');

      const instance = internal.getActiveCanvas3dInstance();
      expect(instance?.view).toBeDefined();

      // Reset call counters right before measuring the 60-frame hot loop
      getDrawnObjectsSpy.mockClear();
      const qsaSpy = vi.spyOn(document, 'querySelectorAll');
      const topClosestSpy = vi.spyOn(topCanvas, 'closest');
      const sideClosestSpy = vi.spyOn(sideCanvas, 'closest');
      const frontClosestSpy = vi.spyOn(frontCanvas, 'closest');

      const orthoCam = createOrthoCamera();
      const startMs = performance.now();
      for (let frameIdx = 0; frameIdx < 60; frameIdx += 1) {
        renderListener!(topCanvas, orthoCam, topScene);
        renderListener!(sideCanvas, orthoCam, sideScene);
        renderListener!(frontCanvas, orthoCam, frontScene);
        internal.cameraFollower.tick(instance!.view as never, instance!.model as never);
      }
      const elapsedMs = performance.now() - startMs;

      // Must NEVER call getDrawnObjects() 240 times (at most 1-2 calls: binary search + 1 cached map build)
      expect(getDrawnObjectsSpy.mock.calls.length).toBeLessThanOrEqual(2);
      // Zero document.querySelectorAll('canvas') on steady 60fps loop
      expect(qsaSpy).not.toHaveBeenCalled();
      // WeakMap role cache: closest() called at most once per canvas across all 60 frames
      expect(topClosestSpy.mock.calls.length).toBeLessThanOrEqual(1);
      expect(sideClosestSpy.mock.calls.length).toBeLessThanOrEqual(1);
      expect(frontClosestSpy.mock.calls.length).toBeLessThanOrEqual(1);
      expect(elapsedMs).toBeLessThan(50);

      const guides = document.querySelectorAll<SVGSVGElement>('.cvat-3d-enhancer-base-guide');
      expect(guides.length).toBe(2); // side + front only, never top
    } finally {
      stop();
    }
  });

  it('1b. resolves zoomed ortho scene membership via O(1) parent chain without DFS over 100,000 meshes', () => {
    const TOTAL_MESHES = 100_000;
    const zoomCanvas = document.createElement('canvas') as HTMLCanvasElement & {
      scene?: ThreeSceneLike;
    };
    document.body.appendChild(zoomCanvas);
    mockCanvasRect(zoomCanvas, 640, 480);

    const zoomScene = createMockScene();
    let childElementReads = 0;
    const rawChildren = new Array<Record<string, unknown>>(TOTAL_MESHES);
    for (let i = 0; i < TOTAL_MESHES; i += 1) {
      rawChildren[i] = { name: String(i), parent: zoomScene };
    }
    const activeSideMesh = rawChildren[TOTAL_MESHES - 1]!;
    zoomScene.children = new Proxy(rawChildren as never, {
      get(target, prop, receiver) {
        if (typeof prop === 'string' && prop !== 'length') {
          childElementReads += 1;
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    zoomCanvas.scene = zoomScene;

    const host = new PageBridgeRuntimeHost(
      'scale_100k_zoom_parent_walk_token_999999',
      window as never,
      document
    );
    const internal = host as unknown as {
      preRenderEnhancer: Cvat3dPreRenderEnhancer;
      resolveActiveCuboid: (allowReduxFallback?: boolean) => unknown;
    };

    const setListenerSpy = vi.spyOn(internal.preRenderEnhancer, 'setCanvasRenderListener');
    vi.spyOn(internal, 'resolveActiveCuboid').mockReturnValue({
      clientID: 99_999,
      entry: {
        data: { clientID: 99_999, points: [0, 0, 0, 0, 0, 0, 4, 2, 1.6] },
        cuboid: { side: activeSideMesh },
      },
      state: null,
    });

    const stop = host.start();
    try {
      const renderListener = setListenerSpy.mock.calls[0]![0]!;
      const cam = createOrthoCamera();
      childElementReads = 0;

      const startMs = performance.now();
      for (let i = 0; i < 60; i += 1) {
        renderListener(zoomCanvas, cam, zoomScene);
      }
      const elapsedMs = performance.now() - startMs;

      // Parent chain walk hits zoomScene directly without reading zoomScene.children elements
      expect(childElementReads).toBe(0);
      expect(elapsedMs).toBeLessThan(25);
    } finally {
      stop();
    }
  });

  it('2. reads 0 Redux clientID getters on 60fps Ortho renders and caches filtered-out active misses across 50 events', () => {
    vi.useFakeTimers();
    const FILTERED_STATES_COUNT = 99_980; // 100,000 dataset with 20 filtered-out cuboids including active ID
    const FILTERED_OUT_ACTIVE_ID = 42_001;

    let clientIdGetterReads = 0;
    const states: CvatObjectStateLike[] = new Array<CvatObjectStateLike>(FILTERED_STATES_COUNT);
    for (let i = 0; i < FILTERED_STATES_COUNT; i += 1) {
      // All visible IDs are even -> odd ACTIVE_ID (42_001) is guaranteed to miss
      const id = i * 2;
      states[i] = {
        frame: 10,
        shapeType: 'cuboid',
        get clientID(): number {
          clientIdGetterReads += 1;
          return id;
        },
      };
    }

    const perspScene = createMockScene();
    const topScene = createMockScene();
    const sideScene = createMockScene();
    const frontScene = createMockScene();

    const perspCanvas = document.querySelector<HTMLCanvasElement>(
      '.cvat-canvas3d-perspective canvas'
    )!;
    const topCanvas = document.querySelector<HTMLCanvasElement>('.cvat-canvas3d-topview canvas')!;
    const sideCanvas = document.querySelector<HTMLCanvasElement>('.cvat-canvas3d-sideview canvas')!;
    const frontCanvas = document.querySelector<HTMLCanvasElement>(
      '.cvat-canvas3d-frontview canvas'
    )!;
    mockCanvasRect(topCanvas);
    mockCanvasRect(sideCanvas);
    mockCanvasRect(frontCanvas);

    const canvasInstance: CvatInternalCanvas3dLike = {
      view: {
        views: {
          perspective: { scene: perspScene, renderer: { domElement: perspCanvas } },
          top: { scene: topScene, renderer: { domElement: topCanvas } },
          side: { scene: sideScene, renderer: { domElement: sideCanvas } },
          front: { scene: frontScene, renderer: { domElement: frontCanvas } },
        },
        drawnObjects: {}, // Active object is filtered out of drawnObjects (`entry === null`)
      },
      model: { data: { imageID: 10 } },
    };

    const mockStore = {
      getState: () => ({
        annotation: {
          player: { frame: { number: 10 } },
          annotations: {
            activatedStateID: FILTERED_OUT_ACTIVE_ID,
            states,
          },
          canvas: { instance: canvasInstance },
        },
      }),
      dispatch: vi.fn(),
    };

    Object.defineProperty(window, 'cvatUI', {
      configurable: true,
      writable: true,
      value: {
        registerComponent: (
          cb: (args: { store: typeof mockStore }) => { name: string; destructor: () => void }
        ) => {
          cb({ store: mockStore });
        },
      },
    });

    const host = new PageBridgeRuntimeHost(
      'scale_100k_filtered_active_token_999999',
      window as never,
      document
    );
    const internal = host as unknown as {
      preRenderEnhancer: Cvat3dPreRenderEnhancer;
      handleGlobalStateUpdate: () => void;
      resolveActiveCuboid: (allowReduxFallback?: boolean) => {
        clientID: number;
        entry: CvatDrawnObjectEntry | null;
        state: CvatObjectStateLike | null;
      } | null;
    };

    // Before start(), verify 60 frames of Ortho rendering (`resolveActiveCuboid(false)`) read 0 Redux getters
    const setListenerSpy = vi.spyOn(internal.preRenderEnhancer, 'setCanvasRenderListener');

    const stop = host.start();
    try {
      const renderListener = setListenerSpy.mock.calls[0]![0]!;
      const orthoCam = createOrthoCamera();

      clientIdGetterReads = 0;
      for (let frameIdx = 0; frameIdx < 60; frameIdx += 1) {
        renderListener(topCanvas, orthoCam, topScene);
        renderListener(sideCanvas, orthoCam, sideScene);
        renderListener(frontCanvas, orthoCam, frontScene);
      }
      // Hot render path MUST read 0 Redux Proxy getters!
      expect(clientIdGetterReads).toBe(0);

      // Measure the first Redux-fallback miss vs 50 subsequent events
      clientIdGetterReads = 0;
      internal.resolveActiveCuboid(true);
      // First miss builds WeakMap<states, Map> once (<= 17 binary search + 99,980 items <= 100,000)
      expect(clientIdGetterReads).toBeGreaterThan(0);
      expect(clientIdGetterReads).toBeLessThanOrEqual(100_000);

      // Next 50 events (canvas.setup, active cuboid lookup, globalStateDidUpdate) MUST read 0 getters!
      clientIdGetterReads = 0;
      for (let ev = 0; ev < 50; ev += 1) {
        perspCanvas.dispatchEvent(new CustomEvent('canvas.setup'));
        internal.resolveActiveCuboid(true);
        internal.handleGlobalStateUpdate();
      }
      expect(clientIdGetterReads).toBe(0);
    } finally {
      stop();
      vi.useRealTimers();
    }
  });

  it('3. guards Filter input typing, .ant-select-dropdown portals, and 100 sidebar card mounts with 0 canvas queries and 0 rAF loops', async () => {
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      frames.push(cb);
      return frames.length;
    });

    const flushRaf = async (): Promise<void> => {
      await Promise.resolve();
      const batch = frames.splice(0);
      for (const cb of batch) {
        cb(0);
      }
      await Promise.resolve();
    };

    let sidebarCanvasQueryReads = 0;
    const origElementQuerySelector = Element.prototype.querySelector;
    vi.spyOn(Element.prototype, 'querySelector').mockImplementation(function (
      this: Element,
      selectors: string
    ) {
      if (
        selectors.includes('canvas') &&
        (this.classList.contains('cvat-objects-sidebar-state-item') ||
          this.classList.contains('cvat-objects-sidebar') ||
          Boolean(this.closest?.('.cvat-objects-sidebar')))
      ) {
        sidebarCanvasQueryReads += 1;
      }
      return origElementQuerySelector.call(this, selectors);
    });

    const host = new PageBridgeRuntimeHost(
      'scale_100k_filter_and_sidebar_guard_token_999999',
      window as never,
      document
    );
    const internal = host as unknown as {
      tryMountObjectItemDimensionSyncControls: (cards?: Iterable<HTMLElement> | null) => void;
    };

    const stop = host.start();
    try {
      await flushRaf();
      expect(frames).toHaveLength(0);

      const mountControlsSpy = vi.spyOn(internal, 'tryMountObjectItemDimensionSyncControls');
      sidebarCanvasQueryReads = 0;

      // Part A: Type 20 keys in CVAT Filter input + mount & mutate .ant-select-dropdown on document.body
      const filterInput = document.getElementById('cvat-filter-box') as HTMLInputElement;
      const dropdown = document.createElement('div');
      dropdown.className = 'ant-select-dropdown';
      document.body.appendChild(dropdown);

      for (let k = 0; k < 20; k += 1) {
        filterInput.value = `label=="vehicles" #${k}`;
        filterInput.dispatchEvent(
          new KeyboardEvent('keyup', { key: String(k % 10), bubbles: true })
        );
        const opt = document.createElement('div');
        opt.className = 'ant-select-item';
        opt.textContent = `Option ${k}`;
        dropdown.appendChild(opt);
      }

      await flushRaf();

      expect(mountControlsSpy).not.toHaveBeenCalled();
      expect(sidebarCanvasQueryReads).toBe(0);
      expect(frames).toHaveLength(0);

      // Part B: Mount 100 .cvat-objects-sidebar-state-item cards into .cvat-objects-sidebar
      const sidebar = document.querySelector('.cvat-objects-sidebar')!;
      const frag = document.createDocumentFragment();
      for (let id = 1; id <= 100; id += 1) {
        const card = document.createElement('div');
        card.id = `cvat-objects-sidebar-state-item-${id}`;
        card.className = 'cvat-objects-sidebar-state-item';
        const typeSpan = document.createElement('span');
        typeSpan.className = 'cvat-objects-sidebar-state-item-object-type-text';
        typeSpan.textContent = 'CUBOID TRACK';
        card.appendChild(typeSpan);
        frag.appendChild(card);
      }

      sidebarCanvasQueryReads = 0;
      sidebar.appendChild(frag);

      // Flush exactly 1 rAF cycle
      await Promise.resolve();
      expect(frames).toHaveLength(1);
      const firstWave = frames.splice(0);
      for (const cb of firstWave) {
        cb(0);
      }
      await Promise.resolve();

      // Zero querySelector('canvas, ...') calls on any sidebar card
      expect(sidebarCanvasQueryReads).toBe(0);
      // All 100 cards mounted cleanly
      expect(sidebar.querySelectorAll('.cvat-3d-enhancer-dim-sync-row')).toHaveLength(100);
      // Must settle immediately without scheduling an infinite second rAF loop!
      expect(frames).toHaveLength(0);
    } finally {
      stop();
    }
  });

  it('4. preserves correctness across in-place drawnObjects mutations, filter unhide, and hidden-to-visible hover raycasts', async () => {
    const { BoxGeometry, Mesh, MeshBasicMaterial, Raycaster, Vector3 } = await import('three');
    const { getOrBuildSpatial2DBoxLookup } =
      await import('../../src/integration/cvat/runtime/state-lookup');
    const { Cvat3dPreRenderEnhancer: EnhancerCtor } =
      await import('../../src/integration/cvat/runtime/pre-render-enhancer');
    const { deferHiddenCuboidMeshUpdates } =
      await import('../../src/integration/cvat/runtime/hidden-orientation-arrows');
    const { lockRaycasterHoverToActiveObject } =
      await import('../../src/integration/cvat/runtime/hover-lock');

    // A) In-place mutation of `drawnObjects` across frames refreshes 2D spatial lookup automatically
    const mutableDrawn: Record<number, CvatDrawnObjectEntry> = {
      1: {
        cuboid: {},
        data: {
          clientID: 1,
          points: [10, 0, 0, 0, 0, 0, 4, 2, 1.6],
          hidden: false,
          outside: false,
        },
      },
      2: {
        cuboid: {},
        data: {
          clientID: 2,
          points: [11, 0, 0, 0, 0, 0, 4, 2, 1.6],
          hidden: false,
          outside: false,
        },
      },
    };
    const lookupFrame0 = getOrBuildSpatial2DBoxLookup(mutableDrawn);
    let hitsAt10 = 0;
    lookupFrame0.forEachNeighbor(10, 0, 3, () => {
      hitsAt10 += 1;
    });
    expect(hitsAt10).toBe(2);

    // Mutate same object reference in-place to Frame 1 coordinates (shifted +40m)
    mutableDrawn[1] = {
      cuboid: {},
      data: { clientID: 1, points: [50, 0, 0, 0, 0, 0, 4, 2, 1.6], hidden: false, outside: false },
    };
    mutableDrawn[2] = {
      cuboid: {},
      data: { clientID: 2, points: [51, 0, 0, 0, 0, 0, 4, 2, 1.6], hidden: false, outside: false },
    };
    const lookupFrame1 = getOrBuildSpatial2DBoxLookup(mutableDrawn);
    let hitsAt50 = 0;
    lookupFrame1.forEachNeighbor(50, 0, 3, () => {
      hitsAt50 += 1;
    });
    expect(hitsAt50).toBe(2);

    // B) Filter -> Clear Filter recreating cuboids 1..99 while cuboid 100 stays in `drawnObjects`
    const enhancer = new EnhancerCtor();
    const filterMap: Record<number, CvatDrawnObjectEntry> = {};
    for (let id = 1; id <= 100; id += 1) {
      filterMap[id] = {
        data: { clientID: id, points: [0, 0, 0, 0, 0, 0, 4, 2, 1.6] },
        cuboid: {
          perspective: {
            material: { color: { r: 1, g: 1, b: 1, set: vi.fn() }, depthWrite: true },
          },
        },
      };
    }
    const mockCanvas: CvatInternalCanvas3dLike = {
      view: {
        views: {
          perspective: {
            scene: {
              background: null,
              children: [
                {
                  type: 'Points',
                  geometry: {
                    attributes: {
                      position: { array: new Float32Array([0, 0, 0]) },
                      color: { array: new Float32Array([1, 1, 1]) },
                    },
                  },
                  material: { size: 0.05, color: { r: 1, g: 1, b: 1, set: vi.fn() } },
                },
              ],
            },
          },
        },
        drawnObjects: filterMap,
        notify: vi.fn(),
      },
    };
    enhancer.ensureHooked(mockCanvas);
    for (let id = 1; id <= 99; id += 1) {
      delete filterMap[id];
    }
    mockCanvas.view!.notify!({}, 'objects_updated');
    // Un-filter recreates fresh cuboid meshes 1..99 with depthWrite: true
    for (let id = 1; id <= 99; id += 1) {
      filterMap[id] = {
        data: { clientID: id, points: [0, 0, 0, 0, 0, 0, 4, 2, 1.6] },
        cuboid: {
          perspective: {
            material: { color: { r: 1, g: 1, b: 1, set: vi.fn() }, depthWrite: true },
          },
        },
      };
    }
    mockCanvas.view!.notify!({}, 'objects_updated');
    expect(filterMap[50]!.cuboid.perspective!.material!.depthWrite).toBe(false);

    // C) Cuboid initially hidden (`visible = false` with deferred matrix at identity) then unhidden
    const boxGeom = new BoxGeometry(1, 1, 1);
    boxGeom.computeBoundingSphere();
    const boxMat = new MeshBasicMaterial();
    const meshes: InstanceType<typeof Mesh>[] = [];
    for (let i = 0; i < 300; i += 1) {
      const m = new Mesh(boxGeom, boxMat);
      m.name = String(i);
      m.position.set(i === 299 ? 35 : -50 - i, 0, 0);
      m.scale.set(4, 2, 1.6);
      if (i === 299) {
        // Hidden BEFORE matrixWorld was ever composed -> matrixWorld stays identity at (0,0,0)!
        m.visible = false;
        deferHiddenCuboidMeshUpdates(m);
      } else {
        m.updateMatrixWorld();
      }
      meshes.push(m);
    }

    const rc = new Raycaster(new Vector3(0, 0, 30), new Vector3(0, 0, -1));
    lockRaycasterHoverToActiveObject(
      rc,
      () => null,
      () => true
    );
    // Build HoverSpatialSoA while mesh #299 is still hidden at (35, 0, 0) with stale identity matrixWorld
    rc.set(new Vector3(10, 0, 30), new Vector3(0, 0, -1));
    rc.intersectObjects(meshes, false);

    // Unhide mesh #299 and compose its world matrix (as Three.js render traversal does)
    const target299 = meshes[299]!;
    target299.visible = true;
    target299.updateMatrixWorld();

    rc.set(new Vector3(35, 0, 30), new Vector3(0, 0, -1));
    const hits299 = rc.intersectObjects(meshes, false);
    expect(hits299.some((h) => (h as { object?: { name?: string } }).object?.name === '299')).toBe(
      true
    );

    boxGeom.dispose();
    boxMat.dispose();
  });
});
