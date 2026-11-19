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

Interactions: Shift+click picks a target (CVAT's active object stays the source); Shift+left-drag draws a DOM marquee and selects boxes whose projected centers fall inside; Shift+Alt+drag/click removes; right-click inside the selection opens the Meow menu; Esc, frame change or activating another object clears. Shift+click on the selected target deselects it (no role swap; use the menu's "Đặt làm gốc"). Perspective and Top views are supported. Listeners are registered on `window` in the capture phase and only intercept events while Shift is held or a selection exists, so native rotate/truck/click/context-menu behavior is otherwise untouched. A right-click that follows a right-button camera drag (>5 px) is not intercepted. Nothing runs per render frame or per Redux update while idle; projection and picking run once on mouse release.

Verified in the CVAT sources copied for this work (`canvas3dView.ts`, `canvas3dModel.ts`, `filters-modal.tsx`):

- The perspective `click` handler activates the clicked cuboid in IDLE mode, and `contextmenu` opens CVAT's object menu when an object is active; both are pre-empted in the capture phase only while Meow intercepts.
- `GROUP`/`MERGE` color boxes with `drawnObjects[id].cuboid.setColor(...)` and restore with the view's private `receiveShapeColor(state)`. Meow reuses `cuboid.setColor` and calls `receiveShapeColor` on `annotation.canvas.instance.view` when present, falling back to the entry's label color. The grouping color constant is not readable at runtime, so Meow uses its own highlight color (`#ffd400`). Stored annotation colors are never modified.
- The filter is `changeAnnotationsFilters(filters)` followed by `fetchAnnotationsAsync()`; `annotation.annotations.filters` is an array whose first item is a JSONLogic object (second item: keypoint logic, preserved). `objectID` is a filter field (`filters-modal.tsx`).

Assumed (from cvat-ui/cvat-core knowledge, not visible in the copied sources) and requiring a live check:

- `objectID` evaluates to the object's `clientID` in cvat-core's annotation filter.
- Thunks cannot be dispatched from the page, so Meow dispatches the plain actions those thunks end with: `CHANGE_ANNOTATIONS_FILTERS`, then `FETCH_ANNOTATIONS_SUCCESS` with states from `job.annotations.get(frame, showAllInterpolationTracks, filters)`; after writes `UPDATE_ANNOTATIONS_SUCCESS` with `{states, history, minZ, maxZ}` where `history = await job.actions.get()`. Action names/payloads match cvat-ui's `AnnotationActionTypes` as remembered.
- "Đặt làm gốc" dispatches `ACTIVATE_OBJECT` with `activatedStateID`.
- `ObjectState.save()` delegates to the same cvat-core call as `__internal.save(frame, state)` and therefore records core action history. The previously missing piece for Undo was the Redux `history` snapshot that cvat-ui uses to enable Undo/Ctrl+Z; it is refreshed by `UPDATE_ANNOTATIONS_SUCCESS`.
- Setting `state.keyframe = true` (+ unchanged `points`) and calling `save()` turns an interpolated neighbor frame into a keyframe with its current values; neighbor snapshots are read with `__internal.save(frame, state)` after `updateFlags.reset()` (the existing read idiom).
- `state.hidden` + `save()` updates the sidebar eye state; hide/show is a UI flag and is not an undo entry.
- `job.annotations.get(frame, allTracks, [])` is served from cvat-core's in-memory collection (no server request) and is the "unfiltered" source for "Thêm vật thể xung quanh"; without it Meow falls back to the drawn objects and says so.

Limits: only frame f is written; each written object/frame is a separate cvat-core history entry (several Ctrl+Z presses per multi-object action); neighbor pinning assumes linear interpolation; locked and outside objects are skipped; selection is lost on frame change; Shift+drag in zoomed/maximized orthographic views and Side/Front views is not handled. During CVAT draw/group/merge/split modes (`annotation.canvas.activeControl` is not `cursor`) the Shift gestures are left to CVAT.

Existing sidebar buttons (H/W/L, 180°, L↔W, Yaw, Attr, RS) keep their native `ObjectState`/`__internal.save` writes (the same cvat-core call as `ObjectState.save()`), and now also run the same Redux refresh after writing so CVAT's Undo/Redo state is current. The single-frame 180° and H/W/L paths still emit a `canvas.edited` event (cvat-ui's own `updateAnnotationsAsync`), which records one extra equal-valued history entry; replacing that event with the Redux refresh was left out to keep behavior and tests unchanged until verified on a live job.
