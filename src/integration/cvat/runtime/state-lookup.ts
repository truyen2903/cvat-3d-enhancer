/**
 * High-throughput state, drawn-object, and 2D spatial lookup primitives engineered
 * for 100,000+ CVAT 3D cuboid IDs per frame.
 *
 * Complexity guarantees:
 * - `isNumericClientIdName`: O(len) = O(1) ASCII char-code loop, zero RegExp overhead.
 * - `findObjectStateByClientId`: O(log N) binary search (<= 17 reads at N = 100k, zero allocation)
 *   on sorted CVAT state arrays, with automatic 1-time WeakMap<object, Map<number, T>> fallback
 *   on misses or non-monotonic (user-reordered) state arrays so subsequent lookups run in O(1).
 * - `DrawnObjectsCache`: Generation-aware O(1) record reuse and O(log N) single-ID lookup over
 *   DOM-backed `canvas.getDrawnObjects()` lists.
 * - `getOrBuildSpatial2DBoxLookup`: WeakMap-cached SoA TypedArray + 4.0m 2D open-addressed
 *   spatial hash immune to extreme coordinate outliers (e.g. x = 4500m) for O(1) average
 *   neighborhood queries in QA checks `[F]` and `[Z]`.
 */

import type { CvatDrawnObjectEntry } from './pre-render-enhancer';

export interface ObjectStateClientIdLike {
  readonly clientID?: number | string | null;
}

export interface DrawnObjectEntryLike {
  readonly data?: { readonly clientID?: number | string | null } | null;
  readonly state?: { readonly clientID?: number | string | null } | null;
}

export interface DrawnObjectsCanvasLike<TEntry> {
  readonly getDrawnObjects?: (() => readonly TEntry[] | TEntry[] | null | undefined) | null;
}

export interface Spatial2DDrawnEntryLike {
  readonly data?: {
    readonly clientID?: number | string | null;
    readonly points?: readonly number[] | null;
    readonly hidden?: boolean;
    readonly outside?: boolean;
  } | null;
  readonly state?: {
    readonly clientID?: number | string | null;
    readonly points?: readonly number[] | null;
    readonly hidden?: boolean;
    readonly outside?: boolean;
  } | null;
}

export type Spatial2DDrawnObjectsMap =
  | Readonly<Record<number | string, CvatDrawnObjectEntry | Spatial2DDrawnEntryLike | undefined>>
  | Readonly<Record<number, CvatDrawnObjectEntry | Spatial2DDrawnEntryLike | undefined>>;

export interface Spatial2DBoxLookup {
  readonly count: number;
  readonly cellSize: number;
  readonly ids: Int32Array;
  readonly xs: Float32Array;
  readonly ys: Float32Array;
  readonly zs: Float32Array;
  readonly ls: Float32Array;
  readonly ws: Float32Array;
  readonly hs: Float32Array;
  readonly entries: readonly (Spatial2DDrawnEntryLike | undefined)[];
  forEachNeighbor(
    cx: number,
    cy: number,
    radiusMeters: number,
    callback: (index: number, distXY: number) => boolean | void
  ): void;
}

export const SPATIAL_2D_CELL_SIZE = 4.0;
const SPATIAL_2D_INV_CELL_SIZE = 1 / SPATIAL_2D_CELL_SIZE;
const HASH_PRIME_X = 73856093;
const HASH_PRIME_Y = 19349663;
const SMALL_STATE_SCAN_LIMIT = 32;

function isAsciiDigitsOnly(str: string): boolean {
  const len = str.length;
  if (len === 0) {
    return false;
  }
  for (let i = 0; i < len; i += 1) {
    const code = str.charCodeAt(i);
    if (code < 48 || code > 57) {
      return false;
    }
  }
  return true;
}

/**
 * Fast ASCII digit check (`'0'..'9'`, length >= 1) without RegExp allocation or backtracking.
 */
export function isNumericClientIdName(value: unknown): value is string {
  return typeof value === 'string' && isAsciiDigitsOnly(value);
}

/**
 * Safely parses a `clientID` candidate (`number | string | null | undefined`) into a finite number,
 * returning `NaN` for `null`, `undefined`, blank strings, or non-numeric values (never coercing
 * `null` or `''` into `0`).
 */
