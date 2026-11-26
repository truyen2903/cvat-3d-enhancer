import { describe, expect, it } from 'vitest';
import {
  buildQcShells,
  resolveQcMarginRatio,
} from '../../src/integration/cvat/runtime/qc-margin-geometry';

describe('resolveQcMarginRatio', () => {
  it('maps the three labels case-insensitively', () => {
    expect(resolveQcMarginRatio('vehicles')).toBe(0.05);
    expect(resolveQcMarginRatio(' Vehicles ')).toBe(0.05);
    expect(resolveQcMarginRatio('TWO-WHEELS')).toBe(0.08);
    expect(resolveQcMarginRatio('pedestrian')).toBe(0.1);
  });

  it.each(['Animal', 'Obstacle', '', undefined, null])('ignores %s', (label) => {
    expect(resolveQcMarginRatio(label)).toBeNull();
  });
});

describe('buildQcShells', () => {
  it('builds outer and inner corners for an axis-aligned 4x2x2 box at ratio 0.05', () => {
    const out = new Float64Array(48);
    expect(buildQcShells([0, 0, 0, 0, 0, 0, 4, 2, 2], 0.05, out)).toBe(true);
    expect(out[0]).toBeCloseTo(-2.1);
    expect(out[1]).toBeCloseTo(-1.05);
    expect(out[2]).toBeCloseTo(-1.05);
    expect(out[21]).toBeCloseTo(2.1);
    expect(out[22]).toBeCloseTo(1.05);
    expect(out[23]).toBeCloseTo(1.05);
    expect(out[45]).toBeCloseTo(1.9);
    expect(out[46]).toBeCloseTo(0.95);
  });

  it('rejects invalid points without touching out', () => {
    const out = new Float64Array(48).fill(7);
    expect(buildQcShells([0, 0, 0, 0, 0, 0, 4, 2], 0.05, out)).toBe(false);
    expect(buildQcShells([0, 0, 0, 0, 0, 0, 4, NaN, 2], 0.05, out)).toBe(false);
    expect(buildQcShells([0, 0, 0, 0, 0, 0, 4, 0, 2], 0.05, out)).toBe(false);
    expect(out.every((v) => v === 7)).toBe(true);
  });
});
