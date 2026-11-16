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
      expect(classifyPointInBoxes(index, boxes, px, py, pz)).toBe(expected);
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
});