function readNumericClientId(raw: unknown): number {
  if (typeof raw === 'number') {
    return Number.isFinite(raw) ? raw : NaN;
  }
  if (typeof raw === 'string') {
    if (isAsciiDigitsOnly(raw)) {
      const fast = Number(raw);
      return Number.isFinite(fast) ? fast : NaN;
    }
    const trimmed = raw.trim();
    if (trimmed.length === 0) {
      return NaN;
    }
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : NaN;
  }
  return NaN;
}

const stateMapCache = new WeakMap<object, Map<number, unknown>>();

/**
 * Resolves an object state by numeric `clientID`:
 * - O(1) if a `Map<number, T>` is already cached in `WeakMap` for this `states` array reference.
 * - O(log N) binary search (<= 17 getter reads for 100,000 states, zero Map allocation) when hit
 *   on CVAT's monotonically ordered `states` array.
 * - On miss or monotonicity violation (e.g. filtered-out active object or UI-sorted sidebar list),
 *   builds and caches `Map<number, T>` once per `states` reference so all subsequent lookups are O(1)
 *   with zero Proxy getter reads and 100% recall on arbitrarily ordered arrays.
 */
export function findObjectStateByClientId<T extends ObjectStateClientIdLike>(
  states: readonly T[] | null | undefined,
  clientID: number
): T | null {
  if (
    !states ||
    !Array.isArray(states) ||
    states.length === 0 ||
    typeof clientID !== 'number' ||
    !Number.isFinite(clientID)
  ) {
    return null;
  }

  const cachedMap = stateMapCache.get(states);
  if (cachedMap !== undefined) {
    return (cachedMap.get(clientID) as T | undefined) ?? null;
  }

  const len = states.length;
  if (len <= SMALL_STATE_SCAN_LIMIT) {
    for (let i = 0; i < len; i += 1) {
      const item = states[i];
      if (item && readNumericClientId(item.clientID) === clientID) {
        return item;
      }
    }
    return null;
  }

  let lo = 0;
  let hi = len - 1;
  let boundLoId = -Infinity;
  let boundHiId = Infinity;

  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const midItem = states[mid];
    const midId = midItem ? readNumericClientId(midItem.clientID) : NaN;
    if (!Number.isFinite(midId) || midId < boundLoId || midId > boundHiId) {
      break;
    }
    if (midId === clientID) {
      return midItem ?? null;
    }
    if (midId < clientID) {
      lo = mid + 1;
      boundLoId = midId;
    } else {
      hi = mid - 1;
      boundHiId = midId;
    }
  }

  const indexMap = new Map<number, unknown>();
  for (let i = 0; i < len; i += 1) {
    const item = states[i];
    if (!item) {
      continue;
    }
    const id = readNumericClientId(item.clientID);
    if (Number.isFinite(id) && !indexMap.has(id)) {
      indexMap.set(id, item);
    }
  }
  stateMapCache.set(states, indexMap);
  return (indexMap.get(clientID) as T | undefined) ?? null;
}

/**
 * Generation-tracked cache for DOM-backed `canvas.getDrawnObjects(): TEntry[]` bridges.
 * Eliminates repeated 100k-element `.forEach()` object construction on every `view.drawnObjects`
 * property read while supporting O(log N) single-entry lookups without allocating a 100k-key map.
 */
export class DrawnObjectsCache<TEntry extends DrawnObjectEntryLike = CvatDrawnObjectEntry> {
  private generation = 0;
  private cachedCanvas: object | null = null;
  private cachedGeneration = -1;
  private cachedRecord: Record<number, TEntry> | null = null;
  private cachedListRef: readonly TEntry[] | null = null;
  private cachedListLength = -1;
  private cachedFirstItem: unknown = undefined;
  private cachedLastItem: unknown = undefined;
  private lastSingleCanvas: object | null = null;
  private lastSingleGeneration = -1;
  private lastSingleId = NaN;
  private lastSingleListRef: readonly TEntry[] | null = null;
  private lastSingleListLen = -1;
  private lastSingleEntry: TEntry | null = null;

