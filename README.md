# Meow

![Meow](public/assets/meow-128.png)

Meow — make your workspace feel like home.

---

## 1. Installation Instructions (Chrome / Brave)

1. Install dependencies and build the production bundle:
   ```bash
   npm install
   npm run build
   ```
2. Open Chrome (`chrome://extensions`) or Brave (`brave://extensions`).
3. Enable **Developer mode** in the top-right corner.
4. Click **Load unpacked** and select the generated `dist/` directory inside this repository.
5. Navigate to an authorized CVAT instance (`https://app.cvat.ai` or `http://localhost:8080`) and open a 3D annotation job (`/tasks/<taskId>/jobs/<jobId>`).

---

## 2. Development & Verification Scripts

```bash
# Start Vite + CRXJS development server
npm run dev

# Run TypeScript strict type checking
npm run typecheck

# Run ESLint static analysis (including no-eval / no-new-func security rules)
npm run lint

# Run unit, integration, compatibility, and security test suites (Vitest)
npm run test

# Run dedicated security test suite + static secret/unsafe-execution scanner
npm run test:security

# Build production extension bundle into dist/
npm run build

# Run end-to-end build & Manifest V3 CSP verification (Playwright)
npm run test:e2e
```

---

## 3. Verified vs. Unsupported CVAT 3D Capabilities (`v2.81.0`)

| Capability | Status | Details |
| --- | --- | --- |
| **Cuboid Appearance (`cuboidAppearance`)** | **Supported** | Opacity, selected opacity, outlined borders, outline hex color, orientation arrows (`always`/`selected`/`never`), control points size, and focus padding via CVAT Redux & `Canvas3d.configure()`. |
| **Cuboid Color-By (`labelColors`)** | **Supported** | Switches between `Label`, `Instance`, and `Group` coloring modes. |
| **Camera Presets (`cameraPresets`)** | **Supported** | Step movement, zoom, pitch tilt, yaw rotation (`Canvas3d.keyControls()`), and camera reset (`Canvas3d.fit()`). |
| **Point Cloud Viewport Appearance (`pointCloudAppearance`)** | **Supported** | Non-destructive 3D viewport background color and WebGL `<canvas>` brightness/contrast filters. |
| **Point Size (`pointSize`)** | **Unsupported** | Encapsulated inside private `Canvas3dViewImpl.addScene()` (`size = 0.05` / `0.5`) with no public setter in CVAT `v2.81.0`. |
| **Color Mode Shader (`colorMode`)** | **Unsupported** | `PCDLoader` output is hardcoded to `PointsMaterial(0xffffff)` inside `Canvas3dViewImpl` with no height/intensity shader hook. |
| **3D Ground Grid (`gridVisibility`)** | **Unsupported** | `cvat-canvas3d` does not instantiate `THREE.GridHelper` (`settings.workspace.grid` is 2D-only). |
| **Coordinate Axes Toggle (`coordinateAxes`)** | **Unsupported** | `new THREE.AxesHelper(5)` is added anonymously to private `views.perspective.scene` without a public toggle API. |

---

## 4. Documentation Index

- [Architecture Overview](docs/architecture.md)
- [Authentication Architecture](docs/authentication.md)
- [CVAT 3D Runtime Integration](docs/runtime-integration.md)
- [Configuration Schema & Hierarchy](docs/configuration-schema.md)
- [Security Baseline & VSOC Compliance Mapping](docs/security.md)
- [Threat Model](docs/threat-model.md)
- [Compatibility & Known Limitations](docs/compatibility.md)
- [Vulnerability Reporting Policy](SECURITY.md)
