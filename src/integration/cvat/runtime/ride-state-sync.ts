import type { CvatObjectStateLike } from './pre-render-enhancer';

export interface RideStateSyncResult {
  readonly clientID: number;
  readonly targetValue: string;
  readonly updatedKeyframes: number;
  readonly totalKeyframes: number;
}

export function getRideStateAttribute(state: CvatObjectStateLike | null | undefined) {
  return state?.label?.attributes?.find(
    (attribute) => attribute.name === 'ride_state' && attribute.mutable
  );
}

/** Update mutable attributes at existing keyframes; CVAT carries them through interpolated frames. */
export async function syncTrackRideState(
  clientID: number,
  current: CvatObjectStateLike
): Promise<RideStateSyncResult> {
  const attribute = getRideStateAttribute(current);
  const targetValue = attribute ? current.attributes?.[attribute.id] : undefined;
  const readState = current.__internal?.save;
  const exportTrack = current.__internal?.export;
  if (
    current.clientID !== clientID ||
    current.objectType !== 'track' ||
    current.shapeType !== 'cuboid' ||
    current.lock ||
    !attribute ||
    (targetValue !== 'true' && targetValue !== 'false') ||
    !readState ||
    !exportTrack ||
    !current.updateFlags?.reset
  ) {
    throw new Error('Unlocked cuboid track with a mutable ride_state checkbox is required');
  }

  const shapes = exportTrack().shapes;
  if (!shapes?.length) throw new Error('Track keyframes are unavailable');
  const frames = [...new Set(shapes.map((shape) => shape.frame))].sort((a, b) => a - b);
  if (frames.some((frame) => !Number.isSafeInteger(frame) || frame < 0)) {
    throw new Error('Invalid track keyframe');
  }

  // Read every native snapshot before making changes. Reset flags makes this a read
  // through CVAT's existing adapter, as used by dimension sync, without saving geometry.
  current.updateFlags.reset();
  const snapshots = frames.map((frame) => {
    const state = readState(frame, current);
    if (
      state.clientID !== clientID ||
      state.frame !== frame ||
      state.lock ||
      !state.attributes ||
      !state.updateFlags?.reset ||
      typeof state.save !== 'function'
    ) {
      throw new Error('CVAT cannot safely update this track');
    }
    return state;
  });

  let updatedKeyframes = 0;
  for (const state of snapshots) {
    if (state.attributes?.[attribute.id] === targetValue) continue;
    state.updateFlags!.reset!();
    state.attributes = { ...state.attributes, [attribute.id]: targetValue };
    state.updateFlags!.attributes = true;
    await state.save!();
    updatedKeyframes += 1;
  }
  return { clientID, targetValue, updatedKeyframes, totalKeyframes: frames.length };
}
