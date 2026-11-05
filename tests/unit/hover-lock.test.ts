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
