import { ensureMeowStyle } from './meow-ui';
import { cuboidAxes, readCameraFrame, worldToLocal2d } from './ortho-cuboid-editor';
import type { CameraFrame, OrthoCameraLike } from './ortho-cuboid-editor';

export const BASE_GUIDE_CLASS = 'cvat-3d-enhancer-base-guide';
export interface GuideLine {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface GuideMeshLike {
  matrixWorld?: { elements: ArrayLike<number> };
  geometry?: {
    boundingBox?: {
      min: { x: number; y: number; z: number };
      max: { x: number; y: number; z: number };
    } | null;
    attributes?: { position?: { array: ArrayLike<number>; itemSize?: number } };
  };
}
export interface GuideCameraLike extends OrthoCameraLike {
  projectionMatrix?: { elements: ArrayLike<number> };
  matrixWorldInverse?: { elements: ArrayLike<number> };
}

interface CachedCanvasRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/** Use exactly the mesh transform and camera matrices used by WebGL, including live drags. */
export function projectRenderedCuboidBaseGuide(
  mesh: GuideMeshLike,
  camera: GuideCameraLike,
  width: number,
  height: number
): GuideLine | null {
  const world = mesh.matrixWorld?.elements;
  const inverse = camera.matrixWorldInverse?.elements;
  const projection = camera.projectionMatrix?.elements;
  if (
    !world ||
    !inverse ||
    !projection ||
    world.length < 16 ||
    inverse.length < 16 ||
    projection.length < 16
  ) {
    return null;
  }

  const bounds = mesh.geometry?.boundingBox;
  let minX: number;
  let minY: number;
  let minZ: number;
  let maxX: number;
  let maxY: number;
  let maxZ: number;

  if (bounds) {
    minX = bounds.min.x;
    minY = bounds.min.y;
    minZ = bounds.min.z;
    maxX = bounds.max.x;
    maxY = bounds.max.y;
    maxZ = bounds.max.z;
  } else {
    const positions = mesh.geometry?.attributes?.position;
    const itemSize = positions?.itemSize ?? 3;
    if (!positions || itemSize < 3) {
      return null;
    }
    minX = Infinity;
    minY = Infinity;
    minZ = Infinity;
    maxX = -Infinity;
    maxY = -Infinity;
    maxZ = -Infinity;
    const arr = positions.array;
    const arrLen = arr.length;
    for (let i = 0; i + 2 < arrLen; i += itemSize) {
      const px = arr[i]!;
      const py = arr[i + 1]!;
      const pz = arr[i + 2]!;
      if (px < minX) minX = px;
      if (py < minY) minY = py;
      if (pz < minZ) minZ = pz;
      if (px > maxX) maxX = px;
      if (py > maxY) maxY = py;
      if (pz > maxZ) maxZ = pz;
    }
  }

  if (
    !Number.isFinite(minX) ||
    !Number.isFinite(minY) ||
    !Number.isFinite(minZ) ||
    !Number.isFinite(maxX) ||
    !Number.isFinite(maxY) ||
    !Number.isFinite(maxZ) ||
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0
  ) {
    return null;
  }

  const w0 = world[0]!;
  const w1 = world[1]!;
  const w2 = world[2]!;
  const w3 = world[3]!;
  const w4 = world[4]!;
  const w5 = world[5]!;
  const w6 = world[6]!;
  const w7 = world[7]!;
  const w8 = world[8]!;
  const w9 = world[9]!;
  const w10 = world[10]!;
  const w11 = world[11]!;
  const w12 = world[12]!;
  const w13 = world[13]!;
  const w14 = world[14]!;
  const w15 = world[15]!;

  const v0 = inverse[0]!;
  const v1 = inverse[1]!;
  const v2 = inverse[2]!;
  const v3 = inverse[3]!;
  const v4 = inverse[4]!;
  const v5 = inverse[5]!;
  const v6 = inverse[6]!;
  const v7 = inverse[7]!;
  const v8 = inverse[8]!;
  const v9 = inverse[9]!;
  const v10 = inverse[10]!;
  const v11 = inverse[11]!;
  const v12 = inverse[12]!;
  const v13 = inverse[13]!;
  const v14 = inverse[14]!;
  const v15 = inverse[15]!;

  const p0 = projection[0]!;
  const p1 = projection[1]!;
  const p2 = projection[2]!;
  const p3 = projection[3]!;
  const p4 = projection[4]!;
  const p5 = projection[5]!;
  const p6 = projection[6]!;
  const p7 = projection[7]!;
  const p8 = projection[8]!;
  const p9 = projection[9]!;
  const p10 = projection[10]!;
  const p11 = projection[11]!;
  const p12 = projection[12]!;
  const p13 = projection[13]!;
  const p14 = projection[14]!;
  const p15 = projection[15]!;

  let bottom = -Infinity;
  for (let ix = 0; ix < 2; ix += 1) {
    const x = ix === 0 ? minX : maxX;
    for (let iy = 0; iy < 2; iy += 1) {
      const y = iy === 0 ? minY : maxY;
      for (let iz = 0; iz < 2; iz += 1) {
        const z = iz === 0 ? minZ : maxZ;

        const wx = w0 * x + w4 * y + w8 * z + w12;
        const wy = w1 * x + w5 * y + w9 * z + w13;
        const wz = w2 * x + w6 * y + w10 * z + w14;
        const ww = w3 * x + w7 * y + w11 * z + w15;

        const vx = v0 * wx + v4 * wy + v8 * wz + v12 * ww;
        const vy = v1 * wx + v5 * wy + v9 * wz + v13 * ww;
        const vz = v2 * wx + v6 * wy + v10 * wz + v14 * ww;
        const vw = v3 * wx + v7 * wy + v11 * wz + v15 * ww;

        const cx = p0 * vx + p4 * vy + p8 * vz + p12 * vw;
        const cy = p1 * vx + p5 * vy + p9 * vz + p13 * vw;
        const cz = p2 * vx + p6 * vy + p10 * vz + p14 * vw;
        const cw = p3 * vx + p7 * vy + p11 * vz + p15 * vw;

        if (
          !Number.isFinite(cx) ||
          !Number.isFinite(cy) ||
          !Number.isFinite(cz) ||
          !Number.isFinite(cw) ||
          cw <= 0
        ) {
          return null;
        }
        const screenY = ((1 - cy / cw) * height) / 2;
        if (screenY > bottom) {
          bottom = screenY;
        }
      }
    }
  }

  return bottom >= 0 && bottom <= height ? { x1: 0, y1: bottom, x2: width, y2: bottom } : null;
}

/** Extend the lowest projected cuboid slice horizontally across the Side / Front viewport. */
export function projectCuboidBaseGuide(
  points: readonly number[],
  frame: CameraFrame,
  width: number,
  height: number
): GuideLine | null {
  if (
    points.length < 9 ||
    !Number.isFinite(width) ||
    width <= 0 ||
    !Number.isFinite(height) ||
    height <= 0 ||
    !Number.isFinite(frame.halfW) ||
    frame.halfW <= 0 ||
    !Number.isFinite(frame.halfH) ||
    frame.halfH <= 0 ||
    Math.abs(frame.up[2]) < 0.5
  ) {
    return null;
  }

  for (let i = 0; i < 9; i += 1) {
    const val = points[i]!;
    if (!Number.isFinite(val) || (i >= 6 && val <= 0)) {
      return null;
    }
  }

  const axes = cuboidAxes(points);
  const [, centerY] = worldToLocal2d(frame, [points[0]!, points[1]!, points[2]!]);
  // Support of the entire cuboid along camera-up: its lowest slice, even when tilted
  // or inverted. An edge midpoint would miss the final row of the projected box.
  const up0 = frame.up[0];
  const up1 = frame.up[1];
  const up2 = frame.up[2];
  let halfHeight = 0;
  for (let i = 0; i < 3; i += 1) {
    const axis = axes[i]!;
    const upProjection = axis[0] * up0 + axis[1] * up1 + axis[2] * up2;
    halfHeight += (Math.abs(upProjection) * points[6 + i]!) / 2;
  }

  const bottomY = centerY - halfHeight;
  const y = ((1 - (bottomY - frame.cy) / frame.halfH) * height) / 2;
  if (!Number.isFinite(y) || y < 0 || y > height) return null;
  return { x1: 0, y1: y, x2: width, y2: y };
}

/** A non-interactive SVG sibling; never draws into CVAT's WebGL buffer or annotation data. */
export class CuboidBaseGuide {
  private readonly overlays = new Map<HTMLCanvasElement, SVGSVGElement>();
  private readonly inputs = new Map<
    HTMLCanvasElement,
    { camera: GuideCameraLike; points: readonly number[] | null; mesh?: GuideMeshLike }
  >();
  private readonly rectCache = new Map<HTMLCanvasElement, CachedCanvasRect>();
  private readonly observedCanvases = new Set<HTMLCanvasElement>();
  private readonly resizeObserver: ResizeObserver | null;

