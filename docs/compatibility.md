# Compatibility & Known Limitations — CVAT 3D Enhancer

## 1. Target Environment

- **Browsers**: Google Chrome `>= 114`, Brave Browser `>= 114` (Manifest V3 with `chrome.storage.session` support).
- **Target CVAT Release Inspected**: **CVAT `v2.81.0`** (`cvat-canvas3d` `0.0.10`, `three` `0.184.0`).
- **Compatible CVAT Range**: CVAT `v2.10.0` through `v2.81.0+` (verified via `VersionDetector` against `GET /api/server/about`).

## 2. Verified Supported Capabilities

1. **Cuboid Appearance (`cuboidAppearance`)**:
   - Cuboid fill opacity (`0% - 100%`)
   - Selected cuboid fill opacity (`0% - 100%`)
   - Outlined cuboid borders toggle and hex color (`#RRGGBB`)
   - Orientation arrow visibility (`always`, `selected`, `never`)
   - Orthographic control points size (`1 - 20`) and focused object padding (`0 - 200`)
2. **Cuboid Color-By Mode (`labelColors`)**:
   - Switching between `Label`, `Instance`, and `Group` coloring schemes via CVAT Redux and `Canvas3d.configure()`.
3. **Camera Navigation Step Presets (`cameraPresets`)**:
   - Zoom In/Out, Move Up/Down/Left/Right, Pitch Tilt Up/Down, and Yaw Rotate Left/Right via `Canvas3d.keyControls()` and `Canvas3d.fit()`.
4. **Point Cloud Viewport Appearance (`pointCloudAppearance`)**:
   - Custom 3D viewport background color and non-destructive WebGL `<canvas>` brightness (`50% - 180%`) and contrast (`50% - 180%`) filters.

## 3. Verified Unsupported Capabilities in CVAT `v2.81.0`

Inspection of `cvat-canvas3d/src/typescript/canvas3dView.ts` in CVAT `v2.81.0` confirmed that `Canvas3dViewImpl` encapsulates the Three.js `Scene` and `PointsMaterial` as private fields without public getters/setters:

1. **Direct Three.js Point Size (`pointSize` — Unsupported)**:
   - Hardcoded at `points.material.size = 0.05` (perspective) and `material.size = 0.5` (orthographic) inside `Canvas3dViewImpl.addScene()`.
2. **Point Cloud Height / Intensity Shader Color Mode (`colorMode` — Unsupported)**:
   - Hardcoded at `points.material.color.set(new THREE.Color(0xffffff))` upon `PCDLoader` completion.
3. **3D Ground Grid Helper (`gridVisibility` — Unsupported)**:
   - `cvat-canvas3d` does not instantiate a `THREE.GridHelper` in the 3D scene (`settings.workspace.grid` only applies to 2D annotation).
4. **3D Coordinate Axes Toggle (`coordinateAxes` — Unsupported)**:
   - `new THREE.AxesHelper(5)` is added anonymously to private `this.views.perspective.scene` during `addScene()` with no toggle method.

The extension UI and `CapabilityRegistry` explicitly report these four capabilities as `unsupported` so users are never misled by non-functional controls.

## 4. Customized CVAT sidebar builds

Dimension sync (H/W/L) and heading flip controls use object cards identified by
`.cvat-objects-sidebar-state-item` or `cvat-objects-sidebar-state-item-<clientID>`.
They no longer require `.ant-col-20`, keyframe navigation icons, or a particular Ant Design
CSS hash. The controls provide their own layout and SVG sizing, are keyboard accessible,
and reconcile after sidebar rerenders, cloned rows, or removed icons. Native lock classes
and the lock icon's `aria-label` are checked both during reconciliation and at click time.
Explicit object type labels must identify a cuboid track; other object types are skipped.

Offline regression fixtures cover the supplied Ant Design sidebar structure and modified
layouts. Subsequent authorized live checks were limited to sidebar DOM, React annotation
API signatures and event blocking; no point-cloud data was inspected or live annotations
modified. These DOM fixes do not establish compatibility with arbitrary changes to CVAT's internal annotation APIs:
dimension synchronization still requires the supported runtime ObjectState/track methods.
If a custom build removes both the semantic card selectors and client IDs, its adapter
must be updated using a sanitized HTML sample. Failed sync operations are reported in the
button tooltip rather than producing an unhandled promise rejection.

