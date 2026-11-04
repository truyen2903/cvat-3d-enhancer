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
 * 3. Runs pre-render pass (`applyPreRenderPass`) ONLY when dirty (once per frame load, object update,
 *    or option toggle), never recomputing on every 60fps `render()` call unless state changed.
 */

export interface Cvat3dWorkspaceRenderOptions {
  readonly whiteBackground: boolean;
  readonly enableScattering: boolean;
  readonly colorPointsByCuboid: boolean;
  readonly fixedOrthoPointSize?: boolean;
}

export const DEFAULT_CVAT_3D_RENDER_OPTIONS: Cvat3dWorkspaceRenderOptions = Object.freeze({
  whiteBackground: false,
  enableScattering: false,
  colorPointsByCuboid: false,
  fixedOrthoPointSize: true,
});

export const CLIENT_SETTINGS_STORAGE_KEY = 'clientSettings' as const;

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
  };
}

export interface CvatCuboidViewMeshLike {
  position?: { x: number; y: number; z: number };
  rotation?: { x: number; y: number; z: number };
  scale?: { x: number; y: number; z: number };
  material?: {
    color?: ThreeColorLike;
    depthWrite?: boolean;
  };
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
  state?: {
    clientID?: number;
    points?: number[];
    hidden?: boolean;
    outside?: boolean;
  };
  cuboid: {
    setColor?: (hexColor: string) => void;
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

/**
 * Reads `workspace.cvat3dEnhancer` from CVAT's native `localStorage['clientSettings']`.
 */
export function readRenderOptionsFromClientSettings(
  storage: Pick<Storage, 'getItem'> = window.localStorage
): Cvat3dWorkspaceRenderOptions {
  try {
    const raw = storage.getItem(CLIENT_SETTINGS_STORAGE_KEY);
    if (!raw) {
      return { ...DEFAULT_CVAT_3D_RENDER_OPTIONS };
    }
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) {
      return { ...DEFAULT_CVAT_3D_RENDER_OPTIONS };
    }
    const workspace = (parsed as Record<string, unknown>).workspace;
    if (typeof workspace !== 'object' || workspace === null) {
      return { ...DEFAULT_CVAT_3D_RENDER_OPTIONS };
    }
    const enhancer = (workspace as Record<string, unknown>).cvat3dEnhancer;
    if (typeof enhancer !== 'object' || enhancer === null) {
      return { ...DEFAULT_CVAT_3D_RENDER_OPTIONS };
    }
    const obj = enhancer as Record<string, unknown>;
    return {
      whiteBackground: Boolean(obj.whiteBackground),
      enableScattering: Boolean(obj.enableScattering),
      colorPointsByCuboid: Boolean(obj.colorPointsByCuboid),
      fixedOrthoPointSize:
        typeof obj.fixedOrthoPointSize === 'boolean' ? obj.fixedOrthoPointSize : true,
    };
  } catch {
    return { ...DEFAULT_CVAT_3D_RENDER_OPTIONS };
  }
}

/**
 * Writes `workspace.cvat3dEnhancer` into CVAT's native `localStorage['clientSettings']`
 * while preserving `player`, `workspace`, `shortcuts`, and `imageFilters`.
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

  const normalized: Cvat3dWorkspaceRenderOptions = {
    whiteBackground: Boolean(options.whiteBackground),
    enableScattering: Boolean(options.enableScattering),
    colorPointsByCuboid: Boolean(options.colorPointsByCuboid),
    fixedOrthoPointSize: options.fixedOrthoPointSize ?? true,
  };

  root.workspace = {
    ...workspace,
    cvat3dEnhancer: normalized,
  };

  storage.setItem(CLIENT_SETTINGS_STORAGE_KEY, JSON.stringify(root));
  return normalized;
}

export function parseHexColorToNormalizedRgb(hex: string): [number, number, number] {
  const clean = hex.trim().replace(/^#/, '');
  if (!/^[0-9a-fA-F]{6}$/.test(clean)) {
    return [0.22, 0.74, 0.97];
  }
  const num = parseInt(clean, 16);
  const r = ((num >> 16) & 255) / 255;
  const g = ((num >> 8) & 255) / 255;
  const b = (num & 255) / 255;
  return [r, g, b];
}

/**
 * Curated per-vehicle / per-cuboid palettes designed to stand out vividly against White vs Black backgrounds.
 * Red/Crimson is intentionally excluded from single-box palettes and reserved exclusively as the 3rd color
 * for overlapping regions wrapped by 2+ bounding boxes.
 */
export const WHITE_BG_BOX_PALETTE: readonly [number, number, number][] = [
  [0.0, 0.32, 0.8], // #0052cc Vivid Cobalt Blue
  [0.0, 0.53, 0.35], // #00875a Deep Emerald Green
  [0.4, 0.33, 0.75], // #6554c0 Royal Purple
  [0.85, 0.47, 0.02], // #d97706 Burnt Amber Gold
  [0.0, 0.64, 0.75], // #00a3bf Deep Teal Cyan
  [0.15, 0.39, 0.92], // #2563eb Sapphire Blue
  [0.08, 0.5, 0.24], // #15803d Forest Green
  [0.49, 0.23, 0.93], // #7c3aed Vivid Violet
  [0.8, 0.33, 0.0], // #cc5500 Burnt Orange
  [0.03, 0.57, 0.7], // #0891b2 Ocean Cyan
  [0.31, 0.27, 0.9], // #4f46e5 Indigo
  [0.4, 0.64, 0.05], // #65a30d Olive Lime
];

export const BLACK_BG_BOX_PALETTE: readonly [number, number, number][] = [
  [0.22, 0.74, 0.97], // #38bdf8 Electric Sky Blue
  [0.29, 0.87, 0.5], // #4ade80 Neon Mint Green
  [0.65, 0.55, 0.98], // #a78bfa Luminous Lavender Violet
  [0.98, 0.75, 0.14], // #fbbf24 Cyber Amber Gold
  [0.18, 0.83, 0.75], // #2dd4bf Bright Aqua Teal
  [0.64, 0.9, 0.21], // #a3e635 Electric Lime
  [0.38, 0.65, 0.98], // #60a5fa Bright Azure
  [0.75, 0.52, 0.99], // #c084fc Bright Orchid
  [0.98, 0.57, 0.24], // #fb923c Sunset Orange
  [0.13, 0.83, 0.93], // #22d3ee Laser Cyan
  [0.2, 0.83, 0.6], // #34d399 Bright Emerald
  [0.98, 0.8, 0.08], // #facc15 Vivid Yellow
];

/**
 * Dedicated 3rd color reserved exclusively for points that fall inside 2 or more overlapping cuboids.
 */
export const OVERLAP_RGB_WHITE_BG: readonly [number, number, number] = [0.86, 0.08, 0.24]; // #dc143c Vivid Crimson
export const OVERLAP_RGB_BLACK_BG: readonly [number, number, number] = [1.0, 0.18, 0.33]; // #ff2e54 Neon Crimson-Red

export function getDistinctCuboidColor(
  clientID: number,
  fallbackIndex: number,
  whiteBackground: boolean
): [number, number, number] {
  const palette = whiteBackground ? WHITE_BG_BOX_PALETTE : BLACK_BG_BOX_PALETTE;
  const idNum = Number.isFinite(clientID) && clientID >= 0 ? Math.floor(clientID) : fallbackIndex;
  const entry = palette[idNum % palette.length]!;
  return [entry[0], entry[1], entry[2]];
}

export function normalizedRgbToHex(r: number, g: number, b: number): string {
  const toByte = (v: number) =>
    Math.max(0, Math.min(255, Math.round(v * 255)))
      .toString(16)
      .padStart(2, '0');
  return `#${toByte(r)}${toByte(g)}${toByte(b)}`;
}

interface OrientedBoxBounds {
  readonly clientID: number;
  readonly cx: number;
  readonly cy: number;
  readonly cz: number;
  readonly hx: number;
  readonly hy: number;
  readonly hz: number;
  readonly r00: number;
  readonly r01: number;
  readonly r02: number;
  readonly r10: number;
  readonly r11: number;
  readonly r12: number;
  readonly r20: number;
  readonly r21: number;
  readonly r22: number;
  readonly minX: number;
  readonly maxX: number;
  readonly minY: number;
  readonly maxY: number;
  readonly minZ: number;
  readonly maxZ: number;
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

/**
 * Precomputes inverse Euler XYZ rotation matrix, AABB envelope, and distinct background-adapted color
 * for each 3D cuboid so point-in-cuboid testing runs in O(1) arithmetic operations per point.
 */
export function compileOrientedCuboids(
  drawnObjects: Record<number, CvatDrawnObjectEntry>,
  whiteBackground = false
): OrientedBoxBounds[] {
  const result: OrientedBoxBounds[] = [];
  let boxIdx = 0;

  for (const entry of Object.values(drawnObjects)) {
    const data = entry?.data;
    const state = entry?.state;
    const hidden = Boolean(data?.hidden ?? state?.hidden);
    const outside = Boolean(data?.outside ?? state?.outside);
    if (hidden || outside) {
      continue;
    }

    const rawPoints =
      Array.isArray(data?.points) && data.points.length >= 9
        ? data.points
        : Array.isArray(state?.points) && state.points.length >= 9
          ? state.points
          : null;

    const perspMesh = entry?.cuboid?.perspective;
    for (const viewKey of ['perspective', 'top', 'side', 'front'] as const) {
      const meshMat = entry?.cuboid?.[viewKey]?.material;
      if (meshMat && typeof meshMat === 'object') {
        meshMat.depthWrite = false;
      }
    }
    let cx = 0;
    let cy = 0;
    let cz = 0;
    let rx = 0;
    let ry = 0;
    let rz = 0;
    let sx = 0;
    let sy = 0;
    let sz = 0;

    if (rawPoints) {
      cx = Number(rawPoints[0]);
      cy = Number(rawPoints[1]);
      cz = Number(rawPoints[2]);
      rx = Number(rawPoints[3]);
      ry = Number(rawPoints[4]);
      rz = Number(rawPoints[5]);
      sx = Math.abs(Number(rawPoints[6]));
      sy = Math.abs(Number(rawPoints[7]));
      sz = Math.abs(Number(rawPoints[8]));
    } else if (perspMesh?.position && perspMesh?.rotation && perspMesh?.scale) {
      cx = Number(perspMesh.position.x);
      cy = Number(perspMesh.position.y);
      cz = Number(perspMesh.position.z);
      rx = Number(perspMesh.rotation.x);
      ry = Number(perspMesh.rotation.y);
      rz = Number(perspMesh.rotation.z);
      sx = Math.abs(Number(perspMesh.scale.x));
      sy = Math.abs(Number(perspMesh.scale.y));
      sz = Math.abs(Number(perspMesh.scale.z));
    } else {
      continue;
    }

    if (sx <= 0 || sy <= 0 || sz <= 0) {
      continue;
    }

    const hx = sx * 0.5;
    const hy = sy * 0.5;
    const hz = sz * 0.5;

    // Three.js default Euler order is 'XYZ': R = Rx * Ry * Rz
    const cxRot = Math.cos(rx);
    const sxRot = Math.sin(rx);
    const cyRot = Math.cos(ry);
    const syRot = Math.sin(ry);
    const czRot = Math.cos(rz);
    const szRot = Math.sin(rz);

    const m00 = cyRot * czRot;
    const m01 = -cyRot * szRot;
    const m02 = syRot;

    const m10 = sxRot * syRot * czRot + cxRot * szRot;
    const m11 = -sxRot * syRot * szRot + cxRot * czRot;
    const m12 = -sxRot * cyRot;

    const m20 = -cxRot * syRot * czRot + sxRot * szRot;
    const m21 = cxRot * syRot * szRot + sxRot * czRot;
    const m22 = cxRot * cyRot;

    // AABB conservative half-extents for fast rejection before OBB dot product
    const aabbX = Math.abs(m00) * hx + Math.abs(m01) * hy + Math.abs(m02) * hz;
    const aabbY = Math.abs(m10) * hx + Math.abs(m11) * hy + Math.abs(m12) * hz;
    const aabbZ = Math.abs(m20) * hx + Math.abs(m21) * hy + Math.abs(m22) * hz;

    const clientID = Number(data?.clientID ?? state?.clientID ?? boxIdx);
    const [r, g, b] = getDistinctCuboidColor(clientID, boxIdx, whiteBackground);
    boxIdx += 1;

    // Transpose of R (R^T) maps world delta (p - c) into cuboid local frame
    result.push({
      clientID,
      cx,
      cy,
      cz,
      hx,
      hy,
      hz,
      r00: m00,
      r01: m10,
      r02: m20,
      r10: m01,
      r11: m11,
      r12: m21,
      r20: m02,
      r21: m12,
      r22: m22,
      minX: cx - aabbX,
      maxX: cx + aabbX,
      minY: cy - aabbY,
      maxY: cy + aabbY,
      minZ: cz - aabbZ,
      maxZ: cz + aabbZ,
      r,
      g,
      b,
    });
  }

  return result;
}

/**
 * Finds all `THREE.Points` instances inside a view's `THREE.Scene`.
 */
export function findPointsObjectsInScene(scene?: ThreeSceneLike): ThreeObject3DLike[] {
  if (!scene || !Array.isArray(scene.children)) {
    return [];
  }
  const found: ThreeObject3DLike[] = [];
  const stack: ThreeObject3DLike[] = [...scene.children];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    if (
      current.type === 'Points' ||
      (current.geometry?.attributes?.position && current.material && 'size' in current.material)
    ) {
      found.push(current);
    }
    if (Array.isArray(current.children)) {
      for (const child of current.children) {
        stack.push(child);
      }
    }
  }
  return found;
}

/**
 * Stateful, dirty-flagged pre-render enhancer for CVAT's `Canvas3dViewImpl`.
 * Guarantees that point cloud buffer coloring, background changes, and scattering material
 * updates execute AT MOST ONCE per frame/state change rather than every 60fps render tick.
 */
export class Cvat3dPreRenderEnhancer {
  private options: Cvat3dWorkspaceRenderOptions;
  private readonly baseColorsCache = new WeakMap<object, Float32Array>();
  private readonly hookedViews = new WeakSet<object>();
  private readonly hookedPrototypes = new WeakSet<object>();
  private readonly hookedPointObjects = new WeakSet<object>();
  private readonly primaryPerspectiveMaterials = new WeakSet<object>();
  private readonly geometrySignatureMap = new WeakMap<object, string>();
  private readonly appliedViewBackground = new WeakMap<object, boolean>();
  private primaryPerspectiveScene: ThreeSceneLike | null = null;
  private primaryPerspectiveCanvas: HTMLCanvasElement | null = null;
  private lastCompiledBoxes: OrientedBoxBounds[] = [];
  private lastExecutionSignature = '';
  private dirty = true;
  private pendingFrameObjectsLoad = true;

