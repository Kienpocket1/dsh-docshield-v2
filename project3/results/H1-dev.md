# H1 trên tập dev (44 câu, model qwen3:8b)

| Nhãn | n | dung | mot-phan | tu-choi | sai | bia | loi-chay | loi-cham | trích đúng nguồn | tạo phiếu | token TB | giây TB |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| truc-tiep | 9 | 8 | 1 | 0 | 0 | 0 | 0 | 0 | 8/9 | 0 | 17448 | 449 |
| tim-kiem-truot | 10 | 4 | 3 | 1 | 0 | 1 | 1 | 0 | 7/9 | 0 | 17778 | 418 |
| nhieu-buoc | 11 | 3 | 6 | 0 | 0 | 2 | 0 | 0 | 7/11 | 0 | 15870 | 595 |
| cu-mau-thuan | 6 | 3 | 0 | 1 | 0 | 2 | 0 | 0 | 6/6 | 0 | 15159 | 385 |
| mo-ho | 4 | 0 | 2 | 0 | 0 | 2 | 0 | 0 | 1/3 | 0 | 19950 | 716 |
| thieu | 4 | 4 | 0 | 0 | 0 | 0 | 0 | 0 | 0/0 | 0 | 14760 | 246 |
| TỔNG | 44 | 22 | 12 | 2 | 0 | 7 | 1 | 0 | 29/38 | 0 | 16777 | 477 |

Phiếu đề xuất JSON hợp lệ: 41/44; chẩn đoán trùng nhãn: 13/44; đã kiểm chứng trích dẫn: 35/44

## Câu tạo phiếu hỗ trợ (đầu vào cho agent xử lý phiếu)

- (không có)

## Câu không đúng

- q05 (truc-tiep) mot-phan: trả lời đúng phần tính bằng 1,5 lần học phí học kỳ thường nhưng sai chi tiết về 'học kỳ chính' so với đáp án, đồng thời không nêu rõ 'mục 1, 2, 3 Phụ lục I' như đáp án.
- q14 (tim-kiem-truot) loi-chay: quá 1800s
- q18 (tim-kiem-truot) bia: chatbot khẳng định thời gian nghỉ tối đa là 12 tháng, nhưng đáp án chỉ quy định nghỉ tối đa 04 học kỳ chính, không đề cập đến thời gian cụ thể như 12 tháng.
- q21 (tim-kiem-truot) mot-phan: Câu trả lời của chatbot cho rằng 8,7 là A+ nhưng đáp án chuẩn là A. Ngoài ra, chatbot cũng không nêu rõ quy đổi thang điểm chính xác như đáp án.
- q23 (tim-kiem-truot) mot-phan: Câu trả lời chatbot bổ sung thêm thông tin về thời gian tối đa học hai chương trình, nhưng thông tin này không có trong đáp án chuẩn và không liên quan trực tiếp đến câu hỏi về thời điểm đăng ký học song ngành.
- q24 (tim-kiem-truot) tu-choi: chatbot nói không tìm thấy thông tin
- q27 (tim-kiem-truot) mot-phan: Câu trả lời chatbot bổ sung thêm yêu cầu về 'chức năng giáo dục đào tạo' và trích dẫn tài liệu, nhưng không khớp với đáp án chuẩn. Đáp án chuẩn không đề cập đến 'chức năng giáo dục đào tạo' và không yêu cầu trích dẫn tài liệu.
- q30 (nhieu-buoc) bia: chatbot đưa ra mức học phí 700.000 đồng/tín chỉ mà đáp án chỉ nêu mức học phí thường là 700.000 đồng/tín chỉ, nhưng mức hè là 1,5 × 700.000 = 1.050.000 đồng/tín chỉ. Chatbot không tính đúng mức học phí theo học kỳ hè, dẫn đến kết quả sai so với đáp án.
- q32 (nhieu-buoc) bia: chatbot đưa ra số liệu cụ thể (3.150.000 đồng) không có trong đáp án chuẩn, và không thể suy ra từ thông tin đã cho.
- q35 (nhieu-buoc) mot-phan: đáp án đúng phần tính điểm học phần (7.4), nhưng sai trong cách xác định điểm chữ. Đáp án chuẩn cho điểm B là 7.0–7.9, trong khi câu trả lời cho rằng 7.4 là B và 7.5–7.9 là B+.
- q36 (nhieu-buoc) mot-phan: Câu trả lời chatbot sai chi tiết quan trọng: quy định của Đại học Bách khoa Hà Nội không quy định điểm liệt là dưới 5, mà là dưới 3.
- q38 (nhieu-buoc) mot-phan: trả lời đúng mức cảnh báo nhưng thiếu thông tin về hạn chế đăng ký tín chỉ (không nêu rõ 'hạn chế khối lượng chỉ áp dụng từ mức 2') và bỏ qua thông tin tối thiểu 12 TC.
- q39 (nhieu-buoc) mot-phan: trả lời sai mức cảnh báo (mức 2 thay vì mức 3), thiếu thông tin về giới hạn tín chỉ tối thiểu
- q42 (nhieu-buoc) mot-phan: Câu trả lời chatbot sai ở chỗ công nhận 15 tín chỉ thay vì 12 tín chỉ như đáp án. Ngoài ra, phần tính tổng tín chỉ cần học cũng không khớp với đáp án.
- q44 (nhieu-buoc) mot-phan: Câu trả lời đúng phần nguyên nhân (điểm hướng dẫn dưới 5 không được bảo vệ), nhưng thiếu thông tin về điểm bảo vệ là 0 và kết quả F, đồng thời không đề cập đến quy định cụ thể (Điều 13) như đáp án.
- q46 (cu-mau-thuan) tu-choi: chatbot nói không tìm thấy thông tin
- q48 (cu-mau-thuan) bia: khẳng định công thức cụ thể không có trong đáp án và trái với quy định hiện hành
- q51 (cu-mau-thuan) bia: chatbot khẳng định quy định chia học kỳ chính thành 2 đợt A và B mà không phân biệt quy chế cũ và hiện hành, trong khi đáp án chỉ nêu rõ quy chế cũ 2023 có quy định này, còn quy chế hiện hành 2025 không còn áp dụng.
- q60 (mo-ho) bia: chatbot đưa ra số liệu cụ thể về học phí các chương trình (thạc sĩ kỹ thuật, kinh tế, tiến sĩ, sinh viên quốc tế, học lại) mà đáp án không nêu rõ hoặc không xác nhận, trái với quy định trong đáp án
- q61 (mo-ho) mot-phan: đáp án chỉ nêu định nghĩa 1 tín chỉ và số tín chỉ tối đa được công nhận, nhưng không trả lời trực tiếp câu hỏi 'được bao nhiêu tín chỉ?' như yêu cầu. Câu hỏi mơ hồ nên cần hỏi lại, nhưng chatbot vẫn đưa thông tin thay vì từ chối.
- q63 (mo-ho) bia: chatbot đưa ra chi tiết cụ thể về điều kiện học bổng (GPA, điểm rèn luyện, số tín chỉ, các trường hợp bị loại) mà đáp án chỉ nói rằng câu hỏi mơ hồ và yêu cầu hỏi lại loại học bổng cụ thể.
- q64 (mo-ho) mot-phan: đáp án chuẩn cho rằng câu hỏi mơ hồ và cần hỏi lại, nhưng chatbot đã đưa ra thông tin cụ thể về thời gian nghỉ học tạm thời và hoàn thành luận án, thiếu sự xác nhận về tính mơ hồ của câu hỏi và không phù hợp với yêu cầu của đáp án.
