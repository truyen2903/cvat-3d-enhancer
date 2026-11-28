# Giao diện Meow trong CVAT 3D

Giao diện dùng lớp Ant Design của CVAT, màu theo theme và một stylesheet chung
`#meow-ui-style`. Không đổi option key, storage, hotkey hay action id.

## Thẻ object: trước → sau

```text
Trước: [H] [W] [L] [180°] [L↔W] [Yaw] [Attr] [RS]
       [select thuộc tính] [Áp dụng] [Hủy]  (kéo dài thẻ)

Sau:                         [H|W|L] [↻ 180°] [⋯]
                                         +-----------------------------+
                                         | Đổi L↔W       Shift: toàn track |
                                         | Nội suy yaw   Shift: chọn khoảng|
                                         | Thuộc tính    Toàn track       |
                                         | ride_state    Toàn track       |
                                         +-----------------------------+
       Popover cạnh ⋯: [thuộc tính v] [Áp dụng toàn track] [Hủy]
       hoặc:           [frame đầu v] [frame cuối v] [Nội suy yaw] [Hủy]
```

H/W/L vẫn đồng bộ kích thước; ↻ lật 180° ở frame hiện tại. Shift+click giữ nguyên
ý nghĩa từng thao tác: toàn track cho lật/đổi kích thước, chọn khoảng cho yaw.
Tooltip nói rõ phạm vi. `ride_state` chỉ có khi nhãn hỗ trợ. Thẻ khóa vô hiệu hóa nút.
Chỉ một menu sidebar được tạo và dùng lại, gắn nút theo viewport như trước.
Esc hoặc click ra ngoài đóng menu/popover; hủy popover không sửa dữ liệu.

## Chọn nhiều: trước → sau

```text
Trước: Meow · N object [Tráo hình học] [Tráo attribute] [Gốc→đích]
       [Lọc] [Ẩn] [Hành động v] [x]
       Menu: một danh sách dài, không nhóm

Sau:   ( 2 chọn | ⇄ Tráo | ▽ Chỉ cụm | Ẩn | ⋯ | × )
       Không chọn gì: không có thanh công cụ

       ⋯ / chuột phải trong vùng chọn:
       +--------------------------------+
       | Cặp                            |
       | Tráo / Tráo + thuộc tính / Gốc→đích |
       |--------------------------------|
       | Lọc                            |
       | Chỉ cụm / Thêm vào filter / Trả về filter |
       |--------------------------------|
       | Hiển thị                       |
       | Ẩn / Hiện                      |
       |--------------------------------|
       | Theo gốc                       |
       | Ghim đáy: frame này / → cuối track |
       | Kích thước: frame này / mọi frame |
       | Đặt theo mốc tĩnh              |
       |--------------------------------|
       | Khác                           |
       | Thêm xung quanh / Đặt làm gốc / Bỏ chọn |
       +--------------------------------+
```

Chỉ hiện hành động áp dụng được. “Đặt làm gốc” phụ thuộc vật thể dưới con trỏ;
“Trả về filter” cần lịch sử filter. Ba nút chính tối đa là Tráo, Chỉ cụm, Ẩn.
Khung kéo chọn có viền xanh CVAT nét đứt và nền nhạt. Highlight vật thể giữ nguyên.
Esc đóng menu trước, Esc lần nữa bỏ chọn. Toolbar mất khi bỏ chọn hoặc đổi frame.

## Thông báo: trước → sau

```text
Trước: góc dưới phải, tối đa 4 thẻ, nội dung dài xuống dòng
Sau:   góc dưới phải, tối đa 3 thẻ gọn:
                               [✓ #12: đồng bộ cao (H): 4 frame]
                               [i Chọn 2 vật thể]
```

Thông báo dài rút gọn một dòng; tooltip giữ đầy đủ nội dung. Thành công/thông tin tự
ẩn sau 2,2 giây, lỗi sau 5 giây; đang xử lý được cập nhật tại chỗ khi có kết quả.
Toast bị đẩy khỏi chồng không xuất hiện lại khi thao tác cũ kết thúc.

## Workspace: trước → sau

```text
Trước: 11 checkbox riêng lẻ, tiêu đề và mô tả tiếng Anh dài
Sau:   > Meow
       v Meow                         (khi mở)
         Hiển thị
           [x] Tia căn đáy box
           [x] Bóng track · Alt+G
         Chỉnh box
           [x] Đồng bộ H / W / L
           [x] Công cụ hướng box
           [x] Chỉnh bằng W / A / S / D / Q / E
           [x] Tăng độ nhạy phím ×2
           [x] Lưu ngay khi nhả phím
         Điều hướng
           [x] Giữ box trên màn hình
           [x] Nhấp đúp không lọc nhanh
           [x] Chuyển frame bằng nút chuột
         Chọn nhiều
           [x] Chọn nhiều box · Shift
```

Mỗi tùy chọn có mô tả ngắn màu dịu và tooltip. Mở/đóng section không thay đổi tùy chọn.
Tất cả 11 option giữ nguyên dữ liệu lưu và cách bật/tắt.

## Bóng track và tia căn đáy: trước → sau

```text
Trước: giữ Alt+G → khung keyframe + đường đi; Side/Front → tia đáy đỏ
Sau:   giữ Alt+G → khung keyframe + đường đi; Side/Front → tia đáy đỏ
       cùng stylesheet, không bắt chuột, không có bảng điều khiển thường trực
```

Giữ màu phân biệt của ghost và tia đỏ vì chúng là dấu hiệu hình học trên nền point
cloud; không thêm nền trắng. Chúng tiếp tục xuất hiện/mất theo hành vi cũ. Stylesheet,
menu và popover được dọn khi runtime dừng; không thêm công việc mỗi render frame.