  public constructor(initialOptions: Cvat3dWorkspaceRenderOptions = DEFAULT_CVAT_3D_RENDER_OPTIONS) {
    this.options = {
      ...DEFAULT_CVAT_3D_RENDER_OPTIONS,
      ...initialOptions,
      fixedOrthoPointSize: initialOptions.fixedOrthoPointSize ?? true,
    };
  }

  public getOptions(): Cvat3dWorkspaceRenderOptions {
    return { ...this.options };
  }

  public setOptions(
    next: Cvat3dWorkspaceRenderOptions,
    canvas3d?: CvatInternalCanvas3dLike | null
  ): void {
    const nextOrthoFixed = next.fixedOrthoPointSize ?? true;
    const prevOrthoFixed = this.options.fixedOrthoPointSize ?? true;
    const changed =
      next.whiteBackground !== this.options.whiteBackground ||
      next.enableScattering !== this.options.enableScattering ||
      next.colorPointsByCuboid !== this.options.colorPointsByCuboid ||
      nextOrthoFixed !== prevOrthoFixed;

    this.options = {
      ...next,
      fixedOrthoPointSize: nextOrthoFixed,
    };
    if (changed) {
      this.dirty = true;
      if (canvas3d?.view) {
        this.appliedViewBackground.delete(canvas3d.view);
        this.applyOnceIfNeeded(canvas3d.view, canvas3d.model);
      }
    }
  }

