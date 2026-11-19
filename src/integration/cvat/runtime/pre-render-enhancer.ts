/**
 * Deep Three.js / CVAT 3D Renderer pre-frame interceptor.
 *
 * Inspects and hooks into CVAT's internal `Canvas3dViewImpl` (`canvasInstance.view`)
 * and `Canvas3dModelImpl` (`canvasInstance.model`) in the page context.
 *
 * Design guarantees:
 * 1. Syncs with CVAT's native `localStorage.getItem('clientSettings')` under `workspace.cvat3dEnhancer`.
 * 2. Injects native Ant Design-styled checkboxes into CVAT's Settings -> Workspace modal tab
 *    (`.cvat-workspace-settings`).
 * 3. Leaves point cloud colors, point sizes and viewport backgrounds to native CVAT; the hook
 *    pass runs ONLY when dirty (view structure or object updates), never on every render.
 */

import { interpolateTrackYaw, reorientTrack, wrapYaw } from './track-editing';
import {
  WORKSPACE_FEATURE_DEFAULTS,
  WORKSPACE_FEATURE_KEYS,
  WORKSPACE_FEATURE_CONTROLS,
  normalizeWorkspaceFeatureOptions,
  type WorkspaceFeatureOptions,
} from './workspace-feature-options';
import type { GuideMeshLike } from './cuboid-base-guide';
import {
  deferHiddenCuboidMeshUpdates,
  deferHiddenOrientationArrowUpdates,
} from './hidden-orientation-arrows';
import { showMeowToast } from './meow-toast';

export interface Cvat3dWorkspaceRenderOptions extends WorkspaceFeatureOptions {
  readonly followActiveObject?: boolean;
}

export const DEFAULT_CVAT_3D_RENDER_OPTIONS: Cvat3dWorkspaceRenderOptions = Object.freeze({
  ...WORKSPACE_FEATURE_DEFAULTS,
  followActiveObject: true,
});

export const CLIENT_SETTINGS_STORAGE_KEY = 'clientSettings' as const;
export const ENHANCER_STANDALONE_STORAGE_KEY = 'cvat3dEnhancerSettings' as const;

export interface ThreeBufferAttributeLike {
  array: Float32Array | number[];
  needsUpdate?: boolean;
  count?: number;
}

export interface ThreeColorLike {
  r: number;
  g: number;
  b: number;
  set: (val: number | string) => void;
  setHex?: (hex: number) => void;
}

export interface ThreePointsMaterialLike {
  size: number;
  sizeAttenuation?: boolean;
  vertexColors?: boolean;
  opacity?: number;
  transparent?: boolean;
  color: ThreeColorLike;
  needsUpdate?: boolean;
  clone?: () => ThreePointsMaterialLike;
}

export interface ThreeObject3DLike {
  type?: string;
  name?: string;
  visible?: boolean;
  children?: ThreeObject3DLike[];
  geometry?: {
    attributes?: {
      position?: ThreeBufferAttributeLike;
      color?: ThreeBufferAttributeLike;
      intensity?: ThreeBufferAttributeLike;
    };
    drawRange?: {
      start: number;
      count: number;
    };
    setDrawRange?: (start: number, count: number) => void;
    clone?: () => NonNullable<ThreeObject3DLike['geometry']>;
  };
  material?: ThreePointsMaterialLike;
  onBeforeRender?: (...args: unknown[]) => void;
}

export interface ThreeSceneLike extends ThreeObject3DLike {
  background: ThreeColorLike | null;
  children: ThreeObject3DLike[];
}

export interface CvatRenderViewLike {
  scene?: ThreeSceneLike;
  renderer?: {
    domElement?: HTMLCanvasElement;
    setClearColor?: (color: number | string, alpha?: number) => void;
    render?: (scene: unknown, camera: unknown) => void;
  };
}

export interface CvatCuboidViewMeshLike extends GuideMeshLike {
  position?: { x: number; y: number; z: number };
  rotation?: { x: number; y: number; z: number };
  scale?: { x: number; y: number; z: number };
  material?: {
    color?: ThreeColorLike;
    depthWrite?: boolean;
  };
}

export interface CvatSerializedTrackShape {
  frame: number;
  points?: number[];
  outside?: boolean;
  occluded?: boolean;
  attributes?: { spec_id: number; value: string }[];
}

export interface CvatSerializedTrack {
  clientID?: number;
  frame?: number;
  attributes?: { spec_id: number; value: string }[];
  shapes?: CvatSerializedTrackShape[];
}

export interface CvatObjectStateLike {
  clientID?: number | null;
  frame?: number;
  objectType?: string;
  shapeType?: string;
  points?: number[] | null;
  attributes?: Record<number | string, string>;
  label?: {
    id?: number;
    name?: string;
    color?: string;
    attributes?: readonly {
      id: number;
      name: string;
      mutable: boolean;
      input_type?: string;
    }[];
  };
  lock?: boolean;
  hidden?: boolean;
  outside?: boolean;
  occluded?: boolean;
  keyframe?: boolean;
  updateFlags?: {
    reset?: () => void;
    points?: boolean;
    attributes?: boolean;
    keyframe?: boolean;
    occluded?: boolean;
    hidden?: boolean;
  };
  __internal?: {
    save?: (frame: number, data: CvatObjectStateLike) => CvatObjectStateLike;
    export?: () => CvatSerializedTrack;
  };
  save?: () => Promise<CvatObjectStateLike> | CvatObjectStateLike;
  export?: () => Promise<CvatSerializedTrack> | CvatSerializedTrack;
}

export interface CvatDrawnObjectEntry {
  data: {
    clientID: number;
    labelColor?: string;
    groupColor?: string;
    color?: string;
    points: number[];
    hidden?: boolean;
    outside?: boolean;
  };
  state?: CvatObjectStateLike;
  cuboid: {
    orientationArrows?: Partial<
      Record<'perspective' | 'top' | 'side' | 'front', Record<string, unknown> | null>
    >;
    setColor?: (hexColor: string) => void;
    setScale?: (x: number, y: number, z: number) => void;
    setRotation?: (x: number, y: number, z: number) => void;
    perspective?: CvatCuboidViewMeshLike;
    top?: CvatCuboidViewMeshLike;
    side?: CvatCuboidViewMeshLike;
    front?: CvatCuboidViewMeshLike;
  };
}

export interface CvatInternalViewLike {
  views?: {
    perspective?: CvatRenderViewLike;
    top?: CvatRenderViewLike;
    side?: CvatRenderViewLike;
    front?: CvatRenderViewLike;
    [key: string]: CvatRenderViewLike | undefined;
  };
  drawnObjects?: Record<number, CvatDrawnObjectEntry>;
  onSceneImageLoaded?: (points: ThreeObject3DLike) => void;
  notify?: (model: unknown, reason: string) => void;
  render?: () => void;
}

