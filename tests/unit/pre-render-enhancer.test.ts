import { describe, expect, it, vi } from 'vitest';
import {
  type CvatInternalCanvas3dLike,
  Cvat3dPreRenderEnhancer,
  injectCvatWorkspaceSettingsControls,
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

  it('runs pre-render pass ONLY ONCE per frame/state change (dirty flag optimization) and colors points inside oriented cuboids', () => {
    // 2 points: point 0 at (1, 1, 1) inside cuboid, point 1 at (50, 50, 50) outside cuboid
    const positionArray = new Float32Array([1, 1, 1, 50, 50, 50]);
    const colorArray = new Float32Array([1, 1, 1, 1, 1, 1]);

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
          101: {
            data: {
              clientID: 101,
              labelColor: '#ff0000',
              // Center (0,0,0), Rotation (0,0,0), Scale (4,4,4) -> bounds [-2, 2]
              points: [0, 0, 0, 0, 0, 0, 4, 4, 4],
              hidden: false,
              outside: false,
            },
            cuboid: {
              perspective: {
                material: {
                  color: { r: 1, g: 0, b: 0, set: vi.fn() },
                },
              },
            },
          },
        },
        render: origRenderSpy,
      },
    };

    const enhancer = new Cvat3dPreRenderEnhancer({
      whiteBackground: true,
      enableScattering: true,
      colorPointsByCuboid: true,
    });

    enhancer.ensureHooked(mockCanvas3d);

    // Point 0 (inside box #101) should be colored red (1, 0, 0)
    expect(colorArray[0]).toBeCloseTo(1, 3);
    expect(colorArray[1]).toBeCloseTo(0, 3);
    expect(colorArray[2]).toBeCloseTo(0, 3);

    // Point 1 (outside box, on white background) should be darkened to charcoal (0.12, 0.12, 0.12)
    expect(colorArray[3]).toBeCloseTo(0.12, 3);
    expect(colorArray[4]).toBeCloseTo(0.12, 3);
    expect(colorArray[5]).toBeCloseTo(0.12, 3);

    // Scattering applied to material
    expect(pointsObj.material.size).toBe(0.025);
    expect(pointsObj.material.transparent).toBe(true);
    expect(bgSetSpy).toHaveBeenCalledWith(0xffffff);

    // Clear spy and simulate 60fps render() calls without frame/object changes
    bgSetSpy.mockClear();
    mockCanvas3d.view!.render!();
    mockCanvas3d.view!.render!();
    mockCanvas3d.view!.render!();

    // Pre-render pass MUST NOT re-execute on subsequent 60fps frames when not dirty
    expect(bgSetSpy).not.toHaveBeenCalled();
    expect(origRenderSpy).toHaveBeenCalledTimes(3);
  });
});
