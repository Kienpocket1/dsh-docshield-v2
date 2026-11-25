# H3 trên tập dev (12 câu, model qwen3:8b)

| Nhãn | n | dung | mot-phan | tu-choi | sai | bia | loi-chay | loi-cham | trích đúng nguồn | tạo phiếu | token TB | giây TB |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| tim-kiem-truot | 4 | 1 | 1 | 1 | 1 | 0 | 0 | 0 | 2/4 | 0 | 21333 | 671 |
| nhieu-buoc | 4 | 2 | 1 | 0 | 0 | 0 | 1 | 0 | 2/3 | 0 | 21783 | 749 |
| cu-mau-thuan | 4 | 2 | 0 | 0 | 1 | 1 | 0 | 0 | 3/4 | 0 | 20946 | 531 |
| TỔNG | 12 | 5 | 2 | 1 | 2 | 1 | 1 | 0 | 7/11 | 0 | 21315 | 642 |

Phiếu đề xuất JSON hợp lệ: 11/12; chẩn đoán trùng nhãn: 0/12; đã kiểm chứng trích dẫn: 10/12

## Câu tạo phiếu hỗ trợ (đầu vào cho agent xử lý phiếu)

- (không có)

## Câu không đúng

- q14 (tim-kiem-truot) mot-phan: đáp án chuẩn nói rõ không được thi lại, phải đăng ký học lại; câu trả lời chatbot thêm thông tin 'trừ trường hợp đặc biệt' không có trong đáp án, gây hiểu nhầm quy định.
- q17 (tim-kiem-truot) tu-choi: chatbot nói không tìm thấy thông tin
- q21 (tim-kiem-truot) sai: Câu trả lời của chatbot cho rằng 8,7 là B+ và 3,5 trên thang 4, nhưng đáp án chuẩn là 8,5–9,4 là A và 4,0 trên thang 4. Do đó, chatbot đã sai về cả điểm chữ và quy đổi thang điểm.
- q29 (nhieu-buoc) loi-chay: quá 1800s
- q38 (nhieu-buoc) mot-phan: trả lời đúng mức cảnh báo nhưng sai số tín chỉ tối đa được đăng ký
- q46 (cu-mau-thuan) sai: Đáp án chuẩn quy định hiện hành là 6 tín chỉ, nhưng chatbot đưa ra 8 tín chỉ (quy định cũ).
- q48 (cu-mau-thuan) bia: khẳng định công thức cụ thể không có trong đáp án và trái với quy định hiện hành
