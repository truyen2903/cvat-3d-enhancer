/**
 * Orthographic (Top / Side / Front) cuboid editing helpers for the CVAT 3D workspace.
 *
 * 1. Keyboard nudge only while hovering Top / Side / Front:
 *      A / D  -> move the active cuboid left / right on screen
 *      W / S  -> move the active cuboid up / down on screen
 *      Q      -> rotate (tilt) counter-clockwise around the view axis
 *      E      -> rotate (tilt) clockwise around the view axis
 *      Shift  -> 5x coarser step
 *    While hovering a view, CVAT never receives W/A/S/D/Q/E (without Ctrl/Alt/Meta).
 *    Outside these views, these keys go back to CVAT untouched.
 *
 * 2. Edge resize in Top / Side / Front views: CVAT natively only offers corner handles.
 *    Dragging one of the 4 edges of the active cuboid resizes it along a single axis while the
 *    opposite edge stays fixed. Areas near the corners are left to CVAT's native handles.
 *
 * Movement is computed in screen space from the view's real camera, so it is always relative
 * to what the user sees regardless of how CVAT orients the orthographic cameras.
 * Cuboid points layout: [x, y, z, rx, ry, rz, sx, sy, sz, ...] (Euler order XYZ, radians).
 */

import { CVAT_DOM_SELECTORS } from '../../../shared/constants';
import type { OrthoViewName } from './ortho-view-maximizer';
import { isEditableEventTarget } from './ortho-view-maximizer';

export { isEditableEventTarget };

export type Vec3 = [number, number, number];
/** Row-major 3x3 matrix. */
export type Mat3 = [number, number, number, number, number, number, number, number, number];

export interface OrthoCameraLike {
  left?: number;
  right?: number;
  top?: number;
  bottom?: number;
  zoom?: number;
  isOrthographicCamera?: boolean;
  matrixWorld?: { elements?: ArrayLike<number> };
  updateMatrixWorld?: (force?: boolean) => void;
}

/** Plain-number snapshot of an orthographic camera (immune to camera changes mid-drag). */
export interface CameraFrame {
  readonly right: Vec3;
  readonly up: Vec3;
  readonly back: Vec3;
  readonly position: Vec3;
  /** Half extents & center of the visible frustum in camera-local units. */
  readonly halfW: number;
  readonly halfH: number;
  readonly cx: number;
  readonly cy: number;
}

export interface EdgeHit {
  /** Cuboid local axis being resized: 0 = x (length), 1 = y (width), 2 = z (height). */
  readonly axis: 0 | 1 | 2;
  /** Which side of the axis the grabbed edge is on. */
  readonly sign: 1 | -1;
  /** Screen-space (camera right/up) unit direction of that axis. */
  readonly dir2d: readonly [number, number];
  /** Length of the projected unit axis on the screen plane (1 when parallel to screen). */
  readonly projFactor: number;
}

export interface OrthoCuboidEditorContext {
  getKeyboardOptions?: () => {
    enabled?: boolean;
    highSensitivity?: boolean;
    immediateCommit?: boolean;
  };
  /** Legacy maximized state; keyboard activation now depends solely on hover. */
  getMaximizedView: () => OrthoViewName | null;
  /** Active, editable cuboid points on the current frame (null if none / locked). */
  getActivePoints: () => { clientID: number; points: number[] } | null;
  getViewCamera: (view: OrthoViewName) => OrthoCameraLike | null;
  /** Live visual update only (no persistence). */
  previewPoints: (clientID: number, points: number[]) => void;
  /** Persist points through CVAT (one undo step). */
  commitPoints: (clientID: number, points: number[]) => void;
}

const KEY_EVENT_TYPES = ['keydown', 'keyup', 'keypress'] as const;
const SUPPRESSED_KEY_EVENTS = new WeakSet<Event>();
const HOOKED_EVENT_TARGET_PROTOS = new WeakMap<object, Set<(event: KeyboardEvent) => boolean>>();

/**
 * Installs a prototype-level hook on `EventTarget.prototype.addEventListener` /
 * `removeEventListener` so that ANY keyboard listener registered by CVAT (even if CVAT
 * registered `window.addEventListener('keydown', ..., true)` before our script ran, or via
 * Mousetrap / react-hotkeys on `document`) is bypassed whenever `shouldSuppress(event)`
 * returns `true` or the event has already been marked suppressed.
 */
