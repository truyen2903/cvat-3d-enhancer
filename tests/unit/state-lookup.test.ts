import { describe, expect, it, vi } from 'vitest';
import type { CvatDrawnObjectEntry } from '../../src/integration/cvat/runtime/pre-render-enhancer';
import {
  DrawnObjectsCache,
  type DrawnObjectEntryLike,
  SPATIAL_2D_CELL_SIZE,
  findObjectStateByClientId,
  getOrBuildSpatial2DBoxLookup,
  isNumericClientIdName,
} from '../../src/integration/cvat/runtime/state-lookup';

function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

describe('isNumericClientIdName', () => {
  it('accepts non-empty ASCII digit strings without using regex', () => {
    expect(isNumericClientIdName('0')).toBe(true);
    expect(isNumericClientIdName('1')).toBe(true);
    expect(isNumericClientIdName('42')).toBe(true);
    expect(isNumericClientIdName('99999')).toBe(true);
    expect(isNumericClientIdName('0007')).toBe(true);
  });

  it('rejects empty strings, whitespace, signs, decimals, boundary ASCII chars, and non-strings', () => {
    expect(isNumericClientIdName('')).toBe(false);
    expect(isNumericClientIdName(' 12')).toBe(false);
    expect(isNumericClientIdName('12 ')).toBe(false);
    expect(isNumericClientIdName('\t5')).toBe(false);
    expect(isNumericClientIdName('\n5')).toBe(false);
    expect(isNumericClientIdName('-1')).toBe(false);
    expect(isNumericClientIdName('+1')).toBe(false);
    expect(isNumericClientIdName('1.5')).toBe(false);
    expect(isNumericClientIdName('1e3')).toBe(false);
    expect(isNumericClientIdName('/')).toBe(false); // charCode 47 ('0' - 1)
    expect(isNumericClientIdName(':')).toBe(false); // charCode 58 ('9' + 1)
    expect(isNumericClientIdName('12/3')).toBe(false);
    expect(isNumericClientIdName('12:3')).toBe(false);
    expect(isNumericClientIdName('topPlane')).toBe(false);
    expect(isNumericClientIdName('١٢٣')).toBe(false);
    expect(isNumericClientIdName('１２３')).toBe(false);
    expect(isNumericClientIdName(null)).toBe(false);
    expect(isNumericClientIdName(undefined)).toBe(false);
    expect(isNumericClientIdName(123)).toBe(false);
    expect(isNumericClientIdName(NaN)).toBe(false);
    expect(isNumericClientIdName({})).toBe(false);
  });
});

