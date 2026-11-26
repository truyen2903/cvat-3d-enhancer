import { removeMeowUi } from '../integration/cvat/runtime/meow-ui';
import { canReuseVisibleCuboidBounds } from '../integration/cvat/runtime/visible-cuboids';
import {
  beginPerfSpan,
  endPerfSpan,
  installPerfProbeConsole,
  PERF_CLICK_SPAN,
  PERF_FRAME_SPAN,
  timePerf,
} from '../integration/cvat/runtime/perf-probe';
import { TrackGhostOverlay } from '../integration/cvat/runtime/track-ghost-overlay';
import { installMouseFrameNavigation } from '../integration/cvat/runtime/mouse-frame-navigation';
import {
  installSidebarQuickFilterGuard,
  resolveSidebarObjectContext,
  sidebarHasRideState,
  syncSidebarRideState,
  sidebarMutableAttributes,
  sidebarYawRangeOptions,
  syncSidebarMutableAttribute,
} from '../integration/cvat/runtime/sidebar-enhancements';
import { BASE_GUIDE_CLASS, CuboidBaseGuide } from '../integration/cvat/runtime/cuboid-base-guide';
import type { GuideCameraLike } from '../integration/cvat/runtime/cuboid-base-guide';
import { QcMarginOverlay } from '../integration/cvat/runtime/qc-margin-overlay';
import type { QcMarginTarget } from '../integration/cvat/runtime/qc-margin-overlay';
import { MessageProtocol } from '../integration/cvat/bridge';
import type { CanvasVisualConfigInput, PageRuntimeProbeResult } from '../integration/cvat/runtime';
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
  syncTrackCuboidDimension,
  type ThreeSceneLike,
  writeRenderOptionsToClientSettings,
} from '../integration/cvat/runtime/pre-render-enhancer';
import {
  DrawnObjectsCache,
  findObjectStateByClientId,
  invalidateSpatial2DBoxLookup,
  isNumericClientIdName,
} from '../integration/cvat/runtime/state-lookup';
import { BRIDGE_CHANNEL, type CameraPresetAction, CVAT_DOM_SELECTORS } from '../shared/constants';
import type { BridgeRequestEnvelope } from '../shared/types';
import {
  installPointerButtonEventTracking,
  invalidateHoverSpatialIndex,
  lockRaycasterHoverToActiveObject,
  unlockRaycasterHover,
  type RaycasterLike,
} from '../integration/cvat/runtime/hover-lock';
import {
  ActiveObjectCameraFollower,
  attachActiveObjectCameraFollow,
  type FollowModelLike,
  type FollowViewLike,
} from '../integration/cvat/runtime/camera-follow';
import { CanvasSelectionController } from '../integration/cvat/runtime/canvas-selection';
import type { ProjectionCamera } from '../integration/cvat/runtime/canvas-picking';
import { MultiObjectRunner } from '../integration/cvat/runtime/multi-object-actions';
import {
  readCvatContext,
  readUnfilteredFrameStates,
  refreshCvatAnnotations,
} from '../integration/cvat/runtime/cvat-annotation-write';
import { showMeowToast } from '../integration/cvat/runtime/meow-toast';
import type { OrthoViewName } from '../integration/cvat/runtime/ortho-view-maximizer';
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

type PerspDomCanvasElement = HTMLCanvasElement & {
  scene?: ThreeSceneLike;
  getDrawnObjects?: () => CvatDrawnObjectEntry[];
  updatePosition?: (state: CvatObjectStateLike, points: number[]) => void;
};

type SceneDomCanvasElement = HTMLCanvasElement & {
  scene?: ThreeSceneLike;
};

type CanvasOrthoRole = 'top' | 'side' | 'front' | 'other';

const SIDEBAR_ITEM_ID_PREFIX = 'cvat-objects-sidebar-state-item-';
const SIDEBAR_CARD_SELECTOR =
  '.cvat-objects-sidebar-state-item, [id^="cvat-objects-sidebar-state-item-"]';
const MAX_TARGETED_SIDEBAR_CARDS = 128;

const IGNORED_MUTATION_SELECTOR =
  `.cvat-appearance-block, .${BASE_GUIDE_CLASS}, ` +
  '#meow-toast-stack, [data-meow-owned], .meow-selection-ui, #cvat-3d-enhancer-workspace-settings-section, ' +
  '[data-enhancer-workspace-settings], .ant-select-dropdown, .ant-tooltip, .ant-popover';

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

function isIgnoredMutationNode(node: Node): boolean {
  if (node.nodeType !== 1) {
    return true;
  }
  const el = node as Element;
  if (
    el.id === 'meow-toast-stack' ||
    el.id === 'meow-ui-style' ||
    el.hasAttribute('data-meow-owned') ||
    el.classList.contains('meow-selection-ui') ||
    el.id === 'cvat-3d-enhancer-workspace-settings-section' ||
    el.classList.contains(BASE_GUIDE_CLASS) ||
    el.classList.contains('cvat-appearance-block') ||
    el.classList.contains('ant-select-dropdown') ||
    el.classList.contains('ant-tooltip') ||
    el.classList.contains('ant-popover') ||
    el.hasAttribute('data-enhancer-workspace-settings')
  ) {
    return true;
  }
  const firstChild = el.firstElementChild;
  if (
    firstChild &&
    el.childElementCount === 1 &&
    (firstChild.classList.contains('ant-select-dropdown') ||
      firstChild.classList.contains('ant-tooltip') ||
      firstChild.classList.contains('ant-popover'))
  ) {
    return true;
  }
  return false;
}

function isOnlyEnhancerRowAdded(rec: MutationRecord): boolean {
  if (rec.removedNodes.length > 0 || rec.addedNodes.length === 0) {
    return false;
  }
  for (let i = 0; i < rec.addedNodes.length; i += 1) {
    const node = rec.addedNodes[i]!;
    if (
      node.nodeType !== 1 ||
      !(node as Element).classList.contains('cvat-3d-enhancer-dim-sync-row')
    ) {
      return false;
    }
  }
  return true;
}

function isInScene(root: unknown, target: unknown): boolean {
  if (!root || !target) {
    return false;
  }
  let cur: unknown = target;
  for (let depth = 0; cur && depth < 16; depth += 1) {
    if (cur === root) {
      return true;
    }
    cur = (cur as { parent?: unknown }).parent;
  }
  if ((target as { parent?: unknown }).parent === undefined) {
    const topChildren = (root as { children?: unknown[] }).children;
    return Array.isArray(topChildren) && topChildren.length <= 64 && topChildren.includes(target);
  }
  return false;
}

