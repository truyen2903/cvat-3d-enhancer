/**
 * Active-object hover lock & 100k-mesh O(1) raycast accelerator for CVAT 3D perspective view.
 *
 * CVAT's `Canvas3dViewImpl.renderRayCaster()` raycasts every animation frame against all visible
 * cuboids and highlights (focuses) whatever cuboid is under the mouse cursor. While the user is
 * editing an ACTIVE object, hovering over a neighbouring cuboid steals that highlight.
 *
 * This module wraps `views.perspective.rayCaster.renderer.intersectObjects` so that:
 * 1. While an object is active, hover raycasts (outside of real click/mouse button events)
 *    resolve only the active cuboid + non-cuboid helpers in O(1) via WeakMap / 1-slot index cache.
 * 2. While no object is active (`activeClientId === null`) on dense scenes, stationary rays reuse
 *    a per-raycaster O(1) Idle Ray Cache and moving rays shortlist candidates via an SoA
 *    Ray-Sphere broad-phase before delegating exact geometry intersection to Three.js.
 * 3. Button events use a fresh conservative broad phase and native exact picking for every
 *    candidate, independently of the active object.
 */

import { isNumericClientIdName } from './state-lookup';
import { isPerfProbeEnabled, timePerf } from './perf-probe';

interface RaycastIntersectionLike {
  readonly object?: { readonly name?: string } | null;
}