export function installEarlyKeySuppressionHook(
  win: Window,
  shouldSuppress: (event: KeyboardEvent) => boolean
): () => void {
  const EventTargetProto = (win as unknown as { EventTarget?: { prototype?: EventTarget } })
    .EventTarget?.prototype;
  if (!EventTargetProto) {
    return () => undefined;
  }
  let predicates = HOOKED_EVENT_TARGET_PROTOS.get(EventTargetProto);
  if (!predicates) {
    predicates = new Set();
    HOOKED_EVENT_TARGET_PROTOS.set(EventTargetProto, predicates);

    const activePredicates = predicates;
    const origAdd = EventTargetProto.addEventListener;
    const origRemove = EventTargetProto.removeEventListener;
    const listenerMap = new WeakMap<EventListenerOrEventListenerObject, EventListener>();

    EventTargetProto.addEventListener = function (
      this: EventTarget,
      type: string,
      listener: EventListenerOrEventListenerObject | null,
      options?: boolean | AddEventListenerOptions
    ): void {
      if (
        listener &&
        (type === 'keydown' || type === 'keyup' || type === 'keypress') &&
        !(listener as { __cvat3dEnhancerInternalKeyListener?: boolean })
          .__cvat3dEnhancerInternalKeyListener
      ) {
        let wrapped = listenerMap.get(listener);
        if (!wrapped) {
          wrapped = function (this: EventTarget, ev: Event): void {
            if (SUPPRESSED_KEY_EVENTS.has(ev)) {
              return;
            }
            if (ev instanceof KeyboardEvent) {
              for (const check of activePredicates) {
                if (check(ev)) {
                  return;
                }
              }
            }
            if (typeof listener === 'function') {
              listener.call(this, ev);
            } else if (typeof listener.handleEvent === 'function') {
              listener.handleEvent(ev);
            }
          };
          listenerMap.set(listener, wrapped);
        }
        return origAdd.call(this, type, wrapped, options);
      }
      return origAdd.call(this, type, listener, options);
    };

    EventTargetProto.removeEventListener = function (
      this: EventTarget,
      type: string,
      listener: EventListenerOrEventListenerObject | null,
      options?: boolean | EventListenerOptions
    ): void {
      if (listener && (type === 'keydown' || type === 'keyup' || type === 'keypress')) {
        const wrapped = listenerMap.get(listener);
        if (wrapped) {
          origRemove.call(this, type, wrapped, options);
        }
      }
      return origRemove.call(this, type, listener, options);
    };
  }

  predicates.add(shouldSuppress);
  return () => {
    predicates?.delete(shouldSuppress);
  };
}

const VIEW_WRAPPERS: Readonly<Record<OrthoViewName, string>> = {
  top: CVAT_DOM_SELECTORS.TOP_VIEW_WRAPPER,
  side: CVAT_DOM_SELECTORS.SIDE_VIEW_WRAPPER,
  front: CVAT_DOM_SELECTORS.FRONT_VIEW_WRAPPER,
};

export const NUDGE_KEY_CODES = ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE'] as const;
const NUDGE_KEYS = new Set<string>(NUDGE_KEY_CODES);
const NUDGE_KEY_CHARS: Readonly<Record<string, (typeof NUDGE_KEY_CODES)[number]>> = {
  w: 'KeyW',
  a: 'KeyA',
  s: 'KeyS',
  d: 'KeyD',
  q: 'KeyQ',
  e: 'KeyE',
};

export function resolveNudgeKeyCode(event: KeyboardEvent): (typeof NUDGE_KEY_CODES)[number] | null {
  if (event.code && NUDGE_KEYS.has(event.code)) {
    return event.code as (typeof NUDGE_KEY_CODES)[number];
  }
  const keyLower = typeof event.key === 'string' ? event.key.toLowerCase() : '';
  return NUDGE_KEY_CHARS[keyLower] ?? null;
}

/**
 * Detects whether any orthographic view (Top/Side/Front) is currently maximized — either via
 * our `OrthoViewMaximizer` state, via `.cvat-3d-enhancer-view-maximized` DOM class, or via
 * CVAT's native zoom/expand modal/view (a large `<canvas>` outside the 4 standard slots).
 */
export function detectActiveZoomedOrthoView(
  doc: Document,
  explicitMaximized: OrthoViewName | null
): OrthoViewName | null {
  if (explicitMaximized) {
    return explicitMaximized;
  }
  for (const view of ['top', 'side', 'front'] as const) {
    const el = doc.querySelector<HTMLElement>(VIEW_WRAPPERS[view]);
    if (!el) continue;
    if (el.classList.contains('cvat-3d-enhancer-view-maximized') || el.style.position === 'fixed') {
      return view;
    }
    // Also detect if one of the ortho views was expanded to cover > 45% of the viewport width
    const winW = doc.defaultView?.innerWidth ?? 0;
    if (winW > 0 && el.clientWidth > winW * 0.45) {
      return view;
    }
  }
  // Detect standalone CVAT ortho zoom canvas (e.g. 866x712 canvas outside the 4 standard views)
  const perspCanvas = doc.querySelector('.cvat-canvas3d-perspective canvas');
  const topCanvas = doc.querySelector('.cvat-canvas3d-topview canvas');
  const sideCanvas = doc.querySelector('.cvat-canvas3d-sideview canvas');
  const frontCanvas = doc.querySelector('.cvat-canvas3d-frontview canvas');
  const allCanvases = doc.querySelectorAll<HTMLCanvasElement>('canvas');
  for (const c of allCanvases) {
    if (
      c !== perspCanvas &&
      c !== topCanvas &&
      c !== sideCanvas &&
      c !== frontCanvas &&
      (c.clientWidth >= 400 || c.width >= 400)
    ) {
      return 'top';
    }
  }
  return null;
}

