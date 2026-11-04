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
}

export const DEFAULT_CVAT_3D_RENDER_OPTIONS: Cvat3dWorkspaceRenderOptions = Object.freeze({
  whiteBackground: false,
  enableScattering: false,
  colorPointsByCuboid: false,
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
    };
  };
  material?: ThreePointsMaterialLike;
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
  cuboid: {
    perspective?: {
      material?: {
        color?: ThreeColorLike;
      };
    };
  };
}

export interface CvatInternalViewLike {
  views?: {
    perspective?: CvatRenderViewLike;
    top?: CvatRenderViewLike;
    side?: CvatRenderViewLike;
    front?: CvatRenderViewLike;
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

interface OrientedBoxBounds {
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
 * Precomputes inverse Euler XYZ rotation matrix and AABB envelope for each 3D cuboid
 * so point-in-cuboid testing runs in O(1) arithmetic operations per point with zero heap allocations.
 */
export function compileOrientedCuboids(
  drawnObjects: Record<number, CvatDrawnObjectEntry>,
  colorBy = 'Label'
): OrientedBoxBounds[] {
  const result: OrientedBoxBounds[] = [];

  for (const entry of Object.values(drawnObjects)) {
    const { data, cuboid } = entry;
    if (!data || data.hidden || data.outside || !Array.isArray(data.points) || data.points.length < 9) {
      continue;
    }

    const cx = Number(data.points[0]);
    const cy = Number(data.points[1]);
    const cz = Number(data.points[2]);
    const rx = Number(data.points[3]);
    const ry = Number(data.points[4]);
    const rz = Number(data.points[5]);
    const sx = Math.abs(Number(data.points[6]));
    const sy = Math.abs(Number(data.points[7]));
    const sz = Math.abs(Number(data.points[8]));

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

    let r = 0.22;
    let g = 0.74;
    let b = 0.97;

    const meshColor = cuboid?.perspective?.material?.color;
    if (
      meshColor &&
      typeof meshColor.r === 'number' &&
      typeof meshColor.g === 'number' &&
      typeof meshColor.b === 'number'
    ) {
      r = meshColor.r;
      g = meshColor.g;
      b = meshColor.b;
    } else {
      const hex =
        colorBy === 'Label'
          ? (data.labelColor ?? data.color ?? '#38bdf8')
          : colorBy === 'Group'
            ? (data.groupColor ?? data.color ?? '#38bdf8')
            : (data.color ?? data.labelColor ?? '#38bdf8');
      [r, g, b] = parseHexColorToNormalizedRgb(hex);
    }

    // Transpose of R (R^T) maps world delta (p - c) into cuboid local frame
    result.push({
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
  private readonly appliedViewBackground = new WeakMap<object, boolean>();
  private lastExecutionSignature = '';
  private dirty = true;

  public constructor(initialOptions: Cvat3dWorkspaceRenderOptions = DEFAULT_CVAT_3D_RENDER_OPTIONS) {
    this.options = { ...initialOptions };
  }

  public getOptions(): Cvat3dWorkspaceRenderOptions {
    return { ...this.options };
  }

  public setOptions(
    next: Cvat3dWorkspaceRenderOptions,
    canvas3d?: CvatInternalCanvas3dLike | null
  ): void {
    const changed =
      next.whiteBackground !== this.options.whiteBackground ||
      next.enableScattering !== this.options.enableScattering ||
      next.colorPointsByCuboid !== this.options.colorPointsByCuboid;

    this.options = { ...next };
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
  }

  /**
   * Immediately applies the target background color (`0xffffff` or `0x000000`) to all 4 Three.js
   * scenes and WebGL renderers, even BEFORE the first frame's PCD point cloud finishes loading,
   * eliminating the initial black-frame flash on frame 0.
   */
  public applySceneBackgrounds(view: CvatInternalViewLike): void {
    if (!view.views) {
      return;
    }
    if (!this.dirty && this.appliedViewBackground.get(view) === this.options.whiteBackground) {
      return;
    }

    const viewKeys = ['perspective', 'top', 'side', 'front'] as const;
    const targetBgHex = this.options.whiteBackground ? 0xffffff : 0x000000;
    const targetBgCss = this.options.whiteBackground ? '#ffffff' : '#000000';

    for (const key of viewKeys) {
      const rv = view.views[key];
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
   * Hooks a `Canvas3d` instance's internal `view` (`Canvas3dViewImpl`) so that:
   * - `onSceneImageLoaded`: marks dirty when a new frame's PCD point cloud finishes loading.
   * - `notify`: marks dirty when `OBJECTS_UPDATED` or `CONFIG_UPDATED` fires.
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
      return true;
    }
    this.hookedViews.add(view);
    this.dirty = true;

    if (typeof view.onSceneImageLoaded === 'function') {
      const origOnSceneLoaded = view.onSceneImageLoaded.bind(view);
      view.onSceneImageLoaded = (points: ThreeObject3DLike): void => {
        origOnSceneLoaded(points);
        this.dirty = true;
        this.applyOnceIfNeeded(view, canvas3d?.model);
      };
    }

    if (typeof view.notify === 'function') {
      const origNotify = view.notify.bind(view);
      view.notify = (model: unknown, reason: string): void => {
        if (reason === 'image_changed') {
          this.dirty = true;
          this.appliedViewBackground.delete(view);
          this.applySceneBackgrounds(view);
        }
        origNotify(model, reason);
        if (
          reason === 'image_changed' ||
          reason === 'objects_updated' ||
          reason === 'config_updated'
        ) {
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
    const perspectivePoints = findPointsObjectsInScene(perspectiveScene);
    if (perspectivePoints.length === 0) {
      // Scene point cloud not yet populated for this frame; keep dirty=true so point coloring runs on PCD load
      return false;
    }

    const drawnObjects = view.drawnObjects ?? {};
    const objectSignature = Object.values(drawnObjects)
      .map(
        (o) =>
          `${o.data?.clientID}:${o.data?.color}:${o.data?.labelColor}:${(o.data?.points ?? []).join(',')}:${String(o.data?.hidden)}:${String(o.data?.outside)}`
      )
      .join('|');

    const frameId = model?.data?.imageID ?? 'unknown';
    const colorBy = model?.data?.configuration?.colorBy ?? 'Label';
    const currentSignature = `${String(frameId)}::${this.options.whiteBackground ? 1 : 0}:${this.options.enableScattering ? 1 : 0}:${this.options.colorPointsByCuboid ? 1 : 0}::${colorBy}::${objectSignature}`;

    if (!this.dirty && currentSignature === this.lastExecutionSignature) {
      return false;
    }

    this.lastExecutionSignature = currentSignature;
    this.dirty = false;

    const viewKeys = ['perspective', 'top', 'side', 'front'] as const;

    for (const key of viewKeys) {
      const rv = view.views[key];
      if (!rv) continue;

      const pointsList = findPointsObjectsInScene(rv.scene);
      for (const ptsObj of pointsList) {
        this.applyScatteringToMaterial(ptsObj, key === 'perspective');
      }
    }

    // Apply per-cuboid point coloring across all views' point clouds (sharing or cloning geometry)
    const processedGeometries = new WeakSet<object>();
    const compiledBoxes = this.options.colorPointsByCuboid
      ? compileOrientedCuboids(drawnObjects, colorBy)
      : [];

    for (const key of viewKeys) {
      const rv = view.views[key];
      const pointsList = findPointsObjectsInScene(rv?.scene);
      for (const ptsObj of pointsList) {
        if (ptsObj.geometry && !processedGeometries.has(ptsObj.geometry)) {
          processedGeometries.add(ptsObj.geometry);
          this.applyPointCloudBoxColors(ptsObj, compiledBoxes);
        }
      }
    }

    return true;
  }

  private applyScatteringToMaterial(ptsObj: ThreeObject3DLike, isPerspective: boolean): void {
    const mat = ptsObj.material;
    if (!mat) {
      return;
    }

    if (this.options.enableScattering) {
      // Reduced scattering / glare: tighter attenuated point size + subtle translucency
      mat.size = isPerspective ? 0.025 : 0.28;
      mat.sizeAttenuation = true;
      mat.transparent = true;
      mat.opacity = 0.78;
    } else {
      // Native CVAT v2.81.0 defaults: 0.05 for perspective, 0.5 for orthographic
      mat.size = isPerspective ? 0.05 : 0.5;
      mat.sizeAttenuation = true;
      mat.transparent = false;
      mat.opacity = 1.0;
    }
    mat.needsUpdate = true;
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

    // Check whether CVAT stored 0..255 or 0..1 floats in the color buffer attribute
    let colorScale = 1;
    for (let i = 0; i < Math.min(len, 30); i += 1) {
      if ((originalColors[i] ?? 0) > 1.01) {
        colorScale = 255;
        break;
      }
    }

    const defaultPointColorWhenWhiteBg = 0.12 * colorScale;

    if (!this.options.colorPointsByCuboid && !this.options.whiteBackground) {
      // Fast restore from cached Float32Array
      for (let i = 0; i < len; i += 1) {
        colorArray[i] = originalColors[i] ?? colorScale;
      }
      colorAttr.needsUpdate = true;
      return;
    }

    const boxCount = boxes.length;

    for (let i = 0; i < len; i += 3) {
      const px = posArray[i] ?? 0;
      const py = posArray[i + 1] ?? 0;
      const pz = posArray[i + 2] ?? 0;

      let matchedBox: OrientedBoxBounds | null = null;

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

          matchedBox = box;
          break;
        }
      }

      if (matchedBox) {
        colorArray[i] = matchedBox.r * colorScale;
        colorArray[i + 1] = matchedBox.g * colorScale;
        colorArray[i + 2] = matchedBox.b * colorScale;
      } else if (this.options.whiteBackground) {
        // On white background, pure white unboxed points become dark charcoal so they remain visible
        const origR = originalColors[i] ?? colorScale;
        const origG = originalColors[i + 1] ?? colorScale;
        const origB = originalColors[i + 2] ?? colorScale;
        const threshold = 0.9 * colorScale;
        if (origR >= threshold && origG >= threshold && origB >= threshold) {
          colorArray[i] = defaultPointColorWhenWhiteBg;
          colorArray[i + 1] = defaultPointColorWhenWhiteBg;
          colorArray[i + 2] = defaultPointColorWhenWhiteBg;
        } else {
          colorArray[i] = origR;
          colorArray[i + 1] = origG;
          colorArray[i + 2] = origB;
        }
      } else {
        colorArray[i] = originalColors[i] ?? colorScale;
        colorArray[i + 1] = originalColors[i + 1] ?? colorScale;
        colorArray[i + 2] = originalColors[i + 2] ?? colorScale;
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
  const canvases = doc.querySelectorAll<HTMLCanvasElement & { scene?: ThreeSceneLike }>(
    '.cvat-canvas3d-perspective canvas, .cvat-canvas3d-orthographic-view canvas'
  );
  for (const canvas of canvases) {
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
    if (bgInput) syncCheckboxVisualState(bgInput, opts.whiteBackground);
    if (scInput) syncCheckboxVisualState(scInput, opts.enableScattering);
    if (boxInput) syncCheckboxVisualState(boxInput, opts.colorPointsByCuboid);
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
  ];

  const initialOpts = getOptions();

  for (const item of items) {
    const isChecked = initialOpts[item.key];

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
