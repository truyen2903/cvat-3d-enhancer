import { MessageProtocol } from '../integration/cvat/bridge';
import type {
  CanvasVisualConfigInput,
  PageRuntimeProbeResult,
} from '../integration/cvat/runtime';
import {
  type Cvat3dWorkspaceRenderOptions,
  type CvatInternalCanvas3dLike,
  Cvat3dPreRenderEnhancer,
  injectCvatWorkspaceSettingsControls,
  readRenderOptionsFromClientSettings,
  syncEarlyViewportBackgroundDom,
  writeRenderOptionsToClientSettings,
} from '../integration/cvat/runtime/pre-render-enhancer';
import {
  BRIDGE_CHANNEL,
  type CameraPresetAction,
  CVAT_DOM_SELECTORS,
} from '../shared/constants';
import type { BridgeRequestEnvelope } from '../shared/types';

interface CvatCanvas3dLike extends CvatInternalCanvas3dLike {
  configure?: (config: Record<string, unknown>) => void;
  keyControls?: (event: KeyboardEvent) => void;
  fit?: () => void;
}

interface CvatReduxStoreLike {
  getState: () => Record<string, unknown>;
  dispatch: (action: { type: string; payload?: Record<string, unknown> }) => void;
  subscribe?: (listener: () => void) => () => void;
}

interface CvatWindowGlobals {
  cvatUI?: {
    registerComponent?: (
      builder: (args: { store: CvatReduxStoreLike }) => {
        name: string;
        destructor: () => void;
        globalStateDidUpdate?: (state: Record<string, unknown>) => void;
      }
    ) => void;
  };
}

const CAMERA_KEY_MAPPING: Record<
  CameraPresetAction,
  { readonly code: string; readonly altKey: boolean; readonly shiftKey: boolean }
> = {
  ZOOM_IN: { code: 'KeyI', altKey: true, shiftKey: false },
  ZOOM_OUT: { code: 'KeyK', altKey: true, shiftKey: false },
  MOVE_UP: { code: 'KeyU', altKey: true, shiftKey: false },
  MOVE_DOWN: { code: 'KeyO', altKey: true, shiftKey: false },
  MOVE_LEFT: { code: 'KeyJ', altKey: true, shiftKey: false },
  MOVE_RIGHT: { code: 'KeyL', altKey: true, shiftKey: false },
  TILT_UP: { code: 'ArrowUp', altKey: false, shiftKey: true },
  TILT_DOWN: { code: 'ArrowDown', altKey: false, shiftKey: true },
  ROTATE_LEFT: { code: 'ArrowLeft', altKey: false, shiftKey: true },
  ROTATE_RIGHT: { code: 'ArrowRight', altKey: false, shiftKey: true },
};

export class PageBridgeRuntimeHost {
  private readonly win: Window & CvatWindowGlobals;
  private readonly doc: Document;
  private readonly sessionToken: string;
  private readonly preRenderEnhancer: Cvat3dPreRenderEnhancer;
  private reduxStore: CvatReduxStoreLike | null = null;
  private pluginRegistered = false;
  private settingsObserver: MutationObserver | null = null;

  public constructor(
    sessionToken: string,
    win: Window & CvatWindowGlobals = window as Window & CvatWindowGlobals,
    doc: Document = document
  ) {
    this.sessionToken = sessionToken;
    this.win = win;
    this.doc = doc;
    const savedOptions = readRenderOptionsFromClientSettings(this.win.localStorage);
    this.preRenderEnhancer = new Cvat3dPreRenderEnhancer(savedOptions);
    syncEarlyViewportBackgroundDom(this.doc, savedOptions.whiteBackground);
    this.tryHookCvatUIPlugin();
  }

