import { BoxGeometry, Mesh, MeshBasicMaterial, Raycaster, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import {
  filterHoverIntersections,
  invalidateHoverSpatialIndex,
  installPointerButtonEventTracking,
  lockRaycasterHoverToActiveObject,
  unlockRaycasterHover,
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

  it('runs 60 hover ticks across 100,000 meshes in < 20ms for both active and null-active modes', () => {
    const geometry = new BoxGeometry(1, 1, 1);
    geometry.computeBoundingSphere();
    const material = new MeshBasicMaterial();
    const total = 100_000;
    const meshes = new Array<Mesh>(total);

    for (let i = 0; i < total; i += 1) {
      const mesh = new Mesh(geometry, material);
      mesh.name = String(i);
      const col = i % 500;
      const row = Math.floor(i / 500);
      mesh.position.set((col - 250) * 6, (row - 100) * 6, 0);
      mesh.scale.set(4, 2, 1.6);
      mesh.updateMatrixWorld();
      meshes[i] = mesh;
    }

    // Place mesh #50000 directly under (24, 12, 0)
    const targetMesh = meshes[50_000]!;
    targetMesh.position.set(24, 12, 0);
    targetMesh.updateMatrixWorld();

    let activeId: string | null = '99999';
    const rayCaster = new Raycaster(new Vector3(24, 12, 50), new Vector3(0, 0, -1));
    let originalCalls = 0;
    let lastCandidateCount = 0;
    const nativeIntersect = rayCaster.intersectObjects.bind(rayCaster);
    rayCaster.intersectObjects = ((
      objects: Mesh[],
      recursive?: boolean,
      ...rest: [Array<ReturnType<Raycaster['intersectObjects']>[number]>?]
    ) => {
      originalCalls += 1;
      lastCandidateCount = objects.length;
      return nativeIntersect(objects, recursive, ...rest);
    }) as Raycaster['intersectObjects'];

    lockRaycasterHoverToActiveObject(
      rayCaster,
      () => activeId,
      () => true,
      { resolveActiveObject: (id) => meshes[Number(id)] }
    );

    // Warmup initial index build once
    rayCaster.intersectObjects(meshes, false);
    activeId = null;
    rayCaster.intersectObjects(meshes, false);

    // 1) Active mode: 60 ticks on 100,000 meshes (including fresh `.slice()` arrays) < 20ms
    activeId = '50000';
    const slicedCopy = meshes.slice();
    const tActive0 = performance.now();
    let activeHits: unknown[] = [];
    for (let tick = 0; tick < 60; tick += 1) {
      activeHits = rayCaster.intersectObjects(tick % 2 === 0 ? meshes : slicedCopy, false);
    }
    const activeElapsedMs = performance.now() - tActive0;
    expect(activeElapsedMs).toBeLessThan(20);
    expect(lastCandidateCount).toBe(1);
    expect((activeHits[0] as { object?: { name?: string } } | undefined)?.object?.name).toBe(
      '50000'
    );

    // 2) Idle mode (`activeId === null`) with stationary ray: 60 ticks < 20ms and calls `original` once
    activeId = null;
    rayCaster.set(new Vector3(24, 12, 40), new Vector3(0, 0, -1));
    originalCalls = 0;
    const tIdle0 = performance.now();
    let idleHits: unknown[] = [];
    for (let tick = 0; tick < 60; tick += 1) {
      idleHits = rayCaster.intersectObjects(meshes, false);
    }
    const idleElapsedMs = performance.now() - tIdle0;
    expect(idleElapsedMs).toBeLessThan(20);
    expect(originalCalls).toBe(1);
    expect(lastCandidateCount).toBeLessThan(16);
    expect((idleHits[0] as { object?: { name?: string } } | undefined)?.object?.name).toBe('50000');

    // Hiding the currently hovered mesh invalidates the idle cache on the very next tick
    targetMesh.visible = false;
    const afterHideHits = rayCaster.intersectObjects(meshes, false);
    expect(originalCalls).toBe(2);
    expect(
      afterHideHits.some(
        (h) => (h as { object?: { name?: string } } | undefined)?.object?.name === '50000'
      )
    ).toBe(false);
    targetMesh.visible = true;

    // 3) Moving ray with `activeId === null`: SoA broad-phase shortlists candidates across 100k meshes
    for (let step = 0; step < 10; step += 1) {
      rayCaster.set(new Vector3((step - 5) * 6, 0, 40), new Vector3(0, 0, -1));
      rayCaster.intersectObjects(meshes, false);
      expect(lastCandidateCount).toBeLessThan(16);
    }

    geometry.dispose();
    material.dispose();
  });
});

