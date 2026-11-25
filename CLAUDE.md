# DSH-DocShield (bản công ty) — ghi chú cho agent

Trả lời tiếng Việt. Remote `origin` = github.com/Kienpocket1/dsh-docshield-v2 (nhánh `cong-ty`); chỉ push khi người dùng yêu cầu (repo đồ án là repo khác).
Bàn giao đầy đủ (kiến trúc, cách chạy, bẫy): `E:\Company\HANDOFF.md` — chỉ đọc khi cần.

## Kiến trúc
- 1 DSH chung trong container `congty-dsh-main`; plugin `gate/` (đăng nhập, lọc theo người dùng, mặc định chặn: `gate/src/policy.mjs`), `docshield/` (tra cứu), `exec-router/` (công cụ của agent chạy trong container riêng từng người, vùng theo thư mục phiên: `exec-router/src/zones.mjs`).
- Skill DSH: `container/skills/<tên>/SKILL.md` → image `/opt/dsh-skills` → chép vào `$DSH_HOME/skills` mỗi lần khởi động; exec-router cho mọi phiên đọc (chỉ đọc) thư mục này từ dsh-main. Có `remove-ai-marks`: gọi service `tools-local\start-watermarks.cmd` (Windows :8765, Layer B = qwen3 Ollama) qua `EGRESS_LOCAL_ALLOW=host.docker.internal:8765` trong `local.cmd` (proxy chỉ mở đúng host:port này, HTTP thường).
- `exec-router/tool-manager.mjs` chạy trên Windows, duy nhất gọi Docker. Egress proxy `container/egress-proxy.mjs` (image riêng `egress-proxy.Dockerfile`, chỉ node) là lối ra internet duy nhất; không hạn mức (`DEFAULT_LIMITS` = Infinity, unit test truyền mức riêng).
- Hạn mức token theo gói (cửa sổ 5 giờ + tuần): `gate/plugin` bọc `llm/stream`, hỏi gate qua IPC (fail-closed); `gate/src/quota.mjs` quyết định, sổ `quota_windows` trong `gate.db` (chỉ gate ghi). Gán gói ở `/gate/admin`, người dùng xem ở `/gate/usage`. Mức suy luận low/medium/high: `reasoningEfforts` của model trong `settings.yaml`.
- Hạn mức đĩa vùng (`TOOL_QUOTA_MB`, quét 60 s): vượt → chặn; mỗi lượt bị từ chối đo lại bằng container tạm → admin xóa file là tự gỡ chặn.
- Tool DocShield: khai báo `docshield/src/tools/defs.ts`, xử lý `calls.ts`, quyền theo `USER_TOOLS`/`ADMIN_TOOLS` (`docshield/src/guard.ts`); `my_access` chỉ cho user (admin không có).
- Vùng: `users/<tên>` (đọc/ghi, internet) · `admin` · `users` = admin xem dữ liệu (chỉ đọc, không mạng).
- Workspace con `users/<u>/<wsp>`: upload vào `<wsp>/docs` (index scope `user:<u>`, key tiền tố `<wsp>__`, chỉ 1 cấp — `docshield/src/ingest/layout.ts`); đường dẫn tương đối của tool tính từ cwd phiên (`exec-router/src/index.mjs` `baseCwd`).

## Bản này
- Cấu hình: `local.cmd` (không vào git) — prefix `congty`, gate `127.0.0.1:3454`, manager 3470, image `congty-*`. Volume `congty-*`; KHÔNG đụng `docshield-*` (bản đồ án).
- Chạy: `start.cmd` (`tunnel`, `rebuild`). Mã nguồn DSH để build: `E:\Company\deepseek-harness` (bản clone, đã `pnpm install` + `pnpm run build:lib:host`; `DSH_SOURCE` trong `local.cmd`).
- Không tự bật/tắt hệ thống đang chạy của người dùng; hỏi trước. Không in khóa API/mật khẩu.

