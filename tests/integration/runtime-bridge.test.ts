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
