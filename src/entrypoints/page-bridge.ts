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
import {
  installPointerButtonEventTracking,
  lockRaycasterHoverToActiveObject,
  type RaycasterLike,
} from '../integration/cvat/runtime/hover-lock';
import {
  ActiveObjectCameraFollower,
  attachActiveObjectCameraFollow,
  type FollowModelLike,
  type FollowViewLike,
} from '../integration/cvat/runtime/camera-follow';
import {
  evaluateActiveObjectQaReport,
  extractSidebarDomLabelAndAttributes,
  getPerspectivePointCloudPositions,
  QA_OVERLAY_ELEMENT_ID,
  renderActiveObjectQaOverlayDom,
  renderActiveObjectQaOverlayLoadingDom,
} from '../integration/cvat/runtime/active-object-qa-overlay';
import { OrthoViewMaximizer, type OrthoViewName } from '../integration/cvat/runtime/ortho-view-maximizer';
import {
  OrthoCuboidEditor,
  type OrthoCameraLike,
} from '../integration/cvat/runtime/ortho-cuboid-editor';

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
  private readonly cameraFollower = new ActiveObjectCameraFollower(
    () => this.getActiveObjectClientId(this.cachedInstance),
    () => this.preRenderEnhancer.getOptions().followActiveObject ?? true
  );
  private cachedInstance: CvatCanvas3dLike | null = null;
  private lastQaSignature = '';
  private qaEvalTimer: ReturnType<typeof setTimeout> | null = null;
  private domSyncRafId: number | null = null;
  private globalStateUpdateRafId: number | null = null;
  private cachedPerspCanvas: (HTMLCanvasElement & { scene?: ThreeSceneLike; getDrawnObjects?: () => CvatDrawnObjectEntry[] }) | null = null;
  private cachedTopCanvas: (HTMLCanvasElement & { scene?: ThreeSceneLike }) | null = null;
  private cachedSideCanvas: (HTMLCanvasElement & { scene?: ThreeSceneLike }) | null = null;
  private cachedFrontCanvas: (HTMLCanvasElement & { scene?: ThreeSceneLike }) | null = null;

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
    installPointerButtonEventTracking(this.win);
    // W/A/S/D/Q/E nudge (while zoomed) + edge resize in Top/Side/Front views
    const orthoEditor = new OrthoCuboidEditor(
      {
        getMaximizedView: () => orthoMaximizer.getMaximizedView(),
        getActivePoints: () => this.getActiveCuboidPoints(),
        getViewCamera: (view) => this.getOrthoViewCamera(view),
        previewPoints: (clientID, points) => this.previewCuboidPoints(clientID, points),
        commitPoints: (clientID, points) => {
          void this.commitCuboidPoints(clientID, points);
        },
      },
      this.doc,
      this.win
    );
    // Keys 1/2/3 toggle maximize of Top/Side/Front orthographic views
    const orthoMaximizer = new OrthoViewMaximizer(this.doc, this.win, (view) => {
      if (view === null) {
        orthoEditor.flushPendingCommit();
      }
    });
    const uninstallOrthoEditor = orthoEditor.install();
    const uninstallOrthoMaximizer = orthoMaximizer.install();

    const onInteractiveChange = (event: Event) => {
      const targetEl = event.target as Element | null;
      if (
        targetEl &&
        typeof targetEl.closest === 'function' &&
        targetEl.closest('.cvat-workspace-settings, #cvat-3d-enhancer-workspace-settings')
      ) {
        return;
      }
      this.syncActiveObjectQaOverlay(event.type === 'change');
    };
    this.doc.addEventListener('change', onInteractiveChange, true);
    this.doc.addEventListener('pointerup', onInteractiveChange, true);
    this.doc.addEventListener('keyup', onInteractiveChange, true);

    // Observe DOM for CVAT Settings -> Workspace modal opening and 3D canvas initialization
    if (this.doc.documentElement) {
      let pendingChildListChange = false;
      const runDomSync = () => {
        this.domSyncRafId = null;
        const hadChildList = pendingChildListChange;
        pendingChildListChange = false;
        if (hadChildList) {
          syncEarlyViewportBackgroundDom(
            this.doc,
            this.preRenderEnhancer.getOptions().whiteBackground
          );
          this.tryMountWorkspaceSettingsCheckboxes();
          if (this.checkForNewlyMountedCanvases()) {
            this.preRenderEnhancer.markViewStructureChanged();
          }
        }
        this.tryMountObjectItemDimensionSyncControls();
        const instance = this.getActiveCanvas3dInstance();
        if (instance) {
          this.preRenderEnhancer.ensureHooked(instance);
          this.ensureActiveObjectHoverLock(instance);
        }
        this.syncActiveObjectQaOverlay();
      };

      this.settingsObserver = new MutationObserver((records) => {
        let hasRelevantMutation = false;
        for (let i = 0; i < records.length; i += 1) {
          const rec = records[i]!;
          const targetNode = rec.target as Element | null;
          if (
            targetNode &&
            (targetNode.id === QA_OVERLAY_ELEMENT_ID ||
              targetNode.parentElement?.id === QA_OVERLAY_ELEMENT_ID)
          ) {
            continue;
          }
          hasRelevantMutation = true;
          if (rec.type === 'childList') {
            pendingChildListChange = true;
          }
        }
        if (!hasRelevantMutation) {
          return;
        }
        if (this.domSyncRafId === null) {
          const raf = this.win.requestAnimationFrame?.bind(this.win);
          if (typeof raf === 'function') {
            this.domSyncRafId = raf(runDomSync);
          } else {
            runDomSync();
          }
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
      this.ensureActiveObjectHoverLock(initialInstance);
    }
    this.syncActiveObjectQaOverlay(true);

    return () => {
      this.doc.removeEventListener('plugins.ready', onPluginReady);
      this.win.removeEventListener('message', this.handleMessage);
      this.doc.removeEventListener('change', onInteractiveChange, true);
      this.doc.removeEventListener('pointerup', onInteractiveChange, true);
      this.doc.removeEventListener('keyup', onInteractiveChange, true);
      uninstallOrthoMaximizer();
      uninstallOrthoEditor();
      if (this.domSyncRafId !== null) {
        this.win.cancelAnimationFrame?.(this.domSyncRafId);
        this.domSyncRafId = null;
      }
      this.clearQaEvalTimer();
      this.settingsObserver?.disconnect();
      this.settingsObserver = null;
    };
  }

  private ensureActiveObjectHoverLock(instance: CvatCanvas3dLike): void {
    this.cachedInstance = instance;
    const perspective = instance.view?.views?.perspective as
      | { rayCaster?: { renderer?: RaycasterLike } }
      | undefined;
    lockRaycasterHoverToActiveObject(perspective?.rayCaster?.renderer, () =>
      this.getActiveObjectClientId(instance)
    );

    // Keep the active object pinned at the same screen position across frame changes
    const perspCamera = (instance.view?.views?.perspective as { camera?: unknown } | undefined)
      ?.camera;
    if (perspCamera) {
      attachActiveObjectCameraFollow(
        instance.view as unknown as FollowViewLike,
        this.cameraFollower,
        () => instance.model as FollowModelLike | undefined
      );
    }
  }

  private getActiveObjectClientId(instance?: CvatCanvas3dLike | null): string | null {
    if (this.reduxStore) {
      try {
        const annotation = this.reduxStore.getState().annotation as
          | { annotations?: { activatedStateID?: number | null } }
          | undefined;
        const activated = annotation?.annotations?.activatedStateID;
        if (typeof activated === 'number' && Number.isFinite(activated)) {
          return String(activated);
        }
        if (activated === null) {
          return null;
        }
      } catch {
        // Fall back to Canvas3d model state
      }
    }
    const modelData = (instance?.model as
      | { data?: { activeElement?: { clientID?: string | number | null } } }
      | undefined)?.data;
    const fallback = modelData?.activeElement?.clientID;
    if (fallback !== undefined && fallback !== null && String(fallback) !== '') {
      return String(fallback);
    }

    const activeSidebarEl = this.doc.querySelector<HTMLElement>(
      '.cvat-objects-sidebar-state-active-item[id^="cvat-objects-sidebar-state-item-"]'
    );
    if (activeSidebarEl) {
      const match = /^cvat-objects-sidebar-state-item-(\d+)$/.exec(activeSidebarEl.id);
      if (match?.[1]) {
        return match[1];
      }
    }
    return null;
  }

  private clearQaEvalTimer(): void {
    if (this.qaEvalTimer !== null) {
      clearTimeout(this.qaEvalTimer);
      this.qaEvalTimer = null;
    }
  }

  private syncActiveObjectQaOverlay(force = false): void {
    const enabled = this.preRenderEnhancer.getOptions().enableActiveObjectWarnings ?? true;
    if (!enabled) {
      this.clearQaEvalTimer();
      if (this.lastQaSignature !== 'disabled') {
        this.lastQaSignature = 'disabled';
        renderActiveObjectQaOverlayDom(this.doc, null, false);
      }
      return;
    }

    const instance = this.getActiveCanvas3dInstance();
    const activeIdStr = this.getActiveObjectClientId(instance);
    if (!activeIdStr || !instance?.view) {
      this.clearQaEvalTimer();
      if (this.lastQaSignature !== 'none') {
        this.lastQaSignature = 'none';
        renderActiveObjectQaOverlayDom(this.doc, null, true);
      }
      return;
    }

    const clientID = Number(activeIdStr);
    if (!Number.isFinite(clientID)) {
      this.clearQaEvalTimer();
      renderActiveObjectQaOverlayDom(this.doc, null, true);
      return;
    }

    const drawnObjects = instance.view.drawnObjects ?? {};
    const drawnEntry = drawnObjects[clientID] ?? null;
    let stateOnCurrentFrame: CvatObjectStateLike | null = drawnEntry?.state ?? null;

    if (!stateOnCurrentFrame) {
      const modelObjects = (instance.model as { objects?: CvatObjectStateLike[] } | undefined)
        ?.objects;
      if (Array.isArray(modelObjects)) {
        stateOnCurrentFrame =
          modelObjects.find((s) => Number(s?.clientID) === clientID) ?? null;
      }
    }

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

    const pts = stateOnCurrentFrame?.points ?? drawnEntry?.data?.points ?? [];
    const domFrameAttr =
      instance.view.views?.perspective?.renderer?.domElement?.getAttribute?.('data-frame-number') ??
      null;
    const frame = Number(
      stateOnCurrentFrame?.frame ?? instance.model?.data?.imageID ?? domFrameAttr ?? 0
    );

    const {
      labelName: domLabelName,
      domAttributes,
      isOutsideInDom,
      domPos,
    } = extractSidebarDomLabelAndAttributes(this.doc, clientID);
    const isOutside =
      isOutsideInDom ||
      Boolean(stateOnCurrentFrame?.outside) ||
      Boolean(drawnEntry?.data?.outside) ||
      Boolean(drawnEntry?.state?.outside);

    if (isOutside) {
      this.clearQaEvalTimer();
      const outsideSig = `${clientID}@${frame}::outside`;
      if (force || this.lastQaSignature !== outsideSig) {
        this.lastQaSignature = outsideSig;
        renderActiveObjectQaOverlayDom(this.doc, null, true);
      }
      return;
    }

    const attrSig = JSON.stringify({
      s: stateOnCurrentFrame?.attributes ?? {},
      d: domAttributes,
      l: domLabelName ?? '',
      pos: domPos ?? null,
    });
    const ptsSig = pts
      .slice(0, 9)
      .map((n) => Number(n).toFixed(3))
      .join(',');
    const posArray = getPerspectivePointCloudPositions(instance.view);
    const sig = `${clientID}@${frame}::${ptsSig}::${attrSig}::p${posArray?.length ?? 0}`;

    if (!force && sig === this.lastQaSignature) {
      return;
    }
    this.lastQaSignature = sig;
    this.clearQaEvalTimer();

    const previewLabel =
      (stateOnCurrentFrame as { label?: { name?: string } } | null)?.label?.name ?? domLabelName;

    // Show spinning loading indicator while scanning so we never flash "Không có lỗi" prematurely
    renderActiveObjectQaOverlayLoadingDom(
      this.doc,
      { clientID, labelName: previewLabel },
      true
    );

    const delayMs = !posArray || posArray.length === 0 ? 220 : 120;
    this.qaEvalTimer = setTimeout(() => {
      this.qaEvalTimer = null;
      const latestPosArray = getPerspectivePointCloudPositions(instance.view) ?? posArray;
      const report = evaluateActiveObjectQaReport({
        clientID,
        frame: Number.isFinite(frame) ? frame : 0,
        drawnEntry,
        stateOnCurrentFrame,
        drawnObjects,
        positionArray: latestPosArray,
        fallbackLabelName: domLabelName,
        domAttributes,
        isOutsideOnCurrentFrame: isOutside,
        fallbackPos: domPos,
      });

      renderActiveObjectQaOverlayDom(this.doc, report, true);
    }, delayMs);
  }

  private tryMountWorkspaceSettingsCheckboxes(): void {
    injectCvatWorkspaceSettingsControls(
      this.doc,
      () => this.preRenderEnhancer.getOptions(),
      (next: Cvat3dWorkspaceRenderOptions) => {
        const persisted = writeRenderOptionsToClientSettings(next, this.win.localStorage);
        syncEarlyViewportBackgroundDom(this.doc, persisted.whiteBackground);
        const canvasInstance = this.getActiveCanvas3dInstance();
        if (canvasInstance) {
          this.preRenderEnhancer.ensureHooked(canvasInstance);
          this.ensureActiveObjectHoverLock(canvasInstance);
        }
        this.preRenderEnhancer.setOptions(persisted, canvasInstance);
        this.syncActiveObjectQaOverlay(true);
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
      onAfterSync: () => {
        this.preRenderEnhancer.markDirty();
        const inst = this.getActiveCanvas3dInstance();
        if (inst?.view) {
          this.preRenderEnhancer.applyOnceIfNeeded(inst.view, inst.model);
          this.preRenderEnhancer.requestViewsRedraw();
        }
        this.syncActiveObjectQaOverlay(true);
      },
    });
  }

  /** Active cuboid (drawn entry + ObjectState) on the current frame. */
  private resolveActiveCuboid(): {
    clientID: number;
    entry: CvatDrawnObjectEntry | null;
    state: CvatObjectStateLike | null;
  } | null {
    const instance = this.getActiveCanvas3dInstance();
    const clientID = Number(this.getActiveObjectClientId(instance));
    if (!Number.isFinite(clientID)) {
      return null;
    }
    const entry = instance?.view?.drawnObjects?.[clientID] ?? null;
    let state: CvatObjectStateLike | null = entry?.state ?? null;
    if (!state && this.reduxStore) {
      try {
        const annotation = this.reduxStore.getState().annotation as
          | { annotations?: { states?: CvatObjectStateLike[] } }
          | undefined;
        const states = annotation?.annotations?.states;
        if (Array.isArray(states)) {
          state = states.find((s) => Number(s?.clientID) === clientID) ?? null;
        }
      } catch {
        // Ignore fallback lookup errors
      }
    }
    return { clientID, entry, state };
  }

  private getActiveCuboidPoints(): { clientID: number; points: number[] } | null {
    const active = this.resolveActiveCuboid();
    if (!active || active.state?.lock) {
      return null;
    }
    if (active.state?.shapeType && active.state.shapeType !== 'cuboid') {
      return null;
    }
    const pts =
      Array.isArray(active.state?.points) && active.state.points.length >= 9
        ? active.state.points
        : Array.isArray(active.entry?.data?.points) && active.entry.data.points.length >= 9
          ? active.entry.data.points
          : null;
    return pts ? { clientID: active.clientID, points: [...pts] } : null;
  }

  private getOrthoViewCamera(view: OrthoViewName): OrthoCameraLike | null {
    const isOrtho = (cam: unknown): cam is OrthoCameraLike => {
      const c = cam as OrthoCameraLike | null | undefined;
      return Boolean(c && typeof c.left === 'number' && c.matrixWorld?.elements);
    };
    const instance = this.getActiveCanvas3dInstance();
    const viewCam = (instance?.view?.views?.[view] as { camera?: unknown } | undefined)?.camera;
    if (isOrtho(viewCam)) {
      return viewCam;
    }
    const selectors: Record<OrthoViewName, string> = {
      top: CVAT_DOM_SELECTORS.TOP_VIEW_WRAPPER,
      side: CVAT_DOM_SELECTORS.SIDE_VIEW_WRAPPER,
      front: CVAT_DOM_SELECTORS.FRONT_VIEW_WRAPPER,
    };
    const canvas = this.doc.querySelector<HTMLCanvasElement>(`${selectors[view]} canvas`);
    const rendered = this.preRenderEnhancer.getLastRenderCameraForCanvas(canvas);
    return isOrtho(rendered) ? rendered : null;
  }

  /** Live visual update of the active cuboid meshes (no persistence / undo entry). */
  private previewCuboidPoints(clientID: number, points: number[]): void {
    const entry = this.getActiveCanvas3dInstance()?.view?.drawnObjects?.[clientID];
    if (!entry) {
      return;
    }
    const [x, y, z, rx, ry, rz, sx, sy, sz] = points as [
      number, number, number, number, number, number, number, number, number,
    ];
    const cuboid = entry.cuboid as CvatDrawnObjectEntry['cuboid'] & {
      setPosition?: (x: number, y: number, z: number) => void;
    };
    if (typeof cuboid.setPosition === 'function') cuboid.setPosition(x, y, z);
    if (typeof cuboid.setRotation === 'function') cuboid.setRotation(rx, ry, rz);
    if (typeof cuboid.setScale === 'function') cuboid.setScale(sx, sy, sz);
    for (const key of ['perspective', 'top', 'side', 'front'] as const) {
      const mesh = cuboid[key];
      if (!mesh) continue;
      if (mesh.position) Object.assign(mesh.position, { x, y, z });
      if (mesh.rotation) Object.assign(mesh.rotation, { x: rx, y: ry, z: rz });
      if (mesh.scale) Object.assign(mesh.scale, { x: sx, y: sy, z: sz });
    }
    if (Array.isArray(entry.data?.points)) {
      for (let i = 0; i < 9; i += 1) entry.data.points[i] = points[i]!;
    }
    this.preRenderEnhancer.markDirty();
    this.preRenderEnhancer.requestViewsRedraw();
  }

  /** Persists cuboid points through CVAT (same path as the existing dimension tools). */
  private async commitCuboidPoints(clientID: number, points: number[]): Promise<void> {
    const active = this.resolveActiveCuboid();
    const state =
      active?.clientID === clientID
        ? active.state
        : (this.getActiveCanvas3dInstance()?.view?.drawnObjects?.[clientID]?.state ?? null);
    if (!state || state.lock) {
      return;
    }
    const prev = Array.isArray(state.points) ? state.points : [];
    const nextPoints = [...points, ...prev.slice(points.length)];

    let dispatchState: CvatObjectStateLike = state;
    try {
      state.points = nextPoints;
      if (state.updateFlags) {
        state.updateFlags.points = true;
      }
      const internalSave = state.__internal?.save;
      if (typeof internalSave === 'function') {
        dispatchState = internalSave(Number(state.frame ?? 0), state);
      } else if (typeof state.save === 'function') {
        dispatchState = await state.save();
      }
    } catch {
      // Fall back to CVAT's canvas.edited handler below
    }

    const perspCanvas = this.doc.querySelector<
      HTMLCanvasElement & {
        updatePosition?: (state: CvatObjectStateLike, points: number[]) => void;
      }
    >('.cvat-canvas3d-perspective canvas');
    if (perspCanvas && dispatchState) {
      if (typeof perspCanvas.updatePosition === 'function') {
        perspCanvas.updatePosition(dispatchState, [...nextPoints]);
      } else {
        perspCanvas.dispatchEvent(
          new CustomEvent('canvas.edited', {
            bubbles: false,
            cancelable: true,
            detail: { state: dispatchState, points: [...nextPoints] },
          })
        );
      }
    }

    this.preRenderEnhancer.markDirty();
    const inst = this.getActiveCanvas3dInstance();
    if (inst?.view) {
      this.preRenderEnhancer.applyOnceIfNeeded(inst.view, inst.model);
      this.preRenderEnhancer.requestViewsRedraw();
    }
    this.syncActiveObjectQaOverlay(true);
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
              if (this.globalStateUpdateRafId !== null) {
                this.win.cancelAnimationFrame?.(this.globalStateUpdateRafId);
                this.globalStateUpdateRafId = null;
              }
              this.reduxStore = null;
            },
            globalStateDidUpdate: () => {
              if (this.globalStateUpdateRafId !== null) {
                return;
              }
              const raf = this.win.requestAnimationFrame?.bind(this.win);
              if (typeof raf === 'function') {
                this.globalStateUpdateRafId = raf(() => {
                  this.globalStateUpdateRafId = null;
                  this.handleGlobalStateUpdate();
                });
              } else {
                this.handleGlobalStateUpdate();
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

  private handleGlobalStateUpdate(): void {
    const activeInstance = this.getActiveCanvas3dInstance();
    if (activeInstance) {
      this.preRenderEnhancer.ensureHooked(activeInstance);
      this.ensureActiveObjectHoverLock(activeInstance);
    }
    this.syncActiveObjectQaOverlay();
  }

  private getActiveCanvas3dInstance(): CvatCanvas3dLike | null {
    if (this.reduxStore) {
      try {
        const state = this.reduxStore.getState();
        const annotation = state.annotation as Record<string, unknown> | undefined;
        const canvas = annotation?.canvas as Record<string, unknown> | undefined;
        const instance = canvas?.instance as CvatCanvas3dLike | undefined;
        if (instance && (typeof instance.configure === 'function' || instance.view)) {
          if (instance.view?.views?.perspective?.scene) {
            return instance;
          }
          const domInstance = this.resolveDomBackedCanvas3dInstance();
          if (domInstance?.view) {
            return {
              configure: instance.configure?.bind(instance),
              keyControls: instance.keyControls?.bind(instance),
              fit: instance.fit?.bind(instance),
              view: domInstance.view,
              model: instance.model ?? domInstance.model,
            };
          }
          return instance;
        }
      } catch {
        // Fall through to DOM-backed 3D canvas inspection
      }
    }

    return this.resolveDomBackedCanvas3dInstance();
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

  private bindDomPerspectiveCanvasEvents(): (HTMLCanvasElement & {
    scene?: ThreeSceneLike;
    getDrawnObjects?: () => CvatDrawnObjectEntry[];
  }) | null {
    if (!this.cachedPerspCanvas || !this.cachedPerspCanvas.isConnected) {
      this.cachedPerspCanvas = this.doc.querySelector<
        HTMLCanvasElement & {
          scene?: ThreeSceneLike;
          getDrawnObjects?: () => CvatDrawnObjectEntry[];
        }
      >('.cvat-canvas3d-perspective canvas');
    }
    const perspCanvas = this.cachedPerspCanvas;

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
        this.syncActiveObjectQaOverlay(true);
      });
      perspCanvas.addEventListener('canvas.edited', () => {
        this.syncActiveObjectQaOverlay(true);
      });
    }

    return perspCanvas;
  }

  private getViewsMap(): NonNullable<CvatInternalViewLike['views']> {
    if (!this.cachedPerspCanvas?.isConnected) {
      this.cachedPerspCanvas = this.doc.querySelector<
        HTMLCanvasElement & {
          scene?: ThreeSceneLike;
          getDrawnObjects?: () => CvatDrawnObjectEntry[];
        }
      >('.cvat-canvas3d-perspective canvas');
    }
    if (!this.cachedTopCanvas?.isConnected) {
      this.cachedTopCanvas = this.doc.querySelector<HTMLCanvasElement & { scene?: ThreeSceneLike }>(
        '.cvat-canvas3d-topview canvas'
      );
    }
    if (!this.cachedSideCanvas?.isConnected) {
      this.cachedSideCanvas = this.doc.querySelector<HTMLCanvasElement & { scene?: ThreeSceneLike }>(
        '.cvat-canvas3d-sideview canvas'
      );
    }
    if (!this.cachedFrontCanvas?.isConnected) {
      this.cachedFrontCanvas = this.doc.querySelector<HTMLCanvasElement & { scene?: ThreeSceneLike }>(
        '.cvat-canvas3d-frontview canvas'
      );
    }

    const p = this.cachedPerspCanvas;
    const t = this.cachedTopCanvas;
    const s = this.cachedSideCanvas;
    const f = this.cachedFrontCanvas;

    const viewsMap: NonNullable<CvatInternalViewLike['views']> = {
      perspective: p?.scene ? { scene: p.scene, renderer: { domElement: p } } : undefined,
      top: t?.scene ? { scene: t.scene, renderer: { domElement: t } } : undefined,
      side: s?.scene ? { scene: s.scene, renderer: { domElement: s } } : undefined,
      front: f?.scene ? { scene: f.scene, renderer: { domElement: f } } : undefined,
    };

    // Also include any zoomed/expanded Top/Side/Front canvas mounted anywhere in the DOM
    // (must have its own distinct THREE.Scene so we never alias the perspective scene!)
    const allSceneCanvases = this.doc.querySelectorAll<
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
  }

  /**
   * Fallback/direct bridge that reads CVAT's `canvas.scene` (`THREE.Scene`) and
   * `canvas.getDrawnObjects()` defined directly on `.cvat-canvas3d-perspective canvas`,
   * `.cvat-canvas3d-orthographic-view canvas`, and any newly opened zoom/modal `<canvas>`.
   */
  private resolveDomBackedCanvas3dInstance(): CvatCanvas3dLike | null {
    const perspCanvas = this.bindDomPerspectiveCanvasEvents();

    if (!perspCanvas?.scene) {
      return null;
    }

    if (!this.domBackedViewRef || this.lastDomCanvasRef !== perspCanvas) {
      this.lastDomCanvasRef = perspCanvas;
      const docRef = this.doc;
      const getViews = () => this.getViewsMap();
      this.domBackedViewRef = {
        get views() {
          return getViews();
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
        fixedOrthoPointSize: current.fixedOrthoPointSize ?? true,
        followActiveObject: current.followActiveObject ?? true,
        enableActiveObjectWarnings: current.enableActiveObjectWarnings ?? true,
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
      // Only reply with a signed error envelope if the sender already presented our valid
      // sessionToken (e.g. schema/payload validation failed). Never echo this.sessionToken
      // back to an unauthenticated/forged caller!
      if (candidate.sessionToken === this.sessionToken) {
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
      }
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

// Auto-initialize when injected into page (even if scriptEl was cleaned up before ES module load completed)
if (typeof document !== 'undefined' && typeof window !== 'undefined') {
  const winFlags = window as unknown as { __cvat3dEnhancerPageBridgeStarted?: boolean };
  if (!winFlags.__cvat3dEnhancerPageBridgeStarted) {
    winFlags.__cvat3dEnhancerPageBridgeStarted = true;
    const scriptEl = document.querySelector<HTMLScriptElement>(
      'script[data-cvat-enhancer-bridge-token]'
    );
    const token =
      scriptEl?.dataset.cvatEnhancerBridgeToken || MessageProtocol.generateSessionToken();
    if (scriptEl?.dataset.cvatEnhancerBridgeToken) {
      // Immediately remove token attribute from DOM so page scripts cannot scrape it later
      delete scriptEl.dataset.cvatEnhancerBridgeToken;
    }
    const host = new PageBridgeRuntimeHost(token);
    host.start();
  }
}
