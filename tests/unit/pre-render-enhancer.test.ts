import { WORKSPACE_FEATURE_DEFAULTS } from '../../src/integration/cvat/runtime/workspace-feature-options';
import { describe, expect, it, vi } from 'vitest';
import {
  type Cvat3dWorkspaceRenderOptions,
  type CvatObjectStateLike,
  injectCvatObjectDimensionSyncControls,
  injectCvatWorkspaceSettingsControls,
  optimizeOrthographicRaycastPlanes,
  readRenderOptionsFromClientSettings,
  syncTrackCuboidDimension,
  writeRenderOptionsToClientSettings,
} from '../../src/integration/cvat/runtime/pre-render-enhancer';

describe('Cvat3dPreRenderEnhancer & Native Workspace Settings Integration', () => {
  it('persists options inside CVAT native localStorage["clientSettings"].workspace.cvat3dEnhancer without losing existing settings', () => {
    window.localStorage.clear();
    window.localStorage.setItem(
      'clientSettings',
      JSON.stringify({
        player: { frameStep: 10 },
        workspace: { autoSave: true, focusedObjectPadding: 50 },
      })
    );

    writeRenderOptionsToClientSettings({
      enableHeadingFlip: false,
      followActiveObject: false,
    });

    const raw = JSON.parse(window.localStorage.getItem('clientSettings') ?? '{}') as Record<
      string,
      Record<string, unknown>
    >;
    expect(raw.player?.frameStep).toBe(10);
    expect(raw.workspace?.autoSave).toBe(true);

    const readBack = readRenderOptionsFromClientSettings();
    expect(readBack).toEqual({
      ...WORKSPACE_FEATURE_DEFAULTS,
      enableHeadingFlip: false,
      followActiveObject: false,
    });
  });

  it('restores enhancer options even after CVAT SettingsModal overwrites clientSettings without cvat3dEnhancer', () => {
    window.localStorage.clear();
    writeRenderOptionsToClientSettings({ followActiveObject: false });

    // Simulate CVAT saving its own Redux settings snapshot (drops our key)
    window.localStorage.setItem(
      'clientSettings',
      JSON.stringify({ player: { frameStep: 5 }, workspace: { autoSave: false } })
    );

    const restored = readRenderOptionsFromClientSettings();
    expect(restored).toEqual({ ...WORKSPACE_FEATURE_DEFAULTS, followActiveObject: false });

    // clientSettings must be healed while keeping CVAT's own values
    const healed = JSON.parse(window.localStorage.getItem('clientSettings') ?? '{}') as {
      player?: { frameStep?: number };
      workspace?: { autoSave?: boolean; cvat3dEnhancer?: { followActiveObject?: boolean } };
    };
    expect(healed.player?.frameStep).toBe(5);
    expect(healed.workspace?.autoSave).toBe(false);
    expect(healed.workspace?.cvat3dEnhancer?.followActiveObject).toBe(false);
  });

  it('drops removed point cloud options from previously saved settings', () => {
    window.localStorage.clear();
    window.localStorage.setItem(
      'cvat3dEnhancerSettings',
      JSON.stringify({
        whiteBackground: true,
        enableScattering: true,
        colorPointsByCuboid: true,
        hideGroundPoints: true,
        fixedOrthoPointSize: false,
        enlargePerspectivePoints: false,
        enableActiveObjectWarnings: true,
        followActiveObject: false,
      })
    );

    const restored = readRenderOptionsFromClientSettings();
    expect(restored).toEqual({ ...WORKSPACE_FEATURE_DEFAULTS, followActiveObject: false });

    writeRenderOptionsToClientSettings(restored);
    const stored = JSON.parse(window.localStorage.getItem('clientSettings') ?? '{}') as {
      workspace?: { cvat3dEnhancer?: Record<string, unknown> };
    };
    expect(Object.keys(stored.workspace?.cvat3dEnhancer ?? {}).sort()).toEqual(
      Object.keys(restored).sort()
    );
  });

  it('injects native checkboxes into .cvat-workspace-settings and triggers callback on tick (both via input change and label click)', () => {
    document.body.innerHTML = `<div class="cvat-workspace-settings"><div class="ant-row css-n0gjrg"></div></div>`;
    let current: Cvat3dWorkspaceRenderOptions = { followActiveObject: true };
    const onChangeSpy = vi.fn((next: Cvat3dWorkspaceRenderOptions) => {
      current = next;
    });

    const mounted = injectCvatWorkspaceSettingsControls(document, () => current, onChangeSpy);
    expect(mounted).toBe(true);
    for (const removed of [
      'whiteBackground',
      'enableScattering',
      'colorPointsByCuboid',
      'hideGroundPoints',
      'fixedOrthoPointSize',
      'enlargePerspectivePoints',
      'enableActiveObjectWarnings',
    ]) {
      expect(document.querySelector(`input[data-enhancer-opt="${removed}"]`)).toBeNull();
    }

    const followCheckbox = document.querySelector<HTMLInputElement>(
      'input[data-enhancer-opt="followActiveObject"]'
    );
    expect(followCheckbox).not.toBeNull();
    expect(followCheckbox!.classList.contains('meow-workspace-input')).toBe(true);
    followCheckbox!.checked = false;
    followCheckbox!.dispatchEvent(new Event('change'));

    expect(onChangeSpy).toHaveBeenCalledWith({ followActiveObject: false });

    // Clicking on the label/inner span (not the raw input) must also toggle cleanly once
    const flipInput = document.querySelector<HTMLInputElement>(
      'input[data-enhancer-opt="enableHeadingFlip"]'
    );
    const flipLabel = flipInput?.closest('label');
    expect(flipLabel?.className).toContain('css-n0gjrg');
    expect(flipInput?.checked).toBe(true);
    flipLabel?.click();
    expect(flipInput?.checked).toBe(false);
    expect(current.enableHeadingFlip).toBe(false);
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
    const trackShapes: Record<number, { points: number[]; attributes: Record<number, string> }> = {
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
    const flip180Btn = document.querySelector<HTMLElement>(
      '#cvat-objects-sidebar-state-item-1 [data-enhancer-sync-dim="FLIP_180"]'
    );
    expect(syncHBtn).not.toBeNull();
    expect(syncWBtn).not.toBeNull();
    expect(syncLBtn).not.toBeNull();
    expect(flip180Btn).not.toBeNull();

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

    // 3. Click [FLIP_180] -> flips Yaw (index 5) by 180° (0 -> -Math.PI) on current frame 5 ONLY
    flip180Btn!.click();
    await new Promise((r) => setTimeout(r, 10));

    expect(Math.abs(trackShapes[5]!.points[5]!)).toBeCloseTo(Math.PI, 4);
    expect(trackShapes[0]!.points[5]).toBeCloseTo(0, 4);
    expect(trackShapes[15]!.points[5]).toBeCloseTo(0, 4);
  });

  it('simplifies subdivided orthographic raycast planes (sidePlane/topPlane/frontPlane) from 712x866 segments (1.23M triangles) to 1x1 segment (2 triangles)', () => {
    const disposeSpy = vi.fn();
    class MockPlaneGeometry {
      public parameters: {
        width: number;
        height: number;
        widthSegments: number;
        heightSegments: number;
      };
      public attributes: {
        position: { array: Float32Array; count: number };
      };
      public index: { array: Uint16Array; count: number };
      public dispose = disposeSpy;

      public constructor(w = 1, h = 1, ws = 1, hs = 1) {
        this.parameters = { width: w, height: h, widthSegments: ws, heightSegments: hs };
        const vertCount = (ws + 1) * (hs + 1);
        const idxCount = ws * hs * 6;
        this.attributes = {
          position: { array: new Float32Array(Math.min(vertCount * 3, 12)), count: vertCount },
        };
        this.index = { array: new Uint16Array(Math.min(idxCount, 6)), count: idxCount };
      }
    }

    const bloatedSidePlaneGeom = new MockPlaneGeometry(712, 866, 712, 866);
    const sidePlaneMesh = {
      type: 'Mesh',
      name: 'sidePlane',
      geometry: bloatedSidePlaneGeom,
    };
    const sideScene = {
      background: null,
      children: [sidePlaneMesh],
    };

    const optimizedPlanes = new WeakSet<object>();
    const count1 = optimizeOrthographicRaycastPlanes(sideScene, optimizedPlanes);
    expect(count1).toBe(1);
    expect(disposeSpy).toHaveBeenCalledTimes(1);
    expect(sidePlaneMesh.geometry.parameters.widthSegments).toBe(1);
    expect(sidePlaneMesh.geometry.parameters.heightSegments).toBe(1);
    expect(sidePlaneMesh.geometry.index.count).toBe(6);

    // Subsequent calls on the same plane mesh are a fast no-op
    const count2 = optimizeOrthographicRaycastPlanes(sideScene, optimizedPlanes);
    expect(count2).toBe(0);
  });
});
