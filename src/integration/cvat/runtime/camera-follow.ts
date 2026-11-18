/**
 * Active-object camera follow for the CVAT 3D perspective view.
 *
 * When an object (track) is active and the user switches frames (Next / Previous / jump),
 * the object usually moves in world coordinates while CVAT keeps the perspective camera still,
 * so the active box "jumps away" on screen. This module translates the perspective camera
 * (position AND orbit target, keeping zoom/rotation) by exactly the active box's center delta
 * between the previous frame and the new frame, so the active box stays pinned at the same
 * screen position across frames.
 *
 * - Same-frame edits (dragging/resizing the box) only update the tracked center, never move the camera.
 * - Changing the active object (or deactivating) resets tracking without moving the camera.
 */

import { findObjectStateByClientId, isNumericClientIdName } from './state-lookup';

export interface Vector3Like {
  x: number;
  y: number;
  z: number;
  clone?: () => Vector3Like;
  set?: (x: number, y: number, z: number) => unknown;
}

export interface CameraControlsLike {
  getTarget?: (out: Vector3Like, receiveEndValue?: boolean) => Vector3Like;
  getPosition?: (out: Vector3Like, receiveEndValue?: boolean) => Vector3Like;
  setLookAt?: (
    px: number,
    py: number,
    pz: number,
    tx: number,
    ty: number,
    tz: number,
    enableTransition?: boolean
  ) => unknown;
}

interface FollowStateLike {
  readonly clientID?: number | string;
  readonly points?: readonly number[];
  readonly frame?: number;
  readonly hidden?: boolean;
  readonly outside?: boolean;
}
export interface FollowEntryLike {
  readonly data?: FollowStateLike | null;
  readonly state?: FollowStateLike | null;
}

export interface FollowViewLike {
  views?: {
    perspective?: {
      camera?: { position?: Vector3Like } | null;
      controls?: CameraControlsLike | null;
    };
    [key: string]: unknown;
  };
  drawnObjects?: Record<number | string, FollowEntryLike | undefined>;
  getDrawnObjectById?: (clientID: number) => FollowEntryLike | null | undefined;
  render?: () => void;
}

export interface FollowModelLike {
  data?: {
    imageID?: number | null;
    isFrameUpdating?: boolean;
    objects?: readonly FollowStateLike[];
  } | null;
  objects?: readonly FollowStateLike[];
}

interface TrackedState {
  clientID: string;
  frame: number;
  cx: number;
  cy: number;
  cz: number;
}

const FOLLOW_MARKER = '__cvat3dEnhancerCameraFollow';

function hasValidFrame(source: FollowStateLike | null | undefined): source is FollowStateLike {
  return Boolean(source && typeof source.frame === 'number' && Number.isFinite(source.frame));
}

export function readEntryCenter(
  entry: FollowEntryLike | undefined
): [number, number, number] | null {
  const pts = entry?.state?.points ?? entry?.data?.points;
  if (!pts || pts.length < 3) {
    return null;
  }
  const x = Number(pts[0]);
  const y = Number(pts[1]);
  const z = Number(pts[2]);
  return Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z) ? [x, y, z] : null;
}

/**
 * Translates the perspective camera + orbit target by (dx, dy, dz) instantly (no transition).
 */
export function translatePerspectiveCamera(
  view: FollowViewLike,
  dx: number,
  dy: number,
  dz: number
): boolean {
  const persp = view.views?.perspective;
  const camPos = persp?.camera?.position;
  const controls = persp?.controls;
  if (!camPos) {
    return false;
  }

  if (
    controls &&
    typeof controls.getTarget === 'function' &&
    typeof controls.setLookAt === 'function'
  ) {
    const targetOut: Vector3Like =
      typeof camPos.clone === 'function' ? camPos.clone() : { x: 0, y: 0, z: 0 };
    const target = controls.getTarget(targetOut, false) ?? targetOut;
    let position: Vector3Like = camPos;
    if (typeof controls.getPosition === 'function') {
      const posOut: Vector3Like =
        typeof camPos.clone === 'function' ? camPos.clone() : { x: 0, y: 0, z: 0 };
      position = controls.getPosition(posOut, false) ?? posOut;
    }
    if (
      !Number.isFinite(position.x) ||
      !Number.isFinite(position.y) ||
      !Number.isFinite(position.z) ||
      !Number.isFinite(target.x) ||
      !Number.isFinite(target.y) ||
      !Number.isFinite(target.z)
    ) {
      return false;
    }
    controls.setLookAt(
      position.x + dx,
      position.y + dy,
      position.z + dz,
      target.x + dx,
      target.y + dy,
      target.z + dz,
      false
    );
    return true;
  }

  // A partial/loading controls instance can overwrite direct camera mutations on its next update.
  if (controls) return false;
  if (typeof camPos.set === 'function') {
    camPos.set(camPos.x + dx, camPos.y + dy, camPos.z + dz);
  } else {
    camPos.x += dx;
    camPos.y += dy;
    camPos.z += dz;
  }
  return true;
}

export class ActiveObjectCameraFollower {
  private tracked: TrackedState | null = null;
  private cachedModelObjects: readonly FollowStateLike[] | null = null;
  private cachedModelObjectsLen = -1;
  private cachedLookupId: string | null = null;
  private cachedModelState: FollowStateLike | null = null;

  public constructor(
    private readonly getActiveClientId: () => string | null,
    private readonly isEnabled: () => boolean
  ) {}

  public reset(): void {
    this.tracked = null;
    this.cachedModelObjects = null;
    this.cachedModelObjectsLen = -1;
    this.cachedLookupId = null;
    this.cachedModelState = null;
  }