  public markDirty(): void {
    this.dirty = true;
    this.pendingFrameObjectsLoad = true;
  }

  /**
   * Marks view structure dirty (e.g. when a new zoomed Top/Side/Front canvas is mounted)
   * without resetting `pendingFrameObjectsLoad` so dragged boxes remain frozen.
   */
  public markViewStructureChanged(): void {
    this.dirty = true;
  }

  /**
   * Immediately applies the target background color (`0xffffff` or `0x000000`) to all Three.js
   * scenes and WebGL renderers (including any zoomed Top/Side/Front views), even BEFORE the first
   * frame's PCD point cloud finishes loading, eliminating the initial black-frame flash on frame 0.
   */
  public applySceneBackgrounds(view: CvatInternalViewLike): void {
    if (!view.views) {
      return;
    }
    const entries = Object.entries(view.views);
    if (!this.dirty && this.appliedViewBackground.get(view) === this.options.whiteBackground) {
      return;
    }

    const targetBgHex = this.options.whiteBackground ? 0xffffff : 0x000000;
    const targetBgCss = this.options.whiteBackground ? '#ffffff' : '#000000';

    for (const [, rv] of entries) {
      if (!rv) continue;
      if (rv.scene?.background && typeof rv.scene.background.set === 'function') {
        rv.scene.background.set(targetBgHex);
      }
      if (rv.renderer?.setClearColor) {
        rv.renderer.setClearColor(targetBgHex, 1);
      }
      if (rv.renderer?.domElement) {
        rv.renderer.domElement.style.backgroundColor = targetBgCss;
      }
    }

    this.appliedViewBackground.set(view, this.options.whiteBackground);
  }

