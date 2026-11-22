# BẢNG QUY CHUẨN KÍCH THƯỚC BOUNDING BOX 3D

Dự án: CVAT 3D Point Cloud Annotation (Project 22). Đơn vị tính: Mét (m)

---

## QUY CHUẨN CHUNG ÁP DỤNG CHO TOÀN BỘ JOB HIỆN TẠI

> [!IMPORTANT]
> Đây là các nguyên tắc cốt lõi bắt buộc phải tuân thủ 100% cho tất cả các nhãn và đối tượng trong dataset.

### 1. Nguyên tắc "1 Point cũng phải có Box"
* **Ngưỡng nhận diện tối thiểu**: Dù đối tượng chỉ xuất hiện **1 point duy nhất** thì vẫn bắt buộc phải gắn/duy trì Bounding Box, tuyệt đối không được bỏ qua chỉ vì số lượng point quá ít.

### 2. Quy tắc Nội suy liên tục qua Frame trống (Interpolation) & Đánh Outside
* **Bắt buộc nội suy giữa chừng**: Nếu đối tượng bị mất point tạm thời giữa chừng (do bị che khuất, góc quét LiDAR hụt), sau đó lại xuất hiện point ở các frame tiếp theo $\rightarrow$ **các frame ở giữa bắt buộc phải nội suy (Interpolate), tuyệt đối không được ngắt quãng hay xóa track**.
  - *Ví dụ minh họa luồng chuẩn*:
    - `Frame 0`: Có 1 point $\rightarrow$ Có box.
    - `Frame 1`: Có 3 point $\rightarrow$ Có box.
    - `Frame 2, 3, 4`: 0 point (tạm thời khuất point) $\rightarrow$ **Bắt buộc nội suy (Interpolation)** liên tục vị trí, duy trì box.
    - `Frame 5`: Xuất hiện lại 1 point $\rightarrow$ Tiếp tục nối và fit box theo track.
    - `Frame 6 -> End`: 0 point (đối tượng đi hẳn ra ngoài tầm quan sát đến hết chuỗi) $\rightarrow$ Đánh trạng thái **Outside** bắt đầu từ frame 6.

### 3. Quy tắc Đáy Box tiếp xúc Mặt đường (Ground Alignment)
* **Cắt ngang qua point mặt đường**: Đáy của Bounding Box phải **cắt ngang qua các điểm point của mặt đường** (tiếp xúc chuẩn xác với cốt mặt đường).
* **Tuyệt đối cấm**:
  - Không đặt đáy box lơ lửng trên không (cao hơn mặt đường).
  - Không để đáy box thụt lún sâu xuống lòng đất (thấp hơn mặt đường).

### 4. Yêu cầu Bao trọn Point thực, tránh bỏ sót (Point Coverage)
* **Bọc hết toàn bộ point thực**: Bounding Box phải bao trọn toàn bộ các điểm point được xác định thuộc về đối tượng (không phải là điểm nhiễu/noise).
* **Tránh bỏ sót point**: Tuyệt đối không để sót point thực ra ngoài viền box hoặc cắt xén mất các góc cạnh, bộ phận của đối tượng.

### 5. Căn chỉnh góc xoay Front & Side theo mặt đường (Heading & Side Alignment)
* **Căn phẳng và ngang nhất có thể**: Hướng mặt trước (`Front`) và mặt bên sườn (`Side`) của Bounding Box phải được căn chỉnh chuẩn theo trục di chuyển của vật thể và song song/phẳng nhất với mặt đường và làn đường.
* **Tránh chéo quá độ**: Tuyệt đối tránh để box bị xoay nghiêng, xoay chéo góc quá mức (lệch góc Yaw/Pitch/Roll) so với mặt phẳng và hướng di chuyển thực tế của cung đường.

---

## Nhóm `vehicles`

