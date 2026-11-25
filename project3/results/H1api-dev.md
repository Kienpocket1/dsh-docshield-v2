# H1api trên tập dev (5 câu, model deepseek/deepseek-v4-flash-free)

| Nhãn | n | dung | mot-phan | tu-choi | sai | bia | loi-chay | loi-cham | trích đúng nguồn | tạo phiếu | token TB | giây TB |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| tim-kiem-truot | 2 | 1 | 1 | 0 | 0 | 0 | 0 | 0 | 2/2 | 0 | 105384 | 188 |
| nhieu-buoc | 2 | 1 | 1 | 0 | 0 | 0 | 0 | 0 | 2/2 | 0 | 96525 | 175 |
| cu-mau-thuan | 1 | 1 | 0 | 0 | 0 | 0 | 0 | 0 | 1/1 | 0 | 197601 | 283 |
| TỔNG | 5 | 3 | 2 | 0 | 0 | 0 | 0 | 0 | 5/5 | 0 | 120284 | 202 |

Phiếu đề xuất JSON hợp lệ: 5/5; chẩn đoán trùng nhãn: 3/5; đã kiểm chứng trích dẫn: 5/5

## Câu tạo phiếu hỗ trợ (đầu vào cho agent xử lý phiếu)

- (không có)

## Câu không đúng

- q17 (tim-kiem-truot) mot-phan: Câu trả lời chatbot đưa ra nhiều thông tin chi tiết hơn đáp án chuẩn, nhưng không sai. Tuy nhiên, đáp án chuẩn chỉ khẳng định 'không vắng buổi nào được cộng 1 điểm', trong khi chatbot thêm nhiều điều kiện, giải thích và nguồn tham khảo, gây hiểu nhầm về tính chính xác và đầy đủ của thông tin.
- q38 (nhieu-buoc) mot-phan: trả lời đúng phần cảnh báo mức 1 nhưng thiếu thông tin về hạn chế tín chỉ trong học kỳ chính (đúng là 24 TC) và có thêm thông tin về Quy chế 2023, Điều 19, không có trong đáp án chuẩn.
