# DocShield (`dsh-docshield`)

Chatbot tra cứu tài liệu nội bộ cho nhiều người dùng, chạy trên DeepSeek Harness Web UI:
- **Cách ly dữ liệu:** mỗi người chỉ tra được tài liệu chung và tài liệu của chính mình.
- **Trả lời có bằng chứng:** câu trích phải là nguyên văn của tài liệu và được kiểm tra bằng code.
- **Phiếu hỗ trợ:** tự tạo khi tài liệu không có câu trả lời, Admin phản hồi trong chat.

## Hai cách triển khai

| | **Khuyến nghị: `gate/` (dsh-gate, tự viết)** | Cũ: dsh-passwords |
|---|---|---|
| Đăng nhập | Cổng tự viết ở **:3444**: scrypt, cookie ký, tự đăng ký + admin duyệt, trang quản trị | Plugin bên thứ ba ở :3443 (GPL-3.0) |
| Cách ly | **Mỗi user một tiến trình DSH riêng** (DSH_HOME riêng), không phải lọc lưu lượng | Một DSH chung, gateway lọc phiên/workspace |
| Danh tính cho DocShield | Gate truyền qua cấu hình (`identity`) | Suy ra từ thư mục làm việc (cwd) của phiên |
| Embedding | Một dịch vụ bge-m3 dùng chung (`scripts/embed-server.mjs`, :3490) | bge-m3 trong tiến trình DSH |
| Chạy | `start.cmd` (gốc repo) → http://127.0.0.1:3454 | `_archive/root-old/start-docshield.cmd` → http://127.0.0.1:3443 |

Chi tiết cổng mới: [../gate/README.md](../gate/README.md). Các phần bên dưới mô tả cách cũ; plugin DocShield vẫn hỗ trợ cả hai cách, vì khi không cấu hình `identity` thì nó quay về suy danh tính từ cwd.

| Thành phần | Vai trò |
|---|---|
| DeepSeek Harness 0.1.6-alpha.2 (bản riêng, chỉ loopback) | Agent, giao diện chat |
| `gate/` (khuyến nghị) hoặc `dsh-passwords` 2.7.3 | Đăng nhập, tách người dùng |
| `dsh-docshield` (package này) | Công cụ DocShield, guard, nạp + lập chỉ mục, phiếu hỗ trợ, thẻ giao diện |
| bge-m3 (ONNX int8, chạy offline) + SQLite (`sqlite-vec` + FTS5) | Tìm kiếm theo nghĩa + từ khóa |
| Model chat: bất kỳ nhà cung cấp nào DSH hỗ trợ (demo: `nien-router/my-models-free` qua 9Router) | Sinh câu trả lời |

## Chạy
1. Bật 9Router (`9router`, cổng 20128) cho model chat.
2. Chạy `start.cmd` ở gốc repo (khuyến nghị), hoặc `_archive/root-old/start-docshield.cmd` nếu dùng cách cũ.
3. Mở trình duyệt vào **http://127.0.0.1:3454** (gate), hoặc :3443 nếu dùng cách cũ.
   > Không vào thẳng cổng của DSH: cổng đó bỏ qua lớp đăng nhập. Không đưa URL có `?token=` trong cửa sổ console cho ai.

## Cách hoạt động: danh tính = workspace
Gateway chỉ cho subuser mở phiên trong thư mục được cấp. DocShield suy ra vai trò từ thư mục làm việc (cwd) của phiên:

| Thư mục (dưới `storage/`) | Vai trò | Được tìm | Upload vào |
|---|---|---|---|
| `users/<tên>` | user `<tên>` | tài liệu chung + của mình | `users/<tên>/docs` |
| `admin` (chỉ owner) | Admin | tài liệu chung | `public_docs` |
| chỗ khác trong `storage/` | không hợp lệ | mọi công cụ bị chặn | |

**3 lớp khóa công cụ:**
1. Gateway chỉ cho subuser dùng agent mode "DocShield".
2. Preset DocShield chỉ chứa công cụ DocShield.
3. Guard toàn cục chặn mọi công cụ khác trong `storage/`, kể cả khi owner lỡ tick `标准模式`.

## Thêm người dùng
```
node scripts/provision-user.mjs <tên>      # tạo storage/users/<tên>/docs + in checklist
```
Checklist cho owner (Settings → Password Gate):
1. **Subusers:** tạo `<tên>` (3–32 ký tự a-z 0-9 _ -, **viết thường**, trùng tên thư mục).
2. **Add workspace:** `storage\users\<tên>`.
3. **Subuser permissions → `<tên>`:**
   - Workspace: **chỉ** `<tên>`.
   - Agent modes: **chỉ** "DocShield".
   - Tick **"Large file upload."** (không tick thì gateway chặn mọi upload).
   - Nên giới hạn "Available models".
4. Kiểm tra: `node scripts/doctor.mjs` (đọc `platform.db`, chỉ đọc, báo LỖI/CẢNH BÁO).