describe('button-event broad phase', () => {
  it('shortlists clicks while preserving native hit order, helpers, ties and hidden meshes', () => {
    installPointerButtonEventTracking(window);
    const geometry = new BoxGeometry(2, 2, 2);
    const material = new MeshBasicMaterial();
    const objects: Mesh[] = [];
    let seed = 91;
    const random = () => (seed = (1664525 * seed + 1013904223) >>> 0) / 2 ** 32;
    for (let id = 0; id < 1000; id++) {
      const mesh = new Mesh(geometry, material);
      mesh.name = String(id);
      mesh.position.set((random() - 0.5) * 500, (random() - 0.5) * 500, random() * 10);
      mesh.rotation.set(random(), random(), random());
      mesh.scale.set(0.1 + random() * 10, 1 + random(), 1 + random());
      mesh.updateMatrixWorld();
      objects.push(mesh);
    }
    const native = new Raycaster();
    const patched = new Raycaster();
    const nativeIntersect = patched.intersectObjects.bind(patched);
    let candidateCount = 0;
    patched.intersectObjects = (candidates, recursive, target) => {
      candidateCount = candidates.length;
      return nativeIntersect(candidates, recursive, target);
    };
    let versioned = false;
    let activeId = '999';
    lockRaycasterHoverToActiveObject(patched, () => activeId, undefined, {
      useCachedClickBounds: () => versioned,
    });
    const canvas = document.createElement('canvas');
    document.body.appendChild(canvas);
    let actual: unknown[] = [];
    canvas.addEventListener('click', () => {
      actual = patched.intersectObjects(objects, false);
    });
    try {
      // Equal-distance native ties retain input order; unnamed helpers are always included.
      const helper = objects[0]!.clone();
      helper.name = 'helper';
      const tie = objects[0]!.clone();
      tie.name = '1001';
      objects.splice(1, 0, helper, tie);
      for (let step = 0; step < 60; step++) {
        versioned = step >= 30;
        if (versioned) invalidateHoverSpatialIndex();
        const target = objects[step % 3 === 0 ? 0 : step * 7]!;
        target.visible = step % 2 === 0;
        target.position.x += 1; // No prior hover or epoch update: a real click must use fresh bounds.
        target.updateMatrixWorld();
        const origin = target.position.clone().add(new Vector3(0, 0, 50));
        const direction = new Vector3(0, 0, -1);
        native.set(origin, direction);
        patched.set(origin, direction);
        const expected = native.intersectObjects(objects, false);
        canvas.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        expect(actual).toEqual(expected);
        expect(candidateCount).toBeLessThan(objects.length / 10);
        // A second click reuses versioned bounds, including native hidden-mesh semantics.
        canvas.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        expect(actual).toEqual(expected);
        if (versioned) {
          activeId = target.name;
          target.position.x += 2; // In-progress active preview before model notify.
          target.updateMatrixWorld();
          const previewExpected = native.intersectObjects(objects, false);
          canvas.dispatchEvent(new MouseEvent('click', { bubbles: true }));
          expect(actual).toEqual(previewExpected);
        }
      }
    } finally {
      canvas.remove();
      geometry.dispose();
      material.dispose();
    }
  });
});

it('restores the native raycaster method on teardown', () => {
  const raycaster = { intersectObjects: () => [hit('2'), hit('1')] };
  const native = raycaster.intersectObjects;
  lockRaycasterHoverToActiveObject(raycaster, () => '1');
  unlockRaycasterHover(raycaster);
  expect(raycaster.intersectObjects).toBe(native);
  expect(raycaster.intersectObjects()).toEqual([hit('2'), hit('1')]);
});