/** Resolve the whole hovered panel, including its header and canvas container. */
export function detectHoveredOrthoView(doc: Document): OrthoViewName | null {
  for (const view of ['top', 'side', 'front'] as const) {
    if (doc.querySelector(`${VIEW_WRAPPERS[view]}:hover`)) return view;
  }
  return null;
}

export const NUDGE_STEP_PX = 2.5;
export const NUDGE_FALLBACK_STEP_M = 0.025;
export const ROTATE_STEP_RAD = (0.4 * Math.PI) / 180;
export const COARSE_MULTIPLIER = 4;
export const EDGE_TOLERANCE_PX = 6;
export const CORNER_EXCLUSION_PX = 10;
export const MIN_CUBOID_SIZE_M = 0.01;
const COMMIT_DEBOUNCE_MS = 250;

// ---------------------------------------------------------------------------------------------
// Pure math
// ---------------------------------------------------------------------------------------------

const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

function normalize(v: Vec3): Vec3 {
  const len = Math.hypot(v[0], v[1], v[2]);
  return len > 1e-12 ? [v[0] / len, v[1] / len, v[2] / len] : [0, 0, 0];
}

/** Same convention as THREE.Matrix4.makeRotationFromEuler with order 'XYZ'. */
export function eulerXYZToMatrix(rx: number, ry: number, rz: number): Mat3 {
  const a = Math.cos(rx);
  const b = Math.sin(rx);
  const c = Math.cos(ry);
  const d = Math.sin(ry);
  const e = Math.cos(rz);
  const f = Math.sin(rz);
  const ae = a * e;
  const af = a * f;
  const be = b * e;
  const bf = b * f;
  return [c * e, -c * f, d, af + be * d, ae - bf * d, -b * c, bf - ae * d, be + af * d, a * c];
}

/** Same convention as THREE.Euler.setFromRotationMatrix with order 'XYZ'. */
export function matrixToEulerXYZ(m: Mat3): Vec3 {
  const m02 = Math.max(-1, Math.min(1, m[2]));
  const ry = Math.asin(m02);
  if (Math.abs(m02) < 0.9999999) {
    return [Math.atan2(-m[5], m[8]), ry, Math.atan2(-m[1], m[0])];
  }
  return [Math.atan2(m[7], m[4]), ry, 0];
}

export function axisAngleMatrix(axis: Vec3, angle: number): Mat3 {
  const [x, y, z] = normalize(axis);
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const t = 1 - c;
  return [
    t * x * x + c,
    t * x * y - s * z,
    t * x * z + s * y,
    t * x * y + s * z,
    t * y * y + c,
    t * y * z - s * x,
    t * x * z - s * y,
    t * y * z + s * x,
    t * z * z + c,
  ];
}

export function multiplyMat3(a: Mat3, b: Mat3): Mat3 {
  const out = new Array<number>(9).fill(0) as Mat3;
  for (let r = 0; r < 3; r += 1) {
    for (let c = 0; c < 3; c += 1) {
      out[r * 3 + c] = a[r * 3]! * b[c]! + a[r * 3 + 1]! * b[3 + c]! + a[r * 3 + 2]! * b[6 + c]!;
    }
  }
  return out;
}

/** World-space unit vectors of the cuboid local x / y / z axes. */
export function cuboidAxes(points: readonly number[]): [Vec3, Vec3, Vec3] {
  const m = eulerXYZToMatrix(points[3] ?? 0, points[4] ?? 0, points[5] ?? 0);
  return [
    [m[0], m[3], m[6]],
    [m[1], m[4], m[7]],
    [m[2], m[5], m[8]],
  ];
}

/**
 * Fallback canonical orthographic camera frames (standard CVAT LiDAR coordinate system:
 * +X forward, +Y left, +Z up) used only if the Three.js OrthographicCamera reference is not
 * directly exposed on the view.
 */
