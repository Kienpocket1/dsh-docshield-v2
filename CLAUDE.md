# DSH-DocShield — ghi chú cho agent

Người dùng viết tiếng Việt; trả lời tiếng Việt. Không push lên GitHub (chỉ commit trên máy) trừ khi người dùng yêu cầu.

## Bố cục máy (ngoài repo)
- `E:\Deepseek_Harness\runtime\` là môi trường chạy thật: `dsh\` (DSH 0.1.6-alpha.2 sạch từ npm), `home\` (DSH_HOME + `runtime.patch.yml`), `storage\` (**dữ liệu thật**), `gate-var\` (tài khoản, khóa cookie). DSH lưu workspace/phiên theo đường dẫn tuyệt đối: không đổi tên/di chuyển.
- `E:\Deepseek_Harness\spike-dshpw\` là môi trường cũ (dsh-passwords, bản DSH đã bị vá) — chỉ còn để tham khảo, sẽ chuyển vào `_archive`.
- `E:\Deepseek_Harness\deepseek-harness\` là mã nguồn DSH gốc — chỉ đọc, không sửa.
- `E:\Deepseek_Harness\start-gate.cmd` (CRLF — sửa bằng Write/Edit rồi đổi lại CRLF; không dùng `sed -i`, vì sed của Git Bash đổi sang LF).
- `E:\Deepseek_Harness\_backup\` bản sao lưu dữ liệu thật (có API key, mật khẩu băm) — không đưa đi đâu.

## Bẫy
- Profile `runtime\home\profiles\web\node_modules\{dsh-docshield,dsh-gate}` là junction trỏ vào `dsh-docshield\docshield` và `dsh-docshield\gate`. Đổi chỗ package thì sửa junction và `package.json` của profile.
- Gate được plugin bật như tiến trình con của DSH: sửa code gate phải khởi động lại cả DSH.
- Bộ lọc gate viết theo định dạng dây DSH 0.1.6-alpha.2 và **mặc định chặn**. Chức năng giao diện bị hỏng với tài khoản thường → xem log `gate: deny …` để biết endpoint nào cần thêm vào `gate/src/policy.mjs`.
- Muốn thử end-to-end thì dựng DSH_HOME/storage/gate-var riêng (patch đổi `storageRoot`, `varDir`, cổng gate), không thử trên `runtime\`.
- Không tự bật/tắt DSH của người dùng; hỏi trước.
- Repo GitHub là public: không đưa báo cáo LaTeX (`E:\Deepseek_Harness\bao-cao\`) hay dữ liệu thật vào.
