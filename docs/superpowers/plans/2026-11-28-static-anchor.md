# Đặt theo mốc tĩnh — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Thêm thao tác menu chuột phải "Đặt theo mốc tĩnh". Thao tác này tính pose của các đích A ở frame hiện tại từ mốc B (object active), dựa trên frame K mà cả hai cùng được label, trong dữ liệu LiDAR tính theo xe (ego).

**Architecture:** Module toán thuần `static-anchor.ts` gồm: dự đoán yaw-only, kiểm tra mốc, chọn frame K. `MultiObjectRunner` thêm nhánh `place-by-anchor`: đọc pose ở K bằng `readFrameStates`, rồi ghi qua `commit` có sẵn (saveStates, ghim f±1, 1 lần Ctrl+Z). `canvas-selection.ts` chỉ thêm mục vào nhóm "Theo gốc".

**Tech Stack:** TypeScript strict, Vitest + jsdom, runtime không dùng React trong `src/integration/cvat/runtime/`.

**Spec:** `docs/superpowers/specs/2026-11-28-static-anchor-design.md`

## Global Constraints

- Cuboid points `[x, y, z, rx, ry, rz, L, W, H, …]`; công thức yaw-only đúng như mục "Toán" của spec.
- Ngưỡng: kích thước mốc lệch tương đối **> 0.10** ở trục bất kỳ → `size-changed`; `|Δψ| > 135°` (`3π/4`) → `heading-flip`.
- K: keyframe không outside, chung của mốc và đích, khác frame hiện tại, gần nhất; nếu cách đều thì lấy frame nhỏ hơn; tính riêng cho từng đích.
- Mốc phải là track cuboid, là keyframe ở frame hiện tại và không outside. Đích phải là track cuboid.
- A giữ `rx, ry, L, W, H` của frame K; phần `points[9…]` lấy của A ở frame hiện tại.
- Chỉ ghi qua `MultiObjectRunner.commit(writes, false)`. Không gọi `save()` trực tiếp, không quét server.
- Không thêm phím tắt hay tuỳ chọn Workspace; không đổi `page-bridge.ts`, `cvat-annotation-write.ts`.
- Prettier: 2 spaces, single quotes, semicolons, 100 cols; cấm `any`; file kebab-case; chuỗi UI bằng tiếng Việt.

## Review Focus

- Yaw quấn qua 0/2π (ψB_K = 6.2, ψB_f = 0.1) phải ra Δψ ≈ +0.183, không phải −6.1 (Task 1).
- Đích chính là mốc (selection chỉ có B) → không ghi gì, toast "Chưa chọn object đích" (Task 2).
- Đổi frame trong lúc đang đọc frame K → huỷ, không ghi, toast `ABORTED` (Task 2).
- Hai đích có K khác nhau, trong đó một K bị `heading-flip` → chỉ ghi đích có K hợp lệ, toast nêu lý do (Task 2).
- Sau khi ghi, frame f−1 và f+1 của track A giữ nguyên giá trị nội suy cũ, và chỉ cần 1 lần Ctrl+Z để trả A về như cũ (Task 2).

---

### Task 1: Module toán mốc tĩnh

**Files:**

- Create: `src/integration/cvat/runtime/static-anchor.ts`
- Test: `tests/unit/static-anchor.test.ts`

**Interfaces:**

- Consumes: `wrapYaw(radians): number` từ `./track-editing`; type `CvatObjectStateLike` từ `./pre-render-enhancer`.
- Produces:
  - `export const ANCHOR_SIZE_TOLERANCE = 0.1;` và `export const ANCHOR_MAX_YAW_DELTA = (3 * Math.PI) / 4;`
  - `export function predictFromAnchor(anchorRef: readonly number[], targetRef: readonly number[], anchorNow: readonly number[], targetNow: readonly number[]): number[] | null`: trả về mảng dài `targetNow.length`; null nếu mảng nào có ít hơn 9 phần tử, có giá trị không hữu hạn trong 9 phần tử đầu, hoặc L/W/H của `targetRef` ≤ 0.
  - `export type AnchorCheck = 'ok' | 'size-changed' | 'heading-flip';`
  - `export function checkAnchorConsistency(anchorRef: readonly number[], anchorNow: readonly number[]): AnchorCheck`: kiểm tra kích thước trước; lệch tương đối = `|now − ref| / ref`.
  - `export interface KeyShape { readonly frame: number; readonly outside?: boolean }`
  - `export function insideKeyframes(state: CvatObjectStateLike): number[] | null`: lấy từ `state.__internal?.export?.().shapes`, chỉ giữ `outside !== true`, sắp tăng dần. Trả null khi không phải track, không đọc được, hoặc có frame không phải safe integer ≥ 0.
  - `export function pickReferenceFrame(frame: number, anchorKeys: readonly number[], targetKeys: readonly number[]): number | null`
  - `export function anchorErrorAt1Deg(anchorRef: readonly number[], targetRef: readonly number[]): number`: `hypot(dx, dy) · sin(1°)`.