## 5. Side / Front cuboid base guide

A solid red 1 px horizontal guide extends the selected cuboid's lowest projected slice
across Side and Front viewports, including their normal unexpanded panels. It projects
the actual view mesh using its world transform and the renderer camera matrices, so
view-specific transforms and live edits do not leave a gap between the box and guide.
The overlay uses a viewport root outside transformed or padded panels, with no margin,
padding, or stroke halo. An annotation-coordinate fallback remains for runtimes that do
not expose the view mesh.

The SVG overlay ignores pointer input and updates during rendering, scrolling, and window
resizing. It is hidden without an active visible cuboid, on Top views, and when no valid
camera projection is available. It does not alter annotation geometry or the WebGL point
cloud. Runtime integration requires the existing Three.js scene render hook and a readable
active cuboid.

## 6. Sidebar quick filter and annotation API fallback

Double clicks on object-card backgrounds invoke CVAT's native sidebar `focus` action
while bypassing the combined Quick-filter handler and its second mouse-down/click.
Single clicks, object buttons, label selectors, editable inputs, and the explicit Quick
filter Clear button retain their native behavior. If the native focus action cannot be
resolved, the original double-click handler is preserved. The guard is removed on teardown.

When Redux/renderer integration cannot provide ObjectState, dimension sync and heading
flip resolve that specific object from bounded sidebar React fiber ancestry. After saving,
the native sidebar refresh callback updates annotations. This adapter does not inspect
canvas geometry or point-cloud buffers. Regression tests cover all four actions using
synthetic annotations; live checks verify visible controls and blocked double-click events.

Custom domains still require browser host permission and activation through the Meow popup
(**Add & Activate Link**). Merely rebuilding the bundle does not activate an unapproved
origin or update an already-open page. A standalone sidebar patch applied during diagnosis
lasts only until that page reloads.

## 7. Orthographic keyboard response

W/A/S/D moves the cuboid by 2.5 screen pixels per press (0.025 m fallback without camera
access); Q/E rotates by 0.4 degrees. Shift multiplies either step by four. Mesh preview and
redraw run synchronously on keydown without rescanning point-cloud colors. Keyup commits
the pending edit immediately; the idle debounce remains as a fallback for missing keyup.

## 8. Native point cloud display

Meow no longer changes point cloud rendering. Point colors, point sizes (main 3D, Top, Side,
Front and their zoomed views), size attenuation and viewport backgrounds stay exactly as CVAT
draws them. The removed options (white background, solid black/white points, coloring points
by cuboid, Top-only ground hiding, fixed 3.5 px orthographic points and 20% larger main
points) are dropped from saved settings the next time they are read.

## 9. Workspace controls for recent enhancements

Settings → Workspace includes independent checkboxes for: frame follow for the active
object, mouse side-button navigation, cuboid base guide, native focus without automatic
Quick filter, H/W/L sync buttons, heading flip button, W/A/S/D/Q/E editing, double keyboard
sensitivity, and immediate key-release commit. Existing installations default to enabled
to preserve their current behavior. Turning off a control applies immediately. Disabling the
keyboard restores native CVAT shortcuts; disabling the filter override restores native
double-click behavior.

Values persist under `clientSettings.workspace.cvat3dEnhancer` and the standalone backup
`cvat3dEnhancerSettings`. Closing CVAT Settings cannot overwrite them with stale Redux
settings. The keyboard sensitivity option switches between 1.25/2.5 px and 0.2/0.4 degrees
per key press.

## 10. Focus and frame-transition stability

Sidebar double-click activates the intended object before invoking CVAT's focus action,
and resets the previous camera-follow anchor. Camera follow reads the annotation frame
from either `state` or native `data` and waits when it does not match the displayed frame.
It uses the current controls position/target rather than pending animation endpoints.
If controls are still initializing, the delta is retried after they become available;
detached views cannot consume the current job's follow anchor. Appearance updates preserve
all Workspace flags rather than reverting them to defaults.

