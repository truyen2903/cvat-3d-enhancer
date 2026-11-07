// CPU-only microbenchmark. Requires Node with TypeScript type stripping (22.18+).
// These timings are not browser FPS or an end-to-end CVAT benchmark.
import { performance } from 'node:perf_hooks';
import { Scene, Group, ArrowHelper, Vector3 } from 'three';
import { deferHiddenOrientationArrowUpdates } from '../src/integration/cvat/runtime/hidden-orientation-arrows.ts';

function make(optimized) {
  const scene = new Scene();
  const hooked = new WeakSet();
  for (let i = 0; i < 362; i++) {
    const box = new Group();
    scene.add(box);
    for (let j = 0; j < 3; j++) {
      const arrow = new ArrowHelper(new Vector3(1, 0, 0));
      arrow.visible = false;
      box.add(arrow);
      if (optimized) deferHiddenOrientationArrowUpdates(arrow, hooked);
    }
  }
  return scene;
}
const native = make(false), optimized = make(true);
for (let i = 0; i < 100; i++) { native.updateMatrixWorld(); optimized.updateMatrixWorld(); }
function run(scene, moving) {
  const start = performance.now();
  for (let i = 0; i < 300; i++) {
    if (moving) scene.children[0].rotation.z = i / 100;
    scene.updateMatrixWorld();
  }
  return performance.now() - start;
}
const median = (values) => values.sort((a, b) => a - b)[3];
for (const visible of [false, true]) {
  for (const scene of [native, optimized]) {
    scene.traverse((node) => { if (node.type === 'ArrowHelper') node.visible = visible; });
    for (let i = 0; i < 100; i++) scene.updateMatrixWorld();
  }
  for (const moving of [false, true]) {
    const before = [], after = [];
    for (let i = 0; i < 7; i++) {
      if (i % 2) { after.push(run(optimized, moving)); before.push(run(native, moving)); }
      else { before.push(run(native, moving)); after.push(run(optimized, moving)); }
    }
    console.log(JSON.stringify({ visible, moving, frames: 300, cuboids: 362, nativeMs: median(before), optimizedMs: median(after) }));
  }
}
