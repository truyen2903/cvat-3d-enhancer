import type { GuideCameraLike } from './cuboid-base-guide';
import { ensureMeowStyle } from './meow-ui';
import { buildQcShells, resolveQcMarginRatio } from './qc-margin-geometry';

export interface QcMarginTarget {
  readonly points: readonly number[];
  readonly labelName: string | null | undefined;
}

const OUTER_FILL = 'rgba(255, 159, 64, 0.14)';
const OUTER_STROKE = 'rgba(255, 159, 64, 0.55)';
const INNER_FILL = 'rgba(64, 160, 255, 0.14)';
const INNER_STROKE = 'rgba(64, 160, 255, 0.55)';

/** Everything a single source canvas needs; allocated once and reused by every render. */
interface ViewState {
  readonly overlay: HTMLCanvasElement;
  readonly context: CanvasRenderingContext2D;
  readonly box: Float64Array; // cached cx, cy, cz, rx, ry, rz, L, W, H
  readonly shells: Float64Array; // 24 corners (x, y, z): outer, inner, box
  readonly screen: Float64Array; // 24 corners (x, y, valid)
  readonly camera: Float64Array; // view + projection matrices
  readonly sorted: Int32Array;
  readonly outerHull: Int32Array;
  readonly innerHull: Int32Array;
  readonly boxHull: Int32Array;
  ratio: number;
  shellsValid: boolean;
  shellVersion: number;
  drawnShellVersion: number;
  rectVersion: number;
  drawnRectVersion: number;
  width: number;
  height: number;
  drawn: boolean;
  hasCamera: boolean;
}

function cross(s: Float64Array, offset: number, a: number, b: number, c: number): number {
  const ax = s[(offset + a) * 3]!;
  const ay = s[(offset + a) * 3 + 1]!;
  return (
    (s[(offset + b) * 3]! - ax) * (s[(offset + c) * 3 + 1]! - ay) -
    (s[(offset + b) * 3 + 1]! - ay) * (s[(offset + c) * 3]! - ax)
  );
}

/** Convex hull of the valid projected corners of one shell; returns the vertex count. */
function convexHull(state: ViewState, offset: number, hull: Int32Array): number {
  const { screen, sorted } = state;
  let n = 0;
  for (let i = 0; i < 8; i += 1) if (screen[(offset + i) * 3 + 2] !== 0) sorted[n++] = i;
  if (n < 3) return 0;
  for (let i = 1; i < n; i += 1) {
    const v = sorted[i]!;
    const vx = screen[(offset + v) * 3]!;
    const vy = screen[(offset + v) * 3 + 1]!;
    let j = i - 1;
    while (j >= 0) {
      const u = sorted[j]!;
      const ux = screen[(offset + u) * 3]!;
      if (ux < vx || (ux === vx && screen[(offset + u) * 3 + 1]! <= vy)) break;
      sorted[j + 1] = u;
      j -= 1;
    }
    sorted[j + 1] = v;
  }
  let k = 0;
  for (let i = 0; i < n; i += 1) {
    while (k >= 2 && cross(screen, offset, hull[k - 2]!, hull[k - 1]!, sorted[i]!) <= 0) k -= 1;
    hull[k++] = sorted[i]!;
  }
  const lower = k + 1;
  for (let i = n - 2; i >= 0; i -= 1) {
    while (k >= lower && cross(screen, offset, hull[k - 2]!, hull[k - 1]!, sorted[i]!) <= 0) k -= 1;
    hull[k++] = sorted[i]!;
  }
  return k - 1;
}

/**
 * Non-interactive canvas overlay showing the inner/outer QC margin shells of the active box.
 * Redraws only when the box, ratio, camera or viewport changed; no allocation per render.
 */
export class QcMarginOverlay {
  private readonly views = new Map<HTMLCanvasElement, ViewState>();
  private rectVersion = 0;
  private readonly resizeObserver: ResizeObserver | null;

  public constructor(private readonly doc: Document) {
    const Observer = (
      doc.defaultView as (Window & { ResizeObserver?: typeof ResizeObserver }) | null
    )?.ResizeObserver;
    this.resizeObserver =
      typeof Observer === 'function' ? new Observer(this.invalidateRects) : null;
    doc.defaultView?.addEventListener('resize', this.invalidateRects);
    doc.addEventListener('scroll', this.invalidateRects, true);
  }

