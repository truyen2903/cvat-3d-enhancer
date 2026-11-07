import { describe, expect, it, vi } from 'vitest';
import { collectQaPointNeighborhood } from '../../src/integration/cvat/runtime/qa-point-neighborhood';
import { evaluateSpatialAndPointCloudWarnings } from '../../src/integration/cvat/runtime/active-object-qa-overlay';

const box = [2, 3, 1, 0.2, 0.1, 0.7, 4, 2, 2];
describe('cooperative QA point scanning', () => {
  it('preserves the full-scan QA result for a rotated cuboid while yielding', async () => {
    const positions: number[] = [];
    for (let x = -10; x <= 10; x++)
      for (let y = -10; y <= 10; y++) {
        positions.push(x / 2, y / 2, 0, x / 2, y / 2, 1);
      }
    const yieldTask = vi.fn(async () => {});
    const nearby = await collectQaPointNeighborhood(positions, box, () => true, yieldTask, 32);
    expect(yieldTask).toHaveBeenCalled();
    expect(nearby!.length).toBeLessThan(positions.length);
    const params = { clientID: 1, currentPoints: box, outside: false };
    expect(evaluateSpatialAndPointCloudWarnings({ ...params, positionArray: nearby })).toEqual(
      evaluateSpatialAndPointCloudWarnings({ ...params, positionArray: positions })
    );
  });

  it('preserves zero nearby points versus missing point-cloud semantics', async () => {
    const positions = new Float32Array([100, 100, 100, 200, 200, 200]);
    const nearby = await collectQaPointNeighborhood(positions, box, () => true);
    const params = { clientID: 1, currentPoints: box, outside: false };
    expect(evaluateSpatialAndPointCloudWarnings({ ...params, positionArray: nearby })).toEqual(
      evaluateSpatialAndPointCloudWarnings({ ...params, positionArray: positions })
    );
  });

  it('abandons obsolete selection/frame work at the next yield without mutating native buffers', async () => {
    const positions = new Float32Array(90);
    const before = positions.slice();
    let current = true;
    const yieldTask = vi.fn(async () => {
      current = false;
    });
    expect(
      await collectQaPointNeighborhood(positions, box, () => current, yieldTask, 2)
    ).toBeNull();
    expect(yieldTask).toHaveBeenCalledTimes(1);
    expect(positions).toEqual(before);
  });
});