export const DEFAULT_ORTHO_CAMERA_FRAMES: Readonly<Record<OrthoViewName, CameraFrame>> = {
  top: {
    right: [1, 0, 0],
    up: [0, 1, 0],
    back: [0, 0, 1],
    position: [0, 0, 10],
    halfW: 10,
    halfH: 10,
    cx: 0,
    cy: 0,
  },
  side: {
    right: [1, 0, 0],
    up: [0, 0, 1],
    back: [0, -1, 0],
    position: [0, -10, 0],
    halfW: 10,
    halfH: 10,
    cx: 0,
    cy: 0,
  },
  front: {
    right: [0, -1, 0],
    up: [0, 0, 1],
    back: [-1, 0, 0],
    position: [-10, 0, 0],
    halfW: 10,
    halfH: 10,
    cx: 0,
    cy: 0,
  },
};

export function readCameraFrame(camera: OrthoCameraLike | null | undefined): CameraFrame | null {
  const e = camera?.matrixWorld?.elements;
  if (!camera || !e || e.length < 16) {
    return null;
  }
  const { left, right, top, bottom } = camera;
  if (
    typeof left !== 'number' ||
    typeof right !== 'number' ||
    typeof top !== 'number' ||
    typeof bottom !== 'number'
  ) {
    return null;
  }
  const zoom = typeof camera.zoom === 'number' && camera.zoom > 0 ? camera.zoom : 1;
  const r = normalize([e[0]!, e[1]!, e[2]!]);
  const u = normalize([e[4]!, e[5]!, e[6]!]);
  const b = normalize([e[8]!, e[9]!, e[10]!]);
  if (r[0] === 0 && r[1] === 0 && r[2] === 0) {
    return null;
  }
  return {
    right: r,
    up: u,
    back: b,
    position: [e[12]!, e[13]!, e[14]!],
    halfW: (right - left) / (2 * zoom),
    halfH: (top - bottom) / (2 * zoom),
    cx: (right + left) / 2,
    cy: (top + bottom) / 2,
  };
}

/** Pixel position (relative to canvas top-left) -> camera-local 2D coordinates. */
export function pixelToLocal2d(
  frame: CameraFrame,
  px: number,
  py: number,
  width: number,
  height: number
): [number, number] {
  const ndcX = (px / Math.max(1, width)) * 2 - 1;
  const ndcY = 1 - (py / Math.max(1, height)) * 2;
  return [frame.cx + ndcX * frame.halfW, frame.cy + ndcY * frame.halfH];
}

export function worldToLocal2d(frame: CameraFrame, p: Vec3): [number, number] {
  const d: Vec3 = [p[0] - frame.position[0], p[1] - frame.position[1], p[2] - frame.position[2]];
  return [dot(d, frame.right), dot(d, frame.up)];
}

export function worldUnitsPerPixel(frame: CameraFrame, width: number): number {
  return (2 * frame.halfW) / Math.max(1, width);
}

/** Moves the cuboid by (dx, dy) world units along the camera's screen right / up axes. */
export function nudgeCuboidPoints(
  points: readonly number[],
  frame: CameraFrame,
  dx: number,
  dy: number
): number[] {
  const next = [...points];
  for (let i = 0; i < 3; i += 1) {
    next[i] = (points[i] ?? 0) + frame.right[i]! * dx + frame.up[i]! * dy;
  }
  return next;
}

/** Rotates the cuboid around the view axis. Positive angle = counter-clockwise on screen. */
export function rotateCuboidPointsAroundViewAxis(
  points: readonly number[],
  frame: CameraFrame,
  angle: number
): number[] {
  const current = eulerXYZToMatrix(points[3] ?? 0, points[4] ?? 0, points[5] ?? 0);
  const rotated = multiplyMat3(axisAngleMatrix(frame.back, angle), current);
  const [rx, ry, rz] = matrixToEulerXYZ(rotated);
  const next = [...points];
  next[3] = rx;
  next[4] = ry;
  next[5] = rz;
  return next;
}

/**
 * Finds the cuboid edge (in screen space) under the pointer, excluding corner areas.
 * `pointer` is in camera-local 2D coordinates; `unitsPerPx` converts pixels to those units.
 */