  public start(): () => void {
    const onPluginReady = () => {
      this.tryHookCvatUIPlugin();
    };
    this.doc.addEventListener('plugins.ready', onPluginReady);
    this.win.addEventListener('message', this.handleMessage);

    // Observe DOM for CVAT Settings -> Workspace modal opening and 3D canvas initialization
    if (this.doc.documentElement) {
      this.settingsObserver = new MutationObserver(() => {
        syncEarlyViewportBackgroundDom(
          this.doc,
          this.preRenderEnhancer.getOptions().whiteBackground
        );
        this.tryMountWorkspaceSettingsCheckboxes();
        const instance = this.getActiveCanvas3dInstance();
        if (instance) {
          this.preRenderEnhancer.ensureHooked(instance);
        }
      });
      this.settingsObserver.observe(this.doc.documentElement, {
        childList: true,
        subtree: true,
      });
    }

    syncEarlyViewportBackgroundDom(this.doc, this.preRenderEnhancer.getOptions().whiteBackground);
    this.tryMountWorkspaceSettingsCheckboxes();

    return () => {
      this.doc.removeEventListener('plugins.ready', onPluginReady);
      this.win.removeEventListener('message', this.handleMessage);
      this.settingsObserver?.disconnect();
      this.settingsObserver = null;
    };
  }

  private tryMountWorkspaceSettingsCheckboxes(): void {
    injectCvatWorkspaceSettingsControls(
      this.doc,
      () => this.preRenderEnhancer.getOptions(),
      (next: Cvat3dWorkspaceRenderOptions) => {
        const persisted = writeRenderOptionsToClientSettings(next, this.win.localStorage);
        syncEarlyViewportBackgroundDom(this.doc, persisted.whiteBackground);
        const canvasInstance = this.getActiveCanvas3dInstance();
        this.preRenderEnhancer.setOptions(persisted, canvasInstance);
      }
    );
  }

  private tryHookCvatUIPlugin(): void {
    if (this.pluginRegistered) {
      return;
    }
    const cvatUI = this.win.cvatUI;
    if (cvatUI && typeof cvatUI.registerComponent === 'function') {
      try {
        cvatUI.registerComponent(({ store }) => {
          this.reduxStore = store;
          const instance = this.getActiveCanvas3dInstance();
          if (instance) {
            this.preRenderEnhancer.ensureHooked(instance);
          }

          return {
            name: 'cvat-3d-enhancer-runtime-bridge',
            destructor: () => {
              this.reduxStore = null;
            },
            globalStateDidUpdate: () => {
              // Ensure clientSettings key isn't wiped when CVAT's SettingsModal calls updateCachedSettings()
              const currentOpts = this.preRenderEnhancer.getOptions();
              const inStorage = readRenderOptionsFromClientSettings(this.win.localStorage);
              if (
                inStorage.whiteBackground !== currentOpts.whiteBackground ||
                inStorage.enableScattering !== currentOpts.enableScattering ||
                inStorage.colorPointsByCuboid !== currentOpts.colorPointsByCuboid
              ) {
                writeRenderOptionsToClientSettings(currentOpts, this.win.localStorage);
              }

              const activeInstance = this.getActiveCanvas3dInstance();
              if (activeInstance) {
                this.preRenderEnhancer.ensureHooked(activeInstance);
              }
            },
          };
        });
        this.pluginRegistered = true;
      } catch {
        // Ignore if CVAT plugin registry rejected duplicate registration
      }
    }
  }

  private getActiveCanvas3dInstance(): CvatCanvas3dLike | null {
    if (!this.reduxStore) {
      return null;
    }
    try {
      const state = this.reduxStore.getState();
      const annotation = state.annotation as Record<string, unknown> | undefined;
      const canvas = annotation?.canvas as Record<string, unknown> | undefined;
      const instance = canvas?.instance as CvatCanvas3dLike | undefined;
      if (instance && typeof instance.configure === 'function') {
        return instance;
      }
    } catch {
      return null;
    }
    return null;
  }

  public probeRuntime(): PageRuntimeProbeResult {
    this.tryHookCvatUIPlugin();
    const perspectiveDom = Boolean(this.doc.querySelector(CVAT_DOM_SELECTORS.PERSPECTIVE_WRAPPER));
    const perspectiveCanvas = Boolean(
      this.doc.querySelector(`${CVAT_DOM_SELECTORS.PERSPECTIVE_CANVAS_CONTAINER} canvas`)
    );
    const orthoViews =
      this.doc.querySelectorAll(CVAT_DOM_SELECTORS.ORTHOGRAPHIC_VIEW).length >= 3;
    const canvasInstance = this.getActiveCanvas3dInstance();
    if (canvasInstance) {
      this.preRenderEnhancer.ensureHooked(canvasInstance);
    }

    return {
      hasCvatUIPluginHook: Boolean(this.win.cvatUI?.registerComponent),
      hasReduxStoreAccess: Boolean(this.reduxStore),
      hasActive3DCanvasInstance: Boolean(canvasInstance),
      hasPerspectiveDom: perspectiveDom,
      hasPerspectiveCanvas: perspectiveCanvas,
      hasOrthographicViews: orthoViews,
      renderOptions: this.preRenderEnhancer.getOptions(),
    };
  }

