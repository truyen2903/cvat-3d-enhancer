# Initial canvas profiling findings

Date: 2026-11-07. Preliminary observation, not an A/B benchmark or a completed performance fix.

## Captured session

Chrome DevTools Performance recorded the existing live CVAT tab for 14.63 seconds. No deliberate camera or annotation manipulation was performed by the agent during this capture. The page had 362 objects in its sidebar; DevTools was docked, so this viewport differs from the user's normal editing viewport. Other user activity and instrumentation overhead were not controlled.

Summary displayed by DevTools:

| Category | Time |
| --- | ---: |
| Scripting | 12,044 ms |
| Painting | 1,374 ms |
| System | 1,108 ms |

Bottom-up displayed:

| Function | Self | Total |
| --- | ---: | ---: |
| multiplyMatrices | 5,528.1 ms | 5,528.3 ms |
| updateMatrixWorld | 3,259.7 ms | 10,476.6 ms |
| compose | 1,589.0 ms | 1,589.0 ms |
| Commit | 1,374.4 ms | 1,374.4 ms |
| Profiling overhead | 586.5 ms | 887.2 ms |

Nested total times overlap and must not be added together. The CPU trace points toward repeated scene-transform work; it does not establish GPU headroom, actual FPS or exclusive ownership of all work by native CVAT. Extension hooks executing in the page world may be attributed to the page or their caller. The 43.3 ms attributed explicitly to Meow in the summary is not a measurement of all extension overhead.

The live static application bundle (`cvat-ui.e9196e7c006da21037f3.min.js`) was inspected locally. Its native render method loops views, updates controls/projection, calls renderer.render, then runs perspective raycasts and orthographic editing actions. The library's updateMatrixWorld calls updateMatrix whenever matrixAutoUpdate is enabled and propagates forced updates through descendants.

## Rejected experiment

A temporary per-object transform cache was tested against Three.js 0.184.0. Correctness checks covered translation, rotation, scaling, forced updates, manually controlled matrices, reparenting and camera inverse updates.

A CPU-only synthetic test used a scene with 2,535 objects, 300 traversals per sample, seven samples and warmed-up scenes. Median traversal times:

| Scenario | Native | Cache experiment |
| --- | ---: | ---: |
| Static transforms | 35.43 ms | 42.52 ms |
| One moving group | 32.66 ms | 44.08 ms |

These totals cover 300 traversals, not one presented frame. Node CPU timings do not predict browser FPS. The experiment showed no benefit and was removed, including its temporary test dependencies. It is not in the current build.

## Next measurement

Export the captured trace and inspect caller stacks for updateMatrixWorld: determine whether repeated work originates in renderer traversal, helpers, forced subtree updates or another caller. Repeat with Meow disabled and with camera motion under the same viewport. Establish object/scene counts and actual call frequency before modifying native scene scheduling.

Prioritize reducing redundant traversal/calls if confirmed. Adaptive pixel ratio or point LOD should follow only if GPU pressure is measured; they do not directly address this observed CPU cost.

## Access limitation

The trace was read in DevTools UI but has not been exported to a local file. Subsequent accessibility reads failed with permission_denied even though the permission status command reports granted. The Chrome debugging endpoint at localhost:9222 was unavailable. No caller-stack analysis or before/after live validation has been completed.

## Trace export recovered

The trace has now been exported locally to `~/Downloads/meow-cvat-baseline.json.gz` (22,031,366 bytes, 213,921 events). A native Save sheet was not exposed correctly by the Orca accessibility tree; saving succeeded through the sheet's native accessibility controls instead. Raw trace data remains outside the repository.

CPU profile parent links confirm the dominant sampled path:

`CVAT rAF callback B → Canvas.render → Meow view wrappers → native view.render → per-view renderer.render → recursive updateMatrixWorld → multiplyMatrices / compose`.

The matrix hot path is the native renderer's scene traversal, not an additional loop inside the extension wrappers. This still does not quantify the incremental cost of those wrappers; the native-only A/B run remains outstanding.

A next prototype may check the scene once and skip the native matrix traversal only when the complete supported scene state is unchanged. It must preserve forced updates and fall back for custom update hooks, manual matrices, topology changes and attached cameras. Benchmark it before including it in the extension.

## Narrow optimization retained for browser testing

The whole-scene scan prototype improved static synthetic traversal only slightly (35.54 → 32.23 ms per 300 traversals), and regressed when one group moved (32.02 → 85.05 ms). It was not integrated.

Inspection of the live bundle's Cuboid constructor identified three decorative orientation ArrowHelpers per cuboid per view. Native scene traversal updates their child matrices even when the orientation checkbox hides the arrows. The retained implementation defers only these known arrows' updateMatrixWorld traversal when their own visible flag is false. It leaves coordinate-query APIs and custom update implementations alone and forces a complete update when an arrow becomes visible again. No point-cloud data, renderer, material or shader is recreated.

Reproducible CPU microbenchmark: `node scripts/benchmark-hidden-arrows.mjs` (Node 22.18+; test dependencies Three.js and its types are pinned to 0.184.0 and are not imported into the production extension).

One run, median of seven samples, 362 groups with three arrows each, 300 matrix traversals per sample:

| Arrows | Parent motion | Native | Optimized |
| --- | --- | ---: | ---: |
| Hidden | Static | 73.08 ms | 10.38 ms |
| Hidden | One moving parent | 74.60 ms | 10.56 ms |
| Visible | Static | 85.70 ms | 87.38 ms |
| Visible | One moving parent | 82.35 ms | 86.88 ms |

This reduces hidden-arrow traversal work substantially, with a small wrapper cost when arrows are visible. These timings exclude all GPU drawing, picking and UI work; they are not an FPS promise. Live before/after capture after loading the new extension build remains necessary. Tests cover native world-matrix recovery after parent translation/rotation/scale, resized arrows, hidden coordinate queries, idempotence, custom hook fallback and newly created cuboids.