export function hitTestCuboidEdge(
  points: readonly number[],
  frame: CameraFrame,
  pointer: readonly [number, number],
  unitsPerPx: number,
  tolerancePx = EDGE_TOLERANCE_PX,
  cornerExclusionPx = CORNER_EXCLUSION_PX
): EdgeHit | null {
  if (points.length < 9) {
    return null;
  }
  const axes = cuboidAxes(points);
  const sizes = [points[6] ?? 0, points[7] ?? 0, points[8] ?? 0];
  const center = worldToLocal2d(frame, [points[0] ?? 0, points[1] ?? 0, points[2] ?? 0]);

  // The axis most aligned with the view direction is the depth axis (not visible as edges)
  let depthAxis = 0;
  let maxDepth = -1;
  axes.forEach((ax, i) => {
    const d = Math.abs(dot(ax, frame.back));
    if (d > maxDepth) {
      maxDepth = d;
      depthAxis = i;
    }
  });
  const visible = ([0, 1, 2] as const).filter((i) => i !== depthAxis);

  const rel: [number, number] = [pointer[0] - center[0], pointer[1] - center[1]];
  const proj = visible.map((i) => {
    const ax = axes[i]!;
    const px = dot(ax, frame.right);
    const py = dot(ax, frame.up);
    const f = Math.hypot(px, py);
    return {
      axis: i,
      dir: f > 1e-9 ? ([px / f, py / f] as const) : null,
      f,
      half: (sizes[i]! / 2) * f,
    };
  });

  const tol = tolerancePx * unitsPerPx;
  const cornerMargin = cornerExclusionPx * unitsPerPx;
  let best: (EdgeHit & { dist: number }) | null = null;

  for (let k = 0; k < 2; k += 1) {
    const a = proj[k]!;
    const b = proj[1 - k]!;
    if (!a.dir || !b.dir || a.half <= 0 || b.half <= 0) {
      continue;
    }
    const alongA = rel[0] * a.dir[0] + rel[1] * a.dir[1];
    const alongB = rel[0] * b.dir[0] + rel[1] * b.dir[1];
    const dist = Math.abs(Math.abs(alongA) - a.half);
    if (dist > tol) {
      continue;
    }
    if (Math.abs(alongB) > b.half - cornerMargin) {
      continue; // corner zone -> leave it to CVAT's native corner handles
    }
    if (!best || dist < best.dist) {
      best = {
        axis: a.axis as 0 | 1 | 2,
        sign: alongA >= 0 ? 1 : -1,
        dir2d: a.dir,
        projFactor: a.f,
        dist,
      };
    }
  }

  if (!best) {
    return null;
  }
  return {
    axis: best.axis,
    sign: best.sign,
    dir2d: best.dir2d,
    projFactor: best.projFactor,
  };
}

/**
 * Resizes the cuboid along `hit.axis` so the grabbed edge follows the pointer while the
 * opposite edge stays fixed. `delta2d` is the pointer movement in camera-local 2D units.
 */
export function resizeCuboidPointsByEdge(
  startPoints: readonly number[],
  hit: EdgeHit,
  delta2d: readonly [number, number],
  minSize = MIN_CUBOID_SIZE_M
): number[] {
  const along = delta2d[0] * hit.dir2d[0] + delta2d[1] * hit.dir2d[1];
  const worldDelta = hit.projFactor > 1e-9 ? along / hit.projFactor : 0;
  const sizeIdx = 6 + hit.axis;
  const oldSize = startPoints[sizeIdx] ?? 0;
  const newSize = Math.max(minSize, oldSize + hit.sign * worldDelta);
  const growth = newSize - oldSize;
  const axis = cuboidAxes(startPoints)[hit.axis];
  const next = [...startPoints];
  next[sizeIdx] = newSize;
  for (let i = 0; i < 3; i += 1) {
    next[i] = (startPoints[i] ?? 0) + axis[i]! * hit.sign * (growth / 2);
  }
  return next;
}

export function cursorForEdge(hit: EdgeHit): string {
  return Math.abs(hit.dir2d[0]) >= Math.abs(hit.dir2d[1]) ? 'ew-resize' : 'ns-resize';
}

// ---------------------------------------------------------------------------------------------
// DOM controller
// ---------------------------------------------------------------------------------------------

interface DragState {
  readonly view: OrthoViewName;
  readonly canvas: HTMLCanvasElement;
  readonly clientID: number;
  readonly startPoints: number[];
  readonly frame: CameraFrame;
  readonly hit: EdgeHit;
  readonly startLocal: [number, number];
  lastPoints: number[];
}

export class OrthoCuboidEditor {
  private readonly doc: Document;
  private readonly win: Window;
  private readonly ctx: OrthoCuboidEditorContext;
  private hoverObserved = false;
  private shortcutsSuspended = false;
  private hoveredPanel: HTMLElement | null = null;
  private drag: DragState | null = null;
  private suppressNextClick = false;
  private cursorCanvas: HTMLCanvasElement | null = null;
  private cursorPrev = '';
  private pending: { clientID: number; points: number[] } | null = null;
  private commitTimer: ReturnType<typeof setTimeout> | null = null;

  public constructor(
    ctx: OrthoCuboidEditorContext,
    doc: Document = document,
    win: Window = window
  ) {
    this.ctx = ctx;
    this.doc = doc;
    this.win = win;
  }