export interface CvatInternalCanvas3dLike {
  view?: CvatInternalViewLike;
  model?: {
    data?: {
      imageID?: number | null;
      configuration?: {
        colorBy?: string;
      };
    };
  };
}

function normalizeRenderOptionsRecord(obj: Record<string, unknown>): Cvat3dWorkspaceRenderOptions {
  return {
    ...normalizeWorkspaceFeatureOptions(obj),
    followActiveObject: typeof obj.followActiveObject === 'boolean' ? obj.followActiveObject : true,
  };
}

/**
 * Reads `workspace.cvat3dEnhancer` from CVAT's native `localStorage['clientSettings']`
 * (with authoritative fallback/sync from `localStorage['cvat3dEnhancerSettings']` so CVAT's
 * SettingsModal close handler can never wipe or revert user-configured 3D enhancer options).
 */
export function readRenderOptionsFromClientSettings(
  storage: Pick<Storage, 'getItem'> & Partial<Pick<Storage, 'setItem'>> = window.localStorage
): Cvat3dWorkspaceRenderOptions {
  let standaloneOptions: Cvat3dWorkspaceRenderOptions | null = null;
  try {
    const rawStandalone = storage.getItem(ENHANCER_STANDALONE_STORAGE_KEY);
    if (rawStandalone) {
      const parsedStandalone: unknown = JSON.parse(rawStandalone);
      if (
        typeof parsedStandalone === 'object' &&
        parsedStandalone !== null &&
        !Array.isArray(parsedStandalone)
      ) {
        standaloneOptions = normalizeRenderOptionsRecord(
          parsedStandalone as Record<string, unknown>
        );
      }
    }
  } catch {
    standaloneOptions = null;
  }

  let clientSettingsOptions: Cvat3dWorkspaceRenderOptions | null = null;
  try {
    const raw = storage.getItem(CLIENT_SETTINGS_STORAGE_KEY);
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        const workspace = (parsed as Record<string, unknown>).workspace;
        if (typeof workspace === 'object' && workspace !== null && !Array.isArray(workspace)) {
          const enhancer = (workspace as Record<string, unknown>).cvat3dEnhancer;
          if (typeof enhancer === 'object' && enhancer !== null && !Array.isArray(enhancer)) {
            clientSettingsOptions = normalizeRenderOptionsRecord(
              enhancer as Record<string, unknown>
            );
          }
        }
      }
    }
  } catch {
    clientSettingsOptions = null;
  }

  if (standaloneOptions) {
    // If CVAT's SettingsModal overwrote `clientSettings` with stale Redux state, heal `clientSettings`
    if (
      typeof storage.setItem === 'function' &&
      (!clientSettingsOptions ||
        WORKSPACE_FEATURE_KEYS.some(
          (key) => (clientSettingsOptions[key] ?? true) !== (standaloneOptions[key] ?? true)
        ) ||
        (clientSettingsOptions.followActiveObject ?? true) !==
          (standaloneOptions.followActiveObject ?? true))
    ) {
      try {
        writeRenderOptionsToClientSettings(
          standaloneOptions,
          storage as Pick<Storage, 'getItem' | 'setItem'>
        );
      } catch {
        // Ignore storage write errors in restricted contexts
      }
    }
    return standaloneOptions;
  }

  if (clientSettingsOptions) {
    if (typeof storage.setItem === 'function') {
      try {
        storage.setItem(ENHANCER_STANDALONE_STORAGE_KEY, JSON.stringify(clientSettingsOptions));
      } catch {
        // Ignore storage write errors
      }
    }
    return clientSettingsOptions;
  }

  return { ...DEFAULT_CVAT_3D_RENDER_OPTIONS };
}

/**
 * Writes `workspace.cvat3dEnhancer` into CVAT's native `localStorage['clientSettings']`
 * AND `localStorage['cvat3dEnhancerSettings']` while preserving `player`, `workspace`,
 * `shortcuts`, and `imageFilters`.
 */
export function writeRenderOptionsToClientSettings(
  options: Cvat3dWorkspaceRenderOptions,
  storage: Pick<Storage, 'getItem' | 'setItem'> = window.localStorage
): Cvat3dWorkspaceRenderOptions {
  let root: Record<string, unknown> = {};
  try {
    const existingRaw = storage.getItem(CLIENT_SETTINGS_STORAGE_KEY);
    if (existingRaw) {
      const parsed: unknown = JSON.parse(existingRaw);
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        root = parsed as Record<string, unknown>;
      }
    }
  } catch {
    root = {};
  }

  const workspace =
    typeof root.workspace === 'object' && root.workspace !== null && !Array.isArray(root.workspace)
      ? (root.workspace as Record<string, unknown>)
      : {};

  const normalized = normalizeRenderOptionsRecord({ ...options });

  root.workspace = {
    ...workspace,
    cvat3dEnhancer: normalized,
  };

  try {
    storage.setItem(ENHANCER_STANDALONE_STORAGE_KEY, JSON.stringify(normalized));
  } catch {
    // Ignore standalone write error if quota exceeded
  }
  storage.setItem(CLIENT_SETTINGS_STORAGE_KEY, JSON.stringify(root));
  return normalized;
}

const CUBOID_VIEW_KEYS = ['perspective', 'top', 'side', 'front'] as const;

const ORTHO_RAYCAST_PLANE_NAMES = new Set(['topPlane', 'sidePlane', 'frontPlane']);

type RaycastPlaneGeometryLike = NonNullable<ThreeObject3DLike['geometry']> & {
  parameters?: {
    width?: number;
    height?: number;
    widthSegments?: number;
    heightSegments?: number;
  };
  index?: {
    array: Uint16Array | Uint32Array | Float32Array | number[];
    count?: number;
    needsUpdate?: boolean;
  } | null;
  boundingBox?: unknown;
  boundingSphere?: unknown;
  dispose?: () => void;
};

const sceneRaycastPlaneCache = new WeakMap<object, ThreeObject3DLike>();

function isPlaneGeometryAlreadySimplified(geom: RaycastPlaneGeometryLike | undefined): boolean {
  if (!geom) {
    return false;
  }
  const widthSegments = Number(geom.parameters?.widthSegments ?? 1);
  const heightSegments = Number(geom.parameters?.heightSegments ?? 1);
  const indexCount = Number(geom.index?.count ?? geom.index?.array?.length ?? 0);
  const posCount = Number(
    geom.attributes?.position?.count ??
      (geom.attributes?.position?.array ? geom.attributes.position.array.length / 3 : 0)
  );
  return widthSegments <= 1 && heightSegments <= 1 && indexCount <= 6 && posCount <= 4;
}

