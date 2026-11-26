import { cuboidAxes } from './ortho-cuboid-editor';

/** Margin (size ± ratio) used for the P-error QC shells, per CVAT label. */
export const QC_MARGIN_RATIOS = {
  vehicles: 0.05,
  'two-wheels': 0.08,
  pedestrian: 0.1,
} as const satisfies Readonly<Record<string, number>>;

type QcLabelKey = keyof typeof QC_MARGIN_RATIOS;

const LABEL_ALIASES: Readonly<Record<string, QcLabelKey>> = {
  vehicles: 'vehicles',
  vehicle: 'vehicles',
  'two-wheels': 'two-wheels',
  'two-wheel': 'two-wheels',
  twowheels: 'two-wheels',
  two_wheels: 'two-wheels',
  pedestrian: 'pedestrian',
  pedestrians: 'pedestrian',
};

export function resolveQcMarginRatio(labelName: string | null | undefined): number | null {
  if (typeof labelName !== 'string') return null;
  const key = LABEL_ALIASES[labelName.trim().toLowerCase()];
  return key ? QC_MARGIN_RATIOS[key] : null;
}

/**
 * Writes 16 corners (x, y, z) into `out`: 8 outer (size × (1 + ratio)) then 8 inner
 * (size × (1 − ratio)). Corner i uses a + sign on axis k when bit k of i is set.
 */
export function buildQcShells(
  points: readonly number[],
  ratio: number,
  out: Float64Array
): boolean {
  if (points.length < 9 || out.length < 48) return false;
  for (let i = 0; i < 9; i += 1) if (!Number.isFinite(points[i])) return false;
  if (points[6]! <= 0 || points[7]! <= 0 || points[8]! <= 0) return false;

  const axes = cuboidAxes(points);
  for (let shell = 0; shell < 2; shell += 1) {
    const scale = shell === 0 ? 1 + ratio : 1 - ratio;
    for (let corner = 0; corner < 8; corner += 1) {
      let x = points[0]!;
      let y = points[1]!;
      let z = points[2]!;
      for (let k = 0; k < 3; k += 1) {
        const half = (points[6 + k]! * scale) / 2;
        const signed = corner & (1 << k) ? half : -half;
        const axis = axes[k]!;
        x += axis[0] * signed;
        y += axis[1] * signed;
        z += axis[2] * signed;
      }
      const o = (shell * 8 + corner) * 3;
      out[o] = x;
      out[o + 1] = y;
      out[o + 2] = z;
    }
  }
  return true;
}