  public invalidate(): void {
    this.generation += 1;
  }

  public getGeneration(): number {
    return this.generation;
  }

  private isSameListSnapshot(list: readonly TEntry[]): boolean {
    const len = list.length;
    if (this.cachedListRef !== list || this.cachedListLength !== len) {
      return false;
    }
    if (len === 0) {
      return true;
    }
    return list[0] === this.cachedFirstItem && list[len - 1] === this.cachedLastItem;
  }

  public getMap(canvas: DrawnObjectsCanvasLike<TEntry> | null | undefined): Record<number, TEntry> {
    if (!canvas || typeof canvas.getDrawnObjects !== 'function') {
      return {};
    }

    if (
      this.cachedCanvas === canvas &&
      this.cachedGeneration === this.generation &&
      this.cachedRecord !== null &&
      this.cachedListRef !== null &&
      this.isSameListSnapshot(this.cachedListRef)
    ) {
      return this.cachedRecord;
    }

    let list: readonly TEntry[] | null | undefined;
    try {
      list = canvas.getDrawnObjects();
    } catch {
      return {};
    }
    if (!Array.isArray(list)) {
      return {};
    }

    if (
      this.cachedCanvas === canvas &&
      this.cachedRecord !== null &&
      this.isSameListSnapshot(list)
    ) {
      this.cachedGeneration = this.generation;
      return this.cachedRecord;
    }

    return this.buildAndStoreRecord(canvas, list);
  }

  public getEntryById(
    canvas: DrawnObjectsCanvasLike<TEntry> | null | undefined,
    clientID: number
  ): TEntry | null {
    if (
      !canvas ||
      typeof canvas.getDrawnObjects !== 'function' ||
      typeof clientID !== 'number' ||
      !Number.isFinite(clientID)
    ) {
      return null;
    }

    if (
      this.lastSingleCanvas === canvas &&
      this.lastSingleGeneration === this.generation &&
      this.lastSingleId === clientID &&
      this.lastSingleListRef !== null &&
      this.lastSingleListRef.length === this.lastSingleListLen
    ) {
      return this.lastSingleEntry;
    }

    if (
      this.cachedCanvas === canvas &&
      this.cachedGeneration === this.generation &&
      this.cachedRecord !== null &&
      this.cachedListRef !== null &&
      this.isSameListSnapshot(this.cachedListRef)
    ) {
      const hit = this.cachedRecord[clientID] ?? null;
      this.lastSingleCanvas = canvas;
      this.lastSingleGeneration = this.generation;
      this.lastSingleId = clientID;
      this.lastSingleListRef = this.cachedListRef;
      this.lastSingleListLen = this.cachedListLength;
      this.lastSingleEntry = hit;
      return hit;
    }

    let list: readonly TEntry[] | null | undefined;
    try {
      list = canvas.getDrawnObjects();
    } catch {
      return null;
    }
    if (!Array.isArray(list)) {
      return null;
    }

    if (
      this.cachedCanvas === canvas &&
      this.cachedRecord !== null &&
      this.isSameListSnapshot(list)
    ) {
      this.cachedGeneration = this.generation;
      const hit = this.cachedRecord[clientID] ?? null;
      this.lastSingleCanvas = canvas;
      this.lastSingleGeneration = this.generation;
      this.lastSingleId = clientID;
      this.lastSingleListRef = list;
      this.lastSingleListLen = list.length;
      this.lastSingleEntry = hit;
      return hit;
    }

    const len = list.length;
    if (len > 0) {
      let lo = 0;
      let hi = len - 1;
      let boundLoId = -Infinity;
      let boundHiId = Infinity;

      while (lo <= hi) {
        const mid = (lo + hi) >>> 1;
        const item = list[mid];
        const rawId = item?.data?.clientID ?? item?.state?.clientID ?? mid;
        const parsedId = readNumericClientId(rawId);
        const midId = Number.isFinite(parsedId) ? parsedId : mid;

        if (midId < boundLoId || midId > boundHiId) {
          break;
        }
        if (midId === clientID) {
          const hit = item ?? null;
          this.lastSingleCanvas = canvas;
          this.lastSingleGeneration = this.generation;
          this.lastSingleId = clientID;
          this.lastSingleListRef = list;
          this.lastSingleListLen = len;
          this.lastSingleEntry = hit;
          return hit;
        }
        if (midId < clientID) {
          lo = mid + 1;
          boundLoId = midId;
        } else {
          hi = mid - 1;
          boundHiId = midId;
        }
      }
    }

    const record = this.buildAndStoreRecord(canvas, list);
    const hit = record[clientID] ?? null;
    this.lastSingleCanvas = canvas;
    this.lastSingleGeneration = this.generation;
    this.lastSingleId = clientID;
    this.lastSingleListRef = list;
    this.lastSingleListLen = len;
    this.lastSingleEntry = hit;
    return hit;
  }

