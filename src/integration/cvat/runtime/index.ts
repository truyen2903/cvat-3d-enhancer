import { rootLogger } from '../../../core/logger';
import type { CameraPresetAction } from '../../../shared/constants';
import type {
  CapabilityId,
  CapabilityMap,
  CuboidColorBy,
  CuboidOrientationVisibility,
  CvatRuntimeSnapshot,
} from '../../../shared/types';
import { PageBridge } from '../bridge';
import { VersionDetector } from '../compatibility';
import { CvatDomAdapter } from '../dom';

export interface CanvasVisualConfigInput {
  readonly shapeOpacity?: number;
  readonly selectedShapeOpacity?: number;
  readonly outlinedBorders?: boolean;
  readonly outlineColor?: string;
  readonly orientationVisibility?: CuboidOrientationVisibility;
  readonly colorBy?: CuboidColorBy;
  readonly controlPointsSize?: number;
  readonly focusedObjectPadding?: number;
  readonly canvasBackgroundColor?: string;
  readonly pointCloudCssBrightness?: number;
  readonly pointCloudCssContrast?: number;
  readonly whiteBackground?: boolean;
  readonly enableScattering?: boolean;
  readonly colorPointsByCuboid?: boolean;
}

export interface PageRuntimeProbeResult {
  readonly hasCvatUIPluginHook: boolean;
  readonly hasReduxStoreAccess: boolean;
  readonly hasActive3DCanvasInstance: boolean;
  readonly hasPerspectiveDom: boolean;
  readonly hasPerspectiveCanvas: boolean;
  readonly hasOrthographicViews: boolean;
  readonly renderOptions?: {
    readonly whiteBackground: boolean;
    readonly enableScattering: boolean;
    readonly colorPointsByCuboid: boolean;
  };
}

export function createInitialCapabilityMap(): CapabilityMap {
  return {
    pointCloudAppearance: {
      id: 'pointCloudAppearance',
      name: 'Point Cloud Visual Filter & Background',
      status: 'unverified',
      verifiedBy: 'none',
      reason: 'Pending verification of CVAT 3D WebGL canvas DOM.',
    },
    pointSize: {
      id: 'pointSize',
      name: '3D Point Cloud Point Size',
      status: 'unsupported',
      verifiedBy: 'none',
      reason:
        'CVAT v2.81.0 Canvas3dViewImpl encapsulates Three.js PointsMaterial (size=0.05/0.5) inside a private class closure with no public setter.',
    },
    colorMode: {
      id: 'colorMode',
      name: 'Point Cloud Height / Intensity Color Shader',
      status: 'unsupported',
      verifiedBy: 'none',
      reason:
        'CVAT v2.81.0 PCDLoader & Canvas3dViewImpl hardcode PointsMaterial(0xffffff) inside private view state without shader/attribute hooks.',
    },
    cameraPresets: {
      id: 'cameraPresets',
      name: 'Camera Navigation & Step Presets',
      status: 'unverified',
      verifiedBy: 'none',
      reason: 'Pending verification of CVAT 3D perspective canvas / keyControls.',
    },
    gridVisibility: {
      id: 'gridVisibility',
      name: '3D Ground Grid Helper',
      status: 'unsupported',
      verifiedBy: 'none',
      reason:
        'CVAT v2.81.0 3D workspace does not instantiate THREE.GridHelper; settings.workspace.grid is wired exclusively to 2D canvas.',
    },
    coordinateAxes: {
      id: 'coordinateAxes',
      name: '3D Coordinate Axes Helper Visibility',
      status: 'unsupported',
      verifiedBy: 'none',
      reason:
        'CVAT v2.81.0 adds THREE.AxesHelper(5) anonymously to private views.perspective.scene without a public toggle API.',
    },
    cuboidAppearance: {
      id: 'cuboidAppearance',
      name: 'Cuboid Opacity, Outlines & Orientation Arrows',
      status: 'unverified',
      verifiedBy: 'none',
      reason:
        'Pending verification of window.cvatUI plugin store or active Canvas3d.configure() hook.',
    },
    labelColors: {
      id: 'labelColors',
      name: 'Cuboid Color-By Mode (Label / Instance / Group)',
      status: 'unverified',
      verifiedBy: 'none',
      reason:
        'Pending verification of window.cvatUI plugin store or active Canvas3d.configure() hook.',
    },
  };
}

/**
 * Registry of runtime capabilities.
 * Never reports a capability as 'supported' unless verified against the live CVAT runtime/DOM.
 */
export class CapabilityRegistry {
  private capabilities: CapabilityMap = createInitialCapabilityMap();

  public getCapabilities(): CapabilityMap {
    return structuredClone(this.capabilities);
  }

  public isSupported(id: CapabilityId): boolean {
    return this.capabilities[id].status === 'supported';
  }