- [ ] **Step 1: Viết test thất bại** trong `tests/unit/static-anchor.test.ts`

```ts
const B_K = [10, 0, 0, 0, 0, 0, 4, 2, 1.5];
const A_K = [20, 0, 1, 0.01, 0.02, 0.3, 3, 1, 1];
const A_NOW = [0, 0, 0, 0, 0, 0, 9, 9, 9, 7, 8]; // tail 7, 8 must survive

it('returns the reference box when the anchor did not move', () => {
  const out = predictFromAnchor(B_K, A_K, B_K, A_NOW)!;
  expect(out.slice(0, 9).map((v) => +v.toFixed(9))).toEqual(A_K);
  expect(out.slice(9)).toEqual([7, 8]);
});
it('rotates the offset with the anchor yaw and shifts z with the anchor', () => {
  const bNow = [0, 0, 0.5, 0, 0, Math.PI / 2, 4, 2, 1.5];
  const out = predictFromAnchor(B_K, A_K, bNow, A_NOW)!;
  expect(out[0]).toBeCloseTo(0);
  expect(out[1]).toBeCloseTo(10);
  expect(out[2]).toBeCloseTo(1.5);
  expect(out[3]).toBe(0.01);
  expect(out[4]).toBe(0.02);
  expect(out[5]).toBeCloseTo(0.3 + Math.PI / 2);
  expect(out.slice(6, 9)).toEqual([3, 1, 1]);
});
it('takes the short way across the 0/2π seam', () => {
  const ref = [0, 0, 0, 0, 0, 6.2, 4, 2, 1.5];
  const now = [0, 0, 0, 0, 0, 0.1, 4, 2, 1.5];
  const out = predictFromAnchor(ref, [10, 0, 0, 0, 0, 0, 3, 1, 1], now, A_NOW)!;
  const d = 0.1 - 6.2 + 2 * Math.PI;
  expect(out[0]).toBeCloseTo(10 * Math.cos(d));
  expect(out[1]).toBeCloseTo(10 * Math.sin(d));
  expect(out[5]).toBeCloseTo(d);
});
it('rejects short, non-finite or zero-size input', () => {
  expect(predictFromAnchor(B_K.slice(0, 8), A_K, B_K, A_NOW)).toBeNull();
  expect(predictFromAnchor(B_K, [...A_K.slice(0, 6), 0, 1, 1], B_K, A_NOW)).toBeNull();
  expect(predictFromAnchor(B_K, A_K, [NaN, ...B_K.slice(1)], A_NOW)).toBeNull();
});
it('flags a resized or flipped anchor at the exact thresholds', () => {
  const size = (k: number) => [10, 0, 0, 0, 0, 0, 4 * k, 2, 1.5];
  expect(checkAnchorConsistency(B_K, size(1.09))).toBe('ok');
  expect(checkAnchorConsistency(B_K, size(1.11))).toBe('size-changed');
  const yaw = (deg: number) => [10, 0, 0, 0, 0, (deg * Math.PI) / 180, 4, 2, 1.5];
  expect(checkAnchorConsistency(B_K, yaw(134))).toBe('ok');
  expect(checkAnchorConsistency(B_K, yaw(136))).toBe('heading-flip');
  expect(checkAnchorConsistency(B_K, yaw(-136))).toBe('heading-flip');
});
it('picks the nearest common keyframe, earlier on ties, never the current frame', () => {
  expect(pickReferenceFrame(5, [1, 5, 9], [1, 5, 9])).toBe(1);
  expect(pickReferenceFrame(5, [2, 7], [2, 7, 8])).toBe(7);
  expect(pickReferenceFrame(5, [5], [5])).toBeNull();
  expect(pickReferenceFrame(5, [1], [2])).toBeNull();
});
it('reads only inside keyframes from the serialized track', () => {
  const state = {
    objectType: 'track',
    __internal: {
      export: () => ({ shapes: [{ frame: 9 }, { frame: 2, outside: true }, { frame: 4 }] }),
    },
  } as unknown as CvatObjectStateLike;
  expect(insideKeyframes(state)).toEqual([4, 9]);
  expect(insideKeyframes({ objectType: 'shape' })).toBeNull();
});
it('estimates the lever-arm error for a 1° yaw error', () => {
  expect(anchorErrorAt1Deg([0, 0, 0, 0, 0, 0, 1, 1, 1], [30, 0, 0, 0, 0, 0, 1, 1, 1])).toBeCloseTo(
    0.5236,
    3
  );
});
```

