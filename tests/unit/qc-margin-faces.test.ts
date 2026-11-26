import { BoxGeometry, Euler, Mesh, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { buildQcShells } from '../../src/integration/cvat/runtime/qc-margin-geometry';

// CVAT renders a cuboid as a unit box scaled by points[6..8] and rotated by Euler XYZ points[3..5].
function cvatCorners(points: number[]): Vector3[] {
  const mesh = new Mesh(new BoxGeometry(1, 1, 1));
  mesh.position.set(points[0]!, points[1]!, points[2]!);
  mesh.rotation.copy(new Euler(points[3]!, points[4]!, points[5]!, 'XYZ'));
  mesh.scale.set(points[6]!, points[7]!, points[8]!);
  mesh.updateMatrixWorld(true);
  const out: Vector3[] = [];
  for (const sx of [-0.5, 0.5])
    for (const sy of [-0.5, 0.5])
      for (const sz of [-0.5, 0.5])
        out.push(new Vector3(sx, sy, sz).applyMatrix4(mesh.matrixWorld));
  return out;
}

const boxes = [
  [0, 0, 0, 0, 0, 0, 4.5, 1.9, 1.6],
  [3, -2, 1, 0.3, -0.2, 1.1, 4.5, 1.9, 1.6],
  [-5, 8, 0.5, 1.2, 0.7, -2.4, 0.7, 0.6, 1.7],
];

describe.each(boxes)('QC shells for box %j', (...raw) => {
  const points = raw as number[];
  const ratio = 0.05;
  const out = new Float64Array(72);
  buildQcShells(points, ratio, out);
  const corner = (shell: number, i: number) =>
    new Vector3(
      out[(shell * 8 + i) * 3],
      out[(shell * 8 + i) * 3 + 1],
      out[(shell * 8 + i) * 3 + 2]
    );

  it('the box shell matches the cuboid CVAT renders', () => {
    const expected = cvatCorners(points);
    for (let i = 0; i < 8; i += 1)
      expect(expected.some((e) => e.distanceTo(corner(2, i)) < 1e-9)).toBe(true);
  });

  it('every one of the 6 faces is offset by ratio x that axis size, outward and inward', () => {
    const center = new Vector3(points[0], points[1], points[2]);
    const euler = new Euler(points[3]!, points[4]!, points[5]!, 'XYZ');
    const axes = [new Vector3(1, 0, 0), new Vector3(0, 1, 0), new Vector3(0, 0, 1)].map((a) =>
      a.applyEuler(euler)
    );
    for (let k = 0; k < 3; k += 1) {
      const size = points[6 + k]!;
      const faceDistance = (shell: number, sign: number) => {
        let best = -Infinity;
        for (let i = 0; i < 8; i += 1) {
          const d = corner(shell, i).sub(center).dot(axes[k]!) * sign;
          if (d > best) best = d;
        }
        return best;
      };
      for (const sign of [1, -1]) {
        expect(faceDistance(0, sign)).toBeCloseTo(size * (0.5 + ratio), 9); // outer
        expect(faceDistance(2, sign)).toBeCloseTo(size * 0.5, 9); // box
        expect(faceDistance(1, sign)).toBeCloseTo(size * (0.5 - ratio), 9); // inner
      }
    }
  });
});
