# QC Margin Overlay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Draw inner/outer translucent margin shells around the active CVAT cuboid (main 3D + Top/Side/Front) so annotators can judge error P by eye.

**Architecture:** A pure-logic module (label → ratio, box → 16 shell corners) plus a canvas-2D overlay class modelled on `TrackGhostOverlay` (camera-matrix projection, zero per-frame allocation, redraw only on change). Wired into the existing `onCanvasRender` listener in `page-bridge.ts`; toggles added to Workspace feature options.

**Tech Stack:** TypeScript strict, Vitest + jsdom, React-free runtime code in `src/integration/cvat/runtime/`.

**Spec:** `docs/superpowers/specs/2026-11-26-qc-margin-overlay-design.md`

## Global Constraints

- Ratios: `vehicles` 0.05, `two-wheels` 0.08, `pedestrian` 0.10; every other label draws nothing.
- Shell size = box dimensions × (1 ± ratio); inner = 1 − ratio, outer = 1 + ratio.
- Active object only; hidden/outside/non-cuboid → nothing drawn.
- No per-frame allocation in `render`; no point-cloud scan.
- Prettier: 2 spaces, single quotes, semicolons, 100 cols; explicit `any` forbidden; kebab-case files.
- Overlay must never write to CVAT state; `pointer-events: none`.
- Z check and text HUD are out of scope.

## Review Focus

- Label `"Vehicles "` / `"TWO-WHEELS"` (case, whitespace) → still matched; `"Animal"`, `"Obstacle"`, `undefined` → null.
- `points` shorter than 9, containing NaN, or with non-positive dimensions → no shells, no throw.
- Vertex behind the camera (`cw <= 0`) in perspective → that corner is skipped, no NaN drawn.
- Switching active object or toggling the option off clears canvases once and stops drawing.
- Main-3D and Top/Side/Front toggles are independent; master off disables both.
- Canvas removed from DOM or resized → overlay follows/clears without leaking elements.

---

### Task 1: Label ratio and shell geometry

**Files:**
- Create: `src/integration/cvat/runtime/qc-margin-geometry.ts`
- Test: `tests/unit/qc-margin-geometry.test.ts`

**Interfaces:**
- Produces:
  - `QC_MARGIN_RATIOS: Readonly<Record<'vehicles' | 'two-wheels' | 'pedestrian', number>>`
  - `resolveQcMarginRatio(labelName: string | null | undefined): number | null`
  - `buildQcShells(points: readonly number[], ratio: number, out: Float64Array): boolean` — `out` has 48 floats: 8 outer corners (x,y,z) then 8 inner corners. Corner `i` = center + Σ axisₖ · (±halfₖ), sign `+` when bit k of `i` is set (bit0→axis0, bit1→axis1, bit2→axis2; same order as `EDGES` in `track-ghost-overlay.ts`). Uses `cuboidAxes` from `ortho-cuboid-editor.ts`. Returns `false` (leaving `out` untouched) if `points.length < 9`, any of the first 9 values is non-finite, or any of `points[6..8] <= 0`.

- [ ] **Step 1: Write the failing tests**

```ts
it('maps the three labels case-insensitively and ignores others', () => {
  expect(resolveQcMarginRatio('vehicles')).toBe(0.05);
  expect(resolveQcMarginRatio(' Vehicles ')).toBe(0.05);
  expect(resolveQcMarginRatio('TWO-WHEELS')).toBe(0.08);
  expect(resolveQcMarginRatio('pedestrian')).toBe(0.1);
  for (const l of ['Animal', 'Obstacle', '', undefined, null]) expect(resolveQcMarginRatio(l)).toBeNull();
});
it('builds outer/inner corners for an axis-aligned 4x2x2 box at ratio 0.05', () => {
  const out = new Float64Array(48);
  expect(buildQcShells([0, 0, 0, 0, 0, 0, 4, 2, 2], 0.05, out)).toBe(true);
  expect([...out.slice(21, 24)]).toEqual([expect.closeTo(2.1), expect.closeTo(1.05), expect.closeTo(1.05)]); // outer corner 7
  expect([...out.slice(0, 3)]).toEqual([expect.closeTo(-2.1), expect.closeTo(-1.05), expect.closeTo(-1.05)]); // outer corner 0
  expect(out[45]).toBeCloseTo(1.9); // inner corner 7, x
});
it('rejects invalid points without touching out', () => {
  const out = new Float64Array(48).fill(7);
  expect(buildQcShells([0, 0, 0, 0, 0, 0, 4, 2], 0.05, out)).toBe(false);
  expect(buildQcShells([0, 0, 0, 0, 0, 0, 4, NaN, 2], 0.05, out)).toBe(false);
  expect(buildQcShells([0, 0, 0, 0, 0, 0, 4, 0, 2], 0.05, out)).toBe(false);
  expect(out.every((v) => v === 7)).toBe(true);
});
```

