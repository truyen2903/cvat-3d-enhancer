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
