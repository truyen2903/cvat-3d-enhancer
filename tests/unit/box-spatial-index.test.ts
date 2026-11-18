import { describe, expect, it } from 'vitest';
import {
  POINT_IN_OVERLAP,
  POINT_OUTSIDE_BOXES,
  buildBoxSpatialIndex,
  classifyPointInBoxes,
  compileOrientedCuboids,
  type CvatDrawnObjectEntry,
  type OrientedBoxBounds,
} from '../../src/integration/cvat/runtime/pre-render-enhancer';

/** Reference implementation: the previous linear scan over every box. */
function bruteForce(boxes: readonly OrientedBoxBounds[], px: number, py: number, pz: number) {
  let matched = POINT_OUTSIDE_BOXES;
  for (let b = 0; b < boxes.length; b += 1) {
    const box = boxes[b]!;
    const dx = px - box.cx;
    const dy = py - box.cy;
    const dz = pz - box.cz;
    const lx = box.r00 * dx + box.r01 * dy + box.r02 * dz;
    const ly = box.r10 * dx + box.r11 * dy + box.r12 * dz;
    const lz = box.r20 * dx + box.r21 * dy + box.r22 * dz;
    if (Math.abs(lx) > box.hx || Math.abs(ly) > box.hy || Math.abs(lz) > box.hz) continue;
    if (matched !== POINT_OUTSIDE_BOXES) return POINT_IN_OVERLAP;
    matched = b;
  }
  return matched;
}