function isCachedPlaneAttachedToScene(scene: ThreeSceneLike, plane: ThreeObject3DLike): boolean {
  const parent = (plane as { parent?: unknown }).parent;
  if (parent !== undefined) {
    return parent === scene;
  }
  const children = scene.children;
  const headLimit = Math.min(children.length, 6);
  for (let i = 0; i < headLimit; i += 1) {
    if (children[i] === plane) {
      return true;
    }
  }
  const tailStart = Math.max(headLimit, children.length - 4);
  for (let i = tailStart; i < children.length; i += 1) {
    if (children[i] === plane) {
      return true;
    }
  }
  return false;
}

/**
 * CVAT's `onSceneImageLoaded` creates invisible raycast planes (`topPlane`, `sidePlane`, `frontPlane`)
 * using `new THREE.PlaneGeometry(offsetHeight, offsetWidth, offsetHeight, offsetWidth)`.
 * Replacing the subdivided geometry with a 1x1 segment plane (2 triangles) preserves the exact same
 * mathematical plane and `worldToLocal` transform while making resize/translate raycasts ~600,000x faster,
 * and caches the discovered plane per scene in a `WeakMap` so subsequent checks exit in O(1).
 */
export function optimizeOrthographicRaycastPlanes(
  scene?: ThreeSceneLike | null,
  optimizedPlanes?: WeakSet<object>
): number {
  if (!scene || !Array.isArray(scene.children)) {
    return 0;
  }

  const cachedPlane = sceneRaycastPlaneCache.get(scene);
  if (
    cachedPlane &&
    isCachedPlaneAttachedToScene(scene, cachedPlane) &&
    (!optimizedPlanes || optimizedPlanes.has(cachedPlane)) &&
    isPlaneGeometryAlreadySimplified(cachedPlane.geometry as RaycastPlaneGeometryLike | undefined)
  ) {
    return 0;
  }

  let optimizedCount = 0;
  const children = scene.children;
  for (let i = 0; i < children.length; i += 1) {
    const child = children[i];
    if (!child || typeof child !== 'object' || !child.name) {
      continue;
    }
    if (!ORTHO_RAYCAST_PLANE_NAMES.has(child.name)) {
      continue;
    }
    sceneRaycastPlaneCache.set(scene, child);
    if (optimizedPlanes?.has(child)) {
      continue;
    }
    optimizedPlanes?.add(child);

    const geom = child.geometry as RaycastPlaneGeometryLike | undefined;
    if (!geom) {
      continue;
    }

    if (isPlaneGeometryAlreadySimplified(geom)) {
      continue;
    }

    const width = Math.max(Number(geom.parameters?.width) || 1000, 2000);
    const height = Math.max(Number(geom.parameters?.height) || 1000, 2000);
    const GeomCtor = (geom as { constructor?: unknown }).constructor;

    if (typeof GeomCtor === 'function' && GeomCtor !== Object) {
      try {
        const replacement = new (
          GeomCtor as new (w: number, h: number, ws: number, hs: number) => typeof geom
        )(width, height, 1, 1);
        if (replacement && replacement.attributes?.position) {
          child.geometry = replacement;
          if (typeof geom.dispose === 'function') {
            geom.dispose();
          }
          optimizedCount += 1;
          continue;
        }
      } catch {
        // Fall through to in-place buffer simplification
      }
    }

    const hw = width * 0.5;
    const hh = height * 0.5;
    if (geom.attributes?.position) {
      geom.attributes.position.array = new Float32Array([
        -hw,
        hh,
        0,
        hw,
        hh,
        0,
        -hw,
        -hh,
        0,
        hw,
        -hh,
        0,
      ]);
      geom.attributes.position.count = 4;
      geom.attributes.position.needsUpdate = true;
    }
    if (geom.index) {
      geom.index.array = new Uint16Array([0, 2, 1, 2, 3, 1]);
      geom.index.count = 6;
      geom.index.needsUpdate = true;
    }
    if (geom.parameters) {
      geom.parameters = {
        width,
        height,
        widthSegments: 1,
        heightSegments: 1,
      };
    }
    geom.boundingBox = null;
    geom.boundingSphere = null;
    optimizedCount += 1;
  }
  return optimizedCount;
}

/**
 * Stateful, dirty-flagged hook layer for CVAT's `Canvas3dViewImpl`.
 * Captures per-canvas render cameras, simplifies orthographic raycast planes and defers hidden
 * cuboid/arrow updates. It never changes point cloud colors, sizes or backgrounds, and it only
 * runs a pass when the view structure or annotation objects change.
 */
const CUBOID_INITIALIZED_SYM = Symbol.for('meowCuboidInitialized');

interface InitializableCuboid {
  [CUBOID_INITIALIZED_SYM]?: boolean;
}

export class Cvat3dPreRenderEnhancer {
  private options: Cvat3dWorkspaceRenderOptions;
  private readonly hookedViews = new WeakSet<object>();
  private readonly hookedPrototypes = new WeakSet<object>();
  private readonly optimizedPlaneMeshes = new WeakSet<object>();
  private readonly scenePlaneCheckCount = new WeakMap<object, number>();
  private readonly sceneRenderContext = new Map<
    ThreeSceneLike,
    {
      renderer: NonNullable<CvatRenderViewLike['renderer']>;
      camera: unknown;
      wasConnected: boolean;
    }
  >();
  private primaryPerspectiveScene: ThreeSceneLike | null = null;
  private activeView: CvatInternalViewLike | null = null;
  private activeModel: CvatInternalCanvas3dLike['model'] | null = null;
  private lastViewCount = 0;
  private dirty = true;
  private needsIncrementalCuboidSync = false;
  private isRedrawingViews = false;
  private isApplying = false;
  private nativeNotifyDepth = 0;

  private canvasRenderListener:
    ((canvas: HTMLCanvasElement, camera: unknown, scene?: ThreeSceneLike) => void) | null = null;

  public setCanvasRenderListener(
    listener: ((canvas: HTMLCanvasElement, camera: unknown, scene?: ThreeSceneLike) => void) | null
  ): void {
    this.canvasRenderListener = listener;
  }

  /**
   * Returns the camera most recently used to render into the given `<canvas>` (captured from
   * the scene `onBeforeRender` hook), or `null` if that canvas has not been rendered yet.
   */
  public getLastRenderCameraForCanvas(canvas: HTMLCanvasElement | null | undefined): unknown {
    if (!canvas) {
      return null;
    }
    for (const [scene, ctx] of this.sceneRenderContext.entries()) {
      const domEl = ctx.renderer?.domElement;
      if (domEl?.isConnected === true && !ctx.wasConnected) {
        ctx.wasConnected = true;
      }
      if (ctx.wasConnected && domEl && domEl.isConnected === false && domEl !== canvas) {
        this.sceneRenderContext.delete(scene);
        continue;
      }
      if (domEl === canvas) {
        return ctx.camera ?? null;
      }
    }
    return null;
  }