- [ ] **Step 2: Run** `npx vitest run tests/unit/qc-margin-geometry.test.ts` — Expected: FAIL (module missing).
- [ ] **Step 3: Implement** the three exports above in `qc-margin-geometry.ts`; label lookup trims and lowercases, aliases `vehicle`, `two-wheel`, `twowheels`, `two_wheels`, `pedestrians` map to the same ratios.
- [ ] **Step 4: Run** the same command — Expected: PASS.
- [ ] **Step 5: Commit** `feat(qc): add margin ratio and shell geometry`

### Task 2: Canvas overlay with change-only redraw

**Files:**
- Create: `src/integration/cvat/runtime/qc-margin-overlay.ts`
- Test: `tests/unit/qc-margin-overlay.test.ts`

**Interfaces:**
- Consumes: `resolveQcMarginRatio`, `buildQcShells` (Task 1); `GuideCameraLike` from `cuboid-base-guide.ts`; `ensureMeowStyle` only if styling is needed.
- Produces:
  - `export interface QcMarginTarget { readonly points: readonly number[]; readonly labelName: string | null | undefined }`
  - `export class QcMarginOverlay { constructor(doc: Document); render(canvas: HTMLCanvasElement, camera: GuideCameraLike, target: QcMarginTarget | null): void; clear(): void; dispose(): void }`
  - Contract: one fixed-position, `pointer-events: none` `<canvas>` per source canvas, appended to `doc.fullscreenElement ?? doc.documentElement`, sized to the source canvas rect (device-pixel-ratio aware). `render(…, null)` or a label with no ratio clears that overlay once (tracked by a `drawn` flag) and returns.
  - Performance contract: shells rebuilt only when the 9 point values or ratio differ from the cached copy; the draw is skipped when the cached 32 camera numbers (`matrixWorldInverse` + `projectionMatrix`), rect size and shell version are unchanged. Reuse preallocated `Float64Array`s; no object/array creation in `render` after first call per canvas.
  - Drawing: project 16 corners like `TrackGhostOverlay.render` (valid when `cw > 0 && cz ∈ [-cw, cw]`); fill the outer-hull with colour A `rgba(255, 159, 64, 0.22)`, then the inner-hull with colour B `rgba(64, 160, 255, 0.22)`; stroke both outlines 1px. Hull = convex hull of the valid projected corners of that shell (monotone chain over preallocated index buffers; skip if < 3 valid corners).

- [ ] **Step 1: Write the failing tests** (stub `HTMLCanvasElement.prototype.getContext` with `vi.spyOn` returning a recording mock with `clearRect/beginPath/moveTo/lineTo/closePath/fill/stroke` spies; use a `three` `OrthographicCamera` after `updateMatrixWorld()`; a source `<canvas>` with mocked `getBoundingClientRect`):
  - `renders_two_fills_for_vehicles`: target `{ points: [0,0,0,0,0,0,4,2,2], labelName: 'vehicles' }` → `fill` called twice.
  - `draws_nothing_for_animal`: `labelName: 'Animal'` → no overlay canvas appended, `fill` not called.
  - `skips_redraw_when_nothing_changed`: second identical `render` → `fill` call count unchanged.
  - `redraws_when_points_change`: change `points[6]` → `fill` count increases by 2.
  - `clears_once_on_null`: after a draw, `render(…, null)` → `clearRect` called once, second `null` call adds no calls; overlay canvas `display` is `none`.
  - `dispose_removes_overlays`: after `dispose()`, `document.querySelectorAll('canvas.meow-qc-margin')` is empty.