export class PageBridgeRuntimeHost {
  private readonly win: Window & CvatWindowGlobals;
  private readonly doc: Document;
  private readonly sessionToken: string;
  private readonly preRenderEnhancer: Cvat3dPreRenderEnhancer;
  private reduxStore: CvatReduxStoreLike | null = null;
  private pluginRegistered = false;
  private readonly hoverRaycasters = new Set<RaycasterLike>();
  private settingsObserver: MutationObserver | null = null;
  private readonly hookedPerspectiveCanvases = new WeakSet<HTMLCanvasElement>();
  private readonly hookedSetupCanvases = new WeakSet<HTMLCanvasElement>();
  private readonly knownDomCanvases = new WeakSet<HTMLCanvasElement>();
  private readonly canvasOrthoRoleCache = new WeakMap<HTMLCanvasElement, CanvasOrthoRole>();
  private readonly domDrawnObjectsCache = new DrawnObjectsCache<CvatDrawnObjectEntry>();
  private lastDrawnLookupCanvas: object | null = null;
  private lastDrawnLookupGen = -1;
  private lastDrawnLookupClientId = NaN;
  private lastDrawnLookupEntry: CvatDrawnObjectEntry | null = null;
  private domBackedViewRef: CvatInternalViewLike | null = null;
  private lastDomCanvasRef: HTMLCanvasElement | null = null;
  private cachedDomInstanceView: CvatInternalViewLike | null = null;
  private cachedDomFrameAttr: string | null = null;
  private cachedDomInstance: CvatCanvas3dLike | null = null;
  private cachedHybridSourceInstance: CvatCanvas3dLike | null = null;
  private cachedHybridDomView: CvatInternalViewLike | null = null;
  private cachedHybridModel: CvatInternalCanvas3dLike['model'] | undefined = undefined;
  private cachedHybridModelFrame: number | null | undefined = undefined;
  private cachedHybridWrapper: CvatCanvas3dLike | null = null;
  private readonly cameraFollower = new ActiveObjectCameraFollower(
    () => this.getActiveObjectClientId(this.cachedInstance),
    () => this.preRenderEnhancer.getOptionsReadonly().followActiveObject ?? true
  );
  private trackGhosts: TrackGhostOverlay | null = null;
  private selection: CanvasSelectionController | null = null;
  private baseGuide: CuboidBaseGuide | null = null;
  private cachedInstance: CvatCanvas3dLike | null = null;
  private domSyncRafId: number | null = null;
  private globalStateUpdateRafId: number | null = null;
  private cachedPerspCanvas: PerspDomCanvasElement | null = null;
  private cachedTopCanvas: SceneDomCanvasElement | null = null;
  private cachedSideCanvas: SceneDomCanvasElement | null = null;
  private cachedFrontCanvas: SceneDomCanvasElement | null = null;
  private readonly extraSceneCanvases = new Set<SceneDomCanvasElement>();
  private readonly extraCanvasScenes = new WeakMap<HTMLCanvasElement, ThreeSceneLike | undefined>();
  private initialCanvasScanDone = false;
  private viewsMapDirty = true;
  private cachedViewsMap: NonNullable<CvatInternalViewLike['views']> | null = null;
  private cachedPerspScene: ThreeSceneLike | undefined = undefined;
  private cachedTopScene: ThreeSceneLike | undefined = undefined;
  private cachedSideScene: ThreeSceneLike | undefined = undefined;
  private cachedFrontScene: ThreeSceneLike | undefined = undefined;
  private hasReduxSnapshot = false;
  private lastReduxFrame: unknown = undefined;
  private lastReduxActivatedId: unknown = undefined;
  private lastReduxStatesRef: unknown = undefined;
  private lastReduxCanvasInstance: unknown = undefined;
  private lastNumericActiveId = NaN;
  private lastNumericActiveIdStr = '';
  private liveActiveSidebarItems: HTMLCollectionOf<Element> | null = null;
  private cachedActiveSidebarEl: Element | null = null;
  private cachedActiveSidebarRawId = '';
  private cachedActiveSidebarParsedId: string | null = null;

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
    this.tryHookCvatUIPlugin();
  }

  private getCanvasOrthoRole(canvas: HTMLCanvasElement): CanvasOrthoRole {
    const cached = this.canvasOrthoRoleCache.get(canvas);
    if (cached !== undefined) {
      return cached;
    }
    let role: CanvasOrthoRole = 'other';
    const wrapper = canvas.closest?.(
      `${CVAT_DOM_SELECTORS.TOP_VIEW_WRAPPER}, ${CVAT_DOM_SELECTORS.SIDE_VIEW_WRAPPER}, ${CVAT_DOM_SELECTORS.FRONT_VIEW_WRAPPER}`
    );
    if (wrapper) {
      if (wrapper.classList.contains('cvat-canvas3d-topview')) {
        role = 'top';
      } else if (wrapper.classList.contains('cvat-canvas3d-sideview')) {
        role = 'side';
      } else if (wrapper.classList.contains('cvat-canvas3d-frontview')) {
        role = 'front';
      }
    }
    this.canvasOrthoRoleCache.set(canvas, role);
    return role;
  }

  public start(): () => void {
    const removePerfProbe = installPerfProbeConsole(this.win);
    const onPerfPointerDown = (event: PointerEvent): void => {
      const target = event.target as Element | null;
      if (event.button === 0 && target?.closest?.('.cvat-canvas3d-perspective')) {
        beginPerfSpan(PERF_CLICK_SPAN);
      }
    };
    this.win.addEventListener('pointerdown', onPerfPointerDown, true);
    const removeMouseFrameNavigation = installMouseFrameNavigation(
      this.doc,
      this.win,
      () => this.preRenderEnhancer.getOptionsReadonly().enableMouseFrameNavigation ?? true
    );
    const removeQuickFilterGuard = installSidebarQuickFilterGuard(
      this.doc,
      this.win,
      () => this.preRenderEnhancer.getOptionsReadonly().disableSidebarQuickFilter ?? true,
      () => this.cameraFollower.reset()
    );
    const baseGuide = (this.baseGuide = new CuboidBaseGuide(
      this.doc,
      () => this.preRenderEnhancer.getOptionsReadonly().showCuboidBaseGuide ?? true
    ));
    const qcMargin = new QcMarginOverlay(this.doc);
    // Alt+P: quick on/off for the QC margin overlay (same toggle as the Workspace checkbox).
    const onQcMarginHotkey = (event: KeyboardEvent): void => {
      if (
        event.code !== 'KeyP' ||
        !event.altKey ||
        event.shiftKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.repeat
      )
        return;
      const target = event.target as Element | null;
      if (target?.closest?.('input,textarea,select,[contenteditable="true"],[role="textbox"]'))
        return;
      event.preventDefault();
      event.stopPropagation();
      const options = this.preRenderEnhancer.getOptionsReadonly();
      const enabled = !(options.showQcMargin ?? true);
      this.applyWorkspaceOptions({ ...options, showQcMargin: enabled });
      showMeowToast(this.doc, `QC vùng đệm P: ${enabled ? 'bật' : 'tắt'}`, 'info');
      if (enabled) this.preRenderEnhancer.requestViewsRedraw();
      else qcMargin.clear();
    };
    this.win.addEventListener('keydown', onQcMarginHotkey, true);
    const trackGhosts = (this.trackGhosts = new TrackGhostOverlay(
      this.doc,
      () => this.preRenderEnhancer.getOptionsReadonly().enableTrackGhosts ?? true,
      () => {
        const active = this.resolveActiveCuboid(true);
        if (!active) return null;
        const state = resolveSidebarObjectContext(this.doc, active.clientID)?.state ?? active.state;
        const canvas = this.doc.querySelector<HTMLCanvasElement>(
          '.cvat-canvas3d-perspective canvas'
        );
        return state && canvas
          ? {
              state,
              canvas,
              camera: this.preRenderEnhancer.getLastRenderCameraForCanvas(
                canvas
              ) as OrthoCameraLike | null,
            }
          : null;
      }
    ));
    const multiRunner = new MultiObjectRunner({
      getStore: () => this.reduxStore,
      afterWrite: () => {
        this.invalidateSceneObjectCaches();
        this.preRenderEnhancer.requestViewsRedraw();
      },
      toast: (message, kind) => {
        showMeowToast(this.doc, message, kind);
      },
    });
    this.selection = new CanvasSelectionController(this.doc, this.win, {
      isEnabled: () => this.preRenderEnhancer.getOptionsReadonly().enableCanvasMultiSelect ?? true,
      isIdle: () => {
        const control = readCvatContext(this.reduxStore).activeControl;
        return control === null || control.toLowerCase() === 'cursor';
      },
      getFrame: () => readCvatContext(this.reduxStore).frame,
      getActiveClientID: () => this.getActiveNumericClientId(),
      getCamera: (canvas) =>
        this.preRenderEnhancer.getLastRenderCameraForCanvas(canvas) as ProjectionCamera | null,
      getDrawnObjects: () => this.getActiveCanvas3dInstance()?.view?.drawnObjects ?? null,
      getDrawnEntry: (id) => this.getDrawnObjectEntryById(this.getActiveCanvas3dInstance(), id),
      restoreColor: (entry) => this.restoreCuboidColor(entry),
      listUnfilteredFrameObjects: async () => {
        const states = await readUnfilteredFrameStates(this.reduxStore);
        if (!states) return null;
        const boxes: { id: number; points: number[] }[] = [];
        for (const state of states) {
          const points = state.points;
          if (typeof state.clientID === 'number' && Array.isArray(points) && points.length >= 9)
            boxes.push({ id: state.clientID, points });
        }
        return boxes;
      },
      filterHistorySize: () => multiRunner.filterHistory.size,
      runAction: async (id, ids) => {
        await multiRunner.run(id, ids, this.getActiveNumericClientId());
      },
      activate: (clientID) => {
        this.reduxStore?.dispatch({
          type: 'ACTIVATE_OBJECT',
          payload: {
            activatedStateID: clientID,
            activatedElementID: null,
            activatedAttributeID: null,
          },
        });
      },
      toast: (message, kind) => {
        showMeowToast(this.doc, message, kind);
      },
    });
    this.syncKeyboardEnabledAttribute();
    const onCanvasRender = (
      canvas: HTMLCanvasElement,
      camera: unknown,
      scene?: ThreeSceneLike
    ): void => {
      trackGhosts.render(canvas, camera as OrthoCameraLike);
      const cam = camera as OrthoCameraLike;
      qcMargin.render(
        canvas,
        cam as unknown as GuideCameraLike,
        this.resolveQcMarginTarget(Boolean(cam?.isOrthographicCamera))
      );
      if (!cam?.isOrthographicCamera) return;
      if ((this.preRenderEnhancer.getOptionsReadonly().showCuboidBaseGuide ?? true) === false) {
        baseGuide.update(canvas, cam, null);
        return;
      }
      const role = this.getCanvasOrthoRole(canvas);
      if (role === 'top') return;
      const active = this.resolveActiveCuboid(false);
      const points = active?.entry?.data.points ?? active?.state?.points ?? null;
      const hidden =
        active?.state?.hidden ||
        active?.state?.outside ||
        active?.entry?.data.hidden ||
        active?.entry?.data.outside;
      const cuboid = active?.entry?.cuboid;
      const mesh =
        role === 'side' || role === 'front'
          ? cuboid?.[role]
          : cuboid?.side && isInScene(scene, cuboid.side)
            ? cuboid.side
            : cuboid?.front && isInScene(scene, cuboid.front)
              ? cuboid.front
              : undefined;
      baseGuide.update(canvas, cam, hidden ? null : points, mesh);
    };
    this.preRenderEnhancer.setCanvasRenderListener((canvas, camera, scene) =>
      timePerf('meow.renderListener', () => onCanvasRender(canvas, camera, scene))
    );
    const onPluginReady = () => {
      this.tryHookCvatUIPlugin();
    };
    this.doc.addEventListener('plugins.ready', onPluginReady);
    this.win.addEventListener('message', this.handleMessage);
    installPointerButtonEventTracking(this.win);
    // W/A/S/D/Q/E nudge (while zoomed) + edge resize in Top/Side/Front views
    const orthoEditor = new OrthoCuboidEditor(
      {
        getKeyboardOptions: () => {
          const options = this.preRenderEnhancer.getOptionsReadonly();
          return {
            enabled: options.enableOrthoKeyboard,
            highSensitivity: options.fasterOrthoKeyboard,
            immediateCommit: options.immediateKeyboardCommit,
          };
        },
        getMaximizedView: () => null,
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
    const uninstallOrthoEditor = orthoEditor.install();

    // Observe DOM for CVAT Settings -> Workspace modal opening and 3D canvas initialization
    if (this.doc.documentElement) {
      let pendingChildListChange = false;
      let pendingSidebarChange = false;
      let fullSidebarReconcile = false;
      const dirtySidebarCards = new Set<HTMLElement>();

      let structuralRoots = new Set<Element>();
      const pendingMountRoots = new Set<Element>();
      let rootsChanged = false;
      const observeRoots = (): void => {
        const observer = this.settingsObserver;
        if (!observer) return;
        observer.disconnect();
        structuralRoots = new Set<Element>();
        const roots = this.doc.querySelectorAll(
          '.cvat-objects-sidebar, canvas, .cvat-canvas-container, ' +
            '.cvat-canvas3d-perspective, .cvat-canvas3d-orthographic-view, ' +
            '.cvat-workspace-settings, .ant-modal-root'
        );
        for (const root of roots) {
          observer.observe(root, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: root.matches('.cvat-objects-sidebar')
              ? ['class', 'aria-label', 'id', 'data-client-id']
              : ['data-frame-number'],
          });
          // Watch only direct children along each mount path, so replacing a React root
          // is detected without subscribing to every sidebar descendant's attributes.
          for (let parent = root.parentElement; parent; parent = parent.parentElement) {
            if (!parent.matches('.cvat-objects-sidebar, .ant-modal-root')) {
              structuralRoots.add(parent);
            }
          }
        }
        if (this.doc.body) structuralRoots.add(this.doc.body);
        structuralRoots.add(this.doc.documentElement);
        for (const root of structuralRoots) {
          // Do not overwrite a scoped subtree registration above.
          if (![...roots].includes(root)) observer.observe(root, { childList: true });
        }
        if (this.doc.body) pendingMountRoots.add(this.doc.body);
        const scopedRoots = new Set(roots);
        // Split discovery along known mount paths. An unclassified sibling can receive a
        // sidebar/modal later even when another sibling has already mounted its canvas.
        for (const root of pendingMountRoots) {
          if (!root.isConnected || scopedRoots.has(root)) {
            pendingMountRoots.delete(root);
          } else if ([...roots].some((known) => root.contains(known))) {
            pendingMountRoots.delete(root);
            for (const child of root.children) {
              if (!scopedRoots.has(child) && !isIgnoredMutationNode(child))
                pendingMountRoots.add(child);
            }
          } else {
            observer.observe(root, { childList: true, subtree: true });
          }
        }
      };

      const runDomSyncImpl = (): void => {
        this.domSyncRafId = null;
        baseGuide.prune();
        const hadChildList = pendingChildListChange;
        if (hadChildList || rootsChanged) observeRoots();
        rootsChanged = false;
        pendingChildListChange = false;
        const hadSidebarChange = pendingSidebarChange;
        pendingSidebarChange = false;
        const reconcileAllSidebar = fullSidebarReconcile;
        fullSidebarReconcile = false;
        let cardsSnapshot: HTMLElement[] | undefined;
        if (!reconcileAllSidebar && dirtySidebarCards.size > 0) {
          cardsSnapshot = [];
          for (const c of dirtySidebarCards) {
            if (c.isConnected) {
              cardsSnapshot.push(c);
            }
          }
        }
        dirtySidebarCards.clear();

        if (hadChildList) {
          this.tryMountWorkspaceSettingsCheckboxes();
          const mountedCanvases = this.checkForNewlyMountedCanvases();
          if (mountedCanvases) {
            this.preRenderEnhancer.markViewStructureChanged();
          }
          const instance = this.getActiveCanvas3dInstance();
          if (instance) {
            this.preRenderEnhancer.ensureHooked(instance);
            this.ensureActiveObjectHoverLock(instance);
            if (mountedCanvases) this.preRenderEnhancer.requestViewsRedraw();
          }
        }
        if (hadSidebarChange) {
          if (reconcileAllSidebar) {
            this.tryMountObjectItemDimensionSyncControls();
          } else if (cardsSnapshot && cardsSnapshot.length > 0) {
            this.tryMountObjectItemDimensionSyncControls(cardsSnapshot);
          }
        }
        this.settingsObserver?.takeRecords();
      };
      const runDomSync = (): void => timePerf('meow.domSync', runDomSyncImpl);

      const onSettingsMutations = (records: MutationRecord[]): void => {
        let hasRelevantMutation = false;
        let clearedClassGhosts = false;
        for (let i = 0; i < records.length; i += 1) {
          const rec = records[i]!;
          // Class churn never needs a DOM reconciliation or ancestor selector walk.
          if (rec.type === 'attributes' && rec.attributeName === 'class') {
            if (!clearedClassGhosts && (rec.target as Element).matches(SIDEBAR_CARD_SELECTOR)) {
              clearedClassGhosts = true;
              this.trackGhosts?.clear();
            }
            continue;
          }
          const targetNode =
            rec.target.nodeType === 1 ? (rec.target as Element) : rec.target.parentElement;
          if (!targetNode) {
            continue;
          }
          if (targetNode.closest?.(IGNORED_MUTATION_SELECTOR)) {
            continue;
          }
          if (targetNode.closest?.('.cvat-3d-enhancer-dim-sync-row')) {
            if (rec.type !== 'childList' || rec.removedNodes.length === 0) {
              continue;
            }
          }

          if (rec.type === 'attributes') {
            if (
              rec.attributeName !== 'data-frame-number' &&
              !targetNode.closest?.(
                '.cvat-objects-sidebar, .cvat-objects-sidebar-state-item, .cvat-workspace-settings'
              )
            ) {
              continue;
            }
            hasRelevantMutation = true;
            if (rec.attributeName === 'data-frame-number') {
              this.trackGhosts?.clear();
              this.selection?.clear();
              this.invalidateSceneObjectCaches();
              pendingChildListChange = true;
            }
            if (rec.attributeName === 'class' && targetNode.matches(SIDEBAR_CARD_SELECTOR)) {
              this.trackGhosts?.clear();
            }
            const card = targetNode.closest?.<HTMLElement>(SIDEBAR_CARD_SELECTOR);
            if (card) {
              pendingSidebarChange = true;
              if (!fullSidebarReconcile) {
                if (dirtySidebarCards.size >= MAX_TARGETED_SIDEBAR_CARDS) {
                  fullSidebarReconcile = true;
                  dirtySidebarCards.clear();
                } else {
                  dirtySidebarCards.add(card);
                }
              }
            } else if (targetNode.closest?.('.cvat-objects-sidebar')) {
              pendingSidebarChange = true;
              fullSidebarReconcile = true;
              dirtySidebarCards.clear();
            }
            continue;
          }

          // rec.type === 'childList'
          if (isOnlyEnhancerRowAdded(rec)) {
            continue;
          }
          let allIgnored = rec.addedNodes.length + rec.removedNodes.length > 0;
          if (allIgnored) {
            for (let j = 0; j < rec.addedNodes.length; j += 1) {
              if (!isIgnoredMutationNode(rec.addedNodes[j]!)) {
                allIgnored = false;
                break;
              }
            }
            if (allIgnored) {
              for (let j = 0; j < rec.removedNodes.length; j += 1) {
                if (!isIgnoredMutationNode(rec.removedNodes[j]!)) {
                  allIgnored = false;
                  break;
                }
              }
            }
            if (allIgnored) {
              continue;
            }
          }

          if (structuralRoots.has(targetNode) || pendingMountRoots.has(targetNode)) {
            rootsChanged = true;
            hasRelevantMutation = true;
            for (const node of rec.addedNodes) {
              if (node.nodeType === 1 && !isIgnoredMutationNode(node))
                pendingMountRoots.add(node as Element);
            }
          }
          const card = targetNode.closest?.<HTMLElement>(SIDEBAR_CARD_SELECTOR);
          const inSidebar = Boolean(card) || Boolean(targetNode.closest?.('.cvat-objects-sidebar'));

          if (inSidebar) {
            hasRelevantMutation = true;
            if (rec.addedNodes.length > 0 || rec.removedNodes.length > 0) {
              this.domDrawnObjectsCache.invalidate();
            }
            if (card) {
              pendingSidebarChange = true;
              if (!fullSidebarReconcile) {
                if (dirtySidebarCards.size >= MAX_TARGETED_SIDEBAR_CARDS) {
                  fullSidebarReconcile = true;
                  dirtySidebarCards.clear();
                } else {
                  dirtySidebarCards.add(card);
                }
              }
            } else if (rec.addedNodes.length > 0) {
              pendingSidebarChange = true;
              if (!fullSidebarReconcile) {
                if (
                  rec.addedNodes.length > MAX_TARGETED_SIDEBAR_CARDS ||
                  dirtySidebarCards.size + rec.addedNodes.length > MAX_TARGETED_SIDEBAR_CARDS
                ) {
                  fullSidebarReconcile = true;
                  dirtySidebarCards.clear();
                } else {
                  for (let j = 0; j < rec.addedNodes.length; j += 1) {
                    const added = rec.addedNodes[j]!;
                    if (added.nodeType !== 1) continue;
                    const addedEl = added as HTMLElement;
                    if (
                      addedEl.classList.contains('cvat-objects-sidebar-state-item') ||
                      addedEl.id.startsWith(SIDEBAR_ITEM_ID_PREFIX)
                    ) {
                      dirtySidebarCards.add(addedEl);
                    } else if (addedEl.childElementCount > MAX_TARGETED_SIDEBAR_CARDS) {
                      fullSidebarReconcile = true;
                      dirtySidebarCards.clear();
                      break;
                    } else {
                      const nested = addedEl.getElementsByClassName(
                        'cvat-objects-sidebar-state-item'
                      );
                      if (dirtySidebarCards.size + nested.length > MAX_TARGETED_SIDEBAR_CARDS) {
                        fullSidebarReconcile = true;
                        dirtySidebarCards.clear();
                        break;
                      }
                      for (let k = 0; k < nested.length; k += 1) {
                        dirtySidebarCards.add(nested[k] as HTMLElement);
                      }
                    }
                  }
                }
              }
            }

            // Never run querySelector('canvas, .cvat-workspace-settings') on sidebar nodes;
            // only check direct O(1) tagName === 'CANVAS'.
            for (let j = 0; j < rec.addedNodes.length; j += 1) {
              const n = rec.addedNodes[j]!;
              if (n.nodeType === 1 && (n as Element).tagName === 'CANVAS') {
                pendingChildListChange = true;
                break;
              }
            }
            if (!pendingChildListChange) {
              for (let j = 0; j < rec.removedNodes.length; j += 1) {
                const n = rec.removedNodes[j]!;
                if (n.nodeType === 1 && (n as Element).tagName === 'CANVAS') {
                  pendingChildListChange = true;
                  break;
                }
              }
            }
            continue;
          }

          hasRelevantMutation = true;
          let affectsCanvasOrSettings = Boolean(targetNode.closest?.('.cvat-workspace-settings'));
          if (!inSidebar) {
            for (let j = 0; j < rec.addedNodes.length; j += 1) {
              const node = rec.addedNodes[j]!;
              if (node.nodeType !== 1 || isIgnoredMutationNode(node)) continue;
              const el = node as Element;
              if (
                !affectsCanvasOrSettings &&
                (el.tagName === 'CANVAS' ||
                  el.classList.contains('cvat-workspace-settings') ||
                  Boolean(el.querySelector('canvas, .cvat-workspace-settings')))
              ) {
                affectsCanvasOrSettings = true;
              }
              if (
                !fullSidebarReconcile &&
                (el.classList.contains('cvat-objects-sidebar') ||
                  el.classList.contains('cvat-objects-sidebar-state-item') ||
                  el.id.startsWith(SIDEBAR_ITEM_ID_PREFIX) ||
                  Boolean(
                    el.querySelector('.cvat-objects-sidebar, .cvat-objects-sidebar-state-item')
                  ))
              ) {
                rootsChanged = true;
                pendingSidebarChange = true;
                fullSidebarReconcile = true;
                dirtySidebarCards.clear();
              }
            }
            if (!affectsCanvasOrSettings) {
              for (let j = 0; j < rec.removedNodes.length; j += 1) {
                const node = rec.removedNodes[j]!;
                if (node.nodeType !== 1 || isIgnoredMutationNode(node)) continue;
                const el = node as Element;
                if (
                  el.tagName === 'CANVAS' ||
                  el.classList.contains('cvat-workspace-settings') ||
                  Boolean(el.querySelector('canvas, .cvat-workspace-settings'))
                ) {
                  affectsCanvasOrSettings = true;
                  break;
                }
              }
            }
          }
          if (affectsCanvasOrSettings) {
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
      };
      this.settingsObserver = new MutationObserver((records) =>
        timePerf('meow.mutationObserver', () => onSettingsMutations(records))
      );
      observeRoots();
    }

    this.tryMountWorkspaceSettingsCheckboxes();
    this.tryMountObjectItemDimensionSyncControls();
    this.initialCanvasScanDone = true;
    this.checkForNewlyMountedCanvases();
    const initialInstance = this.getActiveCanvas3dInstance();
    if (initialInstance) {
      this.preRenderEnhancer.ensureHooked(initialInstance);
      this.ensureActiveObjectHoverLock(initialInstance);
      this.preRenderEnhancer.requestViewsRedraw();
    }
    this.settingsObserver?.takeRecords();

    return () => {
      this.doc.removeEventListener('plugins.ready', onPluginReady);
      this.win.removeEventListener('message', this.handleMessage);
      uninstallOrthoEditor();
      this.win.removeEventListener('pointerdown', onPerfPointerDown, true);
      removePerfProbe();
      this.preRenderEnhancer.disposeHotPaths();
      for (const raycaster of this.hoverRaycasters) unlockRaycasterHover(raycaster);
      this.hoverRaycasters.clear();
      this.preRenderEnhancer.setCanvasRenderListener(null);
      trackGhosts.dispose();
      this.trackGhosts = null;
      this.selection?.dispose();
      this.selection = null;
      baseGuide.clear();
      this.win.removeEventListener('keydown', onQcMarginHotkey, true);
      qcMargin.dispose();
      this.baseGuide = null;
      this.doc.documentElement.removeAttribute('data-meow-ortho-keyboard');
      removeQuickFilterGuard();
      removeMouseFrameNavigation();
      if (this.domSyncRafId !== null) {
        this.win.cancelAnimationFrame?.(this.domSyncRafId);
        this.domSyncRafId = null;
      }
      this.settingsObserver?.disconnect();
      this.settingsObserver = null;
      removeMeowUi(this.doc);
    };
  }

  private invalidateSceneObjectCaches(): void {
    this.domDrawnObjectsCache.invalidate();
    invalidateSpatial2DBoxLookup();
    invalidateHoverSpatialIndex();
  }

  private getDrawnObjectEntryById(
    instance: CvatCanvas3dLike | null | undefined,
    clientID: number
  ): CvatDrawnObjectEntry | null {
    if (!instance?.view || !Number.isFinite(clientID)) {
      return null;
    }
    if (instance.view === this.domBackedViewRef) {
      const perspCanvas = this.bindDomPerspectiveCanvasEvents();
      if (!perspCanvas) {
        return null;
      }
      const gen = this.domDrawnObjectsCache.getGeneration();
      if (
        this.lastDrawnLookupCanvas === perspCanvas &&
        this.lastDrawnLookupGen === gen &&
        this.lastDrawnLookupClientId === clientID
      ) {
        return this.lastDrawnLookupEntry;
      }
      const entry = this.domDrawnObjectsCache.getEntryById(perspCanvas, clientID);
      this.lastDrawnLookupCanvas = perspCanvas;
      this.lastDrawnLookupGen = gen;
      this.lastDrawnLookupClientId = clientID;
      this.lastDrawnLookupEntry = entry;
      return entry;
    }
    return instance.view.drawnObjects?.[clientID] ?? null;
  }

  private ensureActiveObjectHoverLock(instance: CvatCanvas3dLike): void {
    if (this.cachedInstance?.view !== instance.view) this.cameraFollower.reset();
    this.cachedInstance = instance;
    const perspective = instance.view?.views?.perspective as
      { rayCaster?: { renderer?: RaycasterLike } } | undefined;
    const raycaster = perspective?.rayCaster?.renderer;
    if (raycaster) this.hoverRaycasters.add(raycaster);
    lockRaycasterHoverToActiveObject(
      raycaster,
      () => this.getActiveObjectClientId(this.cachedInstance ?? instance),
      undefined,
      {
        useCachedClickBounds: () =>
          this.cachedInstance?.view === instance.view && canReuseVisibleCuboidBounds(instance.view),
        resolveActiveObject: (activeId) => {
          const id = Number(activeId);
          return Number.isFinite(id)
            ? this.getDrawnObjectEntryById(this.cachedInstance ?? instance, id)?.cuboid?.perspective
            : undefined;
        },
      }
    );

    // Keep the active object pinned at the same screen position across frame changes
    const perspCamera = (instance.view?.views?.perspective as { camera?: unknown } | undefined)
      ?.camera;
    if (perspCamera) {
      attachActiveObjectCameraFollow(
        instance.view as unknown as FollowViewLike,
        this.cameraFollower,
        () => this.cachedInstance?.model as FollowModelLike | undefined,
        () => this.cachedInstance?.view === instance.view
      );
    }
  }

  private formatNumericClientId(id: number): string {
    if (id === this.lastNumericActiveId) {
      return this.lastNumericActiveIdStr;
    }
    const formatted = String(id);
    this.lastNumericActiveId = id;
    this.lastNumericActiveIdStr = formatted;
    return formatted;
  }

  private getActiveObjectClientId(instance?: CvatCanvas3dLike | null): string | null {
    if (this.reduxStore) {
      try {
        const annotation = this.reduxStore.getState().annotation as
          { annotations?: { activatedStateID?: number | null } } | undefined;
        const activated = annotation?.annotations?.activatedStateID;
        if (typeof activated === 'number' && Number.isFinite(activated)) {
          return this.formatNumericClientId(activated);
        }
        if (activated === null) {
          return null;
        }
      } catch {
        // Fall back to Canvas3d model state
      }
    }
    const modelData = (
      instance?.model as
        { data?: { activeElement?: { clientID?: string | number | null } } } | undefined
    )?.data;
    const fallback = modelData?.activeElement?.clientID;
    if (typeof fallback === 'number' && Number.isFinite(fallback)) {
      return this.formatNumericClientId(fallback);
    }
    if (fallback !== undefined && fallback !== null && String(fallback) !== '') {
      return String(fallback);
    }

    const cachedEl = this.cachedActiveSidebarEl;
    if (
      cachedEl &&
      cachedEl.isConnected &&
      cachedEl.classList.contains('cvat-objects-sidebar-state-active-item') &&
      cachedEl.id === this.cachedActiveSidebarRawId
    ) {
      return this.cachedActiveSidebarParsedId;
    }

    const activeItems =
      this.liveActiveSidebarItems ??
      (this.liveActiveSidebarItems = this.doc.getElementsByClassName(
        'cvat-objects-sidebar-state-active-item'
      ));
    for (let i = 0; i < activeItems.length; i += 1) {
      const el = activeItems[i]!;
      const rawId = el.id;
      if (rawId.startsWith(SIDEBAR_ITEM_ID_PREFIX)) {
        const suffix = rawId.slice(SIDEBAR_ITEM_ID_PREFIX.length);
        if (isNumericClientIdName(suffix)) {
          this.cachedActiveSidebarEl = el;
          this.cachedActiveSidebarRawId = rawId;
          this.cachedActiveSidebarParsedId = suffix;
          return suffix;
        }
      }
    }
    this.cachedActiveSidebarEl = null;
    this.cachedActiveSidebarRawId = '';
    this.cachedActiveSidebarParsedId = null;
    return null;
  }

  private tryMountWorkspaceSettingsCheckboxes(): void {
    injectCvatWorkspaceSettingsControls(
      this.doc,
      () => this.preRenderEnhancer.getOptionsReadonly(),
      (next: Cvat3dWorkspaceRenderOptions) => this.applyWorkspaceOptions(next)
    );
  }

  /** Persist and activate new Workspace options (checkbox change or hotkey). */
  private applyWorkspaceOptions(next: Cvat3dWorkspaceRenderOptions): void {
    const persisted = writeRenderOptionsToClientSettings(next, this.win.localStorage);
    const canvasInstance = this.getActiveCanvas3dInstance();
    if (canvasInstance) {
      this.preRenderEnhancer.ensureHooked(canvasInstance);
      this.ensureActiveObjectHoverLock(canvasInstance);
    }
    this.preRenderEnhancer.setOptions(persisted, canvasInstance);
    this.syncKeyboardEnabledAttribute();
    this.tryMountObjectItemDimensionSyncControls();
    this.baseGuide?.refresh();
    this.trackGhosts?.refreshEnabled();
    this.selection?.refreshEnabled();
  }

  private syncKeyboardEnabledAttribute(): void {
    this.doc.documentElement.setAttribute(
      'data-meow-ortho-keyboard',
      this.preRenderEnhancer.getOptionsReadonly().enableOrthoKeyboard === false ? '0' : '1'
    );
  }

  private tryMountObjectItemDimensionSyncControls(
    targetCards?: Iterable<HTMLElement> | null
  ): void {
    const opts = this.preRenderEnhancer.getOptionsReadonly();
    injectCvatObjectDimensionSyncControls(
      this.doc,
      (
        clientID: number,
        dimension: CuboidDimensionKey,
        wholeTrack?: boolean,
        yawRange?: readonly [number, number]
      ): Promise<DimensionSyncResult> =>
        this.handleSyncObjectDimension(clientID, dimension, wholeTrack, yawRange),
      targetCards != null
        ? {
            enableDimensionSync: opts.enableDimensionSync,
            enableHeadingFlip: opts.enableHeadingFlip,
            targetCards,
          }
        : opts,
      {
        isAvailable: (id, card) => sidebarHasRideState(this.doc, id, card),
        sync: async (id) => {
          const result = await syncSidebarRideState(this.doc, id);
          if (result.updatedKeyframes > 0) await this.syncReduxAfterWrite();
          return result;
        },
        getYawRangeOptions: (id) => sidebarYawRangeOptions(this.doc, id),
        getAttributes: (id) => sidebarMutableAttributes(this.doc, id),
        syncAttribute: async (id, attr) => {
          const result = await syncSidebarMutableAttribute(this.doc, id, attr);
          if (result.updatedKeyframes > 0) await this.syncReduxAfterWrite();
          return result;
        },
      }
    );
  }

  private async handleSyncObjectDimension(
    clientID: number,
    dimension: CuboidDimensionKey,
    wholeTrack = false,
    yawRange?: readonly [number, number]
  ): Promise<DimensionSyncResult> {
    const sidebar = resolveSidebarObjectContext(this.doc, clientID);
    const instance = sidebar ? null : this.getActiveCanvas3dInstance();
    const drawnEntry = this.getDrawnObjectEntryById(instance, clientID);
    let stateOnCurrentFrame: CvatObjectStateLike | null =
      sidebar?.state ?? drawnEntry?.state ?? null;

    if (!stateOnCurrentFrame && instance) {
      const modelObjects = (instance.model as { objects?: CvatObjectStateLike[] } | undefined)
        ?.objects;
      if (Array.isArray(modelObjects)) {
        stateOnCurrentFrame = findObjectStateByClientId(modelObjects, clientID);
      }
    }

    if (!stateOnCurrentFrame && this.reduxStore) {
      try {
        const state = this.reduxStore.getState();
        const annotation = state.annotation as Record<string, unknown> | undefined;
        const annotations = annotation?.annotations as Record<string, unknown> | undefined;
        const states = annotations?.states as CvatObjectStateLike[] | undefined;
        if (Array.isArray(states)) {
          stateOnCurrentFrame = findObjectStateByClientId(states, clientID);
        }
      } catch {
        // Ignore fallback lookup errors
      }
    }

    const perspCanvas =
      this.bindDomPerspectiveCanvasEvents() ??
      this.doc.querySelector<PerspDomCanvasElement>('.cvat-canvas3d-perspective canvas');

    const result = await syncTrackCuboidDimension(clientID, dimension, {
      wholeTrack,
      yawRange,
      drawnEntry,
      stateOnCurrentFrame,
      perspectiveCanvas: perspCanvas,
      onAfterSync: () => {
        this.invalidateSceneObjectCaches();
        this.preRenderEnhancer.markDirty();
        const inst = this.getActiveCanvas3dInstance();
        if (inst?.view) {
          this.preRenderEnhancer.applyOnceIfNeeded(inst.view, inst.model);
          this.preRenderEnhancer.requestViewsRedraw();
        }
      },
    });
    if (result.syncedFrames > 0) {
      // Same Redux sync cvat-ui's updateAnnotationsAsync performs, so CVAT's Undo/Ctrl+Z see the edit.
      await this.syncReduxAfterWrite();
      await sidebar?.refresh?.();
    }
    return result;
  }

  private getActiveNumericClientId(): number | null {
    const id = this.getActiveObjectClientId(this.getActiveCanvas3dInstance());
    const numeric = id === null ? NaN : Number(id);
    return Number.isFinite(numeric) ? numeric : null;
  }

  /**
   * Undo a Meow highlight the way CVAT's GROUP/MERGE modes do: ask the native view for the color
   * (`receiveShapeColor`, private but reachable at runtime). Falls back to the label color.
   */
  private restoreCuboidColor(entry: CvatDrawnObjectEntry): void {
    let color: string | undefined;
    try {
      const canvas = this.reduxStore?.getState().annotation as
        { canvas?: { instance?: { view?: unknown } } } | undefined;
      const view = canvas?.canvas?.instance?.view as
        { receiveShapeColor?: (state: unknown) => unknown } | undefined;
      if (typeof view?.receiveShapeColor === 'function') {
        const value = view.receiveShapeColor(entry.state ?? entry.data);
        if (typeof value === 'string') color = value;
      }
    } catch {
      color = undefined;
    }
    color ??= entry.data.color ?? entry.data.labelColor ?? entry.state?.label?.color;
    if (color) entry.cuboid.setColor?.(color);
  }

  /** Re-sync cvat-ui's Redux states + undo history after an extension-side write. */
  private async syncReduxAfterWrite(): Promise<void> {
    const ctx = readCvatContext(this.reduxStore);
    await refreshCvatAnnotations(this.reduxStore, { frame: ctx.frame, job: ctx.job }, 'update');
  }

  /** Active cuboid (drawn entry + ObjectState) on the current frame. */
  private qcLabelCache: { clientID: number; name: string; at: number } | null = null;

  /** Label of the active object: drawn state first, then the sidebar card (cached briefly). */
  private resolveQcLabelName(
    clientID: number,
    state: CvatObjectStateLike | null | undefined
  ): string | undefined {
    const direct = state?.label?.name;
    if (direct) return direct;
    const now = Date.now();
    if (this.qcLabelCache?.clientID !== clientID || now - this.qcLabelCache.at > 400) {
      const item = this.doc.getElementById(`cvat-objects-sidebar-state-item-${clientID}`);
      const name =
        item
          ?.querySelector(
            '.cvat-objects-sidebar-state-item-label-selector .ant-select-selection-item'
          )
          ?.textContent?.trim() ||
        resolveSidebarObjectContext(this.doc, clientID)?.state?.label?.name ||
        item?.querySelector('.ant-select-selection-item')?.textContent?.trim() ||
        '';
      this.qcLabelCache = { clientID, name, at: now };
    }
    return this.qcLabelCache.name || undefined;
  }

  /** Cheap per-render lookup: null unless the QC margin applies to the active cuboid here. */
  private resolveQcMarginTarget(isOrthographic: boolean): QcMarginTarget | null {
    const options = this.preRenderEnhancer.getOptionsReadonly();
    const viewEnabled = isOrthographic
      ? (options.showQcMarginOrtho ?? true)
      : (options.showQcMarginPerspective ?? true);
    if (!(options.showQcMargin ?? true) || !viewEnabled) return null;
    const active = this.resolveActiveCuboid(false);
    if (!active) return null;
    const { entry, state } = active;
    // The drawn entry is the source of truth, exactly like the base guide; state may be absent.
    const points = entry?.data.points ?? state?.points;
    if (!points) return null;
    if (state?.shapeType && state.shapeType !== 'cuboid') return null;
    if (state?.hidden || state?.outside || entry?.data.hidden || entry?.data.outside) return null;
    return {
      points,
      labelName: this.resolveQcLabelName(active.clientID, state ?? entry?.state),
    };
  }

  private resolveActiveCuboid(allowReduxFallback = true): {
    clientID: number;
    entry: CvatDrawnObjectEntry | null;
    state: CvatObjectStateLike | null;
  } | null {
    const instance = this.getActiveCanvas3dInstance();
    const activeId = this.getActiveObjectClientId(instance);
    const clientID = activeId === null ? NaN : Number(activeId);
    if (!Number.isFinite(clientID)) {
      return null;
    }
    const entry = this.getDrawnObjectEntryById(instance, clientID);
    let state: CvatObjectStateLike | null = entry?.state ?? null;
    if (!state && allowReduxFallback) {
      const modelObjects = (instance?.model as { objects?: CvatObjectStateLike[] } | undefined)
        ?.objects;
      if (Array.isArray(modelObjects)) {
        state = findObjectStateByClientId(modelObjects, clientID);
      }
    }
    if (!state && allowReduxFallback && this.reduxStore) {
      try {
        const annotation = this.reduxStore.getState().annotation as
          { annotations?: { states?: CvatObjectStateLike[] } } | undefined;
        const states = annotation?.annotations?.states;
        if (Array.isArray(states)) {
          state = findObjectStateByClientId(states, clientID);
        }
      } catch {
        // Ignore fallback lookup errors
      }
    }
    return { clientID, entry, state };
  }

  private getActiveCuboidPoints(): { clientID: number; points: number[] } | null {
    const active = this.resolveActiveCuboid(true);
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
    const cachedCanvas =
      view === 'top'
        ? this.cachedTopCanvas
        : view === 'side'
          ? this.cachedSideCanvas
          : this.cachedFrontCanvas;
    const selectors: Record<OrthoViewName, string> = {
      top: CVAT_DOM_SELECTORS.TOP_VIEW_WRAPPER,
      side: CVAT_DOM_SELECTORS.SIDE_VIEW_WRAPPER,
      front: CVAT_DOM_SELECTORS.FRONT_VIEW_WRAPPER,
    };
    const canvas =
      cachedCanvas?.isConnected === true
        ? cachedCanvas
        : this.doc.querySelector<HTMLCanvasElement>(`${selectors[view]} canvas`);
    const rendered = this.preRenderEnhancer.getLastRenderCameraForCanvas(canvas);
    return isOrtho(rendered) ? rendered : null;
  }

  /** Live visual update of the active cuboid meshes (no persistence / undo entry). */
  private previewCuboidPoints(clientID: number, points: number[]): void {
    const entry = this.getDrawnObjectEntryById(this.getActiveCanvas3dInstance(), clientID);
    if (!entry) {
      return;
    }
    const [x, y, z, rx, ry, rz, sx, sy, sz] = points as [
      number,
      number,
      number,
      number,
      number,
      number,
      number,
      number,
      number,
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
    // A preview only moves meshes. Recoloring the full point cloud here stalls every keydown.
    this.preRenderEnhancer.requestViewsRedraw();
  }

  /** Persists cuboid points through CVAT (same path as the existing dimension tools). */
  private async commitCuboidPoints(clientID: number, points: number[]): Promise<void> {
    const active = this.resolveActiveCuboid(true);
    const state =
      active?.clientID === clientID
        ? active.state
        : (this.getDrawnObjectEntryById(this.getActiveCanvas3dInstance(), clientID)?.state ?? null);
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

    const perspCanvas =
      this.bindDomPerspectiveCanvasEvents() ??
      this.doc.querySelector<PerspDomCanvasElement>('.cvat-canvas3d-perspective canvas');
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

    // Same-frame cuboid edit: do NOT call markDirty() (which resets pendingFrameObjectsLoad=true
    // and recompiles/recolors all 100k cuboids + full LiDAR buffer mid-edit).
    this.invalidateSceneObjectCaches();
    this.preRenderEnhancer.requestViewsRedraw();
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
          this.hasReduxSnapshot = false;
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
              this.hasReduxSnapshot = false;
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
    timePerf('meow.reduxUpdate', () => this.handleGlobalStateUpdateImpl());
  }

  private handleGlobalStateUpdateImpl(): void {
    if (this.reduxStore) {
      try {
        const state = this.reduxStore.getState();
        const annotation = state.annotation as Record<string, unknown> | undefined;
        const annotations = annotation?.annotations as
          { activatedStateID?: unknown; states?: unknown } | undefined;
        const player = annotation?.player as { frame?: { number?: unknown } } | undefined;
        const canvas = annotation?.canvas as { instance?: CvatCanvas3dLike } | undefined;

        const nextCanvasInstance = canvas?.instance ?? null;
        const nextFrame = player?.frame?.number ?? nextCanvasInstance?.model?.data?.imageID ?? null;
        const nextActivatedId = annotations?.activatedStateID ?? null;
        const nextStatesRef = annotations?.states ?? null;

        if (
          this.hasReduxSnapshot &&
          nextFrame === this.lastReduxFrame &&
          nextActivatedId === this.lastReduxActivatedId &&
          nextStatesRef === this.lastReduxStatesRef &&
          nextCanvasInstance === this.lastReduxCanvasInstance
        ) {
          return;
        }

        if (
          !this.hasReduxSnapshot ||
          nextFrame !== this.lastReduxFrame ||
          nextStatesRef !== this.lastReduxStatesRef
        ) {
          this.invalidateSceneObjectCaches();
        }

        this.trackGhosts?.contextChanged(nextFrame, nextActivatedId);
        this.selection?.contextChanged(nextFrame, nextActivatedId);
        this.hasReduxSnapshot = true;
        this.lastReduxFrame = nextFrame;
        this.lastReduxActivatedId = nextActivatedId;
        this.lastReduxStatesRef = nextStatesRef;
        this.lastReduxCanvasInstance = nextCanvasInstance;
      } catch {
        // Proceed with standard sync if Redux state inspection fails
      }
    }

    const activeInstance = this.getActiveCanvas3dInstance();
    if (activeInstance) {
      this.preRenderEnhancer.ensureHooked(activeInstance);
      this.ensureActiveObjectHoverLock(activeInstance);
    }
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
            const effectiveModel = instance.model ?? domInstance.model;
            const modelFrame = effectiveModel?.data?.imageID;
            if (
              this.cachedHybridWrapper !== null &&
              this.cachedHybridSourceInstance === instance &&
              this.cachedHybridDomView === domInstance.view &&
              this.cachedHybridModel === effectiveModel &&
              this.cachedHybridModelFrame === modelFrame
            ) {
              return this.cachedHybridWrapper;
            }
            const wrapper: CvatCanvas3dLike = {
              configure: instance.configure?.bind(instance),
              keyControls: instance.keyControls?.bind(instance),
              fit: instance.fit?.bind(instance),
              view: domInstance.view,
              model: effectiveModel,
            };
            this.cachedHybridSourceInstance = instance;
            this.cachedHybridDomView = domInstance.view;
            this.cachedHybridModel = effectiveModel;
            this.cachedHybridModelFrame = modelFrame;
            this.cachedHybridWrapper = wrapper;
            return wrapper;
          }
          return instance;
        }
      } catch {
        // Fall through to DOM-backed 3D canvas inspection
      }
    }

    return this.resolveDomBackedCanvas3dInstance();
  }

  private attachCanvasSetupListener(canvas: HTMLCanvasElement): void {
    if (this.hookedSetupCanvases.has(canvas)) {
      return;
    }
    this.hookedSetupCanvases.add(canvas);
    canvas.addEventListener('canvas.setup', () => {
      endPerfSpan(PERF_FRAME_SPAN);
      this.trackGhosts?.clear();
      this.selection?.onCanvasSetup();
      this.invalidateSceneObjectCaches();
      this.viewsMapDirty = true;
      this.preRenderEnhancer.markViewStructureChanged();
      const inst = this.getActiveCanvas3dInstance();
      if (inst?.view) {
        this.preRenderEnhancer.applyOnceIfNeeded(inst.view, inst.model);
      }
    });
  }

  private refreshPrimaryDomCanvases(): void {
    if (!this.cachedPerspCanvas?.isConnected) {
      this.cachedPerspCanvas = this.doc.querySelector<PerspDomCanvasElement>(
        '.cvat-canvas3d-perspective canvas'
      );
    }
    if (!this.cachedTopCanvas?.isConnected) {
      this.cachedTopCanvas = this.doc.querySelector<SceneDomCanvasElement>(
        '.cvat-canvas3d-topview canvas'
      );
    }
    if (!this.cachedSideCanvas?.isConnected) {
      this.cachedSideCanvas = this.doc.querySelector<SceneDomCanvasElement>(
        '.cvat-canvas3d-sideview canvas'
      );
    }
    if (!this.cachedFrontCanvas?.isConnected) {
      this.cachedFrontCanvas = this.doc.querySelector<SceneDomCanvasElement>(
        '.cvat-canvas3d-frontview canvas'
      );
    }
  }

  private checkForNewlyMountedCanvases(): boolean {
    this.initialCanvasScanDone = true;
    this.refreshPrimaryDomCanvases();
    const p = this.cachedPerspCanvas;
    const t = this.cachedTopCanvas;
    const s = this.cachedSideCanvas;
    const f = this.cachedFrontCanvas;

    for (const extra of this.extraSceneCanvases) {
      if (!extra.isConnected || extra === p || extra === t || extra === s || extra === f) {
        this.extraSceneCanvases.delete(extra);
        this.viewsMapDirty = true;
      }
    }

    const allCanvases = this.doc.querySelectorAll<SceneDomCanvasElement>('canvas');
    let foundNew = false;
    for (const c of allCanvases) {
      if (!this.knownDomCanvases.has(c)) {
        this.knownDomCanvases.add(c);
        foundNew = true;
        this.attachCanvasSetupListener(c);
      }
      if (c !== p && c !== t && c !== s && c !== f && !this.extraSceneCanvases.has(c)) {
        this.extraSceneCanvases.add(c);
        this.viewsMapDirty = true;
      }
    }
    if (foundNew) {
      this.viewsMapDirty = true;
    }
    return foundNew;
  }

  private bindDomPerspectiveCanvasEvents(): PerspDomCanvasElement | null {
    if (!this.cachedPerspCanvas || !this.cachedPerspCanvas.isConnected) {
      this.cachedPerspCanvas = this.doc.querySelector<PerspDomCanvasElement>(
        '.cvat-canvas3d-perspective canvas'
      );
      this.viewsMapDirty = true;
    }
    const perspCanvas = this.cachedPerspCanvas;

    if (!perspCanvas) {
      return null;
    }

    if (!this.hookedPerspectiveCanvases.has(perspCanvas)) {
      this.hookedPerspectiveCanvases.add(perspCanvas);
      this.knownDomCanvases.add(perspCanvas);
      this.attachCanvasSetupListener(perspCanvas);
      const onCanvasObjectsMutated = (): void => {
        this.invalidateSceneObjectCaches();
      };
      perspCanvas.addEventListener('canvas.edited', onCanvasObjectsMutated);
      perspCanvas.addEventListener('canvas.drawn', onCanvasObjectsMutated);
      perspCanvas.addEventListener('canvas.deleted', onCanvasObjectsMutated);
      perspCanvas.addEventListener('canvas.canceled', onCanvasObjectsMutated);
    }

    return perspCanvas;
  }

  private getViewsMap(): NonNullable<CvatInternalViewLike['views']> {
    if (!this.initialCanvasScanDone) {
      this.checkForNewlyMountedCanvases();
    }

    if (
      (this.cachedPerspCanvas !== null && !this.cachedPerspCanvas.isConnected) ||
      (this.cachedTopCanvas !== null && !this.cachedTopCanvas.isConnected) ||
      (this.cachedSideCanvas !== null && !this.cachedSideCanvas.isConnected) ||
      (this.cachedFrontCanvas !== null && !this.cachedFrontCanvas.isConnected)
    ) {
      this.viewsMapDirty = true;
    }

    if (!this.viewsMapDirty) {
      if (
        this.cachedPerspCanvas?.scene !== this.cachedPerspScene ||
        this.cachedTopCanvas?.scene !== this.cachedTopScene ||
        this.cachedSideCanvas?.scene !== this.cachedSideScene ||
        this.cachedFrontCanvas?.scene !== this.cachedFrontScene
      ) {
        this.viewsMapDirty = true;
      } else if (this.extraSceneCanvases.size > 0) {
        for (const extra of this.extraSceneCanvases) {
          if (!extra.isConnected) {
            this.extraSceneCanvases.delete(extra);
            this.viewsMapDirty = true;
          } else if (this.extraCanvasScenes.get(extra) !== extra.scene) {
            this.viewsMapDirty = true;
          }
        }
      }
    }

    if (!this.viewsMapDirty && this.cachedViewsMap !== null) {
      return this.cachedViewsMap;
    }

    this.refreshPrimaryDomCanvases();
    const p = this.cachedPerspCanvas;
    const t = this.cachedTopCanvas;
    const s = this.cachedSideCanvas;
    const f = this.cachedFrontCanvas;

    this.cachedPerspScene = p?.scene;
    this.cachedTopScene = t?.scene;
    this.cachedSideScene = s?.scene;
    this.cachedFrontScene = f?.scene;

    const viewsMap: NonNullable<CvatInternalViewLike['views']> = {
      perspective: p?.scene ? { scene: p.scene, renderer: { domElement: p } } : undefined,
      top: t?.scene ? { scene: t.scene, renderer: { domElement: t } } : undefined,
      side: s?.scene ? { scene: s.scene, renderer: { domElement: s } } : undefined,
      front: f?.scene ? { scene: f.scene, renderer: { domElement: f } } : undefined,
    };

    // Include any zoomed/expanded Top/Side/Front canvas tracked via MutationObserver
    // (must have its own distinct THREE.Scene so we never alias the perspective scene!)
    let extraIdx = 0;
    for (const c of this.extraSceneCanvases) {
      if (!c.isConnected || c === p || c === t || c === s || c === f) {
        this.extraSceneCanvases.delete(c);
        continue;
      }
      this.extraCanvasScenes.set(c, c.scene);
      if (c.scene && c.scene !== p?.scene) {
        viewsMap[`ortho_zoom_${extraIdx}`] = {
          scene: c.scene,
          renderer: { domElement: c },
        };
        extraIdx += 1;
      }
    }

    this.cachedViewsMap = viewsMap;
    this.viewsMapDirty = false;
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
      this.domDrawnObjectsCache.invalidate();
      this.viewsMapDirty = true;
      const getViews = () => this.getViewsMap();
      const getDrawnObjectsMap = () =>
        this.domDrawnObjectsCache.getMap(this.bindDomPerspectiveCanvasEvents());
      const getSingleDrawnObject = (id: number) =>
        this.domDrawnObjectsCache.getEntryById(this.bindDomPerspectiveCanvasEvents(), id);
      const viewRef: CvatInternalViewLike & {
        getDrawnObjectById: (id: number) => CvatDrawnObjectEntry | null;
      } = {
        get views() {
          return getViews();
        },
        get drawnObjects() {
          return getDrawnObjectsMap();
        },
        getDrawnObjectById(id: number) {
          return getSingleDrawnObject(id);
        },
      };
      this.domBackedViewRef = viewRef;
    }

    const frameAttr = perspCanvas.getAttribute('data-frame-number');
    if (
      this.cachedDomInstance !== null &&
      this.cachedDomInstanceView === this.domBackedViewRef &&
      this.cachedDomFrameAttr === frameAttr
    ) {
      return this.cachedDomInstance;
    }

    const parsedFrame = frameAttr !== null ? Number(frameAttr) : null;
    const domInstance: CvatCanvas3dLike = {
      view: this.domBackedViewRef,
      model: {
        data: {
          imageID: Number.isFinite(parsedFrame) ? parsedFrame : null,
        },
      },
    };
    this.cachedDomInstanceView = this.domBackedViewRef;
    this.cachedDomFrameAttr = frameAttr;
    this.cachedDomInstance = domInstance;
    return domInstance;
  }

  public probeRuntime(): PageRuntimeProbeResult {
    this.tryHookCvatUIPlugin();
    const perspectiveDom = Boolean(this.doc.querySelector(CVAT_DOM_SELECTORS.PERSPECTIVE_WRAPPER));
    const perspectiveCanvas = Boolean(
      this.doc.querySelector(`${CVAT_DOM_SELECTORS.PERSPECTIVE_CANVAS_CONTAINER} canvas`)
    );
    const orthoViews = this.doc.querySelectorAll(CVAT_DOM_SELECTORS.ORTHOGRAPHIC_VIEW).length >= 3;
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

    if (this.reduxStore) {
      let shapesState: Record<string, unknown> | undefined;
      let workspaceState: Record<string, unknown> | undefined;
      try {
        const rootSettings = this.reduxStore.getState().settings as
          { shapes?: Record<string, unknown>; workspace?: Record<string, unknown> } | undefined;
        shapesState = rootSettings?.shapes;
        workspaceState = rootSettings?.workspace;
      } catch {
        shapesState = undefined;
        workspaceState = undefined;
      }

      if (config.shapeOpacity !== undefined && shapesState?.opacity !== config.shapeOpacity) {
        this.reduxStore.dispatch({
          type: 'CHANGE_SHAPES_OPACITY',
          payload: { opacity: config.shapeOpacity },
        });
      }
      if (
        config.selectedShapeOpacity !== undefined &&
        shapesState?.selectedOpacity !== config.selectedShapeOpacity
      ) {
        this.reduxStore.dispatch({
          type: 'CHANGE_SELECTED_SHAPES_OPACITY',
          payload: { selectedOpacity: config.selectedShapeOpacity },
        });
      }
      if (config.outlinedBorders !== undefined || config.outlineColor !== undefined) {
        const targetOutlined = config.outlinedBorders ?? true;
        const targetColor = config.outlineColor ?? '#000000';
        const alreadyMatches =
          shapesState?.outlined === targetOutlined &&
          (shapesState?.outlinedBorders === targetColor || shapesState?.color === targetColor);
        if (!alreadyMatches) {
          this.reduxStore.dispatch({
            type: 'CHANGE_SHAPES_OUTLINED_BORDERS',
            payload: {
              outlined: targetOutlined,
              color: targetColor,
            },
          });
        }
      }
      if (
        config.orientationVisibility !== undefined &&
        shapesState?.orientationVisibility !== config.orientationVisibility
      ) {
        this.reduxStore.dispatch({
          type: 'CHANGE_SHAPES_ORIENTATION_VISIBILITY',
          payload: { orientationVisibility: config.orientationVisibility },
        });
      }
      if (config.colorBy !== undefined && shapesState?.colorBy !== config.colorBy) {
        this.reduxStore.dispatch({
          type: 'CHANGE_SHAPES_COLOR_BY',
          payload: { colorBy: config.colorBy },
        });
      }
      if (
        config.controlPointsSize !== undefined &&
        (shapesState?.controlPointsSize ?? workspaceState?.controlPointsSize) !==
          config.controlPointsSize
      ) {
        this.reduxStore.dispatch({
          type: 'SWITCH_CONTROL_POINTS_SIZE',
          payload: { controlPointsSize: config.controlPointsSize },
        });
      }
      if (
        config.focusedObjectPadding !== undefined &&
        (shapesState?.focusedObjectPadding ?? workspaceState?.focusedObjectPadding) !==
          config.focusedObjectPadding
      ) {
        this.reduxStore.dispatch({
          type: 'CHANGE_FOCUSED_OBJECT_PADDING',
          payload: { focusedObjectPadding: config.focusedObjectPadding },
        });
      }
    }

    if (canvasInstance?.configure) {
      const currentModelCfg = (
        canvasInstance.model?.data as { configuration?: Record<string, unknown> } | undefined
      )?.configuration;
      const directPatch: Record<string, unknown> = {};
      if (
        config.shapeOpacity !== undefined &&
        currentModelCfg?.shapeOpacity !== config.shapeOpacity
      ) {
        directPatch.shapeOpacity = config.shapeOpacity;
      }
      if (
        config.selectedShapeOpacity !== undefined &&
        currentModelCfg?.selectedShapeOpacity !== config.selectedShapeOpacity
      ) {
        directPatch.selectedShapeOpacity = config.selectedShapeOpacity;
      }
      if (config.outlinedBorders !== undefined || config.outlineColor !== undefined) {
        const targetOutlinedValue = config.outlinedBorders
          ? (config.outlineColor ?? '#000000')
          : false;
        if (currentModelCfg?.outlinedBorders !== targetOutlinedValue) {
          directPatch.outlinedBorders = targetOutlinedValue;
        }
      }
      if (
        config.orientationVisibility !== undefined &&
        currentModelCfg?.orientationVisibility !== config.orientationVisibility
      ) {
        directPatch.orientationVisibility = config.orientationVisibility;
      }
      if (config.colorBy !== undefined && currentModelCfg?.colorBy !== config.colorBy) {
        directPatch.colorBy = config.colorBy;
      }
      if (
        config.controlPointsSize !== undefined &&
        currentModelCfg?.controlPointsSize !== config.controlPointsSize
      ) {
        directPatch.controlPointsSize = config.controlPointsSize;
      }
      if (
        config.focusedObjectPadding !== undefined &&
        currentModelCfg?.focusedObjectPadding !== config.focusedObjectPadding
      ) {
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
    if (candidate.channel !== BRIDGE_CHANNEL || candidate.direction !== 'CONTENT_TO_PAGE') {
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
