# dsh-gate

Plugin DSH cho **một DeepSeek Harness dùng chung** nhiều người: đăng nhập, đăng ký, quản trị tài khoản và **lọc theo người dùng**. Thay cho dsh-passwords.

```
Trình duyệt ──► gate :3444  (đăng nhập, lọc từng request / từng thông điệp WebSocket)
                  └──► 1 DSH chung (127.0.0.1, cổng ngẫu nhiên)
                        ├─ plugin dsh-gate      : bật/tắt tiến trình gate
                        └─ plugin dsh-docshield : tra cứu tài liệu
alice chỉ thấy và dùng phiên có thư mục trong storage/users/alice; admin thấy tất cả.
```

## Vì sao là plugin + một tiến trình riêng

DSH gốc không có chỗ cắm đăng nhập:
- nó kiểm tra cookie của chính nó trước khi plugin được chạy;
- hàm xử lý RPC không biết ai gọi;
- kênh WebSocket `/api/remote.mux` thuộc về DSH.

Vì vậy, giống dsh-passwords, phần đăng nhập và lọc là một tiến trình đứng trước DSH, còn plugin lo vòng đời của nó:
- `plugin/index.mjs`: khi DSH nạp xong, lấy `connection.authenticatedUrl()` (API công khai của DSH, **không vá DSH**), rồi bật `bin/gate.mjs serve --plugin` và đưa link đó qua biến môi trường. DSH tắt thì gate tắt theo.
- Gate đổi token lấy cookie DSH và gắn cookie đó khi chuyển tiếp. Trình duyệt chỉ giữ cookie của gate.

## Lọc theo người dùng (`src/policy.mjs`, `src/filter.mjs`)

Viết theo định dạng dây của DSH 0.1.6-alpha.2. **Mặc định chặn**: chỉ cho qua những gì có trong danh sách.

| Loại | Xử lý cho tài khoản thường |
|---|---|
| Dữ liệu chung (danh mục model, preset, provider…) | Cho qua |
| Lệnh theo phiên (`session/prompt`, `rename`, `cancel`, `commands/*`, `fileUploads/upload`, `subagents/*`…) | Mọi mã phiên trong tham số phải thuộc thư mục của người đó |
| `session/create` | Chỉ trong `storage/users/<tên>`, luôn dùng preset `docshield`, không nhận mã phiên của người khác |
| `session/list`, `session/search`, `workspace/follow`, `session/control`, `$events` | Lọc kết quả, chỉ còn phiên/workspace của người đó |
| `session/follow` | Chỉ phiên của mình; kiểm tra lại thư mục trong snapshot |
| Duyệt công cụ (`$events/result`) | Chỉ trả lời được yêu cầu duyệt đã gửi cho chính người đó |
| `/api/file`, `workspaceFiles/*`, `directoryPicker/*` | Đường dẫn phải nằm trong thư mục của người đó |
| Plugin manager, terminal, ghi cài đặt/credential, mở file trên máy chủ, luồng terminal… | Chặn |

Gate tự biết phiên nào ở thư mục nào bằng cách hỏi `session/list` của DSH (`src/sessions.mjs`). Nó cũng tự tạo workspace `storage/users/<tên>` (admin: `storage/admin`) khi tài khoản vào lần đầu. Mỗi lần từ chối được ghi log `gate: deny …`.

## Chạy

```
E:\Deepseek_Harness\start-gate.cmd
```
Mở http://127.0.0.1:3444. Dữ liệu chạy nằm ngoài repo, trong `E:\Deepseek_Harness\runtime\`:

| Thư mục | Nội dung |
|---|---|
| `dsh\` | DSH 0.1.6-alpha.2 sạch, cài từ npm |
| `home\` | DSH_HOME: cấu hình model, preset, phiên chat; `runtime.patch.yml` |
| `storage\` | Tài liệu, DB DocShield, model bge-m3 |
| `gate-var\` | Tài khoản, khóa cookie |

## Cho máy khác truy cập

| Cách | Lệnh | Ai vào được |
|---|---|---|
| Chỉ máy này (mặc định) | `start-gate.cmd` | http://127.0.0.1:3444 |
| Cùng mạng LAN | `start-gate.cmd lan`, mở cổng 3444 trên tường lửa (loại mạng Private) | `http://<IP máy này>:3444`; HTTP không mã hóa |
| Qua internet bằng link | `start-gate.cmd tunnel` (cần cài `cloudflared`) | `https://….trycloudflare.com`; có HTTPS, không cần mở cổng |

Chế độ tunnel bật `GATE_TRUST_PROXY=1`. Khi đó gate lấy IP thật từ header `CF-Connecting-IP`, nên việc chống dò mật khẩu và giới hạn đăng ký tính theo từng người, không gộp chung một IP. Header này chỉ được tin khi request đến từ chính máy này. Cookie cũng được gắn cờ `Secure`. Link quick tunnel đổi mỗi lần chạy; tắt cửa sổ tunnel là ngắt truy cập từ ngoài.

## Thiết lập lần đầu

