import { describe, expect, it, vi } from 'vitest';
import { prefilterHoverCandidates } from '../../src/integration/cvat/runtime/hover-lock';
import { cacheVisibleCuboids } from '../../src/integration/cvat/runtime/visible-cuboids';
import { Cvat3dPreRenderEnhancer } from '../../src/integration/cvat/runtime/pre-render-enhancer';

function fixture(count = 300) {
  const drawnObjects: Record<
    number,
    {
      data: { clientID: number; points: number[]; hidden?: boolean; outside?: boolean };
      cuboid: {
        perspective: {
          visible: boolean;
          name: string;
          position: { x: number; y: number; z: number };
        };
      };
    }
  > = {};
  for (let id = 0; id < count; id++) {
    drawnObjects[id] = {
      data: { clientID: id, points: [] },
      cuboid: {
        perspective: { visible: id % 3 !== 0, name: String(id), position: { x: id, y: 0, z: 0 } },
      },
    };
  }
  const view = {
    drawnObjects,
    getAllVisibleCuboids(view = 'perspective') {
      return Object.values(this.drawnObjects)
        .map(({ cuboid }) => cuboid[view as 'perspective'])
        .filter((mesh) => mesh.visible);
    },
    notify(_model: unknown, _reason: string) {},
  };
  const native = view.getAllVisibleCuboids.bind(view);
  const enhancer = new Cvat3dPreRenderEnhancer();
  enhancer.ensureHooked({ view });
  return { view, native, enhancer };
}

describe('visible cuboid runtime cache', () => {
  it('returns the same array for 60 steady renders without enumerating drawn objects', () => {
    const { view } = fixture();
    const first = view.getAllVisibleCuboids();
    const values = vi.spyOn(Object, 'values');
    try {
      for (let i = 0; i < 60; i++) expect(view.getAllVisibleCuboids()).toBe(first);
      expect(values).not.toHaveBeenCalled();
    } finally {
      values.mockRestore();
    }
  });

  it('matches the native oracle across visibility, activation, deletion and replacement', () => {
    const { view, native } = fixture();
    let seed = 42;
    const random = () => (seed = (1664525 * seed + 1013904223) >>> 0) / 2 ** 32;
    const reasons = [
      'objects_updated',
      'image_changed',
      'shape_activated',
      'config_updated',
      'group',
      'merge',
      'split',
      'cancel',
      'draw',
    ];
    for (let i = 0; i < 250; i++) {
      view.getAllVisibleCuboids();
      const id = Math.floor(random() * 300);
      const entry = view.drawnObjects[id];
      if (entry) {
        entry.data.hidden = random() > 0.7;
        entry.data.outside = random() > 0.8;
        entry.cuboid.perspective.visible = !entry.data.hidden && !entry.data.outside;
      }
      if (i % 5 === 0) {
        delete view.drawnObjects[id];
        view.notify({}, reasons[i % reasons.length]!);
      }
      if (i % 31 === 0) view.drawnObjects = { ...view.drawnObjects };
      expect(view.getAllVisibleCuboids()).toEqual(native());
    }
  });
});

it('restores methods and live visibility values on teardown', () => {
  const { view, enhancer } = fixture();
  const mesh = view.drawnObjects[1]!.cuboid.perspective;
  view.getAllVisibleCuboids();
  expect(Object.getOwnPropertyDescriptor(mesh, 'visible')?.get).toBeTypeOf('function');
  mesh.visible = false;
  enhancer.disposeHotPaths();
  expect(Object.getOwnPropertyDescriptor(mesh, 'visible')?.value).toBe(false);
  expect(view.getAllVisibleCuboids()).not.toBe(view.getAllVisibleCuboids());
});

it('falls back for nonconfigurable visibility, missing methods and unfamiliar native results', () => {
  expect(cacheVisibleCuboids({ drawnObjects: {} })).toBeNull();
  const { view } = fixture();
  const mesh = view.drawnObjects[1]!.cuboid.perspective;
  Object.defineProperty(mesh, 'visible', { configurable: false });
  expect(view.getAllVisibleCuboids()).toContain(mesh);
  mesh.visible = false;
  expect(view.getAllVisibleCuboids()).not.toContain(mesh);
  const custom = {
    drawnObjects: { 1: { cuboid: { perspective: { visible: true } } } },
    notify() {},
    getAllVisibleCuboids: () => ['version-specific result'],
  };
  cacheVisibleCuboids(custom);
  expect(custom.getAllVisibleCuboids()).toEqual(['version-specific result']);
  expect(custom.getAllVisibleCuboids()).not.toBe(custom.getAllVisibleCuboids());
});

it('invalidates hover membership when an interior cuboid is replaced under the same ID', () => {
  const { view } = fixture();
  const oldList = view.getAllVisibleCuboids();
  const oldMesh = view.drawnObjects[77]!.cuboid.perspective;
  expect(prefilterHoverCandidates(oldList, '77')).toEqual([oldMesh]);
  const replacement = { ...oldMesh };
  view.drawnObjects[77]!.cuboid.perspective = replacement;
  view.notify({}, 'objects_updated');
  const newList = view.getAllVisibleCuboids();
  expect(newList[0]).toBe(oldList[0]);
  expect(newList[newList.length >> 1]).toBe(oldList[oldList.length >> 1]);
  expect(newList.at(-1)).toBe(oldList.at(-1));
  expect(prefilterHoverCandidates(newList, '77')[0]).toBe(replacement);
  expect(Object.getOwnPropertyDescriptor(oldMesh, 'visible')?.get).toBeUndefined();
});
