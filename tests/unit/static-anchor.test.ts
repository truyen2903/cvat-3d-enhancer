import { describe, expect, it } from 'vitest';
import type { CvatObjectStateLike } from '../../src/integration/cvat/runtime/pre-render-enhancer';
import {
  anchorErrorAt1Deg,
  checkAnchorConsistency,
  insideKeyframes,
  pickReferenceFrame,
  predictFromAnchor,
} from '../../src/integration/cvat/runtime/static-anchor';

const B_K = [10, 0, 0, 0, 0, 0, 4, 2, 1.5];
const A_K = [20, 0, 1, 0.01, 0.02, 0.3, 3, 1, 1];
const A_NOW = [0, 0, 0, 0, 0, 0, 9, 9, 9, 7, 8]; // tail 7, 8 must survive

describe('predictFromAnchor', () => {
  it('returns the reference box when the anchor did not move', () => {
    const out = predictFromAnchor(B_K, A_K, B_K, A_NOW)!;
    expect(out.slice(0, 9).map((v) => +v.toFixed(9))).toEqual(A_K);
    expect(out.slice(9)).toEqual([7, 8]);
  });

  it('rotates the offset with the anchor yaw and shifts z with the anchor', () => {
    const bNow = [0, 0, 0.5, 0, 0, Math.PI / 2, 4, 2, 1.5];
    const out = predictFromAnchor(B_K, A_K, bNow, A_NOW)!;
    expect(out[0]).toBeCloseTo(0);
    expect(out[1]).toBeCloseTo(10);
    expect(out[2]).toBeCloseTo(1.5);
    expect(out[3]).toBe(0.01);
    expect(out[4]).toBe(0.02);
    expect(out[5]).toBeCloseTo(0.3 + Math.PI / 2);
    expect(out.slice(6, 9)).toEqual([3, 1, 1]);
  });

  it('takes the short way across the 0/2π seam', () => {
    const ref = [0, 0, 0, 0, 0, 6.2, 4, 2, 1.5];
    const now = [0, 0, 0, 0, 0, 0.1, 4, 2, 1.5];
    const out = predictFromAnchor(ref, [10, 0, 0, 0, 0, 0, 3, 1, 1], now, A_NOW)!;
    const d = 0.1 - 6.2 + 2 * Math.PI;
    expect(out[0]).toBeCloseTo(10 * Math.cos(d));
    expect(out[1]).toBeCloseTo(10 * Math.sin(d));
    expect(out[5]).toBeCloseTo(d);
  });

  it('rejects short, non-finite or zero-size input', () => {
    expect(predictFromAnchor(B_K.slice(0, 8), A_K, B_K, A_NOW)).toBeNull();
    expect(predictFromAnchor(B_K, [...A_K.slice(0, 6), 0, 1, 1], B_K, A_NOW)).toBeNull();
    expect(predictFromAnchor(B_K, A_K, [NaN, ...B_K.slice(1)], A_NOW)).toBeNull();
    expect(predictFromAnchor(B_K, A_K, B_K, A_NOW.slice(0, 8))).toBeNull();
  });
});

describe('checkAnchorConsistency', () => {
  it('flags a resized or flipped anchor at the exact thresholds', () => {
    const size = (k: number) => [10, 0, 0, 0, 0, 0, 4 * k, 2, 1.5];
    expect(checkAnchorConsistency(B_K, size(1.09))).toBe('ok');
    expect(checkAnchorConsistency(B_K, size(1.11))).toBe('size-changed');
    const yaw = (deg: number) => [10, 0, 0, 0, 0, (deg * Math.PI) / 180, 4, 2, 1.5];
    expect(checkAnchorConsistency(B_K, yaw(134))).toBe('ok');
    expect(checkAnchorConsistency(B_K, yaw(136))).toBe('heading-flip');
    expect(checkAnchorConsistency(B_K, yaw(-136))).toBe('heading-flip');
  });
});

describe('reference frame', () => {
  it('picks the nearest common keyframe, earlier on ties, never the current frame', () => {
    expect(pickReferenceFrame(5, [1, 5, 9], [1, 5, 9])).toBe(1);
    expect(pickReferenceFrame(5, [2, 7], [2, 7, 8])).toBe(7);
    expect(pickReferenceFrame(5, [5], [5])).toBeNull();
    expect(pickReferenceFrame(5, [1], [2])).toBeNull();
  });

  it('reads only inside keyframes from the serialized track', () => {
    const state = {
      objectType: 'track',
      __internal: {
        export: () => ({ shapes: [{ frame: 9 }, { frame: 2, outside: true }, { frame: 4 }] }),
      },
    } as unknown as CvatObjectStateLike;
    expect(insideKeyframes(state)).toEqual([4, 9]);
    expect(insideKeyframes({ objectType: 'shape' })).toBeNull();
    const broken = {
      objectType: 'track',
      __internal: { export: () => ({ shapes: [{ frame: -1 }] }) },
    } as unknown as CvatObjectStateLike;
    expect(insideKeyframes(broken)).toBeNull();
  });
});

describe('anchorErrorAt1Deg', () => {
  it('estimates the lever-arm error for a 1° yaw error', () => {
    expect(
      anchorErrorAt1Deg([0, 0, 0, 0, 0, 0, 1, 1, 1], [30, 0, 0, 0, 0, 0, 1, 1, 1])
    ).toBeCloseTo(0.5236, 3);
  });
});
