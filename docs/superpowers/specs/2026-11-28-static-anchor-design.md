# Đặt theo mốc tĩnh (static anchor) — design

Chốt trong chat ngày 2026-11-28. Quy mô: dự án nhỏ (3–4 task). Trạng thái: chờ duyệt.

## Mục đích

Dữ liệu LiDAR của job tính **theo xe (ego)**: mỗi frame cả cảnh tĩnh trượt và xoay theo
chuyển động của xe. Hai vật tĩnh A, B giữ nguyên vị trí _tương đối_ với nhau. Khi ở frame K cả A
và B đều rõ và đã label chuẩn, còn ở frame hiện tại chỉ B rõ, annotator muốn Meow tính ra hộp của
A từ hộp của B thay vì ước lượng bằng mắt trên đám điểm thưa.

## Mục tiêu

- Một thao tác mới trong menu chuột phải sẵn có của vùng chọn (nhóm **"Theo gốc"**):
  **"Đặt theo mốc tĩnh"** (id `place-by-anchor`).
- Cách chọn dùng lại cơ chế hiện có: click thường chọn B (object active = gốc), Shift+click /
  Shift+kéo marquee để chọn một hoặc nhiều A (đích). Chỉ trong view perspective chính.
- Với mỗi đích A, tự tìm frame tham chiếu K rồi tính pose của A ở frame hiện tại; ghi tất cả đích
  trong **một** bước Ctrl+Z.
- Toast báo kết quả: số object đã đặt, frame K đã dùng, sai số ước tính theo khoảng cách.

## Không làm (bản đầu)

- Không dùng nhiều mốc / least-squares (để bản 2; phần toán viết sao cho dùng lại được).
- Không lưu quan hệ qua các lần đổi frame, không áp cho dải nhiều frame.
- Không tạo object mới: A phải đang tồn tại và không outside ở frame hiện tại.
- Không thêm phím tắt, không thêm tuỳ chọn Workspace.
- Không đổi L/W/H, attribute, occluded, label của A ngoài phần hình học nêu dưới.

## Phản mục tiêu (coi như thất bại dù "chạy được")

- Làm méo các frame khác của track A (nội suy trước/sau phải giữ nguyên).
- Ghi một nửa khi có lỗi mà không báo; ghi khi đã đổi frame giữa chừng.
- Lặng lẽ đặt A sai 180° quanh B khi heading của B bị lật.
- Làm thay đổi hành vi của các mục menu, Shift+click, marquee, phím tắt hiện có.

## Ràng buộc

- Cuboid points: `[x, y, z, rx, ry, rz, L, W, H, …]`, xoay Euler XYZ như THREE.
- Ghi qua `writeStatesAtFrame` (saveStates transaction, ghim f±1 cho track, bỏ qua lock / outside /
  ground truth), làm mới Redux bằng `refreshCvatAnnotations` — tức là qua `MultiObjectRunner.commit`.
- Workspace Review bị chặn ghi (đã có sẵn trong `MultiObjectRunner.run`).
- Không quét server; chỉ đọc dữ liệu cvat-core trong bộ nhớ (`readFrameStates`, `trackKeyframes`).
- TypeScript strict, không `any`, Prettier của dự án, file kebab-case.

## Các cách đã cân nhắc

1. **Một mốc, tính trên frame hiện tại, không giữ state (đã chọn).** Khớp với việc vùng chọn bị
   xoá khi đổi frame; ít đụng code cũ nhất. Nhược: sai số tỷ lệ với khoảng cách A–B × sai yaw B.
2. Nhiều mốc, Kabsch 2D trên tâm các mốc. Chính xác hơn khi A xa, nhưng cần phân biệt mốc/đích
   trong vùng chọn (hiện chỉ có 1 gốc). Để bản 2.
3. Ghi nhớ quan hệ ở frame K rồi áp cho nhiều frame. Cần state sống qua đổi frame, nhiều bước
   undo, rủi ro tương tác cao nhất. Loại.

## Toán (module thuần, không DOM)

Ký hiệu: `p = points`, `ψ = p[5]`, `c = (p[0], p[1], p[2])`. Đầu vào: `B_K`, `A_K` (frame K),
`B_f` (frame hiện tại). Bản yaw-only (không khuếch đại nhiễu roll/pitch):

```
Δψ      = wrapPi(ψB_f − ψB_K)                         // ∈ (−π, π]
d       = (xA_K − xB_K, yA_K − yB_K)
xyA_f   = (xB_f, yB_f) + Rot(Δψ) · d
zA_f    = zA_K + (zB_f − zB_K)
rzA_f   = wrapYaw(ψA_K + Δψ)                          // [0, 2π) như track-editing
rx, ry  = của A_K;  L, W, H = của A_K;  phần đuôi p[9…] = của A ở frame hiện tại
```

Tương đương `A_f = (M_B_f · M_B_K⁻¹) · A_K` khi rx = ry = 0.

Sai số ước tính hiển thị: `|d| · sin(1°)` (mét, làm tròn 0,1) — nói rõ là "nếu yaw B lệch 1°".

Hàm thuần đề xuất (`src/integration/cvat/runtime/static-anchor.ts`):

