# Meow — CVAT 3D Enhancer

![Biểu tượng Meow](public/assets/meow-128.png)

Meow là tiện ích trình duyệt Manifest V3 hỗ trợ thao tác và kiểm tra nhãn 3D trong CVAT. Công cụ bổ sung các điều khiển cho cuboid, tùy chọn hiển thị point cloud và cảnh báo QA ngay trong workspace CVAT.

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
7. Trong CVAT, mở **Settings → Workspace** để bật hoặc tắt các tính năng của Meow.

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

Trên thẻ **CUBOID TRACK** ở sidebar, Meow thêm các nút:

| Nút      | Chức năng                                                           |
| -------- | ------------------------------------------------------------------- |
| **H**    | Đồng bộ chiều cao của cuboid sang các keyframe phù hợp trong track. |
| **W**    | Đồng bộ chiều rộng.                                                 |
| **L**    | Đồng bộ chiều dài.                                                  |
| **180°** | Đảo hướng yaw 180° trên frame hiện tại.                             |

H/W/L dùng giá trị của frame hiện tại. Theo mặc định, các keyframe được đồng bộ khi thuộc tính trùng khớp; mã nguồn có xử lý riêng cho nhãn **two-wheels** đối với H và L. Các nút được vô hiệu hóa khi object bị khóa. Nếu thao tác không thực hiện được, di chuột lên nút để xem thông báo trong tooltip.

Kết quả phụ thuộc ObjectState và API track của bản CVAT đang chạy. Với CVAT được tùy chỉnh, hãy kiểm tra kết quả trên job được phép sử dụng trước khi áp dụng rộng rãi.

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
- **Tia đỏ căn đáy** xuất hiện trong Side/Front tại lát thấp nhất của cuboid đang chọn, kể cả ô nhỏ. Tia là lớp hiển thị, không chỉnh hình học annotation.
- **Giữ object trên màn hình khi chuyển frame**: camera được dịch theo thay đổi vị trí của object đang chọn, khi runtime cung cấp thông tin camera và frame phù hợp. Việc chỉnh box trong cùng frame không chủ động kéo camera theo box.

### Point cloud và QA

- Tùy chọn **ẩn đất** chỉ lọc điểm mặt đất trong **Top**; 3D chính, Side và Front giữ đầy đủ điểm đất. Tắt tùy chọn để khôi phục điểm trong Top.
- Point ở khung 3D chính có thể được tăng **20%** so với kích thước gốc, vẫn thay đổi theo zoom. Tùy chọn riêng giữ point Top/Side/Front ở **3,5 px**.
- Có thể dùng nền trắng, chuyển các điểm ngoài box sang màu đen/trắng, hoặc tô màu điểm trong cuboid.
- Cảnh báo QA cho object đang chọn có thể hiển thị các nhóm kiểm tra kích thước, đồng bộ, độ cao, hướng, bước nhảy và độ khớp point cloud. Cảnh báo là thông tin hỗ trợ; cần kiểm tra lại trên dữ liệu và quy trình của dự án.

## Các tùy chọn trong Settings → Workspace

Meow thêm các checkbox vào tab Workspace của CVAT. Tên dưới đây khớp với giao diện hiện tại:

| Tùy chọn                                                | Công dụng                                                       |
| ------------------------------------------------------- | --------------------------------------------------------------- |
| White 3D canvas background                              | Dùng nền trắng cho viewport 3D.                                 |
| Solid black/white 3D points                             | Dùng màu đen/trắng cho điểm ngoài box thay vì màu cường độ gốc. |
| Color 3D points by bounding box                         | Tô điểm nằm trong cuboid.                                       |
| Hide ground points in Top view only                     | Chỉ ẩn điểm đất ở Top.                                          |
| Fixed 3.5px point size in Top/Side/Front views          | Giữ kích thước point cố định trong các góc nhìn trực giao.      |
| Keep active object fixed on screen when changing frames | Bám camera theo object đang chọn khi chuyển frame.              |
| Show QA warnings on 3D canvas for active object         | Bật cảnh báo QA cho object đang chọn.                           |
| Show cuboid base guide                                  | Hiện tia căn đáy ở Side/Front.                                  |
| Double-click focuses without Quick filter               | Giữ focus và bỏ Quick filter tự động khi double-click.          |
| Mouse side buttons: previous / next frame               | Nút hông Back lùi frame, Forward tiến frame trong job 3D.       |
| Show H/W/L dimension sync buttons                       | Hiện nút đồng bộ kích thước.                                    |
| Show 180° heading flip button                           | Hiện nút đảo hướng.                                             |
| Edit cuboids with W/A/S/D/Q/E                           | Bật chỉnh box bằng bàn phím trong Top/Side/Front.               |
| Double W/A/S/D/Q/E sensitivity                          | Dùng bước di chuyển và xoay lớn gấp đôi.                        |
| Save keyboard edits immediately on key release          | Lưu khi thả phím; khi tắt, chờ 250 ms không thao tác.           |
| Enlarge main 3D points by 20%                           | Tăng kích thước point của 3D chính, giữ tỷ lệ zoom.             |

Các tùy chọn được lưu trong cài đặt của CVAT trên trình duyệt và bản sao dự phòng của Meow. Các tính năng bổ sung gần đây mặc định bật để giữ hành vi hiện tại; nền trắng, tô màu point và ẩn đất mặc định tắt.

## Tương thích và giới hạn

Meow được phát triển dựa trên CVAT 3D và đã có tài liệu đối chiếu với CVAT **v2.81.0**. Kiểm tra phiên bản qua API không đảm bảo mọi bản CVAT tùy chỉnh hoạt động giống nhau: các tính năng sidebar, camera và đồng bộ track phụ thuộc các cấu trúc hoặc API runtime mà bản CVAT cung cấp.

Một số khả năng không có điều khiển chung được hỗ trợ trong Capability Registry, gồm chọn kích thước point tùy ý qua API công khai, shader màu theo độ cao/cường độ, lưới mặt đất 3D và bật/tắt trục tọa độ 3D. Các điều chỉnh point cố định/tăng 20% nêu trên là cơ chế tích hợp runtime riêng, không đồng nghĩa có bộ điều khiển kích thước tùy ý cho mọi bản CVAT.

Xem [tương thích và giới hạn](docs/compatibility.md) để biết cách hoạt động, các giả định và phạm vi kiểm tra.

## Xử lý sự cố

| Hiện tượng                      | Kiểm tra                                                                                                                               |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Không thấy Meow trên CVAT riêng | Kiểm tra extension đang bật; thêm đúng domain bằng **Add & Activate Link**, chấp nhận quyền rồi tải lại tab.                           |
| Không thấy các mục Workspace    | Mở một job 3D, mở lại **Settings → Workspace** và kiểm tra extension đã được kích hoạt trên domain.                                    |
| Không thấy nút H/W/L            | Bật tùy chọn trong Workspace; kiểm tra object là cuboid track và sidebar đã tải xong.                                                  |
| Bấm nút không thấy thay đổi     | Kiểm tra object không bị khóa, tooltip của nút và trạng thái/keyframe phù hợp; bản CVAT tùy chỉnh phải cung cấp API track tương thích. |
| Phím WASD/QE không phản hồi     | Bật tùy chọn bàn phím, chọn cuboid và đưa chuột vào Top/Side/Front; kiểm tra con trỏ không đang ở ô nhập.                              |
| Điểm đất vẫn hiện               | Kiểm tra tùy chọn ẩn đất đã bật và đang xem khung Top. Các khung còn lại được giữ nguyên.                                              |
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
