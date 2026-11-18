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
import { isNumericClientIdName } from './state-lookup';

export interface Cvat3dWorkspaceRenderOptions extends WorkspaceFeatureOptions {
  readonly whiteBackground: boolean;
  readonly enableScattering: boolean;
  readonly colorPointsByCuboid: boolean;
  readonly hideGroundPoints?: boolean;
  readonly fixedOrthoPointSize?: boolean;
  readonly followActiveObject?: boolean;
  readonly enableActiveObjectWarnings?: boolean;
}

export const DEFAULT_CVAT_3D_RENDER_OPTIONS: Cvat3dWorkspaceRenderOptions = Object.freeze({
  ...WORKSPACE_FEATURE_DEFAULTS,
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
    name?: string;
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
    whiteBackground: Boolean(obj.whiteBackground),
    enableScattering: Boolean(obj.enableScattering),
    colorPointsByCuboid: Boolean(obj.colorPointsByCuboid),
    hideGroundPoints: Boolean(obj.hideGroundPoints),
    fixedOrthoPointSize:
      typeof obj.fixedOrthoPointSize === 'boolean' ? obj.fixedOrthoPointSize : true,
    followActiveObject: typeof obj.followActiveObject === 'boolean' ? obj.followActiveObject : true,
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
        WORKSPACE_FEATURE_KEYS.some(
          (key) => (clientSettingsOptions[key] ?? true) !== (standaloneOptions[key] ?? true)
        ) ||
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
    ...normalizeWorkspaceFeatureOptions({ ...options }),
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

const CUBOID_VIEW_KEYS = ['perspective', 'top', 'side', 'front'] as const;

function isHexCharCode(code: number): boolean {
  return (code >= 48 && code <= 57) || (code >= 65 && code <= 70) || (code >= 97 && code <= 102);
}

function normalizeHex6Color(raw: unknown): string | undefined {
  if (typeof raw !== 'string') {
    return undefined;
  }
  const clean = raw.length === 7 || raw.length === 6 ? raw : raw.trim();
  const hasHash = clean.length === 7 && clean.charCodeAt(0) === 35;
  if (!hasHash && clean.length !== 6) {
    return undefined;
  }
  const offset = hasHash ? 1 : 0;
  for (let i = 0; i < 6; i += 1) {
    if (!isHexCharCode(clean.charCodeAt(offset + i))) {
      return undefined;
    }
  }
  return hasHash ? clean : `#${clean}`;
}

/**
 * Extracts the native CVAT Label color of a 3D cuboid box (`data.labelColor` or `state.label.color`).
 * Prioritizes `entry.data` fields before touching `entry.state` getters, and checks
 * `cuboid.perspective.material.color` as fallback if labelColor is not directly populated.
 */
export function resolveRenderedCuboidColorHex(entry?: CvatDrawnObjectEntry): string | undefined {
  const dataLabelHex = normalizeHex6Color(entry?.data?.labelColor);
  if (dataLabelHex) {
    return dataLabelHex;
  }

  const stateObj = entry?.state as { label?: { color?: string }; color?: string } | undefined;
  const stateLabelHex = normalizeHex6Color(stateObj?.label?.color);
  if (stateLabelHex) {
    return stateLabelHex;
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

  return (
    normalizeHex6Color(entry?.data?.color) ??
    normalizeHex6Color(stateObj?.color) ??
    normalizeHex6Color(entry?.data?.groupColor)
  );
}

/**
 * Ensures the 3D cuboid box mesh (`perspective`, `top`, `side`, `front`) keeps its native CVAT
 * Label color (`data.labelColor` / `state.label.color`) WITHOUT calling `cuboid.setColor()`,
 * because `cuboid.setColor()` in CVAT overwrites `this.wireframe.material.color` (which would
 * destroy CVAT's white/configured `outlinedBorders`).
 */
export function ensureCuboidKeepsLabelColor(entry?: CvatDrawnObjectEntry): string | undefined {
  const labelColor =
    normalizeHex6Color(entry?.data?.labelColor) ??
    normalizeHex6Color((entry?.state as { label?: { color?: string } } | undefined)?.label?.color);

  if (labelColor && entry?.cuboid) {
    for (let v = 0; v < CUBOID_VIEW_KEYS.length; v += 1) {
      const matColor = entry.cuboid[CUBOID_VIEW_KEYS[v]!]?.material?.color;
      if (matColor && typeof matColor.set === 'function') {
        matColor.set(labelColor);
      }
    }
  }

  return labelColor;
}

/**
 * Persistent per-session / per-background cache mapping each cuboid's `clientID` (or `serverID`)
 * to its assigned internal point cloud RGB color (`[r, g, b]`), bounded to prevent unbounded
 * memory growth on multi-hour 100k-box sessions.
 */
const MAX_COLOR_CACHE_ENTRIES = 250_000;
const MAX_LABEL_PALETTE_CACHE_ENTRIES = 512;
const cuboidPointColorCacheWhiteBg = new Map<number, [number, number, number]>();
const cuboidPointColorCacheBlackBg = new Map<number, [number, number, number]>();
const labelPaletteChoiceCache = new Map<string, readonly [number, number, number][]>();

function setBoundedColorCache(
  cache: Map<number, [number, number, number]>,
  stableId: number,
  color: [number, number, number]
): void {
  if (cache.size >= MAX_COLOR_CACHE_ENTRIES) {
    cache.clear();
  }
  cache.set(stableId, color);
}

export function clearCuboidPointColorCache(): void {
  cuboidPointColorCacheWhiteBg.clear();
  cuboidPointColorCacheBlackBg.clear();
  labelPaletteChoiceCache.clear();
}

function getOrBuildLabelPaletteChoices(
  normalizedLabelHex: string,
  whiteBackground: boolean
): readonly [number, number, number][] {
  const cacheKey = `${whiteBackground ? 'W' : 'B'}:${normalizedLabelHex.toLowerCase()}`;
  const existing = labelPaletteChoiceCache.get(cacheKey);
  if (existing) {
    return existing;
  }

  const palette = whiteBackground ? WHITE_BG_BOX_PALETTE : BLACK_BG_BOX_PALETTE;
  const bgRgb: readonly [number, number, number] = whiteBackground ? [1, 1, 1] : [0, 0, 0];
  const labelRgb = parseHexColorToNormalizedRgb(normalizedLabelHex);
  const blendedInteriorRgb: readonly [number, number, number] = [
    bgRgb[0] * 0.55 + labelRgb[0] * 0.45,
    bgRgb[1] * 0.55 + labelRgb[1] * 0.45,
    bgRgb[2] * 0.55 + labelRgb[2] * 0.45,
  ];

  const MIN_BOX_PERCEPTUAL_DIST = 0.5;
  const MIN_HUE_SEPARATION_DEG = 65;
  const MIN_BG_CONTRAST_RATIO = 4.2;

  const choices: [number, number, number][] = new Array(palette.length);
  for (let hashedIndex = 0; hashedIndex < palette.length; hashedIndex += 1) {
    let bestEntry = palette[hashedIndex]!;
    let bestScore = -Infinity;
    let locked: readonly [number, number, number] | null = null;

    for (let offset = 0; offset < palette.length; offset += 1) {
      const candidate = palette[(hashedIndex + offset) % palette.length]!;
      const boxDist = computePerceptualColorDistance(candidate, labelRgb);
      const hueDiff = computeHueSeparationDegrees(candidate, labelRgb);
      const interiorDist = computePerceptualColorDistance(candidate, blendedInteriorRgb);
      const interiorContrast = computeWcagContrastRatio(candidate, blendedInteriorRgb);
      const bgContrast = computeWcagContrastRatio(candidate, bgRgb);

      if (
        boxDist >= MIN_BOX_PERCEPTUAL_DIST &&
        hueDiff >= MIN_HUE_SEPARATION_DEG &&
        bgContrast >= MIN_BG_CONTRAST_RATIO &&
        interiorDist >= 0.35
      ) {
        locked = candidate;
        break;
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

    const picked = locked ?? bestEntry;
    choices[hashedIndex] = [picked[0], picked[1], picked[2]];
  }

  if (labelPaletteChoiceCache.size >= MAX_LABEL_PALETTE_CACHE_ENTRIES) {
    labelPaletteChoiceCache.clear();
  }
  labelPaletteChoiceCache.set(cacheKey, choices);
  return choices;
}

function getDistinctCuboidColorRef(
  clientID: number,
  fallbackIndex: number,
  whiteBackground: boolean,
  labelColorHex?: string
): readonly [number, number, number] {
  const hasStableId = Number.isFinite(clientID) && clientID >= 0;
  const stableId = hasStableId ? Math.floor(clientID) : -1;
  const cache = whiteBackground ? cuboidPointColorCacheWhiteBg : cuboidPointColorCacheBlackBg;

  if (hasStableId) {
    const cached = cache.get(stableId);
    if (cached) {
      return cached;
    }
  }

  const palette = whiteBackground ? WHITE_BG_BOX_PALETTE : BLACK_BG_BOX_PALETTE;
  const idNum = hasStableId ? stableId : fallbackIndex;
  // Knuth multiplicative hash for pseudo-random per-cuboid color distribution
  const hashedIndex = Math.abs((idNum * 2654435761) >>> 0) % palette.length;

  const normalizedLabelHex = normalizeHex6Color(labelColorHex);
  if (!normalizedLabelHex) {
    const entry = palette[hashedIndex]!;
    const chosen: [number, number, number] = [entry[0], entry[1], entry[2]];
    if (hasStableId) {
      setBoundedColorCache(cache, stableId, chosen);
    }
    return chosen;
  }

  const choices = getOrBuildLabelPaletteChoices(normalizedLabelHex, whiteBackground);
  const picked = choices[hashedIndex]!;
  const chosen: [number, number, number] = [picked[0], picked[1], picked[2]];
  if (hasStableId) {
    setBoundedColorCache(cache, stableId, chosen);
  }
  return chosen;
}

export function getDistinctCuboidColor(
  clientID: number,
  fallbackIndex: number,
  whiteBackground: boolean,
  labelColorHex?: string
): [number, number, number] {
  const rgb = getDistinctCuboidColorRef(clientID, fallbackIndex, whiteBackground, labelColorHex);
  return [rgb[0], rgb[1], rgb[2]];
}

export function normalizedRgbToHex(r: number, g: number, b: number): string {
  const toByte = (v: number) =>
    Math.max(0, Math.min(255, Math.round(v * 255)))
      .toString(16)
      .padStart(2, '0');
  return `#${toByte(r)}${toByte(g)}${toByte(b)}`;
}

export interface OrientedBoxBounds {
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
  if (!drawnObjects) {
    return result;
  }
  const colorCache = whiteBackground ? cuboidPointColorCacheWhiteBg : cuboidPointColorCacheBlackBg;
  let boxIdx = 0;

  for (const key in drawnObjects) {
    if (!Object.hasOwn(drawnObjects, key)) {
      continue;
    }
    const entry = drawnObjects[key];
    if (!entry) {
      continue;
    }
    const data = entry.data;
    if (data?.hidden === true || data?.outside === true) {
      continue;
    }
    const rawDataHidden = data?.hidden;
    const rawDataOutside = data?.outside;
    const needStateFlags =
      rawDataHidden === undefined ||
      rawDataHidden === null ||
      rawDataOutside === undefined ||
      rawDataOutside === null;
    const state = needStateFlags ? entry.state : undefined;
    if (
      needStateFlags &&
      (Boolean(rawDataHidden ?? state?.hidden) || Boolean(rawDataOutside ?? state?.outside))
    ) {
      continue;
    }

    const dataPts = data?.points;
    let rawPoints: readonly number[] | null = null;
    if (Array.isArray(dataPts) && dataPts.length >= 9) {
      rawPoints = dataPts;
    } else {
      const st = state ?? entry.state;
      if (Array.isArray(st?.points) && st.points.length >= 9) {
        rawPoints = st.points;
      }
    }

    const cuboid = entry.cuboid;
    if (cuboid) {
      for (let v = 0; v < CUBOID_VIEW_KEYS.length; v += 1) {
        const meshMat = cuboid[CUBOID_VIEW_KEYS[v]!]?.material;
        if (meshMat && typeof meshMat === 'object') {
          meshMat.depthWrite = false;
        }
      }
    }

    const perspMesh = cuboid?.perspective;
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

    // NaN extents/rotations would make every point test pass (NaN comparisons are false).
    if (
      !(sx > 0 && sy > 0 && sz > 0) ||
      !Number.isFinite(cx) ||
      !Number.isFinite(cy) ||
      !Number.isFinite(cz) ||
      !Number.isFinite(rx) ||
      !Number.isFinite(ry) ||
      !Number.isFinite(rz) ||
      !Number.isFinite(sx) ||
      !Number.isFinite(sy) ||
      !Number.isFinite(sz)
    ) {
      continue;
    }

    const hx = sx * 0.5;
    const hy = sy * 0.5;
    const hz = sz * 0.5;

    // Three.js default Euler order is 'XYZ': R = Rx * Ry * Rz.
    // Fast-path common yaw-only 3D LiDAR cuboids (rx === 0 && ry === 0) to skip 4 trig calls.
    let m00: number;
    let m01: number;
    let m02: number;
    let m10: number;
    let m11: number;
    let m12: number;
    let m20: number;
    let m21: number;
    let m22: number;

    const czRot = Math.cos(rz);
    const szRot = Math.sin(rz);
    if (rx === 0 && ry === 0) {
      m00 = czRot;
      m01 = -szRot;
      m02 = 0;
      m10 = szRot;
      m11 = czRot;
      m12 = 0;
      m20 = 0;
      m21 = 0;
      m22 = 1;
    } else {
      const cxRot = Math.cos(rx);
      const sxRot = Math.sin(rx);
      const cyRot = Math.cos(ry);
      const syRot = Math.sin(ry);

      m00 = cyRot * czRot;
      m01 = -cyRot * szRot;
      m02 = syRot;

      m10 = sxRot * syRot * czRot + cxRot * szRot;
      m11 = -sxRot * syRot * szRot + cxRot * czRot;
      m12 = -sxRot * cyRot;

      m20 = -cxRot * syRot * czRot + sxRot * szRot;
      m21 = cxRot * syRot * szRot + sxRot * czRot;
      m22 = cxRot * cyRot;
    }

    // AABB conservative half-extents for fast rejection before OBB dot product
    const aabbX = Math.abs(m00) * hx + Math.abs(m01) * hy + Math.abs(m02) * hz;
    const aabbY = Math.abs(m10) * hx + Math.abs(m11) * hy + Math.abs(m12) * hz;
    const aabbZ = Math.abs(m20) * hx + Math.abs(m21) * hy + Math.abs(m22) * hz;

    const rawId = data?.clientID ?? (state ?? entry.state)?.clientID ?? boxIdx;
    const clientID = Number(rawId);
    const hasStableId = Number.isFinite(clientID) && clientID >= 0;
    const stableId = hasStableId ? Math.floor(clientID) : -1;

    // NEVER touch or mutate `entry.cuboid` colors/materials here!
    // Check per-clientID cache BEFORE reading/parsing label colors, and avoid tuple cloning.
    let rgb: readonly [number, number, number] | undefined = hasStableId
      ? colorCache.get(stableId)
      : undefined;
    if (!rgb) {
      const renderedBoxColorHex = resolveRenderedCuboidColorHex(entry);
      rgb = getDistinctCuboidColorRef(clientID, boxIdx, whiteBackground, renderedBoxColorHex);
    }
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
      r: rgb[0],
      g: rgb[1],
      b: rgb[2],
    });
  }

  return result;
}

/**
 * O(N) single-pass, zero-array-allocation, order-independent visibility token over `drawnObjects`.
 * Combines `totalCount`, `visibleCount`, and two avalanche-mixed 32-bit commutative accumulators
 * into a compact fixed-size string (~32 chars) instead of sorting 100k strings into a ~1 MB buffer.
 */
export function computeDrawnObjectsVisibilityToken(
  drawnObjects?: Record<number, CvatDrawnObjectEntry> | null
): string {
  if (!drawnObjects) {
    return '';
  }
  let totalCount = 0;
  let visibleCount = 0;
  let sumLo = 0;
  let xorHi = 0;
  let sumHi = 0;

  for (const id in drawnObjects) {
    if (!Object.hasOwn(drawnObjects, id)) {
      continue;
    }
    const entry = drawnObjects[id];
    const data = entry?.data;
    const rawHidden = data?.hidden;
    const rawOutside = data?.outside;
    const hidden = Boolean(
      rawHidden !== undefined && rawHidden !== null ? rawHidden : entry?.state?.hidden
    );
    const outside = Boolean(
      rawOutside !== undefined && rawOutside !== null ? rawOutside : entry?.state?.outside
    );
    const flags = (hidden ? 1 : 0) | (outside ? 2 : 0);
    if (flags === 0) {
      visibleCount += 1;
    }
    totalCount += 1;

    let h1 = (0x811c9dc5 ^ ((flags + 1) * 0x9e3779b1)) >>> 0;
    let h2 = (0x9e3779b9 ^ ((flags + 5) * 0x85ebca6b)) >>> 0;
    const idLen = id.length;
    for (let i = 0; i < idLen; i += 1) {
      const ch = id.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 0x01000193) >>> 0;
      h2 = Math.imul(h2 ^ (ch + ((i + 1) << 8)), 0x85ebca6b) >>> 0;
    }

    h1 ^= h1 >>> 16;
    h1 = Math.imul(h1, 0x85ebca6b) >>> 0;
    h1 ^= h1 >>> 13;
    h1 = Math.imul(h1, 0xc2b2ae35) >>> 0;
    h1 = (h1 ^ (h1 >>> 16)) >>> 0;

    h2 ^= h2 >>> 16;
    h2 = Math.imul(h2, 0xc2b2ae35) >>> 0;
    h2 ^= h2 >>> 13;
    h2 = Math.imul(h2, 0x85ebca6b) >>> 0;
    h2 = (h2 ^ (h2 >>> 16)) >>> 0;

    sumLo = (sumLo + h1) | 0;
    xorHi = (xorHi ^ h2) >>> 0;
    sumHi = (sumHi + h2) | 0;
  }

  if (totalCount === 0) {
    return '';
  }
  const loHex = (sumLo >>> 0).toString(16).padStart(8, '0');
  const hiHex = ((xorHi ^ (sumHi >>> 0)) >>> 0).toString(16).padStart(8, '0');
  return `${totalCount}:${visibleCount}:${loHex}:${hiHex}`;
}

/**
 * IDs plus outside/hidden flags of drawn objects. Retained for backwards compatibility, avoiding
 * `Object.entries` tuple allocations and skipping `.sort()` when keys are already ordered.
 */
export function drawnObjectsVisibilitySignature(
  drawnObjects?: Record<number, CvatDrawnObjectEntry> | null
): string {
  if (!drawnObjects) return '';
  const parts: string[] = [];
  let prevPart: string | null = null;
  let needsSort = false;

  for (const id in drawnObjects) {
    if (!Object.hasOwn(drawnObjects, id)) {
      continue;
    }
    const entry = drawnObjects[id];
    const data = entry?.data;
    const rawHidden = data?.hidden;
    const rawOutside = data?.outside;
    const hidden = Boolean(
      rawHidden !== undefined && rawHidden !== null ? rawHidden : entry?.state?.hidden
    );
    const outside = Boolean(
      rawOutside !== undefined && rawOutside !== null ? rawOutside : entry?.state?.outside
    );
    const part = hidden || outside ? `${id}:${outside ? 'o' : ''}${hidden ? 'h' : ''}` : id;
    if (!needsSort && prevPart !== null && part < prevPart) {
      needsSort = true;
    }
    prevPart = part;
    parts.push(part);
  }
  if (needsSort) {
    parts.sort();
  }
  return parts.join(',');
}

export interface BoxSpatialBounds {
  readonly minX: number;
  readonly maxX: number;
  readonly minY: number;
  readonly maxY: number;
  readonly minZ: number;
  readonly maxZ: number;
}

/**
 * Two-level hierarchical XY spatial index over compiled cuboids (CSR layout):
 * - Level 1 (Fine grid up to 512x512, min cell 0.75m): indexes compact cuboids spanning <= 32 fine cells.
 * - Level 2 (Coarse 32x32 grid): indexes medium/large rotated cuboids spanning > 32 fine cells and <= 32 coarse cells.
 * - Overflow array: holds huge cuboids (> 32 coarse cells), grid-boundary straddlers, and distant coordinate outliers.
 */
export interface BoxSpatialIndex {
  readonly minX: number;
  readonly maxX: number;
  readonly minY: number;
  readonly maxY: number;
  readonly minZ: number;
  readonly maxZ: number;
  readonly gridMinX: number;
  readonly gridMaxX: number;
  readonly gridMinY: number;
  readonly gridMaxY: number;
  readonly invCell: number;
  readonly cols: number;
  readonly rows: number;
  readonly cellStart: Int32Array;
  readonly cellItems: Int32Array;
  readonly cellMinZ: Float32Array;
  readonly cellMaxZ: Float32Array;
  readonly boxAabb6: Float64Array;
  readonly coarseInvCellX: number;
  readonly coarseInvCellY: number;
  readonly coarseCellStart: Int32Array;
  readonly coarseCellItems: Int32Array;
  readonly coarseMinX: number;
  readonly coarseMaxX: number;
  readonly coarseMinY: number;
  readonly coarseMaxY: number;
  readonly coarseMinZ: number;
  readonly coarseMaxZ: number;
  readonly overflowBoxes: Int32Array;
  readonly hugeInteriorCount: number;
  readonly exteriorScanLimit: number;
  readonly overflowMinX: number;
  readonly overflowMaxX: number;
  readonly overflowMinY: number;
  readonly overflowMaxY: number;
  readonly overflowMinZ: number;
  readonly overflowMaxZ: number;
  readonly hugeMinX: number;
  readonly hugeMaxX: number;
  readonly hugeMinY: number;
  readonly hugeMaxY: number;
  readonly hugeMinZ: number;
  readonly hugeMaxZ: number;
}

const BOX_GRID_MAX_CELLS_PER_AXIS = 512;
const BOX_GRID_MIN_CELL_SIZE = 0.75;
const COARSE_GRID_SIDE = 64;
const COARSE_GRID_CELLS = COARSE_GRID_SIDE * COARSE_GRID_SIDE;
const MAX_GRID_CELLS_PER_BOX = 32;
const OUTLIER_DETECTION_MIN_BOXES = 64;
const OUTLIER_SPAN_THRESHOLD_METERS = 600;
const CORE_SAMPLE_CAP = 512;
const EMPTY_INT32_ARRAY = new Int32Array(0);
const EMPTY_COARSE_START = new Int32Array(COARSE_GRID_CELLS + 1);

const sharedSampleX = new Float64Array(CORE_SAMPLE_CAP);
const sharedSampleY = new Float64Array(CORE_SAMPLE_CAP);
let sharedBoxX0 = new Int16Array(0);
let sharedBoxX1 = new Int16Array(0);
let sharedBoxY0 = new Int16Array(0);
let sharedBoxY1 = new Int16Array(0);
let sharedGridCursor = new Int32Array(0);
const sharedCoarseCursor = new Int32Array(COARSE_GRID_CELLS);

export const POINT_OUTSIDE_BOXES = -1;
export const POINT_IN_OVERLAP = -2;

function selectCoreAxisWindow(
  sorted: Float64Array,
  rawMin: number,
  rawMax: number
): [number, number] {
  if (rawMax - rawMin <= OUTLIER_SPAN_THRESHOLD_METERS) {
    return [rawMin, rawMax];
  }
  const n = sorted.length;
  const atQuantile = (q: number): number =>
    sorted[Math.min(n - 1, Math.max(0, Math.floor((n - 1) * q)))]!;

  for (const trim of [0.01, 0.02, 0.05, 0.1]) {
    const lo = atQuantile(trim);
    const hi = atQuantile(1 - trim);
    if (hi - lo <= OUTLIER_SPAN_THRESHOLD_METERS) {
      const pad = 25;
      return [Math.max(rawMin, lo - pad), Math.min(rawMax, hi + pad)];
    }
  }

  const lo98 = atQuantile(0.02);
  const hi98 = atQuantile(0.98);
  const pad = Math.max(25, (hi98 - lo98) * 0.05);
  return [Math.max(rawMin, lo98 - pad), Math.min(rawMax, hi98 + pad)];
}

export function buildBoxSpatialIndex(
  boxes: readonly OrientedBoxBounds[],
  domainBounds?: BoxSpatialBounds | null
): BoxSpatialIndex | null {
  const count = boxes.length;
  if (count === 0) return null;

  const hasDomain = Boolean(
    domainBounds &&
    Number.isFinite(domainBounds.minX) &&
    Number.isFinite(domainBounds.maxX) &&
    Number.isFinite(domainBounds.minY) &&
    Number.isFinite(domainBounds.maxY) &&
    Number.isFinite(domainBounds.minZ) &&
    Number.isFinite(domainBounds.maxZ) &&
    domainBounds.minX <= domainBounds.maxX &&
    domainBounds.minY <= domainBounds.maxY &&
    domainBounds.minZ <= domainBounds.maxZ
  );

  const dMinX = hasDomain ? domainBounds!.minX : -Infinity;
  const dMaxX = hasDomain ? domainBounds!.maxX : Infinity;
  const dMinY = hasDomain ? domainBounds!.minY : -Infinity;
  const dMaxY = hasDomain ? domainBounds!.maxY : Infinity;
  const dMinZ = hasDomain ? domainBounds!.minZ : -Infinity;
  const dMaxZ = hasDomain ? domainBounds!.maxZ : Infinity;

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  let activeCount = 0;
  let spanAccum = 0;

  for (let b = 0; b < count; b += 1) {
    const box = boxes[b]!;
    if (hasDomain) {
      if (
        box.maxX < dMinX ||
        box.minX > dMaxX ||
        box.maxY < dMinY ||
        box.minY > dMaxY ||
        box.maxZ < dMinZ ||
        box.minZ > dMaxZ
      ) {
        continue;
      }
      const bx0 = box.minX > dMinX ? box.minX : dMinX;
      const bx1 = box.maxX < dMaxX ? box.maxX : dMaxX;
      const by0 = box.minY > dMinY ? box.minY : dMinY;
      const by1 = box.maxY < dMaxY ? box.maxY : dMaxY;
      const bz0 = box.minZ > dMinZ ? box.minZ : dMinZ;
      const bz1 = box.maxZ < dMaxZ ? box.maxZ : dMaxZ;
      if (bx0 < minX) minX = bx0;
      if (bx1 > maxX) maxX = bx1;
      if (by0 < minY) minY = by0;
      if (by1 > maxY) maxY = by1;
      if (bz0 < minZ) minZ = bz0;
      if (bz1 > maxZ) maxZ = bz1;
      const sx = bx1 - bx0;
      const sy = by1 - by0;
      const maxDim = sx > sy ? sx : sy;
      spanAccum += maxDim < 10 ? maxDim : 10;
      activeCount += 1;
    } else {
      if (box.minX < minX) minX = box.minX;
      if (box.maxX > maxX) maxX = box.maxX;
      if (box.minY < minY) minY = box.minY;
      if (box.maxY > maxY) maxY = box.maxY;
      if (box.minZ < minZ) minZ = box.minZ;
      if (box.maxZ > maxZ) maxZ = box.maxZ;
      const sx = box.maxX - box.minX;
      const sy = box.maxY - box.minY;
      const maxDim = sx > sy ? sx : sy;
      spanAccum += maxDim < 10 ? maxDim : 10;
      activeCount += 1;
    }
  }

  if (
    activeCount === 0 ||
    !Number.isFinite(minX) ||
    !Number.isFinite(maxX) ||
    !Number.isFinite(minY) ||
    !Number.isFinite(maxY) ||
    !Number.isFinite(minZ) ||
    !Number.isFinite(maxZ)
  ) {
    return null;
  }

  let gridMinX = minX;
  let gridMaxX = maxX;
  let gridMinY = minY;
  let gridMaxY = maxY;

  if (
    activeCount >= OUTLIER_DETECTION_MIN_BOXES &&
    (maxX - minX > OUTLIER_SPAN_THRESHOLD_METERS || maxY - minY > OUTLIER_SPAN_THRESHOLD_METERS)
  ) {
    const targetSamples = Math.min(activeCount, CORE_SAMPLE_CAP);
    const sampleStep = activeCount / targetSamples;
    let activeSeen = 0;
    let nextTarget = 0;
    let collected = 0;

    for (let b = 0; b < count && collected < targetSamples; b += 1) {
      const box = boxes[b]!;
      if (
        hasDomain &&
        (box.maxX < dMinX ||
          box.minX > dMaxX ||
          box.maxY < dMinY ||
          box.minY > dMaxY ||
          box.maxZ < dMinZ ||
          box.minZ > dMaxZ)
      ) {
        continue;
      }
      if (activeSeen >= Math.floor(nextTarget)) {
        sharedSampleX[collected] = box.cx;
        sharedSampleY[collected] = box.cy;
        collected += 1;
        nextTarget += sampleStep;
      }
      activeSeen += 1;
    }

    if (collected >= 16) {
      const sortedX = sharedSampleX.subarray(0, collected);
      const sortedY = sharedSampleY.subarray(0, collected);
      sortedX.sort();
      sortedY.sort();
      const [winMinX, winMaxX] = selectCoreAxisWindow(sortedX, minX, maxX);
      const [winMinY, winMaxY] = selectCoreAxisWindow(sortedY, minY, maxY);

      let tightMinX = Infinity;
      let tightMaxX = -Infinity;
      let tightMinY = Infinity;
      let tightMaxY = -Infinity;
      for (let b = 0; b < count; b += 1) {
        const box = boxes[b]!;
        if (
          hasDomain &&
          (box.maxX < dMinX ||
            box.minX > dMaxX ||
            box.maxY < dMinY ||
            box.minY > dMaxY ||
            box.maxZ < dMinZ ||
            box.minZ > dMaxZ)
        ) {
          continue;
        }
        const bx0 = hasDomain && box.minX < dMinX ? dMinX : box.minX;
        const bx1 = hasDomain && box.maxX > dMaxX ? dMaxX : box.maxX;
        const by0 = hasDomain && box.minY < dMinY ? dMinY : box.minY;
        const by1 = hasDomain && box.maxY > dMaxY ? dMaxY : box.maxY;
        if (bx0 >= winMinX && bx1 <= winMaxX && by0 >= winMinY && by1 <= winMaxY) {
          if (bx0 < tightMinX) tightMinX = bx0;
          if (bx1 > tightMaxX) tightMaxX = bx1;
          if (by0 < tightMinY) tightMinY = by0;
          if (by1 > tightMaxY) tightMaxY = by1;
        }
      }
      if (tightMinX <= tightMaxX && tightMinY <= tightMaxY) {
        gridMinX = tightMinX;
        gridMaxX = tightMaxX;
        gridMinY = tightMinY;
        gridMaxY = tightMaxY;
      } else {
        gridMinX = winMinX;
        gridMaxX = winMaxX;
        gridMinY = winMinY;
        gridMaxY = winMaxY;
      }
    }
  }

  const gridSpanX = Math.max(0, gridMaxX - gridMinX);
  const gridSpanY = Math.max(0, gridMaxY - gridMinY);
  const meanBoxSpan = spanAccum / activeCount;
  // Scale fine cell size in [0.75m, 1.4m] to typical vehicle extent so standard rotated cars
  // fit in <= 25 fine cells (instead of spilling 78k cars into overflow), while keeping cells <= 1.4m.
  const adaptiveMinCell = Math.min(1.4, Math.max(BOX_GRID_MIN_CELL_SIZE, meanBoxSpan * 0.31));
  const cellSize = Math.max(
    adaptiveMinCell,
    gridSpanX / BOX_GRID_MAX_CELLS_PER_AXIS,
    gridSpanY / BOX_GRID_MAX_CELLS_PER_AXIS
  );
  const invCell = 1 / cellSize;
  const cols = Math.min(
    BOX_GRID_MAX_CELLS_PER_AXIS,
    Math.max(1, Math.floor(gridSpanX * invCell) + 1)
  );
  const rows = Math.min(
    BOX_GRID_MAX_CELLS_PER_AXIS,
    Math.max(1, Math.floor(gridSpanY * invCell) + 1)
  );
  const numCells = cols * rows;

  const coarseInvCellX = gridSpanX > 1e-6 ? COARSE_GRID_SIDE / gridSpanX : 1;
  const coarseInvCellY = gridSpanY > 1e-6 ? COARSE_GRID_SIDE / gridSpanY : 1;

  if (sharedBoxX0.length < count) {
    const cap = Math.max(count, sharedBoxX0.length * 2, 1024);
    sharedBoxX0 = new Int16Array(cap);
    sharedBoxX1 = new Int16Array(cap);
    sharedBoxY0 = new Int16Array(cap);
    sharedBoxY1 = new Int16Array(cap);
  }
  const boxX0 = sharedBoxX0;
  const boxX1 = sharedBoxX1;
  const boxY0 = sharedBoxY0;
  const boxY1 = sharedBoxY1;

  const boxAabb6 = new Float64Array(count * 6);
  const cellStart = new Int32Array(numCells + 1);
  const cellMinZ = new Float32Array(numCells);
  const cellMaxZ = new Float32Array(numCells);
  cellMinZ.fill(Infinity);
  cellMaxZ.fill(-Infinity);

  let coarseBoxCount = 0;
  let coarseCellStart: Int32Array | null = null;

  let hugeInteriorCount = 0;
  let exteriorOverflowCount = 0;
  let overflowMinX = Infinity;
  let overflowMaxX = -Infinity;
  let overflowMinY = Infinity;
  let overflowMaxY = -Infinity;
  let overflowMinZ = Infinity;
  let overflowMaxZ = -Infinity;
  let hugeMinX = Infinity;
  let hugeMaxX = -Infinity;
  let hugeMinY = Infinity;
  let hugeMaxY = -Infinity;
  let hugeMinZ = Infinity;
  let hugeMaxZ = -Infinity;
  let coarseMinX = Infinity;
  let coarseMaxX = -Infinity;
  let coarseMinY = Infinity;
  let coarseMaxY = -Infinity;
  let coarseMinZ = Infinity;
  let coarseMaxZ = -Infinity;

  // Encoding in boxX0[b]:
  //   0..511   -> Level 1 fine grid x0 (x1 in boxX1, y0 in boxY0, y1 in boxY1)
  //   1000+cx0 -> Level 2 coarse grid cx0 (cx1 in boxX1, cy0 in boxY0, cy1 in boxY1)
  //   -1       -> Level 3 huge interior / boundary-straddling box
  //   -2       -> Level 4 pure exterior outlier box
  //   -3       -> Pruned outside domainBounds
  for (let b = 0; b < count; b += 1) {
    const box = boxes[b]!;
    const aabbOff = b * 6;
    boxAabb6[aabbOff] = box.minX;
    boxAabb6[aabbOff + 1] = box.maxX;
    boxAabb6[aabbOff + 2] = box.minY;
    boxAabb6[aabbOff + 3] = box.maxY;
    boxAabb6[aabbOff + 4] = box.minZ;
    boxAabb6[aabbOff + 5] = box.maxZ;

    if (
      hasDomain &&
      (box.maxX < dMinX ||
        box.minX > dMaxX ||
        box.maxY < dMinY ||
        box.minY > dMaxY ||
        box.maxZ < dMinZ ||
        box.minZ > dMaxZ)
    ) {
      boxX0[b] = -3;
      continue;
    }

    const bx0 = hasDomain && box.minX < dMinX ? dMinX : box.minX;
    const bx1 = hasDomain && box.maxX > dMaxX ? dMaxX : box.maxX;
    const by0 = hasDomain && box.minY < dMinY ? dMinY : box.minY;
    const by1 = hasDomain && box.maxY > dMaxY ? dMaxY : box.maxY;
    const bz0 = hasDomain && box.minZ < dMinZ ? dMinZ : box.minZ;
    const bz1 = hasDomain && box.maxZ > dMaxZ ? dMaxZ : box.maxZ;

    // Pure exterior outlier completely outside the fine XY grid
    if (bx1 < gridMinX || bx0 > gridMaxX || by1 < gridMinY || by0 > gridMaxY) {
      boxX0[b] = -2;
      exteriorOverflowCount += 1;
      if (bx0 < overflowMinX) overflowMinX = bx0;
      if (bx1 > overflowMaxX) overflowMaxX = bx1;
      if (by0 < overflowMinY) overflowMinY = by0;
      if (by1 > overflowMaxY) overflowMaxY = by1;
      if (bz0 < overflowMinZ) overflowMinZ = bz0;
      if (bz1 > overflowMaxZ) overflowMaxZ = bz1;
      continue;
    }

    const fullyInsideGrid =
      bx0 >= gridMinX && bx1 <= gridMaxX && by0 >= gridMinY && by1 <= gridMaxY;
    if (fullyInsideGrid) {
      let x0 = Math.floor((bx0 - gridMinX) * invCell);
      let x1 = Math.floor((bx1 - gridMinX) * invCell);
      let y0 = Math.floor((by0 - gridMinY) * invCell);
      let y1 = Math.floor((by1 - gridMinY) * invCell);
      if (x0 < 0) x0 = 0;
      else if (x0 >= cols) x0 = cols - 1;
      if (x1 < 0) x1 = 0;
      else if (x1 >= cols) x1 = cols - 1;
      if (y0 < 0) y0 = 0;
      else if (y0 >= rows) y0 = rows - 1;
      if (y1 < 0) y1 = 0;
      else if (y1 >= rows) y1 = rows - 1;

      const fineSpanCells = (x1 - x0 + 1) * (y1 - y0 + 1);
      if (fineSpanCells <= MAX_GRID_CELLS_PER_BOX) {
        boxX0[b] = x0;
        boxX1[b] = x1;
        boxY0[b] = y0;
        boxY1[b] = y1;
        const zLoPad = bz0 - 1e-4;
        const zHiPad = bz1 + 1e-4;
        for (let gy = y0; gy <= y1; gy += 1) {
          const rowOff = gy * cols;
          for (let gx = x0; gx <= x1; gx += 1) {
            const cell = rowOff + gx;
            cellStart[cell + 1]! += 1;
            if (zLoPad < cellMinZ[cell]!) cellMinZ[cell] = zLoPad;
            if (zHiPad > cellMaxZ[cell]!) cellMaxZ[cell] = zHiPad;
          }
        }
        continue;
      }

      // Level 2 coarse 64x64 grid for medium/large rotated vehicles (> 32 fine cells)
      let cx0 = Math.floor((bx0 - gridMinX) * coarseInvCellX);
      let cx1 = Math.floor((bx1 - gridMinX) * coarseInvCellX);
      let cy0 = Math.floor((by0 - gridMinY) * coarseInvCellY);
      let cy1 = Math.floor((by1 - gridMinY) * coarseInvCellY);
      if (cx0 < 0) cx0 = 0;
      else if (cx0 >= COARSE_GRID_SIDE) cx0 = COARSE_GRID_SIDE - 1;
      if (cx1 < 0) cx1 = 0;
      else if (cx1 >= COARSE_GRID_SIDE) cx1 = COARSE_GRID_SIDE - 1;
      if (cy0 < 0) cy0 = 0;
      else if (cy0 >= COARSE_GRID_SIDE) cy0 = COARSE_GRID_SIDE - 1;
      if (cy1 < 0) cy1 = 0;
      else if (cy1 >= COARSE_GRID_SIDE) cy1 = COARSE_GRID_SIDE - 1;

      const coarseSpanCells = (cx1 - cx0 + 1) * (cy1 - cy0 + 1);
      if (coarseSpanCells <= MAX_GRID_CELLS_PER_BOX) {
        if (!coarseCellStart) {
          coarseCellStart = new Int32Array(COARSE_GRID_CELLS + 1);
        }
        boxX0[b] = 1000 + cx0;
        boxX1[b] = cx1;
        boxY0[b] = cy0;
        boxY1[b] = cy1;
        coarseBoxCount += 1;
        if (bx0 < coarseMinX) coarseMinX = bx0;
        if (bx1 > coarseMaxX) coarseMaxX = bx1;
        if (by0 < coarseMinY) coarseMinY = by0;
        if (by1 > coarseMaxY) coarseMaxY = by1;
        if (bz0 < coarseMinZ) coarseMinZ = bz0;
        if (bz1 > coarseMaxZ) coarseMaxZ = bz1;
        if (bx0 < overflowMinX) overflowMinX = bx0;
        if (bx1 > overflowMaxX) overflowMaxX = bx1;
        if (by0 < overflowMinY) overflowMinY = by0;
        if (by1 > overflowMaxY) overflowMaxY = by1;
        if (bz0 < overflowMinZ) overflowMinZ = bz0;
        if (bz1 > overflowMaxZ) overflowMaxZ = bz1;
        for (let gy = cy0; gy <= cy1; gy += 1) {
          const rowBase = gy * COARSE_GRID_SIDE + 1;
          for (let gx = cx0; gx <= cx1; gx += 1) {
            coarseCellStart[rowBase + gx]! += 1;
          }
        }
        continue;
      }
    }

    // Huge cuboid (> 32 coarse cells) or cuboid straddling the fine-grid boundary
    boxX0[b] = -1;
    hugeInteriorCount += 1;
    if (bx0 < hugeMinX) hugeMinX = bx0;
    if (bx1 > hugeMaxX) hugeMaxX = bx1;
    if (by0 < hugeMinY) hugeMinY = by0;
    if (by1 > hugeMaxY) hugeMaxY = by1;
    if (bz0 < hugeMinZ) hugeMinZ = bz0;
    if (bz1 > hugeMaxZ) hugeMaxZ = bz1;
    if (bx0 < overflowMinX) overflowMinX = bx0;
    if (bx1 > overflowMaxX) overflowMaxX = bx1;
    if (by0 < overflowMinY) overflowMinY = by0;
    if (by1 > overflowMaxY) overflowMaxY = by1;
    if (bz0 < overflowMinZ) overflowMinZ = bz0;
    if (bz1 > overflowMaxZ) overflowMaxZ = bz1;
  }

  if (sharedGridCursor.length < numCells) {
    sharedGridCursor = new Int32Array(Math.max(numCells, BOX_GRID_MAX_CELLS_PER_AXIS * 64));
  }
  const cursor = sharedGridCursor;
  cursor[0] = 0;
  for (let c = 1; c <= numCells; c += 1) {
    const sum = cellStart[c]! + cellStart[c - 1]!;
    cellStart[c] = sum;
    if (c < numCells) {
      cursor[c] = sum;
    }
  }

  let coarseCellItems = EMPTY_INT32_ARRAY;
  if (coarseCellStart) {
    sharedCoarseCursor[0] = 0;
    for (let c = 1; c <= COARSE_GRID_CELLS; c += 1) {
      const sum = coarseCellStart[c]! + coarseCellStart[c - 1]!;
      coarseCellStart[c] = sum;
      if (c < COARSE_GRID_CELLS) {
        sharedCoarseCursor[c] = sum;
      }
    }
    coarseCellItems = new Int32Array(coarseCellStart[COARSE_GRID_CELLS]!);
  }

  const cellItems = new Int32Array(cellStart[numCells]!);
  const exteriorScanLimit = hugeInteriorCount + exteriorOverflowCount;
  const totalOverflow = exteriorScanLimit + coarseBoxCount;
  const overflowBoxes = totalOverflow > 0 ? new Int32Array(totalOverflow) : EMPTY_INT32_ARRAY;
  let hugeWrite = 0;
  let extWrite = hugeInteriorCount;
  let coarseOverflowWrite = exteriorScanLimit;

  for (let b = 0; b < count; b += 1) {
    const tag = boxX0[b]!;
    if (tag >= 1000) {
      const cx0 = tag - 1000;
      const cx1 = boxX1[b]!;
      const cy0 = boxY0[b]!;
      const cy1 = boxY1[b]!;
      overflowBoxes[coarseOverflowWrite] = b;
      coarseOverflowWrite += 1;
      for (let gy = cy0; gy <= cy1; gy += 1) {
        const rowOffset = gy * COARSE_GRID_SIDE;
        for (let gx = cx0; gx <= cx1; gx += 1) {
          const cell = rowOffset + gx;
          coarseCellItems[sharedCoarseCursor[cell]!] = b;
          sharedCoarseCursor[cell]! += 1;
        }
      }
    } else if (tag >= 0) {
      const x1 = boxX1[b]!;
      const y0 = boxY0[b]!;
      const y1 = boxY1[b]!;
      for (let gy = y0; gy <= y1; gy += 1) {
        const rowOffset = gy * cols;
        for (let gx = tag; gx <= x1; gx += 1) {
          const cell = rowOffset + gx;
          cellItems[cursor[cell]!] = b;
          cursor[cell]! += 1;
        }
      }
    } else if (tag === -1) {
      overflowBoxes[hugeWrite] = b;
      hugeWrite += 1;
    } else if (tag === -2) {
      overflowBoxes[extWrite] = b;
      extWrite += 1;
    }
  }

  return {
    minX,
    maxX,
    minY,
    maxY,
    minZ,
    maxZ,
    gridMinX,
    gridMaxX,
    gridMinY,
    gridMaxY,
    invCell,
    cols,
    rows,
    cellStart,
    cellItems,
    cellMinZ,
    cellMaxZ,
    boxAabb6,
    coarseInvCellX,
    coarseInvCellY,
    coarseCellStart: coarseCellStart ?? EMPTY_COARSE_START,
    coarseCellItems,
    coarseMinX,
    coarseMaxX,
    coarseMinY,
    coarseMaxY,
    coarseMinZ,
    coarseMaxZ,
    overflowBoxes,
    hugeInteriorCount,
    exteriorScanLimit,
    overflowMinX,
    overflowMaxX,
    overflowMinY,
    overflowMaxY,
    overflowMinZ,
    overflowMaxZ,
    hugeMinX,
    hugeMaxX,
    hugeMinY,
    hugeMaxY,
    hugeMinZ,
    hugeMaxZ,
  };
}

function isPointInsideOrientedBox(
  aabb6: Float64Array,
  boxes: readonly OrientedBoxBounds[],
  b: number,
  px: number,
  py: number,
  pz: number
): boolean {
  const off = b * 6;
  if (
    px < aabb6[off]! ||
    px > aabb6[off + 1]! ||
    py < aabb6[off + 2]! ||
    py > aabb6[off + 3]! ||
    pz < aabb6[off + 4]! ||
    pz > aabb6[off + 5]!
  ) {
    return false;
  }
  const box = boxes[b]!;
  const dx = px - box.cx;
  const dy = py - box.cy;
  const dz = pz - box.cz;
  const lx = box.r00 * dx + box.r01 * dy + box.r02 * dz;
  if (lx < -box.hx || lx > box.hx) return false;
  const ly = box.r10 * dx + box.r11 * dy + box.r12 * dz;
  if (ly < -box.hy || ly > box.hy) return false;
  const lz = box.r20 * dx + box.r21 * dy + box.r22 * dz;
  return lz >= -box.hz && lz <= box.hz;
}

/**
 * Returns the index of the single cuboid containing the point, `POINT_IN_OVERLAP` when two or
 * more cuboids contain it, or `POINT_OUTSIDE_BOXES`.
 */
export function classifyPointInBoxes(
  index: BoxSpatialIndex,
  boxes: readonly OrientedBoxBounds[],
  px: number,
  py: number,
  pz: number
): number {
  if (!(
    px >= index.minX &&
    px <= index.maxX &&
    py >= index.minY &&
    py <= index.maxY &&
    pz >= index.minZ &&
    pz <= index.maxZ
  )) {
    return POINT_OUTSIDE_BOXES;
  }

  const aabb6 = index.boxAabb6;
  let matched = POINT_OUTSIDE_BOXES;

  if (
    px >= index.gridMinX &&
    px <= index.gridMaxX &&
    py >= index.gridMinY &&
    py <= index.gridMaxY
  ) {
    let gx = ((px - index.gridMinX) * index.invCell) | 0;
    let gy = ((py - index.gridMinY) * index.invCell) | 0;
    if (gx < 0) gx = 0;
    else if (gx >= index.cols) gx = index.cols - 1;
    if (gy < 0) gy = 0;
    else if (gy >= index.rows) gy = index.rows - 1;

    const cell = gy * index.cols + gx;
    if (pz >= index.cellMinZ[cell]! && pz <= index.cellMaxZ[cell]!) {
      const end = index.cellStart[cell + 1]!;
      for (let k = index.cellStart[cell]!; k < end; k += 1) {
        const b = index.cellItems[k]!;
        if (isPointInsideOrientedBox(aabb6, boxes, b, px, py, pz)) {
          if (matched !== POINT_OUTSIDE_BOXES) return POINT_IN_OVERLAP;
          matched = b;
        }
      }
    }

    if (
      index.coarseCellItems.length > 0 &&
      px >= index.coarseMinX &&
      px <= index.coarseMaxX &&
      py >= index.coarseMinY &&
      py <= index.coarseMaxY &&
      pz >= index.coarseMinZ &&
      pz <= index.coarseMaxZ
    ) {
      let cgx = ((px - index.gridMinX) * index.coarseInvCellX) | 0;
      let cgy = ((py - index.gridMinY) * index.coarseInvCellY) | 0;
      if (cgx < 0) cgx = 0;
      else if (cgx >= COARSE_GRID_SIDE) cgx = COARSE_GRID_SIDE - 1;
      if (cgy < 0) cgy = 0;
      else if (cgy >= COARSE_GRID_SIDE) cgy = COARSE_GRID_SIDE - 1;

      const cCell = cgy * COARSE_GRID_SIDE + cgx;
      const cEnd = index.coarseCellStart[cCell + 1]!;
      for (let k = index.coarseCellStart[cCell]!; k < cEnd; k += 1) {
        const b = index.coarseCellItems[k]!;
        if (isPointInsideOrientedBox(aabb6, boxes, b, px, py, pz)) {
          if (matched !== POINT_OUTSIDE_BOXES) return POINT_IN_OVERLAP;
          matched = b;
        }
      }
    }

    const hugeCount = index.hugeInteriorCount;
    if (
      hugeCount > 0 &&
      px >= index.hugeMinX &&
      px <= index.hugeMaxX &&
      py >= index.hugeMinY &&
      py <= index.hugeMaxY &&
      pz >= index.hugeMinZ &&
      pz <= index.hugeMaxZ
    ) {
      const overflow = index.overflowBoxes;
      for (let k = 0; k < hugeCount; k += 1) {
        const b = overflow[k]!;
        if (isPointInsideOrientedBox(aabb6, boxes, b, px, py, pz)) {
          if (matched !== POINT_OUTSIDE_BOXES) return POINT_IN_OVERLAP;
          matched = b;
        }
      }
    }
    return matched;
  }

  const extLimit = index.exteriorScanLimit;
  if (
    extLimit > 0 &&
    px >= index.overflowMinX &&
    px <= index.overflowMaxX &&
    py >= index.overflowMinY &&
    py <= index.overflowMaxY &&
    pz >= index.overflowMinZ &&
    pz <= index.overflowMaxZ
  ) {
    const overflow = index.overflowBoxes;
    for (let k = 0; k < extLimit; k += 1) {
      const b = overflow[k]!;
      if (isPointInsideOrientedBox(aabb6, boxes, b, px, py, pz)) {
        if (matched !== POINT_OUTSIDE_BOXES) return POINT_IN_OVERLAP;
        matched = b;
      }
    }
  }
  return matched;
}

interface CachedScenePointsEntry {
  readonly childrenRef: readonly ThreeObject3DLike[];
  readonly directIndices: number[] | null;
  readonly subtreeParents: (object | null)[] | null;
  readonly subtreeRootIndex: number;
  readonly subtreeRootNode: ThreeObject3DLike | null;
  readonly points: ThreeObject3DLike[];
}

const scenePointsCache = new WeakMap<ThreeSceneLike, CachedScenePointsEntry>();

function isPointsSceneNode(node: ThreeObject3DLike): boolean {
  return (
    node.type === 'Points' ||
    Boolean(node.geometry?.attributes?.position && node.material && 'size' in node.material)
  );
}

function shouldSkipPointsTraversalSubtree(node: ThreeObject3DLike): boolean {
  const t = node.type;
  if (t === 'Mesh' || t === 'LineSegments' || t === 'ArrowHelper' || t === 'Line') {
    return true;
  }
  return isNumericClientIdName(node.name);
}

function invalidateScenePointsCache(scene?: ThreeSceneLike | null): void {
  if (scene && typeof scene === 'object') {
    scenePointsCache.delete(scene);
  }
}

function seedScenePointsCacheFromRender(
  scene: ThreeSceneLike | undefined,
  ptsObj: ThreeObject3DLike
): void {
  if (!scene || typeof scene !== 'object' || scenePointsCache.has(scene)) {
    return;
  }
  const children = scene.children;
  if (!Array.isArray(children) || children.length === 0) {
    return;
  }
  const headLimit = Math.min(children.length, 8);
  for (let i = 0; i < headLimit; i += 1) {
    if (children[i] === ptsObj) {
      scenePointsCache.set(scene, {
        childrenRef: children,
        directIndices: [i],
        subtreeParents: null,
        subtreeRootIndex: -1,
        subtreeRootNode: null,
        points: [ptsObj],
      });
      return;
    }
  }
  const tailStart = Math.max(headLimit, children.length - 4);
  for (let i = tailStart; i < children.length; i += 1) {
    if (children[i] === ptsObj) {
      scenePointsCache.set(scene, {
        childrenRef: children,
        directIndices: [i],
        subtreeParents: null,
        subtreeRootIndex: -1,
        subtreeRootNode: null,
        points: [ptsObj],
      });
      return;
    }
  }
}

function isCachedScenePointsValid(scene: ThreeSceneLike, cached: CachedScenePointsEntry): boolean {
  const children = scene.children;
  if (cached.childrenRef !== children || cached.points.length === 0) {
    return false;
  }
  if (cached.directIndices !== null) {
    const pts = cached.points;
    const indices = cached.directIndices;
    for (let i = 0; i < pts.length; i += 1) {
      const pt = pts[i]!;
      const parent = (pt as { parent?: unknown }).parent;
      if (parent !== undefined && parent !== scene) {
        return false;
      }
      const idx = indices[i]!;
      if (children[idx] === pt) {
        continue;
      }
      // Constant-time re-anchor check at head/tail in case cuboids were removed before/after Points
      let relocated = -1;
      const headLimit = Math.min(children.length, 6);
      for (let j = 0; j < headLimit; j += 1) {
        if (children[j] === pt) {
          relocated = j;
          break;
        }
      }
      if (relocated === -1) {
        const tailStart = Math.max(headLimit, children.length - 4);
        for (let j = tailStart; j < children.length; j += 1) {
          if (children[j] === pt) {
            relocated = j;
            break;
          }
        }
      }
      if (relocated === -1) {
        return false;
      }
      indices[i] = relocated;
    }
    return true;
  }

  if (
    cached.subtreeParents !== null &&
    cached.subtreeRootNode !== null &&
    children[cached.subtreeRootIndex] === cached.subtreeRootNode
  ) {
    for (let i = 0; i < cached.points.length; i += 1) {
      const pt = cached.points[i]!;
      const expectedParent = cached.subtreeParents[i];
      if (!expectedParent || (pt as { parent?: unknown }).parent !== expectedParent) {
        return false;
      }
    }
    return true;
  }

  return false;
}

/**
 * Finds all `THREE.Points` instances inside a view's `THREE.Scene` in O(1) on cache hits,
 * and skips all CVAT cuboid subtrees (`Mesh`/`LineSegments`/`ArrowHelper`/`Line` and numeric
 * `clientID` object names) with zero `.children` reads on initial discovery.
 */
export function findPointsObjectsInScene(scene?: ThreeSceneLike): ThreeObject3DLike[] {
  if (!scene || !Array.isArray(scene.children)) {
    return [];
  }
  const cached = scenePointsCache.get(scene);
  if (cached && isCachedScenePointsValid(scene, cached)) {
    return cached.points;
  }

  const topChildren = scene.children;
  const topLen = topChildren.length;
  if (topLen === 0) {
    return [];
  }

  const found: ThreeObject3DLike[] = [];
  const directIndices: number[] = [];
  const candidateContainers: { index: number; node: ThreeObject3DLike }[] = [];

  // Pass 1: inspect direct children of scene without touching `.children` on any cuboid/mesh
  for (let i = 0; i < topLen; i += 1) {
    const child = topChildren[i];
    if (!child) continue;
    if (isPointsSceneNode(child)) {
      found.push(child);
      directIndices.push(i);
      continue;
    }
    if (!shouldSkipPointsTraversalSubtree(child)) {
      candidateContainers.push({ index: i, node: child });
    }
  }

  let foundInSubtree = false;
  let subtreeRootIndex = -1;
  let subtreeRootNode: ThreeObject3DLike | null = null;
  const subtreeParents: (object | null)[] = [];

  if (candidateContainers.length > 0) {
    const stack: ThreeObject3DLike[] = [];
    for (let c = 0; c < candidateContainers.length; c += 1) {
      const entry = candidateContainers[c]!;
      const rootSubChildren = entry.node.children;
      if (!Array.isArray(rootSubChildren) || rootSubChildren.length === 0) {
        continue;
      }
      for (let k = rootSubChildren.length - 1; k >= 0; k -= 1) {
        const sub = rootSubChildren[k];
        if (sub) stack.push(sub);
      }
      while (stack.length > 0) {
        const current = stack.pop()!;
        if (isPointsSceneNode(current)) {
          found.push(current);
          foundInSubtree = true;
          subtreeRootIndex = entry.index;
          subtreeRootNode = entry.node;
          const parentRef = (current as { parent?: unknown }).parent;
          subtreeParents.push(
            parentRef && typeof parentRef === 'object' ? (parentRef as object) : null
          );
          continue;
        }
        if (shouldSkipPointsTraversalSubtree(current)) {
          continue;
        }
        const kids = current.children;
        if (Array.isArray(kids)) {
          for (let k = kids.length - 1; k >= 0; k -= 1) {
            const kid = kids[k];
            if (kid) stack.push(kid);
          }
        }
      }
    }
  }

  if (found.length > 0) {
    if (!foundInSubtree) {
      scenePointsCache.set(scene, {
        childrenRef: topChildren,
        directIndices,
        subtreeParents: null,
        subtreeRootIndex: -1,
        subtreeRootNode: null,
        points: found,
      });
    } else if (
      candidateContainers.length === 1 &&
      subtreeParents.length === found.length &&
      subtreeParents.every((p) => p !== null)
    ) {
      scenePointsCache.set(scene, {
        childrenRef: topChildren,
        directIndices: null,
        subtreeParents,
        subtreeRootIndex,
        subtreeRootNode,
        points: found,
      });
    }
  }

  return found;
}

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

const originalGeometryPositionsMap = new WeakMap<object, Float32Array>();
const pointCloudBoundsCache = new WeakMap<
  object,
  { readonly len: number; readonly bounds: BoxSpatialBounds | null }
>();
const groundElevationGridCache = new WeakMap<
  object,
  { readonly len: number; readonly egoGroundZ: number; readonly cellMinZ: Float32Array }
>();

function getOrComputePointCloudBounds(
  srcPositions: Float32Array | number[],
  len: number
): BoxSpatialBounds | null {
  if (len < 3) {
    return null;
  }
  const cached = pointCloudBoundsCache.get(srcPositions);
  if (cached && cached.len === len) {
    return cached.bounds;
  }

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;

  for (let i = 0; i < len; i += 3) {
    const px = srcPositions[i]!;
    const py = srcPositions[i + 1]!;
    const pz = srcPositions[i + 2]!;
    if (px < minX) minX = px;
    if (px > maxX) maxX = px;
    if (py < minY) minY = py;
    if (py > maxY) maxY = py;
    if (pz < minZ) minZ = pz;
    if (pz > maxZ) maxZ = pz;
  }

  const bounds: BoxSpatialBounds | null =
    minX <= maxX &&
    minY <= maxY &&
    minZ <= maxZ &&
    Number.isFinite(minX) &&
    Number.isFinite(maxX) &&
    Number.isFinite(minY) &&
    Number.isFinite(maxY) &&
    Number.isFinite(minZ) &&
    Number.isFinite(maxZ)
      ? { minX, maxX, minY, maxY, minZ, maxZ }
      : null;

  pointCloudBoundsCache.set(srcPositions, { len, bounds });
  return bounds;
}

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
const GROUND_HALF_SPAN = GROUND_GRID_SIDE * GROUND_CELL_SIZE * 0.5; // 96m
const sharedGroundCellMinZ = new Float32Array(GROUND_GRID_SIDE * GROUND_GRID_SIDE);
const sharedEgoHistogram = new Int32Array(40);

/**
 * Ultra-fast 2-pass local ground elevation estimator (`< 1.2ms` for 120,000 points), memoized per
 * `srcPositions` buffer so repeated box filter changes on the same frame never recompute ground elevation.
 */
function populateGroundElevationGrid(
  srcPositions: Float32Array | number[],
  len: number
): { egoGroundZ: number; cellMinZ: Float32Array } {
  const cached = groundElevationGridCache.get(srcPositions);
  if (cached && cached.len === len) {
    return cached;
  }

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

  const stored = {
    len,
    egoGroundZ,
    cellMinZ: new Float32Array(sharedGroundCellMinZ),
  };
  groundElevationGridCache.set(srcPositions, stored);
  return stored;
}

/**
 * Stateful, dirty-flagged pre-render enhancer for CVAT's `Canvas3dViewImpl`.
 * Guarantees that point cloud buffer coloring, background changes, and scattering material
 * updates execute AT MOST ONCE per frame/state change rather than every 60fps render tick.
 */
const CUBOID_INITIALIZED_SYM = Symbol.for('meowCuboidInitialized');

interface InitializableCuboid {
  [CUBOID_INITIALIZED_SYM]?: boolean;
}

export class Cvat3dPreRenderEnhancer {
  private options: Cvat3dWorkspaceRenderOptions;
  private readonly baseColorsCache = new WeakMap<object, Float32Array>();
  private readonly modifiedGeometries = new WeakSet<object>();
  private readonly compactedGeometries = new WeakSet<object>();
  private readonly topGeometryCopies = new WeakMap<
    object,
    NonNullable<ThreeObject3DLike['geometry']>
  >();
  private readonly topGeometrySources = new WeakMap<
    object,
    NonNullable<ThreeObject3DLike['geometry']>
  >();
  private readonly sceneViewRoles = new WeakMap<object, boolean>();
  private readonly topCameras = new WeakSet<object>();
  private readonly canvasTopRoleCache = new WeakMap<HTMLCanvasElement, boolean>();
  private readonly hookedViews = new WeakSet<object>();
  private readonly hookedPrototypes = new WeakSet<object>();
  private readonly hookedPointObjects = new WeakSet<object>();
  private readonly primaryPerspectiveMaterials = new WeakSet<object>();
  private readonly initializedMaterials = new WeakSet<object>();
  private readonly optimizedPlaneMeshes = new WeakSet<object>();
  private readonly scenePlaneCheckCount = new WeakMap<object, number>();
  private readonly geometryEpochMap = new WeakMap<object, number>();
  private readonly appliedSceneColors = new WeakMap<ThreeColorLike, boolean>();
  private readonly appliedViewBackground = new WeakMap<object, boolean>();
  private readonly sceneRenderContext = new Map<
    ThreeSceneLike,
    {
      renderer: NonNullable<CvatRenderViewLike['renderer']>;
      camera: unknown;
      wasConnected: boolean;
    }
  >();
  private primaryPerspectiveScene: ThreeSceneLike | null = null;
  private primaryPerspectiveCanvas: HTMLCanvasElement | null = null;
  private activeView: CvatInternalViewLike | null = null;
  private activeModel: CvatInternalCanvas3dLike['model'] | null = null;
  private lastCompiledBoxes: OrientedBoxBounds[] = [];
  private lastExecutionSignature = '';
  private lastGeometryColorSignature = '';
  private geometryColorEpoch = 0;
  private lastViewCount = 0;
  private dirty = true;
  private pendingFrameObjectsLoad = true;
  private needsIncrementalCuboidSync = false;
  private pendingVisibilityToken: string | null = null;
  private pendingVisibilityObjectsRef: object | null = null;
  private isRedrawingViews = false;
  private isApplying = false;
  private nativeNotifyDepth = 0;
  private lastObjectIds = '';

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
    this.options = {
      ...DEFAULT_CVAT_3D_RENDER_OPTIONS,
      ...initialOptions,
      ...normalizeWorkspaceFeatureOptions({ ...initialOptions }),
      hideGroundPoints: Boolean(initialOptions.hideGroundPoints),
      fixedOrthoPointSize: initialOptions.fixedOrthoPointSize ?? true,
      followActiveObject: initialOptions.followActiveObject ?? true,
      enableActiveObjectWarnings: initialOptions.enableActiveObjectWarnings ?? true,
    };
  }

  public getOptions(): Cvat3dWorkspaceRenderOptions {
    return { ...this.options };
  }

  public getOptionsReadonly(): Readonly<Cvat3dWorkspaceRenderOptions> {
    return this.options;
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
      nextOrthoFixed !== prevOrthoFixed ||
      (next.enlargePerspectivePoints ?? true) !== (this.options.enlargePerspectivePoints ?? true);

    this.options = {
      ...next,
      ...normalizeWorkspaceFeatureOptions({ ...next }),
      hideGroundPoints: nextHideGround,
      fixedOrthoPointSize: nextOrthoFixed,
      followActiveObject: next.followActiveObject ?? true,
      enableActiveObjectWarnings: next.enableActiveObjectWarnings ?? true,
    };
    if (changed) {
      this.dirty = true;
      this.pendingFrameObjectsLoad = true;
      this.pendingVisibilityToken = null;
      this.pendingVisibilityObjectsRef = null;
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
  private syncSceneColor(scene: ThreeSceneLike | undefined): void {
    const color = scene?.background;
    if (!color || typeof color.set !== 'function') return;
    const channel = this.options.whiteBackground ? 1 : 0;
    if (
      this.appliedSceneColors.get(color) === this.options.whiteBackground &&
      color.r === channel &&
      color.g === channel &&
      color.b === channel
    )
      return;
    color.set(this.options.whiteBackground ? 0xffffff : 0x000000);
    this.appliedSceneColors.set(color, this.options.whiteBackground);
  }

  public applySceneBackgrounds(view: CvatInternalViewLike): void {
    const views = view.views;
    if (!views) {
      return;
    }
    if (!this.dirty && this.appliedViewBackground.get(view) === this.options.whiteBackground) {
      return;
    }

    const targetBgHex = this.options.whiteBackground ? 0xffffff : 0x000000;
    const targetBgCss = this.options.whiteBackground ? '#ffffff' : '#000000';

    for (const key in views) {
      if (!Object.hasOwn(views, key)) continue;
      const rv = views[key];
      if (!rv) continue;
      if (rv.scene) {
        this.ensureThreePrototypesHooked(rv.scene);
      }
      this.syncSceneColor(rv.scene);
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
   * - Fixed 3.5px point size (`size = 3.5, sizeAttenuation = false`)
   * - White/black scene & renderer background
   * - Per-cuboid point cloud colors
   * even if the zoom canvas creates its own `WebGLRenderer`, `Scene`, `Points`, or `PointsMaterial`.
   */
  private ensureThreePrototypesHooked(
    perspectiveScene?: ThreeSceneLike,
    samplePoints?: ThreeObject3DLike
  ): void {
    if (perspectiveScene && typeof perspectiveScene === 'object') {
      const sceneProto = Object.getPrototypeOf(perspectiveScene) as {
        onBeforeRender?: (...args: unknown[]) => void;
      } | null;
      if (sceneProto && sceneProto !== Object.prototype && !this.hookedPrototypes.has(sceneProto)) {
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
          const targetBgRgb = this.options.whiteBackground ? 'rgb(255, 255, 255)' : 'rgb(0, 0, 0)';
          const sceneObj = scene as ThreeSceneLike | undefined;
          this.syncSceneColor(sceneObj);
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
            // Remember (renderer, camera) per scene so option toggles can force an immediate redraw
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
      const pointsProto = Object.getPrototypeOf(samplePoints) as {
        onBeforeRender?: (...args: unknown[]) => void;
      } | null;
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

  private isTopView(
    scene?: unknown,
    renderer?: CvatRenderViewLike['renderer'],
    camera?: unknown
  ): boolean {
    if (scene && typeof scene === 'object') {
      const role = this.sceneViewRoles.get(scene);
      if (role !== undefined) {
        return role;
      }
    }
    if (camera && typeof camera === 'object' && this.topCameras.has(camera)) {
      return true;
    }
    const canvas = renderer?.domElement;
    if (canvas) {
      const cachedRole = this.canvasTopRoleCache.get(canvas);
      if (cachedRole !== undefined) {
        return cachedRole;
      }
      if (canvas.closest?.('.cvat-canvas3d-topview')) {
        this.canvasTopRoleCache.set(canvas, true);
        return true;
      }
      if (
        canvas.closest?.(
          '.cvat-canvas3d-perspective, .cvat-canvas3d-sideview, .cvat-canvas3d-frontview'
        )
      ) {
        this.canvasTopRoleCache.set(canvas, false);
        return false;
      }
    }
    return false;
  }

  /** Give Top a private geometry so compaction cannot change any other viewport. */
  private preparePointGeometry(points: ThreeObject3DLike, isTop: boolean): void {
    const source = points.geometry;
    if (!source) return;
    const original = this.topGeometrySources.get(source);
    if (!isTop) {
      if (original) points.geometry = original;
      return;
    }
    if (!this.options.hideGroundPoints || original) return;
    let copy = this.topGeometryCopies.get(source);
    if (!copy) {
      if (typeof source.clone === 'function') {
        copy = source.clone();
      } else {
        const cloneAttribute = (
          attribute?: ThreeBufferAttributeLike
        ): ThreeBufferAttributeLike | undefined =>
          attribute ? { ...attribute, array: attribute.array.slice() } : undefined;
        copy = {
          ...source,
          attributes: {
            ...source.attributes,
            position: cloneAttribute(source.attributes?.position),
            color: cloneAttribute(source.attributes?.color),
          },
          drawRange: source.drawRange ? { ...source.drawRange } : undefined,
          setDrawRange(start, count) {
            this.drawRange = { start, count };
          },
        };
      }
      this.topGeometryCopies.set(source, copy);
      this.topGeometrySources.set(copy, source);
      // A newly expanded Top may clone an already-colored main view. Keep its original
      // intensity colors as the restore baseline instead of caching the recolored values.
      const originalColor = source.attributes?.color;
      const copyColor = copy.attributes?.color;
      const baseColor = originalColor ? this.baseColorsCache.get(originalColor) : undefined;
      if (copyColor && baseColor) this.baseColorsCache.set(copyColor, baseColor);

      // Share the immutable source position Float32Array as the un-compacted baseline so
      // Perspective and Top share `pcBounds`, `BoxSpatialIndex`, `pointHits`, and `groundGrid`!
      const sourcePosAttr = source.attributes?.position;
      const copyPosAttr = copy.attributes?.position;
      const sourceOrigPos = sourcePosAttr
        ? (originalGeometryPositionsMap.get(sourcePosAttr) ??
          (!this.compactedGeometries.has(source) && sourcePosAttr.array instanceof Float32Array
            ? sourcePosAttr.array
            : undefined))
        : undefined;
      if (copyPosAttr && sourceOrigPos) {
        originalGeometryPositionsMap.set(copyPosAttr, sourceOrigPos);
        originalGeometryPositionsMap.set(copy, sourceOrigPos);
      }
    }
    points.geometry = copy;
  }

  private handlePointsBeforeRender(
    ptsObj: ThreeObject3DLike,
    renderer?: unknown,
    scene?: unknown,
    camera?: unknown,
    materialArg?: unknown
  ): void {
    seedScenePointsCacheFromRender(scene as ThreeSceneLike | undefined, ptsObj);

    const camObj = camera as
      { isOrthographicCamera?: boolean; isPerspectiveCamera?: boolean; type?: string } | undefined;
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

    const isTop = this.isTopView(scene, renObj, camera);
    if (isTop && camera && typeof camera === 'object') this.topCameras.add(camera);
    this.preparePointGeometry(ptsObj, isTop);
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

    if (ptsObj.geometry && this.geometryColorEpoch > 0) {
      const targetStamp =
        this.geometryColorEpoch * 2 + (isTop && this.options.hideGroundPoints ? 1 : 0);
      if (this.geometryEpochMap.get(ptsObj.geometry) !== targetStamp) {
        this.geometryEpochMap.set(ptsObj.geometry, targetStamp);
        this.applyPointCloudBoxColors(ptsObj, this.lastCompiledBoxes, isTop);
      }
    }
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

    // Always ensure background is synced immediately even before PCD finishes loading
    this.applySceneBackgrounds(view);

    if (this.hookedViews.has(view)) {
      let currentViewCount = 0;
      if (view.views) {
        for (const k in view.views) {
          if (Object.hasOwn(view.views, k)) currentViewCount += 1;
        }
      }
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
        if (view.views) {
          for (const k in view.views) {
            if (Object.hasOwn(view.views, k)) {
              const scn = view.views[k]?.scene;
              invalidateScenePointsCache(scn);
              seedScenePointsCacheFromRender(scn, points);
            }
          }
        }
        this.dirty = true;
        this.pendingFrameObjectsLoad = true;
        this.pendingVisibilityToken = null;
        this.pendingVisibilityObjectsRef = null;
        // Native code updates frame objects immediately after this callback.
        // Let objects_updated / the next render process the completed frame once.
      };
    }

    if (typeof view.notify === 'function') {
      const origNotify = view.notify.bind(view);
      view.notify = (model: unknown, reason: string): void => {
        // Let CVAT finish replacing the image and annotations before processing points.
        // Native notify can render synchronously or emit nested objects_updated events.
        if (reason === 'image_changed') {
          this.pendingFrameObjectsLoad = true;
          this.pendingVisibilityToken = null;
          this.pendingVisibilityObjectsRef = null;
        }
        this.nativeNotifyDepth += 1;
        try {
          origNotify(model, reason);
        } finally {
          this.nativeNotifyDepth -= 1;
        }
        if (reason === 'objects_updated') {
          if (!this.options.colorPointsByCuboid && !this.options.hideGroundPoints) {
            // O(1) fast-path when point coloring & ground hiding are off: box visibility cannot affect points
            if (this.pendingFrameObjectsLoad) {
              this.dirty = true;
            } else {
              this.needsIncrementalCuboidSync = true;
            }
          } else {
            const objectIds = computeDrawnObjectsVisibilityToken(view.drawnObjects);
            this.pendingVisibilityToken = objectIds;
            this.pendingVisibilityObjectsRef = view.drawnObjects ?? null;
            if (this.pendingFrameObjectsLoad || objectIds !== this.lastObjectIds) {
              this.markDirty();
            } else {
              this.needsIncrementalCuboidSync = true;
            }
          }
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
    if (!view.views || this.isApplying || this.nativeNotifyDepth > 0) {
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

      // Each view's scene can contain 100k+ cuboid descendants. Reuse the O(1)-cached
      // point-object discovery for this pass without traversing cuboid subtrees.
      const pointLists = new Map<ThreeSceneLike, ThreeObject3DLike[]>();
      const pointsForScene = (scene?: ThreeSceneLike): ThreeObject3DLike[] => {
        if (!scene) return [];
        let points = pointLists.get(scene);
        if (!points) {
          points = findPointsObjectsInScene(scene);
          pointLists.set(scene, points);
        }
        return points;
      };
      const perspectivePoints = pointsForScene(perspectiveScene);
      if (perspectivePoints.length === 0) {
        // Scene point cloud not yet populated for this frame; keep dirty=true so point coloring runs on PCD load
        return false;
      }

      this.ensureThreePrototypesHooked(perspectiveScene, perspectivePoints[0]);

      const drawnObjects = view.drawnObjects ?? {};
      this.syncDrawnCuboidsIncremental(drawnObjects);

      const hideGround = Boolean(this.options.hideGroundPoints);
      let objectIds: string;
      if (!this.options.colorPointsByCuboid && !hideGround) {
        objectIds = 'off';
      } else if (
        this.pendingVisibilityToken !== null &&
        this.pendingVisibilityObjectsRef === (view.drawnObjects ?? null)
      ) {
        objectIds = this.pendingVisibilityToken;
      } else {
        objectIds = computeDrawnObjectsVisibilityToken(drawnObjects);
      }
      this.pendingVisibilityToken = null;
      this.pendingVisibilityObjectsRef = null;

      const viewEntries = Object.entries(view.views);
      this.lastViewCount = viewEntries.length;
      let totalPointsObjects = 0;
      for (let v = 0; v < viewEntries.length; v += 1) {
        const rv = viewEntries[v]![1];
        if (rv?.scene) {
          totalPointsObjects += pointsForScene(rv.scene).length;
        }
      }

      const domFrameAttr =
        view.views.perspective?.renderer?.domElement?.getAttribute?.('data-frame-number') ?? null;
      const frameId = model?.data?.imageID ?? domFrameAttr ?? 'unknown';
      const orthoFixed = this.options.fixedOrthoPointSize ?? true;
      const geometryColorSignature = `${String(frameId)}::${this.options.whiteBackground ? 1 : 0}:${this.options.enableScattering ? 1 : 0}:${this.options.colorPointsByCuboid ? 1 : 0}:${hideGround ? 1 : 0}::objects:${objectIds}`;
      const currentSignature = `${geometryColorSignature}:${orthoFixed ? 1 : 0}::v${viewEntries.length}:p${totalPointsObjects}`;

      if (!this.dirty && currentSignature === this.lastExecutionSignature) {
        return false;
      }

      const shouldRecompileBoxSnapshots =
        this.pendingFrameObjectsLoad || geometryColorSignature !== this.lastGeometryColorSignature;
      if (shouldRecompileBoxSnapshots || this.geometryColorEpoch === 0) {
        this.geometryColorEpoch += 1;
      }

      this.lastExecutionSignature = currentSignature;
      this.lastGeometryColorSignature = geometryColorSignature;
      this.dirty = false;
      this.pendingFrameObjectsLoad = false;
      if (this.options.colorPointsByCuboid || hideGround) {
        this.lastObjectIds = objectIds;
      }

      for (let v = 0; v < viewEntries.length; v += 1) {
        const [key, rv] = viewEntries[v]!;
        if (!rv) continue;

        if (rv.scene) {
          optimizeOrthographicRaycastPlanes(rv.scene, this.optimizedPlaneMeshes);
        }
        if (
          rv.scene &&
          (key === 'perspective' || key === 'top' || key === 'side' || key === 'front')
        ) {
          this.sceneViewRoles.set(rv.scene, key === 'top');
        }
        const isTop = key === 'top' || this.isTopView(rv.scene, rv.renderer);
        const viewCamera = (rv as { camera?: unknown }).camera;
        if (isTop && viewCamera && typeof viewCamera === 'object') this.topCameras.add(viewCamera);
        const isPerspective = key === 'perspective';
        const pointsList = pointsForScene(rv.scene);
        for (let p = 0; p < pointsList.length; p += 1) {
          const ptsObj = pointsList[p]!;
          this.preparePointGeometry(ptsObj, isTop);
          this.bindInstanceBeforeRenderHook(ptsObj);
          this.applyScatteringToMaterial(ptsObj, isPerspective);
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

      for (let v = 0; v < viewEntries.length; v += 1) {
        const [key, rv] = viewEntries[v]!;
        const isTop = key === 'top' || this.isTopView(rv?.scene, rv?.renderer);
        const targetStamp = this.geometryColorEpoch * 2 + (isTop && hideGround ? 1 : 0);
        const pointsList = pointsForScene(rv?.scene);
        for (let p = 0; p < pointsList.length; p += 1) {
          const ptsObj = pointsList[p]!;
          if (ptsObj.geometry && !processedGeometries.has(ptsObj.geometry)) {
            processedGeometries.add(ptsObj.geometry);
            if (
              shouldRecompileBoxSnapshots ||
              this.geometryEpochMap.get(ptsObj.geometry) !== targetStamp
            ) {
              this.geometryEpochMap.set(ptsObj.geometry, targetStamp);
              this.applyPointCloudBoxColors(ptsObj, compiledBoxes, isTop);
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
      // give the orthographic/zoom Points object its own material to preserve its 3.5px size.
      mat = mat.clone();
      ptsObj.material = mat;
    }

    const useFixedOrtho35px = this.options.fixedOrthoPointSize ?? true;
    // Keep CVAT perspective zoom attenuation; enlarge its native 0.05 size by 20%.
    const targetSize = isPerspective
      ? 0.05 * ((this.options.enlargePerspectivePoints ?? true) ? 1.2 : 1)
      : useFixedOrtho35px
        ? 3.5
        : 0.5;
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

  private boxIndexSource: readonly OrientedBoxBounds[] | null = null;
  private boxIndexDomain: BoxSpatialBounds | null = null;
  private boxIndexCache: BoxSpatialIndex | null = null;
  private sharedPointHitsBuffer = new Int32Array(0);
  private lastPointHitsPositions: Float32Array | number[] | null = null;
  private lastPointHitsBoxIndex: BoxSpatialIndex | null = null;
  private lastPointHitsCount = 0;

  /** Build the grid once per compiled box snapshot + LiDAR domain bounds; all views reuse it. */
  private getBoxSpatialIndex(
    boxes: readonly OrientedBoxBounds[],
    domainBounds?: BoxSpatialBounds | null
  ): BoxSpatialIndex | null {
    const normalizedDomain = domainBounds ?? null;
    const sameDomain =
      this.boxIndexDomain === normalizedDomain ||
      Boolean(
        this.boxIndexDomain &&
        normalizedDomain &&
        this.boxIndexDomain.minX === normalizedDomain.minX &&
        this.boxIndexDomain.maxX === normalizedDomain.maxX &&
        this.boxIndexDomain.minY === normalizedDomain.minY &&
        this.boxIndexDomain.maxY === normalizedDomain.maxY &&
        this.boxIndexDomain.minZ === normalizedDomain.minZ &&
        this.boxIndexDomain.maxZ === normalizedDomain.maxZ
      );
    if (this.boxIndexSource !== boxes || !sameDomain) {
      this.boxIndexSource = boxes;
      this.boxIndexDomain = normalizedDomain;
      this.boxIndexCache = buildBoxSpatialIndex(boxes, normalizedDomain);
    }
    return this.boxIndexCache;
  }

  private applyPointCloudBoxColors(
    ptsObj: ThreeObject3DLike,
    boxes: readonly OrientedBoxBounds[],
    isTop = false
  ): void {
    const geom = ptsObj.geometry;
    const posAttr = geom?.attributes?.position;
    const colorAttr = geom?.attributes?.color;
    if (!geom || !posAttr || !colorAttr) {
      return;
    }

    const hideGround = Boolean(this.options.hideGroundPoints) && isTop;
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
    const numPoints = Math.floor(len / 3);

    // WebGL Float32BufferAttribute (Float32Array) always expects normalized 0.0..1.0 floats;
    // only Uint8Array/Uint8ClampedArray attributes use 0..255.
    const colorScale =
      colorArray instanceof Uint8Array || colorArray instanceof Uint8ClampedArray ? 255 : 1;

    const overlapRgb = this.options.whiteBackground ? OVERLAP_RGB_WHITE_BG : OVERLAP_RGB_BLACK_BG;
    const boxCount = boxes.length;
    const solidBase = this.options.whiteBackground ? 0 : colorScale;

    // Prune distant outlier boxes outside the actual LiDAR cloud AABB and build fine spatial grid once
    const needBoxTest = (colorBoxes || hideGround) && boxCount > 0;
    const pcBounds = needBoxTest ? getOrComputePointCloudBounds(srcPositions, numPoints * 3) : null;
    const boxIndex = needBoxTest ? this.getBoxSpatialIndex(boxes, pcBounds) : null;
    const checkBoxes = boxIndex !== null;

    let hitsBuffer: Int32Array | null = null;
    let reuseCachedHits = false;
    if (checkBoxes && numPoints > 0) {
      if (
        this.lastPointHitsPositions === srcPositions &&
        this.lastPointHitsBoxIndex === boxIndex &&
        this.lastPointHitsCount === numPoints
      ) {
        hitsBuffer = this.sharedPointHitsBuffer;
        reuseCachedHits = true;
      } else {
        if (this.sharedPointHitsBuffer.length < numPoints) {
          this.sharedPointHitsBuffer = new Int32Array(numPoints);
        }
        hitsBuffer = this.sharedPointHitsBuffer;
      }
    }

    if (!hideGround) {
      // Fast non-compacting path: bulk-initialize unboxed colors with native TypedArray `.fill()` / `.set()`
      if (useSolidUnboxed) {
        if (
          colorArray instanceof Float32Array ||
          colorArray instanceof Uint8Array ||
          colorArray instanceof Uint8ClampedArray
        ) {
          colorArray.fill(solidBase);
        } else {
          for (let i = 0; i < len; i += 1) {
            colorArray[i] = solidBase;
          }
        }
      } else if (
        colorArray instanceof Float32Array &&
        colorArray.length === originalColors.length
      ) {
        colorArray.set(originalColors);
      } else {
        for (let i = 0; i < len; i += 1) {
          colorArray[i] = originalColors[i]!;
        }
      }

      if (colorBoxes && boxIndex && hitsBuffer) {
        const overlapR = overlapRgb[0] * colorScale;
        const overlapG = overlapRgb[1] * colorScale;
        const overlapB = overlapRgb[2] * colorScale;

        if (reuseCachedHits) {
          for (let ptIdx = 0, i = 0; ptIdx < numPoints; ptIdx += 1, i += 3) {
            const hit = hitsBuffer[ptIdx]!;
            if (hit === POINT_OUTSIDE_BOXES) continue;
            if (hit === POINT_IN_OVERLAP) {
              colorArray[i] = overlapR;
              colorArray[i + 1] = overlapG;
              colorArray[i + 2] = overlapB;
            } else {
              const box = boxes[hit]!;
              colorArray[i] = box.r * colorScale;
              colorArray[i + 1] = box.g * colorScale;
              colorArray[i + 2] = box.b * colorScale;
            }
          }
        } else {
          for (let ptIdx = 0, i = 0; ptIdx < numPoints; ptIdx += 1, i += 3) {
            const hit = classifyPointInBoxes(
              boxIndex,
              boxes,
              srcPositions[i] ?? 0,
              srcPositions[i + 1] ?? 0,
              srcPositions[i + 2] ?? 0
            );
            hitsBuffer[ptIdx] = hit;
            if (hit === POINT_OUTSIDE_BOXES) continue;
            if (hit === POINT_IN_OVERLAP) {
              colorArray[i] = overlapR;
              colorArray[i + 1] = overlapG;
              colorArray[i + 2] = overlapB;
            } else {
              const box = boxes[hit]!;
              colorArray[i] = box.r * colorScale;
              colorArray[i + 1] = box.g * colorScale;
              colorArray[i + 2] = box.b * colorScale;
            }
          }
          this.lastPointHitsPositions = srcPositions;
          this.lastPointHitsBoxIndex = boxIndex;
          this.lastPointHitsCount = numPoints;
        }
      }

      colorAttr.needsUpdate = true;
      return;
    }

    // Ground-hiding compaction path (`hideGroundPoints === true`)
    const { egoGroundZ, cellMinZ } = populateGroundElevationGrid(srcPositions, numPoints * 3);
    const groundThicknessTol = 0.22;
    const overlapR = overlapRgb[0] * colorScale;
    const overlapG = overlapRgb[1] * colorScale;
    const overlapB = overlapRgb[2] * colorScale;
    let writeOffset = 0;

    for (let ptIdx = 0, i = 0; ptIdx < numPoints; ptIdx += 1, i += 3) {
      const px = srcPositions[i] ?? 0;
      const py = srcPositions[i + 1] ?? 0;
      const pz = srcPositions[i + 2] ?? 0;

      let hit = POINT_OUTSIDE_BOXES;
      if (checkBoxes && hitsBuffer) {
        if (reuseCachedHits) {
          hit = hitsBuffer[ptIdx]!;
        } else {
          hit = classifyPointInBoxes(boxIndex!, boxes, px, py, pz);
          hitsBuffer[ptIdx] = hit;
        }
      }

      const isOverlapping = hit === POINT_IN_OVERLAP;
      const matchedBox: OrientedBoxBounds | null =
        hit === POINT_OUTSIDE_BOXES ? null : isOverlapping ? boxes[0]! : boxes[hit]!;

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
        colorArray[writeOffset] = overlapR;
        colorArray[writeOffset + 1] = overlapG;
        colorArray[writeOffset + 2] = overlapB;
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

    if (checkBoxes && hitsBuffer && !reuseCachedHits) {
      this.lastPointHitsPositions = srcPositions;
      this.lastPointHitsBoxIndex = boxIndex;
      this.lastPointHitsCount = numPoints;
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
      Boolean(canvas.closest?.('.cvat-canvas3d-perspective, .cvat-canvas3d-orthographic-view'));
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
    ...WORKSPACE_FEATURE_KEYS.map((key) => ((opts[key] ?? true) ? 1 : 0)),
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
      title: 'Hide ground points in Top view only (Chỉ tắt đất ở Top)',
      description:
        'Hide road and ground points only in Top; keep ground visible in main 3D, Side and Front',
    },
    {
      key: 'fixedOrthoPointSize',
      rowClass: 'cvat-workspace-settings-3d-ortho-point-size',
      title: 'Fixed 3.5px point size in Top/Side/Front views',
      description:
        'Lock point size to 3.5px in orthographic views (uncheck to follow CVAT default)',
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

export { injectCvatObjectDimensionSyncControls } from './object-dimension-controls';
