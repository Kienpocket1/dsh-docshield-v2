# H0 trên tập dev (44 câu, model qwen3:8b)

| Nhãn | n | dung | mot-phan | tu-choi | sai | bia | loi-chay | loi-cham | trích đúng nguồn | tạo phiếu | token TB | giây TB |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| truc-tiep | 9 | 8 | 0 | 0 | 0 | 1 | 0 | 0 | 7/9 | 0 | 8643 | 196 |
| tim-kiem-truot | 10 | 6 | 2 | 2 | 0 | 0 | 0 | 0 | 7/10 | 1 | 7044 | 196 |
| nhieu-buoc | 11 | 5 | 3 | 2 | 0 | 0 | 1 | 0 | 5/10 | 2 | 6955 | 202 |
| cu-mau-thuan | 6 | 4 | 1 | 1 | 0 | 0 | 0 | 0 | 3/6 | 1 | 8408 | 197 |
| mo-ho | 4 | 0 | 1 | 0 | 0 | 3 | 0 | 0 | 0/3 | 0 | 7220 | 217 |
| thieu | 4 | 4 | 0 | 0 | 0 | 0 | 0 | 0 | 0/0 | 3 | 9863 | 179 |
| TỔNG | 44 | 27 | 7 | 5 | 0 | 4 | 1 | 0 | 22/38 | 7 | 7827 | 198 |

## Câu tạo phiếu hỗ trợ (đầu vào cho agent xử lý phiếu)

- q17 (tim-kiem-truot, tu-choi): phiếu 107
- q29 (nhieu-buoc, tu-choi): phiếu 108
- q32 (nhieu-buoc, tu-choi): phiếu 109
- q46 (cu-mau-thuan, tu-choi): phiếu 110
- q54 (thieu, dung): phiếu 111
- q55 (thieu, dung): phiếu 112
- q58 (thieu, dung): phiếu 113

## Câu không đúng

- q08 (truc-tiep) bia: chatbot đưa ra số liệu cụ thể (26 triệu đồng/năm) nhưng đáp án chuẩn là 28,5 triệu đồng/năm, thông tin này không có trong đáp án và trái với đáp án.
- q14 (tim-kiem-truot) mot-phan: Câu trả lời của chatbot chứa thông tin không đúng so với đáp án chuẩn, như việc cho phép retake môn học ở hình thức chính quy và quy định về điểm sau thi lại không vượt quá C, điều này không được nêu trong đáp án chuẩn.
- q17 (tim-kiem-truot) tu-choi: chatbot chuyển phiếu hỗ trợ thay vì đưa ra đáp án
- q24 (tim-kiem-truot) tu-choi: chatbot nói không tìm thấy thông tin cụ thể về số tín chỉ để được tính là sinh viên năm ba, nhưng đáp án chuẩn lại có thông tin rõ ràng (từ 64 đến 95 tín chỉ).
- q27 (tim-kiem-truot) mot-phan: Câu trả lời của chatbot bổ sung thêm yêu cầu 'Hợp tác với nhà trường' không có trong đáp án chuẩn, đồng thời diễn đạt một số chi tiết khác một cách chi tiết hơn, nhưng vẫn có phần trùng lặp và đúng với đáp án.
- q29 (nhieu-buoc) tu-choi: chatbot chuyển phiếu hỗ trợ thay vì đưa ra đáp án
- q32 (nhieu-buoc) tu-choi: chatbot chuyển phiếu hỗ trợ mà không đưa ra đáp án
- q35 (nhieu-buoc) mot-phan: câu trả lời đúng phần công thức tính điểm học phần, nhưng thiếu thông tin về thang điểm chữ theo quy định của Đại học Bách khoa Hà Nội, thay vào đó đưa ra ví dụ thang điểm phổ biến không phải là đáp án chuẩn.
- q38 (nhieu-buoc) loi-chay: quá 1800s
- q39 (nhieu-buoc) mot-phan: trả lời đúng phần nâng mức cảnh báo nhưng sai về mức cảnh báo (nên là mức 3, không phải mức 2), đồng thời thiếu thông tin về giới hạn đăng ký cho chương trình ELITECH và hợp tác quốc tế.
- q42 (nhieu-buoc) mot-phan: Câu trả lời chatbot có thông tin về tổng số tín chỉ (60 TC) và phân bổ 12 TC từ cử nhân, 48 TC KSCS, nhưng thiếu thông tin chính xác về việc công nhận 12 TC từ bảng điểm cử nhân (ghi điểm R, không tính CPA) và không nêu rõ điều kiện công nhận. Ngoài ra, phần 'được phép học tích lũy trước tối đa 15 tín chỉ' không có trong đáp án chuẩn.
- q46 (cu-mau-thuan) tu-choi: chatbot nói không tìm thấy / không có thông tin / chuyển phiếu hỗ trợ / hỏi lại, không đưa ra đáp án.
- q51 (cu-mau-thuan) mot-phan: Câu trả lời của chatbot khẳng định học kỳ chính được chia thành 2 đợt A và B mà không phân biệt quy chế cũ hay mới, trong khi đáp án chỉ nêu rõ quy chế cũ 2023 có quy định này, còn quy chế hiện hành 2025 không còn chia đợt A/B. Do đó, câu trả lời thiếu thông tin quan trọng về sự thay đổi theo quy chế mới.
- q60 (mo-ho) bia: đưa ra số liệu cụ thể (720.000, 780.000, 26 triệu) không có trong đáp án chuẩn, đồng thời không phù hợp với thông tin trong đáp án (đáp án chỉ nêu ví dụ cho chương trình chuẩn năm 2026-2027, không phân biệt ngành cụ thể như kỹ thuật, công nghệ, kinh tế).
- q61 (mo-ho) bia: Chatbot khẳng định số tín chỉ cụ thể là 30 tín chỉ, nhưng đáp án cho rằng câu hỏi mơ hồ và không cung cấp thông tin cụ thể. Đáp án chuẩn không nêu rõ số tín chỉ nào, do đó thông tin 30 tín chỉ là không có trong đáp án và không thể suy ra từ nội dung được cung cấp.
- q63 (mo-ho) bia: chatbot đưa ra chi tiết cụ thể về các loại học bổng, điều kiện xét, công thức tính điểm và các trường hợp không xét, nhưng đáp án chỉ nói rằng câu hỏi mơ hồ và yêu cầu hỏi lại loại học bổng. Chatbot đã tự đưa thông tin chi tiết mà không được xác nhận trong đáp án.
- q64 (mo-ho) mot-phan: trả lời đúng một phần về thời gian nghỉ học tạm thời là 4 học kỳ, nhưng không giải thích rõ câu hỏi ban đầu là mơ hồ và không đề cập đến các trường hợp khác như thời gian chậm tiến độ hoặc nộp bài thi trực tuyến.