- [ ] **Step 2: Chạy** `npx vitest run tests/unit/static-anchor.test.ts`. Kỳ vọng: FAIL (module chưa có).
- [ ] **Step 3: Viết code** các export trên trong `static-anchor.ts`. Δψ = `wrapYaw(ψnow − ψref + π) − π`; `rz` kết quả = `wrapYaw(ψA_K + Δψ)`. Đầu file có comment ngắn mô tả công thức, kèm dòng tương đương `A_f = (M_B_f · M_B_K⁻¹) · A_K` khi rx = ry = 0.
- [ ] **Step 4: Chạy lại** cùng lệnh. Kỳ vọng: PASS. Sau đó chạy `npm run typecheck && npm run lint`. Kỳ vọng: không lỗi.
- [ ] **Step 5: Commit** `feat(anchor): add static anchor pose prediction math`

---

### Task 2: Runner `place-by-anchor`

**Files:**

- Modify: `src/integration/cvat/runtime/multi-object-actions.ts` (union `MultiActionId`, `MULTI_ACTIONS`, `availableActions`, `dispatch`, method mới `runAnchor`)
- Test: `tests/unit/multi-object-actions.test.ts` (dùng lại `createWorld`, `FakeObject`, `shapeish`, `makeRunner`)

**Interfaces:**

- Consumes: toàn bộ export của Task 1; `readFrameStates`, `this.resolveStates`, `this.commit`, `this.report`, `this.isCurrent`, `ABORTED` đã có trong file.
- Produces:
  - `MultiActionId` thêm `'place-by-anchor'`.
  - `MULTI_ACTIONS` thêm sau `'sync-size-track'`: `{ id: 'place-by-anchor', label: 'Đặt theo mốc tĩnh (tính đích từ mốc theo frame cả hai cùng được label)', scope: 'cluster' }`.
  - `availableActions` trả mục này khi `ctx.hasSource` (gộp vào nhánh của `pin-bottom`).
  - `private async runAnchor(selection: readonly number[], activeID: number | null): Promise<boolean>`.

- [ ] **Step 1: Viết test thất bại.** Thêm vào test availability có sẵn: `expect(ids(base)).not.toContain('place-by-anchor')` và `expect(ids({ ...base, hasSource: true })).toContain('place-by-anchor')`. Thêm `describe('place by static anchor', …)` dùng world như sau:

```ts
// anchor track 4: keyframes 2 and 5; target track 6: keyframes 2 and 9 (interpolated at 4..6)
function anchorWorld() {
  const w = createWorld({ frame: 5 });
  const b = new FakeObject(4, 'track', w.history, 0);
  b.shapes[2] = shapeish([10, 0, 0, 0, 0, 0, 4, 2, 1.5], {});
  b.shapes[5] = shapeish([0, 0, 0.5, 0, 0, Math.PI / 2, 4, 2, 1.5], {});
  const a = new FakeObject(6, 'track', w.history, 0);
  a.shapes[2] = shapeish([20, 0, 1, 0, 0, 0.3, 3, 1, 1], {});
  a.shapes[9] = shapeish([27, 0, 1, 0, 0, 0.3, 3, 1, 1], {});
  w.objects.set(4, b);
  w.objects.set(6, a);
  return { ...w, b, a };
}
```

