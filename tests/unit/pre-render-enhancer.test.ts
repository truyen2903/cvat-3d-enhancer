import { describe, expect, it, vi } from 'vitest';
import {
  type CvatInternalCanvas3dLike,
  Cvat3dPreRenderEnhancer,
  getDistinctCuboidColor,
  injectCvatWorkspaceSettingsControls,
  OVERLAP_RGB_WHITE_BG,
  readRenderOptionsFromClientSettings,
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
            cuboid: {},
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
            cuboid: {},
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

    const expectedBox1 = getDistinctCuboidColor(1, 0, true);
    const expectedBox2 = getDistinctCuboidColor(2, 1, true);

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

    // Point 3 MUST NOT change color while dragging on the same frame
    expect(colorArray[9]).toBeCloseTo(0, 3);

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

  it('defaults Top/Side/Front orthographic views to fixed 2.5px point size and reverts to CVAT 0.5px when unchecked', () => {
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

    // By default (fixedOrthoPointSize: true), orthographic view point size is fixed at 2.5px
    expect(topPoints.material.size).toBe(2.5);
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
});