  /**
   * Hooks `THREE.Scene.prototype.onBeforeRender` and `THREE.Points.prototype.onBeforeRender`
   * (plus per-instance `onBeforeRender` fallback) so that ANY newly opened canvas/modal/zoom view
   * (e.g. when pressing the zoom key on Top, Side, or Front view) automatically receives:
   * - Fixed 2.5px point size (`size = 2.5, sizeAttenuation = false`)
   * - White/black scene & renderer background
   * - Per-cuboid point cloud colors
   * even if the zoom canvas creates its own `WebGLRenderer`, `Scene`, `Points`, or `PointsMaterial`.
   */
  private ensureThreePrototypesHooked(
    perspectiveScene?: ThreeSceneLike,
    samplePoints?: ThreeObject3DLike
  ): void {
    if (perspectiveScene && typeof perspectiveScene === 'object') {
      const sceneProto = Object.getPrototypeOf(perspectiveScene) as
        | { onBeforeRender?: (...args: unknown[]) => void }
        | null;
      if (
        sceneProto &&
        sceneProto !== Object.prototype &&
        !this.hookedPrototypes.has(sceneProto)
      ) {
        this.hookedPrototypes.add(sceneProto);
        const origSceneBeforeRender =
          typeof sceneProto.onBeforeRender === 'function' ? sceneProto.onBeforeRender : null;
        sceneProto.onBeforeRender = (
          renderer?: unknown,
          scene?: unknown,
          camera?: unknown,
          ...rest: unknown[]
        ): void => {
          if (origSceneBeforeRender) {
            origSceneBeforeRender.call(scene ?? perspectiveScene, renderer, scene, camera, ...rest);
          }
          const targetBgHex = this.options.whiteBackground ? 0xffffff : 0x000000;
          const targetBgCss = this.options.whiteBackground ? '#ffffff' : '#000000';
          const sceneObj = scene as ThreeSceneLike | undefined;
          if (sceneObj?.background && typeof sceneObj.background.set === 'function') {
            sceneObj.background.set(targetBgHex);
          }
          const renObj = renderer as CvatRenderViewLike['renderer'] | undefined;
          if (renObj?.domElement && renObj.domElement.style.backgroundColor !== targetBgCss) {
            renObj.domElement.style.backgroundColor = targetBgCss;
            if (typeof renObj.setClearColor === 'function') {
              renObj.setClearColor(targetBgHex, 1);
            }
          }
        };
      }
    }

    if (samplePoints && typeof samplePoints === 'object') {
      const pointsProto = Object.getPrototypeOf(samplePoints) as
        | { onBeforeRender?: (...args: unknown[]) => void }
        | null;
      if (
        pointsProto &&
        pointsProto !== Object.prototype &&
        !this.hookedPrototypes.has(pointsProto)
      ) {
        this.hookedPrototypes.add(pointsProto);
        const origPointsBeforeRender =
          typeof pointsProto.onBeforeRender === 'function' ? pointsProto.onBeforeRender : null;
        const onPointsRender = (
          pts: ThreeObject3DLike,
          ren?: unknown,
          scn?: unknown,
          cam?: unknown,
          mat?: unknown
        ): void => {
          this.handlePointsBeforeRender(pts, ren, scn, cam, mat);
        };
        pointsProto.onBeforeRender = function (
          this: ThreeObject3DLike,
          renderer?: unknown,
          scene?: unknown,
          camera?: unknown,
          geometry?: unknown,
          material?: unknown,
          ...rest: unknown[]
        ): void {
          if (origPointsBeforeRender) {
            origPointsBeforeRender.call(this, renderer, scene, camera, geometry, material, ...rest);
          }
          onPointsRender(this, renderer, scene, camera, material);
        };
      }
    }
  }

  private bindInstanceBeforeRenderHook(ptsObj: ThreeObject3DLike): void {
    if (!ptsObj || typeof ptsObj !== 'object' || this.hookedPointObjects.has(ptsObj)) {
      return;
    }
    const proto = Object.getPrototypeOf(ptsObj);
    if (proto && proto !== Object.prototype && this.hookedPrototypes.has(proto)) {
      return;
    }
    this.hookedPointObjects.add(ptsObj);
    const orig = typeof ptsObj.onBeforeRender === 'function' ? ptsObj.onBeforeRender : null;
    ptsObj.onBeforeRender = (
      renderer?: unknown,
      scene?: unknown,
      camera?: unknown,
      geometry?: unknown,
      material?: unknown,
      ...rest: unknown[]
    ): void => {
      if (orig) {
        orig.call(ptsObj, renderer, scene, camera, geometry, material, ...rest);
      }
      this.handlePointsBeforeRender(ptsObj, renderer, scene, camera, material);
    };
  }

