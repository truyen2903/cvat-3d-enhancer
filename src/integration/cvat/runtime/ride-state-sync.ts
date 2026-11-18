import type { CvatObjectStateLike } from './pre-render-enhancer';

export interface RideStateSyncResult {
  readonly clientID: number;
  readonly targetValue: string;
  readonly updatedKeyframes: number;
  readonly totalKeyframes: number;
  /** Outside keyframes included in the sync (their outside flag is preserved). */
  readonly outsideKeyframes?: number;
}

type RideStateAttribute = NonNullable<
  NonNullable<CvatObjectStateLike['label']>['attributes']
>[number];

const labelRideStateCache = new WeakMap<object, RideStateAttribute | undefined>();

export function getRideStateAttribute(
  state: CvatObjectStateLike | null | undefined
): RideStateAttribute | undefined {
  const label = state?.label;
  if (!label || typeof label !== 'object') return undefined;
  if (labelRideStateCache.has(label)) {
    return labelRideStateCache.get(label);
  }
  const found = label.attributes?.find(
    (attribute) => attribute.name === 'ride_state' && attribute.mutable
  );
  labelRideStateCache.set(label, found);
  return found;
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
  const uniqueFrames = new Set<number>();
  for (const shape of shapes) {
    const frame = shape.frame;
    if (!Number.isSafeInteger(frame) || frame < 0) {
      throw new Error('Invalid track keyframe');
    }
    uniqueFrames.add(frame);
  }
  const frames = [...uniqueFrames].sort((a, b) => a - b);

  // Read every native snapshot before making changes. Reset flags makes this a read
  // through CVAT's existing adapter, as used by dimension sync, without saving geometry.
  current.updateFlags.reset();
  const snapshots: CvatObjectStateLike[] = [];
  let outsideKeyframes = 0;
  for (const frame of frames) {
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
    if (state.outside) outsideKeyframes += 1;
    snapshots.push(state);
  }

  let updatedKeyframes = 0;
  // Outside keyframes are updated too: when the object reappears, CVAT carries the value
  // from the last keyframe, so a stale outside keyframe would revert ride_state.
  for (const state of snapshots) {
    if (state.attributes?.[attribute.id] === targetValue) continue;
    state.updateFlags!.reset!();
    state.attributes = { ...state.attributes, [attribute.id]: targetValue };
    state.updateFlags!.attributes = true;
    await state.save!();
    updatedKeyframes += 1;
  }
  return {
    clientID,
    targetValue,
    updatedKeyframes,
    totalKeyframes: frames.length,
    outsideKeyframes,
  };
}
