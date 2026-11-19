import type { CvatObjectStateLike } from './pre-render-enhancer';

export function wrapYaw(radians: number): number {
  return ((radians % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
}

export function reorientCuboid(points: readonly number[], operation: 'flip' | 'swap'): number[] {
  const next = [...points];
  next[5] = wrapYaw(points[5]! + (operation === 'flip' ? Math.PI : Math.PI / 2));
  if (operation === 'swap') {
    next[6] = points[7]!;
    next[7] = points[6]!;
  }
  return next;
}

export function trackKeyframes(current: CvatObjectStateLike): number[] {
  const shapes = current.__internal?.export?.().shapes;
  if (!shapes?.length || shapes.some((s) => !Number.isSafeInteger(s.frame) || s.frame < 0)) {
    throw new Error('Track keyframes are unavailable');
  }
  return [...new Set(shapes.map((s) => s.frame))].sort((a, b) => a - b);
}

/** Reset update flags before using CVAT's native save adapter as a snapshot read. */
export function readTrackSnapshots(
  clientID: number,
  current: CvatObjectStateLike,
  frames: readonly number[]
): CvatObjectStateLike[] {
  if (
    current.clientID !== clientID ||
    current.objectType !== 'track' ||
    current.shapeType !== 'cuboid' ||
    current.lock ||
    !current.__internal?.save ||
    !current.updateFlags?.reset
  ) {
    throw new Error('Unlocked cuboid track with native snapshot access is required');
  }
  current.updateFlags.reset();
  return frames.map((frame) => {
    const state = current.__internal!.save!(frame, current);
    if (
      state.clientID !== clientID ||
      state.frame !== frame ||
      state.lock ||
      !state.updateFlags?.reset ||
      !state.points ||
      state.points.length < 9 ||
      !state.points.every(Number.isFinite)
    ) {
      throw new Error('CVAT cannot safely read this track');
    }
    return state;
  });
}

function writePoints(
  current: CvatObjectStateLike,
  states: readonly CvatObjectStateLike[],
  points: readonly number[][]
): number {
  for (let i = 0; i < states.length; i++) {
    const state = states[i]!;
    state.updateFlags!.reset!();
    state.points = points[i]!;
    state.updateFlags!.points = true;
    current.__internal!.save!(state.frame!, state);
  }
  return states.length;
}

/** Snapshot every target before writes, so interpolation reads never observe earlier edits. */
export async function reorientTrack(
  clientID: number,
  current: CvatObjectStateLike,
  operation: 'flip' | 'swap',
  wholeTrack = false
): Promise<number> {
  const frames = wholeTrack ? trackKeyframes(current) : [current.frame!];
  if (frames.some((f) => !Number.isSafeInteger(f) || f < 0))
    throw new Error('Current frame is unavailable');
  const states = readTrackSnapshots(clientID, current, frames);
  return writePoints(
    current,
    states,
    states.map((s) => reorientCuboid(s.points!, operation))
  );
}

/** Endpoints stay intact; every interior frame keeps native interpolated geometry except rz. */
export async function interpolateTrackYaw(
  clientID: number,
  current: CvatObjectStateLike,
  range?: readonly [number, number]
): Promise<number> {
  const keyframes = trackKeyframes(current);
  const frame = current.frame!;
  const start = range?.[0] ?? keyframes.filter((f) => f < frame).at(-1);
  const end = range?.[1] ?? keyframes.find((f) => f > frame);
  if (start === undefined || end === undefined)
    throw new Error('Cần hai keyframe bao quanh frame hiện tại');
  if (start >= end || !keyframes.includes(start) || !keyframes.includes(end))
    throw new Error('Chọn hai keyframe theo thứ tự tăng dần');
  // Bound accidental UI stalls on unusually long tracks; no job-wide scans or server reads.
  if (end - start > 10000) throw new Error('Khoảng nội suy vượt quá 10000 frame');
  const frames = Array.from({ length: end - start + 1 }, (_, i) => start + i);
  const states = readTrackSnapshots(clientID, current, frames);
  if (states.some((s) => s.outside)) throw new Error('Không nội suy qua frame outside');
  const from = states[0]!.points![5]!;
  const to = states.at(-1)!.points![5]!;
  const delta = wrapYaw(to - from + Math.PI) - Math.PI;
  const interior = states.slice(1, -1);
  const points = interior.map((s) => {
    const next = [...s.points!];
    next[5] = wrapYaw(from + (delta * (s.frame! - start)) / (end - start));
    return next;
  });
  return writePoints(current, interior, points);
}