  public readonly refresh = (): void => {
    this.rectCache.clear();
    for (const [canvas, input] of this.inputs) {
      this.update(canvas, input.camera, input.points, input.mesh);
    }
  };

  public constructor(
    private readonly doc: Document,
    private readonly isEnabled: () => boolean = () => true
  ) {
    const ResizeObserverCtor =
      (doc.defaultView as (Window & { ResizeObserver?: typeof ResizeObserver }) | null)
        ?.ResizeObserver ?? (typeof ResizeObserver === 'function' ? ResizeObserver : undefined);
    if (typeof ResizeObserverCtor === 'function') {
      this.resizeObserver = new ResizeObserverCtor((entries) => {
        for (const entry of entries) {
          const target = entry.target as HTMLCanvasElement;
          const cached = this.rectCache.get(target);
          if (!cached) {
            continue;
          }
          const cr = entry.contentRect;
          if (
            !cr ||
            Math.abs(cr.width - cached.width) > 0.5 ||
            Math.abs(cr.height - cached.height) > 0.5
          ) {
            this.rectCache.delete(target);
          }
        }
      });
    } else {
      this.resizeObserver = null;
    }
    doc.addEventListener('scroll', this.refresh, true);
    doc.defaultView?.addEventListener('resize', this.refresh);
  }

