import { describe, expect, it } from 'vitest';
import {
  filterHoverIntersections,
  installPointerButtonEventTracking,
  lockRaycasterHoverToActiveObject,
} from '../../src/integration/cvat/runtime/hover-lock';

const hit = (name: string) => ({ object: { name } });

describe('Active object hover lock', () => {
  it('drops hover hits on other cuboids while an object is active', () => {
    const hits = [hit('7'), hit('3'), hit('')];
    expect(filterHoverIntersections(hits, '3')).toEqual([hit('3'), hit('')]);
    expect(filterHoverIntersections(hits, null)).toBe(hits);
  });

  it('wraps raycaster for hover but never filters raycasts inside click events', () => {
    installPointerButtonEventTracking(window);
    let active: string | null = '1';
    const rayCaster = {
      intersectObjects: (): unknown[] => [hit('2'), hit('1')],
    };
    expect(lockRaycasterHoverToActiveObject(rayCaster, () => active)).toBe(true);
    // idempotent
    expect(lockRaycasterHoverToActiveObject(rayCaster, () => active)).toBe(true);

    // Hover (render loop): other ID 2 is ignored
    expect(rayCaster.intersectObjects()).toEqual([hit('1')]);

    // No active object: hover behaves natively
    active = null;
    expect(rayCaster.intersectObjects()).toEqual([hit('2'), hit('1')]);

    // Click on another object while one is active must still be able to switch selection
    active = '1';
    let clickHits: unknown[] = [];
    const target = document.createElement('canvas');
    document.body.appendChild(target);
    target.addEventListener('click', () => {
      clickHits = rayCaster.intersectObjects();
    });
    target.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(clickHits).toEqual([hit('2'), hit('1')]);
    expect(rayCaster.intersectObjects()).toEqual([hit('1')]);
  });
});

describe('hover raycast prefilter', () => {
  it('only intersects the active cuboid and unnamed helpers during hover', async () => {
    const { prefilterHoverCandidates } =
      await import('../../src/integration/cvat/runtime/hover-lock');
    const objects = [{ name: '1' }, { name: '2' }, { name: 'plane' }, { name: '3' }, {}];
    expect(prefilterHoverCandidates(objects, '2')).toEqual([{ name: '2' }, { name: 'plane' }, {}]);
    expect(prefilterHoverCandidates(objects, null)).toBe(objects);
  });

  it('passes the reduced candidate list to the native raycast, but not for recursive casts', () => {
    const seen: unknown[][] = [];
    const rayCaster = {
      intersectObjects: (objects: unknown[], _recursive?: boolean): unknown[] => {
        seen.push(objects);
        return objects.map((object) => ({ object }));
      },
    };
    lockRaycasterHoverToActiveObject(rayCaster, () => '5');
    const cuboids = Array.from({ length: 1000 }, (_, i) => ({ name: String(i) }));
    expect(rayCaster.intersectObjects(cuboids, false)).toEqual([{ object: { name: '5' } }]);
    expect(seen[0]).toHaveLength(1);
    rayCaster.intersectObjects(cuboids, true);
    expect(seen[1]).toHaveLength(1000);
  });
});