  public constructor(
    initialOptions: Cvat3dWorkspaceRenderOptions = DEFAULT_CVAT_3D_RENDER_OPTIONS
  ) {
    this.options = normalizeRenderOptionsRecord({ ...initialOptions });
  }

  public getOptions(): Cvat3dWorkspaceRenderOptions {
    return { ...this.options };
  }

  public getOptionsReadonly(): Readonly<Cvat3dWorkspaceRenderOptions> {
    return this.options;
  }

  /** Options only toggle page-bridge behaviors; none of them require a canvas redraw. */
  public setOptions(
    next: Cvat3dWorkspaceRenderOptions,
    _canvas3d?: CvatInternalCanvas3dLike | null
  ): void {
    this.options = normalizeRenderOptionsRecord({ ...next });
  }

  public requestViewsRedraw(): void {
    if (this.isRedrawingViews) {
      return;
    }
    this.isRedrawingViews = true;
    try {
      if (typeof this.activeView?.render === 'function') {
        this.activeView.render();
      }
      const nativeScenes =
        typeof this.activeView?.render === 'function'
          ? new Set(Object.values(this.activeView.views ?? {}).map((view) => view?.scene))
          : null;
      for (const [scene, ctx] of this.sceneRenderContext.entries()) {
        const domEl = ctx.renderer?.domElement;
        if (domEl?.isConnected === true && !ctx.wasConnected) {
          ctx.wasConnected = true;
        }
        if (ctx.wasConnected && domEl && domEl.isConnected === false) {
          this.sceneRenderContext.delete(scene);
          continue;
        }
        if (nativeScenes?.has(scene)) continue;
        if (typeof ctx.renderer?.render === 'function' && ctx.camera) {
          ctx.renderer.render(scene, ctx.camera);
        }
      }
    } catch {
      // Ignore WebGL render errors if a view was disposed
    } finally {
      this.isRedrawingViews = false;
    }
  }

  public markDirty(): void {
    this.dirty = true;
  }

  /** Marks view structure dirty (e.g. when a new zoomed Top/Side/Front canvas is mounted). */
  public markViewStructureChanged(): void {
    this.dirty = true;
  }

  /**
   * Hooks `THREE.Scene.prototype.onBeforeRender` once so any newly opened canvas/zoom view
   * (including ones with their own `WebGLRenderer`) reports its camera and gets simplified
   * orthographic raycast planes.
   */
  private ensureScenePrototypeHooked(scene: ThreeSceneLike): void {
    const sceneProto = Object.getPrototypeOf(scene) as {
      onBeforeRender?: (...args: unknown[]) => void;
    } | null;
    if (!sceneProto || sceneProto === Object.prototype || this.hookedPrototypes.has(sceneProto)) {
      return;
    }
    this.hookedPrototypes.add(sceneProto);
    const origSceneBeforeRender =
      typeof sceneProto.onBeforeRender === 'function' ? sceneProto.onBeforeRender : null;
    sceneProto.onBeforeRender = (
      renderer?: unknown,
      sceneArg?: unknown,
      camera?: unknown,
      ...rest: unknown[]
    ): void => {
      if (origSceneBeforeRender) {
        origSceneBeforeRender.call(sceneArg ?? scene, renderer, sceneArg, camera, ...rest);
      }
      const sceneObj = sceneArg as ThreeSceneLike | undefined;
      if (
        sceneObj &&
        sceneObj !== this.primaryPerspectiveScene &&
        Array.isArray(sceneObj.children)
      ) {
        if (sceneRaycastPlaneCache.has(sceneObj)) {
          optimizeOrthographicRaycastPlanes(sceneObj, this.optimizedPlaneMeshes);
        } else if (this.scenePlaneCheckCount.get(sceneObj) !== sceneObj.children.length) {
          this.scenePlaneCheckCount.set(sceneObj, sceneObj.children.length);
          optimizeOrthographicRaycastPlanes(sceneObj, this.optimizedPlaneMeshes);
        }
      }
      const renObj = renderer as CvatRenderViewLike['renderer'] | undefined;
      if (renObj?.domElement && camera) {
        this.canvasRenderListener?.(renObj.domElement, camera, sceneObj);
      }
      if (sceneObj && renObj && typeof renObj.render === 'function' && camera) {
        // Remember (renderer, camera) per scene so callers can force an immediate redraw
        const previous = this.sceneRenderContext.get(sceneObj);
        const currentlyConnected = renObj.domElement?.isConnected === true;
        if (previous?.renderer !== renObj || previous.camera !== camera) {
          this.sceneRenderContext.set(sceneObj, {
            renderer: renObj,
            camera,
            wasConnected: currentlyConnected,
          });
        } else if (currentlyConnected && !previous.wasConnected) {
          previous.wasConnected = true;
        }
        if (this.sceneRenderContext.size > 16) {
          const oldestKey = this.sceneRenderContext.keys().next().value;
          if (oldestKey) this.sceneRenderContext.delete(oldestKey);
        }
      }
      if (
        this.dirty &&
        !this.isApplying &&
        this.activeView &&
        sceneObj &&
        sceneObj === this.primaryPerspectiveScene
      ) {
        this.applyOnceIfNeeded(this.activeView, this.activeModel ?? undefined);
      }
    };
  }

  /**
   * Incrementally configures newly seen cuboids in O(N) with zero `Object.values` and zero
   * `WeakSet` ephemeron allocations:
   * - Sets `material.depthWrite = false` across all 4 viewport meshes.
   * - Hooks `deferHiddenCuboidMeshUpdates` on all 4 viewport meshes.
   * - Hooks `deferHiddenOrientationArrowUpdates` on all orientation arrows using a single shared wrapper.
   */
  private syncDrawnCuboidsIncremental(
    drawnObjects?: Record<number, CvatDrawnObjectEntry> | null
  ): void {
    if (!drawnObjects) {
      return;
    }

    const isPlainObj = Object.getPrototypeOf(drawnObjects) === Object.prototype;

    for (const key in drawnObjects) {
      if (!isPlainObj && !Object.hasOwn(drawnObjects, key)) {
        continue;
      }
      const cuboid = drawnObjects[key]?.cuboid as
        (CvatDrawnObjectEntry['cuboid'] & InitializableCuboid) | undefined;
      if (!cuboid || typeof cuboid !== 'object' || cuboid[CUBOID_INITIALIZED_SYM] === true) {
        continue;
      }
      for (let v = 0; v < CUBOID_VIEW_KEYS.length; v += 1) {
        const viewMesh = cuboid[CUBOID_VIEW_KEYS[v]!];
        if (viewMesh && typeof viewMesh === 'object') {
          const meshMat = viewMesh.material;
          if (meshMat && typeof meshMat === 'object') {
            meshMat.depthWrite = false;
          }
          deferHiddenCuboidMeshUpdates(viewMesh);
        }
      }
      const arrowsByView = cuboid.orientationArrows;
      if (arrowsByView && typeof arrowsByView === 'object') {
        for (let v = 0; v < CUBOID_VIEW_KEYS.length; v += 1) {
          const arrows = arrowsByView[CUBOID_VIEW_KEYS[v]!];
          if (!arrows || typeof arrows !== 'object') {
            continue;
          }
          if ('x' in arrows || 'y' in arrows || 'z' in arrows) {
            if (arrows.x) deferHiddenOrientationArrowUpdates(arrows.x);
            if (arrows.y) deferHiddenOrientationArrowUpdates(arrows.y);
            if (arrows.z) deferHiddenOrientationArrowUpdates(arrows.z);
          } else {
            for (const arrowKey in arrows) {
              if (Object.hasOwn(arrows, arrowKey)) {
                deferHiddenOrientationArrowUpdates(arrows[arrowKey]);
              }
            }
          }
        }
      }
      cuboid[CUBOID_INITIALIZED_SYM] = true;
    }
  }