  private observeCanvas(canvas: HTMLCanvasElement): void {
    if (!this.resizeObserver || this.observedCanvases.has(canvas)) {
      return;
    }
    this.observedCanvases.add(canvas);
    this.resizeObserver.observe(canvas);
  }

  private unobserveCanvas(canvas: HTMLCanvasElement): void {
    this.rectCache.delete(canvas);
    if (!this.observedCanvases.delete(canvas)) {
      return;
    }
    this.resizeObserver?.unobserve(canvas);
  }

  public prune(): void {
    for (const canvas of this.inputs.keys()) {
      if (!canvas.isConnected) {
        this.overlays.get(canvas)?.remove();
        this.overlays.delete(canvas);
        this.inputs.delete(canvas);
        this.unobserveCanvas(canvas);
      }
    }
    for (const canvas of this.overlays.keys()) {
      if (!canvas.isConnected) {
        this.overlays.get(canvas)?.remove();
        this.overlays.delete(canvas);
        this.unobserveCanvas(canvas);
      }
    }
  }

  public update(
    canvas: HTMLCanvasElement,
    camera: GuideCameraLike,
    points: readonly number[] | null,
    mesh?: GuideMeshLike
  ): void {
    if (!canvas.isConnected || !canvas.parentElement) {
      const existingSvg = this.overlays.get(canvas);
      if (existingSvg) {
        if (!canvas.isConnected) {
          existingSvg.remove();
          this.overlays.delete(canvas);
        } else if (existingSvg.style.display !== 'none') {
          existingSvg.style.display = 'none';
        }
      }
      this.inputs.delete(canvas);
      this.unobserveCanvas(canvas);
      return;
    }

    const isNewCanvas = !this.inputs.has(canvas);
    this.inputs.set(canvas, { camera, points, mesh });

    if (!this.isEnabled() || !points) {
      const existingSvg = this.overlays.get(canvas);
      if (existingSvg && existingSvg.style.display !== 'none') {
        existingSvg.style.display = 'none';
      }
      return;
    }

    if (isNewCanvas) {
      this.prune();
      this.observeCanvas(canvas);
    }

    camera.updateMatrixWorld?.(true);

    let rect = this.rectCache.get(canvas);
    if (!rect) {
      const domRect = canvas.getBoundingClientRect();
      rect = {
        left: domRect.left,
        top: domRect.top,
        width: domRect.width,
        height: domRect.height,
      };
      this.rectCache.set(canvas, rect);
      this.observeCanvas(canvas);
    }

    let line: GuideLine | null = null;
    if (mesh) {
      line = projectRenderedCuboidBaseGuide(mesh, camera, rect.width, rect.height);
    } else {
      const frame = readCameraFrame(camera);
      if (frame) {
        line = projectCuboidBaseGuide(points, frame, rect.width, rect.height);
      }
    }

    let svg = this.overlays.get(canvas);
    if (!line) {
      if (svg && svg.style.display !== 'none') {
        svg.style.display = 'none';
      }
      return;
    }

    if (!svg || !svg.isConnected) {
      svg = this.doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
      ensureMeowStyle(this.doc);
      svg.classList.add(BASE_GUIDE_CLASS, 'meow-base-guide');
      svg.setAttribute('aria-hidden', 'true');
      svg.setAttribute('preserveAspectRatio', 'none');
      const path = this.doc.createElementNS('http://www.w3.org/2000/svg', 'line');
      path.setAttribute('stroke', '#ef4444');
      path.setAttribute('stroke-width', '1');
      path.setAttribute('vector-effect', 'non-scaling-stroke');
      svg.appendChild(path);
      // Viewport coordinates must not inherit panel transforms, padding or modal offsets.
      (this.doc.fullscreenElement ?? this.doc.documentElement).appendChild(svg);
      this.overlays.set(canvas, svg);
    }

    const viewBox = `0 0 ${rect.width} ${rect.height}`;
    if (svg.getAttribute('viewBox') !== viewBox) svg.setAttribute('viewBox', viewBox);

    const style = svg.style;
    if (style.display !== 'block') style.display = 'block';
    const leftPx = `${rect.left}px`;
    if (style.left !== leftPx) style.left = leftPx;
    const topPx = `${rect.top}px`;
    if (style.top !== topPx) style.top = topPx;
    const widthPx = `${rect.width}px`;
    if (style.width !== widthPx) style.width = widthPx;
    const heightPx = `${rect.height}px`;
    if (style.height !== heightPx) style.height = heightPx;

    const path = svg.firstElementChild;
    if (path) {
      const x1Text = line.x1.toFixed(2);
      const y1Text = line.y1.toFixed(2);
      const x2Text = line.x2.toFixed(2);
      const y2Text = line.y2 === line.y1 ? y1Text : line.y2.toFixed(2);
      if (path.getAttribute('x1') !== x1Text) path.setAttribute('x1', x1Text);
      if (path.getAttribute('y1') !== y1Text) path.setAttribute('y1', y1Text);
      if (path.getAttribute('x2') !== x2Text) path.setAttribute('x2', x2Text);
      if (path.getAttribute('y2') !== y2Text) path.setAttribute('y2', y2Text);
    }
  }

  public clear(): void {
    for (const svg of this.overlays.values()) svg.remove();
    this.overlays.clear();
    this.inputs.clear();
    this.rectCache.clear();
    this.observedCanvases.clear();
    this.resizeObserver?.disconnect();
    this.doc.removeEventListener('scroll', this.refresh, true);
    this.doc.defaultView?.removeEventListener('resize', this.refresh);
  }
}