function seeded(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function randomScene(count: number) {
  const rand = seeded(42);
  const drawn: Record<number, CvatDrawnObjectEntry> = {};
  for (let id = 0; id < count; id += 1) {
    drawn[id] = {
      data: {
        clientID: id,
        points: [
          (rand() - 0.5) * 160,
          (rand() - 0.5) * 160,
          rand() * 2 - 1,
          (rand() - 0.5) * 0.2,
          (rand() - 0.5) * 0.2,
          rand() * Math.PI * 2,
          1 + rand() * 5,
          1 + rand() * 3,
          1 + rand() * 2.5,
        ],
      },
    } as unknown as CvatDrawnObjectEntry;
  }
  return compileOrientedCuboids(drawn, false);
}

describe('cuboid spatial index', () => {
  it('matches the linear scan for 1000 rotated, overlapping cuboids', () => {
    const boxes = randomScene(1000);
    const index = buildBoxSpatialIndex(boxes)!;
    const rand = seeded(7);
    let inside = 0;
    let overlap = 0;
    for (let i = 0; i < 60000; i += 1) {
      // Bias samples toward box centers so inside/overlap cases are well covered.
      const box = boxes[Math.floor(rand() * boxes.length)]!;
      const near = rand() < 0.7;
      const px = near ? box.cx + (rand() - 0.5) * 6 : (rand() - 0.5) * 200;
      const py = near ? box.cy + (rand() - 0.5) * 6 : (rand() - 0.5) * 200;
      const pz = near ? box.cz + (rand() - 0.5) * 3 : (rand() - 0.5) * 6;
      const expected = bruteForce(boxes, px, py, pz);
      const actual = classifyPointInBoxes(index, boxes, px, py, pz);
      if (actual !== expected) {
        expect(actual).toBe(expected);
      }
      if (expected >= 0) inside += 1;
      if (expected === POINT_IN_OVERLAP) overlap += 1;
    }
    expect(inside).toBeGreaterThan(1000);
    expect(overlap).toBeGreaterThan(10);
  });

  it('is much faster than a linear scan with 1000 cuboids', () => {
    const boxes = randomScene(1000);
    const rand = seeded(3);
    const points = new Float32Array(120000 * 3);
    for (let i = 0; i < points.length; i += 3) {
      points[i] = (rand() - 0.5) * 160;
      points[i + 1] = (rand() - 0.5) * 160;
      points[i + 2] = (rand() - 0.5) * 3;
    }
    const t0 = performance.now();
    const index = buildBoxSpatialIndex(boxes)!;
    let gridHits = 0;
    for (let i = 0; i < points.length; i += 3) {
      if (classifyPointInBoxes(index, boxes, points[i]!, points[i + 1]!, points[i + 2]!) >= 0)
        gridHits += 1;
    }
    const gridMs = performance.now() - t0;
    const t1 = performance.now();
    let linearHits = 0;
    for (let i = 0; i < points.length; i += 3) {
      if (bruteForce(boxes, points[i]!, points[i + 1]!, points[i + 2]!) >= 0) linearHits += 1;
    }
    const linearMs = performance.now() - t1;
    expect(gridHits).toBe(linearHits);
    expect(gridMs * 5).toBeLessThan(linearMs);
  });

  it('skips cuboids with non-finite coordinates instead of matching every point', () => {
    const boxes = compileOrientedCuboids(
      {
        1: { data: { clientID: 1, points: [NaN, 0, 0, 0, 0, 0, 2, 2, 2] } },
        2: { data: { clientID: 2, points: [0, 0, 0, 0, 0, 0, 2, 2, 2] } },
      } as unknown as Record<number, CvatDrawnObjectEntry>,
      false
    );
    expect(boxes.map((box) => box.clientID)).toEqual([2]);
  });

  it('returns no index for an empty box list', () => {
    expect(buildBoxSpatialIndex([])).toBeNull();
  });

  it('prevents grid collapse on x = 4500m outliers, caps cellItems at <= 32 * N with 40m x 40m boxes, and matches bruteForce bit-for-bit', () => {
    const rand = seeded(101);
    const drawn: Record<number, CvatDrawnObjectEntry> = {};
    for (let id = 0; id < 1000; id += 1) {
      drawn[id] = {
        data: {
          clientID: id,
          points: [
            (rand() - 0.5) * 160,
            (rand() - 0.5) * 160,
            rand() * 2 - 1,
            (rand() - 0.5) * 0.15,
            (rand() - 0.5) * 0.15,
            rand() * Math.PI * 2,
            1 + rand() * 4.5,
            1 + rand() * 2.5,
            1 + rand() * 2.2,
          ],
        },
      } as unknown as CvatDrawnObjectEntry;
    }

    // Large 40m x 40m cuboids (including overlapping large-with-small and large-with-large)
    drawn[1000] = {
      data: { clientID: 1000, points: [0, 0, 0, 0, 0, 0.35, 40, 40, 5] },
    } as unknown as CvatDrawnObjectEntry;
    drawn[1001] = {
      data: { clientID: 1001, points: [10, 10, 0, 0.05, -0.05, 0.8, 40, 40, 5] },
    } as unknown as CvatDrawnObjectEntry;

    // Distant coordinate outliers at x = 4500m (including overlapping outliers) and (-3800, 2900)
    drawn[1002] = {
      data: { clientID: 1002, points: [4500, 0, 0, 0, 0, 0.2, 5, 2.2, 2] },
    } as unknown as CvatDrawnObjectEntry;
    drawn[1003] = {
      data: { clientID: 1003, points: [4501, 0.5, 0, 0, 0, -0.4, 5, 2.2, 2] },
    } as unknown as CvatDrawnObjectEntry;
    drawn[1004] = {
      data: { clientID: 1004, points: [-3800, 2900, 1.5, 0, 0, 1.1, 6, 3, 2.5] },
    } as unknown as CvatDrawnObjectEntry;

    const boxes = compileOrientedCuboids(drawn, false);
    const index = buildBoxSpatialIndex(boxes)!;
    expect(index).not.toBeNull();

    // Combinatorial explosion guard: never exceed 32 grid cells per box
    expect(index.cellItems.length).toBeLessThanOrEqual(32 * boxes.length);
    // Fine grid cell size must remain fine (~0.75m..1.5m), NOT collapsed by x = 4500m
    expect(1 / index.invCell).toBeLessThanOrEqual(1.5);
    expect(index.overflowBoxes.length).toBeGreaterThanOrEqual(5);

    const qRand = seeded(2026);
    let insideHits = 0;
    let overlapHits = 0;
    let outlierHits = 0;

    for (let i = 0; i < 40000; i += 1) {
      let px: number;
      let py: number;
      let pz: number;
      const mode = qRand();
      if (mode < 0.65) {
        const box = boxes[Math.floor(qRand() * boxes.length)]!;
        px = box.cx + (qRand() - 0.5) * 8;
        py = box.cy + (qRand() - 0.5) * 8;
        pz = box.cz + (qRand() - 0.5) * 4;
      } else if (mode < 0.85) {
        // Sample inside/around the 40m x 40m boxes
        px = (qRand() - 0.5) * 60;
        py = (qRand() - 0.5) * 60;
        pz = (qRand() - 0.5) * 6;
      } else {
        // Sample around distant outliers at x = 4500m and (-3800, 2900)
        if (qRand() < 0.7) {
          px = 4500 + (qRand() - 0.5) * 10;
          py = (qRand() - 0.5) * 6;
          pz = (qRand() - 0.5) * 4;
        } else {
          px = -3800 + (qRand() - 0.5) * 10;
          py = 2900 + (qRand() - 0.5) * 10;
          pz = 1.5 + (qRand() - 0.5) * 4;
        }
      }

      const expected = bruteForce(boxes, px, py, pz);
      const actual = classifyPointInBoxes(index, boxes, px, py, pz);
      if (actual !== expected) {
        expect(actual).toBe(expected);
      }
      if (expected >= 0) insideHits += 1;
      if (expected === POINT_IN_OVERLAP) overlapHits += 1;
      if (px > 4000 && expected !== POINT_OUTSIDE_BOXES) outlierHits += 1;
    }

    expect(insideHits).toBeGreaterThan(500);
    expect(overlapHits).toBeGreaterThan(100);
    expect(outlierHits).toBeGreaterThan(50);

    // Domain bounds pruning: distant outliers outside LiDAR cloud bounds are completely dropped
    const domainBounds = { minX: -90, maxX: 90, minY: -90, maxY: 90, minZ: -5, maxZ: 5 };
    const prunedIndex = buildBoxSpatialIndex(boxes, domainBounds)!;
    expect(prunedIndex).not.toBeNull();
    expect(prunedIndex.maxX).toBeLessThanOrEqual(90);
    for (let i = 0; i < 5000; i += 1) {
      const px = (qRand() - 0.5) * 180;
      const py = (qRand() - 0.5) * 180;
      const pz = (qRand() - 0.5) * 10;
      const expected = bruteForce(boxes, px, py, pz);
      const actual = classifyPointInBoxes(prunedIndex, boxes, px, py, pz);
      if (actual !== expected) {
        expect(actual).toBe(expected);
      }
    }
  });
});