describe('findObjectStateByClientId', () => {
  it('handles null, undefined, empty arrays, and non-finite clientIDs safely', () => {
    expect(findObjectStateByClientId(null, 1)).toBeNull();
    expect(findObjectStateByClientId(undefined, 1)).toBeNull();
    expect(findObjectStateByClientId([], 0)).toBeNull();

    const states = [{ clientID: 0 }, { clientID: 1 }];
    expect(findObjectStateByClientId(states, NaN)).toBeNull();
    expect(findObjectStateByClientId(states, Infinity)).toBeNull();
    expect(findObjectStateByClientId(states, -Infinity)).toBeNull();
  });

  it('never confuses null, undefined, or blank string clientIDs with clientID = 0', () => {
    const small = [
      { clientID: null, label: 'null-id' },
      { clientID: undefined, label: 'undef-id' },
      { clientID: '', label: 'empty-id' },
      { clientID: '   ', label: 'spaces-id' },
      { clientID: 0, label: 'real-zero' },
    ];
    expect(findObjectStateByClientId(small, 0)?.label).toBe('real-zero');

    const onlyInvalid = Array.from({ length: 64 }, (_, idx) => ({
      clientID: idx % 2 === 0 ? null : '',
      idx,
    }));
    expect(findObjectStateByClientId(onlyInvalid, 0)).toBeNull();
  });

  it('finds elements in 100,000 sorted states in <= 17 getter reads with zero Map build', () => {
    let getterReads = 0;
    const states = Array.from({ length: 100_000 }, (_, i) => {
      const id = i * 2 + 10;
      return {
        idx: i,
        get clientID(): number {
          getterReads += 1;
          return id;
        },
      };
    });

    for (const targetIdx of [0, 1, 12_345, 50_000, 87_654, 99_999]) {
      getterReads = 0;
      const targetId = targetIdx * 2 + 10;
      const found = findObjectStateByClientId(states, targetId);
      expect(found?.idx).toBe(targetIdx);
      expect(getterReads).toBeLessThanOrEqual(17);
    }
  });

  it('caches a Map in WeakMap after the first miss so 1,000 subsequent calls read 0 getters', () => {
    let getterReads = 0;
    const states = Array.from({ length: 5_000 }, (_, i) => ({
      idx: i,
      get clientID(): number {
        getterReads += 1;
        return i * 3;
      },
    }));

    // First miss (e.g. active object hidden by CVAT filter) builds the Map once
    expect(findObjectStateByClientId(states, 999_999)).toBeNull();
    expect(getterReads).toBeGreaterThan(0);

    // Next 1,000 misses and hits on the same Redux `states` array read 0 getters!
    getterReads = 0;
    for (let k = 0; k < 500; k += 1) {
      expect(findObjectStateByClientId(states, 999_999)).toBeNull();
      expect(findObjectStateByClientId(states, ((k * 7) % 5_000) * 3)?.idx).toBe((k * 7) % 5_000);
    }
    expect(getterReads).toBe(0);
  });

  it('never misses elements when CVAT states are shuffled, reversed, or sorted by another column', () => {
    const rand = seeded(123);
    const shuffled = Array.from({ length: 2_000 }, (_, i) => ({
      clientID: i % 5 === 0 ? String(i) : i,
      marker: `obj-${i}`,
    }));
    for (let i = shuffled.length - 1; i > 0; i -= 1) {
      const j = Math.floor(rand() * (i + 1));
      const tmp = shuffled[i]!;
      shuffled[i] = shuffled[j]!;
      shuffled[j] = tmp;
    }

    for (let i = 0; i < 2_000; i += 17) {
      const found = findObjectStateByClientId(shuffled, i);
      expect(found?.marker).toBe(`obj-${i}`);
    }
    expect(findObjectStateByClientId(shuffled, 99_999)).toBeNull();

    // Reversed descending order (both <= 32 and > 32)
    const reversedSmall = Array.from({ length: 16 }, (_, i) => ({ clientID: 100 - i, i }));
    expect(findObjectStateByClientId(reversedSmall, 100)?.i).toBe(0);
    expect(findObjectStateByClientId(reversedSmall, 85)?.i).toBe(15);

    const reversedLarge = Array.from({ length: 200 }, (_, i) => ({ clientID: 500 - i, i }));
    expect(findObjectStateByClientId(reversedLarge, 500)?.i).toBe(0);
    expect(findObjectStateByClientId(reversedLarge, 301)?.i).toBe(199);
  });
});

