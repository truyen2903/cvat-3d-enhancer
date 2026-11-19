import { ensureMeowStyle } from './meow-ui';
import type { CvatObjectStateLike } from './pre-render-enhancer';
import type { GuideCameraLike } from './cuboid-base-guide';
import { cuboidAxes } from './ortho-cuboid-editor';
import { showMeowToast } from './meow-toast';

const EDGES = [0, 1, 0, 2, 0, 4, 1, 3, 1, 5, 2, 3, 2, 6, 3, 7, 4, 5, 4, 6, 5, 7, 6, 7];
interface GhostGeometry {
  readonly vertices: Float64Array;
  readonly projected: Float64Array;
  readonly frames: readonly number[];
  readonly currentFrame: number;
}

/** Build once on keydown. Each box has eight corners followed by its center. */
function buildGeometry(state: CvatObjectStateLike): GhostGeometry | null {
  const shapes = state.__internal?.export?.().shapes;
  if (!shapes) return null;
  const visible = shapes.filter((s) => !s.outside && s.frame !== state.frame);
  if (state.points && !state.outside) visible.push({ frame: state.frame!, points: state.points });
  visible.sort((a, b) => a.frame - b.frame);
  const valid = visible.filter(
    (s) =>
      Number.isSafeInteger(s.frame) &&
      s.points &&
      s.points.length >= 9 &&
      s.points.every(Number.isFinite)
  );
  if (!valid.length) return null;
  const vertices = new Float64Array(valid.length * 27);
  for (let box = 0; box < valid.length; box++) {
    const points = valid[box]!.points!;
    const axes = cuboidAxes(points);
    for (let corner = 0; corner < 8; corner++) {
      for (let axis = 0; axis < 3; axis++) {
        let value = points[axis]!;
        for (let local = 0; local < 3; local++) {
          const sign = corner & (1 << local) ? 1 : -1;
          value += (sign * points[6 + local]! * axes[local]![axis]!) / 2;
        }
        vertices[box * 27 + corner * 3 + axis] = value;
      }
    }
    vertices.set(points.slice(0, 3), box * 27 + 24);
  }
  return {
    vertices,
    projected: new Float64Array(valid.length * 27),
    frames: valid.map((s) => s.frame),
    currentFrame: state.frame!,
  };
}

/** Canvas2D overlay uses CVAT's render camera, without depending on its private Three.js version. */
export class TrackGhostOverlay {
  private geometry: GhostGeometry | null = null;
  private source: HTMLCanvasElement | null = null;
  private overlay: HTMLCanvasElement | null = null;
  private context: CanvasRenderingContext2D | null = null;
  private clientID: number | null = null;
  private rect: DOMRect | null = null;
  private held = false;

  public constructor(
    private readonly doc: Document,
    private readonly enabled: () => boolean,
    private readonly resolve: () => {
      state: CvatObjectStateLike;
      canvas: HTMLCanvasElement;
      camera?: GuideCameraLike | null;
    } | null
  ) {
    doc.defaultView?.addEventListener('keydown', this.keydown, true);
    doc.defaultView?.addEventListener('keyup', this.keyup, true);
    doc.defaultView?.addEventListener('blur', this.release);
    doc.defaultView?.addEventListener('resize', this.resize);
    doc.addEventListener('scroll', this.resize, true);
    doc.addEventListener('visibilitychange', this.release);
  }

  private readonly keydown = (event: KeyboardEvent): void => {
    if (
      event.code !== 'KeyG' ||
      !event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.repeat ||
      this.held ||
      !this.enabled()
    )
      return;
    const target = event.target as Element | null;
    if (target?.closest?.('input,textarea,select,[contenteditable="true"],[role="textbox"]'))
      return;
    const active = this.resolve();
    const state = active?.state;
    if (
      !active ||
      !state ||
      state.objectType !== 'track' ||
      state.shapeType !== 'cuboid' ||
      state.hidden ||
      state.outside
    )
      return;
    event.preventDefault();
    event.stopImmediatePropagation();
    this.held = true;
    try {
      const geometry = buildGeometry(state);
      if (!geometry) throw new Error('Không có keyframe trong trình duyệt');
      this.geometry = geometry;
      this.source = active.canvas;
      this.clientID = state.clientID ?? null;
      this.overlay = this.doc.createElement('canvas');
      ensureMeowStyle(this.doc);
      this.overlay.className = 'meow-track-ghosts';
      this.overlay.setAttribute('aria-hidden', 'true');
      this.context = this.overlay.getContext('2d');
      if (!this.context) throw new Error('Canvas2D không khả dụng');
      (this.doc.fullscreenElement ?? this.doc.documentElement).appendChild(this.overlay);
      this.resize();
      if (active.camera) this.render(active.canvas, active.camera);
    } catch (error: unknown) {
      this.clear();
      showMeowToast(
        this.doc,
        error instanceof Error ? error.message : 'Không thể hiển thị ghost',
        'error'
      );
    }
  };

  private readonly keyup = (event: KeyboardEvent): void => {
    if (event.code === 'KeyG' || event.key === 'Alt') this.release();
  };
  private readonly release = (): void => {
    this.held = false;
    this.clear();
  };
  private readonly resize = (): void => {
    if (!this.source || !this.overlay) return;
    this.rect = this.source.getBoundingClientRect();
    const r = this.rect;
    this.overlay.width = Math.max(1, Math.round(r.width));
    this.overlay.height = Math.max(1, Math.round(r.height));
    this.overlay.style.left = `${r.left}px`;
    this.overlay.style.top = `${r.top}px`;
    this.overlay.style.width = `${r.width}px`;
    this.overlay.style.height = `${r.height}px`;
  };