Danh sách test (tên test: điều phải assert):

- `places the target from frame 2 and keeps neighbors`: chạy `runner.run('place-by-anchor', [4, 6], 4)` trả `true`. Sau đó `a.snapshot(5).points` bắt đầu bằng ≈ `[0, 10, 1.5, 0, 0, 0.3 + π/2, 3, 1, 1]`. `a.snapshot(4).points` và `a.snapshot(6).points` bằng giá trị đã chụp _trước khi_ chạy. Toast thành công chứa `'frame 2'` và `'#4'`.
- `is one native undo step`: sau khi chạy, gọi `w.nativeStep('undo')` một lần; `a.snapshot(5).points` quay về giá trị nội suy cũ, và `a.shapes` không còn key 5.
- `refuses when the anchor is not a keyframe here`: chạy với `w.frame.value = 4` (b nội suy) → trả `false`; `saveStates` không được gọi; toast lỗi chứa `'keyframe'`.
- `skips non-track and no-common-frame targets`: selection `[4, 6, 3, 2]`. Object 3 là shape. Object 2 không có keyframe chung với b ngoài frame hiện tại: t2 có keyframe 4, 5, 6, b có keyframe 2, 5. Kết quả: chỉ 6 được ghi; toast chứa `'không phải track'` và `'chưa có frame chung'`.
- `refuses a flipped anchor`: đặt `b.shapes[5].points[5] = Math.PI` (Δψ = 180°) → trả `false`; không ghi; toast chứa `'lật'`.
- `aborts when the frame changes while reading`: bọc `w.job.annotations.get` sao cho khi được gọi với frame 2 thì đặt `w.frame.value = 6` trước khi resolve → trả `false`; toast `'Đã đổi frame; hủy thao tác, chưa ghi.'`; `saveStates` không được gọi.
- `needs a target besides the anchor`: chạy `run('place-by-anchor', [4], 4)` → trả `false`, toast `'Chưa chọn object đích'`.

- [ ] **Step 2: Chạy** `npx vitest run tests/unit/multi-object-actions.test.ts`. Kỳ vọng: các test mới FAIL, test cũ PASS.
- [ ] **Step 3: Viết code `runAnchor`** theo đúng thứ tự kiểm tra trong mục "Điều kiện và kiểm tra" của spec:
  1. `activeID === null` → toast `'Chọn object mốc bằng click hoặc Đặt làm gốc.'`.
  2. Không có đích nào khác mốc → toast `'Chưa chọn object đích'`.
  3. `resolveStates([activeID, ...others])`; null → toast `ABORTED`.
  4. Mốc không phải track cuboid, `!keyframe`, hoặc `outside` → toast `'Hãy label mốc ở frame này trước (cần keyframe)'`.
  5. Với từng đích: `insideKeyframes`, rồi `pickReferenceFrame`. Gom đích theo K thành `Map<number, number[]>` và đếm `notTrack` / `noCommon`.
  6. Với mỗi K (sắp tăng dần): `readFrameStates(scope.job, K)`; sau mỗi lần `await` phải kiểm tra `this.isCurrent()`, không còn current thì toast `ABORTED` và return false. Kiểm tra `checkAnchorConsistency(B_K, B_now)`; nếu khác `'ok'` thì bỏ cả nhóm và ghi lý do (`'mốc đổi kích thước > 10% so với frame K'` / `'mốc có thể bị lật hướng (> 135°) so với frame K'`). Nếu hợp lệ: `predictFromAnchor`, đẩy `{ state: A_now, points }` vào danh sách ghi, và giữ `max(anchorErrorAt1Deg)`.
  7. Không có gì để ghi → toast lỗi gộp mọi lý do; return false.
  8. `commit(writes, false)`, rồi `report(summary, \`Đã đặt ${n} object theo mốc #${activeID} (frame ${Ks.join(', ')}; sai ~${err.toFixed(1).replace('.', ',')} m nếu yaw mốc lệch 1°)\`, notes)`. `notes`gồm`bỏ qua X object không phải track`, `Y object chưa có frame chung với mốc`, và các lý do K bị từ chối.