describe('DrawnObjectsCache', () => {
  it('handles null/missing canvas and throwing getDrawnObjects defensively', () => {
    const cache = new DrawnObjectsCache();
    expect(cache.getMap(null)).toEqual({});
    expect(cache.getMap(undefined)).toEqual({});
    expect(cache.getMap({})).toEqual({});
    expect(cache.getEntryById(null, 1)).toBeNull();
    expect(cache.getEntryById({}, 1)).toBeNull();
    expect(cache.getEntryById({ getDrawnObjects: () => [] }, NaN)).toBeNull();

    const brokenCanvas = {
      getDrawnObjects: (): never => {
        throw new Error('DOM canvas disposed');
      },
    };
    expect(cache.getMap(brokenCanvas)).toEqual({});
    expect(cache.getEntryById(brokenCanvas, 0)).toBeNull();
  });

  it('caches getMap in O(1) across same generation and across invalidate() when array ref + length match', () => {
    let idReads = 0;
    const list = Array.from({ length: 200 }, (_, i) => ({
      data: {
        get clientID(): number {
          idReads += 1;
          return i + 100;
        },
      },
    }));
    const getDrawnObjects = vi.fn(() => list);
    const canvas = { getDrawnObjects };

    const cache = new DrawnObjectsCache<(typeof list)[number]>();
    const map1 = cache.getMap(canvas);
    expect(Object.keys(map1)).toHaveLength(200);
    expect(map1[150]).toBe(list[50]);
    expect(getDrawnObjects).toHaveBeenCalledTimes(1);
    const readsAfterFirstBuild = idReads;
    expect(readsAfterFirstBuild).toBe(200);

    // Same generation -> O(1), does not even call getDrawnObjects or read clientID again
    const map2 = cache.getMap(canvas);
    expect(map2).toBe(map1);
    expect(getDrawnObjects).toHaveBeenCalledTimes(1);
    expect(idReads).toBe(readsAfterFirstBuild);

    // After invalidate(), if getDrawnObjects() returns the exact same array ref & length -> reuses map1!
    cache.invalidate();
    const map3 = cache.getMap(canvas);
    expect(map3).toBe(map1);
    expect(getDrawnObjects).toHaveBeenCalledTimes(2);
    expect(idReads).toBe(readsAfterFirstBuild);

    // After invalidate() with a new array -> rebuilds map
    const dynamicCache = new DrawnObjectsCache<DrawnObjectEntryLike>();
    const nextList: DrawnObjectEntryLike[] = [
      { data: { clientID: 7 } },
      { state: { clientID: 9 } },
      {},
    ];
    let currentList: readonly DrawnObjectEntryLike[] = nextList;
    const dynamicCanvas = { getDrawnObjects: () => currentList };
    const freshMap = dynamicCache.getMap(dynamicCanvas);
    expect(freshMap[7]).toBe(nextList[0]);
    expect(freshMap[9]).toBe(nextList[1]);
    expect(freshMap[2]).toBe(nextList[2]); // fallback to idx

    currentList = [{ data: { clientID: 42 } }];
    dynamicCache.invalidate();
    const updatedMap = dynamicCache.getMap(dynamicCanvas);
    expect(updatedMap[42]).toBe(currentList[0]);
    expect(updatedMap[7]).toBeUndefined();
  });

  it('resolves getEntryById in <= 17 binary search steps on 100k items and builds record only on miss', () => {
    let idReads = 0;
    const list = Array.from({ length: 100_000 }, (_, i) => ({
      idx: i,
      data: {
        get clientID(): number {
          idReads += 1;
          return i * 2;
        },
      },
    }));
    const canvas = { getDrawnObjects: () => list };
    const cache = new DrawnObjectsCache<(typeof list)[number]>();

    // Hit via binary search -> <= 17 reads, no 100k record built
    const hit = cache.getEntryById(canvas, 150_000);
    expect(hit?.idx).toBe(75_000);
    expect(idReads).toBeLessThanOrEqual(17);

    // Miss triggers 1-time record build for this generation; subsequent calls are O(1) with 0 reads
    expect(cache.getEntryById(canvas, 150_001)).toBeNull();
    idReads = 0;
    for (let i = 0; i < 200; i += 1) {
      expect(cache.getEntryById(canvas, 199_998)?.idx).toBe(99_999);
      expect(cache.getEntryById(canvas, 150_001)).toBeNull();
    }
    expect(idReads).toBe(0);
  });

  it('finds entries accurately in getEntryById even when getDrawnObjects() is unsorted', () => {
    const list = [
      ...Array.from({ length: 50 }, (_, i) => ({ data: { clientID: 1000 - i }, idx: i })),
    ];
    const cache = new DrawnObjectsCache<(typeof list)[number]>();
    const canvas = { getDrawnObjects: () => list };
    expect(cache.getEntryById(canvas, 1000)?.idx).toBe(0);
    expect(cache.getEntryById(canvas, 951)?.idx).toBe(49);
    expect(cache.getEntryById(canvas, 500)).toBeNull();
  });
});