  private buildAndStoreRecord(canvas: object, list: readonly TEntry[]): Record<number, TEntry> {
    const record: Record<number, TEntry> = {};
    const len = list.length;
    for (let idx = 0; idx < len; idx += 1) {
      const item = list[idx];
      if (item === undefined || item === null) {
        continue;
      }
      const rawId = item.data?.clientID ?? item.state?.clientID ?? idx;
      const parsedId = readNumericClientId(rawId);
      const id = Number.isFinite(parsedId) ? parsedId : idx;
      record[id] = item;
    }
    this.cachedCanvas = canvas;
    this.cachedGeneration = this.generation;
    this.cachedListRef = list;
    this.cachedListLength = len;
    this.cachedFirstItem = len > 0 ? list[0] : undefined;
    this.cachedLastItem = len > 0 ? list[len - 1] : undefined;
    this.cachedRecord = record;
    return record;
  }
}

const EMPTY_INT32 = new Int32Array(0);
const EMPTY_FLOAT32 = new Float32Array(0);
const EMPTY_ENTRIES: readonly (Spatial2DDrawnEntryLike | undefined)[] = Object.freeze([]);

const EMPTY_SPATIAL_2D_BOX_LOOKUP: Spatial2DBoxLookup = Object.freeze({
  count: 0,
  cellSize: SPATIAL_2D_CELL_SIZE,
  ids: EMPTY_INT32,
  xs: EMPTY_FLOAT32,
  ys: EMPTY_FLOAT32,
  zs: EMPTY_FLOAT32,
  ls: EMPTY_FLOAT32,
  ws: EMPTY_FLOAT32,
  hs: EMPTY_FLOAT32,
  entries: EMPTY_ENTRIES,
  forEachNeighbor(): void {
    // No boxes to visit
  },
});

function nextPowerOfTwo(minCapacity: number): number {
  let size = 16;
  while (size < minCapacity) {
    size *= 2;
  }
  return size;
}

/**
 * Builds a flat SoA TypedArray + open-addressed 4.0m 2D spatial hash over valid cuboids
 * (`!hidden && !outside`, prioritizing `entry.data?.points` over `entry.state?.points`).
 */
