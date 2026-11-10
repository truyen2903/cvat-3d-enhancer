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

function transform(matrix: ArrayLike<number>, point: readonly number[]): number[] {
  return [0, 1, 2, 3].map((row) =>
    [0, 1, 2, 3].reduce((sum, col) => sum + matrix[col * 4 + row]! * point[col]!, 0)
  );
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
  )
    return null;
  const bounds = mesh.geometry?.boundingBox;
  const min = bounds ? [bounds.min.x, bounds.min.y, bounds.min.z] : [Infinity, Infinity, Infinity];
  const max = bounds
    ? [bounds.max.x, bounds.max.y, bounds.max.z]
    : [-Infinity, -Infinity, -Infinity];
  if (!bounds) {
    const positions = mesh.geometry?.attributes?.position;
    if (!positions || (positions.itemSize ?? 3) < 3) return null;
    for (let i = 0; i + 2 < positions.array.length; i += positions.itemSize ?? 3) {
      for (let axis = 0; axis < 3; axis++) {
        min[axis] = Math.min(min[axis]!, positions.array[i + axis]!);
        max[axis] = Math.max(max[axis]!, positions.array[i + axis]!);
      }
    }
  }
  if (![...min, ...max, width, height].every(Number.isFinite) || width <= 0 || height <= 0)
    return null;
  let bottom = -Infinity;
  for (const x of [min[0]!, max[0]!])
    for (const y of [min[1]!, max[1]!])
      for (const z of [min[2]!, max[2]!]) {
        const clip = transform(projection, transform(inverse, transform(world, [x, y, z, 1])));
        if (!clip.every(Number.isFinite) || clip[3]! <= 0) return null;
        bottom = Math.max(bottom, ((1 - clip[1]! / clip[3]!) * height) / 2);
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
    !points.slice(0, 9).every(Number.isFinite) ||
    points.slice(6, 9).some((value) => value <= 0) ||
    ![width, height, frame.halfW, frame.halfH].every(
      (value) => Number.isFinite(value) && value > 0
    ) ||
    Math.abs(frame.up[2]) < 0.5
  )
    return null;

  const axes = cuboidAxes(points);
  const [, centerY] = worldToLocal2d(frame, [points[0]!, points[1]!, points[2]!]);
  // Support of the entire cuboid along camera-up: its lowest slice, even when tilted
  // or inverted. An edge midpoint would miss the final row of the projected box.
  const halfHeight = axes.reduce((sum, axis, i) => {
    const upProjection = axis.reduce((dot, component, j) => dot + component * frame.up[j]!, 0);
    return sum + (Math.abs(upProjection) * points[6 + i]!) / 2;
  }, 0);
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
  public readonly refresh = (): void => {
    for (const [canvas, input] of this.inputs)
      this.update(canvas, input.camera, input.points, input.mesh);
  };
  public constructor(
    private readonly doc: Document,
    private readonly isEnabled: () => boolean = () => true
  ) {
    doc.addEventListener('scroll', this.refresh, true);
    doc.defaultView?.addEventListener('resize', this.refresh);
  }

  public prune(): void {
    for (const canvas of this.inputs.keys()) {
      if (!canvas.isConnected) {
        this.overlays.get(canvas)?.remove();
        this.overlays.delete(canvas);
        this.inputs.delete(canvas);
      }
    }
  }

  public update(
    canvas: HTMLCanvasElement,
    camera: GuideCameraLike,
    points: readonly number[] | null,
    mesh?: GuideMeshLike
  ): void {
    this.prune();
    if (canvas.isConnected) this.inputs.set(canvas, { camera, points, mesh });
    camera.updateMatrixWorld?.(true);
    const frame = readCameraFrame(camera);
    const rect = canvas.getBoundingClientRect();
    const line =
      this.isEnabled() && points
        ? mesh
          ? projectRenderedCuboidBaseGuide(mesh, camera, rect.width, rect.height)
          : frame
            ? projectCuboidBaseGuide(points, frame, rect.width, rect.height)
            : null
        : null;
    let svg = this.overlays.get(canvas);
    if (!line || !canvas.isConnected || !canvas.parentElement) {
      if (svg) svg.style.display = 'none';
      return;
    }
    if (!svg || !svg.isConnected) {
      svg = this.doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.classList.add(BASE_GUIDE_CLASS);
      svg.setAttribute('aria-hidden', 'true');
      svg.style.cssText =
        'position:fixed !important; pointer-events:none !important; z-index:1000; overflow:hidden; margin:0 !important; padding:0 !important; border:0 !important;';
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
    const setStyle = (
      key: 'left' | 'top' | 'width' | 'height' | 'display',
      value: string
    ): void => {
      if (svg.style[key] !== value) svg.style[key] = value;
    };
    const viewBox = `0 0 ${rect.width} ${rect.height}`;
    if (svg.getAttribute('viewBox') !== viewBox) svg.setAttribute('viewBox', viewBox);
    setStyle('display', 'block');
    setStyle('left', `${rect.left}px`);
    setStyle('top', `${rect.top}px`);
    setStyle('width', `${rect.width}px`);
    setStyle('height', `${rect.height}px`);
    for (const path of svg.children)
      for (const [key, value] of Object.entries(line)) {
        const text = value.toFixed(2);
        if (path.getAttribute(key) !== text) path.setAttribute(key, text);
      }
  }

  public clear(): void {
    for (const svg of this.overlays.values()) svg.remove();
    this.overlays.clear();
    this.inputs.clear();
    this.doc.removeEventListener('scroll', this.refresh, true);
    this.doc.defaultView?.removeEventListener('resize', this.refresh);
  }
}
