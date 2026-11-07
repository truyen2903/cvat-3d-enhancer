# Meow / CVAT canvas performance plan

Status: proposal only. No additional runtime changes are authorized by this plan.

## Starting point

The user reports that disabling Meow makes CVAT slightly smoother. This suggests both native rendering and extension work need investigation; it does not identify a CPU or GPU bottleneck.

The tested Meow branding snapshot is commit `5492f39`. The current uncommitted performance experiment changes QA scheduling, mutation handling, scene background synchronization and option-triggered redraws. Treat that experiment as a separate benchmark candidate, not a proven improvement.

Repository evidence:

- `pre-render-enhancer.ts` hooks view/scene/Points rendering, changes point materials and can process full geometry buffers for cuboid colors and ground hiding.
- `page-bridge.ts` observes UI mutations and schedules QA over point-cloud data.
- `hover-lock.ts` wraps native raycasts after native intersection computation.
- An existing optimization simplifies invisible orthographic raycast planes. Measure its contribution before adding further raycast changes.
- The installed page reports Three.js r184. Native CVAT render-loop ownership, camera-controls integration and renderer settings must be inspected on the running version before changing them.

## 1. Establish a repeatable baseline

Use the same job, frame, active object, viewport size, browser zoom and camera path. Record browser/GPU, device pixel ratio, point count, cuboid count and visible views. Warm up each configuration, then repeat each scenario three times.

Configurations:

1. Native CVAT, Meow disabled, page reloaded.
2. Meow commit `5492f39`.
3. Current uncommitted optimization experiment.
4. Meow with optional QA, point colors and ground hiding individually disabled to isolate their costs.

Scenarios: idle, orbit/pan/zoom, select an object, drag/resize/rotate a cuboid, change frames, maximize/restore a native view, and drag Appearance sliders.

Measure presented-frame behavior with browser tracing, main-thread frame time (median/p95), long tasks, native render/raycast call counts, extension callback time, draw calls and GPU resource counts. Where supported, GPU timing can distinguish GPU saturation from main-thread stalls. rAF frequency alone is not an FPS measurement. Sample diagnostics outside hot loops and avoid synchronous GPU readback or per-frame console logs.

Exit: retain traces showing the dominant cost for each slow scenario and choose CPU or GPU work accordingly. Do not claim an improvement from unit tests alone.

## 2. Remove unnecessary work without changing visual quality

First retain only measured improvements from the existing experiment. Check background caching, observer self-triggering, duplicated renders and QA work during interaction. Keep immediate editing previews; defer optional QA until interaction settles and reject results from obsolete frames.

Inspect native raycast inputs and frequency. Cache hover results only while pointer, camera, objects and selection are unchanged. Preserve click accuracy and native corner/edge handles. Apply broad-phase candidate filtering only after confirming the actual object hierarchy and intersection semantics.

Avoid re-uploading position/color buffers, rebuilding materials or traversing entire scenes when only the camera changes. Separate invalidation for frame data, annotation geometry, appearance, selection and camera movement.

Exit: compare each change independently with phase 1; revert changes with no measurable benefit or editing regressions.

## 3. Reduce GPU work during camera movement

If traces show GPU pressure, try temporary lower render resolution before introducing point-cloud LOD. Change drawing-buffer resolution through verified native renderer sizing APIs, preserving CSS size, camera aspect and pointer coordinates. Save and restore each renderer's original pixel ratio. Coalesce adjustments and use hysteresis so buffers are not repeatedly resized as controls damp.

Restore full quality after movement settles, on capture/export and before precision editing. Start with Perspective only. Do not reduce point size, disable antialiasing by recreating the renderer, or change Appearance values as a performance shortcut.

If resolution reduction is insufficient, prototype view-only point LOD during orbit/pan/zoom. Use deterministic spatial sampling; a prefix drawRange can systematically omit parts of a scan. Reuse existing attributes where possible, bound the additional index/cache memory and rebuild only when frame data or ground compaction changes. Keep full-resolution data for picking, QA, annotation edits and export. Disable reduced detail during cuboid editing and restore the exact native render state afterward.

Exit: keep the least intrusive option that materially improves p95 frame time; expose temporary quality reduction as an explicit user setting.

## 4. Reduce native rendering at rest

Inspect native animation and camera-controls damping before attempting demand rendering. Keep the existing loop owner; do not start a competing requestAnimationFrame loop.

Only skip expensive drawing after proving that camera, controls, pointer hover, objects, selection, viewport, frame loading and overlays are all settled. Re-render on every relevant invalidation. Views hidden by a native maximized view may skip drawing, but must catch up immediately when restored. Never stop native model/event updates.

This phase is conditional: if native internals cannot be hooked reliably, retain native scheduling and document the limitation.

## 5. Move optional point analysis off the main thread if necessary

Only if QA/color/ground processing remains a measured source of stalls, prototype a bounded worker queue. Allow one running job and at most one replacement job; discard obsolete frame/options results. Never transfer/detach buffers owned by CVAT. Include copying, worker startup, additional memory and GPU upload time in the benchmark. Reuse worker lifetime and explicitly release worker-owned caches when frames are evicted.

Do not add asynchronous geometry swaps without checking interaction and frame identity at commit time.

## Acceptance and rollback

- Target, not a promise: at least 20% lower p95 frame time in the measured slow scenario. Where hardware permits, aim for 16.7 ms at 60 Hz; report actual refresh rate and achieved timings.
- Meow overhead with optional analysis disabled should be within approximately 5% of native under repeatable conditions. If measurement noise exceeds that margin, report uncertainty.
- No loss of points in saved/exported data, selection accuracy, cuboid manipulation, shortcuts or Appearance behavior.
- Test repeated frame changes and view open/close cycles: no sustained growth in live workers, callbacks, material/geometry counts or heap after warm-up and collection. Browser memory may retain reusable GPU allocations; distinguish a plateau from progressive growth.
- Each experiment has a separate toggle/commit and restores the exact prior state when disabled. Preserve `5492f39` as the known rollback reference.

Recommended implementation order: baseline → measured work elimination → adaptive resolution → optional point LOD → conditional demand rendering/worker work. Do not bundle these into one unmeasurable patch.