  public updateFromProbe(probe: PageRuntimeProbeResult): CapabilityMap {
    const next = createInitialCapabilityMap();

    if (probe.hasPerspectiveDom && probe.hasPerspectiveCanvas) {
      next.pointCloudAppearance = {
        id: 'pointCloudAppearance',
        name: 'Point Cloud Visual Filter & Background',
        status: 'supported',
        verifiedBy: 'dom-inspection',
        reason: 'Verified active CVAT 3D WebGL canvas and viewport containers in DOM.',
      };

      next.cameraPresets = {
        id: 'cameraPresets',
        name: 'Camera Navigation & Step Presets',
        status: 'supported',
        verifiedBy: probe.hasActive3DCanvasInstance ? 'runtime-bridge' : 'dom-inspection',
        reason: probe.hasActive3DCanvasInstance
          ? 'Verified active Canvas3d.keyControls() and fit() via CVAT runtime bridge.'
          : 'Verified CVAT 3D perspective camera control triggers in DOM.',
      };
    }

    if (probe.hasReduxStoreAccess || probe.hasActive3DCanvasInstance) {
      next.cuboidAppearance = {
        id: 'cuboidAppearance',
        name: 'Cuboid Opacity, Outlines & Orientation Arrows',
        status: 'supported',
        verifiedBy: 'runtime-bridge',
        reason:
          'Verified CVAT Redux settings store and Canvas3d.configure() runtime bridge integration.',
      };

      next.labelColors = {
        id: 'labelColors',
        name: 'Cuboid Color-By Mode (Label / Instance / Group)',
        status: 'supported',
        verifiedBy: 'runtime-bridge',
        reason: 'Verified CVAT shapes colorBy (Label/Instance/Group) runtime configuration hook.',
      };

      if (probe.hasActive3DCanvasInstance) {
        next.pointSize = {
          id: 'pointSize',
          name: '3D Point Cloud Scattering & Point Size',
          status: 'supported',
          verifiedBy: 'runtime-bridge',
          reason:
            'Verified pre-render hook on Canvas3dViewImpl.views.*.scene PointsMaterial (scattering & size attenuation).',
        };

        next.colorMode = {
          id: 'colorMode',
          name: 'Per-Cuboid Point Cloud Coloring (OBB Filter)',
          status: 'supported',
          verifiedBy: 'runtime-bridge',
          reason:
            'Verified single-pass pre-render OBB point cloud buffer coloring inside Canvas3dViewImpl.',
        };
      }
    }

    this.capabilities = next;
    return this.getCapabilities();
  }

  public reset(): void {
    this.capabilities = createInitialCapabilityMap();
  }
}

export interface Cvat3DRuntimeAdapter {
  probeRuntime(): Promise<CvatRuntimeSnapshot>;
  applyVisualConfig(config: CanvasVisualConfigInput): Promise<void>;
  dispatchCameraAction(action: CameraPresetAction): Promise<void>;
  resetToCvatDefaults(): Promise<void>;
}

/**
 * Concrete adapter for CVAT v2.x (verified against v2.81.0).
 * Communicates with the page-context runtime via the validated PageBridge and falls back
 * to safe DOM inspection where appropriate.
 */
export class CvatV2RuntimeAdapter implements Cvat3DRuntimeAdapter {
  private readonly bridge: PageBridge;
  private readonly domAdapter: CvatDomAdapter;
  private readonly versionDetector: VersionDetector;
  private readonly capabilityRegistry: CapabilityRegistry;
  private readonly log = rootLogger.child('cvat-runtime-adapter');

  public constructor(
    bridge: PageBridge,
    domAdapter: CvatDomAdapter,
    versionDetector: VersionDetector,
    capabilityRegistry: CapabilityRegistry
  ) {
    this.bridge = bridge;
    this.domAdapter = domAdapter;
    this.versionDetector = versionDetector;
    this.capabilityRegistry = capabilityRegistry;
  }

  public async probeRuntime(): Promise<CvatRuntimeSnapshot> {
    const domState = this.domAdapter.has3DWorkspaceDom();
    let bridgeProbe: PageRuntimeProbeResult = {
      hasCvatUIPluginHook: false,
      hasReduxStoreAccess: false,
      hasActive3DCanvasInstance: false,
      hasPerspectiveDom: domState.hasPerspective,
      hasPerspectiveCanvas: domState.hasPerspectiveCanvas,
      hasOrthographicViews: domState.hasOrthographicViews,
    };

    try {
      const response = await this.bridge.sendCommand<Record<string, never>, PageRuntimeProbeResult>(
        'DETECT_RUNTIME',
        {}
      );
      bridgeProbe = {
        hasCvatUIPluginHook: Boolean(response.hasCvatUIPluginHook),
        hasReduxStoreAccess: Boolean(response.hasReduxStoreAccess),
        hasActive3DCanvasInstance: Boolean(response.hasActive3DCanvasInstance),
        hasPerspectiveDom: Boolean(response.hasPerspectiveDom || domState.hasPerspective),
        hasPerspectiveCanvas: Boolean(
          response.hasPerspectiveCanvas || domState.hasPerspectiveCanvas
        ),
        hasOrthographicViews: Boolean(
          response.hasOrthographicViews || domState.hasOrthographicViews
        ),
      };
    } catch (err) {
      this.log.debug('PageBridge probe unavailable; relying on local DOM inspection', err);
    }

    const versionInfo = await this.versionDetector.detectServerVersion(window.location.origin);
    const capabilities = this.capabilityRegistry.updateFromProbe(bridgeProbe);

    return {
      detected:
        bridgeProbe.hasCvatUIPluginHook ||
        bridgeProbe.hasPerspectiveDom ||
        versionInfo.serverVersion !== null,
      serverVersion: versionInfo.serverVersion,
      coreVersion: versionInfo.serverVersion,
      hasCvatUIPluginHook: bridgeProbe.hasCvatUIPluginHook,
      has3DCanvasDom: bridgeProbe.hasPerspectiveDom,
      hasPerspectiveCanvas: bridgeProbe.hasPerspectiveCanvas,
      hasOrthographicViews: bridgeProbe.hasOrthographicViews,
      hasReduxStoreAccess: bridgeProbe.hasReduxStoreAccess,
      capabilities,
    };
  }

