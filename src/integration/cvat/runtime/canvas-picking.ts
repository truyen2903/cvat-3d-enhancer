/**
 * Screen-space helpers for canvas multi-select. Everything here runs once per pointer release
 * (never per render frame) and works from the camera most recently used to render the canvas.
 */
import { cuboidAxes } from './ortho-cuboid-editor';

export interface ProjectionCamera {
  projectionMatrix?: { elements: ArrayLike<number> };
  matrixWorldInverse?: { elements: ArrayLike<number> };
  matrixWorld?: { elements?: ArrayLike<number> };
}

export interface ClientRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export interface ScreenBox {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

export interface PickableBox {
  readonly id: number;
  readonly points: ArrayLike<number>;
}

/** Client-space position of a world point. Returns false when it is behind or outside the frustum. */
export function projectToClient(
  camera: ProjectionCamera,
  canvas: ClientRect,
  x: number,
  y: number,
  z: number,
  out: [number, number]
): boolean {
  const view = camera.matrixWorldInverse?.elements;
  const projection = camera.projectionMatrix?.elements;
  if (!view || !projection) return false;
  const vx = view[0]! * x + view[4]! * y + view[8]! * z + view[12]!;
  const vy = view[1]! * x + view[5]! * y + view[9]! * z + view[13]!;
  const vz = view[2]! * x + view[6]! * y + view[10]! * z + view[14]!;
  const vw = view[3]! * x + view[7]! * y + view[11]! * z + view[15]!;
  const cx = projection[0]! * vx + projection[4]! * vy + projection[8]! * vz + projection[12]! * vw;
  const cy = projection[1]! * vx + projection[5]! * vy + projection[9]! * vz + projection[13]! * vw;
  const cz =
    projection[2]! * vx + projection[6]! * vy + projection[10]! * vz + projection[14]! * vw;
  const cw =
    projection[3]! * vx + projection[7]! * vy + projection[11]! * vz + projection[15]! * vw;
  out[0] = canvas.left + ((1 + cx / cw) * canvas.width) / 2;
  out[1] = canvas.top + ((1 - cy / cw) * canvas.height) / 2;
  return cw > 0 && cz >= -cw && cz <= cw;
}

export function normalizeBox(ax: number, ay: number, bx: number, by: number): ScreenBox {
  return {
    left: Math.min(ax, bx),
    top: Math.min(ay, by),
    right: Math.max(ax, bx),
    bottom: Math.max(ay, by),
  };
}

export function insideBox(box: ScreenBox, x: number, y: number): boolean {
  return x >= box.left && x <= box.right && y >= box.top && y <= box.bottom;
}

/** Ids whose projected box center lies inside the screen rectangle. O(N), one pass. */
export function selectCentersInBox(
  camera: ProjectionCamera,
  canvas: ClientRect,
  boxes: Iterable<PickableBox>,
  rect: ScreenBox
): number[] {
  const ids: number[] = [];
  const out: [number, number] = [0, 0];
  for (const box of boxes) {
    const p = box.points;
    if (p.length < 3) continue;
    if (
      projectToClient(camera, canvas, p[0]!, p[1]!, p[2]!, out) &&
      insideBox(rect, out[0], out[1])
    )
      ids.push(box.id);
  }
  return ids;
}

/** Screen-space bounding box of the eight corners of each box (only boxes fully in front). */
export function projectedBounds(
  camera: ProjectionCamera,
  canvas: ClientRect,
  boxes: Iterable<PickableBox>
): ScreenBox | null {
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  const out: [number, number] = [0, 0];
  for (const box of boxes) {
    const p = box.points;
    if (p.length < 9) continue;
    const axes = cuboidAxes(Array.from(p));
    for (let corner = 0; corner < 8; corner++) {
      const w = [p[0]!, p[1]!, p[2]!];
      for (let k = 0; k < 3; k++) {
        const sign = corner & (1 << k) ? 1 : -1;
        const half = (sign * p[6 + k]!) / 2;
        w[0]! += half * axes[k]![0]!;
        w[1]! += half * axes[k]![1]!;
        w[2]! += half * axes[k]![2]!;
      }
      if (!projectToClient(camera, canvas, w[0]!, w[1]!, w[2]!, out)) continue;
      left = Math.min(left, out[0]);
      right = Math.max(right, out[0]);
      top = Math.min(top, out[1]);
      bottom = Math.max(bottom, out[1]);
    }
  }
  return left <= right ? { left, top, right, bottom } : null;
}

export function expandBox(box: ScreenBox, margin: number): ScreenBox {
  return {
    left: box.left - margin,
    top: box.top - margin,
    right: box.right + margin,
    bottom: box.bottom + margin,
  };
}

interface Ray {
  readonly o: readonly [number, number, number];
  readonly d: readonly [number, number, number];
}

/** World ray under a client position; handles perspective and orthographic projections. */
export function rayFromClient(
  camera: ProjectionCamera,
  canvas: ClientRect,
  clientX: number,
  clientY: number
): Ray | null {
  const proj = camera.projectionMatrix?.elements;
  const world = camera.matrixWorld?.elements;
  if (!proj || !world || !proj[0] || !proj[5] || canvas.width <= 0 || canvas.height <= 0)
    return null;
  const nx = ((clientX - canvas.left) / canvas.width) * 2 - 1;
  const ny = -(((clientY - canvas.top) / canvas.height) * 2 - 1);
  const perspective = proj[15] === 0;
  const ov: [number, number, number] = perspective
    ? [0, 0, 0]
    : [(nx - proj[12]!) / proj[0], (ny - proj[13]!) / proj[5], 0];
  const dv: [number, number, number] = perspective ? [nx / proj[0], ny / proj[5], -1] : [0, 0, -1];
  const m = world;
  const point = (v: readonly [number, number, number]): [number, number, number] => [
    m[0]! * v[0] + m[4]! * v[1] + m[8]! * v[2] + m[12]!,
    m[1]! * v[0] + m[5]! * v[1] + m[9]! * v[2] + m[13]!,
    m[2]! * v[0] + m[6]! * v[1] + m[10]! * v[2] + m[14]!,
  ];
  const dir = (v: readonly [number, number, number]): [number, number, number] => [
    m[0]! * v[0] + m[4]! * v[1] + m[8]! * v[2],
    m[1]! * v[0] + m[5]! * v[1] + m[9]! * v[2],
    m[2]! * v[0] + m[6]! * v[1] + m[10]! * v[2],
  ];
  return { o: point(ov), d: dir(dv) };
}

/** Slab test against the oriented box (local axes from Euler XYZ). Returns entry distance or null. */
export function intersectRayBox(ray: Ray, points: ArrayLike<number>): number | null {
  if (points.length < 9) return null;
  const axes = cuboidAxes(Array.from(points));
  let tMin = 0;
  let tMax = Infinity;
  for (let k = 0; k < 3; k++) {
    const axis = axes[k]!;
    const half = Math.abs(points[6 + k]!) / 2;
    const px =
      (ray.o[0] - points[0]!) * axis[0]! +
      (ray.o[1] - points[1]!) * axis[1]! +
      (ray.o[2] - points[2]!) * axis[2]!;
    const dx = ray.d[0] * axis[0]! + ray.d[1] * axis[1]! + ray.d[2] * axis[2]!;
    if (Math.abs(dx) < 1e-12) {
      if (px < -half || px > half) return null;
      continue;
    }
    let t1 = (-half - px) / dx;
    let t2 = (half - px) / dx;
    if (t1 > t2) [t1, t2] = [t2, t1];
    tMin = Math.max(tMin, t1);
    tMax = Math.min(tMax, t2);
    if (tMin > tMax) return null;
  }
  return tMin;
}

/** Nearest box under the pointer, or null. */
export function pickNearestBox(
  camera: ProjectionCamera,
  canvas: ClientRect,
  clientX: number,
  clientY: number,
  boxes: Iterable<PickableBox>
): number | null {
  const ray = rayFromClient(camera, canvas, clientX, clientY);
  if (!ray) return null;
  let best: number | null = null;
  let bestT = Infinity;
  for (const box of boxes) {
    const t = intersectRayBox(ray, box.points);
    if (t !== null && t < bestT) {
      bestT = t;
      best = box.id;
    }
  }
  return best;
}
