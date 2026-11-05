/**
 * Active-object hover lock for CVAT 3D perspective view.
 *
 * CVAT's `Canvas3dViewImpl.renderRayCaster()` raycasts every animation frame against all visible
 * cuboids and highlights (focuses) whatever cuboid is under the mouse cursor. While the user is
 * editing an ACTIVE object, hovering over a neighbouring cuboid steals that highlight.
 *
 * This module wraps `views.perspective.rayCaster.renderer.intersectObjects` so that, while an
 * object is active, hover raycasts (outside of real click/mouse button events) ignore every
 * cuboid whose `name` (= clientID) differs from the active clientID. Clicking another cuboid
 * still works normally, so the user can always switch the active object explicitly.
 */

interface RaycastIntersectionLike {
  readonly object?: { readonly name?: string } | null;
}

export interface RaycasterLike {
  intersectObjects?: (objects: unknown[], recursive?: boolean, ...rest: unknown[]) => unknown[];
}

const LOCKED_MARKER = '__cvat3dEnhancerHoverLocked';

let pointerButtonEventDepth = 0;
let pointerTrackingInstalled = false;

/**
 * Tracks whether a real mouse button event (click/dblclick/mousedown/mouseup/contextmenu)
 * is currently being dispatched, so raycasts executed inside those handlers are never filtered.
 */
export function installPointerButtonEventTracking(win: Window = window): void {
  if (pointerTrackingInstalled) {
    return;
  }
  pointerTrackingInstalled = true;
  const types = ['mousedown', 'mouseup', 'click', 'dblclick', 'contextmenu', 'pointerdown', 'pointerup'];
  const begin = (): void => {
    pointerButtonEventDepth += 1;
    // Safety net in case a handler stops propagation and the bubble listener never fires
    win.setTimeout(() => {
      pointerButtonEventDepth = 0;
    }, 0);
  };
  const end = (): void => {
    pointerButtonEventDepth = Math.max(0, pointerButtonEventDepth - 1);
  };
  for (const type of types) {
    win.addEventListener(type, begin, true);
    win.addEventListener(type, end, false);
  }
}

export function isInsidePointerButtonEvent(): boolean {
  return pointerButtonEventDepth > 0;
}

export function filterHoverIntersections(
  intersections: unknown[],
  activeClientId: string | null
): unknown[] {
  if (activeClientId === null || !Array.isArray(intersections) || intersections.length === 0) {
    return intersections;
  }
  return intersections.filter((hit) => {
    const name = (hit as RaycastIntersectionLike | null)?.object?.name;
    if (typeof name !== 'string' || name === '' || !/^\d+$/.test(name)) {
      // Not a cuboid identified by clientID -> keep untouched
      return true;
    }
    return name === activeClientId;
  });
}

/**
 * Wraps a THREE.Raycaster instance (idempotent).
 */
export function lockRaycasterHoverToActiveObject(
  rayCaster: RaycasterLike | null | undefined,
  getActiveClientId: () => string | null,
  isEnabled: () => boolean = () => true
): boolean {
  if (!rayCaster || typeof rayCaster.intersectObjects !== 'function') {
    return false;
  }
  const marked = rayCaster as RaycasterLike & { [LOCKED_MARKER]?: boolean };
  if (marked[LOCKED_MARKER]) {
    return true;
  }
  const original = rayCaster.intersectObjects.bind(rayCaster);
  rayCaster.intersectObjects = (objects: unknown[], recursive?: boolean, ...rest: unknown[]) => {
    const hits = original(objects, recursive, ...rest);
    if (!Array.isArray(hits) || hits.length === 0 || !isEnabled() || isInsidePointerButtonEvent()) {
      return hits;
    }
    return filterHoverIntersections(hits, getActiveClientId());
  };
  marked[LOCKED_MARKER] = true;
  return true;
}
