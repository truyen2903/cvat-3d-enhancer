import { describe, expect, it, vi } from 'vitest';
import {
  ArrowHelper,
  BoxGeometry,
  Group,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  Scene,
  Vector3,
} from 'three';
import {
  Cvat3dPreRenderEnhancer,
  type CvatInternalCanvas3dLike,
} from '../../src/integration/cvat/runtime/pre-render-enhancer';
import {
  deferHiddenCuboidMeshUpdates,
  deferHiddenOrientationArrowUpdates,
} from '../../src/integration/cvat/runtime/hidden-orientation-arrows';

function fixture() {
  const scene = new Scene();
  const parent = new Group();
  const arrow = new ArrowHelper(new Vector3(1, 0, 0), new Vector3(0.5, 0, 0), 1);
  parent.add(arrow);
  scene.add(parent);
  const reference = scene.clone(true);
  const expected = reference.children[0]!.children[0]!;
  deferHiddenOrientationArrowUpdates(arrow, new WeakSet());
  return { scene, parent, arrow, reference, expected };
}

describe('hidden cuboid orientation arrows (Three.js r184)', () => {
  it('does not compose or multiply matrices of hidden arrows during 300 native traversals', () => {
    const { scene, arrow } = fixture();
    const compose = vi.spyOn(arrow.matrix, 'compose');
    const childCompose = vi.spyOn(arrow.cone.matrix, 'compose');
    arrow.visible = false;
    for (let i = 0; i < 300; i++) scene.updateMatrixWorld();
    expect(compose).not.toHaveBeenCalled();
    expect(childCompose).not.toHaveBeenCalled();
    expect(arrow.matrixAutoUpdate).toBe(true);
    expect(arrow.children).toHaveLength(2);
  });

  it('matches native world matrices after movement, resizing and showing arrows again', () => {
    const { scene, parent, arrow, reference, expected } = fixture();
    arrow.visible = false;
    expected.visible = false;
    parent.position.set(3, 4, 5);
    reference.children[0]!.position.copy(parent.position);
    parent.rotation.set(0.3, 0.5, 0.7);
    reference.children[0]!.rotation.copy(parent.rotation);
    parent.scale.set(2, 3, 4);
    reference.children[0]!.scale.copy(parent.scale);
    arrow.setLength(2);
    (expected as ArrowHelper).setLength(2);
    scene.updateMatrixWorld();
    reference.updateMatrixWorld();
    arrow.visible = true;
    expected.visible = true;
    // Exercise recovery without a forced ancestor update.
    arrow.updateMatrixWorld();
    expected.updateMatrixWorld(true);
    expect(arrow.matrixWorld.elements).toEqual(expected.matrixWorld.elements);
    for (let i = 0; i < arrow.children.length; i++) {
      expect(arrow.children[i]!.matrixWorld.elements).toEqual(
        expected.children[i]!.matrixWorld.elements
      );
    }
  });

  it('preserves native coordinate queries on hidden arrows and remains idempotent', () => {
    const { scene, parent, arrow, reference, expected } = fixture();
    const hooked = new WeakSet<object>();
    const other = new ArrowHelper(new Vector3(0, 1, 0));
    deferHiddenOrientationArrowUpdates(other, hooked);
    const wrapper = other.updateMatrixWorld;
    deferHiddenOrientationArrowUpdates(other, hooked);
    expect(other.updateMatrixWorld).toBe(wrapper);
    arrow.visible = false;
    expected.visible = false;
    parent.position.set(9, 8, 7);
    reference.children[0]!.position.copy(parent.position);
    scene.updateMatrixWorld();
    reference.updateMatrixWorld();
    expect(arrow.getWorldPosition(new Vector3())).toEqual(expected.getWorldPosition(new Vector3()));
    expect(arrow.localToWorld(new Vector3(1, 2, 3))).toEqual(
      expected.localToWorld(new Vector3(1, 2, 3))
    );
  });

  it('hooks existing and newly created cuboid arrows through the native view lifecycle', () => {
    const makeEntry = (id: number, arrow: ArrowHelper) => ({
      data: { clientID: id, points: [0, 0, 0, 0, 0, 0, 1, 1, 1] },
      cuboid: { orientationArrows: { perspective: { x: arrow } } },
    });
    const first = new ArrowHelper(new Vector3(1, 0, 0));
    const added = new ArrowHelper(new Vector3(0, 1, 0));
    first.visible = false;
    added.visible = false;
    const canvas: CvatInternalCanvas3dLike = {
      view: {
        views: {
          perspective: {
            scene: {
              background: null,
              children: [
                {
                  type: 'Points',
                  geometry: {
                    attributes: {
                      position: { array: new Float32Array([0, 0, 0]) },
                      color: { array: new Float32Array([1, 1, 1]) },
                    },
                  },
                  material: { size: 0.05, color: { r: 1, g: 1, b: 1, set: vi.fn() } },
                },
              ],
            },
          },
        },
        drawnObjects: { 1: makeEntry(1, first) },
        notify: () => {
          canvas.view!.drawnObjects![2] = makeEntry(2, added);
        },
      },
    };
    const enhancer = new Cvat3dPreRenderEnhancer();
    const firstCompose = vi.spyOn(first.matrix, 'compose');
    const addedCompose = vi.spyOn(added.matrix, 'compose');
    enhancer.ensureHooked(canvas);
    first.updateMatrixWorld(true);
    expect(firstCompose).not.toHaveBeenCalled();
    canvas.view!.notify!({}, 'objects_updated');
    added.updateMatrixWorld(true);
    expect(addedCompose).not.toHaveBeenCalled();
    added.visible = true;
    added.updateMatrixWorld();
    expect(addedCompose).toHaveBeenCalledTimes(1);
  });

  it('leaves custom update hooks and unrelated scene objects unchanged', () => {
    const group = new Group();
    const original = group.updateMatrixWorld;
    deferHiddenOrientationArrowUpdates(group, new WeakSet());
    expect(group.updateMatrixWorld).toBe(original);
    const arrow = new ArrowHelper(new Vector3(0, 0, 1));
    const custom = vi.fn();
    arrow.updateMatrixWorld = custom;
    arrow.visible = false;
    deferHiddenOrientationArrowUpdates(arrow, new WeakSet());
    arrow.updateMatrixWorld();
    expect(custom).toHaveBeenCalledTimes(1);
  });

  it('shares a single wrapper function across all hooked ArrowHelpers without per-instance closure interference', () => {
    const hooked = new WeakSet<object>();
    const arrows = Array.from(
      { length: 32 },
      (_, idx) => new ArrowHelper(new Vector3(1, idx % 2, 0), new Vector3(idx, 0, 0), 1)
    );
    for (const a of arrows) {
      deferHiddenOrientationArrowUpdates(a, hooked);
    }
    const sharedFn = arrows[0]!.updateMatrixWorld;
    for (let i = 1; i < arrows.length; i += 1) {
      expect(arrows[i]!.updateMatrixWorld).toBe(sharedFn);
    }

    // Independent per-instance skipped flags when only arrow[0] is hidden
    const compose0 = vi.spyOn(arrows[0]!.matrix, 'compose');
    const compose1 = vi.spyOn(arrows[1]!.matrix, 'compose');
    arrows[0]!.visible = false;
    arrows[1]!.visible = true;

    arrows[0]!.updateMatrixWorld();
    arrows[1]!.updateMatrixWorld();
    expect(compose0).not.toHaveBeenCalled();
    expect(compose1).toHaveBeenCalledTimes(1);

    arrows[0]!.visible = true;
    arrows[0]!.updateMatrixWorld();
    expect(compose0).toHaveBeenCalledTimes(1);
  });

  it('defers and accurately restores world matrices for hidden cuboid meshes and their entire subtrees', () => {
    const scene = new Scene();
    const parent = new Group();
    const cuboidMesh = new Mesh(
      new BoxGeometry(4, 2, 1.5),
      new MeshBasicMaterial({ transparent: true, opacity: 0.35 })
    );
    const wireframe = new LineSegments(new BoxGeometry(4, 2, 1.5), new LineBasicMaterial());
    const cornerDot = new Mesh(new BoxGeometry(0.1, 0.1, 0.1), new MeshBasicMaterial());
    cuboidMesh.add(wireframe);
    cuboidMesh.add(cornerDot);
    parent.add(cuboidMesh);
    scene.add(parent);

    const reference = scene.clone(true);
    const expectedParent = reference.children[0] as Group;
    const expectedMesh = expectedParent.children[0] as Mesh;

    const hooked = new WeakSet<object>();
    const secondMesh = new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial());
    deferHiddenCuboidMeshUpdates(cuboidMesh, hooked);
    deferHiddenCuboidMeshUpdates(secondMesh, hooked);
    expect(cuboidMesh.updateMatrixWorld).toBe(secondMesh.updateMatrixWorld);

    const meshCompose = vi.spyOn(cuboidMesh.matrix, 'compose');
    const wireCompose = vi.spyOn(wireframe.matrix, 'compose');
    const dotCompose = vi.spyOn(cornerDot.matrix, 'compose');

    cuboidMesh.visible = false;
    expectedMesh.visible = false;
    for (let i = 0; i < 100; i += 1) {
      scene.updateMatrixWorld();
    }
    expect(meshCompose).not.toHaveBeenCalled();
    expect(wireCompose).not.toHaveBeenCalled();
    expect(dotCompose).not.toHaveBeenCalled();

    parent.position.set(12, -7, 3);
    parent.rotation.set(0.1, -0.2, 0.9);
    cuboidMesh.position.set(-4, 5, 1.2);
    cuboidMesh.rotation.set(0.05, 0.15, -0.45);
    cuboidMesh.scale.set(4.5, 2.1, 1.7);

    expectedParent.position.copy(parent.position);
    expectedParent.rotation.copy(parent.rotation);
    expectedMesh.position.copy(cuboidMesh.position);
    expectedMesh.rotation.copy(cuboidMesh.rotation);
    expectedMesh.scale.copy(cuboidMesh.scale);

    scene.updateMatrixWorld();
    reference.updateMatrixWorld();

    cuboidMesh.visible = true;
    expectedMesh.visible = true;
    cuboidMesh.updateMatrixWorld();
    expectedMesh.updateMatrixWorld(true);

    expect(cuboidMesh.matrixWorld.elements).toEqual(expectedMesh.matrixWorld.elements);
    for (let i = 0; i < cuboidMesh.children.length; i += 1) {
      expect(cuboidMesh.children[i]!.matrixWorld.elements).toEqual(
        expectedMesh.children[i]!.matrixWorld.elements
      );
    }
  });
});
