/**
 * Static anchor math for ego-frame LiDAR jobs: two static objects keep their relative pose, so a
 * target A at the current frame f follows from anchor B at f and both boxes at a reference frame K.
 *
 * Yaw-only (no roll/pitch noise amplification), cuboid points `[x, y, z, rx, ry, rz, L, W, H, …]`:
 *   Δψ    = wrapPi(ψB_f − ψB_K)
 *   xyA_f = xyB_f + Rot(Δψ) · (xyA_K − xyB_K)
 *   zA_f  = zA_K + (zB_f − zB_K)
 *   rzA_f = wrapYaw(ψA_K + Δψ); rx, ry, L, W, H of A_K; tail `points[9…]` of A_f.
 * Equivalent to A_f = (M_B_f · M_B_K⁻¹) · A_K when rx = ry = 0.
 */
import type { CvatObjectStateLike } from './pre-render-enhancer';
import { wrapYaw } from './track-editing';

/** Relative change of any anchor dimension between K and f above which the anchor is refused. */
export const ANCHOR_SIZE_TOLERANCE = 0.1;
/** Anchor yaw change above which a heading flip is assumed. */
export const ANCHOR_MAX_YAW_DELTA = (3 * Math.PI) / 4;

const ONE_DEGREE = Math.PI / 180;

function validBox(points: readonly number[]): boolean {
  if (points.length < 9) return false;
  for (let i = 0; i < 9; i += 1) if (!Number.isFinite(points[i])) return false;
  return true;
}

/** Signed yaw change in (−π, π]. */
function yawDelta(from: number, to: number): number {
  return wrapYaw(to - from + Math.PI) - Math.PI;
}

export function predictFromAnchor(
  anchorRef: readonly number[],
  targetRef: readonly number[],
  anchorNow: readonly number[],
  targetNow: readonly number[]
): number[] | null {
  if (![anchorRef, targetRef, anchorNow, targetNow].every(validBox)) return null;
  if (targetRef[6]! <= 0 || targetRef[7]! <= 0 || targetRef[8]! <= 0) return null;
  const delta = yawDelta(anchorRef[5]!, anchorNow[5]!);
  const cos = Math.cos(delta);
  const sin = Math.sin(delta);
  const dx = targetRef[0]! - anchorRef[0]!;
  const dy = targetRef[1]! - anchorRef[1]!;
  const next = [...targetNow];
  next[0] = anchorNow[0]! + cos * dx - sin * dy;
  next[1] = anchorNow[1]! + sin * dx + cos * dy;
  next[2] = targetRef[2]! + (anchorNow[2]! - anchorRef[2]!);
  next[3] = targetRef[3]!;
  next[4] = targetRef[4]!;
  next[5] = wrapYaw(targetRef[5]! + delta);
  next[6] = targetRef[6]!;
  next[7] = targetRef[7]!;
  next[8] = targetRef[8]!;
  return next;
}

export type AnchorCheck = 'ok' | 'size-changed' | 'heading-flip';

export function checkAnchorConsistency(
  anchorRef: readonly number[],
  anchorNow: readonly number[]
): AnchorCheck {
  for (let i = 6; i < 9; i += 1) {
    const ref = anchorRef[i]!;
    if (!(ref > 0) || Math.abs(anchorNow[i]! - ref) / ref > ANCHOR_SIZE_TOLERANCE)
      return 'size-changed';
  }
  return Math.abs(yawDelta(anchorRef[5]!, anchorNow[5]!)) > ANCHOR_MAX_YAW_DELTA
    ? 'heading-flip'
    : 'ok';
}

export interface KeyShape {
  readonly frame: number;
  readonly outside?: boolean;
}

/** Keyframes of a track where it is inside, ascending; null when unreadable or not a track. */
export function insideKeyframes(state: CvatObjectStateLike): number[] | null {
  if (state.objectType !== 'track') return null;
  let shapes: readonly KeyShape[] | undefined;
  try {
    shapes = state.__internal?.export?.().shapes;
  } catch {
    return null;
  }
  if (!Array.isArray(shapes)) return null;
  const frames = new Set<number>();
  for (const shape of shapes) {
    if (!Number.isSafeInteger(shape.frame) || shape.frame < 0) return null;
    if (shape.outside !== true) frames.add(shape.frame);
  }
  return [...frames].sort((a, b) => a - b);
}

/** Nearest common keyframe other than `frame`; the earlier one on ties. */
export function pickReferenceFrame(
  frame: number,
  anchorKeys: readonly number[],
  targetKeys: readonly number[]
): number | null {
  const anchor = new Set(anchorKeys);
  let best: number | null = null;
  for (const k of targetKeys) {
    if (k === frame || !anchor.has(k)) continue;
    const distance = Math.abs(k - frame);
    const bestDistance = best === null ? Infinity : Math.abs(best - frame);
    if (distance < bestDistance || (distance === bestDistance && k < best!)) best = k;
  }
  return best;
}

/** Position error at the target (m) if the anchor yaw is off by 1°. */
export function anchorErrorAt1Deg(
  anchorRef: readonly number[],
  targetRef: readonly number[]
): number {
  return (
    Math.hypot(targetRef[0]! - anchorRef[0]!, targetRef[1]! - anchorRef[1]!) * Math.sin(ONE_DEGREE)
  );
}