- [ ] **Step 2: Run** `npx vitest run tests/unit/qc-margin-overlay.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** `QcMarginOverlay` per the contract above; overlay canvases carry class `meow-qc-margin`; follow `TrackGhostOverlay` for rect/resize/scroll handling and register/unregister listeners in constructor/`dispose`.
- [ ] **Step 4: Run** the same command — Expected: PASS.
- [ ] **Step 5: Commit** `feat(qc): add margin shell canvas overlay`

### Task 3: Workspace toggles

**Files:**
- Modify: `src/integration/cvat/runtime/workspace-feature-options.ts` (defaults + controls)
- Test: `tests/unit/workspace-feature-options.test.ts`

**Interfaces:**
- Produces three boolean options, all default `true`, group `'Hiển thị'`:
  - `showQcMargin` — title `'QC vùng đệm P'`, description `'Tô vùng ±% quanh box đang chọn: Vehicles 5%, Two-wheels 8%, Pedestrian 10%.'`
  - `showQcMarginPerspective` — title `'QC vùng đệm ở 3D chính'`, description `'Hiện vùng đệm trong khung 3D chính.'`
  - `showQcMarginOrtho` — title `'QC vùng đệm ở Top / Side / Front'`, description `'Hiện vùng đệm trong ba khung chiếu.'`

- [ ] **Step 1: Write the failing test** — `normalizeWorkspaceFeatureOptions({})` has `showQcMargin`, `showQcMarginPerspective`, `showQcMarginOrtho` all `true`; `{ showQcMargin: 'x' }` stays `true`; the existing "mounts every option" test is extended/adjusted so it still passes with 3 more controls (`WORKSPACE_FEATURE_KEYS` loops cover persistence).
- [ ] **Step 2: Run** `npx vitest run tests/unit/workspace-feature-options.test.ts` — Expected: FAIL.
- [ ] **Step 3: Add** the three keys to `WORKSPACE_FEATURE_DEFAULTS` and three entries to `WORKSPACE_FEATURE_CONTROLS`; fix any hard-coded control counts in existing tests.
- [ ] **Step 4: Run** the same command — Expected: PASS.
- [ ] **Step 5: Commit** `feat(qc): add Workspace toggles for margin overlay`

### Task 4: Wire into the page bridge

**Files:**
- Modify: `src/entrypoints/page-bridge.ts` (field next to `baseGuide` ~L240; construct near L324; use in `onCanvasRender` ~L396; dispose near L847; refresh near L1020 where `baseGuide?.refresh()` is called)
- Test: `tests/integration/runtime-bridge.test.ts`

**Interfaces:**
- Consumes: `QcMarginOverlay`, `QcMarginTarget` (Task 2); options from Task 3 via `this.preRenderEnhancer.getOptionsReadonly()`.
- Produces: in `onCanvasRender`, **before** the `isOrthographicCamera` early return: 
  1. read the two flags; `enabled = showQcMargin && (isOrtho ? showQcMarginOrtho : showQcMarginPerspective)` (all `?? true`);
  2. if not enabled → `qcMargin.render(canvas, cam, null)` and continue;
  3. else `active = this.resolveActiveCuboid(false)`; target is `null` when no active, `hidden`/`outside`, `lock`ed is allowed, or `shapeType` set and not `'cuboid'`; otherwise `{ points: entry?.data.points ?? state.points, labelName: state.label?.name ?? resolveSidebarObjectContext(this.doc, clientID)?.state?.label?.name }`.
  The rest of the listener (base guide) must behave exactly as before. Dispose `qcMargin` in the runtime cleanup.

- [ ] **Step 1: Write the failing integration test** following the existing `runtime-bridge` harness: with an active `vehicles` cuboid, a perspective render callback creates one `canvas.meow-qc-margin`; setting `showQcMargin: false` (or `showQcMarginPerspective: false` for the perspective canvas) removes/hides it; an active `Animal` cuboid creates none.
- [ ] **Step 2: Run** `npx vitest run tests/integration/runtime-bridge.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** the wiring above; verify in code that the render listener is invoked for the perspective canvas (it is: `trackGhosts.render` runs before the ortho check) and that `getOptionsReadonly()` is not copied per frame.
- [ ] **Step 4: Run** `npx vitest run` — Expected: all suites PASS (including the unchanged base-guide tests).
- [ ] **Step 5: Commit** `feat(qc): draw margin shells for the active object`

### Task 5: Docs, checks, build, manual check

**Files:**
- Modify: `README.md` (feature list / Workspace options), `docs/ui-guide.md` if it lists Workspace toggles.

- [ ] **Step 1: Document** the three toggles, the ratios per label, and the "size × (1 ± ratio)" rule.
- [ ] **Step 2: Run** `npm run typecheck && npm run lint && npm run format:check && npm test && npm run test:security` — Expected: all pass; run `npm run format` if only formatting fails.
- [ ] **Step 3: Run** `npm run build` (and the Firefox build script from `package.json` if present) to regenerate tracked `dist*` bundles. Expected: build succeeds.
- [ ] **Step 4: Manual check** on an authorized CVAT 3D job (load `dist/` unpacked): activate a `vehicles` box → orange/blue bands in main 3D and Top/Side/Front; `two-wheels` and `pedestrian` use wider bands; `Animal`/`Obstacle` show nothing; each toggle hides the right views; dragging the box and orbiting the camera stays smooth.
- [ ] **Step 5: Commit** `docs(qc): document margin overlay` (do not commit `dist*` unless the user asks).