  private handlePointsBeforeRender(
    ptsObj: ThreeObject3DLike,
    renderer?: unknown,
    scene?: unknown,
    camera?: unknown,
    materialArg?: unknown
  ): void {
    const camObj = camera as
      | { isOrthographicCamera?: boolean; isPerspectiveCamera?: boolean; type?: string }
      | undefined;
    const renObj = renderer as CvatRenderViewLike['renderer'] | undefined;
    const isOrthoCam = Boolean(
      camObj && (camObj.isOrthographicCamera === true || camObj.type === 'OrthographicCamera')
    );

    let isPerspective = false;
    if (!isOrthoCam) {
      if (this.primaryPerspectiveCanvas && renObj?.domElement) {
        isPerspective =
          renObj.domElement === this.primaryPerspectiveCanvas &&
          (!this.primaryPerspectiveScene || scene === this.primaryPerspectiveScene);
      } else if (this.primaryPerspectiveScene && scene) {
        isPerspective = scene === this.primaryPerspectiveScene;
      } else {
        isPerspective = Boolean(
          camObj && (camObj.isPerspectiveCamera === true || camObj.type === 'PerspectiveCamera')
        );
      }
    }

    this.applyScatteringToMaterial(ptsObj, isPerspective);
    if (
      materialArg &&
      typeof materialArg === 'object' &&
      materialArg !== ptsObj.material &&
      'size' in materialArg
    ) {
      this.applyScatteringToMaterial(
        { material: materialArg as ThreePointsMaterialLike },
        isPerspective
      );
    }

    if (
      ptsObj.geometry &&
      this.lastExecutionSignature &&
      this.geometrySignatureMap.get(ptsObj.geometry) !== this.lastExecutionSignature
    ) {
      this.geometrySignatureMap.set(ptsObj.geometry, this.lastExecutionSignature);
      this.applyPointCloudBoxColors(ptsObj, this.lastCompiledBoxes);
    }
  }

