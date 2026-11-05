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

export interface FollowEntryLike {
  readonly data?: { readonly points?: readonly number[] } | null;
  readonly state?: { readonly points?: readonly number[]; readonly frame?: number } | null;
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
  render?: () => void;
}

export interface FollowModelLike {
  data?: { imageID?: number | null } | null;
}

interface TrackedState {
  clientID: string;
  frame: number;
  cx: number;
  cy: number;
  cz: number;
}

const FOLLOW_MARKER = '__cvat3dEnhancerCameraFollow';

export function readEntryCenter(entry: FollowEntryLike | undefined): [number, number, number] | null {
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
    const target = controls.getTarget(targetOut, true) ?? targetOut;
    let position: Vector3Like = camPos;
    if (typeof controls.getPosition === 'function') {
      const posOut: Vector3Like =
        typeof camPos.clone === 'function' ? camPos.clone() : { x: 0, y: 0, z: 0 };
      position = controls.getPosition(posOut, true) ?? posOut;
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

  public constructor(
    private readonly getActiveClientId: () => string | null,
    private readonly isEnabled: () => boolean
  ) {}

  public reset(): void {
    this.tracked = null;
  }

  /**
   * Must be called once per render tick (before the scene is drawn).
   */
  public tick(view: FollowViewLike, model?: FollowModelLike | null): void {
    if (!this.isEnabled()) {
      this.tracked = null;
      return;
    }
    const activeId = this.getActiveClientId();
    if (activeId === null) {
      this.tracked = null;
      return;
    }

    const entry = view.drawnObjects?.[activeId];
    const center = readEntryCenter(entry);
    if (!center) {
      // Object not drawn (yet) on this frame - keep the last known position until it appears
      return;
    }

    const stateFrame = entry?.state?.frame;
    const modelFrame = model?.data?.imageID;
    const frame =
      typeof stateFrame === 'number' && Number.isFinite(stateFrame)
        ? stateFrame
        : typeof modelFrame === 'number' && Number.isFinite(modelFrame)
          ? modelFrame
          : NaN;
    if (!Number.isFinite(frame)) {
      return;
    }

    const [cx, cy, cz] = center;
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
        translatePerspectiveCamera(view, dx, dy, dz);
      }
    }
    // Same frame: follow box drag/resize silently so the next frame change is relative to the final position
    this.tracked = { clientID: activeId, frame, cx, cy, cz };
  }
}

/**
 * Wraps `view.render()` (idempotent) so the follower runs right before CVAT draws each frame.
 */
export function attachActiveObjectCameraFollow(
  view: FollowViewLike | null | undefined,
  follower: ActiveObjectCameraFollower,
  getModel: () => FollowModelLike | null | undefined
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
      follower.tick(view, getModel());
    } catch {
      // Never break CVAT rendering
    }
    origRender();
  };
  marked[FOLLOW_MARKER] = true;
  return true;
}