  public install(): () => void {
    this.shortcutsSuspended = false;
    this.hoverObserved = false;
    this.hoveredPanel = null;
    const removeProtoHook = installEarlyKeySuppressionHook(this.win, (ev) =>
      this.shouldSuppressKeyEvent(ev)
    );

    const opts = { capture: true } as const;
    const keyHandler = Object.assign((e: KeyboardEvent): void => this.onKey(e), {
      __cvat3dEnhancerInternalKeyListener: true,
    });
    const pointerOver = (e: MouseEvent): void => {
      if (this.shortcutsSuspended) return;
      this.hoverObserved = true;
      this.hoveredPanel = this.resolveViewPanel(e.target);
    };
    const pointerOut = (e: MouseEvent): void => {
      this.hoverObserved = true;
      this.hoveredPanel = this.resolveViewPanel(e.relatedTarget);
    };
    const clearHover = (): void => {
      this.hoveredPanel = null;
      this.hoverObserved = true;
      this.shortcutsSuspended = true;
      this.flushPendingCommit();
    };
    const restoreFocus = (): void => {
      this.shortcutsSuspended = false;
      this.hoverObserved = false;
    };
    const visibilityChanged = (): void => {
      if (this.doc.hidden) clearHover();
    };
    const pointerDown = (e: PointerEvent): void => this.onPointerDown(e);
    const pointerMove = (e: PointerEvent): void => this.onPointerMove(e);
    const pointerUp = (e: PointerEvent): void => this.onPointerUp(e);
    const mouseBlock = (e: MouseEvent): void => this.onMouseDuringDrag(e);

    // Register on BOTH window and document in capture phase so CVAT's document/window/react-hotkeys
    // listeners can never run before us regardless of where they were attached.
    for (const type of KEY_EVENT_TYPES) {
      this.win.addEventListener(type, keyHandler, opts);
      this.doc.addEventListener(type, keyHandler, opts);
    }
    this.win.addEventListener('pointerover', pointerOver, opts);
    this.win.addEventListener('pointerout', pointerOut, opts);
    this.win.addEventListener('mousemove', pointerOver, opts);
    this.win.addEventListener('mouseout', pointerOut, opts);
    this.win.addEventListener('blur', clearHover);
    this.win.addEventListener('focus', restoreFocus);
    this.doc.addEventListener('visibilitychange', visibilityChanged);
    this.win.addEventListener('pointerdown', pointerDown, opts);
    this.win.addEventListener('pointermove', pointerMove, opts);
    this.win.addEventListener('pointerup', pointerUp, opts);
    this.win.addEventListener('pointercancel', pointerUp, opts);
    for (const t of ['mousedown', 'mousemove', 'mouseup', 'click', 'dblclick'] as const) {
      this.win.addEventListener(t, mouseBlock, opts);
    }

    return () => {
      this.flushPendingCommit();
      removeProtoHook();
      for (const type of KEY_EVENT_TYPES) {
        this.win.removeEventListener(type, keyHandler, opts);
        this.doc.removeEventListener(type, keyHandler, opts);
      }
      this.win.removeEventListener('pointerover', pointerOver, opts);
      this.win.removeEventListener('pointerout', pointerOut, opts);
      this.win.removeEventListener('mousemove', pointerOver, opts);
      this.win.removeEventListener('mouseout', pointerOut, opts);
      this.win.removeEventListener('blur', clearHover);
      this.win.removeEventListener('focus', restoreFocus);
      this.doc.removeEventListener('visibilitychange', visibilityChanged);
      clearHover();
      this.win.removeEventListener('pointerdown', pointerDown, opts);
      this.win.removeEventListener('pointermove', pointerMove, opts);
      this.win.removeEventListener('pointerup', pointerUp, opts);
      this.win.removeEventListener('pointercancel', pointerUp, opts);
      for (const t of ['mousedown', 'mousemove', 'mouseup', 'click', 'dblclick'] as const) {
        this.win.removeEventListener(t, mouseBlock, opts);
      }
      this.setCursor(null, null);
    };
  }

  /** Commits any debounced keyboard nudge immediately (e.g. when the view is restored). */
  public flushPendingCommit(): void {
    if (this.commitTimer !== null) {
      clearTimeout(this.commitTimer);
      this.commitTimer = null;
    }
    const pending = this.pending;
    this.pending = null;
    if (pending) {
      this.ctx.commitPoints(pending.clientID, pending.points);
    }
  }

  // ----- keyboard -----------------------------------------------------------------------------