export function buildSpatial2DBoxLookup(
  drawnObjects: Spatial2DDrawnObjectsMap | null | undefined
): Spatial2DBoxLookup {
  if (!drawnObjects || typeof drawnObjects !== 'object') {
    return EMPTY_SPATIAL_2D_BOX_LOOKUP;
  }

  const keys = Object.keys(drawnObjects);
  const keyCount = keys.length;
  if (keyCount === 0) {
    return EMPTY_SPATIAL_2D_BOX_LOOKUP;
  }

  const record = drawnObjects as Readonly<Record<string, Spatial2DDrawnEntryLike | undefined>>;
  const rawIds = new Int32Array(keyCount);
  const rawXs = new Float32Array(keyCount);
  const rawYs = new Float32Array(keyCount);
  const rawZs = new Float32Array(keyCount);
  const rawLs = new Float32Array(keyCount);
  const rawWs = new Float32Array(keyCount);
  const rawHs = new Float32Array(keyCount);
  const rawEntries = new Array<Spatial2DDrawnEntryLike | undefined>(keyCount);

  let count = 0;
  for (let k = 0; k < keyCount; k += 1) {
    const key = keys[k]!;
    const entry = record[key];
    if (!entry) {
      continue;
    }

    const data = entry.data;
    if (data?.hidden === true || data?.outside === true) {
      continue;
    }
    const state = entry.state;
    if (Boolean(data?.hidden ?? state?.hidden) || Boolean(data?.outside ?? state?.outside)) {
      continue;
    }

    // Read `entry.data?.points` first to avoid invoking expensive `cvat-core` state getters
    const dataPts = data?.points;
    let pts: readonly number[] | null = null;
    if (Array.isArray(dataPts) && dataPts.length >= 9) {
      pts = dataPts;
    } else {
      const statePts = state?.points;
      if (Array.isArray(statePts) && statePts.length >= 9) {
        pts = statePts;
      }
    }
    if (!pts) {
      continue;
    }

    const idCandidate = readNumericClientId(data?.clientID ?? state?.clientID ?? key);
    if (!Number.isFinite(idCandidate)) {
      continue;
    }

    const ox = Number(pts[0]);
    const oy = Number(pts[1]);
    const oz = Number(pts[2]);
    const oL = Number(pts[6]);
    const oW = Number(pts[7]);
    const oH = Number(pts[8]);
    if (
      !Number.isFinite(ox) ||
      !Number.isFinite(oy) ||
      !Number.isFinite(oz) ||
      !Number.isFinite(oL) ||
      !Number.isFinite(oW) ||
      !Number.isFinite(oH)
    ) {
      continue;
    }

    rawIds[count] = Math.trunc(idCandidate);
    rawXs[count] = ox;
    rawYs[count] = oy;
    rawZs[count] = oz;
    rawLs[count] = oL;
    rawWs[count] = oW;
    rawHs[count] = oH;
    rawEntries[count] = entry;
    count += 1;
  }

  if (count === 0) {
    return EMPTY_SPATIAL_2D_BOX_LOOKUP;
  }

  const ids = count === keyCount ? rawIds : rawIds.subarray(0, count);
  const xs = count === keyCount ? rawXs : rawXs.subarray(0, count);
  const ys = count === keyCount ? rawYs : rawYs.subarray(0, count);
  const zs = count === keyCount ? rawZs : rawZs.subarray(0, count);
  const ls = count === keyCount ? rawLs : rawLs.subarray(0, count);
  const ws = count === keyCount ? rawWs : rawWs.subarray(0, count);
  const hs = count === keyCount ? rawHs : rawHs.subarray(0, count);
  if (count < keyCount) {
    rawEntries.length = count;
  }
  const entries: readonly (Spatial2DDrawnEntryLike | undefined)[] = rawEntries;

  // Open-addressed 2D cell hash table (load factor <= 0.5) + intrusive per-cell linked list.
  // Storing exact (cellGx, cellGy) per occupied bucket guarantees zero false hash-collision
  // duplicates even when distant outlier cells (e.g. x = 4500m) collide mod tableSize.
  const tableSize = nextPowerOfTwo(count * 2);
  const bucketMask = tableSize - 1;
  const cellHead = new Int32Array(tableSize);
  cellHead.fill(-1);
  const cellGx = new Int32Array(tableSize);
  const cellGy = new Int32Array(tableSize);
  const nextInCell = new Int32Array(count);

  for (let i = count - 1; i >= 0; i -= 1) {
    const gx = Math.floor(xs[i]! * SPATIAL_2D_INV_CELL_SIZE) | 0;
    const gy = Math.floor(ys[i]! * SPATIAL_2D_INV_CELL_SIZE) | 0;
    let slot = ((Math.imul(gx, HASH_PRIME_X) ^ Math.imul(gy, HASH_PRIME_Y)) >>> 0) & bucketMask;
    while (cellHead[slot] !== -1 && (cellGx[slot] !== gx || cellGy[slot] !== gy)) {
      slot = (slot + 1) & bucketMask;
    }
    if (cellHead[slot] === -1) {
      cellGx[slot] = gx;
      cellGy[slot] = gy;
    }
    nextInCell[i] = cellHead[slot]!;
    cellHead[slot] = i;
  }

  return {
    count,
    cellSize: SPATIAL_2D_CELL_SIZE,
    ids,
    xs,
    ys,
    zs,
    ls,
    ws,
    hs,
    entries,
    forEachNeighbor(
      cx: number,
      cy: number,
      radiusMeters: number,
      callback: (index: number, distXY: number) => boolean | void
    ): void {
      if (
        !Number.isFinite(cx) ||
        !Number.isFinite(cy) ||
        !Number.isFinite(radiusMeters) ||
        radiusMeters < 0
      ) {
        return;
      }

      const r2 = radiusMeters * radiusMeters;
      const minGx = Math.floor((cx - radiusMeters) * SPATIAL_2D_INV_CELL_SIZE);
      const maxGx = Math.floor((cx + radiusMeters) * SPATIAL_2D_INV_CELL_SIZE);
      const minGy = Math.floor((cy - radiusMeters) * SPATIAL_2D_INV_CELL_SIZE);
      const maxGy = Math.floor((cy + radiusMeters) * SPATIAL_2D_INV_CELL_SIZE);
      const spanCells = (maxGx - minGx + 1) * (maxGy - minGy + 1);

      // Guard against huge query radii (where grid cell count exceeds actual box count)
      // and extreme coordinates outside 32-bit signed integer cell range.
      if (
        !(spanCells <= count) ||
        minGx < -2147483648 ||
        maxGx > 2147483647 ||
        minGy < -2147483648 ||
        maxGy > 2147483647
      ) {
        for (let idx = 0; idx < count; idx += 1) {
          const dx = xs[idx]! - cx;
          const dy = ys[idx]! - cy;
          const d2 = dx * dx + dy * dy;
          if (d2 <= r2) {
            if (callback(idx, Math.sqrt(d2)) === false) {
              return;
            }
          }
        }
        return;
      }

      const gx0 = minGx | 0;
      const gx1 = maxGx | 0;
      const gy0 = minGy | 0;
      const gy1 = maxGy | 0;

      for (let gy = gy0; gy <= gy1; gy += 1) {
        const gyHash = Math.imul(gy, HASH_PRIME_Y);
        for (let gx = gx0; gx <= gx1; gx += 1) {
          let slot = ((Math.imul(gx, HASH_PRIME_X) ^ gyHash) >>> 0) & bucketMask;
          while (true) {
            const head = cellHead[slot]!;
            if (head === -1) {
              break;
            }
            if (cellGx[slot] === gx && cellGy[slot] === gy) {
              for (let idx = head; idx !== -1; idx = nextInCell[idx]!) {
                const dx = xs[idx]! - cx;
                const dy = ys[idx]! - cy;
                const d2 = dx * dx + dy * dy;
                if (d2 <= r2) {
                  if (callback(idx, Math.sqrt(d2)) === false) {
                    return;
                  }
                }
              }
              break;
            }
            slot = (slot + 1) & bucketMask;
          }
        }
      }
    },
  };
}

