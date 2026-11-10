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

## 8. Main 3D point size

The main perspective point cloud keeps native distance/zoom attenuation and uses a size
of 0.06 (CVAT native 0.05 × 1.2), making points 20% larger at the same zoom level. The
multiplier does not compound on subsequent renders. Top, Side, Front and their zoomed
views retain their existing fixed 3.5 px size.
The orthographic size toggle affects only those views; it does not change the main 3D size.

## 9. Workspace controls for recent enhancements

Settings → Workspace includes eight independent checkboxes: cuboid base guide, native
focus without automatic Quick filter, H/W/L sync buttons, heading flip button, W/A/S/D/Q/E
editing, double keyboard sensitivity, immediate key-release commit, and 20% larger main
3D points. Existing installations default to enabled to preserve their current behavior.
Turning off a control applies immediately. Disabling the keyboard restores native CVAT
shortcuts; disabling the filter override restores native double-click behavior.

Values persist under `clientSettings.workspace.cvat3dEnhancer` and the standalone backup
`cvat3dEnhancerSettings`. Closing CVAT Settings cannot overwrite them with stale Redux
settings. The main point-size option preserves zoom scaling in both states; the keyboard
sensitivity option switches between 1.25/2.5 px and 0.2/0.4 degrees per key press.

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
