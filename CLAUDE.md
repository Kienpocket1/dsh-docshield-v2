# DSH-DocShield (bản công ty) — ghi chú cho agent

Trả lời tiếng Việt. Chỉ commit trên máy; chưa có remote — không tự gắn/push (repo GitHub public của đồ án KHÔNG phải của bản này).
Bàn giao đầy đủ (kiến trúc, cách chạy, bẫy): `E:\Company\HANDOFF.md` — chỉ đọc khi cần.

## Kiến trúc
- 1 DSH chung trong container `congty-dsh-main`; plugin `gate/` (đăng nhập, lọc theo người dùng, mặc định chặn: `gate/src/policy.mjs`), `docshield/` (tra cứu), `exec-router/` (công cụ của agent chạy trong container riêng từng người, vùng theo thư mục phiên: `exec-router/src/zones.mjs`).
- `exec-router/tool-manager.mjs` chạy trên Windows, duy nhất gọi Docker. Egress proxy `container/egress-proxy.mjs` là lối ra internet duy nhất.
- Vùng: `users/<tên>` (đọc/ghi, internet) · `admin` · `users` = admin xem dữ liệu (chỉ đọc, không mạng).

## Bản này
- Cấu hình: `local.cmd` (không vào git) — prefix `congty`, gate `127.0.0.1:3454`, manager 3470, image `congty-*`. Volume `congty-*`; KHÔNG đụng `docshield-*` (bản đồ án, `E:\Deepseek_Harness`).
- Chạy: `start.cmd` (`tunnel`, `rebuild`). Mã nguồn DSH để build: `E:\Deepseek_Harness\deepseek-harness` (chỉ đọc).
- Không tự bật/tắt hệ thống đang chạy của người dùng; hỏi trước. Không in khóa API/mật khẩu.

## Test (chọn cái rẻ nhất đủ dùng)
- `npm test` — unit, nhanh, không cần Docker.
- `npm run attack` (đặt `TOOL_PREFIX=congty TOOL_IMAGE=congty-tools:dev MAIN_IMAGE=congty-dsh-main:dev`) — ~5 phút; chỉ đọc dòng tổng kết và các dòng `✗`, báo cáo ở `test/attack/last-run.md`. Mục internet cần example.com truy cập được.

## Bẫy
- Docker Desktop lỗi socket: `exec-router/ensure-docker.ps1` tự sửa (tắt tiến trình → đổi tên `%LOCALAPPDATA%\Docker\run`, `docker-secrets-engine` → mở; làm 2 lần).
- Git Bash: `export MSYS_NO_PATHCONV=1` trước `docker exec … /opt/...`; heredoc làm mất `\` → dùng Edit/Write.
- `.cmd` phải CRLF; PowerShell 5.1 không có `&&`, `powershell -File` bỏ tham số rỗng.
- Sửa gate/docshield/exec-router phải `start.cmd rebuild` (code nằm trong image).
- Gate mặc định chặn: chức năng giao diện hỏng với tài khoản thường → xem log `gate: deny …`, thêm endpoint vào `gate/src/policy.mjs`.
- Đọc log phiên chat DSH: `E:\Company\tools-local\read-sessions.mjs` (chép vào container `/tmp`, chạy bằng node).
