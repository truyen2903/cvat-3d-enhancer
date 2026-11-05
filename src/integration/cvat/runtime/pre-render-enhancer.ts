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
  readonly hideGroundPoints?: boolean;
  readonly fixedOrthoPointSize?: boolean;
  readonly followActiveObject?: boolean;
  readonly enableActiveObjectWarnings?: boolean;
}

export const DEFAULT_CVAT_3D_RENDER_OPTIONS: Cvat3dWorkspaceRenderOptions = Object.freeze({
  whiteBackground: false,
  enableScattering: false,
  colorPointsByCuboid: false,
  hideGroundPoints: false,
  fixedOrthoPointSize: true,
  followActiveObject: true,
  enableActiveObjectWarnings: true,
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

export interface CvatCuboidViewMeshLike {
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
  lock?: boolean;
  hidden?: boolean;
  outside?: boolean;
  keyframe?: boolean;
  updateFlags?: {
    reset?: () => void;
    points?: boolean;
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
    whiteBackground: Boolean(obj.whiteBackground),
    enableScattering: Boolean(obj.enableScattering),
    colorPointsByCuboid: Boolean(obj.colorPointsByCuboid),
    hideGroundPoints: Boolean(obj.hideGroundPoints),
    fixedOrthoPointSize:
      typeof obj.fixedOrthoPointSize === 'boolean' ? obj.fixedOrthoPointSize : true,
    followActiveObject:
      typeof obj.followActiveObject === 'boolean' ? obj.followActiveObject : true,
    enableActiveObjectWarnings:
      typeof obj.enableActiveObjectWarnings === 'boolean' ? obj.enableActiveObjectWarnings : true,
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
        clientSettingsOptions.whiteBackground !== standaloneOptions.whiteBackground ||
        clientSettingsOptions.enableScattering !== standaloneOptions.enableScattering ||
        clientSettingsOptions.colorPointsByCuboid !== standaloneOptions.colorPointsByCuboid ||
        Boolean(clientSettingsOptions.hideGroundPoints) !==
          Boolean(standaloneOptions.hideGroundPoints) ||
        (clientSettingsOptions.fixedOrthoPointSize ?? true) !==
          (standaloneOptions.fixedOrthoPointSize ?? true) ||
        (clientSettingsOptions.followActiveObject ?? true) !==
          (standaloneOptions.followActiveObject ?? true) ||
        (clientSettingsOptions.enableActiveObjectWarnings ?? true) !==
          (standaloneOptions.enableActiveObjectWarnings ?? true))
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

  const normalized: Cvat3dWorkspaceRenderOptions = {
    whiteBackground: Boolean(options.whiteBackground),
    enableScattering: Boolean(options.enableScattering),
    colorPointsByCuboid: Boolean(options.colorPointsByCuboid),
    hideGroundPoints: Boolean(options.hideGroundPoints),
    fixedOrthoPointSize: options.fixedOrthoPointSize ?? true,
    followActiveObject: options.followActiveObject ?? true,
    enableActiveObjectWarnings: options.enableActiveObjectWarnings ?? true,
  };

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
 * Curated per-vehicle / per-cuboid palettes engineered for maximum WCAG luminance contrast against
 * White (`#ffffff`) vs Black (`#000000`) backgrounds, AND high chromatic/hue separation against
 * the cuboid's own Label color.
 * Red/Crimson is intentionally excluded from single-box palettes and reserved exclusively as the 3rd color
 * for overlapping regions wrapped by 2+ bounding boxes.
 */
export const WHITE_BG_BOX_PALETTE: readonly [number, number, number][] = [
  [0.0, 0.25, 0.85], // #0040d9 Deep Electric Cobalt
  [0.0, 0.5, 0.22], // #008038 Rich Emerald Green
  [0.52, 0.0, 0.88], // #8500e0 Vivid Royal Violet
  [0.82, 0.32, 0.0], // #d15200 Dark Burnt Orange
  [0.0, 0.48, 0.62], // #007a9e Deep Ocean Teal
  [0.78, 0.0, 0.58], // #c70094 Vivid Magenta Plum
  [0.18, 0.15, 0.82], // #2e26d1 Ultramarine Indigo
  [0.24, 0.48, 0.0], // #3d7a00 Deep Forest Olive
  [0.62, 0.22, 0.0], // #9e3800 Rich Saddle Bronze
  [0.0, 0.36, 0.75], // #005cbf Deep Cerulean
  [0.42, 0.0, 0.68], // #6b00ad Dark Amethyst
  [0.0, 0.46, 0.44], // #007570 Dark Pine Cyan
];

export const BLACK_BG_BOX_PALETTE: readonly [number, number, number][] = [
  [0.15, 0.85, 1.0], // #26d9ff Laser Sky Cyan
  [0.25, 1.0, 0.45], // #40ff73 Neon Spring Green
  [0.78, 0.58, 1.0], // #c794ff Luminous Lavender
  [1.0, 0.82, 0.1], // #ffd11a Cyber Gold Yellow
  [0.1, 0.96, 0.82], // #1affd1 Electric Aqua Mint
  [0.68, 1.0, 0.18], // #adff2e High-Vis Chartreuse Lime
  [0.38, 0.72, 1.0], // #61b8ff Brilliant Azure
  [1.0, 0.5, 0.92], // #ff80eb Neon Orchid Pink
  [1.0, 0.62, 0.15], // #ff9e26 Vivid Tangerine
  [0.95, 1.0, 0.25], // #f2ff40 Neon Lemon
  [0.3, 0.95, 0.65], // #4df2a6 Luminous Seafoam
  [0.6, 0.75, 1.0], // #99bfff Bright Periwinkle
];

/**
 * Dedicated 3rd color reserved exclusively for points that fall inside 2 or more overlapping cuboids.
 */
export const OVERLAP_RGB_WHITE_BG: readonly [number, number, number] = [0.86, 0.04, 0.2]; // #db0a33 High-Contrast Crimson
export const OVERLAP_RGB_BLACK_BG: readonly [number, number, number] = [1.0, 0.2, 0.35]; // #ff3359 Neon Crimson-Red

function srgbChannelToLinear(c: number): number {
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/**
 * Relative luminance Y in [0, 1] per WCAG 2.1 specification.
 */
export function computeRelativeLuminance(r: number, g: number, b: number): number {
  return (
    0.2126 * srgbChannelToLinear(r) +
    0.7152 * srgbChannelToLinear(g) +
    0.0722 * srgbChannelToLinear(b)
  );
}

/**
 * WCAG contrast ratio in [1, 21] between two normalized RGB colors.
 */
export function computeWcagContrastRatio(
  rgb1: readonly [number, number, number],
  rgb2: readonly [number, number, number]
): number {
  const l1 = computeRelativeLuminance(rgb1[0], rgb1[1], rgb1[2]);
  const l2 = computeRelativeLuminance(rgb2[0], rgb2[1], rgb2[2]);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * Perceptual Redmean RGB distance in [0, ~1.73] combined with hue angle separation
 * so the internal point cloud color pops distinctly against the cuboid's wireframe/face labelColor.
 */
export function computePerceptualColorDistance(
  rgb1: readonly [number, number, number],
  rgb2: readonly [number, number, number]
): number {
  const rMean = (rgb1[0] + rgb2[0]) * 0.5;
  const dr = rgb1[0] - rgb2[0];
  const dg = rgb1[1] - rgb2[1];
  const db = rgb1[2] - rgb2[2];
  return Math.sqrt((2 + rMean) * dr * dr + 4 * dg * dg + (3 - rMean) * db * db) / 3;
}

/**
 * Converts normalized RGB [0..1] to Hue in [0, 360) and Saturation in [0, 1].
 */
export function rgbToHueSaturation(rgb: readonly [number, number, number]): {
  hue: number;
  saturation: number;
} {
  const [r, g, b] = rgb;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  if (delta < 1e-5) {
    return { hue: 0, saturation: 0 };
  }
  const l = (max + min) * 0.5;
  const saturation = l > 0.5 ? delta / (2 - max - min) : delta / (max + min);

  let hue = 0;
  if (max === r) {
    hue = ((g - b) / delta + (g < b ? 6 : 0)) * 60;
  } else if (max === g) {
    hue = ((b - r) / delta + 2) * 60;
  } else {
    hue = ((r - g) / delta + 4) * 60;
  }
  return { hue: hue % 360, saturation };
}

/**
 * Circular hue angle separation in [0, 180] degrees.
 * Ensures internal point color is on a completely different color family (complementary/triadic)
 * from the bounding box color so points never blend into the box's translucent tint or edges.
 */
export function computeHueSeparationDegrees(
  rgb1: readonly [number, number, number],
  rgb2: readonly [number, number, number]
): number {
  const hs1 = rgbToHueSaturation(rgb1);
  const hs2 = rgbToHueSaturation(rgb2);
  if (hs1.saturation < 0.08 || hs2.saturation < 0.08) {
    return 180;
  }
  const diff = Math.abs(hs1.hue - hs2.hue) % 360;
  return diff > 180 ? 360 - diff : diff;
}

/**
 * Extracts the native CVAT Label color of a 3D cuboid box (`data.labelColor` or `state.label.color`).
 * Also checks `cuboid.perspective.material.color` as fallback if labelColor is not directly populated.
 */
export function resolveRenderedCuboidColorHex(entry?: CvatDrawnObjectEntry): string | undefined {
  const stateLabelColor = (
    entry?.state as { label?: { color?: string }; color?: string } | undefined
  )?.label?.color;

  for (const labelCandidate of [entry?.data?.labelColor, stateLabelColor]) {
    if (typeof labelCandidate === 'string' && /^#?[0-9a-fA-F]{6}$/.test(labelCandidate.trim())) {
      const clean = labelCandidate.trim();
      return clean.startsWith('#') ? clean : `#${clean}`;
    }
  }

  const meshColor = entry?.cuboid?.perspective?.material?.color;
  if (
    meshColor &&
    typeof meshColor.r === 'number' &&
    typeof meshColor.g === 'number' &&
    typeof meshColor.b === 'number' &&
    Number.isFinite(meshColor.r) &&
    Number.isFinite(meshColor.g) &&
    Number.isFinite(meshColor.b)
  ) {
    return normalizedRgbToHex(meshColor.r, meshColor.g, meshColor.b);
  }

  const stateColor = (entry?.state as { color?: string } | undefined)?.color;
  for (const c of [entry?.data?.color, stateColor, entry?.data?.groupColor]) {
    if (typeof c === 'string' && /^#?[0-9a-fA-F]{6}$/.test(c.trim())) {
      const clean = c.trim();
      return clean.startsWith('#') ? clean : `#${clean}`;
    }
  }
  return undefined;
}

/**
 * Ensures the 3D cuboid box mesh (`perspective`, `top`, `side`, `front`) keeps its native CVAT
 * Label color (`data.labelColor` / `state.label.color`) WITHOUT calling `cuboid.setColor()`,
 * because `cuboid.setColor()` in CVAT overwrites `this.wireframe.material.color` (which would
 * destroy CVAT's white/configured `outlinedBorders`).
 */
export function ensureCuboidKeepsLabelColor(entry?: CvatDrawnObjectEntry): string | undefined {
  const stateLabelColor = (
    entry?.state as { label?: { color?: string } } | undefined
  )?.label?.color;
  const rawLabelColor = entry?.data?.labelColor ?? stateLabelColor;
  const labelColor =
    typeof rawLabelColor === 'string' && /^#?[0-9a-fA-F]{6}$/.test(rawLabelColor.trim())
      ? rawLabelColor.trim().startsWith('#')
        ? rawLabelColor.trim()
        : `#${rawLabelColor.trim()}`
      : undefined;

  if (labelColor && entry?.cuboid) {
    for (const viewKey of ['perspective', 'top', 'side', 'front'] as const) {
      const matColor = entry.cuboid[viewKey]?.material?.color;
      if (matColor && typeof matColor.set === 'function') {
        matColor.set(labelColor);
      }
    }
  }

  return labelColor;
}

/**
 * Persistent per-session / per-background cache mapping each cuboid's `clientID` (or `serverID`)
 * to its assigned internal point cloud RGB color (`[r, g, b]`), so that switching across frames
 * (Next/Prev frame) ALWAYS renders the exact same cached point color for the same box ID.
 */
const cuboidPointColorCacheWhiteBg = new Map<number, [number, number, number]>();
const cuboidPointColorCacheBlackBg = new Map<number, [number, number, number]>();

export function clearCuboidPointColorCache(): void {
  cuboidPointColorCacheWhiteBg.clear();
  cuboidPointColorCacheBlackBg.clear();
}

export function getDistinctCuboidColor(
  clientID: number,
  fallbackIndex: number,
  whiteBackground: boolean,
  labelColorHex?: string
): [number, number, number] {
  const hasStableId = Number.isFinite(clientID) && clientID >= 0;
  const stableId = hasStableId ? Math.floor(clientID) : -1;
  const cache = whiteBackground ? cuboidPointColorCacheWhiteBg : cuboidPointColorCacheBlackBg;

  if (hasStableId) {
    const cached = cache.get(stableId);
    if (cached) {
      return [cached[0], cached[1], cached[2]];
    }
  }

  const palette = whiteBackground ? WHITE_BG_BOX_PALETTE : BLACK_BG_BOX_PALETTE;
  const bgRgb: readonly [number, number, number] = whiteBackground ? [1, 1, 1] : [0, 0, 0];
  const idNum = hasStableId ? stableId : fallbackIndex;
  // Knuth multiplicative hash for pseudo-random per-cuboid color distribution
  const hashedIndex = Math.abs((idNum * 2654435761) >>> 0) % palette.length;

  const hasValidLabelColor =
    typeof labelColorHex === 'string' && /^#?[0-9a-fA-F]{6}$/.test(labelColorHex.trim());
  if (!hasValidLabelColor) {
    const entry = palette[hashedIndex]!;
    const chosen: [number, number, number] = [entry[0], entry[1], entry[2]];
    if (hasStableId) {
      cache.set(stableId, chosen);
    }
    return [chosen[0], chosen[1], chosen[2]];
  }

  const labelRgb = parseHexColorToNormalizedRgb(labelColorHex!);
  // CVAT renders the cuboid mesh with translucent fill blended over the background (`opacity ~ 0.35..0.5`),
  // so points inside the box must contrast strongly with BOTH the pure background AND the label-tinted box interior,
  // AND belong to a distinctly different hue family (>= 65 deg hue angle separation) from the box color!
  const blendedInteriorRgb: readonly [number, number, number] = [
    bgRgb[0] * 0.55 + labelRgb[0] * 0.45,
    bgRgb[1] * 0.55 + labelRgb[1] * 0.45,
    bgRgb[2] * 0.55 + labelRgb[2] * 0.45,
  ];

  const MIN_BOX_PERCEPTUAL_DIST = 0.5;
  const MIN_HUE_SEPARATION_DEG = 65;
  const MIN_BG_CONTRAST_RATIO = 4.2;

  let bestEntry = palette[hashedIndex]!;
  let bestScore = -Infinity;

  for (let offset = 0; offset < palette.length; offset += 1) {
    const candidate = palette[(hashedIndex + offset) % palette.length]!;
    const boxDist = computePerceptualColorDistance(candidate, labelRgb);
    const hueDiff = computeHueSeparationDegrees(candidate, labelRgb);
    const interiorDist = computePerceptualColorDistance(candidate, blendedInteriorRgb);
    const interiorContrast = computeWcagContrastRatio(candidate, blendedInteriorRgb);
    const bgContrast = computeWcagContrastRatio(candidate, bgRgb);

    // If the candidate has strong perceptual distance, distinct hue family (>= 65°),
    // and clear contrast against both background and the box's translucent interior, lock & cache it.
    if (
      boxDist >= MIN_BOX_PERCEPTUAL_DIST &&
      hueDiff >= MIN_HUE_SEPARATION_DEG &&
      bgContrast >= MIN_BG_CONTRAST_RATIO &&
      interiorDist >= 0.35
    ) {
      const chosen: [number, number, number] = [candidate[0], candidate[1], candidate[2]];
      if (hasStableId) {
        cache.set(stableId, chosen);
      }
      return [chosen[0], chosen[1], chosen[2]];
    }

    const score =
      boxDist * 4.5 +
      (hueDiff / 180) * 3.0 +
      interiorDist * 1.5 +
      Math.min(bgContrast, 10) * 0.1 +
      Math.min(interiorContrast, 10) * 0.1;
    if (score > bestScore) {
      bestScore = score;
      bestEntry = candidate;
    }
  }

  const chosen: [number, number, number] = [bestEntry[0], bestEntry[1], bestEntry[2]];
  if (hasStableId) {
    cache.set(stableId, chosen);
  }
  return [chosen[0], chosen[1], chosen[2]];
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
    // NEVER touch or mutate `entry.cuboid` colors/materials here!
    // Only READ the box's current color to compute a contrasting color for the 3D points inside it.
    const renderedBoxColorHex = resolveRenderedCuboidColorHex(entry);
    const [r, g, b] = getDistinctCuboidColor(
      clientID,
      boxIdx,
      whiteBackground,
      renderedBoxColorHex
    );
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

const ORTHO_RAYCAST_PLANE_NAMES = new Set(['topPlane', 'sidePlane', 'frontPlane']);

/**
 * CVAT's `onSceneImageLoaded` creates invisible raycast planes (`topPlane`, `sidePlane`, `frontPlane`)
 * using `new THREE.PlaneGeometry(offsetHeight, offsetWidth, offsetHeight, offsetWidth)`.
 * When an orthographic view (e.g. `Side` view at 866x712) is expanded and the user steps to the next frame,
 * CVAT passes `712` and `866` as `widthSegments` and `heightSegments`, generating 1,233,184 triangles!
 * While rotating a box (`renderRotateAction`) never raycasts against this plane, resizing (`renderResizeAction`)
 * and translating (`renderTranslateAction`) raycast against `${view}Plane` on every mousemove frame,
 * causing severe CPU lag (testing 1.23M triangles per frame).
 *
 * Replacing the subdivided geometry with a 1x1 segment plane (2 triangles) preserves the exact same
 * mathematical plane and `worldToLocal` transform while making resize/translate raycasts ~600,000x faster.
 */
export function optimizeOrthographicRaycastPlanes(
  scene?: ThreeSceneLike | null,
  optimizedPlanes?: WeakSet<object>
): number {
  if (!scene || !Array.isArray(scene.children)) {
    return 0;
  }
  let optimizedCount = 0;
  for (const child of scene.children) {
    if (!child || typeof child !== 'object' || !child.name) {
      continue;
    }
    if (!ORTHO_RAYCAST_PLANE_NAMES.has(child.name)) {
      continue;
    }
    if (optimizedPlanes?.has(child)) {
      continue;
    }
    optimizedPlanes?.add(child);

    const geom = child.geometry as
      | (NonNullable<ThreeObject3DLike['geometry']> & {
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
        })
      | undefined;
    if (!geom) {
      continue;
    }

    const widthSegments = Number(geom.parameters?.widthSegments ?? 1);
    const heightSegments = Number(geom.parameters?.heightSegments ?? 1);
    const indexCount = Number(geom.index?.count ?? geom.index?.array?.length ?? 0);
    const posCount = Number(
      geom.attributes?.position?.count ??
        (geom.attributes?.position?.array ? geom.attributes.position.array.length / 3 : 0)
    );

    if (widthSegments <= 1 && heightSegments <= 1 && indexCount <= 6 && posCount <= 4) {
      continue;
    }

    const width = Math.max(Number(geom.parameters?.width) || 1000, 2000);
    const height = Math.max(Number(geom.parameters?.height) || 1000, 2000);
    const GeomCtor = (geom as { constructor?: unknown }).constructor;

    if (typeof GeomCtor === 'function' && GeomCtor !== Object) {
      try {
        const replacement = new (GeomCtor as new (
          w: number,
          h: number,
          ws: number,
          hs: number
        ) => typeof geom)(width, height, 1, 1);
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

const originalGeometryPositionsMap = new WeakMap<object, Float32Array>();

/**
 * Returns the original un-compacted point cloud position buffer (`Float32Array | number[]`)
 * for a `BufferGeometry`, even when `hideGroundPoints` has compacted `attributes.position.array` in place.
 */
export function getOriginalGeometryPositions(
  geometry?: ThreeObject3DLike['geometry'] | null
): Float32Array | number[] | null {
  if (!geometry) {
    return null;
  }
  const posAttr = geometry.attributes?.position;
  if (!posAttr) {
    return null;
  }
  return (
    originalGeometryPositionsMap.get(posAttr) ??
    originalGeometryPositionsMap.get(geometry) ??
    posAttr.array ??
    null
  );
}

const GROUND_GRID_SIDE = 64;
const GROUND_CELL_SIZE = 3.0;
const GROUND_INV_CELL_SIZE = 1 / GROUND_CELL_SIZE;
const GROUND_HALF_SPAN = (GROUND_GRID_SIDE * GROUND_CELL_SIZE) * 0.5; // 96m
const sharedGroundCellMinZ = new Float32Array(GROUND_GRID_SIDE * GROUND_GRID_SIDE);
const sharedEgoHistogram = new Int32Array(40);

/**
 * Ultra-fast 2-pass local ground elevation estimator (`< 1.2ms` for 120,000 points).
 * Computes nominal `egoGroundZ` via a 40-bin histogram near the ego vehicle, then populates
 * `sharedGroundCellMinZ` (64x64 grid of 3m×3m cells over [-96m..+96m]) with slope-clamped
 * cell minimum Z values so sloped/uneven ground is stripped cleanly without cutting elevated objects.
 */
function populateGroundElevationGrid(
  srcPositions: Float32Array | number[],
  len: number
): { egoGroundZ: number; cellMinZ: Float32Array } {
  sharedEgoHistogram.fill(0);
  const histMinZ = -3.2;
  const histMaxZ = 0.8;
  const histInvStep = 40 / (histMaxZ - histMinZ); // 10 bins per meter (0.10m bin)

  // Sample up to ~15,000 points for the ego-ground histogram
  const totalPts = Math.floor(len / 3);
  const histStride = Math.max(1, Math.floor(totalPts / 15000)) * 3;
  let minFallbackZ = Infinity;
  let validNearSamples = 0;

  for (let i = 0; i < len; i += histStride) {
    const px = srcPositions[i] ?? 0;
    const py = srcPositions[i + 1] ?? 0;
    const pz = srcPositions[i + 2] ?? 0;
    if (px < -35 || px > 35 || py < -35 || py > 35) {
      continue;
    }
    if (pz >= histMinZ && pz < histMaxZ) {
      validNearSamples += 1;
      if (pz < minFallbackZ) {
        minFallbackZ = pz;
      }
      const bin = ((pz - histMinZ) * histInvStep) | 0;
      if (bin >= 0 && bin < 40) {
        sharedEgoHistogram[bin] = (sharedEgoHistogram[bin] ?? 0) + 1;
      }
    }
  }

  let peakBin = -1;
  let peakCount = 0;
  for (let b = 0; b < 40; b += 1) {
    const c = sharedEgoHistogram[b] ?? 0;
    if (c > peakCount) {
      peakCount = c;
      peakBin = b;
    }
  }

  let egoGroundZ = -1.65;
  if (peakBin >= 0 && peakCount >= 4) {
    // Anchor at the lowest significant bin near the mode so the full thickness of the road layer is above egoGroundZ
    let chosenBin = peakBin;
    const minSignificant = Math.max(3, Math.floor(peakCount * 0.25));
    for (let b = Math.max(0, peakBin - 3); b <= peakBin; b += 1) {
      if ((sharedEgoHistogram[b] ?? 0) >= minSignificant) {
        chosenBin = b;
        break;
      }
    }
    egoGroundZ = histMinZ + (chosenBin + 0.5) / histInvStep;
  } else if (validNearSamples > 0 && Number.isFinite(minFallbackZ)) {
    egoGroundZ = minFallbackZ;
  }

  sharedGroundCellMinZ.fill(Infinity);
  const gridStride = totalPts > 40000 ? 6 : 3;

  for (let i = 0; i < len; i += gridStride) {
    const px = srcPositions[i] ?? 0;
    const py = srcPositions[i + 1] ?? 0;
    const pz = srcPositions[i + 2] ?? 0;

    const gx = ((px + GROUND_HALF_SPAN) * GROUND_INV_CELL_SIZE) | 0;
    const gy = ((py + GROUND_HALF_SPAN) * GROUND_INV_CELL_SIZE) | 0;
    if (gx < 0 || gx >= GROUND_GRID_SIDE || gy < 0 || gy >= GROUND_GRID_SIDE) {
      continue;
    }

    const ax = px < 0 ? -px : px;
    const ay = py < 0 ? -py : py;
    const rApprox = ax > ay ? ax + 0.4 * ay : ay + 0.4 * ax;

    const minPlausible = egoGroundZ - 0.35 - 0.035 * rApprox;
    const maxPlausible = egoGroundZ + 0.18 + 0.035 * rApprox;
    if (pz < minPlausible || pz > maxPlausible) {
      continue;
    }

    const cellIdx = (gy << 6) | gx;
    if (pz < sharedGroundCellMinZ[cellIdx]!) {
      sharedGroundCellMinZ[cellIdx] = pz;
    }
  }

  return { egoGroundZ, cellMinZ: sharedGroundCellMinZ };
}

/**
 * Stateful, dirty-flagged pre-render enhancer for CVAT's `Canvas3dViewImpl`.
 * Guarantees that point cloud buffer coloring, background changes, and scattering material
 * updates execute AT MOST ONCE per frame/state change rather than every 60fps render tick.
 */
export class Cvat3dPreRenderEnhancer {
  private options: Cvat3dWorkspaceRenderOptions;
  private readonly baseColorsCache = new WeakMap<object, Float32Array>();
  private readonly modifiedGeometries = new WeakSet<object>();
  private readonly compactedGeometries = new WeakSet<object>();
  private readonly hookedViews = new WeakSet<object>();
  private readonly hookedPrototypes = new WeakSet<object>();
  private readonly hookedPointObjects = new WeakSet<object>();
  private readonly primaryPerspectiveMaterials = new WeakSet<object>();
  private readonly initializedMaterials = new WeakSet<object>();
  private readonly optimizedPlaneMeshes = new WeakSet<object>();
  private readonly scenePlaneCheckCount = new WeakMap<object, number>();
  private readonly geometrySignatureMap = new WeakMap<object, string>();
  private readonly appliedViewBackground = new WeakMap<object, boolean>();
  private readonly sceneRenderContext = new Map<
    ThreeSceneLike,
    { renderer: NonNullable<CvatRenderViewLike['renderer']>; camera: unknown }
  >();
  private primaryPerspectiveScene: ThreeSceneLike | null = null;
  private primaryPerspectiveCanvas: HTMLCanvasElement | null = null;
  private activeView: CvatInternalViewLike | null = null;
  private activeModel: CvatInternalCanvas3dLike['model'] | null = null;
  private lastCompiledBoxes: OrientedBoxBounds[] = [];
  private lastExecutionSignature = '';
  private lastGeometryColorSignature = '';
  private lastViewCount = 0;
  private dirty = true;
  private pendingFrameObjectsLoad = true;
  private isRedrawingViews = false;
  private isApplying = false;

  /**
   * Returns the camera most recently used to render into the given `<canvas>` (captured from
   * the scene `onBeforeRender` hook), or `null` if that canvas has not been rendered yet.
   */
  public getLastRenderCameraForCanvas(canvas: HTMLCanvasElement | null | undefined): unknown {
    if (!canvas) {
      return null;
    }
    for (const ctx of this.sceneRenderContext.values()) {
      if (ctx.renderer?.domElement === canvas) {
        return ctx.camera ?? null;
      }
    }
    return null;
  }

  public constructor(initialOptions: Cvat3dWorkspaceRenderOptions = DEFAULT_CVAT_3D_RENDER_OPTIONS) {
    this.options = {
      ...DEFAULT_CVAT_3D_RENDER_OPTIONS,
      ...initialOptions,
      hideGroundPoints: Boolean(initialOptions.hideGroundPoints),
      fixedOrthoPointSize: initialOptions.fixedOrthoPointSize ?? true,
      followActiveObject: initialOptions.followActiveObject ?? true,
      enableActiveObjectWarnings: initialOptions.enableActiveObjectWarnings ?? true,
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
    const nextHideGround = Boolean(next.hideGroundPoints);
    const prevHideGround = Boolean(this.options.hideGroundPoints);
    const changed =
      next.whiteBackground !== this.options.whiteBackground ||
      next.enableScattering !== this.options.enableScattering ||
      next.colorPointsByCuboid !== this.options.colorPointsByCuboid ||
      nextHideGround !== prevHideGround ||
      nextOrthoFixed !== prevOrthoFixed;

    this.options = {
      ...next,
      hideGroundPoints: nextHideGround,
      fixedOrthoPointSize: nextOrthoFixed,
      followActiveObject: next.followActiveObject ?? true,
      enableActiveObjectWarnings: next.enableActiveObjectWarnings ?? true,
    };
    if (changed) {
      this.dirty = true;
      this.pendingFrameObjectsLoad = true;
      const targetView = canvas3d?.view ?? this.activeView;
      const targetModel = canvas3d?.model ?? this.activeModel ?? undefined;
      if (targetView) {
        this.appliedViewBackground.delete(targetView);
        this.applyOnceIfNeeded(targetView, targetModel);
        this.requestViewsRedraw();
      }
    }
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
      for (const [scene, ctx] of this.sceneRenderContext.entries()) {
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
    if (!this.dirty && this.appliedViewBackground.get(view) === this.options.whiteBackground) {
      return;
    }
    const entries = Object.entries(view.views);

    const targetBgHex = this.options.whiteBackground ? 0xffffff : 0x000000;
    const targetBgCss = this.options.whiteBackground ? '#ffffff' : '#000000';

    for (const [, rv] of entries) {
      if (!rv) continue;
      if (rv.scene) {
        this.ensureThreePrototypesHooked(rv.scene);
      }
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
          const targetBgRgb = this.options.whiteBackground
            ? 'rgb(255, 255, 255)'
            : 'rgb(0, 0, 0)';
          const sceneObj = scene as ThreeSceneLike | undefined;
          if (sceneObj?.background && typeof sceneObj.background.set === 'function') {
            sceneObj.background.set(targetBgHex);
          }
          if (
            sceneObj &&
            sceneObj !== this.primaryPerspectiveScene &&
            Array.isArray(sceneObj.children) &&
            this.scenePlaneCheckCount.get(sceneObj) !== sceneObj.children.length
          ) {
            this.scenePlaneCheckCount.set(sceneObj, sceneObj.children.length);
            optimizeOrthographicRaycastPlanes(sceneObj, this.optimizedPlaneMeshes);
          }
          const renObj = renderer as CvatRenderViewLike['renderer'] | undefined;
          if (sceneObj && renObj && typeof renObj.render === 'function' && camera) {
            // Remember (renderer, camera) per scene so option toggles can force an immediate redraw
            this.sceneRenderContext.set(sceneObj, { renderer: renObj, camera });
            if (this.sceneRenderContext.size > 16) {
              const oldestKey = this.sceneRenderContext.keys().next().value;
              if (oldestKey) this.sceneRenderContext.delete(oldestKey);
            }
          }
          if (
            renObj?.domElement &&
            renObj.domElement.style.backgroundColor !== targetBgCss &&
            renObj.domElement.style.backgroundColor !== targetBgRgb
          ) {
            renObj.domElement.style.backgroundColor = targetBgCss;
            if (typeof renObj.setClearColor === 'function') {
              renObj.setClearColor(targetBgHex, 1);
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
      if (this.primaryPerspectiveScene && scene) {
        isPerspective = scene === this.primaryPerspectiveScene;
      } else if (this.primaryPerspectiveCanvas && renObj?.domElement) {
        isPerspective = renObj.domElement === this.primaryPerspectiveCanvas;
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
      this.lastGeometryColorSignature &&
      this.geometrySignatureMap.get(ptsObj.geometry) !== this.lastGeometryColorSignature
    ) {
      this.geometrySignatureMap.set(ptsObj.geometry, this.lastGeometryColorSignature);
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
      const currentViewCount = view.views ? Object.keys(view.views).length : 0;
      if (this.dirty || currentViewCount !== this.lastViewCount) {
        this.dirty = true;
        this.applyOnceIfNeeded(view, canvas3d?.model);
      }
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
    if (!view.views || this.isApplying) {
      return false;
    }
    this.isApplying = true;
    try {
      this.activeView = view;
      if (model) {
        this.activeModel = model;
      }

      // Set WebGL scene background BEFORE checking whether point cloud has loaded so frame 0 never flashes black
      this.applySceneBackgrounds(view);

      const perspectiveScene = view.views.perspective?.scene;
      this.primaryPerspectiveScene = perspectiveScene ?? null;
      this.primaryPerspectiveCanvas = view.views.perspective?.renderer?.domElement ?? null;
      if (perspectiveScene) {
        this.ensureThreePrototypesHooked(perspectiveScene);
      }

      const perspectivePoints = findPointsObjectsInScene(perspectiveScene);
      if (perspectivePoints.length === 0) {
        // Scene point cloud not yet populated for this frame; keep dirty=true so point coloring runs on PCD load
        return false;
      }

      this.ensureThreePrototypesHooked(perspectiveScene, perspectivePoints[0]);

      const drawnObjects = view.drawnObjects ?? {};
      const hasDrawnObjects = Object.keys(drawnObjects).length > 0;

      const viewEntries = Object.entries(view.views);
      this.lastViewCount = viewEntries.length;
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
      const hideGround = Boolean(this.options.hideGroundPoints);
      const geometryColorSignature = `${String(frameId)}::${this.options.whiteBackground ? 1 : 0}:${this.options.enableScattering ? 1 : 0}:${this.options.colorPointsByCuboid ? 1 : 0}:${hideGround ? 1 : 0}::${hasDrawnObjects ? 1 : 0}`;
      const currentSignature = `${geometryColorSignature}:${orthoFixed ? 1 : 0}::v${viewEntries.length}:p${totalPointsObjects}`;

      if (!this.dirty && currentSignature === this.lastExecutionSignature) {
        return false;
      }

      const shouldRecompileBoxSnapshots =
        this.pendingFrameObjectsLoad || geometryColorSignature !== this.lastGeometryColorSignature;

      this.lastExecutionSignature = currentSignature;
      this.lastGeometryColorSignature = geometryColorSignature;
      this.dirty = false;
      if (hasDrawnObjects) {
        this.pendingFrameObjectsLoad = false;
      }

      const cuboidViewKeys = ['perspective', 'top', 'side', 'front'] as const;

      for (const [key, rv] of viewEntries) {
        if (!rv) continue;

        if (rv.scene) {
          optimizeOrthographicRaycastPlanes(rv.scene, this.optimizedPlaneMeshes);
        }
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

      // Apply per-cuboid point coloring and/or ground hiding across all views' point clouds.
      // IMPORTANT: Only recompile cuboid bounds on initial frame load or option change (`shouldRecompileBoxSnapshots`),
      // NEVER when a box is being dragged/resized/rotated or when a zoom canvas mounts mid-frame!
      if (shouldRecompileBoxSnapshots) {
        this.lastCompiledBoxes =
          this.options.colorPointsByCuboid || hideGround
            ? compileOrientedCuboids(drawnObjects, this.options.whiteBackground)
            : [];
      }
      const compiledBoxes = this.lastCompiledBoxes;
      const processedGeometries = new WeakSet<object>();

      for (const [, rv] of viewEntries) {
        const pointsList = findPointsObjectsInScene(rv?.scene);
        for (const ptsObj of pointsList) {
          if (ptsObj.geometry && !processedGeometries.has(ptsObj.geometry)) {
            processedGeometries.add(ptsObj.geometry);
            if (
              shouldRecompileBoxSnapshots ||
              this.geometrySignatureMap.get(ptsObj.geometry) !== geometryColorSignature
            ) {
              this.geometrySignatureMap.set(ptsObj.geometry, geometryColorSignature);
              this.applyPointCloudBoxColors(ptsObj, compiledBoxes);
            }
          }
        }
      }

      return true;
    } finally {
      this.isApplying = false;
    }
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

    const useFixedOrtho35px = this.options.fixedOrthoPointSize ?? true;
    const targetSize = isPerspective ? 0.05 : useFixedOrtho35px ? 3.5 : 0.5;
    const targetAttenuation = isPerspective ? true : !useFixedOrtho35px;

    const needsShaderUpdate =
      !this.initializedMaterials.has(mat) ||
      mat.sizeAttenuation !== targetAttenuation ||
      mat.transparent !== false;
    this.initializedMaterials.add(mat);

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
    const geom = ptsObj.geometry;
    const posAttr = geom?.attributes?.position;
    const colorAttr = geom?.attributes?.color;
    if (!geom || !posAttr || !colorAttr) {
      return;
    }

    const hideGround = Boolean(this.options.hideGroundPoints);
    const colorBoxes = Boolean(this.options.colorPointsByCuboid);
    const useSolidUnboxed = Boolean(this.options.enableScattering);
    const wasModified = this.modifiedGeometries.has(geom);

    // 0ms fast path on frame switch when all point-cloud buffer modifications are disabled
    if (!hideGround && !colorBoxes && !useSolidUnboxed && !wasModified) {
      return;
    }

    const posArray = posAttr.array;
    const colorArray = colorAttr.array;
    const len = Math.min(posArray.length, colorArray.length);
    if (len === 0) {
      return;
    }

    this.modifiedGeometries.add(geom);

    // Snapshot original point cloud colors once per geometry using fast native TypedArray copy
    let originalColors = this.baseColorsCache.get(colorAttr);
    if (!originalColors || originalColors.length !== len) {
      originalColors = new Float32Array(len);
      if (colorArray instanceof Float32Array && colorArray.length === len) {
        originalColors.set(colorArray);
      } else {
        for (let i = 0; i < len; i += 1) {
          originalColors[i] = colorArray[i] ?? 1;
        }
      }
      this.baseColorsCache.set(colorAttr, originalColors);
    }

    // Snapshot original positions when `hideGroundPoints` is enabled so toggling OFF restores 100% of points
    // and QA overlay checks always read the un-compacted point cloud.
    let originalPositions = originalGeometryPositionsMap.get(posAttr);
    if (!originalPositions || originalPositions.length !== len) {
      if (hideGround) {
        originalPositions = new Float32Array(len);
        if (posArray instanceof Float32Array && posArray.length === len) {
          originalPositions.set(posArray);
        } else {
          for (let i = 0; i < len; i += 1) {
            originalPositions[i] = posArray[i] ?? 0;
          }
        }
        originalGeometryPositionsMap.set(posAttr, originalPositions);
        originalGeometryPositionsMap.set(geom, originalPositions);
      }
    }

    if (!hideGround && this.compactedGeometries.has(geom) && originalPositions) {
      if (posArray instanceof Float32Array && posArray.length === originalPositions.length) {
        posArray.set(originalPositions);
      } else {
        for (let i = 0; i < len; i += 1) {
          posArray[i] = originalPositions[i]!;
        }
      }
      posAttr.needsUpdate = true;
      const totalVertices = Math.floor(len / 3);
      if (typeof geom.setDrawRange === 'function') {
        geom.setDrawRange(0, totalVertices);
      } else if (geom.drawRange && typeof geom.drawRange === 'object') {
        geom.drawRange.start = 0;
        geom.drawRange.count = totalVertices;
      }
      this.compactedGeometries.delete(geom);
    }

    const srcPositions = originalPositions ?? posArray;

    // WebGL Float32BufferAttribute (Float32Array) always expects normalized 0.0..1.0 floats;
    // only Uint8Array/Uint8ClampedArray attributes use 0..255.
    const colorScale =
      colorArray instanceof Uint8Array || colorArray instanceof Uint8ClampedArray ? 255 : 1;

    const overlapRgb = this.options.whiteBackground ? OVERLAP_RGB_WHITE_BG : OVERLAP_RGB_BLACK_BG;
    const boxCount = boxes.length;
    const solidBase = this.options.whiteBackground ? 0 : colorScale;

    // Precompute global union AABB of all boxes so 90%+ of points outside all boxes skip the box loop in O(1)
    let globalMinX = Infinity;
    let globalMaxX = -Infinity;
    let globalMinY = Infinity;
    let globalMaxY = -Infinity;
    let globalMinZ = Infinity;
    let globalMaxZ = -Infinity;
    for (let b = 0; b < boxCount; b += 1) {
      const box = boxes[b]!;
      if (box.minX < globalMinX) globalMinX = box.minX;
      if (box.maxX > globalMaxX) globalMaxX = box.maxX;
      if (box.minY < globalMinY) globalMinY = box.minY;
      if (box.maxY > globalMaxY) globalMaxY = box.maxY;
      if (box.minZ < globalMinZ) globalMinZ = box.minZ;
      if (box.maxZ > globalMaxZ) globalMaxZ = box.maxZ;
    }
    const checkBoxes = (colorBoxes || hideGround) && boxCount > 0;

    if (!hideGround) {
      // Fast non-compacting path: bulk-initialize unboxed colors with native TypedArray `.fill()` / `.set()`
      if (useSolidUnboxed) {
        if (colorArray instanceof Float32Array || colorArray instanceof Uint8Array || colorArray instanceof Uint8ClampedArray) {
          colorArray.fill(solidBase);
        } else {
          for (let i = 0; i < len; i += 1) {
            colorArray[i] = solidBase;
          }
        }
      } else if (colorArray instanceof Float32Array && colorArray.length === originalColors.length) {
        colorArray.set(originalColors);
      } else {
        for (let i = 0; i < len; i += 1) {
          colorArray[i] = originalColors[i]!;
        }
      }

      if (colorBoxes && boxCount > 0) {
        for (let i = 0; i < len; i += 3) {
          const px = srcPositions[i] ?? 0;
          if (px < globalMinX || px > globalMaxX) continue;
          const py = srcPositions[i + 1] ?? 0;
          if (py < globalMinY || py > globalMaxY) continue;
          const pz = srcPositions[i + 2] ?? 0;
          if (pz < globalMinZ || pz > globalMaxZ) continue;

          let matchedBox: OrientedBoxBounds | null = null;
          let isOverlapping = false;

          for (let b = 0; b < boxCount; b += 1) {
            const box = boxes[b]!;
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
              isOverlapping = true;
              break;
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
          }
        }
      }

      colorAttr.needsUpdate = true;
      return;
    }

    // Ground-hiding compaction path (`hideGroundPoints === true`)
    const { egoGroundZ, cellMinZ } = populateGroundElevationGrid(srcPositions, len);
    const groundThicknessTol = 0.22;
    let writeOffset = 0;

    for (let i = 0; i < len; i += 3) {
      const px = srcPositions[i] ?? 0;
      const py = srcPositions[i + 1] ?? 0;
      const pz = srcPositions[i + 2] ?? 0;

      let matchedBox: OrientedBoxBounds | null = null;
      let isOverlapping = false;

      if (
        checkBoxes &&
        px >= globalMinX &&
        px <= globalMaxX &&
        py >= globalMinY &&
        py <= globalMaxY &&
        pz >= globalMinZ &&
        pz <= globalMaxZ
      ) {
        for (let b = 0; b < boxCount; b += 1) {
          const box = boxes[b]!;
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
            isOverlapping = true;
            break;
          }
        }
      }

      // Points outside all 3D bounding boxes are tested against the local 2D ground elevation grid
      if (matchedBox === null) {
        const gx = ((px + GROUND_HALF_SPAN) * GROUND_INV_CELL_SIZE) | 0;
        const gy = ((py + GROUND_HALF_SPAN) * GROUND_INV_CELL_SIZE) | 0;
        let localGroundZ = egoGroundZ;
        if (gx >= 0 && gx < GROUND_GRID_SIDE && gy >= 0 && gy < GROUND_GRID_SIDE) {
          const cellVal = cellMinZ[(gy << 6) | gx]!;
          if (cellVal < Infinity) {
            localGroundZ = cellVal;
          }
        }
        if (pz <= localGroundZ + groundThicknessTol && pz >= egoGroundZ - 2.0) {
          continue;
        }
      }

      posArray[writeOffset] = px;
      posArray[writeOffset + 1] = py;
      posArray[writeOffset + 2] = pz;

      if (colorBoxes && isOverlapping) {
        colorArray[writeOffset] = overlapRgb[0] * colorScale;
        colorArray[writeOffset + 1] = overlapRgb[1] * colorScale;
        colorArray[writeOffset + 2] = overlapRgb[2] * colorScale;
      } else if (colorBoxes && matchedBox) {
        colorArray[writeOffset] = matchedBox.r * colorScale;
        colorArray[writeOffset + 1] = matchedBox.g * colorScale;
        colorArray[writeOffset + 2] = matchedBox.b * colorScale;
      } else if (useSolidUnboxed) {
        colorArray[writeOffset] = solidBase;
        colorArray[writeOffset + 1] = solidBase;
        colorArray[writeOffset + 2] = solidBase;
      } else {
        colorArray[writeOffset] = originalColors[i] ?? 1;
        colorArray[writeOffset + 1] = originalColors[i + 1] ?? 1;
        colorArray[writeOffset + 2] = originalColors[i + 2] ?? 1;
      }

      writeOffset += 3;
    }

    const keptVertexCount = Math.floor(writeOffset / 3);
    if (typeof geom.setDrawRange === 'function') {
      geom.setDrawRange(0, keptVertexCount);
    } else if (geom.drawRange && typeof geom.drawRange === 'object') {
      geom.drawRange.start = 0;
      geom.drawRange.count = keptVertexCount;
    }

    // Collapse trailing unused slots to the first valid vertex so boundingSphere/Box3 or mocks without drawRange
    // never see ground coordinates or NaN/Infinity values
    const fillX = writeOffset > 0 ? posArray[0]! : 0;
    const fillY = writeOffset > 0 ? posArray[1]! : 0;
    const fillZ = writeOffset > 0 ? posArray[2]! : 0;
    for (let j = writeOffset; j < len; j += 3) {
      posArray[j] = fillX;
      posArray[j + 1] = fillY;
      posArray[j + 2] = fillZ;
    }

    this.compactedGeometries.add(geom);
    posAttr.needsUpdate = true;
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
  const targetRgb = whiteBackground ? 'rgb(255, 255, 255)' : 'rgb(0, 0, 0)';
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
    if (canvas.style.backgroundColor !== targetCss && canvas.style.backgroundColor !== targetRgb) {
      canvas.style.backgroundColor = targetCss;
    }
  }
}

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
    opts.whiteBackground ? 1 : 0,
    opts.enableScattering ? 1 : 0,
    opts.colorPointsByCuboid ? 1 : 0,
    opts.hideGroundPoints ? 1 : 0,
    (opts.fixedOrthoPointSize ?? true) ? 1 : 0,
    (opts.followActiveObject ?? true) ? 1 : 0,
    (opts.enableActiveObjectWarnings ?? true) ? 1 : 0,
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

  const syncCheckboxVisualState = (
    input: HTMLInputElement,
    checked: boolean
  ): void => {
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
      key: 'whiteBackground',
      rowClass: 'cvat-workspace-settings-3d-white-background',
      title: 'White 3D canvas background',
      description: 'Use a white background in 3D viewports and adjust unboxed point contrast',
    },
    {
      key: 'enableScattering',
      rowClass: 'cvat-workspace-settings-3d-point-scattering',
      title: 'Solid black/white 3D points (ignore LiDAR intensity)',
      description:
        'Checked: points outside boxes are pure black on white background / pure white on black background. Unchecked: keep original LiDAR intensity colors',
    },
    {
      key: 'colorPointsByCuboid',
      rowClass: 'cvat-workspace-settings-3d-color-points-by-cuboid',
      title: 'Color 3D points by bounding box',
      description: 'Highlight points inside each 3D cuboid using the cuboid color',
    },
    {
      key: 'hideGroundPoints',
      rowClass: 'cvat-workspace-settings-3d-hide-ground-points',
      title: 'Hide ground 3D points (Tắt điểm mặt đất)',
      description:
        'Hide road and ground LiDAR points on the 3D canvas to see bounding boxes clearly and speed up frame switching',
    },
    {
      key: 'fixedOrthoPointSize',
      rowClass: 'cvat-workspace-settings-3d-ortho-point-size',
      title: 'Fixed 3.5px point size in Top/Side/Front views',
      description: 'Lock point size to 3.5px in orthographic views (uncheck to follow CVAT default)',
    },
    {
      key: 'followActiveObject',
      rowClass: 'cvat-workspace-settings-3d-follow-active-object',
      title: 'Keep active object fixed on screen when changing frames',
      description:
        'Move the 3D perspective camera with the active object so it stays at the same screen position on Next/Previous frame',
    },
    {
      key: 'enableActiveObjectWarnings',
      rowClass: 'cvat-workspace-settings-3d-active-object-warnings',
      title: 'Show QA warnings on 3D canvas for active object',
      description:
        'Validate attribute dimension thresholds (K), dimension sync (S), height (Z), heading (H), jump (J), and LiDAR fit (T, P, F, D, M) on the 3D canvas',
    },
  ];

  const opts = getOptions();
  const optsSig = computeOptionsSignature(opts);
  let mountedAny = false;

  for (const container of containers) {
    const existing = container.querySelector<HTMLElement>(
      `#${WORKSPACE_SETTINGS_INJECTED_ID}, [data-enhancer-workspace-settings="true"]`
    );
    if (existing) {
      mountedAny = true;
      // Skip DOM mutation if options have not changed since last sync (prevents MutationObserver
      // from resetting input.checked mid-click!)
      if (existing.dataset.enhancerOptsSig === optsSig) {
        continue;
      }
      existing.dataset.enhancerOptsSig = optsSig;
      const bgInput = existing.querySelector<HTMLInputElement>(
        'input[data-enhancer-opt="whiteBackground"]'
      );
      const scInput = existing.querySelector<HTMLInputElement>(
        'input[data-enhancer-opt="enableScattering"]'
      );
      const boxInput = existing.querySelector<HTMLInputElement>(
        'input[data-enhancer-opt="colorPointsByCuboid"]'
      );
      const groundInput = existing.querySelector<HTMLInputElement>(
        'input[data-enhancer-opt="hideGroundPoints"]'
      );
      const orthoInput = existing.querySelector<HTMLInputElement>(
        'input[data-enhancer-opt="fixedOrthoPointSize"]'
      );
      const followInput = existing.querySelector<HTMLInputElement>(
        'input[data-enhancer-opt="followActiveObject"]'
      );
      const warnInput = existing.querySelector<HTMLInputElement>(
        'input[data-enhancer-opt="enableActiveObjectWarnings"]'
      );
      if (bgInput) syncCheckboxVisualState(bgInput, opts.whiteBackground);
      if (scInput) syncCheckboxVisualState(scInput, opts.enableScattering);
      if (boxInput) syncCheckboxVisualState(boxInput, opts.colorPointsByCuboid);
      if (groundInput) syncCheckboxVisualState(groundInput, Boolean(opts.hideGroundPoints));
      if (orthoInput) syncCheckboxVisualState(orthoInput, opts.fixedOrthoPointSize ?? true);
      if (followInput) syncCheckboxVisualState(followInput, opts.followActiveObject ?? true);
      if (warnInput) syncCheckboxVisualState(warnInput, opts.enableActiveObjectWarnings ?? true);
      continue;
    }

    const antdHash = extractAntdHashClass(container);
    const wrapper = doc.createElement('div');
    wrapper.id = WORKSPACE_SETTINGS_INJECTED_ID;
    wrapper.dataset.enhancerWorkspaceSettings = 'true';
    wrapper.dataset.enhancerOptsSig = optsSig;

    for (const item of items) {
      const isChecked =
        item.key === 'fixedOrthoPointSize' ||
        item.key === 'followActiveObject' ||
        item.key === 'enableActiveObjectWarnings'
          ? (opts[item.key] ?? true)
          : Boolean(opts[item.key]);

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
        onChange(updated);
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

export type CuboidDimensionKey = 'H' | 'W' | 'L' | 'FLIP_180';

export const CUBOID_DIMENSION_INDEX: Readonly<Record<CuboidDimensionKey, number>> = Object.freeze({
  FLIP_180: 5, // rotation.z (Yaw / Hướng đầu xe)
  L: 6, // scale.x (Length / Dài)
  W: 7, // scale.y (Width / Rộng)
  H: 8, // scale.z (Height / Cao)
});

/**
 * Normalizes `rz + Math.PI` (180-degree heading flip) into `[-Math.PI, Math.PI)`.
 */
export function flipYawAngle180Rad(rz: number): number {
  const raw = (Number(rz) || 0) + Math.PI;
  let wrapped = (raw + Math.PI) % (2 * Math.PI);
  if (wrapped < 0) {
    wrapped += 2 * Math.PI;
  }
  return wrapped - Math.PI;
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

  const rawLabelName = String(
    (currentState as { label?: { name?: string } }).label?.name ?? ''
  )
    .trim()
    .toLowerCase();
  const isTwoWheels =
    rawLabelName === 'two-wheels' ||
    rawLabelName === 'two-wheel' ||
    rawLabelName === 'twowheels' ||
    rawLabelName === 'two_wheels' ||
    Number((currentState as { label?: { id?: number }; label_id?: number }).label?.id ??
      (currentState as { label_id?: number }).label_id) === 36192;

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
    const bypassAttrMatchForTwoWheelsHL =
      isTwoWheels && (dimension === 'H' || dimension === 'L');
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
    updatedPoints[dimIndex] = targetValue;
    shape.points = updatedPoints;

    if (kfState) {
      kfState.points = updatedPoints;
      if (kfState.updateFlags) {
        kfState.updateFlags.points = true;
      }
      if (typeof internalSave === 'function') {
        const saved = internalSave(kfFrame, kfState);
        if (kfFrame === currentFrame || stateToDispatchForCanvasUpdate === null) {
          stateToDispatchForCanvasUpdate = saved;
          pointsToDispatchForCanvasUpdate = updatedPoints;
        }
      } else if (typeof kfState.save === 'function') {
        const saved = await kfState.save();
        if (kfFrame === currentFrame || stateToDispatchForCanvasUpdate === null) {
          stateToDispatchForCanvasUpdate = saved;
          pointsToDispatchForCanvasUpdate = updatedPoints;
        }
      }
    }

    syncedFrames += 1;
  }

  // Also ensure currentFrame state & cuboid scale reflect the synced dimension in real-time
  const nextCurrentPoints = [...currentPoints];
  nextCurrentPoints[dimIndex] = targetValue;
  if (entry?.data?.points && entry.data.points.length >= 9) {
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

const OBJECT_ITEM_DIM_SYNC_ROW_CLASS = 'cvat-3d-enhancer-dim-sync-row';

const DIMENSION_BUTTON_CONFIGS: readonly {
  readonly key: CuboidDimensionKey;
  readonly className: string;
  readonly title: string;
  readonly svgPath: string;
}[] = [
  {
    key: 'H',
    className: 'cvat-object-item-button-sync-h',
    title: 'Sync Height (H) across frames with 100% identical attributes',
    svgPath:
      'M2 7V3C2 2.45 2.45 2 3 2H7V4H4V7H2ZM22 7V3C22 2.45 21.55 2 21 2H17V4H20V7H22ZM2 17V21C2 21.55 2.45 22 3 22H7V20H4V17H2ZM22 17V21C22 21.55 21.55 22 21 22H17V20H20V17H22ZM7.5 6H10.2V10.7H13.8V6H16.5V18H13.8V13.1H10.2V18H7.5V6Z',
  },
  {
    key: 'W',
    className: 'cvat-object-item-button-sync-w',
    title: 'Sync Width (W) across frames with 100% identical attributes',
    svgPath:
      'M2 7V3C2 2.45 2.45 2 3 2H7V4H4V7H2ZM22 7V3C22 2.45 21.55 2 21 2H17V4H20V7H22ZM2 17V21C2 21.55 2.45 22 3 22H7V20H4V17H2ZM22 17V21C22 21.55 21.55 22 21 22H17V20H20V17H22ZM5.5 6H8.1L9.6 13.8L11.2 6H13.4L15 13.8L16.5 6H19.1L16.4 18H13.9L12.3 10.6L10.7 18H8.2L5.5 6Z',
  },
  {
    key: 'L',
    className: 'cvat-object-item-button-sync-l',
    title: 'Sync Length (L) across frames with 100% identical attributes',
    svgPath:
      'M2 7V3C2 2.45 2.45 2 3 2H7V4H4V7H2ZM22 7V3C22 2.45 21.55 2 21 2H17V4H20V7H22ZM2 17V21C2 21.55 2.45 22 3 22H7V20H4V17H2ZM22 17V21C22 21.55 21.55 22 21 22H17V20H20V17H22ZM8.5 6H11.3V15.5H16.8V18H8.5V6Z',
  },
  {
    key: 'FLIP_180',
    className: 'cvat-object-item-button-flip-180',
    title: 'Flip heading 180° on current frame (Lật đầu xe 180° ở frame hiện tại)',
    svgPath:
      'M12 2L16 6H13V11H11V6H8L12 2ZM12 22L8 18H11V13H13V18H16L12 22ZM5.64 5.64L7.05 7.05C5.17 8.93 4.69 11.74 5.62 14.12L3.77 14.9C2.5 11.74 3.16 8.12 5.64 5.64ZM18.36 18.36L16.95 16.95C18.83 15.07 19.31 12.26 18.38 9.88L20.23 9.1C21.5 12.26 20.84 15.88 18.36 18.36Z',
  },
];

function resolveObjectItemClientId(col20: Element): number | null {
  const card = col20.closest('[id^="cvat-objects-sidebar-state-item-"]');
  if (card?.id) {
    const match = /cvat-objects-sidebar-state-item-(\d+)/.exec(card.id);
    if (match?.[1]) {
      return Number(match[1]);
    }
  }
  const stateItem = col20.closest('.cvat-objects-sidebar-state-item');
  if (stateItem) {
    const idAttr = stateItem.getAttribute('data-client-id') ?? stateItem.id;
    const match = /(\d+)/.exec(idAttr);
    if (match?.[1]) {
      return Number(match[1]);
    }
  }
  return null;
}

/**
 * Injects the 3 native-styled dimension sync icons (`H`, `W`, `L`) into each 3D Track's
 * Object Item card in the CVAT sidebar (right inside `.ant-col-20` alongside CVAT's keyframe
 * and state buttons).
 */
export function injectCvatObjectDimensionSyncControls(
  doc: Document,
  onSyncDimension: (
    clientID: number,
    dimension: CuboidDimensionKey
  ) => Promise<DimensionSyncResult> | DimensionSyncResult
): number {
  const keyframeButtons = doc.querySelectorAll('.cvat-object-item-button-first-keyframe');
  let mountedCount = 0;

  for (const kfBtn of keyframeButtons) {
    const col20 = kfBtn.closest('.ant-col-20');
    if (!col20) {
      continue;
    }

    const isLocked = Boolean(col20.querySelector('.cvat-object-item-button-lock-enabled'));
    const lockFlag = isLocked ? '1' : '0';
    const existingRow = col20.querySelector<HTMLElement>(`.${OBJECT_ITEM_DIM_SYNC_ROW_CLASS}`);
    if (existingRow) {
      if (existingRow.dataset.enhancerLocked !== lockFlag) {
        existingRow.dataset.enhancerLocked = lockFlag;
        const icons = existingRow.querySelectorAll<HTMLElement>('.cvat-object-item-button-sync-dim');
        for (const icon of icons) {
          icon.style.opacity = isLocked ? '0.5' : '';
          icon.style.pointerEvents = isLocked ? 'none' : '';
        }
      }
      continue;
    }

    const sampleRow = col20.querySelector('.ant-row');
    const sampleCol = sampleRow?.querySelector('.ant-col');
    const rowClassName = sampleRow?.className
      ? `${sampleRow.className} ${OBJECT_ITEM_DIM_SYNC_ROW_CLASS}`
      : `ant-row ant-row-space-around ${OBJECT_ITEM_DIM_SYNC_ROW_CLASS}`;
    const colClassName = sampleCol?.className || 'ant-col';

    const syncRow = doc.createElement('div');
    syncRow.className = rowClassName;
    syncRow.dataset.enhancerLocked = lockFlag;

    for (const cfg of DIMENSION_BUTTON_CONFIGS) {
      const col = doc.createElement('div');
      col.className = colClassName;

      const span = doc.createElement('span');
      span.setAttribute('role', 'img');
      span.setAttribute('aria-label', `sync-${cfg.key.toLowerCase()}`);
      span.setAttribute('tabindex', '-1');
      span.className = `anticon cvat-object-item-button-sync-dim ${cfg.className}`;
      span.title = cfg.title;
      span.dataset.enhancerSyncDim = cfg.key;
      if (isLocked) {
        span.style.opacity = '0.5';
        span.style.pointerEvents = 'none';
      }

      const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('viewBox', '0 0 24 24');
      svg.setAttribute('focusable', 'false');
      svg.setAttribute('data-icon', `sync-${cfg.key.toLowerCase()}`);
      svg.setAttribute('width', '1em');
      svg.setAttribute('height', '1em');
      svg.setAttribute('fill', 'currentColor');
      svg.setAttribute('aria-hidden', 'true');

      const path = doc.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', cfg.svgPath);
      svg.appendChild(path);
      span.appendChild(svg);

      span.addEventListener('click', (e: MouseEvent) => {
        e.stopPropagation();
        e.preventDefault();
        if (col20.querySelector('.cvat-object-item-button-lock-enabled')) {
          return;
        }
        const resolvedId = resolveObjectItemClientId(col20);
        if (resolvedId === null || !Number.isFinite(resolvedId)) {
          return;
        }
        void Promise.resolve(onSyncDimension(resolvedId, cfg.key)).then((res) => {
          if (res && res.syncedFrames > 0) {
            span.style.color = '#52c41a';
            if (cfg.key === 'FLIP_180') {
              const degStr =
                res.targetValue !== null ? `${((res.targetValue * 180) / Math.PI).toFixed(1)}°` : '';
              span.title = `Flipped 180° on current frame (Yaw = ${degStr})`;
            } else {
              const valStr = res.targetValue !== null ? res.targetValue.toFixed(2) : '';
              span.title = `${cfg.key} = ${valStr} synced to ${res.syncedFrames} keyframe(s) (${res.skippedAttributeMismatchFrames} skipped due to different attributes)`;
            }
            window.setTimeout(() => {
              span.style.color = '';
            }, 900);
          }
        });
      });

      col.appendChild(span);
      syncRow.appendChild(col);
    }

    col20.appendChild(syncRow);
    mountedCount += 1;
  }

  return mountedCount;
}
