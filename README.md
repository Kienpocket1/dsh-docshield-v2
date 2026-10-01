# DSH-DocShield

Chatbot tra cứu tài liệu nội bộ cho nhiều người dùng, chạy trên **một DeepSeek Harness (DSH) dùng chung**.

| Thư mục | Nội dung |
|---|---|
| [`docshield/`](docshield/README.md) | Plugin DSH: tìm kiếm có trích dẫn kiểm chứng, nạp tài liệu, phiếu hỗ trợ, thẻ giao diện |
| [`gate/`](gate/README.md) | Plugin DSH: đăng nhập, đăng ký, quản trị tài khoản và lọc theo người dùng |
| `project3/` | Dữ liệu cho Project 3 (agent tự bồi đắp kho tri thức) |

## Chạy
```
E:\Deepseek_Harness\start-9router.cmd     # model chat
E:\Deepseek_Harness\start-gate.cmd        # 1 DSH chung + gate → http://127.0.0.1:3444
```
Dữ liệu chạy (DSH, DSH_HOME, tài liệu, tài khoản) nằm ngoài repo, trong `E:\Deepseek_Harness\runtime\`.

## Phát triển
```
npm test        # cả docshield/ và gate/
```

Nhánh `per-user-dsh` (tag `s4-per-user-dsh`) giữ kiến trúc cũ: mỗi người dùng một DSH trong container (S0–S4).