## Project 3 (`project3/`, xem README)
- Agent xử lý phiếu hỗ trợ cho admin (H0–H3; H4 nguồn ngoài đã bỏ 24/11) + chatbot model local fine-tune "biết nói không biết" + reranker (C0–C3), xem `project3/process.md`. Danh sách việc: `project3/TODO.md` — tích `[x]` + ngày khi xong. Kho `project3/corpus/hust/` (24 PDF đã nạp `public_docs`; scan đã OCR sẵn bằng image `congty-ocr:dev` vì DocShield không có OCR). Đánh giá: `project3/eval.py` (`check`/`run`/`grade`, giám khảo qwen3 qua API gốc Ollama `/api/chat` + `think:false` — endpoint `/v1` bỏ qua `/no_think`, qwen3 nghĩ hết token, trả rỗng).
- `agent.py` `run_session` chạy phiên DSH qua gate (`dsh.Gate(user)`, mật khẩu `project3/.<user>-pass`, không git): `p3agent` = H0 phía user, `p3admin` (admin dịch vụ) = agent xử lý phiếu; báo lỗi nếu gate đổi preset. Provider `P3_PROVIDER` (mặc định `ollama-local`). Preset user được chọn: admin gán ở `/gate/admin` (cột `users.presets`, setting `default_presets`; chưa gán → env `GATE_USER_EXTRA_PRESETS`); `USER_PRESET` luôn có (`policy.mjs` `allowedPresets`; `agentPresets/select` = `{agentId, agentPreset}`).
- Luồng phiếu: H0 tạo phiếu → `project3/worker.py` (tự bật cùng `start.cmd` trong cửa sổ "P3 worker" khi `local.cmd` có `P3_WORKER=1`, model `P3_PROVIDER`/`P3_RUN_MODEL`, hoặc `P3_MODEL_FROM_TICKET=1` = model của phiên chatbot tạo phiếu (`eval.py` luôn cố định); chờ hệ thống lên, không thoát; preset `p3-h*` role admin, `exclude` tool ghi, cwd `/data/admin/p3`; đầu vào phiếu + đoạn chat chatbot) → bảng `ticket_proposals` (DocShield schema v5, qua CLI `docshield/dist/cli/tickets.js`; nháp không chạm `admin_reply`) → admin duyệt/sửa/từ chối ở `/gate/admin/tickets` (gate gọi CLI qua env `GATE_TICKETS_CLI`; tùy chọn ghi `public_docs/hoi-dap-tick-N.md`). Thí nghiệm: `eval.py tickets <cfg> <split>`, `eval.py reask <split>`. Preset H1–H3 sinh trong `make-harness-presets.mjs` (persona `p3-ticket-rules.txt`); preset mới phải thêm vào danh sách chép trong `dsh-main-start.mjs`. Root trong container không vào được `/data/users` → chép file bằng tar qua `docker exec` (user node).
- Model: Ollama trên Windows (`ollama serve`, model `E:\Ollama\models`, `OLLAMA_CONTEXT_LENGTH=24576`), provider DSH `ollama-local` → `host.docker.internal:11434` (`apiKeyEnv: HOME` giả). Đổi model khi chạy eval: `P3_PROVIDER=orcarouter P3_RUN_MODEL=deepseek/deepseek-v4-flash-free` (chạy tốt, ~3 phút/câu). Model miễn phí qua 9Router hay 429/404 (orcarouter `contextWindow` đã hạ 30000, bản cũ `.bak-p3`).

## Test (chọn cái rẻ nhất đủ dùng)
- `npm test` — unit, nhanh, không cần Docker.
- `npm run attack` (đặt `TOOL_PREFIX=congty TOOL_IMAGE=congty-tools:dev MAIN_IMAGE=congty-dsh-main:dev PROXY_IMAGE=congty-egress-proxy:dev`) — ~5 phút; chỉ đọc dòng tổng kết và các dòng `✗`, báo cáo ở `test/attack/last-run.md`. Mục internet cần example.com truy cập được.

## Bẫy
- Script `project3/*.py` chạy bằng `python -X utf8 …` (không `-I`: nó bỏ thư mục script khỏi `sys.path`, `import agent` hỏng). Sửa file bằng Edit, không dùng Python/node trong heredoc Bash (`\n`, backtick bị hỏng).
- Đọc phiên qua API: `session/page` cần `throughSeq` = `asOfSeq` thật (`-1` trả rỗng); lời người dùng là sự kiện `user/message` (không có `role`) — xem `worker.py` `chat_lines`.
- DocShield giới hạn 10 phiếu/giờ mỗi người (`MAX_TICKETS_PER_HOUR`): chạy H0 nhiều câu liền bằng `p3agent` có thể bị từ chối tạo phiếu.
- Docker Desktop lỗi socket: `exec-router/ensure-docker.ps1` tự sửa (tắt tiến trình → đổi tên `%LOCALAPPDATA%\Docker\run`, `docker-secrets-engine` → mở; làm 2 lần).
- Git Bash: `export MSYS_NO_PATHCONV=1` trước `docker exec … /opt/...`; heredoc làm mất `\` → dùng Edit/Write.
- PowerShell 5.1 `Get-Content -Raw | Set-Content` đọc UTF-8 thành ANSI → hỏng tiếng Việt; sửa file bằng Edit/Write. `start.cmd` gọi bằng đường dẫn tuyệt đối; nó từ chối khi bản congty đang chạy.
- `.cmd` phải CRLF; PowerShell 5.1 không có `&&`, `powershell -File` bỏ tham số rỗng.
- Sửa gate/docshield/exec-router phải `start.cmd rebuild` (code nằm trong image).
- Gate mặc định chặn: chức năng giao diện hỏng với tài khoản thường → xem log `gate: deny …`, thêm endpoint vào `gate/src/policy.mjs`.
- Danh tính = cwd phiên **như được viết** (gate `policy.mjs`, `zones.mjs`, `docshield/src/scope.ts` phải khớp nhau); symlink làm realpath khác → gate từ chối `session/create` (`realInside`), `scope.ts` trả không scope. Đừng đổi một chỗ sang realpath riêng lẻ.
- Gate tự chặn POST/WebSocket có `Origin` khác `Host` (proxy ghi đè Origin cho DSH). Tunnel phải giữ nguyên Host (cloudflared mặc định giữ; đừng đặt `--http-host-header`).
- Docker mode: kết nối trực tiếp chung IP NAT → chỉ khóa đăng nhập theo tên+IP.
- `safe-fs`/`safe-read` xác minh tệp đã mở qua `/proc/self/fd` (Linux); trên Windows race chỉ được thu hẹp.
- Đọc log phiên chat DSH: `E:\Company\tools-local\read-sessions.mjs` (chép vào container `/tmp`, chạy bằng node).

## Giữ file này đúng
Đổi kiến trúc, cách chạy/test, cổng, cấu hình hoặc gặp bẫy mới → cập nhật file này trong cùng lượt; xóa dòng sai, giữ < ~3 KB.