export interface RayVector3Like {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface RaycasterLike {
  ray?: {
    readonly origin?: RayVector3Like | null;
    readonly direction?: RayVector3Like | null;
  } | null;
  intersectObjects?(objects: unknown[], recursive?: boolean, ...rest: unknown[]): unknown[];
}

export interface HoverLockOptions {
  readonly useCachedClickBounds?: () => boolean;
  readonly resolveActiveObject?: (activeClientId: string) => unknown;
}

interface MeshBoundsLike {
  readonly name?: unknown;
  readonly visible?: boolean;
  readonly isMesh?: boolean;
  readonly isSkinnedMesh?: boolean;
  readonly morphTargetInfluences?: unknown;
  readonly parent?: {
    readonly matrixWorld?: { readonly elements?: ArrayLike<number> | null } | null;
  } | null;
  readonly matrixWorld?: { readonly elements?: ArrayLike<number> | null } | null;
  readonly position?: { readonly x?: number; readonly y?: number; readonly z?: number } | null;
  readonly scale?: { readonly x?: number; readonly y?: number; readonly z?: number } | null;
  readonly geometry?: {
    boundingSphere?: {
      readonly center?: { readonly x?: number; readonly y?: number; readonly z?: number } | null;
      readonly radius?: number;
    } | null;
    boundingBox?: {
      readonly min?: { readonly x?: number; readonly y?: number; readonly z?: number } | null;
      readonly max?: { readonly x?: number; readonly y?: number; readonly z?: number } | null;
    } | null;
    computeBoundingSphere?: () => void;
  } | null;
}

interface HoverSpatialSoA {
  readonly epoch: number;
  readonly count: number;
  readonly cxs: Float64Array;
  readonly cys: Float64Array;
  readonly czs: Float64Array;
  readonly rSqs: Float64Array;
  readonly boundedIndices: Int32Array;
  readonly objIndexToSlot: Int32Array;
  readonly alwaysIncludeIndices: readonly number[];
}

interface HoverCandidateIndex {
  readonly epoch: number;
  readonly sourceObjects: unknown[];
  readonly length: number;
  readonly first: unknown;
  readonly mid: unknown;
  readonly last: unknown;
  readonly firstName: unknown;
  readonly lastName: unknown;
  readonly totalCuboids: number;
  readonly nonCuboids: unknown[];
  readonly nonCuboidIndices: number[];
  readonly denseIdToIndex: Int32Array;
  readonly sparseByName: Map<string, number[]> | null;
  lastActiveId: string | null;
  lastActiveResult: unknown[] | null;
  spatial: HoverSpatialSoA | null;
  clickSpatial: HoverSpatialSoA | null;
}

interface IdleRayCacheState {
  valid: boolean;
  epoch: number;
  ox: number;
  oy: number;
  oz: number;
  dx: number;
  dy: number;
  dz: number;
  recursive: boolean;
  objectsLen: number;
  firstObj: unknown;
  midObj: unknown;
  lastObj: unknown;
  stamp0: number;
  stampMid: number;
  stampLast: number;
  hitsStamp: number;
  lastHits: unknown[];
}

const LOCKED_MARKER = '__cvat3dEnhancerHoverLocked';
const hoverLockCleanups = new WeakMap<RaycasterLike, () => void>();

export function unlockRaycasterHover(rayCaster: RaycasterLike): void {
  hoverLockCleanups.get(rayCaster)?.();
  hoverLockCleanups.delete(rayCaster);
}
const INDEX_CACHE_MIN_OBJECTS = 32;
const IDLE_CACHE_MIN_OBJECTS = 64;
const BROADPHASE_MIN_OBJECTS = 256;
const MAX_DENSE_CLIENT_ID = 1_000_000;
const SPHERE_RADIUS_PAD_METERS = 0.02;

let globalHoverSpatialEpoch = 0;
const candidateIndexWeakMap = new WeakMap<unknown[], HoverCandidateIndex>();
let lastCandidateIndexSlot: HoverCandidateIndex | null = null;

/**
 * Invalidates cached idle-ray and SoA bounding-sphere snapshots when cuboids are edited,
 * undone/redone, drawn, or reloaded across frames.
 */
export function invalidateHoverSpatialIndex(): void {
  globalHoverSpatialEpoch += 1;
  lastCandidateIndexSlot = null;
}

let pointerButtonEventDepth = 0;
let pointerTrackingInstalled = false;

/**
 * Tracks whether a real mouse button event (click/dblclick/mousedown/mouseup/contextmenu)
 * is currently being dispatched, so picking is independent of the active-object hover lock.
 */
export function installPointerButtonEventTracking(win: Window = window): void {
  if (pointerTrackingInstalled) {
    return;
  }
  pointerTrackingInstalled = true;
  const types = [
    'mousedown',
    'mouseup',
    'click',
    'dblclick',
    'contextmenu',
    'pointerdown',
    'pointerup',
  ];
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

/**
 * Parses canonical ASCII integer names (`'0'`, `'1'`, ..., without leading zeros) into a dense
 * integer in `[0, maxDenseId]`, returning `-1` when non-canonical or above `maxDenseId`.
 */
function parseDenseCanonicalId(name: string, maxDenseId: number): number {
  const len = name.length;
  if (len === 0 || len > 7) {
    return -1;
  }
  const firstCode = name.charCodeAt(0);
  if (firstCode < 48 || firstCode > 57) {
    return -1;
  }
  if (len > 1 && firstCode === 48) {
    return -1;
  }
  let value = firstCode - 48;
  for (let i = 1; i < len; i += 1) {
    const code = name.charCodeAt(i);
    if (code < 48 || code > 57) {
      return -1;
    }
    value = value * 10 + (code - 48);
  }
  return value <= maxDenseId ? value : -1;
}

function readObjectStamp(obj: unknown): number {
  const mesh = obj as MeshBoundsLike | null;
  if (!mesh || typeof mesh !== 'object') {
    return 0;
  }
  const vis = mesh.visible === false ? 0 : 1;
  const elements = mesh.matrixWorld?.elements;
  if (elements && elements.length >= 16) {
    return (
      vis +
      Number(elements[12] ?? 0) * 1.0001 +
      Number(elements[13] ?? 0) * 2.0003 +
      Number(elements[14] ?? 0) * 3.0007 +
      Number(elements[0] ?? 0) * 5.0009 +
      Number(elements[5] ?? 0) * 7.0011 +
      Number(elements[10] ?? 0) * 11.0013
    );
  }
  const pos = mesh.position;
  const scale = mesh.scale;
  return (
    vis +
    Number(pos?.x ?? 0) * 1.0001 +
    Number(pos?.y ?? 0) * 2.0003 +
    Number(pos?.z ?? 0) * 3.0007 +
    Number(scale?.x ?? 1) * 5.0009 +
    Number(scale?.y ?? 1) * 7.0011 +
    Number(scale?.z ?? 1) * 11.0013
  );
}

function computeHitsStamp(hits: readonly unknown[]): number {
  const limit = Math.min(hits.length, 4);
  let sum = hits.length;
  for (let i = 0; i < limit; i += 1) {
    const obj = (hits[i] as { object?: unknown } | null)?.object;
    sum += readObjectStamp(obj) * (i + 1);
  }
  return sum;
}

function isCandidateIndexValid(index: HoverCandidateIndex, objects: unknown[]): boolean {
  const len = objects.length;
  if (index.epoch !== globalHoverSpatialEpoch || len !== index.length || len === 0) {
    return false;
  }
  const first = objects[0];
  const mid = objects[len >>> 1];
  const last = objects[len - 1];
  if (first !== index.first || mid !== index.mid || last !== index.last) {
    return false;
  }
  return (
    (first as { name?: unknown } | null)?.name === index.firstName &&
    (last as { name?: unknown } | null)?.name === index.lastName
  );
}

function getOrBuildCandidateIndex(objects: unknown[]): HoverCandidateIndex {
  const existing = candidateIndexWeakMap.get(objects);
  if (existing !== undefined && isCandidateIndexValid(existing, objects)) {
    lastCandidateIndexSlot = existing;
    return existing;
  }
  if (lastCandidateIndexSlot !== null && isCandidateIndexValid(lastCandidateIndexSlot, objects)) {
    candidateIndexWeakMap.set(objects, lastCandidateIndexSlot);
    return lastCandidateIndexSlot;
  }

  const len = objects.length;
  const denseLimit = Math.min(MAX_DENSE_CLIENT_ID, Math.max(len * 2, 1024));
  const denseIdToIndex = new Int32Array(denseLimit + 1);
  denseIdToIndex.fill(-1);
  let sparseByName: Map<string, number[]> | null = null;
  const nonCuboids: unknown[] = [];
  const nonCuboidIndices: number[] = [];
  let totalCuboids = 0;

  for (let i = 0; i < len; i += 1) {
    const item = objects[i];
    const name = (item as { name?: unknown } | null)?.name;
    if (!isNumericClientIdName(name)) {
      nonCuboids.push(item);
      nonCuboidIndices.push(i);
      continue;
    }
    totalCuboids += 1;
    const denseId = parseDenseCanonicalId(name, denseLimit);
    if (denseId >= 0) {
      const prevIdx = denseIdToIndex[denseId]!;
      if (prevIdx === -1) {
        denseIdToIndex[denseId] = i;
        continue;
      }
      if (prevIdx >= 0) {
        denseIdToIndex[denseId] = -2;
        if (!sparseByName) {
          sparseByName = new Map();
        }
        sparseByName.set(name, [prevIdx, i]);
        continue;
      }
    }
    if (!sparseByName) {
      sparseByName = new Map();
    }
    const list = sparseByName.get(name);
    if (list) {
      list.push(i);
    } else {
      sparseByName.set(name, [i]);
    }
  }

  const first = objects[0];
  const mid = objects[len >>> 1];
  const last = objects[len - 1];
  const built: HoverCandidateIndex = {
    epoch: globalHoverSpatialEpoch,
    sourceObjects: objects,
    length: len,
    first,
    mid,
    last,
    firstName: (first as { name?: unknown } | null)?.name,
    lastName: (last as { name?: unknown } | null)?.name,
    totalCuboids,
    nonCuboids,
    nonCuboidIndices,
    denseIdToIndex,
    sparseByName,
    lastActiveId: null,
    lastActiveResult: null,
    spatial: null,
    clickSpatial: null,
  };

  candidateIndexWeakMap.set(objects, built);
  lastCandidateIndexSlot = built;
  return built;
}

function mergeIndexedSubsets(
  source: unknown[],
  indicesA: readonly number[],
  indicesB: readonly number[]
): unknown[] {
  const lenA = indicesA.length;
  const lenB = indicesB.length;
  if (lenA === 0 && lenB === 0) {
    return [];
  }
  const merged = new Array<unknown>(lenA + lenB);
  let a = 0;
  let b = 0;
  let out = 0;
  while (a < lenA && b < lenB) {
    const idxA = indicesA[a]!;
    const idxB = indicesB[b]!;
    if (idxA <= idxB) {
      merged[out] = source[idxA];
      a += 1;
    } else {
      merged[out] = source[idxB];
      b += 1;
    }
    out += 1;
  }
  while (a < lenA) {
    merged[out] = source[indicesA[a]!];
    a += 1;
    out += 1;
  }
  while (b < lenB) {
    merged[out] = source[indicesB[b]!];
    b += 1;
    out += 1;
  }
  return merged;
}

function computeWorldSphere(
  mesh: MeshBoundsLike,
  out: { cx: number; cy: number; cz: number; rSq: number },
  nativeBounds = false
): boolean {
  const geom = mesh.geometry;
  const elements = mesh.matrixWorld?.elements;
  if (!geom || !elements || elements.length < 16) {
    return false;
  }

  if (!geom.boundingSphere && typeof geom.computeBoundingSphere === 'function') {
    try {
      geom.computeBoundingSphere();
    } catch {
      if (nativeBounds) return false;
      // Fallback to boundingBox below
    }
  }

  let localX = 0;
  let localY = 0;
  let localZ = 0;
  let localRadius = -1;

  const bs = geom.boundingSphere;
  if (bs && typeof bs.radius === 'number' && Number.isFinite(bs.radius) && bs.radius >= 0) {
    localX = Number(bs.center?.x ?? 0);
    localY = Number(bs.center?.y ?? 0);
    localZ = Number(bs.center?.z ?? 0);
    localRadius = bs.radius;
  } else if (!nativeBounds && geom.boundingBox?.min && geom.boundingBox.max) {
    const min = geom.boundingBox.min;
    const max = geom.boundingBox.max;
    const minX = Number(min.x);
    const minY = Number(min.y);
    const minZ = Number(min.z);
    const maxX = Number(max.x);
    const maxY = Number(max.y);
    const maxZ = Number(max.z);
    if (
      Number.isFinite(minX) &&
      Number.isFinite(minY) &&
      Number.isFinite(minZ) &&
      Number.isFinite(maxX) &&
      Number.isFinite(maxY) &&
      Number.isFinite(maxZ)
    ) {
      localX = (minX + maxX) * 0.5;
      localY = (minY + maxY) * 0.5;
      localZ = (minZ + maxZ) * 0.5;
      localRadius = 0.5 * Math.hypot(maxX - minX, maxY - minY, maxZ - minZ);
    }
  }

  if (
    localRadius < 0 ||
    !Number.isFinite(localX) ||
    !Number.isFinite(localY) ||
    !Number.isFinite(localZ)
  ) {
    return false;
  }

  // Hidden cuboids have `updateMatrixWorld` deferred, so `mesh.matrixWorld` may still sit at
  // the identity origin `(0, 0, 0)` while `mesh.position` and `mesh.scale` hold the true live
  // coordinates. Use `position`/`scale` (+ parent world transform if present) when hidden.
  if (!nativeBounds && mesh.visible === false && mesh.position && mesh.scale) {
    const px = Number(mesh.position.x ?? 0);
    const py = Number(mesh.position.y ?? 0);
    const pz = Number(mesh.position.z ?? 0);
    const sx = Math.abs(Number(mesh.scale.x ?? 1));
    const sy = Math.abs(Number(mesh.scale.y ?? 1));
    const sz = Math.abs(Number(mesh.scale.z ?? 1));
    if (
      Number.isFinite(px) &&
      Number.isFinite(py) &&
      Number.isFinite(pz) &&
      Number.isFinite(sx) &&
      Number.isFinite(sy) &&
      Number.isFinite(sz)
    ) {
      const maxLocalScale = Math.max(sx, sy, sz);
      const localOffset = Math.hypot(localX * sx, localY * sy, localZ * sz);
      const parentEl = mesh.parent?.matrixWorld?.elements;
      let wCx = px;
      let wCy = py;
      let wCz = pz;
      let parentScale = 1;
      if (parentEl && parentEl.length >= 16) {
        wCx =
          Number(parentEl[0]) * px +
          Number(parentEl[4]) * py +
          Number(parentEl[8]) * pz +
          Number(parentEl[12]);
        wCy =
          Number(parentEl[1]) * px +
          Number(parentEl[5]) * py +
          Number(parentEl[9]) * pz +
          Number(parentEl[13]);
        wCz =
          Number(parentEl[2]) * px +
          Number(parentEl[6]) * py +
          Number(parentEl[10]) * pz +
          Number(parentEl[14]);
        parentScale = Math.sqrt(
          Math.max(
            Number(parentEl[0]) ** 2 + Number(parentEl[1]) ** 2 + Number(parentEl[2]) ** 2,
            Number(parentEl[4]) ** 2 + Number(parentEl[5]) ** 2 + Number(parentEl[6]) ** 2,
            Number(parentEl[8]) ** 2 + Number(parentEl[9]) ** 2 + Number(parentEl[10]) ** 2
          )
        );
      }
      if (
        Number.isFinite(wCx) &&
        Number.isFinite(wCy) &&
        Number.isFinite(wCz) &&
        Number.isFinite(parentScale)
      ) {
        const r =
          (localRadius * maxLocalScale + localOffset) * parentScale + SPHERE_RADIUS_PAD_METERS;
        out.cx = wCx;
        out.cy = wCy;
        out.cz = wCz;
        out.rSq = r * r;
        return true;
      }
    }
  }

  let cx: number;
  let cy: number;
  let cz: number;
  if (localX === 0 && localY === 0 && localZ === 0 && elements[15] === 1) {
    cx = Number(elements[12]);
    cy = Number(elements[13]);
    cz = Number(elements[14]);
  } else {
    const wRaw =
      Number(elements[3]) * localX +
      Number(elements[7]) * localY +
      Number(elements[11]) * localZ +
      Number(elements[15]);
    const invW = wRaw !== 0 ? 1 / wRaw : 1;
    cx =
      (Number(elements[0]) * localX +
        Number(elements[4]) * localY +
        Number(elements[8]) * localZ +
        Number(elements[12])) *
      invW;
    cy =
      (Number(elements[1]) * localX +
        Number(elements[5]) * localY +
        Number(elements[9]) * localZ +
        Number(elements[13])) *
      invW;
    cz =
      (Number(elements[2]) * localX +
        Number(elements[6]) * localY +
        Number(elements[10]) * localZ +
        Number(elements[14])) *
      invW;
  }

  const e0 = Number(elements[0]);
  const e1 = Number(elements[1]);
  const e2 = Number(elements[2]);
  const e4 = Number(elements[4]);
  const e5 = Number(elements[5]);
  const e6 = Number(elements[6]);
  const e8 = Number(elements[8]);
  const e9 = Number(elements[9]);
  const e10 = Number(elements[10]);
  const maxScaleSq = Math.max(
    e0 * e0 + e1 * e1 + e2 * e2,
    e4 * e4 + e5 * e5 + e6 * e6,
    e8 * e8 + e9 * e9 + e10 * e10
  );

  if (
    !Number.isFinite(cx) ||
    !Number.isFinite(cy) ||
    !Number.isFinite(cz) ||
    !Number.isFinite(maxScaleSq)
  ) {
    return false;
  }

  const worldRadius = localRadius * Math.sqrt(maxScaleSq) + SPHERE_RADIUS_PAD_METERS;
  out.cx = cx;
  out.cy = cy;
  out.cz = cz;
  out.rSq = worldRadius * worldRadius;
  return true;
}

const scratchSphere = { cx: 0, cy: 0, cz: 0, rSq: 0 };

function buildSpatialSoA(index: HoverCandidateIndex, nativePicking = false): HoverSpatialSoA {
  const objects = index.sourceObjects;
  const len = objects.length;
  const cxs = new Float64Array(len);
  const cys = new Float64Array(len);
  const czs = new Float64Array(len);
  const rSqs = new Float64Array(len);
  const boundedIndices = new Int32Array(len);
  const objIndexToSlot = new Int32Array(len);
  objIndexToSlot.fill(-1);
  const alwaysIncludeIndices: number[] = [];
  let count = 0;

  for (let i = 0; i < len; i += 1) {
    const mesh = objects[i] as MeshBoundsLike | null;
    if (
      !mesh ||
      !isNumericClientIdName(mesh.name) ||
      (nativePicking
        ? !canBoundNativeMesh(mesh) || !computeNativeClickSphere(mesh)
        : !computeWorldSphere(mesh, scratchSphere))
    ) {
      alwaysIncludeIndices.push(i);
      continue;
    }

    cxs[count] = scratchSphere.cx;
    cys[count] = scratchSphere.cy;
    czs[count] = scratchSphere.cz;
    rSqs[count] = scratchSphere.rSq;
    boundedIndices[count] = i;
    objIndexToSlot[i] = count;
    count += 1;
  }

  return {
    epoch: globalHoverSpatialEpoch,
    count,
    cxs: count === len ? cxs : cxs.subarray(0, count),
    cys: count === len ? cys : cys.subarray(0, count),
    czs: count === len ? czs : czs.subarray(0, count),
    rSqs: count === len ? rSqs : rSqs.subarray(0, count),
    boundedIndices: count === len ? boundedIndices : boundedIndices.subarray(0, count),
    objIndexToSlot,
    alwaysIncludeIndices,
  };
}

function syncSpatialSlotForObject(
  index: HoverCandidateIndex,
  objIndex: number,
  nativePicking = false
): void {
  const spatial = nativePicking ? index.clickSpatial : index.spatial;
  if (!spatial || objIndex < 0 || objIndex >= spatial.objIndexToSlot.length) {
    return;
  }
  const slot = spatial.objIndexToSlot[objIndex]!;
  if (slot < 0) {
    return;
  }
  const mesh = index.sourceObjects[objIndex] as MeshBoundsLike | null;
  if (
    !mesh ||
    (nativePicking ? !computeNativeClickSphere(mesh) : !computeWorldSphere(mesh, scratchSphere))
  ) {
    if (nativePicking) index.clickSpatial = null;
    else index.spatial = null;
    return;
  }
  spatial.cxs[slot] = scratchSphere.cx;
  spatial.cys[slot] = scratchSphere.cy;
  spatial.czs[slot] = scratchSphere.cz;
  spatial.rSqs[slot] = scratchSphere.rSq;
}

// CVAT cuboid boxes have an origin-centered local sphere. Keep their common click path
// scalar-only; unusual geometry/transforms use the general conservative implementation.
function computeNativeClickSphere(mesh: MeshBoundsLike): boolean {
  const sphere = mesh.geometry?.boundingSphere;
  const e = mesh.matrixWorld?.elements;
  if (
    !sphere ||
    !e ||
    e.length < 16 ||
    e[15] !== 1 ||
    sphere.center?.x !== 0 ||
    sphere.center.y !== 0 ||
    sphere.center.z !== 0 ||
    typeof sphere.radius !== 'number' ||
    sphere.radius < 0
  ) {
    return computeWorldSphere(mesh, scratchSphere, true);
  }
  const scaleSq = Math.max(
    e[0]! * e[0]! + e[1]! * e[1]! + e[2]! * e[2]!,
    e[4]! * e[4]! + e[5]! * e[5]! + e[6]! * e[6]!,
    e[8]! * e[8]! + e[9]! * e[9]! + e[10]! * e[10]!
  );
  const radius = sphere.radius * Math.sqrt(scaleSq) + SPHERE_RADIUS_PAD_METERS;
  scratchSphere.cx = e[12]!;
  scratchSphere.cy = e[13]!;
  scratchSphere.cz = e[14]!;
  scratchSphere.rSq = radius * radius;
  return (
    Number.isFinite(scratchSphere.cx) &&
    Number.isFinite(scratchSphere.cy) &&
    Number.isFinite(scratchSphere.cz) &&
    Number.isFinite(scratchSphere.rSq)
  );
}

// Only ordinary Three.js Mesh prototypes use the bounding-sphere picking contract.
// Subclasses, per-instance raycast overrides, skinning and morphing stay native.
const nativeMeshPrototypes = new WeakMap<object, boolean>();
function canBoundNativeMesh(mesh: MeshBoundsLike): boolean {
  if (
    !mesh.isMesh ||
    mesh.isSkinnedMesh ||
    mesh.morphTargetInfluences ||
    Object.hasOwn(mesh, 'raycast')
  )
    return false;
  const prototype: object | null = Object.getPrototypeOf(mesh);
  if (!prototype) return false;
  let supported = nativeMeshPrototypes.get(prototype);
  if (supported === undefined) {
    supported = ['raycast', 'getVertexPosition', 'updateMorphTargets'].every((key) =>
      Object.hasOwn(prototype, key)
    );
    nativeMeshPrototypes.set(prototype, supported);
  }
  return supported;
}

function sphereCouldIntersectRay(
  cx: number,
  cy: number,
  cz: number,
  rSq: number,
  ox: number,
  oy: number,
  oz: number,
  ux: number,
  uy: number,
  uz: number
): boolean {
  const vx = cx - ox;
  const vy = cy - oy;
  const vz = cz - oz;
  const vLenSq = vx * vx + vy * vy + vz * vz;
  if (vLenSq <= rSq) return true;
  const tca = vx * ux + vy * uy + vz * uz;
  const roundingMargin = Number.EPSILON * 16 * (vLenSq + tca * tca + rSq);
  return tca >= 0 && vLenSq - tca * tca <= rSq + roundingMargin;
}

function shortlistBroadPhaseRayCandidates(
  objects: unknown[],
  index: HoverCandidateIndex | null,
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  nativePicking = false
): unknown[] {
  const dirLen = Math.hypot(dx, dy, dz);
  if (!Number.isFinite(dirLen) || dirLen <= 1e-12) {
    return objects;
  }
  const invLen = 1 / dirLen;
  const ux = dx * invLen;
  const uy = dy * invLen;
  const uz = dz * invLen;
  if (nativePicking && Math.abs(dirLen - 1) > Number.EPSILON * 8) return objects;
  if (!index) {
    // Clicks snapshot current native world bounds in one pass, without N-sized scratch
    // arrays or dependencies on a preceding hover/notification. Preserve input order.
    if (Math.abs(dirLen - 1) > Number.EPSILON * 8) return objects;
    const out: unknown[] = [];
    for (const object of objects) {
      const mesh = object as MeshBoundsLike | null;
      if (
        !mesh ||
        !isNumericClientIdName(mesh.name) ||
        !canBoundNativeMesh(mesh) ||
        !computeNativeClickSphere(mesh) ||
        sphereCouldIntersectRay(
          scratchSphere.cx,
          scratchSphere.cy,
          scratchSphere.cz,
          scratchSphere.rSq,
          ox,
          oy,
          oz,
          ux,
          uy,
          uz
        )
      ) {
        out.push(object);
      }
    }
    return out;
  }
  if (
    nativePicking &&
    (!index.clickSpatial || index.clickSpatial.epoch !== globalHoverSpatialEpoch)
  ) {
    index.clickSpatial = buildSpatialSoA(index, true);
  } else if (
    !nativePicking &&
    (!index.spatial || index.spatial.epoch !== globalHoverSpatialEpoch)
  ) {
    index.spatial = buildSpatialSoA(index);
  }
  const spatial = nativePicking ? index.clickSpatial! : index.spatial!;
  if (spatial.count === 0) return objects;

  const { count, cxs, cys, czs, rSqs, boundedIndices, alwaysIncludeIndices } = spatial;
  const matchedIndices: number[] = [];

  for (let k = 0; k < count; k += 1) {
    if (!sphereCouldIntersectRay(cxs[k]!, cys[k]!, czs[k]!, rSqs[k]!, ox, oy, oz, ux, uy, uz)) {
      continue;
    }
    const objIdx = boundedIndices[k]!;
    const candidate = objects[objIdx];
    if (!nativePicking && (candidate as { visible?: boolean } | null)?.visible === false) {
      continue;
    }
    matchedIndices.push(objIdx);
  }

  if (alwaysIncludeIndices.length === 0) {
    const out = new Array<unknown>(matchedIndices.length);
    for (let i = 0; i < matchedIndices.length; i += 1) {
      out[i] = objects[matchedIndices[i]!];
    }
    return out;
  }
  return mergeIndexedSubsets(objects, alwaysIncludeIndices, matchedIndices);
}

export function filterHoverIntersections(
  intersections: unknown[],
  activeClientId: string | null
): unknown[] {
  if (activeClientId === null || !Array.isArray(intersections) || intersections.length === 0) {
    return intersections;
  }
  let filtered: unknown[] | null = null;
  const len = intersections.length;
  for (let i = 0; i < len; i += 1) {
    const hit = intersections[i];
    const name = (hit as RaycastIntersectionLike | null)?.object?.name;
    const keep = !isNumericClientIdName(name) || name === activeClientId;
    if (!keep && filtered === null) {
      filtered = intersections.slice(0, i);
    } else if (keep && filtered !== null) {
      filtered.push(hit);
    }
  }
  return filtered ?? intersections;
}

/** Drop top-level cuboids (named by clientID) other than the active one before raycasting. */
export function prefilterHoverCandidates(
  objects: unknown[],
  activeClientId: string | null,
  resolveActiveObject?: (activeClientId: string) => unknown
): unknown[] {
  if (activeClientId === null || !Array.isArray(objects) || objects.length === 0) {
    return objects;
  }

  const len = objects.length;
  if (len <= INDEX_CACHE_MIN_OBJECTS) {
    let filtered: unknown[] | null = null;
    for (let i = 0; i < len; i += 1) {
      const name = (objects[i] as { name?: unknown } | null)?.name;
      const drop = name !== activeClientId && isNumericClientIdName(name);
      if (drop && filtered === null) {
        filtered = objects.slice(0, i);
      } else if (!drop && filtered !== null) {
        filtered.push(objects[i]);
      }
    }
    return filtered ?? objects;
  }

  const index = getOrBuildCandidateIndex(objects);
  if (index.totalCuboids === 0) {
    return objects;
  }
  if (index.lastActiveId === activeClientId && index.lastActiveResult !== null) {
    if (index.spatial !== null) {
      const cachedId = parseDenseCanonicalId(activeClientId, index.denseIdToIndex.length - 1);
      if (cachedId >= 0) {
        syncSpatialSlotForObject(index, index.denseIdToIndex[cachedId]!);
      }
    }
    return index.lastActiveResult;
  }

  const denseLimit = index.denseIdToIndex.length - 1;
  const denseId = parseDenseCanonicalId(activeClientId, denseLimit);
  let singleMatchIdx = -1;
  let multiMatchIndices: readonly number[] | undefined;

  if (denseId >= 0) {
    const mapped = index.denseIdToIndex[denseId]!;
    if (mapped >= 0) {
      singleMatchIdx = mapped;
    } else if (mapped === -2) {
      multiMatchIndices = index.sparseByName?.get(activeClientId);
    }
  } else {
    multiMatchIndices = index.sparseByName?.get(activeClientId);
  }

  if (singleMatchIdx >= 0 && index.spatial !== null) {
    syncSpatialSlotForObject(index, singleMatchIdx);
  } else if (multiMatchIndices && index.spatial !== null) {
    for (let i = 0; i < multiMatchIndices.length; i += 1) {
      syncSpatialSlotForObject(index, multiMatchIndices[i]!);
    }
  }

  let result: unknown[];
  if (singleMatchIdx >= 0) {
    if (index.totalCuboids === 1) {
      result = objects;
    } else if (index.nonCuboids.length === 0) {
      result = [index.sourceObjects[singleMatchIdx]];
    } else {
      const nonCuboids = index.nonCuboids;
      const nonIndices = index.nonCuboidIndices;
      const nonLen = nonCuboids.length;
      result = new Array<unknown>(nonLen + 1);
      let inserted = false;
      let out = 0;
      for (let k = 0; k < nonLen; k += 1) {
        if (!inserted && singleMatchIdx < nonIndices[k]!) {
          result[out] = index.sourceObjects[singleMatchIdx];
          out += 1;
          inserted = true;
        }
        result[out] = nonCuboids[k];
        out += 1;
      }
      if (!inserted) {
        result[out] = index.sourceObjects[singleMatchIdx];
      }
    }
  } else if (multiMatchIndices && multiMatchIndices.length > 0) {
    if (index.totalCuboids === multiMatchIndices.length) {
      result = objects;
    } else {
      result = mergeIndexedSubsets(index.sourceObjects, index.nonCuboidIndices, multiMatchIndices);
    }
  } else {
    const resolved = resolveActiveObject?.(activeClientId);
    const resolvedName = (resolved as { name?: unknown } | null)?.name;
    if (
      resolved !== undefined &&
      resolved !== null &&
      resolvedName === activeClientId &&
      index.nonCuboids.length === 0
    ) {
      result = [resolved];
    } else {
      result = index.nonCuboids;
    }
  }

  index.lastActiveId = activeClientId;
  index.lastActiveResult = result;
  return result;
}

/**
 * Wraps a THREE.Raycaster instance (idempotent).
 */
export function lockRaycasterHoverToActiveObject(
  rayCaster: RaycasterLike | null | undefined,
  getActiveClientId: () => string | null,
  isEnabled: () => boolean = () => true,
  options?: HoverLockOptions
): boolean {
  if (!rayCaster || typeof rayCaster.intersectObjects !== 'function') {
    return false;
  }
  const marked = rayCaster as RaycasterLike & { [LOCKED_MARKER]?: boolean };
  if (marked[LOCKED_MARKER]) {
    return true;
  }

  const idleCache: IdleRayCacheState = {
    valid: false,
    epoch: -1,
    ox: NaN,
    oy: NaN,
    oz: NaN,
    dx: NaN,
    dy: NaN,
    dz: NaN,
    recursive: false,
    objectsLen: 0,
    firstObj: null,
    midObj: null,
    lastObj: null,
    stamp0: NaN,
    stampMid: NaN,
    stampLast: NaN,
    hitsStamp: NaN,
    lastHits: [],
  };

  let enabled = true;
  const nativeMethod = rayCaster.intersectObjects;
  const original = nativeMethod.bind(rayCaster);
  const resolveActiveObject = options?.resolveActiveObject;

  const wrappedImpl = (objects: unknown[], recursive?: boolean, ...rest: unknown[]): unknown[] => {
    if (!enabled || !isEnabled()) return original(objects, recursive, ...rest);
    if (isInsidePointerButtonEvent()) {
      let candidates = objects;
      try {
        const origin = rayCaster.ray?.origin;
        const direction = rayCaster.ray?.direction;
        if (
          !recursive &&
          Array.isArray(objects) &&
          objects.length > BROADPHASE_MIN_OBJECTS &&
          origin &&
          direction &&
          [origin.x, origin.y, origin.z, direction.x, direction.y, direction.z].every(
            Number.isFinite
          )
        ) {
          const index = options?.useCachedClickBounds?.()
            ? getOrBuildCandidateIndex(objects)
            : null;
          if (index?.clickSpatial) {
            // CVAT can preview the active cuboid while dragging before notifying the model.
            const activeId = getActiveClientId();
            if (activeId !== null) {
              const denseId = parseDenseCanonicalId(activeId, index.denseIdToIndex.length - 1);
              const objectIndex = denseId >= 0 ? index.denseIdToIndex[denseId]! : -1;
              if (objectIndex >= 0) syncSpatialSlotForObject(index, objectIndex, true);
              else
                for (const i of index.sparseByName?.get(activeId) ?? [])
                  syncSpatialSlotForObject(index, i, true);
            }
          }
          candidates = shortlistBroadPhaseRayCandidates(
            objects,
            index,
            origin.x,
            origin.y,
            origin.z,
            direction.x,
            direction.y,
            direction.z,
            true
          );
        }
      } catch {
        // Unfamiliar runtime bounds or helpers must never prevent a native click.
        candidates = objects;
      }
      return original(candidates, recursive, ...rest);
    }

    const activeClientId = getActiveClientId();
    if (activeClientId === null) {
      const len = Array.isArray(objects) ? objects.length : 0;
      const origin = rayCaster.ray?.origin;
      const direction = rayCaster.ray?.direction;
      if (len > IDLE_CACHE_MIN_OBJECTS && origin && direction) {
        const ox = Number(origin.x);
        const oy = Number(origin.y);
        const oz = Number(origin.z);
        const dx = Number(direction.x);
        const dy = Number(direction.y);
        const dz = Number(direction.z);
        if (
          Number.isFinite(ox) &&
          Number.isFinite(oy) &&
          Number.isFinite(oz) &&
          Number.isFinite(dx) &&
          Number.isFinite(dy) &&
          Number.isFinite(dz)
        ) {
          const rec = Boolean(recursive);
          const firstObj = objects[0];
          const midObj = objects[len >>> 1];
          const lastObj = objects[len - 1];
          const stamp0 = readObjectStamp(firstObj);
          const stampMid = readObjectStamp(midObj);
          const stampLast = readObjectStamp(lastObj);

          if (
            idleCache.valid &&
            idleCache.epoch === globalHoverSpatialEpoch &&
            idleCache.ox === ox &&
            idleCache.oy === oy &&
            idleCache.oz === oz &&
            idleCache.dx === dx &&
            idleCache.dy === dy &&
            idleCache.dz === dz &&
            idleCache.recursive === rec &&
            idleCache.objectsLen === len &&
            idleCache.firstObj === firstObj &&
            idleCache.midObj === midObj &&
            idleCache.lastObj === lastObj &&
            idleCache.stamp0 === stamp0 &&
            idleCache.stampMid === stampMid &&
            idleCache.stampLast === stampLast &&
            idleCache.hitsStamp === computeHitsStamp(idleCache.lastHits)
          ) {
            const targetOut = rest.length > 0 && Array.isArray(rest[0]) ? rest[0] : null;
            if (targetOut) {
              for (let i = 0; i < idleCache.lastHits.length; i += 1) {
                (targetOut as unknown[]).push(idleCache.lastHits[i]);
              }
              return targetOut as unknown[];
            }
            return idleCache.lastHits;
          }

          let candidates = objects;
          if (!rec && len > BROADPHASE_MIN_OBJECTS) {
            const index = getOrBuildCandidateIndex(objects);
            candidates = shortlistBroadPhaseRayCandidates(objects, index, ox, oy, oz, dx, dy, dz);
          }

          const hits = original(candidates, recursive, ...rest);
          if (Array.isArray(hits)) {
            idleCache.valid = true;
            idleCache.epoch = globalHoverSpatialEpoch;
            idleCache.ox = ox;
            idleCache.oy = oy;
            idleCache.oz = oz;
            idleCache.dx = dx;
            idleCache.dy = dy;
            idleCache.dz = dz;
            idleCache.recursive = rec;
            idleCache.objectsLen = len;
            idleCache.firstObj = firstObj;
            idleCache.midObj = midObj;
            idleCache.lastObj = lastObj;
            idleCache.stamp0 = stamp0;
            idleCache.stampMid = stampMid;
            idleCache.stampLast = stampLast;
            const storedHits = rest.length > 0 ? hits.slice() : hits;
            idleCache.lastHits = storedHits;
            idleCache.hitsStamp = computeHitsStamp(storedHits);
          }
          return hits;
        }
      }
      return original(objects, recursive, ...rest);
    }

    // Hover hits on other cuboids are discarded anyway; skip intersecting them. With 100k
    // cuboids this removes CVAT's per-animation-frame hover raycast cost in O(1).
    // Recursive casts may target unnamed children of other cuboids; keep those native.
    const candidates = recursive
      ? objects
      : prefilterHoverCandidates(objects, activeClientId, resolveActiveObject);
    const hits = original(candidates, recursive, ...rest);
    if (!Array.isArray(hits) || hits.length === 0) return hits;
    return filterHoverIntersections(hits, activeClientId);
  };
  const wrapped = (objects: unknown[], recursive?: boolean, ...rest: unknown[]): unknown[] =>
    isPerfProbeEnabled()
      ? timePerf(isInsidePointerButtonEvent() ? 'cvat.raycast.click' : 'cvat.raycast.hover', () =>
          wrappedImpl(objects, recursive, ...rest)
        )
      : wrappedImpl(objects, recursive, ...rest);
  try {
    if (!Reflect.set(rayCaster, 'intersectObjects', wrapped)) return false;
    if (!Reflect.set(marked, LOCKED_MARKER, true)) {
      Reflect.set(rayCaster, 'intersectObjects', nativeMethod);
      return false;
    }
    hoverLockCleanups.set(rayCaster, () => {
      enabled = false;
      idleCache.valid = false;
      idleCache.lastHits = [];
      if (rayCaster.intersectObjects === wrapped)
        Reflect.set(rayCaster, 'intersectObjects', nativeMethod);
      Reflect.deleteProperty(marked, LOCKED_MARKER);
    });
    return true;
  } catch {
    return false;
  }
}