  public ensureHooked(canvas3d: CvatInternalCanvas3dLike | null): boolean {
    const view = canvas3d?.view;
    if (!view || typeof view !== 'object') {
      return false;
    }

    if (this.hookedViews.has(view)) {
      if (this.dirty || countViews(view) !== this.lastViewCount) {
        this.dirty = true;
        this.applyOnceIfNeeded(view, canvas3d?.model);
      }
      return true;
    }
    this.hookedViews.add(view);
    this.dirty = true;

    if (typeof view.notify === 'function') {
      const origNotify = view.notify.bind(view);
      view.notify = (model: unknown, reason: string): void => {
        // Native notify can render synchronously or emit nested objects_updated events;
        // wait for the outermost call before touching newly drawn cuboids.
        this.nativeNotifyDepth += 1;
        try {
          origNotify(model, reason);
        } finally {
          this.nativeNotifyDepth -= 1;
        }
        if (reason === 'objects_updated') {
          this.needsIncrementalCuboidSync = true;
        }
        if (this.nativeNotifyDepth === 0) {
          if (this.dirty) {
            this.needsIncrementalCuboidSync = false;
            this.applyOnceIfNeeded(view, canvas3d?.model);
          } else if (this.needsIncrementalCuboidSync) {
            this.needsIncrementalCuboidSync = false;
            this.syncDrawnCuboidsIncremental(view.drawnObjects);
          }
        }
      };
    }

    if (typeof view.render === 'function') {
      const origRender = view.render.bind(view);
      view.render = (): void => {
        if (this.dirty) {
          this.applyOnceIfNeeded(view, canvas3d?.model);
        }
        origRender();
      };
    }

    this.applyOnceIfNeeded(view, canvas3d?.model);
    return true;
  }

  public applyOnceIfNeeded(
    view: CvatInternalViewLike,
    model?: CvatInternalCanvas3dLike['model']
  ): boolean {
    const views = view.views;
    if (!views || this.isApplying || this.nativeNotifyDepth > 0) {
      return false;
    }
    this.activeView = view;
    if (model) {
      this.activeModel = model;
    }
    const viewCount = countViews(view);
    if (!this.dirty && viewCount === this.lastViewCount) {
      return false;
    }
    this.isApplying = true;
    try {
      this.primaryPerspectiveScene = views.perspective?.scene ?? null;
      for (const key in views) {
        if (!Object.hasOwn(views, key)) continue;
        const scene = views[key]?.scene;
        if (!scene) continue;
        this.ensureScenePrototypeHooked(scene);
        optimizeOrthographicRaycastPlanes(scene, this.optimizedPlaneMeshes);
      }
      this.syncDrawnCuboidsIncremental(view.drawnObjects);
      this.lastViewCount = viewCount;
      this.dirty = false;
      return true;
    } finally {
      this.isApplying = false;
    }
  }
}

function countViews(view: CvatInternalViewLike): number {
  let count = 0;
  if (view.views) {
    for (const key in view.views) {
      if (Object.hasOwn(view.views, key)) count += 1;
    }
  }
  return count;
}

const WORKSPACE_SETTINGS_INJECTED_ID = 'cvat-3d-enhancer-workspace-settings-section';

function extractAntdHashClass(container: Element): string {
  const sample = container.querySelector('[class*="css-"]');
  if (sample && typeof sample.className === 'string') {
    const match = /\b(css-[a-z0-9_-]+)\b/i.exec(sample.className);
    if (match?.[1]) {
      return ` ${match[1]}`;
    }
  }
  return '';
}

function computeOptionsSignature(opts: Cvat3dWorkspaceRenderOptions): string {
  return [
    ...WORKSPACE_FEATURE_KEYS.map((key) => ((opts[key] ?? true) ? 1 : 0)),
    (opts.followActiveObject ?? true) ? 1 : 0,
  ].join(':');
}

/**
 * Injects the tickable 3D render options directly into CVAT's native Settings -> Workspace tab
 * (`.cvat-workspace-settings`) using CVAT's exact Ant Design Row/Col/Checkbox/Text DOM structure
 * so the options blend seamlessly with native CVAT settings.
 */