  private readonly invalidateRects = (): void => {
    this.rectVersion += 1;
  };

  public render(
    canvas: HTMLCanvasElement,
    camera: GuideCameraLike,
    target: QcMarginTarget | null
  ): void {
    const ratio = target ? resolveQcMarginRatio(target.labelName) : null;
    if (!target || ratio === null || !canvas.isConnected) {
      const stale = this.views.get(canvas);
      if (stale) {
        if (canvas.isConnected) this.hide(stale);
        else this.remove(canvas, stale);
      }
      return;
    }
    const state = this.views.get(canvas) ?? this.create(canvas);
    if (!state) return;

    const points = target.points;
    let changed = state.ratio !== ratio || state.shellVersion === 0;
    for (let i = 0; i < 9 && !changed; i += 1) if (state.box[i] !== points[i]) changed = true;
    if (changed) {
      for (let i = 0; i < 9; i += 1) state.box[i] = points[i] ?? NaN;
      state.ratio = ratio;
      state.shellsValid = buildQcShells(points, ratio, state.shells);
      state.shellVersion += 1;
    }
    if (!state.shellsValid) {
      this.hide(state);
      return;
    }

    const view = camera.matrixWorldInverse?.elements;
    const projection = camera.projectionMatrix?.elements;
    if (!view || !projection || view.length < 16 || projection.length < 16) {
      this.hide(state);
      return;
    }
    let cameraChanged = !state.hasCamera;
    for (let i = 0; i < 16; i += 1) {
      if (state.camera[i] !== view[i]) {
        state.camera[i] = view[i]!;
        cameraChanged = true;
      }
      if (state.camera[16 + i] !== projection[i]) {
        state.camera[16 + i] = projection[i]!;
        cameraChanged = true;
      }
    }
    state.hasCamera = true;
    if (
      !cameraChanged &&
      state.drawn &&
      state.drawnShellVersion === state.shellVersion &&
      state.drawnRectVersion === this.rectVersion
    )
      return;

    this.draw(canvas, state);
  }

  private create(canvas: HTMLCanvasElement): ViewState | null {
    this.prune();
    const overlay = this.doc.createElement('canvas');
    const context = overlay.getContext('2d');
    if (!context) return null;
    ensureMeowStyle(this.doc);
    overlay.className = 'meow-qc-margin';
    overlay.setAttribute('data-meow-owned', '');
    overlay.setAttribute('aria-hidden', 'true');
    (this.doc.fullscreenElement ?? this.doc.documentElement).appendChild(overlay);
    this.resizeObserver?.observe(canvas);
    const state: ViewState = {
      overlay,
      context,
      box: new Float64Array(9),
      shells: new Float64Array(72),
      screen: new Float64Array(72),
      camera: new Float64Array(32),
      sorted: new Int32Array(8),
      outerHull: new Int32Array(17),
      innerHull: new Int32Array(17),
      boxHull: new Int32Array(17),
      ratio: NaN,
      shellsValid: false,
      shellVersion: 0,
      drawnShellVersion: -1,
      rectVersion: -1,
      drawnRectVersion: -1,
      width: 0,
      height: 0,
      drawn: false,
      hasCamera: false,
    };
    this.views.set(canvas, state);
    return state;
  }