describe('Spatial2DBoxLookup', () => {
  it('caches per drawnObjects reference via WeakMap, prioritizes data.points over state.points, and skips hidden/outside/invalid boxes', () => {
    let statePointsReads = 0;
    const drawnObjects: Record<number, CvatDrawnObjectEntry> = {
      1: {
        data: {
          clientID: 1,
          points: [10, 20, -0.5, 0, 0, 0, 4.5, 1.9, 1.6],
          hidden: false,
          outside: false,
        },
        state: {
          clientID: 1,
          get points(): number[] {
            statePointsReads += 1;
            return [10, 20, -0.5, 0, 0, 0, 4.5, 1.9, 1.6];
          },
        },
        cuboid: {},
      },
      2: {
        // Missing data.points -> falls back to state.points
        data: {
          clientID: 2,
          points: [],
        },
        state: {
          clientID: 2,
          get points(): number[] {
            statePointsReads += 1;
            return [12, 21, -0.4, 0, 0, 0, 4.2, 1.8, 1.5];
          },
        },
        cuboid: {},
      },
      3: {
        data: {
          clientID: 3,
          points: [10, 20, -0.5, 0, 0, 0, 4.0, 1.8, 1.5],
          hidden: true,
        },
        cuboid: {},
      },
      4: {
        data: {
          clientID: 4,
          points: [10, 20, -0.5, 0, 0, 0, 4.0, 1.8, 1.5],
          outside: true,
        },
        cuboid: {},
      },
      5: {
        data: {
          clientID: 5,
          points: [NaN, 20, -0.5, 0, 0, 0, 4.0, 1.8, 1.5],
        },
        cuboid: {},
      },
    };

    const lookup1 = getOrBuildSpatial2DBoxLookup(drawnObjects);
    expect(statePointsReads).toBe(1); // Only ID #2 touched state.points; ID #1 used data.points!
    expect(lookup1.cellSize).toBe(4.0);
    expect(SPATIAL_2D_CELL_SIZE).toBe(4.0);
    expect(lookup1.count).toBe(2);
    expect(lookup1.ids).toBeInstanceOf(Int32Array);
    expect(lookup1.xs).toBeInstanceOf(Float32Array);
    expect(lookup1.ys).toBeInstanceOf(Float32Array);
    expect(lookup1.zs).toBeInstanceOf(Float32Array);
    expect(lookup1.ls).toBeInstanceOf(Float32Array);
    expect(lookup1.ws).toBeInstanceOf(Float32Array);
    expect(lookup1.hs).toBeInstanceOf(Float32Array);
    expect(Array.from(lookup1.ids)).toEqual([1, 2]);

    // Second call returns cached WeakMap entry with 0 additional work
    const lookup2 = getOrBuildSpatial2DBoxLookup(drawnObjects);
    expect(lookup2).toBe(lookup1);
    expect(statePointsReads).toBe(1);

    // Defensive handling for null/undefined/empty
    expect(getOrBuildSpatial2DBoxLookup(null).count).toBe(0);
    expect(getOrBuildSpatial2DBoxLookup(undefined).count).toBe(0);
    expect(getOrBuildSpatial2DBoxLookup({}).count).toBe(0);
  });

  it('matches brute-force Euclidean radius queries 100% with zero duplicates across 2,000 boxes + x=4500m outliers', () => {
    const rand = seeded(99);
    const drawnObjects: Record<number, CvatDrawnObjectEntry> = {};
    for (let i = 0; i < 2_000; i += 1) {
      let x = (rand() - 0.5) * 160;
      let y = (rand() - 0.5) * 40;
      if (i === 5 || i === 1500) {
        x = 4500;
        y = i === 5 ? 3 : -3;
      } else if (i % 10 === 0) {
        x = (rand() - 0.5) * 600;
        y = (rand() - 0.5) * 600;
      }
      drawnObjects[i] = {
        data: {
          clientID: i,
          points: [x, y, -0.8, 0, 0, 0, 4.4, 1.9, 1.6],
        },
        cuboid: {},
      };
    }

    const lookup = getOrBuildSpatial2DBoxLookup(drawnObjects);
    expect(lookup.count).toBe(2_000);

    const queries: [number, number, number][] = [
      [0, 0, 0],
      [12.5, -3.2, 2.2],
      [-45.0, 8.4, 22.0],
      [4500, 0, 5.0],
      [4500, 3, 0.01],
      [10, -5, 10_000], // huge radius fallback
    ];
    for (let q = 0; q < 100; q += 1) {
      queries.push([(rand() - 0.5) * 200, (rand() - 0.5) * 60, rand() * 25]);
    }

    for (const [cx, cy, r] of queries) {
      const r2 = r * r;
      const expectedIds: number[] = [];
      for (let idx = 0; idx < lookup.count; idx += 1) {
        const dx = lookup.xs[idx]! - cx;
        const dy = lookup.ys[idx]! - cy;
        if (dx * dx + dy * dy <= r2) {
          expectedIds.push(lookup.ids[idx]!);
        }
      }

      const actualIds: number[] = [];
      const seenIndices = new Set<number>();
      lookup.forEachNeighbor(cx, cy, r, (idx, distXY) => {
        expect(seenIndices.has(idx)).toBe(false);
        seenIndices.add(idx);
        const dx = lookup.xs[idx]! - cx;
        const dy = lookup.ys[idx]! - cy;
        expect(distXY).toBeCloseTo(Math.hypot(dx, dy), 5);
        actualIds.push(lookup.ids[idx]!);
      });

      actualIds.sort((a, b) => a - b);
      expectedIds.sort((a, b) => a - b);
      expect(actualIds).toEqual(expectedIds);
    }

    // Early termination when callback returns false + invalid query arguments
    let visited = 0;
    lookup.forEachNeighbor(0, 0, 50, () => {
      visited += 1;
      return false;
    });
    expect(visited).toBe(1);

    let invalidVisited = 0;
    lookup.forEachNeighbor(NaN, 0, 10, () => {
      invalidVisited += 1;
    });
    lookup.forEachNeighbor(0, 0, -1, () => {
      invalidVisited += 1;
    });
    lookup.forEachNeighbor(0, 0, NaN, () => {
      invalidVisited += 1;
    });
    expect(invalidVisited).toBe(0);
  });
});