Khi chưa có tài khoản nào, cửa sổ đang chạy in ra một **mã thiết lập** dùng một lần, và mọi trang đều chuyển về `/gate/setup`. Nhập mã đó cùng tên và mật khẩu để tạo **admin** đầu tiên; gate đăng nhập luôn cho bạn. Có tài khoản rồi thì trang này tự khóa. Nhập sai mã nhiều lần cũng bị khóa tạm, giống như đăng nhập sai.

## Tự đăng ký và quản trị trên web

- **Đăng ký** (`/gate/register`, có link ở trang đăng nhập): người dùng tự chọn tên và mật khẩu. Tài khoản mới ở trạng thái *chờ duyệt* và chưa đăng nhập được. Tên dành riêng (`admin`, `root`, `public`…) bị chặn. Mỗi IP gửi tối đa 5 đơn mỗi giờ, và tổng số đơn chờ duyệt không vượt quá 50.
- **Quản trị** (`/gate/admin`, nút "Quản trị" trên thanh đầu trang, chỉ admin thấy):
  - duyệt hoặc từ chối đơn đăng ký;
  - khóa hoặc mở khóa tài khoản;
  - cấp hoặc bỏ quyền admin;
  - đặt lại mật khẩu;
  - bật hoặc tắt tự đăng ký;
  - xem nhật ký.

  Khi khóa, đổi vai trò hoặc đặt lại mật khẩu, phiên đăng nhập cũ của người đó mất hiệu lực ngay và các kết nối đang mở bị cắt. Admin không tự khóa hay tự hạ quyền mình được, và hệ thống luôn còn ít nhất một admin.
- **Đặt lại mật khẩu:** gate sinh một mật khẩu tạm và hiện **một lần** cho admin. Lần đăng nhập sau, người dùng bị bắt đổi mật khẩu mới trước khi dùng tiếp.
- **Đổi mật khẩu** (`/gate/password`): ai cũng dùng được. Các phiên đăng nhập khác của người đó bị đăng xuất.

## Tài khoản (dòng lệnh)

Chạy trong thư mục này, với `GATE_VAR_DIR=E:\Deepseek_Harness\runtime\gate-var`:

| Lệnh | Việc |
|---|---|
| `node bin/gate.mjs user add <tên> [--role admin]` | Tạo tài khoản; hỏi mật khẩu 2 lần (tối thiểu 8 ký tự) |
| `node bin/gate.mjs user passwd <tên>` | Đổi mật khẩu; mọi phiên đăng nhập cũ bị hủy |
| `node bin/gate.mjs user disable\|enable <tên>` | Khóa hoặc mở khóa tài khoản |
| `node bin/gate.mjs user approve\|reject <tên>` | Duyệt hoặc từ chối đơn tự đăng ký |
| `node bin/gate.mjs user list` | Liệt kê tài khoản |
| `node bin/gate.mjs audit [n]` | Xem n dòng nhật ký gần nhất |

Tên tài khoản của người dùng chính là tên thư mục `storage/users/<tên>`. Tài khoản admin làm việc trong `storage/admin` với chế độ DocShield Admin.

## Bảo mật

- Mật khẩu băm bằng scrypt (N=16384, r=8, p=1).
- Cookie `gate_session` được ký HMAC-SHA256, có HttpOnly, SameSite=Lax, hết hạn sau 12 giờ. Cookie mang `credential_version`, nên khi đổi mật khẩu hoặc khóa tài khoản thì mọi cookie cũ mất hiệu lực.
- Form đăng nhập có CSRF (double-submit).
- Sai 5 lần thì khóa tạm, thời gian khóa tăng dần 1 → 5 → 15 → 60 phút. Một IP sai quá 50 lần trong 15 phút cũng bị khóa. Người dùng không tồn tại vẫn tốn thời gian kiểm tra như người dùng có thật, để không lộ tên tài khoản.
- Chưa đăng nhập thì mọi trang bị chuyển sang trang đăng nhập; mọi `/api/*` và WebSocket trả 401.
- Tham số `next` chỉ chấp nhận đường dẫn tương đối, để chặn chuyển hướng ra ngoài.
- DSH chỉ nghe trên 127.0.0.1 ở một cổng ngẫu nhiên, và cookie của DSH chỉ gate giữ. Gọi thẳng vào DSH mà không có cookie thì DSH tự chặn.

## Giới hạn hiện tại

- Người dùng thường chỉ có công cụ DocShield (guard của DocShield chặn công cụ khác trong `storage/`). Muốn trả lại shell/file cho agent thì cần sandbox chỉ chứa công cụ cho từng người; đó là bước tiếp theo.
- Lịch sử chat của kiến trúc cũ (mỗi người một DSH) không chuyển sang DSH chung. Tài liệu và DB DocShield thì giữ nguyên.

## Phát triển

```
npm test     # node:test, không có dependency ngoài
```
Gồm test luật lọc, mã hóa WebSocket, bộ lọc với một DSH giả nói đúng giao thức thật, và đăng nhập/quản trị.