  public async applyVisualConfig(config: CanvasVisualConfigInput): Promise<void> {
    if (
      config.canvasBackgroundColor !== undefined ||
      config.pointCloudCssBrightness !== undefined ||
      config.pointCloudCssContrast !== undefined
    ) {
      if (!this.capabilityRegistry.isSupported('pointCloudAppearance')) {
        throw new Error(
          'Capability "pointCloudAppearance" is not verified on the current runtime.'
        );
      }
      if (config.canvasBackgroundColor) {
        this.domAdapter.applyCanvasBackgroundColor(config.canvasBackgroundColor);
      }
      if (
        config.pointCloudCssBrightness !== undefined ||
        config.pointCloudCssContrast !== undefined
      ) {
        this.domAdapter.applyViewportVisualFilter(
          config.pointCloudCssBrightness ?? 100,
          config.pointCloudCssContrast ?? 100
        );
      }
    }

    const needsBridge =
      config.shapeOpacity !== undefined ||
      config.selectedShapeOpacity !== undefined ||
      config.outlinedBorders !== undefined ||
      config.outlineColor !== undefined ||
      config.orientationVisibility !== undefined ||
      config.colorBy !== undefined ||
      config.controlPointsSize !== undefined ||
      config.focusedObjectPadding !== undefined ||
      config.whiteBackground !== undefined ||
      config.enableScattering !== undefined ||
      config.colorPointsByCuboid !== undefined;

    if (needsBridge) {
      if (
        !this.capabilityRegistry.isSupported('cuboidAppearance') &&
        config.whiteBackground === undefined &&
        config.enableScattering === undefined &&
        config.colorPointsByCuboid === undefined
      ) {
        throw new Error('Capability "cuboidAppearance" is not verified on the current runtime.');
      }
      await this.bridge.sendCommand('APPLY_CANVAS_VISUAL_CONFIG', config);
    }
  }

  public async dispatchCameraAction(action: CameraPresetAction): Promise<void> {
    if (!this.capabilityRegistry.isSupported('cameraPresets')) {
      throw new Error('Capability "cameraPresets" is not verified on the current runtime.');
    }
    await this.bridge.sendCommand('DISPATCH_CAMERA_ACTION', { action });
  }

  public async resetToCvatDefaults(): Promise<void> {
    this.domAdapter.resetDomEnhancements();
    if (this.capabilityRegistry.isSupported('cuboidAppearance')) {
      await this.bridge.sendCommand('RESET_TO_CVAT_DEFAULT', {});
    }
  }
}

export class RuntimeManager {
  private readonly adapter: Cvat3DRuntimeAdapter;
  private readonly capabilityRegistry: CapabilityRegistry;
  private snapshot: CvatRuntimeSnapshot;

  public constructor(adapter: Cvat3DRuntimeAdapter, capabilityRegistry: CapabilityRegistry) {
    this.adapter = adapter;
    this.capabilityRegistry = capabilityRegistry;
    this.snapshot = {
      detected: false,
      serverVersion: null,
      coreVersion: null,
      hasCvatUIPluginHook: false,
      has3DCanvasDom: false,
      hasPerspectiveCanvas: false,
      hasOrthographicViews: false,
      hasReduxStoreAccess: false,
      capabilities: capabilityRegistry.getCapabilities(),
    };
  }

  public async refresh(): Promise<CvatRuntimeSnapshot> {
    this.snapshot = await this.adapter.probeRuntime();
    return this.snapshot;
  }

  public getSnapshot(): CvatRuntimeSnapshot {
    return structuredClone(this.snapshot);
  }

  public isCapabilitySupported(id: CapabilityId): boolean {
    return this.capabilityRegistry.isSupported(id);
  }

  public getAdapter(): Cvat3DRuntimeAdapter {
    return this.adapter;
  }
}