- `predictFromAnchor(anchorRef, targetRef, anchorNow): number[] | null` — null khi đầu vào < 9 số,
  có số không hữu hạn, hoặc L/W/H ≤ 0.
- `checkAnchorConsistency(anchorRef, anchorNow): 'ok' | 'size-changed' | 'heading-flip'`
- `pickReferenceFrame(frame, anchorKeys, targetKeys): number | null`
- `anchorErrorAt1Deg(anchorRef, targetRef): number`

## Chọn frame tham chiếu K

- Keyframe của track lấy từ `__internal.export().shapes` (`frame`, `outside`).
- Ứng viên K: frame ≠ frame hiện tại, là keyframe **không outside** của _cả_ B và A.
- Chọn K gần frame hiện tại nhất; hoà thì lấy frame trước (nhỏ hơn).
- K tính riêng cho từng đích A (mỗi A có thể có K khác nhau). Toast ghi K; nhiều K thì ghi
  "frame 12, 30".
- Đọc pose ở K bằng `readFrameStates(job, K)` (cvat-core in-memory, cùng clientID với track).

## Điều kiện và kiểm tra (theo thứ tự, chặn sớm)

1. Có object active (B) — nếu không: toast "Chọn object mốc bằng click hoặc Đặt làm gốc."
2. B là track cuboid, **là keyframe ở frame hiện tại** và không outside — nếu không: "Hãy label
   mốc ở frame này trước (cần keyframe)". Lý do: B nội suy thì kết quả chỉ lặp lại nội suy.
3. Mỗi đích A: phải là track cuboid, có ở frame hiện tại, không outside, không khoá. A không phải
   track → bỏ qua, đếm "không phải track".
4. Không có K cho A → bỏ qua, đếm "chưa có frame chung với mốc".
5. Kiểm tra mốc B giữa K và frame hiện tại (theo từng K):
   - Kích thước: lệch tương đối > 10% ở bất kỳ trục nào → `size-changed`.
   - Heading: `|Δψ| > 135°` → `heading-flip`.
     Một trong hai xảy ra → **không ghi đích nào dùng K đó**, toast lỗi nói rõ lý do.
6. Đã đổi frame/job trong lúc đọc (`isCurrent`) → huỷ, chưa ghi.

## Ghi

- Tất cả đích hợp lệ → một danh sách `StateWrite { state: A_f, points }`, gọi `commit(writes, false)`
  (không strict: đích lỗi bị bỏ, đích tốt vẫn được ghi, toast liệt kê).
- `writeStatesAtFrame` ghim f−1/f+1 của A khi đang nội suy, nên các frame khác của A không đổi; frame
  hiện tại của A trở thành keyframe.
- Một bước Ctrl+Z (`saveStates`); CVAT cũ không có `saveStates` → báo số lần Ctrl+Z như các thao
  tác khác.
- `afterWrite` đã có sẵn: xoá cache cảnh, vẽ lại ghost / viền QC / tia đáy.

## UI / UX

- `MultiActionId` thêm `'place-by-anchor'`; `MULTI_ACTIONS` thêm
  `{ id: 'place-by-anchor', label: 'Đặt theo mốc tĩnh', scope: 'cluster' }`.
- `availableActions`: hiện khi `hasSource` (giống pin-bottom).
- Menu `canvas-selection.ts`: thêm vào cuối nhóm "Theo gốc"; `title` = "Tính vị trí đích từ mốc
  (object gốc) theo frame cả hai cùng được label". Không thêm vào toolbar nhanh.
- Toast thành công: `Đã đặt 2 object theo mốc #15 (frame 12; sai ~0,5 m nếu yaw mốc lệch 1°)`.
- Toast khi bỏ qua: nối thêm `bỏ qua 1 object không phải track, 1 object chưa có frame chung với mốc`.

## Ảnh hưởng tới chức năng có sẵn

| Chỗ                                    | Thay đổi                                    | Rủi ro / cách giữ an toàn                                                |
| -------------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------ |
| `multi-object-actions.ts`              | thêm id, def, nhánh `dispatch`, `runAnchor` | union mở rộng → `switch` có `default`; test availability cũ phải vẫn qua |
| `canvas-selection.ts`                  | thêm id vào nhóm "Theo gốc"                 | test nhóm menu (`Cặp…Khác`) không đổi tên nhóm                           |
| `cvat-annotation-write.ts`             | không đổi                                   | —                                                                        |
| `track-editing.ts`                     | chỉ import `trackKeyframes`, `wrapYaw`      | —                                                                        |
| page-bridge, hotkey, Workspace options | không đổi                                   | —                                                                        |

## Phần để người làm quyết

- Tên biến, cách tách hàm phụ trong `runAnchor`.
- Thông điệp toast chi tiết (giữ giọng văn tiếng Việt như các toast khác).

## Các quyết định của mình (chưa được bạn xác nhận riêng)

- Ngưỡng 10% kích thước và 135° heading.
- B bắt buộc là keyframe ở frame hiện tại.
- K hoà thì lấy frame trước; K tính riêng cho từng A.
- A giữ rx/ry/L/W/H của frame K (không lấy của frame hiện tại).
- Không phím tắt, không tuỳ chọn bật/tắt.
- Shape (không phải track) không được hỗ trợ ở bản đầu.