  private draw(canvas: HTMLCanvasElement, state: ViewState): void {
    const { overlay, context: ctx, camera, shells, screen } = state;
    if (state.rectVersion !== this.rectVersion || state.width === 0) {
      const rect = canvas.getBoundingClientRect();
      state.rectVersion = this.rectVersion;
      state.width = Math.max(1, Math.round(rect.width));
      state.height = Math.max(1, Math.round(rect.height));
      if (overlay.width !== state.width) overlay.width = state.width;
      if (overlay.height !== state.height) overlay.height = state.height;
      overlay.style.left = `${rect.left}px`;
      overlay.style.top = `${rect.top}px`;
      overlay.style.width = `${rect.width}px`;
      overlay.style.height = `${rect.height}px`;
    }
    if (overlay.style.display !== 'block') overlay.style.display = 'block';

    for (let i = 0; i < 72; i += 3) {
      const x = shells[i]!;
      const y = shells[i + 1]!;
      const z = shells[i + 2]!;
      const vx = camera[0]! * x + camera[4]! * y + camera[8]! * z + camera[12]!;
      const vy = camera[1]! * x + camera[5]! * y + camera[9]! * z + camera[13]!;
      const vz = camera[2]! * x + camera[6]! * y + camera[10]! * z + camera[14]!;
      const vw = camera[3]! * x + camera[7]! * y + camera[11]! * z + camera[15]!;
      const cx = camera[16]! * vx + camera[20]! * vy + camera[24]! * vz + camera[28]! * vw;
      const cy = camera[17]! * vx + camera[21]! * vy + camera[25]! * vz + camera[29]! * vw;
      const cw = camera[19]! * vx + camera[23]! * vy + camera[27]! * vz + camera[31]! * vw;
      screen[i] = ((1 + cx / cw) * state.width) / 2;
      screen[i + 1] = ((1 - cy / cw) * state.height) / 2;
      // 2D overlay: only points behind the camera are unusable; near/far planes don't matter.
      screen[i + 2] = cw > 0 ? 1 : 0;
    }

    ctx.clearRect(0, 0, state.width, state.height);
    ctx.lineWidth = 1;
    const boxCount = convexHull(state, 16, state.boxHull);
    if (boxCount >= 3) {
      // Outer band: between the outer shell and the box. Inner band: between the box and the inner shell.
      const outerCount = convexHull(state, 0, state.outerHull);
      if (outerCount >= 3)
        this.fillRing(state, OUTER_FILL, OUTER_STROKE, 0, state.outerHull, outerCount, boxCount);
      const innerCount = convexHull(state, 8, state.innerHull);
      if (innerCount >= 3)
        this.fillRing(state, INNER_FILL, INNER_STROKE, 8, state.innerHull, innerCount, boxCount);
    }
    state.drawn = true;
    state.drawnShellVersion = state.shellVersion;
    state.drawnRectVersion = this.rectVersion;
  }

  /** Even-odd fill of (shell polygon + box polygon): only the band between them is tinted. */
  private fillRing(
    state: ViewState,
    fill: string,
    stroke: string,
    shellOffset: number,
    shellHull: Int32Array,
    shellCount: number,
    boxCount: number
  ): void {
    const ctx = state.context;
    ctx.fillStyle = fill;
    ctx.strokeStyle = stroke;
    ctx.beginPath();
    this.tracePolygon(state, shellOffset, shellHull, shellCount);
    this.tracePolygon(state, 16, state.boxHull, boxCount);
    ctx.fill('evenodd');
    ctx.beginPath();
    this.tracePolygon(state, shellOffset, shellHull, shellCount);
    ctx.stroke();
  }

  private tracePolygon(state: ViewState, offset: number, hull: Int32Array, count: number): void {
    const { context: ctx, screen } = state;
    for (let i = 0; i < count; i += 1) {
      const o = (offset + hull[i]!) * 3;
      if (i === 0) ctx.moveTo(screen[o]!, screen[o + 1]!);
      else ctx.lineTo(screen[o]!, screen[o + 1]!);
    }
    ctx.closePath();
  }

  private hide(state: ViewState): void {
    if (!state.drawn) return;
    state.context.clearRect(0, 0, state.width, state.height);
    state.overlay.style.display = 'none';
    state.drawn = false;
  }

  private remove(canvas: HTMLCanvasElement, state: ViewState): void {
    state.overlay.remove();
    this.resizeObserver?.unobserve(canvas);
    this.views.delete(canvas);
  }

  private prune(): void {
    for (const [canvas, state] of this.views) if (!canvas.isConnected) this.remove(canvas, state);
  }

  /** Hide every overlay (option turned off, active object lost). */
  public clear(): void {
    for (const state of this.views.values()) this.hide(state);
  }

  public dispose(): void {
    for (const [canvas, state] of this.views) this.remove(canvas, state);
    this.resizeObserver?.disconnect();
    this.doc.defaultView?.removeEventListener('resize', this.invalidateRects);
    this.doc.removeEventListener('scroll', this.invalidateRects, true);
  }
}