  /** Called only at existing state-change boundaries; no object lookup or allocation. */
  public contextChanged(frame: unknown, clientID: unknown): void {
    if (this.geometry && (frame !== this.geometry.currentFrame || clientID !== this.clientID))
      this.clear();
  }
  public refreshEnabled(): void {
    if (!this.enabled()) this.clear();
  }
  public clear(): void {
    this.overlay?.remove();
    this.overlay = null;
    this.context = null;
    this.source = null;
    this.geometry = null;
    this.rect = null;
    this.clientID = null;
  }

  /** No arrays, objects, DOM nodes, geometry or track reads are created in this render path. */
  public render(canvas: HTMLCanvasElement, camera: GuideCameraLike): void {
    if (!this.geometry || canvas !== this.source) return;
    if (!canvas.isConnected || !this.enabled()) {
      this.clear();
      return;
    }
    const view = camera.matrixWorldInverse?.elements;
    const projection = camera.projectionMatrix?.elements;
    const ctx = this.context;
    const rect = this.rect;
    if (!view || !projection || !ctx || !rect) return;
    const vertices = this.geometry.vertices;
    const screen = this.geometry.projected;
    for (let i = 0; i < vertices.length; i += 3) {
      const x = vertices[i]!;
      const y = vertices[i + 1]!;
      const z = vertices[i + 2]!;
      const vx = view[0]! * x + view[4]! * y + view[8]! * z + view[12]!;
      const vy = view[1]! * x + view[5]! * y + view[9]! * z + view[13]!;
      const vz = view[2]! * x + view[6]! * y + view[10]! * z + view[14]!;
      const vw = view[3]! * x + view[7]! * y + view[11]! * z + view[15]!;
      const cx =
        projection[0]! * vx + projection[4]! * vy + projection[8]! * vz + projection[12]! * vw;
      const cy =
        projection[1]! * vx + projection[5]! * vy + projection[9]! * vz + projection[13]! * vw;
      const cz =
        projection[2]! * vx + projection[6]! * vy + projection[10]! * vz + projection[14]! * vw;
      const cw =
        projection[3]! * vx + projection[7]! * vy + projection[11]! * vz + projection[15]! * vw;
      screen[i] = ((1 + cx / cw) * rect.width) / 2;
      screen[i + 1] = ((1 - cy / cw) * rect.height) / 2;
      screen[i + 2] = cw > 0 && cz >= -cw && cz <= cw ? 1 : 0;
    }
    ctx.clearRect(0, 0, rect.width, rect.height);
    ctx.lineWidth = 1;
    for (let box = 0; box < this.geometry.frames.length; box++) {
      const frame = this.geometry.frames[box]!;
      const offset = box * 27;
      ctx.strokeStyle =
        frame === this.geometry.currentFrame
          ? '#ffe066'
          : frame < this.geometry.currentFrame
            ? '#55cfff'
            : '#fa85df';
      ctx.beginPath();
      for (let edge = 0; edge < EDGES.length; edge += 2) {
        const a = offset + EDGES[edge]! * 3;
        const b = offset + EDGES[edge + 1]! * 3;
        if (!screen[a + 2] || !screen[b + 2]) continue;
        ctx.moveTo(screen[a]!, screen[a + 1]!);
        ctx.lineTo(screen[b]!, screen[b + 1]!);
      }
      ctx.stroke();
      const center = offset + 24;
      if (screen[center + 2]) {
        ctx.fillStyle = ctx.strokeStyle;
        ctx.beginPath();
        ctx.arc(
          screen[center]!,
          screen[center + 1]!,
          frame === this.geometry.currentFrame ? 5 : 2,
          0,
          2 * Math.PI
        );
        ctx.fill();
      }
      if (box === 0) continue;
      const previous = center - 27;
      if (!screen[center + 2] || !screen[previous + 2]) continue;
      const x = screen[center]!;
      const y = screen[center + 1]!;
      const px = screen[previous]!;
      const py = screen[previous + 1]!;
      const angle = Math.atan2(y - py, x - px);
      const mx = (x + px) / 2;
      const my = (y + py) / 2;
      ctx.beginPath();
      ctx.moveTo(px, py);
      ctx.lineTo(x, y);
      ctx.moveTo(mx - 7 * Math.cos(angle - 0.45), my - 7 * Math.sin(angle - 0.45));
      ctx.lineTo(mx, my);
      ctx.lineTo(mx - 7 * Math.cos(angle + 0.45), my - 7 * Math.sin(angle + 0.45));
      ctx.stroke();
    }
  }

  public dispose(): void {
    this.release();
    this.doc.defaultView?.removeEventListener('keydown', this.keydown, true);
    this.doc.defaultView?.removeEventListener('keyup', this.keyup, true);
    this.doc.defaultView?.removeEventListener('blur', this.release);
    this.doc.defaultView?.removeEventListener('resize', this.resize);
    this.doc.removeEventListener('scroll', this.resize, true);
    this.doc.removeEventListener('visibilitychange', this.release);
  }
}