Regression tests simulate delayed snapshots, rapid frame jumps, object changes, loading
controls, focus transitions, and detached views. No live point-cloud buffers are inspected.

## 11. Removed QA overlay

The active-object QA overlay (dimension, sync, height, heading, jump, distance and
point-cloud fit warnings) has been removed together with its Workspace checkbox. Meow no
longer scans the point cloud around the selected object; the canvas shows only native CVAT
content plus the cuboid base guide when enabled.

## 12. Mouse side buttons in 3D jobs

The Workspace option **Mouse side buttons: previous / next frame** maps browser Back
(button 3) to the native CVAT previous control and Forward (button 4) to next. It uses
the player's active regular, filtered, empty or chapter navigation control. The mapping
only applies on a 3D job page while the option is enabled. Missing or disabled controls,
text inputs and modal dialogs retain the original browser behavior. Browser events do not
identify the physical mouse, so any device sending these buttons has the same mapping.
Device configuration software may remap or consume the buttons before Chrome sees them.

## 13. Native frame loading and filter refresh

Frame navigation continues through CVAT's native player controls. The enhancer waits for
native image/annotation notifications to finish, including nested notifications and
synchronous renders, before initializing newly drawn cuboids (deferred hidden-mesh and
orientation-arrow updates). It never reads or rewrites point cloud buffers, so filter
changes and frame loads do not trigger point processing.

Regression tests use synthetic scenes for nested notifications and steady renders. Live CVAT
job performance still needs verification with the affected dataset; automated tests do not
establish a frame-time improvement.

## 14. Track-wide ride_state and loading-aware camera follow

The RS sidebar control appears only on cuboid tracks whose label exposes mutable
`ride_state`. It propagates the current boolean value to every existing keyframe,
including outside keyframes, so native interpolation carries it through the whole track.
It uses native ObjectState saves, skips matching values, preserves geometry and other
attributes, and refreshes customized sidebars through `updateState` when
`refreshAnnotations` is unavailable. Locked tracks and missing save adapters fail closed.
The user saves annotations to the server with CVAT's normal Save control.

Camera follow waits while `model.data.isFrameUpdating` is true, retaining the previous
anchor during temporary deactivation. It prefers frame-stamped entries in `model.objects`
over unversioned `drawnObjects.data` used by customized builds. Native sidebar
`focusAndExpand` is supported without invoking the combined Quick-filter handler.

## 15. Track editing tools

- H sync keeps each keyframe's bottom at `z - H/2` by shifting its center by `(newH - oldH)/2`. Existing attribute matching and two-wheels exceptions remain. This is the upright-box ground convention; it is not a tilted-face ground fit.
- 180° click edits the current frame; Shift+click flips every exported keyframe, including outside keyframes. L↔W follows the same scope and swaps scales X/Y while adding π/2 to yaw. For CVAT's Euler XYZ order this preserves the physical cuboid, including tilt. New yaw values wrap to [0, 2π). Locked tracks are refused.
- Attr opens an inline native-card selector populated only on demand from mutable label attributes. Applying propagates the current value to existing keyframes, including outside, and preserves every other attribute, geometry and visibility flag. RS remains the boolean ride_state shortcut. Immutable attributes and frame-range attribute editing are not supported.
- Yaw click uses the keyframes strictly before/after the current frame. Shift+click offers explicit exported keyframe endpoints. The shortest signed angular delta is interpolated, writing only points[5] on interior frames, which become keyframes. Native snapshots preserve position, size, tilt and attributes; endpoints remain intact. Outside intervals, absent boundaries and intervals exceeding 10,000 frames are refused. Native CVAT history receives individual writes rather than one extension-wide undo transaction.
- Hold Alt+G shows local exported, non-outside keyframe wireframes in the main perspective view, plus the current frame and a center polyline with direction arrowheads. Blue denotes earlier frames, pink later frames and yellow the current frame. Only already-loaded export data is used; there are no server requests and no all-frame interpolation. The polyline joins visible samples, including across omitted outside spans; it is not an exact trajectory.