  private getActiveView(): OrthoViewName | null {
    if (this.shortcutsSuspended) return null;
    // CSS :hover may remain set after blur or a synthetic/retargeted pointer exit.
    if (!this.hoverObserved) return detectHoveredOrthoView(this.doc);
    if (this.hoveredPanel?.isConnected) {
      for (const view of ['top', 'side', 'front'] as const) {
        if (this.hoveredPanel.matches(VIEW_WRAPPERS[view])) return view;
      }
    }
    return null;
  }

  public shouldSuppressKeyEvent(event: KeyboardEvent): boolean {
    if (this.ctx.getKeyboardOptions?.().enabled === false) return false;
    const code = resolveNudgeKeyCode(event);
    if (!code || event.ctrlKey || event.altKey || event.metaKey) {
      return false;
    }
    if (isEditableEventTarget(event.target)) {
      return false;
    }
    const view = this.getActiveView();
    return view !== null;
  }

  private onKey(event: KeyboardEvent): void {
    if (this.ctx.getKeyboardOptions?.().enabled === false) {
      this.flushPendingCommit();
      return;
    }
    if (SUPPRESSED_KEY_EVENTS.has(event)) {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      return;
    }
    const code = resolveNudgeKeyCode(event);
    if (!code || event.ctrlKey || event.altKey || event.metaKey) {
      return;
    }
    const view = this.getActiveView();
    if (!view || isEditableEventTarget(event.target)) {
      return;
    }
    // Mark and swallow the key completely so CVAT never sees W/A/S/D/Q/E while hovering an ortho view
    SUPPRESSED_KEY_EVENTS.add(event);
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    if (event.type !== 'keydown') {
      if (event.type === 'keyup' && this.ctx.getKeyboardOptions?.().immediateCommit !== false)
        this.flushPendingCommit();
      return;
    }
    this.applyNudge(view, code, event.shiftKey);
  }

  private applyNudge(view: OrthoViewName, code: string, coarse: boolean): void {
    const active = this.ctx.getActivePoints();
    if (!active || active.points.length < 9) {
      return;
    }
    if (this.pending && this.pending.clientID !== active.clientID) {
      this.flushPendingCommit();
    }
    const liveFrame = readCameraFrame(this.ctx.getViewCamera(view));
    const frame = liveFrame ?? DEFAULT_ORTHO_CAMERA_FRAMES[view];
    const base = this.pending?.clientID === active.clientID ? this.pending.points : active.points;
    const mult =
      (coarse ? COARSE_MULTIPLIER : 1) *
      (this.ctx.getKeyboardOptions?.().highSensitivity === false ? 0.5 : 1);
    const canvas = this.getViewCanvas(view);
    const width = canvas?.clientWidth || canvas?.width || 0;
    const step =
      (liveFrame && width > 0
        ? NUDGE_STEP_PX * worldUnitsPerPixel(liveFrame, width)
        : NUDGE_FALLBACK_STEP_M) * mult;

    let next: number[];
    switch (code) {
      case 'KeyA':
        next = nudgeCuboidPoints(base, frame, -step, 0);
        break;
      case 'KeyD':
        next = nudgeCuboidPoints(base, frame, step, 0);
        break;
      case 'KeyW':
        next = nudgeCuboidPoints(base, frame, 0, step);
        break;
      case 'KeyS':
        next = nudgeCuboidPoints(base, frame, 0, -step);
        break;
      case 'KeyQ':
        next = rotateCuboidPointsAroundViewAxis(base, frame, ROTATE_STEP_RAD * mult);
        break;
      case 'KeyE':
        next = rotateCuboidPointsAroundViewAxis(base, frame, -ROTATE_STEP_RAD * mult);
        break;
      default:
        return;
    }

    this.pending = { clientID: active.clientID, points: next };
    this.ctx.previewPoints(active.clientID, next);
    if (this.commitTimer !== null) {
      clearTimeout(this.commitTimer);
    }
    this.commitTimer = setTimeout(() => {
      this.commitTimer = null;
      this.flushPendingCommit();
    }, COMMIT_DEBOUNCE_MS);
  }

  // ----- edge drag ----------------------------------------------------------------------------

  private resolveViewPanel(target: EventTarget | null): HTMLElement | null {
    const el = target as Element | null;
    if (!el || typeof el.closest !== 'function') return null;
    return el.closest<HTMLElement>(Object.values(VIEW_WRAPPERS).join(', '));
  }

  private resolveViewCanvas(target: EventTarget | null): {
    view: OrthoViewName;
    canvas: HTMLCanvasElement;
  } | null {
    const el = target as Element | null;
    if (!el || el.tagName !== 'CANVAS' || typeof el.closest !== 'function') {
      return null;
    }
    for (const view of ['top', 'side', 'front'] as const) {
      if (el.closest(VIEW_WRAPPERS[view])) {
        return { view, canvas: el as HTMLCanvasElement };
      }
    }
    return null;
  }

