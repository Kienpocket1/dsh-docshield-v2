# Project 3 — Danh sách việc

Đề tài: agent xử lý phiếu hỗ trợ cho admin DocShield (H0–H3) + chatbot model local fine-tune + reranker (C0–C3). Hạn báo cáo: cuối 1/2027.
Kế hoạch chi tiết: `process.md`. Tích `[x]` khi xong, ghi ngày.

## 0. Chuẩn bị
- [x] Hạ tầng: bộ chạy phiên `agent.py` + `dsh.py`, tài khoản `p3agent`, gate cho chọn preset riêng (14/11)
- [x] Model local Ollama `qwen3:8b`, provider DSH `ollama-local` (14/11)
- [x] Tải kho tài liệu ĐHBK Hà Nội: 24 PDF vào `corpus/hust/` (15/11)
- [x] Bỏ phụ thuộc `E:\Deepseek_Harness`, rebuild + test web (15/11)
- [x] Dọn thư mục Company, xóa đồ đề tài sự cố + LibreChat (19/11)

## 1. Kho tài liệu + bộ câu hỏi + H0 (tuần 3–4/11)
- [x] OCR 10 PDF scan (10–17, 19, 20) bằng ocrmypdf + Tesseract `vie` (image `congty-ocr:dev`); bản scan gốc ở `corpus/hust/scan-goc/`; 11–13 có chữ ký số (bị vô hiệu sau OCR) (20/11)
- [x] Nạp 24 PDF vào `public_docs` (tất cả có chunk); gỡ 3 PDF toán cũ — chỉ khôi phục được `Bai_5-4_Loi_giai.pdf` vào `corpus/da-go-khoi-docshield/` (20/11)
- [x] Chủ đề cố ý thiếu: ký túc xá, BHYT, cách chấm điểm rèn luyện, cấp lại thẻ SV, lịch nghỉ Tết 2027, học phí 2027-2028 (20/11)
- [x] Bộ 64 câu `data/questions.jsonl` (đáp án, bằng chứng nguyên văn, nhãn: truc-tiep / tim-kiem-truot / nhieu-buoc / cu-mau-thuan / mo-ho / thieu) (20/11)
- [x] Chia dev 44 / test 20 theo nhãn (trường `split`) (20/11)
- [x] Bộ chấm `eval.py grade`: giám khảo qwen3:8b (dung/mot-phan/tu-choi/sai/bia), trích đúng nguồn, phiếu, token/thời gian (20/11)
- [x] Chạy H0 (preset `docshield`) trên dev → `results/H0-dev.md`: 27/44 đúng, 4 bịa, 7 phiếu (20/11)

## 2. Agent xử lý phiếu v1 + H1–H3 (tuần 1/12)
- [x] Định dạng phiếu đề xuất JSON (chẩn đoán, câu trả lời + trích dẫn, đề xuất cập nhật kho, phiếu lý do) — `docshield/presets/p3-ticket-rules.txt` (20/11)
- [x] Preset `p3-h1` (tìm lại nhiều lượt + chạy mã), `p3-h2` (+ plan/todo), `p3-h3` (+ subagent) trong `container/make-harness-presets.mjs`, thêm vào `GATE_USER_EXTRA_PRESETS` (20/11)
- [x] Chạy H1–H3 trên dev, sửa prompt (21/11): H1 44 câu, H1v2 22 câu sai, H2/H3 12 câu khó (`results/hard12-ids.txt`). Trên 12 câu: đúng H0 7, H1v2 6, H2 4, H3 5; bịa 0/2/2/1 → qwen3:8b yếu với vòng agent dài
- [x] Demo agent xử lý 1 phiếu khó (21/11): q29 học phí, H1 trả lời đúng 14.000.000 đ có trích dẫn, nhưng không xuất JSON, 29 phút (`results/demo-q29.txt`). Web không đổi preset được cho user → tạo phiên bằng `agent.run_session`
- [x] Thử H1 với model API free (DeepSeek V4 Flash, OrcaRouter) trên 5 câu H0 hỏng (`H1api`) (21/11): 3 đúng, 2 một phần, 0 bịa, JSON 5/5, kiểm chứng 5/5, ~3,4 phút/câu, ~120k token/câu (8B: 2 đúng/5, ~12 phút)
- [ ] Chỉ số "cứu câu H0 hỏng" trong `eval.py` (đo agent đúng vai trò: chỉ chạy trên câu chatbot hỏng). Đếm tay 12 câu khó: H0 + H1v2 = 9/12, H0 = 7/12
- [ ] Chọn model cho agent (8B local yếu với vòng dài; H0 giữ qwen3:8b), chạy lại agent chỉ trên 17 câu H0 hỏng ở dev

## 3. Fine-tune chatbot + reranker (thay H4 nguồn ngoài, đổi hướng 24/11)
- [x] Chốt model fine-tune: `qwen3:4b` (24/11)
- [ ] Đo mốc C0 trên dev: `qwen3:4b` và `qwen3:8b` (tắt thinking)
- [ ] Cài WSL2 + Unsloth, thử train mẫu nhỏ trên RTX 4050
- [ ] Bộ dữ liệu tiêu chí B (~400 mẫu, không trùng dev/test); bạn xem lướt 30–50 mẫu
- [ ] Train QLoRA → GGUF → Ollama `docshield-4b`; đo C2
- [ ] Reranker `bge-reranker-v2-m3` trong `search.ts` + worker ONNX; hiệu chỉnh ngưỡng; `npm test`; đo C1, C3

## 4. Duyệt + tập test (tuần 3–4/12)
- [ ] Chuyển agent sang phía admin: preset p3-h* cho admin, đọc phiếu THẬT (H0 tạo bằng `create_support_ticket`, có câu trả lời hỏng của chatbot) thay cho mẫu `TICKET` giả lập chỉ chứa câu hỏi
- [ ] Luồng duyệt: admin duyệt/sửa/từ chối → `update_ticket` trả lời người hỏi, cập nhật kho
- [ ] Đo "bồi đắp": hỏi lại câu tương tự sau khi kho được cập nhật
- [ ] Chạy H0–H4 trên tập test → bảng kết quả chính (RQ1, RQ2)

## 5. RQ3 + phân tích (tuần 1/1)
- [ ] Chốt số người duyệt (bạn + ?) — chờ bạn
- [ ] Thí nghiệm duyệt có/không phiếu lý do
- [ ] Chấm tay ~20% kết quả — bạn làm
- [ ] Phân tích lỗi, chi phí token/thời gian

## 6. Báo cáo (tuần 2–4/1)
- [ ] Báo cáo `.tex`
- [ ] Slide
- [ ] Video demo