| STT | Tên nhãn | Thuộc tính (Attribute) | L tối thiểu (m) | L tối đa (m) | W tối thiểu (m) | W tối đa (m) | H tối thiểu (m) | H tối đa (m) |
| :-: | :--- | :--- | :---: | :---: | :---: | :---: | :---: | :---: |
| 1 | vehicles | type: car | 3.2 | 5.5 | 1.6 | 2.2 | 1.5 | 1.9 |
| 2 | vehicles | type: truck | | | | | | |
| 3 | vehicles | type: bus | | | | | | |
| 4 | vehicles | type: van | 3.2 | 5.5 | 1.6 | 2.2 | 1.5 | 1.9 |
| 5 | vehicles | type: contruction | | | | | | |
| 6 | vehicles | type: pickup | | | | | | |
| 7 | vehicles | type: Trailer | | | | | | |
| 8 | vehicles | type: Tricycle | | | | | | |
| 9 | vehicles | type: Stroller | | | | | | |
| 10 | vehicles | type: Wheelchair | | | | | | |
| 11 | vehicles | type: other | 3.2 | | 1.6 | | 1.5 | |

### Quy tắc / Case kiểm tra chuẩn hóa (`vehicles`)

#### 1. Nguyên tắc kích thước bất biến theo Track ID (Rigid Body)
* **Cố định kích thước 100% xuyên suốt**: Xe là vật thể cứng, kích thước ($L \times W \times H$) của cùng một `Track ID` bắt buộc phải **giữ nguyên từ frame đầu đến frame cuối**, tuyệt đối không co giãn hay thay đổi kích thước qua từng frame (chỉ di chuyển tọa độ và góc xoay).
* **Không ép đồng loạt**: Mỗi xe (Track ID khác nhau) có kích thước độc lập tùy thực tế, không ép các xe cùng loại về cùng một kích cỡ.

#### 2. Quy trình xác định kích thước chuẩn (Anchor Frame & Point Cloud)
* **Ưu tiên Frame nhiều point nhất**: Luôn tìm frame mà xe có lượng point cloud rõ và đầy đủ nhất trong cả chuỗi để fit chuẩn bao trọn thân xe (chiều dài, rộng, cao), sau đó khóa bộ kích thước này áp dụng cho toàn bộ track.
* **Xử lý toàn bộ frame thiếu point (xe ở xa / bị che khuất)**: Nếu toàn bộ track đều không đủ point để dựng hình dạng thực tế, fit theo **ngưỡng tối thiểu (Min)** trong bảng quy chuẩn của loại xe đó.
* **Fit chuẩn biên**: Bao trọn thân xe, hạn chế khoảng trống thừa và tuyệt đối không cắt lẹm các bộ phận cố định của xe (đầu xe, đuôi xe, gương chiếu hậu...).

#### 3. Tuân thủ ngưỡng & Ngoại lệ thực tế
* **Xe đã có quy chuẩn**: Kích thước phải nằm trong khoảng $[\text{Min}, \text{Max}]$ ở điều kiện thông thường.
* **Xe chưa có quy chuẩn**: Fit sát theo hình thái point cloud thực tế, không tự ý áp đặt giới hạn số cố định.
* **Ngoại lệ thực tế**: Nếu xe thực tế vượt ngưỡng (xe độ cản, giá nóc chở hàng, kích cỡ đặc thù) nhưng point cloud và hình ảnh chứng minh xe có kích thước đó, **ưu tiên thực tế khách quan**, tuyệt đối không ép nhỏ box lại chỉ để vừa ngưỡng lý thuyết.

#### 4. Quy tắc xử lý cánh cửa mở (Door Opening Case)
* **Box xe chính**: Vẫn giữ nguyên kích thước khung xe chuẩn ban đầu, không mở rộng box xe để bao luôn cánh cửa.
* **Phần cánh cửa mở**: Đánh nhãn riêng là `Obstacle`.
* **Cố định kích thước cửa**: Bounding Box của `Obstacle` này qua các frame cửa mở cũng phải được **giữ cố định đúng kích thước của cánh cửa**, không co giãn bất thường.

## Nhóm `pedestrian`

| STT | Tên nhãn | Thuộc tính (Attribute) | L tối thiểu (m) | L tối đa (m) | W tối thiểu (m) | W tối đa (m) | H tối thiểu (m) | H tối đa (m) |
| :-: | :--- | :--- | :---: | :---: | :---: | :---: | :---: | :---: |
| 12 | pedestrian | age: adult \| pose: standing | 0.65 | 1 | 0.65 | 1 | 1.5 | 1.9 |
| 13 | pedestrian | age: adult \| pose: sitting | 0.65 | 1 | 0.65 | 1 | | 1.2 |
| 14 | pedestrian | age: adult \| pose: bending | 0.65 | 1 | 0.65 | 1 | 1.2 | 1.9 |
| 15 | pedestrian | age: child \| pose: standing | | | | | | |
| 16 | pedestrian | age: child \| pose: sitting | | | | | | |
| 17 | pedestrian | age: child \| pose: bending | | | | | | |