Ghosts are a non-interactive Canvas2D overlay projected using the native camera's view and projection matrices. They are intentionally visible through point clouds and are not depth-tested. World geometry, screen buffers, context and overlay are allocated on keydown and reused across renders. Idle render calls return immediately; state-change cleanup uses scalar IDs/frame numbers without scanning job objects. Keyup (G or Alt), blur, visibility changes, object/frame changes, canvas setup, option disable and host disposal remove the overlay. Scroll/resize refresh its viewport rectangle. The Workspace option **Hold Alt+G: track ghosts in 3D** defaults on. Text inputs retain Alt+G; custom CVAT shortcut maps and OS bindings can still conflict.

All writes use CVAT's existing local ObjectState adapters and require normal CVAT **Save** to persist to the server. Snapshot reads assume `__internal.save(frame, state)` with reset update flags returns the native interpolated state without creating a keyframe; point-only writes assume it promotes interior frames to keyframes while preserving untouched state. Attribute writes use the existing native `ObjectState.save()` path. The adapter preflights every target snapshot before writes and requests refresh/redraw once per geometry action, not once per keyframe. Native write failures mid-batch do not have an automatic rollback.

Automated fixtures exercise these contracts, lock refusal, shortest-angle interpolation, selective attributes, native-card actions and ghost lifecycle/reuse, including the 100k-object performance regression. These five additions have not been verified against a live authorized CVAT job in this session; custom ObjectState implementations, native undo grouping and camera/shortcut behavior require live validation.

## 16. Canvas multi-select (current frame only)

Workspace option **Shift+click / Shift+drag: multi-select boxes on the 3D canvas** (default on).

Interactions: Shift+click picks a target (CVAT's active object stays the source); Shift+left-drag draws a DOM marquee and selects boxes whose projected centers fall inside; Shift+Alt+drag/click removes; right-click inside the selection opens the Meow menu; Esc, frame change or activating another object clears. Shift+click on the selected target deselects it (no role swap; use the menu's "Đặt làm gốc").

Scope: **only the main 3D perspective canvas** (`.cvat-canvas3d-perspective`). In Top, Side and Front views, and in zoomed/maximized ortho canvases, Meow registers no selection behavior at all: Shift+click/drag there is left completely to CVAT and to Meow's ortho editor. Listeners are registered on `window` in the capture phase and only intercept events whose target is the perspective canvas while Shift is held (or, for the context menu, while a selection exists and CVAT is idle). A right-click that follows a right-button camera drag (>5 px) is not intercepted. Nothing runs per render frame or per Redux update while idle; projection and picking run once on mouse release.

Robustness rules: gestures start only when `annotation.canvas.activeControl` is `cursor` (draw/group/merge/split/etc. are left to CVAT) and are re-checked on mouse release and before every menu action; a marquee is dropped if the frame or mode changed mid-drag or the button was released outside the window (next `mousemove` without button 1 cancels it); hidden and outside objects are never selected by the marquee; dispose removes every listener, the marquee, toolbar and menu.

### Single undo step per Meow action

Every Meow write (swap, sync, align, hide/show) is one native undo step, reachable with CVAT's Ctrl+Z / Ctrl+Shift+Z and the toolbar Undo/Redo buttons:

- Writes use `job.annotations.saveStates(states)`. In cvat-core it opens one `AnnotationHistory` transaction around all `object.save(...)` calls and pushes a single grouped entry (`annotations-collection.ts:1762-1810`, `annotations-history.ts:154-169`); undo/redo run the grouped actions in reverse/forward order (`annotations-history.ts:44-60`). This is the same mechanism cvat-ui uses for moving a multi-selection (`updateAnnotationsBatchAsync`, `annotation-actions.ts:1692`). If one object throws, the transaction is aborted and every object is rolled back.
- A transaction accepts actions of one frame only (`annotations-history.ts:35-42`), so the neighbor-frame keyframe pins of interpolated tracks cannot join it. They are written first with history frozen (`job.actions.freeze(true)`, restored in `finally`) and therefore create no undo steps. Undoing the action restores the edited frame (points, attributes, occluded, keyframe flag of f). The pins stay as extra keyframes holding exactly the previously interpolated values, so the track geometry after undo is unchanged; they are not removed by undo. If a pin cannot be written, no object is edited.
- Pair actions (swap / sync source→target) are all-or-nothing: if either object is locked, outside, ground truth or has no snapshot access nothing is written. Cluster actions skip such objects and report the counts in the toast (cvat-core's `save()` is a silent no-op for locked objects, `track.ts:515`, `shape.ts:255`).
- CVAT builds without `job.annotations.saveStates` (older releases) fall back to per-object `ObjectState.save()`: one history entry per saved object, plus unfrozen pins. The toast states how many Ctrl+Z presses revert the action, and a failed pair write is rolled back by re-saving the previous values. The history instance (`getHistory(job)`) is a private WeakMap lookup in cvat-core and is not reachable from the page, so Meow cannot register its own grouped entry there; a Meow-owned undo stack was not built because it would conflict with CVAT's Ctrl+Z ordering.
- After each write Meow refreshes Redux like `fetchAnnotationsAsync`: `FETCH_ANNOTATIONS_SUCCESS` with the states of the current frame (current filters) and `history = await job.actions.get()`, which is what enables the Undo/Redo buttons. Nothing is dispatched if the frame or job changed while awaiting. When ground-truth states are shown, `UPDATE_ANNOTATIONS_SUCCESS` (merge by clientID) is used instead, and Meow filter changes are refused because a full replace would drop the ground-truth states. Writes are refused in the Review workspace.
- Undo/redo themselves are native (`undoActionAsync` → `job.actions.undo()` then `fetchAnnotationsAsync`), so canvas, sidebar and Redux `history` stay consistent without Meow code.

### Verified APIs

Checked against cvat-ai/cvat `develop` at commit `8299df02e9c0` (sources copied to a scratch folder, not stored in this repo). "Version-dependent" means the symbol exists in that snapshot but older/forked builds may differ, and Meow feature-detects it.

| API used by Meow                                                                                                                                  | Verified in (file:line)                                                                                                      | Status                                                                                   |
| ------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Action `CHANGE_ANNOTATIONS_FILTERS`, payload `{filters}`                                                                                          | `annotation-actions.ts:151`, `:406-411`; reducer `annotation-reducer.ts:1112`                                                | verified                                                                                 |
| Filters applied as change + `fetchAnnotationsAsync()`                                                                                             | `filters-modal.tsx:349-353`                                                                                                  | verified                                                                                 |
| `FETCH_ANNOTATIONS_SUCCESS` payload `{states, intervals, history}` (reducer reads `states`, `history`; `minZ/maxZ` are recomputed by the reducer) | `annotation-actions.ts:153`, `:380-396`; `annotation-reducer.ts:1068-1100`, `computeZRange` `:41`                            | verified; Meow also sends `minZ/maxZ` for older reducers (version-dependent, harmless)   |
| `UPDATE_ANNOTATIONS_SUCCESS` payload `{states, history}` (merged by clientID)                                                                     | `annotation-actions.ts:112`, `:1599-1608`; `annotation-reducer.ts:651-690`                                                   | verified (earlier guess `{states, history, minZ, maxZ}` had extra fields)                |
| `ACTIVATE_OBJECT` payload `{activatedStateID, activatedElementID, activatedAttributeID}`; ignored unless canvas is IDLE and control is cursor     | `annotation-actions.ts:125`, `:969-991`; `annotation-reducer.ts:709-735`                                                     | verified                                                                                 |
| `job.annotations.get(frame, allTracks, filters)` (array filters required, served from memory)                                                     | `session-implementation.ts:351-360`, `annotations-collection.ts:465`                                                         | verified                                                                                 |
| `job.actions.get()` returns `{undo: [action, frame][], redo: ...}`                                                                                | `session-implementation.ts:690`, `annotations-history.ts:79-87`                                                              | verified                                                                                 |
| `job.actions.freeze(bool)`                                                                                                                        | `session-implementation.ts:673`, `annotations-history.ts:75`                                                                 | verified                                                                                 |
| `job.annotations.saveStates(states)` = one history transaction                                                                                    | `session-implementation.ts:547`, `annotations-collection.ts:1762-1810`; used by cvat-ui at `annotation-actions.ts:1651-1655` | verified on this snapshot; **version-dependent** (feature-detected, per-object fallback) |
| History transaction frame rule                                                                                                                    | `annotations-history.ts:35-42`                                                                                               | verified (why pins are frozen)                                                           |
| `job.actions.undo/redo` and native `undoActionAsync` refresh                                                                                      | `session-implementation.ts:642-660`, `annotation-actions.ts:1221-1266`                                                       | verified                                                                                 |
| `ObjectState.save()` → `__internal.save(frame, state)` → `Track/Shape.save`                                                                       | `object-state.ts:564-572`, `track.ts:514-583`, `shape.ts:250`                                                                | verified                                                                                 |
| `ObjectState` setters `points`/`attributes`/`occluded`/`keyframe`/`hidden` raise `updateFlags` themselves                                         | `object-state.ts:257, 330, 357, 404, 226`                                                                                    | verified                                                                                 |
| `Track.save` with no raised flags returns `new ObjectState(this.get(frame))` (neighbor snapshot idiom)                                            | `track.ts:514-583`                                                                                                           | verified                                                                                 |
| `state.keyframe = true` (+ points) turns an interpolated frame into a keyframe                                                                    | `track.ts:485-512`, `:575-577`                                                                                               | verified                                                                                 |
| `save()` is a no-op for locked objects (`this.lock && data.lock`)                                                                                 | `track.ts:515`, `shape.ts:255`                                                                                               | verified (hence locked = skipped/refused)                                                |
| `objectID` filter field is `clientID`                                                                                                             | `annotations-filter.ts:278, 350, 429`; `filters-modal.tsx:229`                                                               | verified                                                                                 |
| Workspace names (`'Review'`) and `showAllInterpolationTracks` / `showGroundTruth` / `groundTruthInfo` Redux paths                                 | `annotation-actions.ts:60-87`, cvat-ui `reducers/index.ts` (`Workspace` enum)                                                | verified                                                                                 |
| `canvas.instance.view.receiveShapeColor`, `drawnObjects[id].cuboid.setColor`                                                                      | `canvas3dView.ts` (copied earlier, see below)                                                                                | unchanged, version-dependent (private view members)                                      |

Still assumed and needing a live check: that the customized CVAT build in use matches these shapes (state path `annotation.job.instance`, `annotation.canvas.activeControl`), that `saveStates` exists there, that its undo/redo restores canvas and sidebar identically to a manual edit, and the 100k-object frames (the Redux refresh re-reads the frame once per action, never while idle).

The remaining notes from the earlier verification of `canvas3dView.ts` / `canvas3dModel.ts` still hold:

- The perspective `click` handler activates the clicked cuboid in IDLE mode, and `contextmenu` opens CVAT's object menu when an object is active; both are pre-empted in the capture phase only while Meow intercepts.
- `GROUP`/`MERGE` color boxes with `drawnObjects[id].cuboid.setColor(...)` and restore with the view's private `receiveShapeColor(state)`. Meow reuses `cuboid.setColor` and calls `receiveShapeColor` on `annotation.canvas.instance.view` when present, falling back to the entry's label color. The grouping color constant is not readable at runtime, so Meow uses its own highlight color (`#ffd400`). Stored annotation colors are never modified.

Limits: only frame f is written; neighbor pinning assumes linear interpolation; locked and outside objects are skipped (pairs refuse); selection is lost on frame change; no selection in Top/Side/Front/zoomed views (by design).

Existing sidebar buttons (H/W/L, 180°, L↔W, Yaw, Attr, RS) keep their native `ObjectState`/`__internal.save` writes (the same cvat-core call as `ObjectState.save()`), and now also run the same Redux refresh after writing so CVAT's Undo/Redo state is current. The single-frame 180° and H/W/L paths still emit a `canvas.edited` event (cvat-ui's own `updateAnnotationsAsync`), which records one extra equal-valued history entry; replacing that event with the Redux refresh was left out to keep behavior and tests unchanged until verified on a live job.
