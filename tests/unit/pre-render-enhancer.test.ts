import { describe, expect, it, vi } from 'vitest';
import {
  type CvatInternalCanvas3dLike,
  type CvatObjectStateLike,
  clearCuboidPointColorCache,
  computeHueSeparationDegrees,
  computePerceptualColorDistance,
  computeWcagContrastRatio,
  Cvat3dPreRenderEnhancer,
  getDistinctCuboidColor,
  injectCvatObjectDimensionSyncControls,
  injectCvatWorkspaceSettingsControls,
  OVERLAP_RGB_WHITE_BG,
  parseHexColorToNormalizedRgb,
  readRenderOptionsFromClientSettings,
  syncTrackCuboidDimension,
  writeRenderOptionsToClientSettings,
} from '../../src/integration/cvat/runtime/pre-render-enhancer';

describe('Cvat3dPreRenderEnhancer & Native Workspace Settings Integration', () => {
  it('persists options inside CVAT native localStorage["clientSettings"].workspace.cvat3dEnhancer without losing existing settings', () => {
    window.localStorage.setItem(
      'clientSettings',
      JSON.stringify({
        player: { frameStep: 10 },
        workspace: { autoSave: true, focusedObjectPadding: 50 },
      })
    );

    writeRenderOptionsToClientSettings({
      whiteBackground: true,
      enableScattering: true,
      colorPointsByCuboid: false,
    });

    const raw = JSON.parse(window.localStorage.getItem('clientSettings') ?? '{}') as Record<
      string,
      Record<string, unknown>
    >;
    expect(raw.player?.frameStep).toBe(10);
    expect(raw.workspace?.autoSave).toBe(true);

    const readBack = readRenderOptionsFromClientSettings();
    expect(readBack).toEqual({
      whiteBackground: true,
      enableScattering: true,
      colorPointsByCuboid: false,
      fixedOrthoPointSize: true,
    });
  });

  it('restores enhancer options even after CVAT SettingsModal overwrites clientSettings without cvat3dEnhancer', () => {
    window.localStorage.clear();
    writeRenderOptionsToClientSettings({
      whiteBackground: true,
      enableScattering: false,
      colorPointsByCuboid: true,
      fixedOrthoPointSize: false,
    });

    // Simulate CVAT saving its own Redux settings snapshot (drops our key)
    window.localStorage.setItem(
      'clientSettings',
      JSON.stringify({ player: { frameStep: 5 }, workspace: { autoSave: false } })
    );

    const restored = readRenderOptionsFromClientSettings();
    expect(restored).toEqual({
      whiteBackground: true,
      enableScattering: false,
      colorPointsByCuboid: true,
      fixedOrthoPointSize: false,
    });

    // clientSettings must be healed while keeping CVAT's own values
    const healed = JSON.parse(window.localStorage.getItem('clientSettings') ?? '{}') as {
      player?: { frameStep?: number };
      workspace?: { autoSave?: boolean; cvat3dEnhancer?: { colorPointsByCuboid?: boolean } };
    };
    expect(healed.player?.frameStep).toBe(5);
    expect(healed.workspace?.autoSave).toBe(false);
    expect(healed.workspace?.cvat3dEnhancer?.colorPointsByCuboid).toBe(true);
  });

  it('injects native checkboxes into .cvat-workspace-settings and triggers callback on tick', () => {
    document.body.innerHTML = `<div class="cvat-workspace-settings"></div>`;
    let current = {
      whiteBackground: false,
      enableScattering: false,
      colorPointsByCuboid: false,
    };
    const onChangeSpy = vi.fn((next) => {
      current = next;
    });

    const mounted = injectCvatWorkspaceSettingsControls(document, () => current, onChangeSpy);
    expect(mounted).toBe(true);

    const boxCheckbox = document.querySelector<HTMLInputElement>(
      'input[data-enhancer-opt="colorPointsByCuboid"]'
    );
    expect(boxCheckbox).not.toBeNull();
    boxCheckbox!.checked = true;
    boxCheckbox!.dispatchEvent(new Event('change'));

    expect(onChangeSpy).toHaveBeenCalledWith({
      whiteBackground: false,
      enableScattering: false,
      colorPointsByCuboid: true,
    });
  });

  it('colors each cuboid distinctly, assigns a 3rd overlap color for overlapping boxes, uses 100% black/white when scattering is off, and freezes colors during box drag until frame change', () => {
    // 4 points:
    // - point 0 at (-2, 0, 0): inside Box #1 only
    // - point 1 at (2, 0, 0): inside Box #2 only
    // - point 2 at (0, 0, 0): inside BOTH Box #1 and Box #2 (overlap!)
    // - point 3 at (50, 50, 50): outside all boxes
    const positionArray = new Float32Array([-2, 0, 0, 2, 0, 0, 0, 0, 0, 50, 50, 50]);
    const colorArray = new Float32Array([1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1]);

    const pointsObj = {
      type: 'Points',
      geometry: {
        attributes: {
          position: { array: positionArray, needsUpdate: false },
          color: { array: colorArray, needsUpdate: false },
        },
      },
      material: {
        size: 0.05,
        sizeAttenuation: true,
        transparent: false,
        opacity: 1,
        color: { r: 1, g: 1, b: 1, set: vi.fn() },
        needsUpdate: false,
      },
    };

    const bgSetSpy = vi.fn();
    const origRenderSpy = vi.fn();
    const origNotifySpy = vi.fn();

    const box1SetColorSpy = vi.fn();
    const box2SetColorSpy = vi.fn();
    const box1MatColorSetSpy = vi.fn();
    const box2MatColorSetSpy = vi.fn();

    const mockCanvas3d: CvatInternalCanvas3dLike = {
      model: {
        data: {
          imageID: 1,
          configuration: { colorBy: 'Label' },
        },
      },
      view: {
        views: {
          perspective: {
            scene: {
              background: { r: 0, g: 0, b: 0, set: bgSetSpy },
              children: [pointsObj],
            },
          },
        },
        drawnObjects: {
          1: {
            data: {
              clientID: 1,
              labelColor: '#ff0000',
              // Box #1 centered at (-1, 0, 0), size (4, 4, 4) -> X in [-3, 1]
              points: [-1, 0, 0, 0, 0, 0, 4, 4, 4],
              hidden: false,
              outside: false,
            },
            cuboid: {
              setColor: box1SetColorSpy,
              perspective: {
                material: {
                  color: { r: 1, g: 0, b: 0, set: box1MatColorSetSpy },
                },
              },
            },
          },
          2: {
            data: {
              clientID: 2,
              labelColor: '#ff0000',
              // Box #2 centered at (1, 0, 0), size (4, 4, 4) -> X in [-1, 3]
              points: [1, 0, 0, 0, 0, 0, 4, 4, 4],
              hidden: false,
              outside: false,
            },
            cuboid: {
              setColor: box2SetColorSpy,
              perspective: {
                material: {
                  color: { r: 1, g: 0, b: 0, set: box2MatColorSetSpy },
                },
              },
            },
          },
        },
        notify: origNotifySpy,
        render: origRenderSpy,
      },
    };

    const enhancer = new Cvat3dPreRenderEnhancer({
      whiteBackground: true,
      enableScattering: false,
      colorPointsByCuboid: true,
    });

    enhancer.ensureHooked(mockCanvas3d);

    const expectedBox1 = getDistinctCuboidColor(1, 0, true, '#ff0000');
    const expectedBox2 = getDistinctCuboidColor(2, 1, true, '#ff0000');

    // Cuboid boxes themselves must NOT be touched at all by enhancer (neither setColor nor material.color.set)
    expect(box1SetColorSpy).not.toHaveBeenCalled();
    expect(box2SetColorSpy).not.toHaveBeenCalled();
    expect(box1MatColorSetSpy).not.toHaveBeenCalled();
    expect(box2MatColorSetSpy).not.toHaveBeenCalled();

    // Box #1 and Box #2 must have distinct colors even though both share the same labelColor
    expect(expectedBox1).not.toEqual(expectedBox2);

    // Point 0 (inside Box #1 only) -> Box #1 distinct color
    expect(colorArray[0]).toBeCloseTo(expectedBox1[0], 3);
    expect(colorArray[1]).toBeCloseTo(expectedBox1[1], 3);
    expect(colorArray[2]).toBeCloseTo(expectedBox1[2], 3);

    // Point 1 (inside Box #2 only) -> Box #2 distinct color
    expect(colorArray[3]).toBeCloseTo(expectedBox2[0], 3);
    expect(colorArray[4]).toBeCloseTo(expectedBox2[1], 3);
    expect(colorArray[5]).toBeCloseTo(expectedBox2[2], 3);

    // Point 2 (inside BOTH Box #1 and Box #2) -> 3rd overlap color (OVERLAP_RGB_WHITE_BG)
    expect(colorArray[6]).toBeCloseTo(OVERLAP_RGB_WHITE_BG[0], 3);
    expect(colorArray[7]).toBeCloseTo(OVERLAP_RGB_WHITE_BG[1], 3);
    expect(colorArray[8]).toBeCloseTo(OVERLAP_RGB_WHITE_BG[2], 3);

    // Point 3 (outside all boxes, scattering OFF on white background) -> 100% pure Black (0, 0, 0)
    expect(colorArray[9]).toBeCloseTo(0, 3);
    expect(colorArray[10]).toBeCloseTo(0, 3);
    expect(colorArray[11]).toBeCloseTo(0, 3);

    // Simulate dragging Box #1 to wrap Point 3 (50, 50, 50) on the SAME frame (imageID = 1)
    mockCanvas3d.view!.drawnObjects![1]!.data.points = [50, 50, 50, 0, 0, 0, 4, 4, 4];
    mockCanvas3d.view!.notify!(mockCanvas3d.model, 'objects_updated');
    mockCanvas3d.view!.render!();
    // Even if a DOM canvas/zoom structure change fires mid-drag (`markViewStructureChanged`),
    // dragged box positions must still remain frozen until Next/Prev frame!
    enhancer.markViewStructureChanged();
    mockCanvas3d.view!.render!();

    // Point 3 MUST NOT change color while dragging on the same frame
    expect(colorArray[9]).toBeCloseTo(0, 3);
    // And Perspective points.material.size MUST stay 0.05 (never turn into 2.5px when renderer.domElement is omitted)
    const perspScn = mockCanvas3d.view!.views!.perspective!.scene!;
    (pointsObj as { onBeforeRender?: (...args: unknown[]) => void }).onBeforeRender?.(
      {},
      perspScn,
      { isPerspectiveCamera: true, type: 'PerspectiveCamera' },
      pointsObj.geometry,
      pointsObj.material
    );
    expect(pointsObj.material.size).toBe(0.05);
    expect(pointsObj.material.sizeAttenuation).toBe(true);

    // Now simulate Next Frame -> Prev Frame (image_changed + initial objects_updated)
    mockCanvas3d.view!.notify!(mockCanvas3d.model, 'image_changed');
    mockCanvas3d.view!.notify!(mockCanvas3d.model, 'objects_updated');

    // After frame reload, Point 3 (now inside Box #1) updates to Box #1's color
    expect(colorArray[9]).toBeCloseTo(expectedBox1[0], 3);
    expect(colorArray[10]).toBeCloseTo(expectedBox1[1], 3);
    expect(colorArray[11]).toBeCloseTo(expectedBox1[2], 3);
  });

  it('applies white background immediately on frame 0 even before PCD point cloud finishes loading (zero black flash)', () => {
    const bgSetSpy = vi.fn();
    const setClearColorSpy = vi.fn();

    const emptyFrame0Canvas3d: CvatInternalCanvas3dLike = {
      model: {
        data: {
          imageID: 0,
        },
      },
      view: {
        views: {
          perspective: {
            scene: {
              background: { r: 0, g: 0, b: 0, set: bgSetSpy },
              children: [], // Point cloud not yet loaded (async PCD arrayBuffer pending)
            },
            renderer: {
              setClearColor: setClearColorSpy,
            },
          },
        },
        drawnObjects: {},
      },
    };

    const enhancer = new Cvat3dPreRenderEnhancer({
      whiteBackground: true,
      enableScattering: false,
      colorPointsByCuboid: false,
    });

    enhancer.ensureHooked(emptyFrame0Canvas3d);

    // Must set background to 0xffffff immediately before PCD finishes loading
    expect(bgSetSpy).toHaveBeenCalledWith(0xffffff);
    expect(setClearColorSpy).toHaveBeenCalledWith(0xffffff, 1);
  });

  it('defaults Top/Side/Front orthographic views to fixed 3.5px point size and reverts to CVAT 0.5px when unchecked', () => {
    const perspPoints = {
      type: 'Points',
      geometry: {
        attributes: {
          position: { array: new Float32Array([0, 0, 0]) },
          color: { array: new Float32Array([1, 1, 1]) },
        },
      },
      material: {
        size: 0.05,
        sizeAttenuation: true,
        color: { r: 1, g: 1, b: 1, set: vi.fn() },
      },
    };
    const topPoints = {
      type: 'Points',
      geometry: {
        attributes: {
          position: { array: new Float32Array([0, 0, 0]) },
          color: { array: new Float32Array([1, 1, 1]) },
        },
      },
      material: {
        size: 0.5,
        sizeAttenuation: true,
        color: { r: 1, g: 1, b: 1, set: vi.fn() },
      },
    };

    const canvas3d: CvatInternalCanvas3dLike = {
      view: {
        views: {
          perspective: {
            scene: { background: null, children: [perspPoints] },
          },
          top: {
            scene: { background: null, children: [topPoints] },
          },
        },
        drawnObjects: {},
      },
    };

    const enhancer = new Cvat3dPreRenderEnhancer();
    enhancer.ensureHooked(canvas3d);

    // By default (fixedOrthoPointSize: true), orthographic view point size is fixed at 3.5px
    expect(topPoints.material.size).toBe(3.5);
    expect(topPoints.material.sizeAttenuation).toBe(false);
    expect(perspPoints.material.size).toBe(0.05);

    // When turned OFF (fixedOrthoPointSize: false), reverts to CVAT native 0.5px
    enhancer.setOptions(
      {
        whiteBackground: false,
        enableScattering: false,
        colorPointsByCuboid: false,
        fixedOrthoPointSize: false,
      },
      canvas3d
    );
    expect(topPoints.material.size).toBe(0.5);
    expect(topPoints.material.sizeAttenuation).toBe(true);
  });

  it('keeps PointsMaterial opaque (transparent = false) and disables cuboid depthWrite when scattering is enabled so active boxes never hide internal points', () => {
    const perspPoints = {
      type: 'Points',
      geometry: {
        attributes: {
          position: { array: new Float32Array([0, 0, 0]) },
          color: { array: new Float32Array([1, 1, 1]) },
        },
      },
      material: {
        size: 0.05,
        sizeAttenuation: true,
        transparent: true,
        opacity: 0.82,
        color: { r: 1, g: 1, b: 1, set: vi.fn() },
      },
    };
    const activeCuboidPerspectiveMat = { depthWrite: true };
    const activeCuboidTopMat = { depthWrite: true };

    const canvas3d: CvatInternalCanvas3dLike = {
      view: {
        views: {
          perspective: {
            scene: { background: null, children: [perspPoints] },
          },
        },
        drawnObjects: {
          1: {
            data: {
              clientID: 1,
              points: [0, 0, 0, 0, 0, 0, 4, 4, 4],
            },
            cuboid: {
              perspective: { material: activeCuboidPerspectiveMat },
              top: { material: activeCuboidTopMat },
            },
          },
        },
      },
    };

    const enhancer = new Cvat3dPreRenderEnhancer({
      whiteBackground: true,
      enableScattering: true,
      colorPointsByCuboid: true,
    });
    enhancer.ensureHooked(canvas3d);

    expect(perspPoints.material.transparent).toBe(false);
    expect(perspPoints.material.opacity).toBe(1.0);
    expect(activeCuboidPerspectiveMat.depthWrite).toBe(false);
    expect(activeCuboidTopMat.depthWrite).toBe(false);
  });

  it('applies 3.5px fixed point size to newly opened zoomed Top/Side/Front canvases (both via views and via THREE.Points.prototype.onBeforeRender)', () => {
    class MockThreePoints {
      public type = 'Points';
      public geometry = {
        attributes: {
          position: { array: new Float32Array([0, 0, 0]) },
          color: { array: new Float32Array([1, 1, 1]) },
        },
      };
      public material = {
        size: 0.5,
        sizeAttenuation: true,
        transparent: false,
        opacity: 1,
        color: { r: 1, g: 1, b: 1, set: vi.fn() },
        clone() {
          return { ...this };
        },
      };
      public onBeforeRender(..._args: unknown[]): void {
        void _args;
      }
    }

    const perspPoints = new MockThreePoints();
    perspPoints.material.size = 0.05;
    const perspCanvas = document.createElement('canvas');
    const perspScene = { background: null, children: [perspPoints] };

    const canvas3d: CvatInternalCanvas3dLike = {
      model: { data: { imageID: 5 } },
      view: {
        views: {
          perspective: {
            scene: perspScene,
            renderer: { domElement: perspCanvas },
          },
        },
        drawnObjects: {},
      },
    };

    const enhancer = new Cvat3dPreRenderEnhancer({
      whiteBackground: true,
      enableScattering: false,
      colorPointsByCuboid: false,
      fixedOrthoPointSize: true,
    });
    enhancer.ensureHooked(canvas3d);
    expect(perspPoints.material.size).toBe(0.05);

    // 1. Simulate pressing zoom key on Top/Side/Front which opens a new standalone zoom canvas
    // with its own MockThreePoints instance (not even registered in view.views)
    const zoomPointsStandalone = new MockThreePoints();
    zoomPointsStandalone.material.size = 0.5;
    const zoomCanvas = document.createElement('canvas');
    const zoomScene = { background: null, children: [zoomPointsStandalone] };
    const orthoCamera = { isOrthographicCamera: true, type: 'OrthographicCamera' };

    // When WebGLRenderer renders zoomPointsStandalone, Three.js invokes onBeforeRender
    zoomPointsStandalone.onBeforeRender(
      { domElement: zoomCanvas },
      zoomScene,
      orthoCamera,
      zoomPointsStandalone.geometry,
      zoomPointsStandalone.material
    );

    expect(zoomPointsStandalone.material.size).toBe(3.5);
    expect(zoomPointsStandalone.material.sizeAttenuation).toBe(false);

    // 2. Also simulate a zoom canvas mounted into view.views['ortho_zoom_0'] on the same frame
    const zoomPointsInViews = new MockThreePoints();
    zoomPointsInViews.material.size = 0.5;
    canvas3d.view!.views!['ortho_zoom_0'] = {
      scene: { background: null, children: [zoomPointsInViews] },
      renderer: { domElement: zoomCanvas },
    };
    enhancer.ensureHooked(canvas3d);

    expect(zoomPointsInViews.material.size).toBe(3.5);
    expect(zoomPointsInViews.material.sizeAttenuation).toBe(false);
  });

  it('injects H, W, L dimension sync icons into CVAT object item sidebar and syncs dimensions ONLY to frames with 100% identical attributes', async () => {
    document.body.innerHTML = `
      <div id="cvat-objects-sidebar-state-item-1" class="cvat-objects-sidebar-state-item">
        <div class="ant-row ant-row-space-around ant-row-middle css-n0gjrg">
          <div class="ant-col ant-col-20 css-n0gjrg" style="text-align: center;">
            <div class="ant-row ant-row-space-around css-n0gjrg">
              <div class="ant-col css-n0gjrg"><span role="img" class="anticon cvat-object-item-button-first-keyframe"></span></div>
              <div class="ant-col css-n0gjrg"><span role="img" class="anticon cvat-object-item-button-prev-keyframe"></span></div>
              <div class="ant-col css-n0gjrg"><span role="img" class="anticon cvat-object-item-button-next-keyframe"></span></div>
              <div class="ant-col css-n0gjrg"><span role="img" class="anticon cvat-object-item-button-last-keyframe"></span></div>
            </div>
            <div class="ant-row ant-row-space-around css-n0gjrg">
              <div class="ant-col css-n0gjrg"><span role="img" class="anticon cvat-object-item-button-outside"></span></div>
              <div class="ant-col css-n0gjrg"><span role="img" class="anticon cvat-object-item-button-lock"></span></div>
            </div>
          </div>
        </div>
      </div>
    `;

    // Track #1 keyframes:
    // - Frame 0: attributes { 10: 'car', 20: 'moving' }, points [0,0,0, 0,0,0, 4.0, 1.8, 1.5]
    // - Frame 5 (current): attributes { 10: 'car', 20: 'moving' }, points [1,2,3, 0,0,0, 4.8, 2.1, 1.75]
    // - Frame 10: attributes { 10: 'car', 20: 'parked' } (MISMATCH!), points [2,3,4, 0,0,0, 4.0, 1.8, 1.5]
    // - Frame 15: attributes { 10: 'car', 20: 'moving' }, points [3,4,5, 0,0,0, 4.1, 1.9, 1.6]
    const trackShapes: Record<
      number,
      { points: number[]; attributes: Record<number, string> }
    > = {
      0: { points: [0, 0, 0, 0, 0, 0, 4.0, 1.8, 1.5], attributes: { 10: 'car', 20: 'moving' } },
      5: { points: [1, 2, 3, 0, 0, 0, 4.8, 2.1, 1.75], attributes: { 10: 'car', 20: 'moving' } },
      10: { points: [2, 3, 4, 0, 0, 0, 4.0, 1.8, 1.5], attributes: { 10: 'car', 20: 'parked' } },
      15: { points: [3, 4, 5, 0, 0, 0, 4.1, 1.9, 1.6], attributes: { 10: 'car', 20: 'moving' } },
    };

    const internalSave = vi.fn((frame: number, data: CvatObjectStateLike): CvatObjectStateLike => {
      const kf = trackShapes[frame]!;
      if (data.updateFlags?.points && Array.isArray(data.points)) {
        kf.points = [...data.points];
        data.updateFlags.points = false;
      }
      return {
        clientID: 1,
        frame,
        objectType: 'track',
        shapeType: 'cuboid',
        points: [...kf.points],
        attributes: { ...kf.attributes },
        updateFlags: {
          reset() {
            delete this.points;
          },
        },
        __internal: {
          save: internalSave,
          export: () => ({
            clientID: 1,
            frame: 0,
            shapes: Object.entries(trackShapes).map(([f, val]) => ({
              frame: Number(f),
              points: [...val.points],
            })),
          }),
        },
      };
    });

    const currentStateOnFrame5 = internalSave(5, { updateFlags: {} });
    const perspCanvas = document.createElement('canvas') as HTMLCanvasElement & {
      updatePosition?: (state: CvatObjectStateLike, points: number[]) => void;
    };
    const updatePositionSpy = vi.fn();
    perspCanvas.updatePosition = updatePositionSpy;

    const mountedCount = injectCvatObjectDimensionSyncControls(document, (id, dim) =>
      syncTrackCuboidDimension(id, dim, {
        stateOnCurrentFrame: currentStateOnFrame5,
        perspectiveCanvas: perspCanvas,
      })
    );
    expect(mountedCount).toBe(1);

    const syncHBtn = document.querySelector<HTMLElement>(
      '#cvat-objects-sidebar-state-item-1 [data-enhancer-sync-dim="H"]'
    );
    const syncWBtn = document.querySelector<HTMLElement>(
      '#cvat-objects-sidebar-state-item-1 [data-enhancer-sync-dim="W"]'
    );
    const syncLBtn = document.querySelector<HTMLElement>(
      '#cvat-objects-sidebar-state-item-1 [data-enhancer-sync-dim="L"]'
    );
    expect(syncHBtn).not.toBeNull();
    expect(syncWBtn).not.toBeNull();
    expect(syncLBtn).not.toBeNull();

    // 1. Click [H] -> syncs Height (index 8 = 1.75) to frames 0, 5, 15, but SKIPS frame 10 (different attribute!)
    syncHBtn!.click();
    await new Promise((r) => setTimeout(r, 10));

    expect(trackShapes[0]!.points[8]).toBeCloseTo(1.75, 4);
    expect(trackShapes[5]!.points[8]).toBeCloseTo(1.75, 4);
    expect(trackShapes[15]!.points[8]).toBeCloseTo(1.75, 4);
    // Frame 10 has attribute 20 = 'parked' != 'moving' -> MUST remain 1.5!
    expect(trackShapes[10]!.points[8]).toBeCloseTo(1.5, 4);
    // W and L on frame 0 must still be untouched (1.8 and 4.0) because only [H] was clicked
    expect(trackShapes[0]!.points[6]).toBeCloseTo(4.0, 4);
    expect(trackShapes[0]!.points[7]).toBeCloseTo(1.8, 4);
    expect(updatePositionSpy).toHaveBeenCalledTimes(1);

    // 2. Click [L] -> syncs Length (index 6 = 4.8) to frames 0, 5, 15, skipping frame 10
    syncLBtn!.click();
    await new Promise((r) => setTimeout(r, 10));

    expect(trackShapes[0]!.points[6]).toBeCloseTo(4.8, 4);
    expect(trackShapes[15]!.points[6]).toBeCloseTo(4.8, 4);
    expect(trackShapes[10]!.points[6]).toBeCloseTo(4.0, 4);
  });

  it('guarantees high contrast against both background and cuboid labelColor for internal box points and caches color per clientID across frames', () => {
    const labelColors = ['#0047c7', '#40ff73', '#ff0000', '#c794ff', '#ffd11a', '#008040'];

    for (const whiteBackground of [true, false]) {
      const bgRgb: readonly [number, number, number] = whiteBackground ? [1, 1, 1] : [0, 0, 0];
      for (const labelHex of labelColors) {
        clearCuboidPointColorCache();
        const labelRgb = parseHexColorToNormalizedRgb(labelHex);
        for (let id = 1; id <= 24; id += 1) {
          const pointRgb = getDistinctCuboidColor(id, id, whiteBackground, labelHex);
          const bgContrast = computeWcagContrastRatio(pointRgb, bgRgb);
          const boxDist = computePerceptualColorDistance(pointRgb, labelRgb);
          const hueDiff = computeHueSeparationDegrees(pointRgb, labelRgb);

          expect(bgContrast).toBeGreaterThanOrEqual(4.2);
          expect(boxDist).toBeGreaterThanOrEqual(0.5);
          expect(hueDiff).toBeGreaterThanOrEqual(65);

          // Subsequent lookups for the same clientID on later frames MUST return the exact cached color
          // even if fallbackIndex or transient labelColorHex differs
          const cachedOnNextFrame = getDistinctCuboidColor(id, id + 99, whiteBackground, undefined);
          expect(cachedOnNextFrame).toEqual(pointRgb);
        }
      }
    }
  });
});
