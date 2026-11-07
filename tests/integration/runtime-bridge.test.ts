import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PageBridgeRuntimeHost } from '../../src/entrypoints/page-bridge';
import { PageBridge } from '../../src/integration/cvat/bridge';
import { VersionDetector } from '../../src/integration/cvat/compatibility';
import { CvatDomAdapter } from '../../src/integration/cvat/dom';
import { CapabilityRegistry, CvatV2RuntimeAdapter } from '../../src/integration/cvat/runtime';

describe('CVAT 3D Runtime & PageBridge Integration', () => {
  beforeEach(() => {
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