  private applyCanvasVisualConfig(config: CanvasVisualConfigInput): void {
    const canvasInstance = this.getActiveCanvas3dInstance();
    if (canvasInstance) {
      this.preRenderEnhancer.ensureHooked(canvasInstance);
    }

    if (
      config.whiteBackground !== undefined ||
      config.enableScattering !== undefined ||
      config.colorPointsByCuboid !== undefined
    ) {
      const current = this.preRenderEnhancer.getOptions();
      const next: Cvat3dWorkspaceRenderOptions = {
        whiteBackground: config.whiteBackground ?? current.whiteBackground,
        enableScattering: config.enableScattering ?? current.enableScattering,
        colorPointsByCuboid: config.colorPointsByCuboid ?? current.colorPointsByCuboid,
      };
      writeRenderOptionsToClientSettings(next, this.win.localStorage);
      this.preRenderEnhancer.setOptions(next, canvasInstance);
      this.tryMountWorkspaceSettingsCheckboxes();
    }

    if (this.reduxStore) {
      if (config.shapeOpacity !== undefined) {
        this.reduxStore.dispatch({
          type: 'CHANGE_SHAPES_OPACITY',
          payload: { opacity: config.shapeOpacity },
        });
      }
      if (config.selectedShapeOpacity !== undefined) {
        this.reduxStore.dispatch({
          type: 'CHANGE_SELECTED_SHAPES_OPACITY',
          payload: { selectedOpacity: config.selectedShapeOpacity },
        });
      }
      if (config.outlinedBorders !== undefined || config.outlineColor !== undefined) {
        this.reduxStore.dispatch({
          type: 'CHANGE_SHAPES_OUTLINED_BORDERS',
          payload: {
            outlined: config.outlinedBorders ?? true,
            color: config.outlineColor ?? '#000000',
          },
        });
      }
      if (config.orientationVisibility !== undefined) {
        this.reduxStore.dispatch({
          type: 'CHANGE_SHAPES_ORIENTATION_VISIBILITY',
          payload: { orientationVisibility: config.orientationVisibility },
        });
      }
      if (config.colorBy !== undefined) {
        this.reduxStore.dispatch({
          type: 'CHANGE_SHAPES_COLOR_BY',
          payload: { colorBy: config.colorBy },
        });
      }
      if (config.controlPointsSize !== undefined) {
        this.reduxStore.dispatch({
          type: 'SWITCH_CONTROL_POINTS_SIZE',
          payload: { controlPointsSize: config.controlPointsSize },
        });
      }
      if (config.focusedObjectPadding !== undefined) {
        this.reduxStore.dispatch({
          type: 'CHANGE_FOCUSED_OBJECT_PADDING',
          payload: { focusedObjectPadding: config.focusedObjectPadding },
        });
      }
    }

    if (canvasInstance?.configure) {
      const directPatch: Record<string, unknown> = {};
      if (config.shapeOpacity !== undefined) directPatch.shapeOpacity = config.shapeOpacity;
      if (config.selectedShapeOpacity !== undefined) {
        directPatch.selectedShapeOpacity = config.selectedShapeOpacity;
      }
      if (config.outlinedBorders !== undefined || config.outlineColor !== undefined) {
        directPatch.outlinedBorders = config.outlinedBorders
          ? (config.outlineColor ?? '#000000')
          : false;
      }
      if (config.orientationVisibility !== undefined) {
        directPatch.orientationVisibility = config.orientationVisibility;
      }
      if (config.colorBy !== undefined) directPatch.colorBy = config.colorBy;
      if (config.controlPointsSize !== undefined) {
        directPatch.controlPointsSize = config.controlPointsSize;
      }
      if (config.focusedObjectPadding !== undefined) {
        directPatch.focusedObjectPadding = config.focusedObjectPadding;
      }
      if (Object.keys(directPatch).length > 0) {
        canvasInstance.configure(directPatch);
      }
    }
  }