  private getViewCanvas(view: OrthoViewName): HTMLCanvasElement | null {
    return this.doc.querySelector<HTMLCanvasElement>(`${VIEW_WRAPPERS[view]} canvas`);
  }

  private hitTestAt(
    view: OrthoViewName,
    canvas: HTMLCanvasElement,
    clientX: number,
    clientY: number
  ): {
    hit: EdgeHit;
    frame: CameraFrame;
    local: [number, number];
    clientID: number;
    points: number[];
  } | null {
    const active = this.ctx.getActivePoints();
    if (!active || active.points.length < 9) {
      return null;
    }
    const frame = readCameraFrame(this.ctx.getViewCamera(view));
    if (!frame) {
      return null;
    }
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      return null;
    }
    const points = this.pending?.clientID === active.clientID ? this.pending.points : active.points;
    const local = pixelToLocal2d(
      frame,
      clientX - rect.left,
      clientY - rect.top,
      rect.width,
      rect.height
    );
    const hit = hitTestCuboidEdge(points, frame, local, worldUnitsPerPixel(frame, rect.width));
    return hit ? { hit, frame, local, clientID: active.clientID, points } : null;
  }

  private onPointerDown(event: PointerEvent): void {
    if (this.drag || event.button !== 0 || event.ctrlKey || event.altKey || event.metaKey) {
      return;
    }
    const target = this.resolveViewCanvas(event.target);
    if (!target) {
      return;
    }
    const found = this.hitTestAt(target.view, target.canvas, event.clientX, event.clientY);
    if (!found) {
      return;
    }
    this.flushPendingCommit();
    event.preventDefault();
    event.stopImmediatePropagation();
    this.drag = {
      view: target.view,
      canvas: target.canvas,
      clientID: found.clientID,
      startPoints: [...found.points],
      frame: found.frame,
      hit: found.hit,
      startLocal: found.local,
      lastPoints: [...found.points],
    };
    this.setCursor(target.canvas, cursorForEdge(found.hit));
  }

  private onPointerMove(event: PointerEvent): void {
    const drag = this.drag;
    if (drag) {
      event.preventDefault();
      event.stopImmediatePropagation();
      const rect = drag.canvas.getBoundingClientRect();
      const local = pixelToLocal2d(
        drag.frame,
        event.clientX - rect.left,
        event.clientY - rect.top,
        rect.width,
        rect.height
      );
      const next = resizeCuboidPointsByEdge(drag.startPoints, drag.hit, [
        local[0] - drag.startLocal[0],
        local[1] - drag.startLocal[1],
      ]);
      drag.lastPoints = next;
      this.ctx.previewPoints(drag.clientID, next);
      return;
    }

    // Hover feedback: show a resize cursor over grabbable edges
    if (event.buttons !== 0) {
      return;
    }
    const target = this.resolveViewCanvas(event.target);
    if (!target) {
      this.setCursor(null, null);
      return;
    }
    const found = this.hitTestAt(target.view, target.canvas, event.clientX, event.clientY);
    this.setCursor(target.canvas, found ? cursorForEdge(found.hit) : null);
  }

  private onPointerUp(event: PointerEvent): void {
    const drag = this.drag;
    if (!drag) {
      return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
    this.drag = null;
    this.suppressNextClick = true;
    setTimeout(() => {
      this.suppressNextClick = false;
    }, 0);
    const changed = drag.lastPoints.some((v, i) => Math.abs(v - (drag.startPoints[i] ?? 0)) > 1e-9);
    if (changed) {
      this.ctx.commitPoints(drag.clientID, drag.lastPoints);
    }
  }

  private onMouseDuringDrag(event: MouseEvent): void {
    if (
      this.drag ||
      (this.suppressNextClick && (event.type === 'click' || event.type === 'mouseup'))
    ) {
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    // Compatibility mousedown for a pointerdown we consumed (CVAT listens to mouse events)
    if (event.type === 'mousedown' && event.button === 0) {
      const target = this.resolveViewCanvas(event.target);
      if (target && this.hitTestAt(target.view, target.canvas, event.clientX, event.clientY)) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    }
  }

  private setCursor(canvas: HTMLCanvasElement | null, cursor: string | null): void {
    if (this.cursorCanvas && (this.cursorCanvas !== canvas || cursor === null)) {
      this.cursorCanvas.style.cursor = this.cursorPrev;
      this.cursorCanvas = null;
    }
    if (canvas && cursor) {
      if (!this.cursorCanvas) {
        this.cursorCanvas = canvas;
        this.cursorPrev = canvas.style.cursor;
      }
      canvas.style.cursor = cursor;
    }
  }
}