### Quy tắc / Case kiểm tra chuẩn hóa (`pedestrian`)

#### 1. Nguyên tắc co giãn kích thước ($L, W$) theo cử động
* Do con người là vật thể cử động phi cứng (*Non-rigid Body*), **chiều dài ($L$) và chiều rộng ($W$) ĐƯỢC PHÉP THAY ĐỔI linh hoạt qua từng frame** để bao trọn sải chân bước đi/chạy, vung tay hoặc thay đổi dáng di chuyển thực tế.

#### 2. Quy tắc Chiều cao ($H$) theo từng Thuộc tính tư thế (`pose`)
* **Khóa $H$ theo đỉnh cao nhất của từng tư thế**: Không thay đổi chiều cao nhấp nhô theo từng nhịp bước chân ở mỗi frame. Chiều cao $H$ phải lấy theo **mức cao nhất ($H_{\max}$)** tương ứng với từng trạng thái thuộc tính (`Attribute`):
  - **Đang đứng (`pose: standing`)**: Lấy và cố định theo chiều cao cao nhất khi người đó đứng thẳng lưng trong chuỗi frame đứng.
  - **Đang cúi (`pose: bending`)**: Lấy và cố định theo chiều cao cao nhất khi người đó ở tư thế cúi khom trong chuỗi frame cúi.
  - **Đang ngồi (`pose: sitting`)**: Lấy và cố định theo chiều cao cao nhất khi người đó ở tư thế ngồi trong chuỗi frame ngồi.
* Khi người có sự chuyển đổi tư thế giữa các frame (ví dụ: đang ngồi đứng dậy $\rightarrow$ chuyển từ `sitting` sang `standing`), chiều cao $H$ sẽ được cập nhật tương ứng với mức cao nhất của tư thế mới.

#### 3. ĐẶC BIỆT QUAN TRỌNG: Hướng di chuyển của người (Heading / Orientation)
* **Tuyệt đối chú ý hướng quay của Bounding Box**: Mặt trước (Front / Heading) của box bắt buộc phải **hướng đúng theo chiều người đang di chuyển** (hoặc hướng mặt/hướng nhìn thực tế của người).
* Không để box bị ngược hướng ($180^\circ$) hoặc lệch ngang so với vector di chuyển thực tế của người trên chuỗi point cloud qua các frame.

#### 4. Quy tắc khi thiếu Point Cloud (Người ở xa / Che khuất)
* Ưu tiên tìm frame người đứng gần sensor hoặc rõ nét nhất để xác định vóc dáng (người lớn hay trẻ em).
* Nếu toàn bộ track đều thiếu point: Áp dụng kích thước tối thiểu theo bảng quy chuẩn (Người lớn: $L_{\min} = 0.65\text{m}$, $W_{\min} = 0.65\text{m}$, $H_{\min}$ theo tư thế).

## Nhóm `two-wheels`

| STT | Tên nhãn | Thuộc tính (Attribute) | L tối thiểu (m) | L tối đa (m) | W tối thiểu (m) | W tối đa (m) | H tối thiểu (m) | H tối đa (m) |
| :-: | :--- | :--- | :---: | :---: | :---: | :---: | :---: | :---: |
| 18 | two-wheels | type: motorcycle \| ride_state: false | 1.5 | 2 | 0.6 | 0.9 | | 1.8 |
| 19 | two-wheels | type: motorcycle \| ride_state: true | 1.5 | 2 | 0.6 | 0.9 | 1.5 | 1.8 |
| 20 | two-wheels | type: bicycle \| ride_state: false | 1.5 | 2 | 0.6 | 0.9 | | 1.8 |
| 21 | two-wheels | type: bicycle \| ride_state: true | 1.5 | 2 | 0.6 | 0.9 | 1.5 | 1.8 |

### Quy tắc / Case kiểm tra chuẩn hóa (`two-wheels`)

#### 1. Nguyên tắc xác định kích thước chuẩn (Anchor Frame)
* **Ưu tiên frame nhiều point nhất**: Luôn tìm frame có point cloud của xe (và người lái nếu có) đầy đủ, rõ nét nhất trong toàn bộ chuỗi để xác định bộ khung kích thước chuẩn.

