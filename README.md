# Meow — CVAT 3D Enhancer

![Biểu tượng Meow](public/assets/meow-128.png)

Meow là tiện ích trình duyệt Manifest V3 hỗ trợ thao tác và kiểm tra nhãn 3D trong CVAT. Công cụ bổ sung các điều khiển cho cuboid ngay trong workspace CVAT; point cloud được giữ nguyên hiển thị gốc của CVAT.

- **Trình duyệt:** Chrome hoặc Brave hỗ trợ Manifest V3; manifest yêu cầu Chrome 114 trở lên.
- **Môi trường:** job annotation 3D trên CVAT. Các bản CVAT tự tùy chỉnh có thể khác về giao diện và API nội bộ.
- **Phát hành hiện tại:** [GitHub Releases](https://github.com/truyen2903/cvat-3d-enhancer/releases/latest).

> Kho GitHub hiện có thể yêu cầu quyền truy cập. Nếu không mở được trang release, hãy nhờ người quản lý kho cấp quyền hoặc gửi trực tiếp file ZIP đã đóng gói.

## Cài đặt nhanh

Người dùng thông thường **không cần cài Node.js hoặc tự build**.

1. Mở [bản phát hành mới nhất](https://github.com/truyen2903/cvat-3d-enhancer/releases/latest), tải file `meow-vX.Y.Z.zip` trong mục **Assets**. Không cần tải file “Source code”.
2. Giải nén ZIP. Đặt thư mục `meow` ở vị trí cố định; thư mục này phải chứa `manifest.json`.
3. Mở `chrome://extensions` trên Chrome hoặc `brave://extensions` trên Brave.
4. Bật **Developer mode** / **Chế độ dành cho nhà phát triển**.
5. Chọn **Load unpacked** / **Tải tiện ích đã giải nén**, sau đó chọn thư mục `meow` vừa giải nén.
6. Mở CVAT và vào một job 3D. Với domain CVAT riêng của công ty, làm thêm bước kích hoạt domain bên dưới.
7. Trong CVAT, mở **Settings → Workspace → Meow** để bật hoặc tắt các tính năng của Meow.

ZIP có kèm `INSTALL.txt` với hướng dẫn tiếng Việt và tiếng Anh. File `.sha256` trong release dùng để kiểm tra tính toàn vẹn của ZIP.

### Kích hoạt domain CVAT riêng

Extension có cấu hình sẵn cho `https://*.cvat.ai`, `http://localhost` và `http://127.0.0.1`. Với domain CVAT khác:

1. Mở tab CVAT muốn sử dụng, sau đó mở popup **Meow** trên thanh công cụ trình duyệt.
2. Nhập URL hoặc domain CVAT vào ô **Add private CVAT domain / link**.
3. Chọn **Add & Activate Link**, chấp nhận yêu cầu cấp quyền truy cập domain của trình duyệt.
4. Tải lại tab CVAT nếu các điều khiển chưa xuất hiện.

Chỉ cấp quyền cho domain bạn được phép sử dụng. Nếu máy thuộc công ty, chính sách trình duyệt của tổ chức có thể ảnh hưởng đến việc cài extension hoặc cấp quyền.

### Cập nhật phiên bản

1. Tải và giải nén ZIP mới nhất từ GitHub Releases.
2. Thay nội dung trong thư mục `meow` **đã nạp** bằng nội dung bản mới; giữ nguyên đường dẫn thư mục.
3. Mở trang Extensions, bấm **Reload** tại Meow, sau đó tải lại tab CVAT.

Bản **Load unpacked** cần cập nhật thủ công theo các bước trên. Quy trình GitHub Release hiện tại không tự cài bản mới vào trình duyệt.

## Sử dụng trong job 3D

### Đồng bộ kích thước và đổi hướng

Trên thẻ **CUBOID TRACK**, Meow thêm một hàng gọn: **[H W L] [↻ 180°] [⋯]**. Di chuột lên nút để xem chi tiết. **↻** là lật 180°; các thao tác ít dùng nằm trong **⋯**:

| Nút                 | Chức năng                                                                                                                         |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| **H**               | Đồng bộ chiều cao, dịch tâm Z để giữ nguyên mặt đáy từng keyframe.                                                                |
| **W**               | Đồng bộ chiều rộng.                                                                                                               |
| **L**               | Đồng bộ chiều dài.                                                                                                                |
| **180°**            | Click: lật yaw 180° frame hiện tại. **Shift+click**: mọi keyframe của track.                                                      |
| **⋯ → Đổi L↔W**     | Click: đổi L/W và cộng yaw 90° frame hiện tại, giữ cùng hộp vật lý (Euler XYZ). **Shift+click**: mọi keyframe.                    |
| **⋯ → Nội suy yaw** | Nội suy riêng yaw giữa hai keyframe bao quanh frame hiện tại. **Shift+click**: chọn hai keyframe đầu/cuối trong popover cạnh nút. |
| **⋯ → Thuộc tính**  | Chọn một thuộc tính mutable, rồi **Áp dụng toàn track** để dùng giá trị frame hiện tại tại mọi keyframe.                          |

Mục **⋯ → ride_state** (RS) áp dụng giá trị `ride_state` hiện tại (bật hoặc tắt) cho mọi frame của cùng track. Nút chỉ hiện khi nhãn có thuộc tính `ride_state` thay đổi theo frame. Thao tác chỉ sửa thuộc tính này tại các keyframe, giữ nguyên hình học và các thuộc tính khác; sau đó dùng **Save** của CVAT để lưu lên server.

**Thuộc tính** hỗ trợ mọi thuộc tính mutable của nhãn (`ride_state`, `sitting`, text, số, lựa chọn...), chỉ sửa thuộc tính được chọn, kể cả keyframe outside. Thuộc tính immutable không có trong danh sách. **ride_state** vẫn là lối tắt riêng cho checkbox `ride_state`.

**Yaw** dùng đường góc ngắn nhất, chuẩn hóa yaw về [0, 2π). Chỉ các frame ở giữa trở thành keyframe mới, giữ nguyên tâm, kích thước, rx/ry và thuộc tính theo snapshot nội suy sẵn của CVAT; hai đầu giữ nguyên. Từ chối khoảng có frame outside, thiếu hai keyframe biên, hoặc dài hơn 10.000 frame. Sau thao tác, toast báo số frame đã cập nhật. Nội suy riêng yaw có thể tạo nhiều keyframe và làm thay đổi cách nội suy về sau; kiểm tra trước khi Save.

Lật toàn track và đổi L/W chỉ sửa các keyframe hiện có, kể cả outside, không lọc theo thuộc tính. Mọi thao tác chỉ thay đổi dữ liệu trong trình duyệt; dùng **Save** của CVAT như thường lệ. Không gộp thành một bước Undo chung: mỗi lần ghi dùng lịch sử native của CVAT.

H/W/L dùng giá trị của frame hiện tại. Theo mặc định, các keyframe được đồng bộ khi thuộc tính trùng khớp; mã nguồn có xử lý riêng cho nhãn **two-wheels** đối với H và L. Các nút được vô hiệu hóa khi object bị khóa. Nếu thao tác không thực hiện được, di chuột lên nút để xem thông báo trong tooltip.

Kết quả phụ thuộc ObjectState và API track của bản CVAT đang chạy. Với CVAT được tùy chỉnh, hãy kiểm tra kết quả trên job được phép sử dụng trước khi áp dụng rộng rãi.

### Ghost box của track

Chọn cuboid track rồi **giữ Alt+G** trong view 3D chính: Meow vẽ wireframe tại các keyframe đã có trong trình duyệt và đường nối tâm theo thứ tự frame, có mũi tên chỉ chiều thời gian. Màu **xanh lam** là quá khứ, **hồng** là tương lai, **vàng** đánh dấu frame hiện tại. Không tải annotation từ server, không vẽ thêm mọi frame nội suy; bỏ qua các keyframe outside. Đường nối chỉ biểu diễn thứ tự các tâm hiển thị, không phải quỹ đạo nội suy chính xác, kể cả khi đi qua khoảng outside.

Overlay tự mất khi thả G hoặc Alt, mất focus, đổi object/frame, hoặc tắt **Bóng track · Alt+G** trong Workspace (mặc định bật). Không nhận hotkey trong ô nhập liệu. Hình học và bộ đệm chiếu được tạo một lần khi nhấn, dùng lại khi camera render; không đọc track hay cấp phát hình học mỗi tick. Overlay nằm trên WebGL nên không bị point cloud che khuất. Alt+G không trùng các phím Meow hiện có; phím tắt CVAT tùy chỉnh/hệ điều hành vẫn cần kiểm tra trên máy thực tế.

### Chọn nhiều box trên canvas 3D (chỉ frame hiện tại)

Bật bằng **Chọn nhiều box · Shift** trong Workspace (mặc định bật). Các thao tác mặc định ghi vào **frame đang mở**. Nhóm **Theo gốc** có thêm lựa chọn **→ cuối track** và **mọi frame** với phạm vi ghi nêu rõ trong menu. Chỉ hoạt động trong **view 3D Perspective chính**: ở Top, Side, Front và các view ortho đang phóng to/maximize, Shift+click/kéo hoàn toàn thuộc về CVAT (Meow không can thiệp).

| Thao tác                                           | Kết quả                                                                                                                                                                |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Click thường                                       | CVAT chọn **gốc** (object active, vẫn dùng highlight và thẻ sidebar của CVAT).                                                                                         |
| **Shift+click** box khác (chỉ view 3D Perspective) | Box đó thành **đích**, tô màu vàng. CVAT không chọn lại box này. Shift+click lần nữa để bỏ đích; Shift+click box khác sẽ thay đích (tối đa 2).                         |
| **Shift+kéo chuột trái**                           | Vẽ khung chọn; khi thả, chọn **mọi object** có **tâm** nằm trong khung, kể cả object **outside** và object đang **bị filter ẩn**. Camera không xoay. Kéo tiếp để thêm. |
| **Shift+Alt+kéo** (hoặc Shift+Alt+click)           | Bỏ các box trong khung (hoặc box dưới con trỏ) khỏi vùng chọn.                                                                                                         |
| **Chuột phải** trong vùng chọn                     | Mở menu Meow thay cho menu của CVAT. Chuột phải ngoài vùng chọn, hoặc kéo camera bằng chuột phải, giữ nguyên hành vi CVAT.                                             |
| **Esc**, đổi frame, click thường object khác       | Xóa vùng chọn.                                                                                                                                                         |

Thanh công cụ dạng pill chỉ xuất hiện khi có vùng chọn: **số lượng · Tráo · Chỉ cụm · Ẩn · ⋯ · ✕** (nút không áp dụng sẽ ẩn). **⋯** mở cùng menu với chuột phải, chia nhóm **Cặp / Lọc / Hiển thị / Theo gốc / Khác**. Esc đóng menu trước; Esc lần nữa bỏ chọn. Toast nằm ở góc dưới phải, tối đa 3 thông báo, tự tắt; lỗi lưu lâu hơn. Di chuột để xem nội dung đầy đủ.

Menu khi có **gốc + 1 đích**:

- **Tráo**: đổi x, y, z, rx, ry, rz, L, W, H giữa hai box.
- **Tráo + attribute**: thêm các attribute **mutable** (theo frame) và occluded. Attribute immutable (cấp track) không bao giờ bị đổi. Nếu hai box khác label, Meow chỉ tráo hình học và báo trong toast.
- **Gốc → đích**: đích nhận L/W/H, attribute mutable và occluded của gốc; **không** đổi vị trí hay yaw. Khác label thì chỉ đồng bộ kích thước + occluded.

Menu khi có **cụm** (chọn bằng khung):

- **Thêm vào filter**, **Chỉ cụm này**: ghi thẳng vào **filter thật của CVAT** dưới dạng nhóm `ObjectID == …` nối bằng OR, đúng định dạng hộp thoại Filter của CVAT tạo ra, nên mở **Filter** của CVAT sẽ thấy và sửa được. Thêm nhiều lần vẫn gộp vào một nhóm OR, không trùng ID. Cụm gồm cả object outside / đang bị lọc nên lọc theo cụm giữ được cả các xe đang ẩn. **Trả về filter** khôi phục filter CVAT trước đó (tối đa 10 bước). Khi filter do Meow áp vẫn đang dùng, **object mới tạo** (vẽ mới, dán) được tự thêm ID vào filter nên không bị ẩn ngay sau khi vẽ; nếu bạn tự sửa filter trong CVAT thì Meow thôi tự thêm.
- **Ẩn / Hiện**: dùng cờ `hidden` của CVAT (biểu tượng con mắt ở sidebar).
- **Ghim đáy · frame này**: gốc là object đang active. Mỗi box khác giữ nguyên H và có `z = đáy_gốc + H/2`.
- **Ghim đáy · → cuối track**: ghim như trên tại frame hiện tại và tại **mọi keyframe sau đó** của gốc hoặc của box (đáy gốc đọc đúng tại từng frame), nên các frame nội suy ở giữa cũng nằm trên đáy gốc. Frame f−1 được giữ nguyên để các frame trước không đổi. Frame nào gốc outside thì giữ nguyên.
- **Kích thước · frame này**: box cùng label nhận L/W/H của gốc nhưng giữ đáy cũ (chỉnh z); box khác label bị bỏ qua và được đếm trong toast.
- **Kích thước · mọi frame**: như trên nhưng áp cho **mọi keyframe** của track (kích thước lấy từ gốc ở frame hiện tại, mỗi keyframe giữ đáy của chính nó). Không tạo keyframe mới.
- **Đặt theo mốc tĩnh**: dùng cho dữ liệu LiDAR tính theo xe (ego), khi hai vật **đứng yên** giữ nguyên vị trí tương đối với nhau. Click vật mốc B (đã label chuẩn, là **keyframe** ở frame này), Shift+click một hoặc nhiều vật A đang khó thấy. Với mỗi A, Meow tìm frame K gần nhất mà A và B cùng là keyframe không outside, rồi đặt A sao cho vị trí, góc yaw và độ cao tương đối với B giống hệt ở frame K (A giữ L/W/H, rx, ry của frame K). Chỉ ghi frame hiện tại, frame f−1/f+1 được giữ nguyên, **một lần Ctrl+Z** hoàn tác. Từ chối khi kích thước B lệch quá 10% hoặc yaw B đổi quá 135° so với frame K (có thể B bị lật hướng). Chỉ hỗ trợ **track**. Sai số tăng theo khoảng cách A–B: toast báo mức lệch nếu yaw của B sai 1° (A cách 30 m thì khoảng 0,5 m), nên chọn mốc gần.
- Hai thao tác nhiều frame ghi mỗi frame là **một bước Ctrl+Z**; toast cho biết cần bấm bao nhiêu lần. Giới hạn 2.000 frame mỗi thao tác.
- **Thêm xung quanh**: thêm các object (kể cả object đang bị filter ẩn) có tâm nằm quanh vùng chọn trên màn hình, đọc từ dữ liệu annotation đã có trong trình duyệt, không gọi server. Nếu không đọc được dữ liệu chưa lọc, Meow chỉ lấy các object đang hiển thị và nói rõ trong toast.
- **Đặt làm gốc**: chuột phải đúng box đã chọn rồi chọn mục này để làm object active.

Với track, ghi tại frame f biến f thành keyframe. Để các frame lân cận không bị lệch, Meow đặt **keyframe giữ nguyên giá trị** tại f−1 và f+1 nếu hai frame đó đang được nội suy (nằm trong track, không outside); các keyframe ghim này được ghi khi tạm đóng băng lịch sử nên không tạo bước undo, và vẫn ở lại sau khi undo (đúng giá trị nội suy cũ nên hình học track không đổi).

**Mỗi thao tác Meow là đúng một bước Ctrl+Z.** Meow ghi qua `job.annotations.saveStates` của CVAT (cùng cơ chế CVAT dùng khi di chuyển nhiều object đã chọn): tráo, đồng bộ, ghim đáy, ẩn/hiện nhiều object được hoàn tác / làm lại bằng **một** lần Ctrl+Z / Ctrl+Shift+Z hoặc nút Undo/Redo. Ghi thất bại giữa chừng thì CVAT hoàn lại tất cả. Với bản CVAT cũ chưa có `saveStates`, Meow quay về ghi từng object và toast cho biết cần Ctrl+Z bao nhiêu lần.

Quy tắc an toàn: thao tác cặp (tráo / đồng bộ gốc → đích) là **tất cả hoặc không gì cả**: nếu một trong hai object bị khóa, outside hoặc không ghi được thì từ chối và toast, không ghi gì. Thao tác cụm bỏ qua object bị khóa/outside và đếm trong toast. Không sửa trong workspace Review. Nếu bạn đổi frame trong lúc Meow đang xử lý, thao tác bị hủy. Khi CVAT đang vẽ/gộp/tách/nhóm, Shift+click/kéo và menu chuột phải của Meow tạm tắt. Lọc cụm không dùng được khi đang hiện Ground truth. Dùng **Save** của CVAT để lưu lên server.

### Chỉnh cuboid bằng bàn phím

Chọn object, đưa chuột vào vùng **Top**, **Side** hoặc **Front**, rồi sử dụng:

| Phím                  | Thao tác theo hướng nhìn trên màn hình   |
| --------------------- | ---------------------------------------- |
| **W / S**             | Di chuyển lên / xuống.                   |
| **A / D**             | Di chuyển trái / phải.                   |
| **Q / E**             | Xoay ngược / cùng chiều quanh trục nhìn. |
| **Shift + phím trên** | Bước di chuyển hoặc xoay lớn gấp 4 lần.  |

Khi bật độ nhạy tăng, bước mặc định là **2,5 pixel màn hình** và **0,4°** mỗi lần nhấn; khi tắt là **1,25 pixel** và **0,2°**. Nếu không đọc được camera, bước di chuyển dự phòng là **0,025 m**, hoặc một nửa khi tắt độ nhạy tăng. Box được xem trước khi nhấn phím; tùy chọn lưu ngay sẽ commit khi thả phím. Các phím có modifier Ctrl/Alt/Meta và ô nhập văn bản được để cho CVAT/trình duyệt xử lý.

Có thể kéo cạnh của cuboid trong các góc nhìn trực giao để chỉnh một trục kích thước; vùng sát góc vẫn dành cho các tay nắm gốc của CVAT.

### Focus và tia căn đáy

- **Double-click** nền thẻ object để chọn và focus object. Tùy chọn Workspace có thể bỏ Quick filter tự động của bản CVAT tùy chỉnh, đồng thời giữ thao tác focus. Nếu không tìm được thao tác focus gốc, extension giữ hành vi double-click của CVAT.
- **Tia đỏ căn đáy** (bật/tắt nhanh bằng **Alt+[**) xuất hiện trong Side/Front tại lát thấp nhất của cuboid đang chọn, kể cả ô nhỏ. Tia là lớp hiển thị, không chỉnh hình học annotation.
- **Giữ object trên màn hình khi chuyển frame**: camera được dịch theo thay đổi vị trí của object đang chọn, khi runtime cung cấp thông tin camera và frame phù hợp. Việc chỉnh box trong cùng frame không chủ động kéo camera theo box.

### QC vùng đệm P

Khi một object **vehicles**, **two-wheels** hoặc **pedestrian** đang được chọn, Meow tô hai lớp trong suốt quanh cuboid của CVAT để người kiểm tra xem box ôm point quá rộng hay quá chật:

- **Lớp ngoài (cam)**: mỗi mặt của box nở ra đúng tỉ lệ × kích thước theo trục đó, ở cả 6 hướng. Point lọt ra ngoài lớp này nghĩa là box quá chật.
- **Lớp trong (xanh)**: mỗi mặt của box lùi vào cùng khoảng đó. Nếu không có point nào chạm tới lớp này, box quá rộng.
- Tỉ lệ theo nhãn: **vehicles 5%**, **two-wheels 8%**, **pedestrian 10%**. Các nhãn khác (Animal, Obstacle…) không vẽ gì.

Nhấn **Alt+P** để bật/tắt nhanh (cùng công tắc với Workspace, có toast báo trạng thái; không nhận phím khi đang gõ trong ô nhập liệu). Hiện ở 3D chính và Top/Side/Front; mỗi nơi có công tắc riêng trong Workspace. Overlay chỉ là lớp hiển thị, không ghi vào annotation, không quét point cloud và chỉ vẽ lại khi box, nhãn, camera hoặc kích thước khung thay đổi.

## Các tùy chọn trong Settings → Workspace

Mở mục thu gọn **Meow** trong Workspace để xem đủ 14 tùy chọn. Mô tả ngắn nằm dưới mỗi mục; di chuột để xem chi tiết.

| Nhóm       | Tùy chọn                         | Công dụng                                            |
| ---------- | -------------------------------- | ---------------------------------------------------- |
| Hiển thị   | Tia căn đáy box · Alt+[          | Tia đỏ ở Side/Front; Alt+[ bật/tắt nhanh.            |
| Hiển thị   | QC vùng đệm P · Alt+P            | Tô vùng đệm quanh box đang chọn (công tắc chính).    |
| Hiển thị   | QC vùng đệm ở 3D chính           | Hiện vùng đệm trong khung 3D chính.                  |
| Hiển thị   | QC vùng đệm ở Top / Side / Front | Hiện vùng đệm trong ba khung chiếu.                  |
| Hiển thị   | Bóng track · Alt+G               | Khung keyframe và đường đi khi giữ Alt+G.            |
| Chỉnh box  | Đồng bộ H / W / L                | Hiện nhóm kích thước và mục Thuộc tính trong ⋯.      |
| Chỉnh box  | Công cụ hướng box                | Hiện lật 180°, Đổi L↔W và Nội suy yaw.               |
| Chỉnh box  | Chỉnh bằng W / A / S / D / Q / E | Chỉnh box trong Top/Side/Front.                      |
| Chỉnh box  | Tăng độ nhạy phím ×2             | Tăng bước di chuyển và xoay.                         |
| Chỉnh box  | Lưu ngay khi nhả phím            | Tắt để chờ 250 ms không thao tác.                    |
| Điều hướng | Giữ box trên màn hình            | Bám camera theo box khi chuyển frame.                |
| Điều hướng | Nhấp đúp không lọc nhanh         | Giữ focus, bỏ Quick filter tự động.                  |
| Điều hướng | Chuyển frame bằng nút chuột      | Back lùi frame, Forward tiến frame.                  |
| Chọn nhiều | Chọn nhiều box · Shift           | Shift+click/kéo chọn cặp hoặc cụm trên canvas chính. |

Các tùy chọn được lưu trong cài đặt của CVAT trên trình duyệt và bản sao dự phòng của Meow. Các tính năng bổ sung gần đây mặc định bật để giữ hành vi hiện tại.

## Tương thích và giới hạn

Meow được phát triển dựa trên CVAT 3D và đã có tài liệu đối chiếu với CVAT **v2.81.0**. Kiểm tra phiên bản qua API không đảm bảo mọi bản CVAT tùy chỉnh hoạt động giống nhau: các tính năng sidebar, camera và đồng bộ track phụ thuộc các cấu trúc hoặc API runtime mà bản CVAT cung cấp.

Một số khả năng không có điều khiển chung được hỗ trợ trong Capability Registry, gồm chọn kích thước point tùy ý qua API công khai, shader màu theo độ cao/cường độ, lưới mặt đất 3D và bật/tắt trục tọa độ 3D.

Xem [tương thích và giới hạn](docs/compatibility.md) để biết cách hoạt động, các giả định và phạm vi kiểm tra.

## Xử lý sự cố

| Hiện tượng                      | Kiểm tra                                                                                                                               |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Không thấy Meow trên CVAT riêng | Kiểm tra extension đang bật; thêm đúng domain bằng **Add & Activate Link**, chấp nhận quyền rồi tải lại tab.                           |
| Không thấy các mục Workspace    | Mở một job 3D, mở lại **Settings → Workspace** và kiểm tra extension đã được kích hoạt trên domain.                                    |
| Không thấy nút H/W/L            | Bật tùy chọn trong Workspace; kiểm tra object là cuboid track và sidebar đã tải xong.                                                  |
| Bấm nút không thấy thay đổi     | Kiểm tra object không bị khóa, tooltip của nút và trạng thái/keyframe phù hợp; bản CVAT tùy chỉnh phải cung cấp API track tương thích. |
| Phím WASD/QE không phản hồi     | Bật tùy chọn bàn phím, chọn cuboid và đưa chuột vào Top/Side/Front; kiểm tra con trỏ không đang ở ô nhập.                              |
| Bản mới chưa xuất hiện          | Thay đúng thư mục đã nạp, bấm **Reload** trên trang Extensions rồi tải lại tab CVAT.                                                   |

## Dành cho người phát triển

### Cài đặt và chạy

```bash
npm ci
npm run dev
```

Build và tạo ZIP cài đặt:

```bash
npm run build
npm run package:release
```

`npm run build` kiểm tra TypeScript và tạo `dist/`. Lệnh đóng gói tạo `release/meow-vX.Y.Z.zip` cùng checksum SHA256; ZIP chứa thư mục `meow/` có thể nạp trực tiếp sau khi giải nén. Python 3 được dùng cho bước đóng gói. `dist/` là artifact production được theo dõi trong repo.

### Kiểm tra

```bash
npm run typecheck      # TypeScript strict
npm run lint           # ESLint
npm run format:check   # Prettier cho src và tests
npm test               # Vitest: unit, integration, compatibility, security
npm run test:security  # Security tests và static secret scanner
npm run build          # Build trước e2e
npm run test:e2e       # Playwright kiểm tra artifact đã build
```

Kiểm tra thay đổi tương tác trên job CVAT 3D mà bạn được phép sử dụng. Không đưa credential hoặc dữ liệu công ty vào source, test fixture hay bundle.

### Cấu trúc dự án

```text
src/entrypoints/       Background, content, page bridge và popup
src/core/              Lifecycle, event bus và command registry
src/features/          Các tính năng annotation, productivity, visualization
src/integration/cvat/  Adapter DOM, bridge, compatibility và runtime CVAT
src/infrastructure/    Browser, storage, messaging và authentication
src/ui/                React UI và trạng thái settings
src/shared/            Types, schemas và constants dùng chung
public/                Tài nguyên tĩnh
scripts/               Kiểm tra bảo mật và đóng gói release
tests/                 Unit, integration, compatibility, security và e2e
docs/                  Kiến trúc, tương thích, bảo mật và release notes
```

### Phát hành

Workflow **Release extension** trên GitHub Actions cài dependencies, chạy kiểm tra, build, đóng gói ZIP và SHA256, rồi xuất bản GitHub Release. Khi chuẩn bị phiên bản mới, cập nhật version đồng bộ trong `package.json`, `package-lock.json` và `manifest.config.ts`; thêm `docs/releases/vX.Y.Z.md`; sau đó đẩy tag tương ứng hoặc chạy workflow thủ công. Workflow dùng GitHub token của Actions.

## Bảo mật và tài liệu

- [Kiến trúc](docs/architecture.md) · [Tích hợp CVAT runtime](docs/runtime-integration.md) · [Cấu hình](docs/configuration-schema.md)
- [Tương thích và giới hạn](docs/compatibility.md) · [Threat model](docs/threat-model.md) · [Bảo mật](docs/security.md)
- [Chính sách báo lỗi bảo mật](SECURITY.md): báo riêng cho maintainer qua GitHub Private Vulnerability Reporting hoặc đầu mối an ninh của tổ chức.
