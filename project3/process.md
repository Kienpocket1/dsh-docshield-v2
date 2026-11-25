# Project 3 — Tiến độ và kế hoạch

**Đề tài (đã chốt 14/11/2026): Agent xử lý phiếu hỗ trợ của DocShield cho quản trị viên.**
Đề xuất gốc: `project3/de-xuat-project3.tex` (chép từ bản đồ án). Hạn báo cáo: cuối tháng 1/2027.

> **Đổi hướng 24/11/2026 (theo thầy):** bỏ phần mở rộng tìm nguồn ngoài (agent con có internet, H4).
> Thay bằng **fine-tune model local để chatbot chính xác một tiêu chí cho người dùng**, kèm **reranker**.
> Phần agent xử lý phiếu (H0–H3) giữ nguyên.

## 1. Đề tài làm gì

Người dùng hỏi DocShield → không tìm thấy trong tài liệu chung → DocShield tạo **phiếu hỗ trợ** (`TICK-…`).

**Phía người dùng (mới):** chatbot chạy `qwen3:4b` local đã fine-tune, phân biệt đúng câu có/không có trong tài liệu.

- **Tiêu chí fine-tune (B): biết nói "không biết" đúng lúc.** Tài liệu có → trả lời theo tài liệu, có trích dẫn. Tài liệu không có → nói rõ không có và tạo phiếu, không bịa.
- **Reranker** `bge-reranker-v2-m3` (ONNX offline) chấm lại ~20 đoạn sau bước tìm kiếm lai (bge-m3 + BM25), ngưỡng theo điểm rerank. Sửa lỗi đã thấy ở M0: câu bẫy có độ giống cosine cao ngang câu thật.
- Hai lớp chặn bịa: reranker lọc đoạn không liên quan, model fine-tune từ chối khi đoạn không trả lời được.

**Phía admin (giữ nguyên):** agent nhận phiếu và làm thay phần việc lặp lại của admin:

1. **Chẩn đoán** vì sao chatbot trượt: tìm kiếm trượt (tài liệu có nhưng khác từ) · cần nhiều bước (tổng hợp, tính toán) · tài liệu thiếu · tài liệu cũ/mâu thuẫn · câu hỏi mơ hồ.
2. **Tự tìm lại trong kho nội bộ**: viết lại câu hỏi, tra nhiều tài liệu, tính toán bằng mã trong sandbox. Trích dẫn vẫn qua bộ kiểm tra nguyên văn của DocShield.
3. **Soạn phiếu đề xuất** cho admin: câu trả lời có trích dẫn (hoặc "tài liệu thật sự không có"), đề xuất cập nhật kho, **phiếu lý do** (chẩn đoán + bằng chứng đã tra).
4. **Admin duyệt / sửa / từ chối.** Chỉ khi duyệt mới trả lời người hỏi và cập nhật kho.

Câu hỏi nghiên cứu:
- **RQ1** agent trả lời thêm được bao nhiêu câu chatbot hỏng, có bịa nhiều hơn không.
- **RQ2** cơ chế harness nào giúp (chạy mã, plan, subagent).
- **RQ3** phiếu lý do có giúp người duyệt bắt đề xuất sai không.
- **RQ4 (mới)** fine-tune + reranker trên model 4B có giảm bịa, tăng từ chối đúng, nhanh hơn 8B gốc không.

Cấu hình:
- Chatbot: **C0** model gốc · **C1** + reranker · **C2** + model fine-tune · **C3** cả hai. Đo thêm `qwen3:8b` gốc làm mốc.
- Agent: **H0** RAG thuần (DocShield hiện tại) · **H1** agent + tìm lại + chạy mã · **H2** + plan · **H3** + subagent. (H4 nguồn ngoài: bỏ.)

## 2. Đã có (dùng lại được)

| Thành phần | Trạng thái |
|---|---|
| DocShield: RAG lai (bge-m3 + BM25/FTS5, RRF, `belowThreshold`), trích dẫn kiểm chứng, tạo phiếu, công cụ admin | có sẵn |
| Gate, sandbox container riêng, egress proxy | có sẵn |
| Bộ chạy phiên `agent.py` + `dsh.py`, `worker.py`, bảng `ticket_proposals`, trang duyệt `/gate/admin/tickets` | có sẵn |
| Kho 24 PDF ĐHBK, bộ 64 câu (dev 44 / test 20), bộ chấm `eval.py` | có sẵn |
| Model local Ollama `qwen3:8b` (provider `ollama-local`) | chạy được, chậm (~200 s/bước): 8B không vừa 6 GB VRAM, tràn sang CPU |
| Máy: RTX 4050 6 GB VRAM | đủ train QLoRA 4B, chạy 4B trọn trong GPU |

## 3. Kế hoạch (từ 24/11, model miễn phí)

| Tuần | Việc | Sản phẩm |
|---|---|---|
| 4/11 | Đo mốc chatbot trên dev: `qwen3:4b` (model đã chốt 24/11) và `qwen3:8b` (tắt thinking) — đúng, bịa, từ chối đúng, thời gian. Cài WSL2 + Unsloth | Bảng mốc C0 |
| 1/12 | Bộ dữ liệu tiêu chí B (~400 mẫu từ kho ĐHBK, nửa có / nửa không có trong tài liệu, thêm câu không dấu, viết tắt); train QLoRA; xuất GGUF → Ollama `docshield-4b`; đo C2 | Model fine-tune + bảng C0/C2 |
| 2/12 | Reranker trong `docshield/src/retrieval/search.ts` + worker ONNX; hiệu chỉnh ngưỡng trên dev; đo C1, C3; `npm test` | Bảng C0–C3 (RQ4) |
| 3–4/12 | Agent: chỉ số "cứu câu H0 hỏng", chọn model agent, chạy H1–H3 trên câu hỏng; luồng duyệt + đo "bồi đắp"; chạy tập test | Bảng kết quả chính (RQ1, RQ2) |
| 1/1 | **RQ3** người duyệt (có/không phiếu lý do); phân tích lỗi, chi phí | Kết quả RQ3 |
| 2–4/1 | Báo cáo, slide, video demo | Nộp |

Quy tắc dữ liệu: mẫu train **không** chứa câu hỏi dev/test (và không diễn đạt lại chúng); chỉ đánh giá trên dev/test.
Giảm phạm vi so với đề xuất: bộ câu hỏi 64 câu thay vì 150–200; mỗi câu chạy 1 lần; giao diện duyệt dùng trang gate có sẵn. Ghi rõ trong báo cáo.

## 4. Cần bạn quyết / cung cấp

1. Xem lướt ~30–50 mẫu train trước khi train.
2. **Người duyệt cho RQ3:** mấy người (bạn + bạn bè?).
3. **Chấm tay** ~20% kết quả.

## 5. Ghi chú
- Chưa commit git.