  private dispatchCameraAction(action: CameraPresetAction): void {
    const spec = CAMERA_KEY_MAPPING[action];
    const synthEvent = new KeyboardEvent('keydown', {
      code: spec.code,
      altKey: spec.altKey,
      shiftKey: spec.shiftKey,
      bubbles: true,
    });

    const canvasInstance = this.getActiveCanvas3dInstance();
    if (canvasInstance?.keyControls) {
      canvasInstance.keyControls(synthEvent);
      return;
    }

    this.doc.dispatchEvent(synthEvent);
  }

  private resetDefaults(): void {
    this.applyCanvasVisualConfig({
      shapeOpacity: 40,
      selectedShapeOpacity: 60,
      outlinedBorders: false,
      outlineColor: '#000000',
      orientationVisibility: 'always',
      colorBy: 'Label',
      controlPointsSize: 5,
      focusedObjectPadding: 50,
      whiteBackground: false,
      enableScattering: false,
      colorPointsByCuboid: false,
    });
    const canvasInstance = this.getActiveCanvas3dInstance();
    if (canvasInstance?.fit) {
      canvasInstance.fit();
    }
  }

  private readonly handleMessage = (event: MessageEvent): void => {
    const expectedOrigin = this.win.location.origin;
    const sourceValid = event.source === this.win || event.source === null;
    const originValid =
      event.origin === expectedOrigin || (event.origin === '' && event.source === null);
    if (!sourceValid || !originValid) {
      return;
    }

    const raw: unknown = event.data;
    if (typeof raw !== 'object' || raw === null) {
      return;
    }

    const candidate = raw as Record<string, unknown>;
    if (
      candidate.channel !== BRIDGE_CHANNEL ||
      candidate.direction !== 'CONTENT_TO_PAGE'
    ) {
      return;
    }

    let request: BridgeRequestEnvelope;
    try {
      request = MessageProtocol.validateIncomingRequest(raw, this.sessionToken);
    } catch (err) {
      const fallbackReqId =
        typeof candidate.requestId === 'string' && candidate.requestId.length >= 8
          ? candidate.requestId
          : 'invalid_req_id';
      const errResp = MessageProtocol.createErrorResponse(
        fallbackReqId,
        this.sessionToken,
        'VALIDATION_ERROR',
        err instanceof Error ? err.message : 'Invalid bridge request'
      );
      this.win.postMessage(errResp, this.win.location.origin);
      return;
    }

    try {
      let result: unknown = {};
      switch (request.command) {
        case 'BRIDGE_HANDSHAKE':
          result = { ready: true };
          break;
        case 'DETECT_RUNTIME':
        case 'GET_CAPABILITIES':
          result = this.probeRuntime();
          break;
        case 'APPLY_CANVAS_VISUAL_CONFIG':
          this.applyCanvasVisualConfig(request.payload as CanvasVisualConfigInput);
          result = { applied: true, renderOptions: this.preRenderEnhancer.getOptions() };
          break;
        case 'DISPATCH_CAMERA_ACTION': {
          const payload = request.payload as { readonly action: CameraPresetAction };
          this.dispatchCameraAction(payload.action);
          result = { dispatched: true };
          break;
        }
        case 'SET_CANVAS_BACKGROUND':
          result = { applied: true };
          break;
        case 'RESET_TO_CVAT_DEFAULT':
          this.resetDefaults();
          result = { reset: true };
          break;
      }

      const response = MessageProtocol.createSuccessResponse(
        request.requestId,
        this.sessionToken,
        result
      );
      this.win.postMessage(response, this.win.location.origin);
    } catch (err) {
      const response = MessageProtocol.createErrorResponse(
        request.requestId,
        this.sessionToken,
        'EXECUTION_ERROR',
        err instanceof Error ? err.message : 'Command execution failed'
      );
      this.win.postMessage(response, this.win.location.origin);
    }
  };
}

// Auto-initialize when injected into page with data-cvat-enhancer-bridge-token
if (typeof document !== 'undefined') {
  const scriptEl = document.querySelector<HTMLScriptElement>(
    'script[data-cvat-enhancer-bridge-token]'
  );
  const token = scriptEl?.dataset.cvatEnhancerBridgeToken;
  if (token) {
    // Immediately remove token attribute from DOM so page scripts cannot scrape it later
    delete scriptEl.dataset.cvatEnhancerBridgeToken;
    const host = new PageBridgeRuntimeHost(token);
    host.start();
  }
}