export function injectCvatWorkspaceSettingsControls(
  doc: Document,
  getOptions: () => Cvat3dWorkspaceRenderOptions,
  onChange: (next: Cvat3dWorkspaceRenderOptions) => void
): boolean {
  const containers = doc.querySelectorAll<HTMLElement>('.cvat-workspace-settings');
  if (containers.length === 0) {
    return false;
  }

  const syncCheckboxVisualState = (input: HTMLInputElement, checked: boolean): void => {
    if (input.checked !== checked) {
      input.checked = checked;
    }
    const checkboxSpan = input.closest('.ant-checkbox');
    const wrapperLabel = input.closest('.ant-checkbox-wrapper');
    if (checkboxSpan && checkboxSpan.classList.contains('ant-checkbox-checked') !== checked) {
      checkboxSpan.classList.toggle('ant-checkbox-checked', checked);
    }
    if (
      wrapperLabel &&
      wrapperLabel.classList.contains('ant-checkbox-wrapper-checked') !== checked
    ) {
      wrapperLabel.classList.toggle('ant-checkbox-wrapper-checked', checked);
    }
  };

  const items: {
    readonly key: keyof Cvat3dWorkspaceRenderOptions;
    readonly rowClass: string;
    readonly title: string;
    readonly description: string;
  }[] = [
    {
      key: 'followActiveObject',
      rowClass: 'cvat-workspace-settings-3d-follow-active-object',
      title: 'Keep active object fixed on screen when changing frames',
      description:
        'Move the 3D perspective camera with the active object so it stays at the same screen position on Next/Previous frame',
    },
  ];

  items.push(
    ...WORKSPACE_FEATURE_CONTROLS.map((item) => ({
      ...item,
      rowClass: `cvat-workspace-settings-${item.key}`,
    }))
  );

  const opts = getOptions();
  const optsSig = computeOptionsSignature(opts);
  let mountedAny = false;

  for (const container of containers) {
    let existing = container.querySelector<HTMLElement>(
      `#${WORKSPACE_SETTINGS_INJECTED_ID}, [data-enhancer-workspace-settings="true"]`
    );
    if (existing && existing.querySelectorAll('input[data-enhancer-opt]').length !== items.length) {
      existing.remove();
      existing = null;
    }
    if (existing) {
      mountedAny = true;
      // Skip DOM mutation if options have not changed since last sync (prevents MutationObserver
      // from resetting input.checked mid-click!)
      if (existing.dataset.enhancerOptsSig === optsSig) {
        continue;
      }
      existing.dataset.enhancerOptsSig = optsSig;
      for (const item of items) {
        const input = existing.querySelector<HTMLInputElement>(
          `input[data-enhancer-opt="${item.key}"]`
        );
        if (input)
          syncCheckboxVisualState(
            input,
            opts[item.key] ?? DEFAULT_CVAT_3D_RENDER_OPTIONS[item.key] ?? false
          );
      }
      continue;
    }

    const antdHash = extractAntdHashClass(container);
    const wrapper = doc.createElement('div');
    wrapper.id = WORKSPACE_SETTINGS_INJECTED_ID;
    wrapper.dataset.enhancerWorkspaceSettings = 'true';
    wrapper.dataset.enhancerOptsSig = optsSig;

    for (const item of items) {
      const isChecked = opts[item.key] ?? DEFAULT_CVAT_3D_RENDER_OPTIONS[item.key] ?? false;

      const row = doc.createElement('div');
      row.className = `ant-row ${item.rowClass} cvat-player-setting${antdHash}`;
      row.style.position = 'relative';

      const checkboxCol = doc.createElement('div');
      checkboxCol.className = `ant-col ant-col-24${antdHash}`;

      const label = doc.createElement('label');
      label.className = `ant-checkbox-wrapper cvat-text-color${antdHash}${
        isChecked ? ' ant-checkbox-wrapper-checked' : ''
      }`;
      label.style.cssText =
        'position: relative; display: inline-flex; align-items: center; cursor: pointer; user-select: none;';

      const checkboxSpan = doc.createElement('span');
      checkboxSpan.className = `ant-checkbox${antdHash}${isChecked ? ' ant-checkbox-checked' : ''}`;
      checkboxSpan.style.cssText =
        'position: relative; display: inline-block; line-height: 1; cursor: pointer;';

      const checkboxInput = doc.createElement('input');
      checkboxInput.type = 'checkbox';
      checkboxInput.className = 'ant-checkbox-input';
      checkboxInput.dataset.enhancerOpt = item.key;
      checkboxInput.checked = isChecked;
      // Strictly contain the invisible input inside the 16x16 .ant-checkbox box so it never stretches
      // over neighboring checkboxes when Ant Design CSS-in-JS classes change
      checkboxInput.style.cssText =
        'position: absolute; inset: 0; width: 100%; height: 100%; margin: 0; opacity: 0; cursor: pointer; z-index: 1;';

      const checkboxInner = doc.createElement('span');
      checkboxInner.className = 'ant-checkbox-inner';

      checkboxSpan.appendChild(checkboxInput);
      checkboxSpan.appendChild(checkboxInner);

      const titleSpan = doc.createElement('span');
      titleSpan.textContent = item.title;

      label.appendChild(checkboxSpan);
      label.appendChild(titleSpan);
      checkboxCol.appendChild(label);

      const descCol = doc.createElement('div');
      descCol.className = `ant-col ant-col-24${antdHash}`;

      const descText = doc.createElement('span');
      descText.className = `ant-typography ant-typography-secondary${antdHash}`;
      descText.textContent = item.description;
      descCol.appendChild(descText);

      const applyToggle = (nextChecked: boolean): void => {
        syncCheckboxVisualState(checkboxInput, nextChecked);
        const current = getOptions();
        const updated: Cvat3dWorkspaceRenderOptions = {
          ...current,
          [item.key]: nextChecked,
        };
        wrapper.dataset.enhancerOptsSig = computeOptionsSignature(updated);
        try {
          onChange(updated);
          showMeowToast(doc, `${nextChecked ? 'Đã bật' : 'Đã tắt'}: ${item.title}`, 'success');
        } catch (error) {
          showMeowToast(doc, `Không áp dụng được: ${item.title}`, 'error');
          throw error;
        }
      };

      checkboxInput.addEventListener('change', () => {
        applyToggle(checkboxInput.checked);
      });

      label.addEventListener('click', (e: MouseEvent) => {
        if (e.target === checkboxInput) {
          return;
        }
        e.preventDefault();
        e.stopPropagation();
        applyToggle(!checkboxInput.checked);
      });

      row.appendChild(checkboxCol);
      row.appendChild(descCol);
      wrapper.appendChild(row);
    }

    container.appendChild(wrapper);
    mountedAny = true;
  }

  return mountedAny;
}

export type CuboidDimensionKey = 'H' | 'W' | 'L' | 'FLIP_180' | 'SWAP_LW' | 'YAW_INTERPOLATE';

export const CUBOID_DIMENSION_INDEX: Readonly<Record<CuboidDimensionKey, number>> = Object.freeze({
  SWAP_LW: 5,
  YAW_INTERPOLATE: 5,
  FLIP_180: 5, // rotation.z (Yaw / Hướng đầu xe)
  L: 6, // scale.x (Length / Dài)
  W: 7, // scale.y (Width / Rộng)
  H: 8, // scale.z (Height / Cao)
});

/**
 * Normalizes `rz + Math.PI` (180-degree heading flip) into `[0, 2 * Math.PI)`.
 */
export function flipYawAngle180Rad(rz: number): number {
  return wrapYaw((Number(rz) || 0) + Math.PI);
}

export interface DimensionSyncResult {
  readonly clientID: number;
  readonly dimension: CuboidDimensionKey;
  readonly targetValue: number | null;
  readonly syncedFrames: number;
  readonly skippedAttributeMismatchFrames: number;
}

/**
 * Flips the 3D cuboid's heading (Yaw / `points[5]`) by 180 degrees (`+Math.PI` rad)
 * on the current frame only.
 */