**Admin:** owner mở workspace `storage\admin` và dùng agent mode **"DocShield Admin"**. Tuyệt đối không cấp thư mục `admin` hay `public_docs` cho subuser.

## Công cụ
| Công cụ | Ai | Việc |
|---|---|---|
| `scoped_doc_search` | mọi người | Tìm kết hợp bge-m3 + BM25 (RRF), chỉ trong phạm vi được đọc |
| `answer_with_evidence` | mọi người | Trả lời kèm trích dẫn; code kiểm tra chunk đã được tìm trong phiên, còn hiệu lực, trích đúng nguyên văn |
| `create_support_ticket` / `check_ticket_status` | mọi người | Phiếu `TICK-<số>`; user chỉ thấy phiếu của mình |
| `list_documents` | mọi người | Tài liệu tra được và trạng thái nạp |
| `list_tickets` / `update_ticket` | Admin | Bảng phiếu, phản hồi, đổi trạng thái: Đang chờ xử lý → Đang xử lý → Đã giải quyết, hoặc **Từ chối** (bắt buộc có lý do) |
| `publish_public_doc` / `reindex_document` | Admin | Công bố bản mới thay bản cũ theo `doc_key`; nạp lại |

## Tài liệu
- Nhận PDF (có lớp chữ), TXT, MD, tối đa 10MB. Gửi kèm trong chat, hoặc chép thẳng vào thư mục `docs/` / `public_docs/`. Bộ theo dõi thư mục tự lập chỉ mục sau khoảng 1 giây.
- **Tài liệu dài cần vài phút để nạp.** bge-m3 chạy trên CPU, khoảng 1–4 giây mỗi đoạn tùy độ bận của máy; PDF 87 trang (112 đoạn) mất khoảng 4 phút khi máy rảnh. Trong lúc đó `list_documents` hiện "đang nạp · x/y đoạn", còn cửa sổ console in `[docshield] đang nạp …` và tiến độ mỗi 15 giây. Các tài liệu được nạp lần lượt từng cái một.
- Thay tài liệu chung: gửi bản mới (tên khác cũng được), rồi bảo Admin *"công bố X thay thế Y với doc_key K"*. Bản cũ bị ngừng tra cứu kể cả khi file vẫn còn trên đĩa.

## Dữ liệu và sao lưu
Sao lưu 3 thứ này (tắt DocShield trước) là khôi phục được:
- `storage/`: tài liệu và `.docshield/docshield.db` (chỉ mục, phiếu, bản đồ tài liệu chung);
- `spike-dshpw/dsh-passwords/data/platform.db` và `.env`: tài khoản, quyền; khóa mã hóa nằm trong `.env`;
- `spike-dshpw/dsh-home`: phiên chat, workspace, cấu hình model, preset.

Dữ liệu demo: `node scripts/seed-demo.mjs` (xem đầu file để biết các tuỳ chọn `--reset`).

## Phát triển
```
npm run build        # tsc (host) + esbuild (client → dist/client.js)
npm test             # vitest, 95 test (tự build trước, vì TC-06 chạy 5 tiến trình con)
node scripts/build-presets.mjs && node scripts/install-presets.mjs   # sau khi sửa presets/persona-rules.txt
```
Kịch bản demo: `DEMO.md`.

## Hạn chế đã biết
- **Chống ảo giác phụ thuộc một phần vào model.** Code chặn được trích dẫn sai hoặc bịa, nhưng không ép được model luôn chọn "không tìm thấy". Ngưỡng tương đồng không tách được câu bẫy khỏi câu thật (hiệu chỉnh: 0,34–0,61 so với 0,40–0,77), nên việc từ chối dựa vào persona.
- **Câu hỏi xin thông tin cá nhân của người khác:** persona dặn trả lời "Không tìm thấy thông tin này trong tài liệu của bạn." và không tạo phiếu. Tuy vậy model vẫn có thể tạo phiếu, và điều này được chấp nhận: Admin sẽ từ chối phiếu kèm lý do. Dữ liệu không thể lộ, vì phạm vi tìm kiếm bị khóa ở tầng dữ liệu.
- **Chưa có OCR:** PDF scan được ghi là "lỗi".
- **Thẻ bằng chứng nằm trong nhóm "N tool calls" mà DSH thu gọn mặc định.** Câu trả lời chính luôn kèm `[Nguồn: …]`.
- **Không có thông báo chủ động** khi Admin phản hồi phiếu; user bấm "Xem tiến độ".
- **URL `?token=` của cổng 3090** vào thẳng DSH. Cổng này chỉ nghe loopback, nhưng không được chia sẻ.
- **Chạy HTTP thường trên 1 máy.** Triển khai mạng cần HTTPS của `dsh-passwords`.
- **DSH là bản alpha:** ghim đúng DSH 0.1.6-alpha.2 và `dsh-passwords` 2.7.3 (patch của gateway phụ thuộc phiên bản).
- **Model qua 9Router có thể "tưởng tượng" công cụ `bash`/`read`** không tồn tại. Vô hại: DSH không gửi các công cụ đó và guard chặn mọi công cụ lạ.
