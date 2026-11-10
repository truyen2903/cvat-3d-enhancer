import type {
  Cvat3dPreRenderEnhancer,
  CvatObjectStateLike,
  CvatInternalCanvas3dLike,
} from '../../src/integration/cvat/runtime/pre-render-enhancer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PageBridgeRuntimeHost } from '../../src/entrypoints/page-bridge';
import { PageBridge } from '../../src/integration/cvat/bridge';
import { VersionDetector } from '../../src/integration/cvat/compatibility';
import { CvatDomAdapter } from '../../src/integration/cvat/dom';
import { CapabilityRegistry, CvatV2RuntimeAdapter } from '../../src/integration/cvat/runtime';

describe('CVAT 3D Runtime & PageBridge Integration', () => {
  beforeEach(() => {
    window.localStorage.clear();
    document.body.innerHTML = `
      <div id="root">
        <div class="cvat-canvas3d-perspective">
          <div class="cvat-canvas-container">
            <canvas width="800" height="600"></canvas>
          </div>
        </div>
        <div class="cvat-canvas3d-orthographic-view cvat-canvas3d-topview"><canvas></canvas></div>
        <div class="cvat-canvas3d-orthographic-view cvat-canvas3d-sideview"><canvas></canvas></div>
        <div class="cvat-canvas3d-orthographic-view cvat-canvas3d-frontview"><canvas></canvas></div>
      </div>
    `;
  });

  it('uses fresh frame metadata when the DOM adapter replaces the model but reuses its view', () => {
    const host = new PageBridgeRuntimeHost(
      'follow_model_session_token_999999',
      window as never,
      document
    );
    const internal = host as unknown as {
      ensureActiveObjectHoverLock: (instance: CvatInternalCanvas3dLike) => void;
      getActiveObjectClientId: () => string | null;
    };
    vi.spyOn(internal, 'getActiveObjectClientId').mockReturnValue('5');
    const setLookAt = vi.fn();
    const view = {
      views: {
        perspective: {
          scene: { background: null, children: [] },
          camera: { position: { x: 10, y: 10, z: 10 } },
          controls: { getTarget: () => ({ x: 0, y: 0, z: 0 }), setLookAt },
        },
      },
      drawnObjects: {
        5: { data: { clientID: 5, frame: 10, points: [0, 0, 0, 0, 0, 0, 4, 2, 1] }, cuboid: {} },
      },
      render: vi.fn(),
    };
    internal.ensureActiveObjectHoverLock({ view, model: { data: { imageID: 10 } } });
    view.render();
    view.drawnObjects[5].data = { clientID: 5, frame: 11, points: [3, 0, 0, 0, 0, 0, 4, 2, 1] };
    internal.ensureActiveObjectHoverLock({ view, model: { data: { imageID: 11 } } });
    view.render();
    expect(setLookAt).toHaveBeenCalledWith(13, 10, 10, 3, 0, 0, false);
  });

  it('preserves focus and Workspace options when appearance settings change', () => {
    const host = new PageBridgeRuntimeHost(
      'focus_settings_session_token_999999',
      window as never,
      document
    );
    const internal = host as unknown as {
      preRenderEnhancer: Cvat3dPreRenderEnhancer;
      getActiveCanvas3dInstance: () => CvatInternalCanvas3dLike | null;
      applyCanvasVisualConfig: (config: { whiteBackground: boolean }) => void;
    };
    vi.spyOn(internal, 'getActiveCanvas3dInstance').mockReturnValue(null);
    internal.preRenderEnhancer.setOptions({
      ...internal.preRenderEnhancer.getOptions(),
      followActiveObject: false,
      disableSidebarQuickFilter: false,
      showCuboidBaseGuide: false,
      enableDimensionSync: false,
      enableOrthoKeyboard: false,
      hideGroundPoints: true,
    });
    internal.applyCanvasVisualConfig({ whiteBackground: true });
    expect(internal.preRenderEnhancer.getOptions()).toMatchObject({
      whiteBackground: true,
      followActiveObject: false,
      disableSidebarQuickFilter: false,
      showCuboidBaseGuide: false,
      enableDimensionSync: false,
      enableOrthoKeyboard: false,
      hideGroundPoints: true,
    });
  });

  it('redraws a key preview immediately without scheduling a full point-cloud recolor', () => {
    const host = new PageBridgeRuntimeHost(
      'instant_preview_session_token_999999',
      window as never,
      document
    );
    const mesh = {
      position: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0 },
      scale: { x: 4, y: 2, z: 1 },
    };
    const entry = {
      data: { clientID: 1, points: [0, 0, 0, 0, 0, 0, 4, 2, 1] },
      cuboid: { perspective: mesh },
    };
    const internal = host as unknown as {
      preRenderEnhancer: Cvat3dPreRenderEnhancer;
      getActiveCanvas3dInstance: () => CvatInternalCanvas3dLike | null;
      previewCuboidPoints: (id: number, points: number[]) => void;
    };
    vi.spyOn(internal, 'getActiveCanvas3dInstance').mockReturnValue({
      view: { drawnObjects: { 1: entry } },
    });
    const dirty = vi.spyOn(internal.preRenderEnhancer, 'markDirty');
    const redraw = vi
      .spyOn(internal.preRenderEnhancer, 'requestViewsRedraw')
      .mockImplementation(() => {});
    internal.previewCuboidPoints(1, [0.025, 0, 0, 0, 0, 0, 4, 2, 1]);
    expect(mesh.position.x).toBe(0.025);
    expect(redraw).toHaveBeenCalledOnce();
    expect(dirty).not.toHaveBeenCalled();
  });

  it('defers QA scans during canvas drags and resumes on release without leaking listeners', () => {
    vi.useFakeTimers();
    const host = new PageBridgeRuntimeHost(
      'perf_test_bridge_session_token_999999',
      window as never,
      document
    );
    const internal = host as unknown as {
      syncActiveObjectQaOverlay: (force?: boolean) => void;
      getActiveCanvas3dInstance: () => null;
      qaEvalTimer: number | null;
      lastQaSignature: string;
    };
    const lookup = vi.spyOn(internal, 'getActiveCanvas3dInstance').mockReturnValue(null);
    const stop = host.start();
    try {
      const scan = vi.fn();
      internal.qaEvalTimer = setTimeout(scan, 120);
      internal.lastQaSignature = 'pending-report';
      document
        .querySelector('canvas')!
        .dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
      lookup.mockClear();
      internal.syncActiveObjectQaOverlay(true);
      vi.advanceTimersByTime(200);
      expect(scan).not.toHaveBeenCalled();
      expect(lookup).not.toHaveBeenCalled();
      window.dispatchEvent(new MouseEvent('pointerup'));
      expect(lookup).toHaveBeenCalled();
      stop();
      lookup.mockClear();
      window.dispatchEvent(new MouseEvent('pointerup'));
      expect(lookup).not.toHaveBeenCalled();
    } finally {
      stop();
      vi.useRealTimers();
    }
  });

  it('updates base guides from the renderer and removes them on deselection and shutdown', () => {
    const host = new PageBridgeRuntimeHost(
      'base_guide_session_token_999999',
      window as never,
      document
    );
    const internal = host as unknown as {
      preRenderEnhancer: Cvat3dPreRenderEnhancer;
      resolveActiveCuboid: () => {
        clientID: number;
        entry: null;
        state: CvatObjectStateLike;
      } | null;
    };
    const attach = vi.spyOn(internal.preRenderEnhancer, 'setCanvasRenderListener');
    const active = vi.spyOn(internal, 'resolveActiveCuboid').mockReturnValue({
      clientID: 1,
      entry: null,
      state: { points: [0, 0, 0, 0, 0, 0, 4, 2, 2] },
    });
    const stop = host.start();
    try {
      const canvas = document.querySelector<HTMLCanvasElement>('.cvat-canvas3d-sideview canvas')!;
      vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({
        x: 0,
        y: 0,
        left: 0,
        top: 0,
        right: 217,
        bottom: 233,
        width: 217,
        height: 233,
        toJSON() {},
      });
      const render = attach.mock.calls[0]![0]!;
      const camera = {
        isOrthographicCamera: true,
        left: -10,
        right: 10,
        top: 10,
        bottom: -10,
        matrixWorld: { elements: [1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, -10, 0, 1] },
      };
      render(canvas, camera);
      const guide = document.querySelector<SVGSVGElement>('.cvat-3d-enhancer-base-guide')!;
      expect(guide.style.display).toBe('block');
      active.mockReturnValue(null);
      render(canvas, camera);
      expect(guide.style.display).toBe('none');
      stop();
      expect(attach).toHaveBeenLastCalledWith(null);
      expect(guide.isConnected).toBe(false);
    } finally {
      stop();
    }
  });

  it('does not treat deselection as cuboid client ID zero', () => {
    const host = new PageBridgeRuntimeHost(
      'deselected_guide_session_token_999999',
      window as never,
      document
    );
    const internal = host as unknown as {
      getActiveObjectClientId: () => string | null;
      resolveActiveCuboid: () => unknown;
    };
    vi.spyOn(internal, 'getActiveObjectClientId').mockReturnValue(null);
    expect(internal.resolveActiveCuboid()).toBeNull();
  });

  it('automatically repairs removed dimension icons and settles without observer loops', async () => {
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    document.body.innerHTML = `
      <div class="cvat-objects-sidebar">
        <div id="cvat-objects-sidebar-state-item-1" class="cvat-objects-sidebar-state-item">
          <span class="cvat-objects-sidebar-state-item-object-type-text">CUBOID TRACK</span>
        </div>
      </div>`;
    const host = new PageBridgeRuntimeHost(
      'dimension_repair_session_token_999999',
      window as never,
      document
    );
    const stop = host.start();
    const flush = async () => {
      await Promise.resolve();
      for (const callback of frames.splice(0)) callback(0);
      await Promise.resolve();
    };
    try {
      await flush();
      await flush();
      expect(frames).toHaveLength(0);
      document.querySelector('[data-enhancer-sync-dim="H"] svg')!.remove();
      await flush();
      await flush();
      await flush();
      expect(document.querySelectorAll('.cvat-3d-enhancer-dim-sync-row svg path')).toHaveLength(4);
      expect(frames).toHaveLength(0);
      document.querySelector('.cvat-3d-enhancer-dim-sync-row')!.remove();
      await flush();
      await flush();
      await flush();
      expect(document.querySelectorAll('.cvat-3d-enhancer-dim-sync-row')).toHaveLength(1);
      expect(frames).toHaveLength(0);
    } finally {
      stop();
    }
  });

  it('ignores Appearance and QA animation mutations while retaining sidebar control updates', async () => {
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    const host = new PageBridgeRuntimeHost(
      'observer_test_bridge_session_token_999999',
      window as never,
      document
    );
    const internal = host as unknown as {
      tryMountObjectItemDimensionSyncControls: () => void;
      tryMountWorkspaceSettingsCheckboxes: () => void;
      checkForNewlyMountedCanvases: () => boolean;
    };
    const controls = vi
      .spyOn(internal, 'tryMountObjectItemDimensionSyncControls')
      .mockImplementation(() => {});
    const settings = vi
      .spyOn(internal, 'tryMountWorkspaceSettingsCheckboxes')
      .mockImplementation(() => {});
    const canvases = vi.spyOn(internal, 'checkForNewlyMountedCanvases').mockReturnValue(false);
    const stop = host.start();
    const flush = async () => {
      await Promise.resolve();
      const pending = frames.splice(0);
      for (const callback of pending) callback(0);
      await Promise.resolve();
    };
    try {
      document.body.insertAdjacentHTML(
        'beforeend',
        `
        <div class="cvat-appearance-block"><span class="handle"></span></div>
        <div class="cvat-objects-sidebar"><div class="cvat-objects-sidebar-state-item"></div></div>
        <div id="animation"><span></span></div>
      `
      );
      await flush();
      await flush();
      controls.mockClear();
      settings.mockClear();
      canvases.mockClear();
      const appearance = document.querySelector('.cvat-appearance-block')!;
      for (let i = 0; i < 20; i++) {
        appearance.firstElementChild!.className = `handle dragging-${i}`;
        document.querySelector('#animation')!.className = `animating-${i}`;
      }
      appearance.appendChild(document.createElement('span'));
      await flush();
      expect(controls).not.toHaveBeenCalled();
      expect(settings).not.toHaveBeenCalled();
      expect(canvases).not.toHaveBeenCalled();
      document.querySelector('.cvat-objects-sidebar-state-item')!.classList.add('active');
      await flush();
      expect(controls).toHaveBeenCalledTimes(1);
      expect(canvases).not.toHaveBeenCalled();
      expect(settings).not.toHaveBeenCalled();
    } finally {
      stop();
    }
  });

  it('probes CVAT runtime via PageBridge, verifies supported vs unsupported capabilities, and dispatches configure()', async () => {
    const configureSpy = vi.fn();
    const keyControlsSpy = vi.fn();
    const dispatchSpy = vi.fn();

    const mockStore = {
      getState: () => ({
        annotation: {
          canvas: {
            instance: {
              configure: configureSpy,
              keyControls: keyControlsSpy,
            },
          },
        },
      }),
      dispatch: dispatchSpy,
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

    const sessionToken = 'integration_test_bridge_session_token_999999';
    const host = new PageBridgeRuntimeHost(sessionToken, window as never, document);
    const stopHost = host.start();

    const bridge = new PageBridge(window, sessionToken);
    const stopBridge = bridge.attach();

    const domAdapter = new CvatDomAdapter(document);
    const versionDetector = new VersionDetector([window.location.origin]);
    const capRegistry = new CapabilityRegistry();
    const adapter = new CvatV2RuntimeAdapter(bridge, domAdapter, versionDetector, capRegistry);

    const snapshot = await adapter.probeRuntime();

    expect(snapshot.hasCvatUIPluginHook).toBe(true);
    expect(snapshot.hasReduxStoreAccess).toBe(true);
    expect(snapshot.capabilities.cuboidAppearance.status).toBe('supported');
    expect(snapshot.capabilities.labelColors.status).toBe('supported');
    expect(snapshot.capabilities.cameraPresets.status).toBe('supported');
    expect(snapshot.capabilities.pointCloudAppearance.status).toBe('supported');
    expect(snapshot.capabilities.pointSize.status).toBe('supported');
    expect(snapshot.capabilities.colorMode.status).toBe('supported');

    // Verify unsupported internal Three.js scene capabilities are honestly reported as unsupported
    expect(snapshot.capabilities.gridVisibility.status).toBe('unsupported');
    expect(snapshot.capabilities.coordinateAxes.status).toBe('unsupported');

    await adapter.applyVisualConfig({
      shapeOpacity: 25,
      selectedShapeOpacity: 75,
      outlinedBorders: true,
      outlineColor: '#22d3ee',
      colorBy: 'Instance',
      canvasBackgroundColor: '#000000',
    });

    expect(dispatchSpy).toHaveBeenCalledWith({
      type: 'CHANGE_SHAPES_OPACITY',
      payload: { opacity: 25 },
    });
    expect(configureSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        shapeOpacity: 25,
        selectedShapeOpacity: 75,
        outlinedBorders: '#22d3ee',
        colorBy: 'Instance',
      })
    );

    await adapter.dispatchCameraAction('ZOOM_IN');
    expect(keyControlsSpy).toHaveBeenCalledTimes(1);

    stopBridge();
    stopHost();
  });
});