export async function flipCuboidYaw180OnCurrentFrame(
  clientID: number,
  options: {
    drawnEntry?: CvatDrawnObjectEntry | null;
    stateOnCurrentFrame?: CvatObjectStateLike | null;
    perspectiveCanvas?:
      | (HTMLCanvasElement & {
          updatePosition?: (state: CvatObjectStateLike, points: number[]) => void;
        })
      | null;
    onAfterSync?: () => void;
  }
): Promise<DimensionSyncResult> {
  const entry = options.drawnEntry ?? null;
  const currentState = options.stateOnCurrentFrame ?? entry?.state ?? null;

  if (!currentState || currentState.lock) {
    return {
      clientID,
      dimension: 'FLIP_180',
      targetValue: null,
      syncedFrames: 0,
      skippedAttributeMismatchFrames: 0,
    };
  }

  const currentPoints =
    Array.isArray(currentState.points) && currentState.points.length >= 9
      ? currentState.points
      : Array.isArray(entry?.data?.points) && entry.data.points.length >= 9
        ? entry.data.points
        : null;

  if (!currentPoints) {
    return {
      clientID,
      dimension: 'FLIP_180',
      targetValue: null,
      syncedFrames: 0,
      skippedAttributeMismatchFrames: 0,
    };
  }

  const nextYaw = flipYawAngle180Rad(Number(currentPoints[5]));
  const updatedPoints = [...currentPoints];
  updatedPoints[5] = nextYaw;

  const currentFrame = Number(currentState.frame ?? 0);
  currentState.updateFlags?.reset?.();
  currentState.points = updatedPoints;
  if (currentState.updateFlags) {
    currentState.updateFlags.points = true;
  }

  let dispatchState: CvatObjectStateLike = currentState;
  const internalSave = currentState.__internal?.save;
  if (typeof internalSave === 'function') {
    dispatchState = internalSave(currentFrame, currentState);
  } else if (typeof currentState.save === 'function') {
    dispatchState = await currentState.save();
  }

  if (entry?.data?.points && entry.data.points.length >= 9) {
    entry.data.points[5] = nextYaw;
  }
  if (typeof entry?.cuboid?.setRotation === 'function') {
    entry.cuboid.setRotation(updatedPoints[3]!, updatedPoints[4]!, nextYaw);
  }
  for (const viewKey of ['perspective', 'top', 'side', 'front'] as const) {
    const rot = entry?.cuboid?.[viewKey]?.rotation;
    if (rot && typeof rot === 'object') {
      rot.z = nextYaw;
    }
  }

  const perspCanvas = options.perspectiveCanvas ?? null;
  if (perspCanvas && dispatchState) {
    if (typeof perspCanvas.updatePosition === 'function') {
      perspCanvas.updatePosition(dispatchState, [...updatedPoints]);
    } else {
      perspCanvas.dispatchEvent(
        new CustomEvent('canvas.edited', {
          bubbles: false,
          cancelable: true,
          detail: {
            state: dispatchState,
            points: [...updatedPoints],
          },
        })
      );
    }
  }

  options.onAfterSync?.();

  return {
    clientID,
    dimension: 'FLIP_180',
    targetValue: nextYaw,
    syncedFrames: 1,
    skippedAttributeMismatchFrames: 0,
  };
}

/**
 * Mandatory 100% attribute equality check between the current frame and any candidate frame.
 * Returns `true` ONLY if every attribute key and value matches 100%.
 */
export function haveIdenticalAttributes(
  attrsA: Record<number | string, unknown> | undefined | null,
  attrsB: Record<number | string, unknown> | undefined | null
): boolean {
  const a = attrsA ?? {};
  const b = attrsB ?? {};
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) {
    return false;
  }
  for (const key of keysA) {
    if (!Object.prototype.hasOwnProperty.call(b, key)) {
      return false;
    }
    if (String(a[key] ?? '').trim() !== String(b[key] ?? '').trim()) {
      return false;
    }
  }
  return true;
}

/**
 * Synchronizes a single 3D cuboid dimension (`H`, `W`, or `L`) from the current frame
 * across all keyframes of the same track (`clientID`) in real-time on CVAT, strictly
 * updating ONLY frames whose attributes 100% match the current frame's attributes.
 */
