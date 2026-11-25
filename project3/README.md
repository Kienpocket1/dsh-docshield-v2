# Project 3 — Agent xử lý phiếu hỗ trợ cho admin DocShield

Đề xuất: `de-xuat-project3.tex`. Tiến độ và kế hoạch: `process.md`.

| Thành phần | Nội dung |
|---|---|
| `corpus/hust/` | 24 PDF công khai của ĐHBK Hà Nội (nguồn trong `sources.tsv`); `cu-*` là bản cũ, dùng cho câu hỏi "tài liệu cũ/mâu thuẫn". 10 bản scan đã OCR (gốc ở `scan-goc/`); cả 24 file đã nạp vào `public_docs` |
| `corpus/text/` | Text trích từ PDF (sau OCR), dùng để kiểm tra bằng chứng |
| `data/questions.jsonl` | 64 câu hỏi: đáp án, bằng chứng nguyên văn, nhãn trượt, `split` dev/test |
| `eval.py` | `check` · `run H0 <split>` (chatbot, tạo phiếu thật) · `tickets H1\|H2\|H3 <split>` (agent phía admin xử lý các phiếu đó) · `reask <split>` (bồi đắp) · `grade <cfg> <split>` → `results/`; bảng H1+ có chỉ số "cứu câu H0 hỏng" |
| `worker.py` | Agent tự xử lý phiếu: quét phiếu `open` → agent `p3-h*` dưới `p3admin` → đề xuất lưu ở DocShield; admin duyệt ở `/gate/admin/tickets` |
| `dsh.py` | Đăng nhập gate (`127.0.0.1:3454`): `p3agent` (user, H0) hoặc `p3admin` (admin dịch vụ, agent); mật khẩu `.<tên>-pass`, không vào git |
| `agent.py` | `run_session(...)`: tạo phiên DSH với preset/model, gửi prompt, chờ xong, trả câu trả lời + token/bước/thời gian; `put(...)` chép file vào workspace `/data/users/p3agent/p3` |
| `llm.py` | Gọi model trực tiếp qua 9Router (`127.0.0.1:20128`), dùng cho giám khảo/sinh dữ liệu |
| `pilot/` | Bộ thử prompt injection cũ, có thể dùng cho web giả lập ở H4 |

Model: local `qwen3:8b` qua Ollama (provider DSH `ollama-local`, mặc định của `agent.py`; đổi bằng `P3_PROVIDER`).
Chạy script bằng `python -X utf8 <file>.py` trong thư mục này.

## Luồng phiếu (mục 4)

```
user hỏi chatbot (H0, docshield) ─► không tìm thấy ─► create_support_ticket (phiếu open)
worker.py ─► agent p3-h* phía admin (đọc phiếu + đoạn chat, tìm lại, chạy mã; không có tool ghi) ─► đề xuất (nháp, người hỏi chưa thấy)
admin /gate/admin/tickets ─► duyệt (sửa được) / từ chối ─► người hỏi thấy "Phản hồi của cán bộ"; tùy chọn thêm vào kho hỏi đáp
```

Worker tự bật cùng `start.cmd` (cửa sổ "P3 worker") khi `local.cmd` có `set "P3_WORKER=1"`; model chọn bằng
`P3_PROVIDER` / `P3_RUN_MODEL` trong `local.cmd` (mặc định 9Router `gemini/gemini-3-flash-preview`). Chạy tay:

```
python -X utf8 worker.py                     # chạy mãi, xử lý phiếu mới (P3_PROVIDER/P3_RUN_MODEL chọn model)
python -X utf8 eval.py run H0 test           # chatbot trên tập test, tạo phiếu thật
python -X utf8 eval.py tickets H1 test       # agent xử lý các phiếu đó (lặp cho H2, H3)
python -X utf8 eval.py grade H1 test         # chấm + "cứu câu H0 hỏng"
```
