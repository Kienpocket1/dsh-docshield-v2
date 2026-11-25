# H1v2 trên tập dev (22 câu, model qwen3:8b)

| Nhãn | n | dung | mot-phan | tu-choi | sai | bia | loi-chay | loi-cham | trích đúng nguồn | tạo phiếu | token TB | giây TB |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| truc-tiep | 1 | 0 | 1 | 0 | 0 | 0 | 0 | 0 | 1/1 | 0 | 16226 | 446 |
| tim-kiem-truot | 6 | 2 | 3 | 0 | 0 | 1 | 0 | 0 | 4/6 | 0 | 19678 | 622 |
| nhieu-buoc | 8 | 3 | 2 | 0 | 0 | 2 | 1 | 0 | 5/7 | 0 | 22975 | 652 |
| cu-mau-thuan | 3 | 0 | 0 | 1 | 1 | 1 | 0 | 0 | 2/3 | 0 | 16889 | 400 |
| mo-ho | 4 | 2 | 1 | 0 | 0 | 1 | 0 | 0 | 2/3 | 1 | 18432 | 459 |
| TỔNG | 22 | 7 | 7 | 1 | 1 | 5 | 1 | 0 | 14/20 | 1 | 19977 | 561 |

Phiếu đề xuất JSON hợp lệ: 19/22; chẩn đoán trùng nhãn: 4/22; đã kiểm chứng trích dẫn: 14/22

## Câu tạo phiếu hỗ trợ (đầu vào cho agent xử lý phiếu)

- q60 (mo-ho, dung): phiếu 114

## Câu không đúng

- q05 (truc-tiep) mot-phan: trả lời đúng phần tính bằng 1,5 lần học phí học kỳ thường nhưng sai chi tiết về 'học kỳ chính' và chưa nêu rõ 'trừ một số học phần và CTĐT kỹ sư chuyên sâu' như đáp án.
- q14 (tim-kiem-truot) bia: chatbot đưa ra thông tin cụ thể về điều kiện thi lại và học lại mà không có trong đáp án chuẩn, đồng thời không phù hợp với quy định được nêu trong đáp án
- q21 (tim-kiem-truot) mot-phan: Câu trả lời đúng phần điểm chữ A nhưng sai về quy đổi sang thang 4 (đáp án là 4,0, nhưng chatbot trả lời 3,5)
- q23 (tim-kiem-truot) mot-phan: Câu trả lời chatbot thêm thông tin không có trong đáp án chuẩn như 'duy trì kết quả học tập trong cả hai chương trình', 'thời gian tối đa học là thời gian quy định cho chương trình đầu tiên', 'đăng ký tốt nghiệp cùng đợt cho cả hai chương trình'.
- q27 (tim-kiem-truot) mot-phan: Câu trả lời chatbot thiếu một số yêu cầu quan trọng như hỗ trợ phát triển kỹ năng, cam kết bố trí cán bộ hướng dẫn và cơ sở vật chất, đồng thời thêm yêu cầu về chức năng giáo dục đào tạo không có trong đáp án chuẩn.
- q30 (nhieu-buoc) bia: chatbot tính sai mức học phí hè, bỏ qua hệ số 1,5 trong công thức tính, dẫn đến kết quả sai so với đáp án chuẩn.
- q32 (nhieu-buoc) bia: chatbot đưa ra số liệu cụ thể (1.980.000 đồng) không có trong đáp án, và không thể suy ra từ thông tin đã cho
- q38 (nhieu-buoc) mot-phan: trả lời sai số tín chỉ tối đa được đăng ký
- q39 (nhieu-buoc) mot-phan: trả lời đúng mức cảnh báo nhưng sai về số tín chỉ bị trượt và quy định giới hạn đăng ký
- q42 (nhieu-buoc) loi-chay: quá 1800s
- q46 (cu-mau-thuan) tu-choi: chatbot nói không tìm thấy thông tin
- q48 (cu-mau-thuan) sai: Câu trả lời khẳng định công thức tính điểm xét học bổng KKHT theo công thức cụ thể, trong khi đáp án chỉ nói đó là công thức của quy định cũ năm 2020 và hiện hành là xét theo GPA không dùng công thức đó.
- q51 (cu-mau-thuan) bia: Chatbot khẳng định quy định chia học kỳ chính thành 2 đợt A và B mà không nêu rõ đây là quy định của quy chế cũ 2023, đồng thời không đề cập đến quy chế hiện hành 2025 đã hủy bỏ quy định này, dẫn đến thông tin sai lệch so với đáp án chuẩn.
- q61 (mo-ho) bia: Chatbot khẳng định số tín chỉ cụ thể (132 tín chỉ) mà đáp án không đề cập, đồng thời không có thông tin này trong kho tài liệu.
- q63 (mo-ho) mot-phan: trả lời chi tiết về học bổng KKHT nhưng không đề cập đến học bổng Trần Đại Nghĩa, mà đáp án chỉ ra câu hỏi mơ hồ và yêu cầu hỏi lại loại học bổng