  private resolveModelState(
    modelObjects: readonly FollowStateLike[] | undefined,
    activeId: string
  ): FollowStateLike | undefined {
    if (!modelObjects || modelObjects.length === 0) {
      return undefined;
    }
    if (
      this.cachedModelObjects === modelObjects &&
      this.cachedModelObjectsLen === modelObjects.length &&
      this.cachedLookupId === activeId
    ) {
      return this.cachedModelState ?? undefined;
    }

    let found: FollowStateLike | undefined;
    if (isNumericClientIdName(activeId as unknown)) {
      const numericId = Number(activeId);
      if (Number.isFinite(numericId)) {
        found = findObjectStateByClientId(modelObjects, numericId) ?? undefined;
      }
    } else {
      const trimmed = activeId.trim();
      const parsed = trimmed.length > 0 ? Number(trimmed) : NaN;
      if (Number.isFinite(parsed)) {
        found = findObjectStateByClientId(modelObjects, parsed) ?? undefined;
      }
      if (!found) {
        found = modelObjects.find((state) => String(state.clientID) === activeId);
      }
    }

    this.cachedModelObjects = modelObjects;
    this.cachedModelObjectsLen = modelObjects.length;
    this.cachedLookupId = activeId;
    this.cachedModelState = found ?? null;
    return found;
  }

  /**
   * Must be called once per render tick (before the scene is drawn).
   */
  public tick(view: FollowViewLike, model?: FollowModelLike | null): void {
    if (!this.isEnabled()) {
      this.tracked = null;
      return;
    }
    // Loading may temporarily clear activation as well as advance imageID.
    if (model?.data?.isFrameUpdating) return;
    const activeId = this.getActiveClientId();
    if (activeId === null) {
      this.tracked = null;
      return;
    }

    if (this.tracked && this.tracked.clientID !== activeId) this.reset();

    let entry: FollowEntryLike | undefined;
    if (typeof view.getDrawnObjectById === 'function' && isNumericClientIdName(activeId)) {
      const numericId = Number(activeId);
      if (Number.isFinite(numericId)) {
        entry = view.getDrawnObjectById(numericId) ?? undefined;
      }
    } else {
      entry = view.drawnObjects?.[activeId];
    }
    const entryState = entry?.state ?? undefined;
    const entryData = entry?.data ?? undefined;
    const modelFrame = model?.data?.imageID;
    const expectedFrame =
      typeof modelFrame === 'number' && Number.isFinite(modelFrame) ? modelFrame : null;

    // Fast-path O(1): if drawnObjects already holds a snapshot matching expectedFrame
    // (or any valid frame when modelFrame is unavailable), use it without touching model.objects.
    let source: FollowStateLike | undefined;
    if (expectedFrame !== null) {
      if (entryState && entryState.frame === expectedFrame) {
        source = entryState;
      } else if (entryData && entryData.frame === expectedFrame) {
        source = entryData;
      }
    } else if (hasValidFrame(entryState)) {
      source = entryState;
    } else if (hasValidFrame(entryData)) {
      source = entryData;
    }

    // CVAT can advance imageID before replacing the drawn objects. Only consult model.objects
    // via O(log N) / O(1)-cached lookup when drawnObjects does not yet match expectedFrame.
    if (!source) {
      const modelObjects = model?.data?.objects ?? model?.objects;
      const modelState = this.resolveModelState(modelObjects, activeId);
      if (expectedFrame !== null) {
        if (modelState && modelState.frame === expectedFrame) {
          source = modelState;
        } else if (
          !hasValidFrame(modelState) &&
          !hasValidFrame(entryState) &&
          !hasValidFrame(entryData)
        ) {
          source = modelState ?? entryState ?? entryData;
        }
      } else if (hasValidFrame(modelState)) {
        source = modelState;
      }
    }

    if (!source || source.hidden || source.outside) return;
    const pts = source.points;
    if (!pts || pts.length < 3) return;
    const cx = Number(pts[0]);
    const cy = Number(pts[1]);
    const cz = Number(pts[2]);
    if (!Number.isFinite(cx) || !Number.isFinite(cy) || !Number.isFinite(cz)) return;

    const frame = expectedFrame ?? source.frame;
    if (typeof frame !== 'number' || !Number.isFinite(frame)) return;

    const prev = this.tracked;
    if (!prev || prev.clientID !== activeId) {
      this.tracked = { clientID: activeId, frame, cx, cy, cz };
      return;
    }

    if (prev.frame !== frame) {
      const dx = cx - prev.cx;
      const dy = cy - prev.cy;
      const dz = cz - prev.cz;
      if (Math.abs(dx) + Math.abs(dy) + Math.abs(dz) > 1e-6) {
        if (!translatePerspectiveCamera(view, dx, dy, dz)) return;
      }
    }
    // Same frame: follow box drag/resize in-place (zero allocation) so next frame delta is exact.
    prev.frame = frame;
    prev.cx = cx;
    prev.cy = cy;
    prev.cz = cz;
  }
}

/**
 * Wraps `view.render()` (idempotent) so the follower runs right before CVAT draws each frame.
 */
export function attachActiveObjectCameraFollow(
  view: FollowViewLike | null | undefined,
  follower: ActiveObjectCameraFollower,
  getModel: () => FollowModelLike | null | undefined,
  isCurrentView: () => boolean = () => true
): boolean {
  if (!view || typeof view.render !== 'function') {
    return false;
  }
  const marked = view as FollowViewLike & { [FOLLOW_MARKER]?: boolean };
  if (marked[FOLLOW_MARKER]) {
    return true;
  }
  const origRender = view.render.bind(view);
  view.render = (): void => {
    try {
      if (isCurrentView()) follower.tick(view, getModel());
    } catch {
      // Never break CVAT rendering
    }
    origRender();
  };
  marked[FOLLOW_MARKER] = true;
  return true;
}
