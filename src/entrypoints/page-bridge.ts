import { MessageProtocol } from '../integration/cvat/bridge';
import type {
  CanvasVisualConfigInput,
  PageRuntimeProbeResult,
} from '../integration/cvat/runtime';
import {
  type CuboidDimensionKey,
  type Cvat3dWorkspaceRenderOptions,
  type CvatDrawnObjectEntry,
  type CvatInternalCanvas3dLike,
  type CvatInternalViewLike,
  type CvatObjectStateLike,
  Cvat3dPreRenderEnhancer,
  type DimensionSyncResult,
  injectCvatObjectDimensionSyncControls,
  injectCvatWorkspaceSettingsControls,
  readRenderOptionsFromClientSettings,
  syncEarlyViewportBackgroundDom,
  syncTrackCuboidDimension,
  type ThreeSceneLike,
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
  private readonly hookedPerspectiveCanvases = new WeakSet<HTMLCanvasElement>();
  private readonly knownDomCanvases = new WeakSet<HTMLCanvasElement>();
  private domBackedViewRef: CvatInternalViewLike | null = null;
  private lastDomCanvasRef: HTMLCanvasElement | null = null;

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
        this.tryMountObjectItemDimensionSyncControls();
        if (this.checkForNewlyMountedCanvases()) {
          this.preRenderEnhancer.markViewStructureChanged();
        }
        const instance = this.getActiveCanvas3dInstance();
        if (instance) {
          this.preRenderEnhancer.ensureHooked(instance);
        }
      });
      this.settingsObserver.observe(this.doc.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['data-frame-number', 'class'],
      });
    }

    syncEarlyViewportBackgroundDom(this.doc, this.preRenderEnhancer.getOptions().whiteBackground);
    this.tryMountWorkspaceSettingsCheckboxes();
    this.tryMountObjectItemDimensionSyncControls();
    const initialInstance = this.getActiveCanvas3dInstance();
    if (initialInstance) {
      this.preRenderEnhancer.ensureHooked(initialInstance);
    }

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

  private tryMountObjectItemDimensionSyncControls(): void {
    injectCvatObjectDimensionSyncControls(
      this.doc,
      (clientID: number, dimension: CuboidDimensionKey): Promise<DimensionSyncResult> =>
        this.handleSyncObjectDimension(clientID, dimension)
    );
  }

  private async handleSyncObjectDimension(
    clientID: number,
    dimension: CuboidDimensionKey
  ): Promise<DimensionSyncResult> {
    const instance = this.getActiveCanvas3dInstance();
    const drawnEntry = instance?.view?.drawnObjects?.[clientID] ?? null;
    let stateOnCurrentFrame: CvatObjectStateLike | null = drawnEntry?.state ?? null;

    if (!stateOnCurrentFrame && this.reduxStore) {
      try {
        const state = this.reduxStore.getState();
        const annotation = state.annotation as Record<string, unknown> | undefined;
        const annotations = annotation?.annotations as Record<string, unknown> | undefined;
        const states = annotations?.states as CvatObjectStateLike[] | undefined;
        if (Array.isArray(states)) {
          stateOnCurrentFrame =
            states.find((s) => Number(s?.clientID) === clientID) ?? null;
        }
      } catch {
        // Ignore fallback lookup errors
      }
    }

    const perspCanvas = this.doc.querySelector<
      HTMLCanvasElement & {
        updatePosition?: (state: CvatObjectStateLike, points: number[]) => void;
      }
    >('.cvat-canvas3d-perspective canvas');

    return syncTrackCuboidDimension(clientID, dimension, {
      drawnEntry,
      stateOnCurrentFrame,
      perspectiveCanvas: perspCanvas,
    });
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
                inStorage.colorPointsByCuboid !== currentOpts.colorPointsByCuboid ||
                (inStorage.fixedOrthoPointSize ?? true) !==
                  (currentOpts.fixedOrthoPointSize ?? true)
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
    const domInstance = this.resolveDomBackedCanvas3dInstance();

    if (this.reduxStore) {
      try {
        const state = this.reduxStore.getState();
        const annotation = state.annotation as Record<string, unknown> | undefined;
        const canvas = annotation?.canvas as Record<string, unknown> | undefined;
        const instance = canvas?.instance as CvatCanvas3dLike | undefined;
        if (instance && (typeof instance.configure === 'function' || instance.view)) {
          if (!instance.view?.views?.perspective?.scene && domInstance?.view) {
            return {
              configure: instance.configure?.bind(instance),
              keyControls: instance.keyControls?.bind(instance),
              fit: instance.fit?.bind(instance),
              view: domInstance.view,
              model: instance.model ?? domInstance.model,
            };
          }
          if (instance.view?.views && domInstance?.view?.views) {
            for (const [k, v] of Object.entries(domInstance.view.views)) {
              if (k.startsWith('ortho_zoom_') && v) {
                instance.view.views[k] = v;
              }
            }
          }
          return instance;
        }
      } catch {
        // Fall through to DOM-backed 3D canvas inspection
      }
    }

    return domInstance;
  }

  private checkForNewlyMountedCanvases(): boolean {
    const allCanvases = this.doc.querySelectorAll<HTMLCanvasElement>('canvas');
    let foundNew = false;
    for (const c of allCanvases) {
      if (!this.knownDomCanvases.has(c)) {
        this.knownDomCanvases.add(c);
        foundNew = true;
        c.addEventListener('canvas.setup', () => {
          this.preRenderEnhancer.markViewStructureChanged();
          const inst = this.getActiveCanvas3dInstance();
          if (inst?.view) {
            this.preRenderEnhancer.applyOnceIfNeeded(inst.view, inst.model);
          }
        });
      }
    }
    return foundNew;
  }

  private bindDomPerspectiveCanvasEvents(): HTMLCanvasElement | null {
    this.checkForNewlyMountedCanvases();
    const perspCanvas = this.doc.querySelector<
      HTMLCanvasElement & {
        scene?: ThreeSceneLike;
        getDrawnObjects?: () => CvatDrawnObjectEntry[];
      }
    >('.cvat-canvas3d-perspective canvas');

    if (!perspCanvas) {
      return null;
    }

    if (!this.hookedPerspectiveCanvases.has(perspCanvas)) {
      this.hookedPerspectiveCanvases.add(perspCanvas);
      perspCanvas.addEventListener('canvas.setup', () => {
        this.preRenderEnhancer.markDirty();
        const inst = this.getActiveCanvas3dInstance();
        if (inst?.view) {
          this.preRenderEnhancer.applyOnceIfNeeded(inst.view, inst.model);
        }
      });
    }

    return perspCanvas;
  }

  /**
   * Fallback/direct bridge that reads CVAT's `canvas.scene` (`THREE.Scene`) and
   * `canvas.getDrawnObjects()` defined directly on `.cvat-canvas3d-perspective canvas`,
   * `.cvat-canvas3d-orthographic-view canvas`, and any newly opened zoom/modal `<canvas>`.
   */
  private resolveDomBackedCanvas3dInstance(): CvatCanvas3dLike | null {
    const perspCanvas = this.bindDomPerspectiveCanvasEvents() as
      | (HTMLCanvasElement & {
          scene?: ThreeSceneLike;
          getDrawnObjects?: () => CvatDrawnObjectEntry[];
        })
      | null;

    if (!perspCanvas?.scene) {
      return null;
    }

    if (!this.domBackedViewRef || this.lastDomCanvasRef !== perspCanvas) {
      this.lastDomCanvasRef = perspCanvas;
      const docRef = this.doc;
      this.domBackedViewRef = {
        get views() {
          const p = docRef.querySelector<HTMLCanvasElement & { scene?: ThreeSceneLike }>(
            '.cvat-canvas3d-perspective canvas'
          );
          const t = docRef.querySelector<HTMLCanvasElement & { scene?: ThreeSceneLike }>(
            '.cvat-canvas3d-topview canvas'
          );
          const s = docRef.querySelector<HTMLCanvasElement & { scene?: ThreeSceneLike }>(
            '.cvat-canvas3d-sideview canvas'
          );
          const f = docRef.querySelector<HTMLCanvasElement & { scene?: ThreeSceneLike }>(
            '.cvat-canvas3d-frontview canvas'
          );

          const viewsMap: NonNullable<CvatInternalViewLike['views']> = {
            perspective: p?.scene ? { scene: p.scene, renderer: { domElement: p } } : undefined,
            top: t?.scene ? { scene: t.scene, renderer: { domElement: t } } : undefined,
            side: s?.scene ? { scene: s.scene, renderer: { domElement: s } } : undefined,
            front: f?.scene ? { scene: f.scene, renderer: { domElement: f } } : undefined,
          };

          // Also include any zoomed/expanded Top/Side/Front canvas mounted anywhere in the DOM
          // (must have its own distinct THREE.Scene so we never alias the perspective scene!)
          const allSceneCanvases = docRef.querySelectorAll<
            HTMLCanvasElement & { scene?: ThreeSceneLike }
          >('canvas');
          let extraIdx = 0;
          for (const c of allSceneCanvases) {
            if (
              c !== p &&
              c !== t &&
              c !== s &&
              c !== f &&
              c.scene &&
              c.scene !== p?.scene
            ) {
              viewsMap[`ortho_zoom_${extraIdx}`] = {
                scene: c.scene,
                renderer: { domElement: c },
              };
              extraIdx += 1;
            }
          }

          return viewsMap;
        },
        get drawnObjects() {
          const map: Record<number, CvatDrawnObjectEntry> = {};
          const p = docRef.querySelector<
            HTMLCanvasElement & { getDrawnObjects?: () => CvatDrawnObjectEntry[] }
          >('.cvat-canvas3d-perspective canvas');
          if (typeof p?.getDrawnObjects === 'function') {
            const list = p.getDrawnObjects();
            if (Array.isArray(list)) {
              list.forEach((item, idx) => {
                const id = item?.data?.clientID ?? item?.state?.clientID ?? idx;
                map[id] = item;
              });
            }
          }
          return map;
        },
      };
    }

    const frameAttr = perspCanvas.getAttribute('data-frame-number');
    const parsedFrame = frameAttr !== null ? Number(frameAttr) : null;

    return {
      view: this.domBackedViewRef,
      model: {
        data: {
          imageID: Number.isFinite(parsedFrame) ? parsedFrame : null,
        },
      },
    };
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
