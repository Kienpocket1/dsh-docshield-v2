# H2 trên tập dev (12 câu, model qwen3:8b)

| Nhãn | n | dung | mot-phan | tu-choi | sai | bia | loi-chay | loi-cham | trích đúng nguồn | tạo phiếu | token TB | giây TB |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| tim-kiem-truot | 4 | 1 | 1 | 2 | 0 | 0 | 0 | 0 | 2/4 | 1 | 24039 | 715 |
| nhieu-buoc | 4 | 1 | 1 | 0 | 0 | 1 | 1 | 0 | 3/3 | 0 | 20278 | 517 |
| cu-mau-thuan | 4 | 2 | 0 | 0 | 0 | 1 | 1 | 0 | 3/3 | 0 | 16651 | 518 |
| TỔNG | 12 | 4 | 2 | 2 | 0 | 2 | 2 | 0 | 8/10 | 1 | 20694 | 597 |

Phiếu đề xuất JSON hợp lệ: 7/12; chẩn đoán trùng nhãn: 1/12; đã kiểm chứng trích dẫn: 6/12

## Câu tạo phiếu hỗ trợ (đầu vào cho agent xử lý phiếu)

- q14 (tim-kiem-truot, tu-choi): phiếu 115

## Câu không đúng

- q14 (tim-kiem-truot) tu-choi: chatbot chuyển phiếu hỗ trợ thay vì trả lời trực tiếp
- q15 (tim-kiem-truot) mot-phan: Câu trả lời chatbot thêm thông tin về việc cần cung cấp giấy xác nhận bệnh tật, điều này không có trong đáp án chuẩn và có thể gây hiểu lầm về quy trình hoãn thi.
- q17 (tim-kiem-truot) tu-choi: chatbot nói không tìm thấy thông tin
- q30 (nhieu-buoc) bia: chatbot khẳng định mức học phí 700.000 VND/tín chỉ cho học kỳ chính, nhưng đáp án chỉ nêu mức hè là 1,5 × 700.000 = 1.050.000 đ/TCHP. Chatbot đưa ra thông tin cụ thể về mức học phí học kỳ chính mà không có trong đáp án.
- q33 (nhieu-buoc) loi-chay: quá 1800s
- q38 (nhieu-buoc) mot-phan: trả lời đúng mức cảnh báo nhưng sai về số tín chỉ tối đa được đăng ký
- q46 (cu-mau-thuan) loi-chay: quá 1800s
- q48 (cu-mau-thuan) bia: khẳng định công thức cụ thể không có trong đáp án và trái với quy định hiện hành