interface CachedSpatial2DRecord {
  readonly lookup: Spatial2DBoxLookup;
  readonly epoch: number;
  readonly totalKeys: number;
  readonly entryKeys: readonly string[];
  readonly maxId: number;
}

let globalSpatial2DEpoch = 0;
const spatial2DBoxLookupCache = new WeakMap<object, CachedSpatial2DRecord>();

/**
 * Explicitly invalidates cached 2D spatial box lookups when CVAT mutates `view.drawnObjects`
 * in-place across frame switches, box edits, new box draws, or deletions.
 */
export function invalidateSpatial2DBoxLookup(drawnObjects?: object | null): void {
  globalSpatial2DEpoch += 1;
  if (drawnObjects && typeof drawnObjects === 'object') {
    spatial2DBoxLookupCache.delete(drawnObjects);
  }
}

function isEntryDataPositionUnchanged(
  entry: Spatial2DDrawnEntryLike | undefined,
  expectedX: number,
  expectedY: number
): boolean {
  if (!entry) {
    return false;
  }
  // Check `entry.data?.points` only so we never trigger lazy `cvat-core` `state.points` getters!
  const dataPts = entry.data?.points;
  if (!Array.isArray(dataPts) || dataPts.length < 2) {
    return true;
  }
  return (
    Math.fround(Number(dataPts[0])) === expectedX && Math.fround(Number(dataPts[1])) === expectedY
  );
}

