# CVAT 3D Runtime Integration & Capability Verification

## 1. Target CVAT Version Inspected

- **Repository**: `https://github.com/cvat-ai/cvat`
- **Release Tag**: `v2.81.0`
- **3D Engine Package**: `cvat-canvas3d` (`v0.0.10`), using `three@0.184.0` and `camera-controls@^1.25.3`.
- **UI Wrapper**: `cvat-ui/src/components/annotation-page/canvas/views/canvas3d/canvas-wrapper3D.tsx`.

## 2. Actual CVAT 3D Architecture Findings

1. **No Global `window` Renderer Exposure**:
   - `Canvas3dImpl` (`cvat-canvas3d/src/typescript/canvas3d.ts`) instantiates `Canvas3dModelImpl`, `Canvas3dControllerImpl`, and `Canvas3dViewImpl` as `private` class properties.
   - Three.js `Scene`, `WebGLRenderer`, `PerspectiveCamera`, and `PointsMaterial` live inside `Canvas3dViewImpl.views` and are **not** attached to `window`.
2. **Official Plugin Entrypoint (`window.cvatUI.registerComponent`)**:
   - `cvat-ui/src/components/plugins-entrypoint.tsx` defines `window.cvatUI.registerComponent(componentBuilder)` and passes `{ dispatch, actionCreators, core, store }`.
   - Through `store.getState().annotation.canvas.instance`, the active `Canvas3d` instance is accessible in the page world.
3. **Public `Canvas3d` Interface (`cvat-canvas3d/src/typescript/canvas3d.ts`)**:
   - `html(): ViewsDOM` (`{ perspective, top, side, front }` `<canvas>` elements)
   - `configure(configuration: Configuration): void` (`colorBy`, `shapeOpacity`, `outlinedBorders`, `selectedShapeOpacity`, `controlPointsSize`, `focusedObjectPadding`, `orientationVisibility`)
   - `keyControls(keys: KeyboardEvent): void`
   - `fit(): void`
   - `focus(clientID: number): void`
   - `activate(clientID: number | null, attributeID?: number): void`

## 3. Verified vs. Unsupported Capabilities Matrix

| Capability ID | Status in CVAT `v2.81.0` | Technical Verification Details |
| --- | --- | --- |
| `cuboidAppearance` | **Supported (Verified)** | Wired via `PageBridge` to CVAT Redux settings actions (`CHANGE_SHAPES_OPACITY`, `CHANGE_SELECTED_SHAPES_OPACITY`, `CHANGE_SHAPES_OUTLINED_BORDERS`, `CHANGE_SHAPES_ORIENTATION_VISIBILITY`, `SWITCH_CONTROL_POINTS_SIZE`, `CHANGE_FOCUSED_OBJECT_PADDING`) and `Canvas3d.configure()`. |
| `labelColors` | **Supported (Verified)** | Wired via `PageBridge` to `CHANGE_SHAPES_COLOR_BY` and `Canvas3d.configure({ colorBy })` (`Label`, `Instance`, `Group`). |
| `cameraPresets` | **Supported (Verified)** | Wired via `PageBridge` to `Canvas3d.keyControls(KeyboardEvent)` for `CameraAction` (`KeyI`, `KeyK`, `KeyU`, `KeyO`, `KeyJ`, `KeyL`, `ArrowUp`, `ArrowDown`, `ArrowLeft`, `ArrowRight`) and `Canvas3d.fit()`. |
| `pointCloudAppearance` | **Supported (Verified)** | Non-destructive viewport background color and WebGL `<canvas>` brightness/contrast filters verified via `.cvat-canvas3d-perspective` and `.cvat-canvas3d-orthographic-view` DOM containers. |
| `pointSize` | **Unsupported (Verified Limitation)** | In `canvas3dView.ts` lines 1799 and 1851, `points.material.size = 0.05` (perspective) and `material.size = 0.5` (top/side/front) are hardcoded inside `addScene()` on a private `THREE.Points` clone with no public setter or `Configuration` property. |
| `colorMode` | **Unsupported (Verified Limitation)** | In `canvas3dView.ts` line 1800, `points.material.color.set(new THREE.Color(0xffffff))` is hardcoded on `PCDLoader` output with no height/intensity shader or public API. |
| `gridVisibility` | **Unsupported (Verified Limitation)** | `cvat-canvas3d` does not instantiate `THREE.GridHelper`; `settings.workspace.grid` in CVAT UI only applies to the 2D canvas. |
| `coordinateAxes` | **Unsupported (Verified Limitation)** | In `canvas3dView.ts` line 1821, `const axesHelper = new THREE.AxesHelper(5)` is added anonymously to private `this.views.perspective.scene` with no name or toggle method. |