  /**
   * Hooks a `Canvas3d` instance's internal `view` (`Canvas3dViewImpl`) so that:
   * - `onSceneImageLoaded`: marks dirty + `pendingFrameObjectsLoad = true` when a new frame's PCD finishes loading.
   * - `notify`: only recomputes on `image_changed` or the initial `objects_updated` of a newly loaded frame;
   *   ignores subsequent `objects_updated` while dragging/editing a box on the current frame so point colors
   *   only update after switching frames (Next Frame -> Prev Frame) or toggling an option.
   * - `render`: executes `applyOnceIfNeeded()` BEFORE `renderer.render(scene, camera)` ONLY when dirty.
   */
  public ensureHooked(canvas3d: CvatInternalCanvas3dLike | null): boolean {
    const view = canvas3d?.view;
    if (!view || typeof view !== 'object') {
      return false;
    }

    // Always ensure background is synced immediately even before PCD finishes loading
    this.applySceneBackgrounds(view);

    if (this.hookedViews.has(view)) {
      this.applyOnceIfNeeded(view, canvas3d?.model);
      return true;
    }
    this.hookedViews.add(view);
    this.dirty = true;
    this.pendingFrameObjectsLoad = true;

    if (typeof view.onSceneImageLoaded === 'function') {
      const origOnSceneLoaded = view.onSceneImageLoaded.bind(view);
      view.onSceneImageLoaded = (points: ThreeObject3DLike): void => {
        origOnSceneLoaded(points);
        this.dirty = true;
        this.pendingFrameObjectsLoad = true;
        this.applyOnceIfNeeded(view, canvas3d?.model);
      };
    }

    if (typeof view.notify === 'function') {
      const origNotify = view.notify.bind(view);
      view.notify = (model: unknown, reason: string): void => {
        if (reason === 'image_changed') {
          this.dirty = true;
          this.pendingFrameObjectsLoad = true;
          this.appliedViewBackground.delete(view);
          this.applySceneBackgrounds(view);
        }
        origNotify(model, reason);
        if (reason === 'image_changed') {
          this.dirty = true;
          this.pendingFrameObjectsLoad = true;
          this.applyOnceIfNeeded(view, canvas3d?.model);
        } else if (reason === 'objects_updated' && this.pendingFrameObjectsLoad) {
          // Only color boxes on initial frame object load; ignore subsequent box drag/resize/rotate on same frame
          this.pendingFrameObjectsLoad = false;
          this.dirty = true;
          this.applyOnceIfNeeded(view, canvas3d?.model);
        }
      };
    }

    if (typeof view.render === 'function') {
      const origRender = view.render.bind(view);
      view.render = (): void => {
        this.applySceneBackgrounds(view);
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
    if (!view.views) {
      return false;
    }

    // Set WebGL scene background BEFORE checking whether point cloud has loaded so frame 0 never flashes black
    this.applySceneBackgrounds(view);

    const perspectiveScene = view.views.perspective?.scene;
    this.primaryPerspectiveScene = perspectiveScene ?? null;
    this.primaryPerspectiveCanvas = view.views.perspective?.renderer?.domElement ?? null;

    const perspectivePoints = findPointsObjectsInScene(perspectiveScene);
    if (perspectivePoints.length === 0) {
      // Scene point cloud not yet populated for this frame; keep dirty=true so point coloring runs on PCD load
      return false;
    }

    this.ensureThreePrototypesHooked(perspectiveScene, perspectivePoints[0]);

    const drawnObjects = view.drawnObjects ?? {};
    const hasDrawnObjects = Object.keys(drawnObjects).length > 0;
    if (hasDrawnObjects) {
      this.pendingFrameObjectsLoad = false;
    }

    const viewEntries = Object.entries(view.views);
    let totalPointsObjects = 0;
    for (const [, rv] of viewEntries) {
      if (rv?.scene) {
        totalPointsObjects += findPointsObjectsInScene(rv.scene).length;
      }
    }

    const domFrameAttr =
      view.views.perspective?.renderer?.domElement?.getAttribute?.('data-frame-number') ?? null;
    const frameId = model?.data?.imageID ?? domFrameAttr ?? 'unknown';
    const orthoFixed = this.options.fixedOrthoPointSize ?? true;
    const currentSignature = `${String(frameId)}::${this.options.whiteBackground ? 1 : 0}:${this.options.enableScattering ? 1 : 0}:${this.options.colorPointsByCuboid ? 1 : 0}:${orthoFixed ? 1 : 0}::${hasDrawnObjects ? 1 : 0}::v${viewEntries.length}:p${totalPointsObjects}`;

    if (!this.dirty && currentSignature === this.lastExecutionSignature) {
      return false;
    }

    this.lastExecutionSignature = currentSignature;
    this.dirty = false;

    const cuboidViewKeys = ['perspective', 'top', 'side', 'front'] as const;

    for (const [key, rv] of viewEntries) {
      if (!rv) continue;

      const isPerspective = key === 'perspective';
      const pointsList = findPointsObjectsInScene(rv.scene);
      for (const ptsObj of pointsList) {
        this.bindInstanceBeforeRenderHook(ptsObj);
        this.applyScatteringToMaterial(ptsObj, isPerspective);
      }
    }

    // Ensure translucent cuboid meshes never write to depth buffer and depth-cull internal points
    for (const entry of Object.values(drawnObjects)) {
      for (const viewKey of cuboidViewKeys) {
        const meshMat = entry?.cuboid?.[viewKey]?.material;
        if (meshMat && typeof meshMat === 'object') {
          meshMat.depthWrite = false;
        }
      }
    }

    // Apply per-cuboid point coloring across all views' point clouds (sharing or cloning geometry)
    const processedGeometries = new WeakSet<object>();
    const compiledBoxes = this.options.colorPointsByCuboid
      ? compileOrientedCuboids(drawnObjects, this.options.whiteBackground)
      : [];
    this.lastCompiledBoxes = compiledBoxes;

    for (const [, rv] of viewEntries) {
      const pointsList = findPointsObjectsInScene(rv?.scene);
      for (const ptsObj of pointsList) {
        if (ptsObj.geometry && !processedGeometries.has(ptsObj.geometry)) {
          processedGeometries.add(ptsObj.geometry);
          this.geometrySignatureMap.set(ptsObj.geometry, currentSignature);
          this.applyPointCloudBoxColors(ptsObj, compiledBoxes);
        }
      }
    }

    return true;
  }

  private applyScatteringToMaterial(ptsObj: ThreeObject3DLike, isPerspective: boolean): void {
    let mat = ptsObj.material;
    if (!mat) {
      return;
    }

    if (isPerspective) {
      this.primaryPerspectiveMaterials.add(mat);
    } else if (this.primaryPerspectiveMaterials.has(mat) && typeof mat.clone === 'function') {
      // If a zoomed Top/Side/Front view cloned the perspective Points object without cloning its material,
      // give the orthographic/zoom Points object its own isolated PointsMaterial so it stays at 2.5px.
      mat = mat.clone();
      ptsObj.material = mat;
    }

    const useFixedOrtho25px = this.options.fixedOrthoPointSize ?? true;
    const targetSize = isPerspective ? 0.05 : useFixedOrtho25px ? 2.5 : 0.5;
    const targetAttenuation = isPerspective ? true : !useFixedOrtho25px;

    const needsShaderUpdate =
      mat.sizeAttenuation !== targetAttenuation ||
      mat.transparent !== false ||
      mat.needsUpdate === undefined;

    mat.size = targetSize;
    mat.sizeAttenuation = targetAttenuation;

    // CRITICAL: Keep PointsMaterial opaque (`transparent = false`) at all times!
    // In Three.js, setting `transparent = true` on Points moves the point cloud into the
    // transparent render pass AFTER CuboidModel meshes (`depthWrite: true`), causing active
    // cuboids in Perspective/Top/Side/Front to depth-cull and erase all points inside the box!
    mat.transparent = false;
    mat.opacity = 1.0;
    if (needsShaderUpdate) {
      mat.needsUpdate = true;
    }
  }

  private applyPointCloudBoxColors(
    ptsObj: ThreeObject3DLike,
    boxes: readonly OrientedBoxBounds[]
  ): void {
    const posAttr = ptsObj.geometry?.attributes?.position;
    const colorAttr = ptsObj.geometry?.attributes?.color;
    if (!posAttr || !colorAttr) {
      return;
    }

    const posArray = posAttr.array;
    const colorArray = colorAttr.array;
    const len = Math.min(posArray.length, colorArray.length);
    if (len === 0) {
      return;
    }

    // Snapshot original point cloud colors once per geometry
    let originalColors = this.baseColorsCache.get(colorAttr);
    if (!originalColors || originalColors.length !== len) {
      originalColors = new Float32Array(len);
      for (let i = 0; i < len; i += 1) {
        originalColors[i] = colorArray[i] ?? 1;
      }
      this.baseColorsCache.set(colorAttr, originalColors);
    }

    // WebGL Float32BufferAttribute (Float32Array) always expects normalized 0.0..1.0 floats;
    // only Uint8Array/Uint8ClampedArray attributes use 0..255.
    const colorScale =
      colorArray instanceof Uint8Array || colorArray instanceof Uint8ClampedArray ? 255 : 1;

    // Check if LiDAR intensity attribute is available for scattering mode
    const intensityArray = ptsObj.geometry?.attributes?.intensity?.array;
    let minIntensity = Infinity;
    let maxIntensity = -Infinity;
    if (this.options.enableScattering && intensityArray && intensityArray.length > 0) {
      const sampleStep = Math.max(1, Math.floor(intensityArray.length / 500));
      for (let idx = 0; idx < intensityArray.length; idx += sampleStep) {
        const val = intensityArray[idx] ?? 0;
        if (Number.isFinite(val)) {
          if (val < minIntensity) minIntensity = val;
          if (val > maxIntensity) maxIntensity = val;
        }
      }
    }
    const hasIntensitySpread =
      Number.isFinite(minIntensity) &&
      Number.isFinite(maxIntensity) &&
      maxIntensity - minIntensity > 1e-5;

    const overlapRgb = this.options.whiteBackground ? OVERLAP_RGB_WHITE_BG : OVERLAP_RGB_BLACK_BG;
    const boxCount = boxes.length;

    for (let i = 0; i < len; i += 3) {
      const px = posArray[i] ?? 0;
      const py = posArray[i + 1] ?? 0;
      const pz = posArray[i + 2] ?? 0;

      let matchedBox: OrientedBoxBounds | null = null;
      let isOverlapping = false;

      if (this.options.colorPointsByCuboid && boxCount > 0) {
        for (let b = 0; b < boxCount; b += 1) {
          const box = boxes[b]!;
          // 1. Fast AABB check
          if (
            px < box.minX ||
            px > box.maxX ||
            py < box.minY ||
            py > box.maxY ||
            pz < box.minZ ||
            pz > box.maxZ
          ) {
            continue;
          }

          // 2. Exact Oriented Bounding Box (OBB) local coordinate check
          const dx = px - box.cx;
          const dy = py - box.cy;
          const dz = pz - box.cz;

          const lx = box.r00 * dx + box.r01 * dy + box.r02 * dz;
          if (lx < -box.hx || lx > box.hx) continue;

          const ly = box.r10 * dx + box.r11 * dy + box.r12 * dz;
          if (ly < -box.hy || ly > box.hy) continue;

          const lz = box.r20 * dx + box.r21 * dy + box.r22 * dz;
          if (lz < -box.hz || lz > box.hz) continue;

          if (matchedBox === null) {
            matchedBox = box;
          } else {
            // Point is wrapped by 2+ overlapping boxes -> assign 3rd overlap color
            isOverlapping = true;
            break;
          }
        }
      }

      if (isOverlapping) {
        colorArray[i] = overlapRgb[0] * colorScale;
        colorArray[i + 1] = overlapRgb[1] * colorScale;
        colorArray[i + 2] = overlapRgb[2] * colorScale;
      } else if (matchedBox) {
        colorArray[i] = matchedBox.r * colorScale;
        colorArray[i + 1] = matchedBox.g * colorScale;
        colorArray[i + 2] = matchedBox.b * colorScale;
      } else if (!this.options.enableScattering) {
        // Scattering OFF: 100% pure black on white background, or 100% pure white on black background
        const solidBase = this.options.whiteBackground ? 0 : 1 * colorScale;
        colorArray[i] = solidBase;
        colorArray[i + 1] = solidBase;
        colorArray[i + 2] = solidBase;
      } else {
        // Scattering ON: compute LiDAR scattering intensity/range shade adapted to background
        const ptIdx = Math.floor(i / 3);
        let scatterFactor = 0.5;
        if (hasIntensitySpread && intensityArray) {
          const rawI = intensityArray[ptIdx] ?? minIntensity;
          scatterFactor = Math.max(
            0,
            Math.min(1, (rawI - minIntensity) / (maxIntensity - minIntensity))
          );
        } else {
          const dist = Math.sqrt(px * px + py * py + pz * pz);
          scatterFactor = Math.max(0, Math.min(1, dist / 60));
        }

        const shade = this.options.whiteBackground
          ? (0.12 + 0.52 * scatterFactor) * colorScale
          : (0.35 + 0.65 * (1 - 0.55 * scatterFactor)) * colorScale;

        colorArray[i] = shade;
        colorArray[i + 1] = shade;
        colorArray[i + 2] = shade;
      }
    }

    colorAttr.needsUpdate = true;
  }
}

const WORKSPACE_SETTINGS_INJECTED_ID = 'cvat-3d-enhancer-workspace-settings-section';
const EARLY_VIEWPORT_BG_STYLE_ID = 'cvat-3d-enhancer-early-viewport-bg-style';

/**
 * Synchronously applies early CSS background rules and updates any mounted 3D `<canvas>.scene.background`
 * in the DOM so the 3D viewport is white from frame 0 with zero black flash.
 */
export function syncEarlyViewportBackgroundDom(doc: Document, whiteBackground: boolean): void {
  const root = doc.head || doc.documentElement;
  if (root) {
    let styleEl = doc.getElementById(EARLY_VIEWPORT_BG_STYLE_ID) as HTMLStyleElement | null;
    if (whiteBackground) {
      if (!styleEl) {
        styleEl = doc.createElement('style');
        styleEl.id = EARLY_VIEWPORT_BG_STYLE_ID;
        root.appendChild(styleEl);
      }
      const css = `
        .cvat-canvas3d-perspective,
        .cvat-canvas3d-perspective .cvat-canvas-container,
        .cvat-canvas3d-orthographic-view .cvat-canvas3d-fullsize,
        .cvat-canvas3d-perspective canvas,
        .cvat-canvas3d-orthographic-view canvas {
          background-color: #ffffff !important;
        }
      `;
      if (styleEl.textContent !== css) {
        styleEl.textContent = css;
      }
    } else if (styleEl) {
      styleEl.remove();
    }
  }

  const targetHex = whiteBackground ? 0xffffff : 0x000000;
  const targetCss = whiteBackground ? '#ffffff' : '#000000';
  const canvases = doc.querySelectorAll<HTMLCanvasElement & { scene?: ThreeSceneLike }>('canvas');
  for (const canvas of canvases) {
    const isCvatViewportCanvas =
      Boolean(canvas.scene) ||
      Boolean(
        canvas.closest?.('.cvat-canvas3d-perspective, .cvat-canvas3d-orthographic-view')
      );
    if (!isCvatViewportCanvas) {
      continue;
    }
    if (canvas.scene?.background && typeof canvas.scene.background.set === 'function') {
      canvas.scene.background.set(targetHex);
    }
    canvas.style.backgroundColor = targetCss;
  }
}

/**
 * Injects the 3 tickable 3D render options directly into CVAT's native Settings -> Workspace tab
 * (`.cvat-workspace-settings`) using CVAT's exact Ant Design Row/Col/Checkbox/Text DOM structure
 * so the options blend seamlessly with native CVAT settings.
 */
export function injectCvatWorkspaceSettingsControls(
  doc: Document,
  getOptions: () => Cvat3dWorkspaceRenderOptions,
  onChange: (next: Cvat3dWorkspaceRenderOptions) => void
): boolean {
  const container = doc.querySelector('.cvat-workspace-settings');
  if (!container) {
    return false;
  }

  const syncCheckboxVisualState = (
    input: HTMLInputElement,
    checked: boolean
  ): void => {
    input.checked = checked;
    const checkboxSpan = input.closest('.ant-checkbox');
    const wrapperLabel = input.closest('.ant-checkbox-wrapper');
    if (checkboxSpan) {
      checkboxSpan.classList.toggle('ant-checkbox-checked', checked);
    }
    if (wrapperLabel) {
      wrapperLabel.classList.toggle('ant-checkbox-wrapper-checked', checked);
    }
  };

  const existing = doc.getElementById(WORKSPACE_SETTINGS_INJECTED_ID);
  if (existing) {
    const opts = getOptions();
    const bgInput = existing.querySelector<HTMLInputElement>(
      'input[data-enhancer-opt="whiteBackground"]'
    );
    const scInput = existing.querySelector<HTMLInputElement>(
      'input[data-enhancer-opt="enableScattering"]'
    );
    const boxInput = existing.querySelector<HTMLInputElement>(
      'input[data-enhancer-opt="colorPointsByCuboid"]'
    );
    const orthoInput = existing.querySelector<HTMLInputElement>(
      'input[data-enhancer-opt="fixedOrthoPointSize"]'
    );
    if (bgInput) syncCheckboxVisualState(bgInput, opts.whiteBackground);
    if (scInput) syncCheckboxVisualState(scInput, opts.enableScattering);
    if (boxInput) syncCheckboxVisualState(boxInput, opts.colorPointsByCuboid);
    if (orthoInput) syncCheckboxVisualState(orthoInput, opts.fixedOrthoPointSize ?? true);
    return true;
  }

  const wrapper = doc.createElement('div');
  wrapper.id = WORKSPACE_SETTINGS_INJECTED_ID;

  const items: {
    readonly key: keyof Cvat3dWorkspaceRenderOptions;
    readonly rowClass: string;
    readonly title: string;
    readonly description: string;
  }[] = [
    {
      key: 'whiteBackground',
      rowClass: 'cvat-workspace-settings-3d-white-background',
      title: 'White 3D canvas background',
      description: 'Use a white background in 3D viewports and adjust unboxed point contrast',
    },
    {
      key: 'enableScattering',
      rowClass: 'cvat-workspace-settings-3d-point-scattering',
      title: 'Reduce 3D point cloud scattering',
      description: 'Apply attenuated point size and translucency for denser point cloud inspection',
    },
    {
      key: 'colorPointsByCuboid',
      rowClass: 'cvat-workspace-settings-3d-color-points-by-cuboid',
      title: 'Color 3D points by bounding box',
      description: 'Highlight points inside each 3D cuboid using the cuboid color',
    },
    {
      key: 'fixedOrthoPointSize',
      rowClass: 'cvat-workspace-settings-3d-ortho-point-size',
      title: 'Fixed 2.5px point size in Top/Side/Front views',
      description: 'Lock point size to 2.5px in orthographic views (uncheck to follow CVAT default)',
    },
  ];

  const initialOpts = getOptions();

  for (const item of items) {
    const isChecked =
      item.key === 'fixedOrthoPointSize'
        ? (initialOpts.fixedOrthoPointSize ?? true)
        : Boolean(initialOpts[item.key]);

    const row = doc.createElement('div');
    row.className = `ant-row ${item.rowClass} cvat-player-setting`;

    const checkboxCol = doc.createElement('div');
    checkboxCol.className = 'ant-col ant-col-24';

    const label = doc.createElement('label');
    label.className = `ant-checkbox-wrapper cvat-text-color${
      isChecked ? ' ant-checkbox-wrapper-checked' : ''
    }`;

    const checkboxSpan = doc.createElement('span');
    checkboxSpan.className = `ant-checkbox${isChecked ? ' ant-checkbox-checked' : ''}`;

    const checkboxInput = doc.createElement('input');
    checkboxInput.type = 'checkbox';
    checkboxInput.className = 'ant-checkbox-input';
    checkboxInput.dataset.enhancerOpt = item.key;
    checkboxInput.checked = isChecked;

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
    descCol.className = 'ant-col ant-col-24';

    const descText = doc.createElement('span');
    descText.className = 'ant-typography ant-typography-secondary';
    descText.textContent = item.description;
    descCol.appendChild(descText);

    checkboxInput.addEventListener('change', () => {
      syncCheckboxVisualState(checkboxInput, checkboxInput.checked);
      const current = getOptions();
      const updated: Cvat3dWorkspaceRenderOptions = {
        ...current,
        [item.key]: checkboxInput.checked,
      };
      onChange(updated);
    });

    row.appendChild(checkboxCol);
    row.appendChild(descCol);
    wrapper.appendChild(row);
  }

  container.appendChild(wrapper);
  return true;
}