#### 2. Phân loại theo trạng thái người lái (`ride_state`)

##### A. Trường hợp KHÔNG có người lái (`ride_state: false`)
* Xem như vật thể cứng tĩnh (*Rigid Body* tương tự `vehicles`).
* **Cố định 100% cả 3 chiều ($L \times W \times H$) từ đầu đến cuối track**, tuyệt đối không co giãn hay thay đổi kích thước qua từng frame.

##### B. Trường hợp CÓ người lái (`ride_state: true`)
* **Chiều dài ($L$)**: **Cố định xuyên suốt** theo chiều dài chuẩn của xe, không thay đổi.
* **Chiều rộng ($W$)**: **Được phép thay đổi linh hoạt theo từng frame** để bao trọn tư thế thực tế của người lái (ví dụ: khi chống chân lúc dừng xe/chạy chậm, dang chân hoặc khép chân).
* **Chiều cao ($H$)**:
  - **Khóa theo độ cao lớn nhất ($H_{\max}$)**: Tìm frame mà người lái đạt **chiều cao cao nhất** (tư thế ngồi thẳng lưng hoặc đứng thẳng) trong cả chuỗi để lấy làm chiều cao chuẩn $H$ cho cả track.
  - **Tuyệt đối không co giật $H$**: Không được thay đổi chiều cao co giãn thụt thò bám theo từng nhịp cúi đầu/ngẩng đầu tức thời ở từng frame.

#### 3. Quy tắc căn chỉnh vị trí khi THIẾU POINT (Sparse Point Cloud)
Khi xe ở xa hoặc bị che khuất dẫn đến không đủ point cloud để thấy rõ toàn bộ thân xe, chỉ nhận diện được point phần đầu/mũ bảo hiểm:
* **Áp dụng kích thước tối thiểu (Min)**: Lấy kích thước theo ngưỡng tối thiểu của bảng quy chuẩn.
* **Xe có 1 người ngồi**: Căn chỉnh Bounding Box sao cho **vị trí đầu người lái nằm chính giữa theo chiều dài ($L$)** của box.
* **Xe có 2 người ngồi**: Căn chỉnh Bounding Box sao cho **điểm chính giữa khoảng cách giữa 2 đầu (trung điểm 2 đầu)** nằm ở **chính giữa theo chiều dài ($L$)** của box.

#### 4. Tuân thủ ngưỡng quy định
* Kích thước chuẩn nằm trong khoảng: $L$: `1.5 – 2.0m`, $W$: `0.6 – 0.9m`, $H$: `1.5 – 1.8m`. Trường hợp người lái chống chân mở rộng $W$, ưu tiên bao trọn thực tế theo point cloud.

## Nhóm `Animal`

| STT | Tên nhãn | Thuộc tính (Attribute) | L tối thiểu (m) | L tối đa (m) | W tối thiểu (m) | W tối đa (m) | H tối thiểu (m) | H tối đa (m) |
| :-: | :--- | :--- | :---: | :---: | :---: | :---: | :---: | :---: |
| 22 | Animal | species: cat | | | | | | |
| 23 | Animal | species: dog | | | | | | |
| 24 | Animal | species: cow | | | | | | |
| 25 | Animal | species: buffalow | | | | | | |
| 26 | Animal | species: other | | | | | | |

## Nhóm `Obstacle`

| STT | Tên nhãn | Thuộc tính (Attribute) | L tối thiểu (m) | L tối đa (m) | W tối thiểu (m) | W tối đa (m) | H tối thiểu (m) | H tối đa (m) |
| :-: | :--- | :--- | :---: | :---: | :---: | :---: | :---: | :---: |
| 27 | Obstacle | type: traffic barrier | | | | | | |
| 28 | Obstacle | type: traffic cone | | | | | | |
| 29 | Obstacle | type: brick | | | | | | |
| 30 | Obstacle | type: trash_bag | | | | | | |
| 31 | Obstacle | type: container | | | | | | |
| 32 | Obstacle | type: metal_sheet | | | | | | |
| 33 | Obstacle | type: wood | | | | | | |
| 34 | Obstacle | type: pole | | | | | | |
| 35 | Obstacle | type: charging_point | | | | | | |
| 36 | Obstacle | type: other | | | | | | |