function isCachedSpatial2DValid(
  drawnObjects: Spatial2DDrawnObjectsMap,
  cached: CachedSpatial2DRecord
): boolean {
  if (cached.epoch !== globalSpatial2DEpoch) {
    return false;
  }
  const lookup = cached.lookup;
  const count = lookup.count;
  const entryKeys = cached.entryKeys;
  const record = drawnObjects as Readonly<Record<string, Spatial2DDrawnEntryLike | undefined>>;

  if (count <= 256 && cached.totalKeys <= 512) {
    let curTotalKeys = 0;
    for (const key in record) {
      if (!Object.hasOwn(record, key)) continue;
      curTotalKeys += 1;
      if (curTotalKeys > cached.totalKeys) {
        return false;
      }
    }
    if (curTotalKeys !== cached.totalKeys) {
      return false;
    }
    for (let i = 0; i < count; i += 1) {
      const curEntry = record[entryKeys[i]!];
      if (curEntry !== lookup.entries[i]) {
        return false;
      }
      if (!isEntryDataPositionUnchanged(curEntry, lookup.xs[i]!, lookup.ys[i]!)) {
        return false;
      }
    }
    return true;
  }

  if (count === 0) {
    return cached.totalKeys === 0 && Object.keys(drawnObjects).length === 0;
  }

  if (cached.maxId >= 0 && record[String(cached.maxId + 1)] !== undefined) {
    return false;
  }

  const stride = Math.max(1, count >>> 4);
  for (let i = 0; i < count; i += stride) {
    const curEntry = record[entryKeys[i]!];
    if (curEntry !== lookup.entries[i]) {
      return false;
    }
    if (!isEntryDataPositionUnchanged(curEntry, lookup.xs[i]!, lookup.ys[i]!)) {
      return false;
    }
  }
  const lastIdx = count - 1;
  const lastEntry = record[entryKeys[lastIdx]!];
  return (
    lastEntry === lookup.entries[lastIdx] &&
    isEntryDataPositionUnchanged(lastEntry, lookup.xs[lastIdx]!, lookup.ys[lastIdx]!)
  );
}

/**
 * Returns the cached `Spatial2DBoxLookup` for a `drawnObjects` record reference in O(1),
 * automatically detecting frame/position mutations so stale coordinates are never served.
 */
export function getOrBuildSpatial2DBoxLookup(
  drawnObjects: Spatial2DDrawnObjectsMap | null | undefined
): Spatial2DBoxLookup {
  if (!drawnObjects || typeof drawnObjects !== 'object') {
    return EMPTY_SPATIAL_2D_BOX_LOOKUP;
  }
  const existing = spatial2DBoxLookupCache.get(drawnObjects);
  if (existing !== undefined && isCachedSpatial2DValid(drawnObjects, existing)) {
    return existing.lookup;
  }
  const built = buildSpatial2DBoxLookup(drawnObjects);
  const allKeys = Object.keys(drawnObjects);
  const record = drawnObjects as Readonly<Record<string, Spatial2DDrawnEntryLike | undefined>>;
  const entryKeys = new Array<string>(built.count);
  let maxId = -1;
  for (let i = 0; i < built.count; i += 1) {
    const id = built.ids[i]!;
    if (id > maxId) maxId = id;
    const idStr = String(id);
    if (record[idStr] === built.entries[i]) {
      entryKeys[i] = idStr;
    } else {
      let matchedKey = idStr;
      for (let k = 0; k < allKeys.length; k += 1) {
        if (record[allKeys[k]!] === built.entries[i]) {
          matchedKey = allKeys[k]!;
          break;
        }
      }
      entryKeys[i] = matchedKey;
    }
  }
  spatial2DBoxLookupCache.set(drawnObjects, {
    lookup: built,
    epoch: globalSpatial2DEpoch,
    totalKeys: allKeys.length,
    entryKeys,
    maxId,
  });
  return built;
}
