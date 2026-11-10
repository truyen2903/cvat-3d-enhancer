# Meow

![Meow](public/assets/meow-128.png)

Meow — make your workspace feel like home.

---

## 1. Installation Instructions (Chrome / Brave)

### Download and install (no build required)

1. Open [the latest release](https://github.com/truyen2903/cvat-3d-enhancer/releases/latest) and download **meow-v0.2.0.zip** under **Assets**.
2. Extract the ZIP and keep the **meow/** folder in a permanent location.
3. Open Chrome (`chrome://extensions`) or Brave (`brave://extensions`) and enable **Developer mode**.
4. Click **Load unpacked** and select **meow/**, the extracted folder containing `manifest.json`.
5. For a private/company CVAT domain, open the Meow popup, enter the CVAT URL and click **Add & Activate Link**. Grant site permission and reload the CVAT tab.
6. Open a 3D job and go to **CVAT Settings → Workspace** to configure the enhancements.

**Node.js, npm and building source code are not required.** The archive includes `INSTALL.txt` with Vietnamese and English instructions.

To update, replace the contents of your existing extension folder with the new version, keep the same folder path, click **Reload** on the Extensions page and reload CVAT.

### Build from source

```bash
npm ci
npm run build
```

Load the generated `dist/` folder using **Load unpacked**. To create the same ready-to-install ZIP as a release, run `npm run package:release` after building.

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

| Capability                                                   | Status          | Details                                                                                                                                                                                           |
| ------------------------------------------------------------ | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Cuboid Appearance (`cuboidAppearance`)**                   | **Supported**   | Opacity, selected opacity, outlined borders, outline hex color, orientation arrows (`always`/`selected`/`never`), control points size, and focus padding via CVAT Redux & `Canvas3d.configure()`. |
| **Cuboid Color-By (`labelColors`)**                          | **Supported**   | Switches between `Label`, `Instance`, and `Group` coloring modes.                                                                                                                                 |
| **Camera Presets (`cameraPresets`)**                         | **Supported**   | Step movement, zoom, pitch tilt, yaw rotation (`Canvas3d.keyControls()`), and camera reset (`Canvas3d.fit()`).                                                                                    |
| **Point Cloud Viewport Appearance (`pointCloudAppearance`)** | **Supported**   | Non-destructive 3D viewport background color and WebGL `<canvas>` brightness/contrast filters.                                                                                                    |
| **Point Size (`pointSize`)**                                 | **Unsupported** | Encapsulated inside private `Canvas3dViewImpl.addScene()` (`size = 0.05` / `0.5`) with no public setter in CVAT `v2.81.0`.                                                                        |
| **Color Mode Shader (`colorMode`)**                          | **Unsupported** | `PCDLoader` output is hardcoded to `PointsMaterial(0xffffff)` inside `Canvas3dViewImpl` with no height/intensity shader hook.                                                                     |
| **3D Ground Grid (`gridVisibility`)**                        | **Unsupported** | `cvat-canvas3d` does not instantiate `THREE.GridHelper` (`settings.workspace.grid` is 2D-only).                                                                                                   |
| **Coordinate Axes Toggle (`coordinateAxes`)**                | **Unsupported** | `new THREE.AxesHelper(5)` is added anonymously to private `views.perspective.scene` without a public toggle API.                                                                                  |

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

## 5. Publishing a release

The **Release extension** GitHub Actions workflow validates the code, rebuilds the extension,
packages a ZIP plus SHA256 checksum, and publishes them to GitHub Releases. Bump the
package, lockfile and manifest versions together, add `docs/releases/vX.Y.Z.md`, then push
the matching `vX.Y.Z` tag or run the workflow manually from Actions. The workflow uses the
built-in GitHub token; no personal access token is stored in this repository.