export async function syncTrackCuboidDimension(
  clientID: number,
  dimension: CuboidDimensionKey,
  options: {
    wholeTrack?: boolean;
    yawRange?: readonly [number, number];
    drawnEntry?: CvatDrawnObjectEntry | null;
    stateOnCurrentFrame?: CvatObjectStateLike | null;
    perspectiveCanvas?:
      | (HTMLCanvasElement & {
          updatePosition?: (state: CvatObjectStateLike, points: number[]) => void;
        })
      | null;
    onAfterSync?: () => void;
  }
): Promise<DimensionSyncResult> {
  if (
    dimension === 'SWAP_LW' ||
    dimension === 'YAW_INTERPOLATE' ||
    (dimension === 'FLIP_180' && options.wholeTrack)
  ) {
    const current = options.stateOnCurrentFrame ?? options.drawnEntry?.state;
    if (!current) throw new Error('CVAT ObjectState is unavailable');
    const syncedFrames =
      dimension === 'YAW_INTERPOLATE'
        ? await interpolateTrackYaw(clientID, current, options.yawRange)
        : await reorientTrack(
            clientID,
            current,
            dimension === 'SWAP_LW' ? 'swap' : 'flip',
            options.wholeTrack
          );
    current.updateFlags!.reset!();
    const fresh = current.__internal!.save!(current.frame!, current);
    if (fresh.points) {
      const entry = options.drawnEntry;
      if (entry) {
        entry.data.points = [...fresh.points];
        entry.cuboid.setScale?.(fresh.points[6]!, fresh.points[7]!, fresh.points[8]!);
        entry.cuboid.setRotation?.(fresh.points[3]!, fresh.points[4]!, fresh.points[5]!);
      }
      // Native keyframe writes above already persist locally. Refresh once below;
      // canvas.edited/updatePosition would save the displayed frame a second time.
    }
    options.onAfterSync?.();
    return {
      clientID,
      dimension,
      targetValue: fresh.points?.[5] ?? null,
      syncedFrames,
      skippedAttributeMismatchFrames: 0,
    };
  }
  if (dimension === 'FLIP_180') {
    return flipCuboidYaw180OnCurrentFrame(clientID, options);
  }
  const dimIndex = CUBOID_DIMENSION_INDEX[dimension];
  const entry = options.drawnEntry ?? null;
  const currentState = options.stateOnCurrentFrame ?? entry?.state ?? null;

  if (!currentState || currentState.lock) {
    return {
      clientID,
      dimension,
      targetValue: null,
      syncedFrames: 0,
      skippedAttributeMismatchFrames: 0,
    };
  }

  const currentPoints =
    Array.isArray(currentState.points) && currentState.points.length >= 9
      ? currentState.points
      : Array.isArray(entry?.data?.points) && entry.data.points.length >= 9
        ? entry.data.points
        : null;

  if (!currentPoints) {
    return {
      clientID,
      dimension,
      targetValue: null,
      syncedFrames: 0,
      skippedAttributeMismatchFrames: 0,
    };
  }

  const targetValue = Number(currentPoints[dimIndex]);
  if (!Number.isFinite(targetValue) || targetValue <= 0) {
    return {
      clientID,
      dimension,
      targetValue: null,
      syncedFrames: 0,
      skippedAttributeMismatchFrames: 0,
    };
  }

  const currentFrame = Number(currentState.frame ?? 0);
  const currentAttributes: Record<number | string, string> = {
    ...(currentState.attributes ?? {}),
  };

  let serializedTrack: CvatSerializedTrack | null = null;
  if (typeof currentState.__internal?.export === 'function') {
    serializedTrack = currentState.__internal.export();
  } else if (typeof currentState.export === 'function') {
    serializedTrack = await currentState.export();
  }

  const rawShapes = Array.isArray(serializedTrack?.shapes)
    ? [...serializedTrack.shapes].sort((a, b) => Number(a.frame) - Number(b.frame))
    : [];

  if (rawShapes.length === 0) {
    return {
      clientID,
      dimension,
      targetValue,
      syncedFrames: 0,
      skippedAttributeMismatchFrames: 0,
    };
  }

  // Build cumulative attribute table (matching CVAT's Track.prototype.getAttributes) as fallback
  const rollingAttrs: Record<number | string, string> = {};
  for (const k of Object.keys(currentAttributes)) {
    rollingAttrs[k] = String(currentAttributes[k] ?? '');
  }
  if (Array.isArray(serializedTrack?.attributes)) {
    for (const attr of serializedTrack.attributes) {
      rollingAttrs[attr.spec_id] = String(attr.value);
    }
  }

  let syncedFrames = 0;
  let skippedAttributeMismatchFrames = 0;
  let stateToDispatchForCanvasUpdate: CvatObjectStateLike | null = null;
  let pointsToDispatchForCanvasUpdate: number[] | null = null;

  const internalSave = currentState.__internal?.save;

  const rawLabelName = String((currentState as { label?: { name?: string } }).label?.name ?? '')
    .trim()
    .toLowerCase();
  const isTwoWheels =
    rawLabelName === 'two-wheels' ||
    rawLabelName === 'two-wheel' ||
    rawLabelName === 'twowheels' ||
    rawLabelName === 'two_wheels' ||
    Number(
      (currentState as { label?: { id?: number }; label_id?: number }).label?.id ??
        (currentState as { label_id?: number }).label_id
    ) === 36192;

  for (const shape of rawShapes) {
    const kfFrame = Number(shape.frame);
    if (!Number.isInteger(kfFrame)) {
      continue;
    }

    if (Array.isArray(shape.attributes)) {
      for (const attr of shape.attributes) {
        rollingAttrs[attr.spec_id] = String(attr.value);
      }
    }

    let kfState: CvatObjectStateLike | null = null;
    if (typeof internalSave === 'function') {
      currentState.updateFlags?.reset?.();
      kfState = internalSave(kfFrame, currentState);
    }

    const effectiveKfAttrs = kfState?.attributes ?? { ...rollingAttrs };

    // MANDATORY CHECK: 100% attribute match with current frame
    // (For two-wheels, H and L must always fit across all frames regardless of ride_state changes)
    const bypassAttrMatchForTwoWheelsHL = isTwoWheels && (dimension === 'H' || dimension === 'L');
    if (
      !bypassAttrMatchForTwoWheelsHL &&
      !haveIdenticalAttributes(currentAttributes, effectiveKfAttrs)
    ) {
      skippedAttributeMismatchFrames += 1;
      continue;
    }

    const existingKfPoints =
      Array.isArray(kfState?.points) && kfState.points.length >= 9
        ? kfState.points
        : Array.isArray(shape.points) && shape.points.length >= 9
          ? shape.points
          : null;

    if (!existingKfPoints) {
      continue;
    }

    const updatedPoints = [...existingKfPoints];
    if (dimension === 'H') {
      updatedPoints[2] = existingKfPoints[2]! + (targetValue - existingKfPoints[8]!) / 2;
    }
    updatedPoints[dimIndex] = targetValue;
    shape.points = updatedPoints;

    if (kfState) {
      kfState.points = updatedPoints;
      if (kfState.updateFlags) {
        kfState.updateFlags.points = true;
      }
      if (typeof internalSave === 'function') {
        const saved = internalSave(kfFrame, kfState);
        if (kfFrame === currentFrame) {
          stateToDispatchForCanvasUpdate = saved;
          pointsToDispatchForCanvasUpdate = updatedPoints;
        }
      } else if (typeof kfState.save === 'function') {
        const saved = await kfState.save();
        if (kfFrame === currentFrame) {
          stateToDispatchForCanvasUpdate = saved;
          pointsToDispatchForCanvasUpdate = updatedPoints;
        }
      }
    }

    syncedFrames += 1;
  }

  // Also ensure currentFrame state & cuboid scale reflect the synced dimension in real-time
  const nextCurrentPoints = [...currentPoints];
  if (dimension === 'H') {
    nextCurrentPoints[2] = currentPoints[2]! + (targetValue - currentPoints[8]!) / 2;
  }
  nextCurrentPoints[dimIndex] = targetValue;
  if (entry?.data?.points && entry.data.points.length >= 9) {
    if (dimension === 'H') {
      entry.data.points[2] = entry.data.points[2]! + (targetValue - entry.data.points[8]!) / 2;
      for (const viewKey of ['perspective', 'top', 'side', 'front'] as const) {
        const position = entry.cuboid[viewKey]?.position;
        if (position) position.z = entry.data.points[2]!;
      }
    }
    entry.data.points[dimIndex] = targetValue;
  }
  if (typeof entry?.cuboid?.setScale === 'function') {
    entry.cuboid.setScale(nextCurrentPoints[6]!, nextCurrentPoints[7]!, nextCurrentPoints[8]!);
  }

  const perspCanvas = options.perspectiveCanvas ?? null;
  const dispatchState = stateToDispatchForCanvasUpdate ?? currentState;
  const dispatchPoints = pointsToDispatchForCanvasUpdate ?? nextCurrentPoints;

  if (perspCanvas && dispatchState && syncedFrames > 0) {
    if (typeof perspCanvas.updatePosition === 'function') {
      perspCanvas.updatePosition(dispatchState, [...dispatchPoints]);
    } else {
      perspCanvas.dispatchEvent(
        new CustomEvent('canvas.edited', {
          bubbles: false,
          cancelable: true,
          detail: {
            state: dispatchState,
            points: [...dispatchPoints],
          },
        })
      );
    }
  }

  options.onAfterSync?.();

  return {
    clientID,
    dimension,
    targetValue,
    syncedFrames,
    skippedAttributeMismatchFrames,
  };
}

export { injectCvatObjectDimensionSyncControls } from './object-dimension-controls';