Trong `dispatch`thêm`case 'place-by-anchor': return this.runAnchor(selection, activeID);`. Vì `labelFor`trong`canvas-selection.ts`là`Record<MultiActionId, string>`, thêm ngay key `'place-by-anchor': 'Đặt theo mốc tĩnh'` để typecheck không đỏ (Task 3 mới đưa mục vào menu).
- [ ] **Step 4: Chạy** `npx vitest run tests/unit/multi-object-actions.test.ts && npm run typecheck && npm run lint`. Kỳ vọng: PASS.
- [ ] **Step 5: Commit** `feat(anchor): add place-by-anchor action to the multi-object runner`

---

### Task 3: Mục menu, docs và kiểm tra toàn bộ

**Files:**

- Modify: `src/integration/cvat/runtime/canvas-selection.ts` (`labelFor` ~dòng 541; nhóm `'Theo gốc'` trong `showMenu` ~dòng 688)
- Modify: `tests/unit/canvas-selection.test.ts`
- Modify: `README.md` (danh sách thao tác "Theo gốc", ~dòng 105), `docs/compatibility.md` (đoạn multi-object actions, ~dòng 221), `docs/ui-guide.md` (sơ đồ menu ~dòng 50)

**Interfaces:**

- Consumes: `'place-by-anchor'` và def của Task 2.
- Produces: nút menu `data-action="place-by-anchor"`, text `'Đặt theo mốc tĩnh'`, title = `def.label`.

- [ ] **Step 1: Viết test thất bại** trong `canvas-selection.test.ts`, đặt cạnh test `groups applicable menu actions…`: khi có active source và mở menu, `menu.querySelector('[data-action="place-by-anchor"]')` nằm trong group `aria-label="Theo gốc"`, là phần tử cuối của group đó, có `textContent` `'Đặt theo mốc tĩnh'`. Khi không có source thì mục này không xuất hiện. Thứ tự tên các nhóm vẫn là `['Cặp', 'Lọc', 'Hiển thị', 'Theo gốc', 'Khác']`. Toolbar nhanh không có `place-by-anchor`.
- [ ] **Step 2: Chạy** `npx vitest run tests/unit/canvas-selection.test.ts`. Kỳ vọng: FAIL.
- [ ] **Step 3: Viết code.** Thêm `'place-by-anchor'` vào cuối mảng của nhóm `'Theo gốc'` (key trong `labelFor` đã có từ Task 2). Docs: thêm một gạch đầu dòng vào README theo giọng văn của các dòng "Ghim đáy", nêu cách chọn (click mốc, Shift+click đích), cách chọn K, hai ngưỡng chặn, yêu cầu track, 1 lần Ctrl+Z và lưu ý sai số theo khoảng cách. Ghi tương tự vào `compatibility.md` (tiếng Anh, theo đoạn hiện có) và thêm một dòng vào sơ đồ `ui-guide.md`.
- [ ] **Step 4: Kiểm tra toàn bộ.** Chạy `npm run typecheck && npm run lint && npm run format:check && npm test && npm run test:security`. Kỳ vọng: tất cả PASS, số test cũ không giảm.
- [ ] **Step 5: Commit** `feat(anchor): add static anchor entry to the selection menu` (gồm menu, test và docs).
- [ ] **Step 6: Build bundle.** Chạy `npm run build:all && npm run test:e2e`. Kỳ vọng: PASS. Commit `build: regenerate Chrome and Firefox bundles` (gồm `dist/`, `dist-firefox/`).
- [ ] **Step 7: Kiểm tra tay trên CVAT 3D thật** (job được phép). Chọn mốc là keyframe ở frame f, Shift+click đích, chuột phải, chọn "Đặt theo mốc tĩnh". Kiểm tra: đích nằm đúng chỗ trên đám điểm; Ctrl+Z một lần trả về như cũ; f−1 và f+1 không đổi; Shift+click, marquee, các mục "Ghim đáy" / "Kích thước" và Alt+P / Alt+[ vẫn chạy như trước. Ghi kết quả vào mô tả PR.
