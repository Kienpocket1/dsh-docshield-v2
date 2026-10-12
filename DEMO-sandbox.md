Cảnh 1: mỗi người một thế giới riêng.
bob gõ:

Chạy: echo "Lương bob 99 triệu" > ~/../bob/docs/luong.txt; ls -la /data /data/users

Mong đợi: /data chỉ có users, và /data/users chỉ có bob.
Ý nghĩa: container của bob chỉ mount thư mục của bob.

Cảnh 2: không đọc được dữ liệu người khác.
alice gõ:

Chạy: cat /data/users/bob/docs/luong.txt; ls /data/users

Mong đợi: No such file or directory; chỉ thấy alice.
Ý nghĩa: vùng lấy từ phiên chứ không từ đường dẫn trong lệnh; thư mục của bob không tồn tại trong container của alice.

Cảnh 3: lối tắt không giúp gì (lỗi 1 vừa sửa).
alice gõ:

Chạy: ln -s /data/users/bob ~/lt && ls ~/lt

Mong đợi: ls báo lỗi (lối tắt không trỏ tới đâu).
Tiếp theo, alice tạo phiên mới chọn thư mục users/alice/lt. Mong đợi: gate từ chối, "thư mục phiên là liên kết ra ngoài thư mục của bạn".

Cảnh 4: không phá được máy chủ.
alice gõ:

Chạy: id; touch /etc/x; rm -rf /opt 2>&1 | head -3

Mong đợi: uid=1000, Read-only file system, Permission denied.
Ý nghĩa: container read-only, không phải root, không có capability.

Cảnh 5: không vắt kiệt tài nguyên.
alice gõ:

Chạy: python3 -c "a=' '*(400*1024*1024)"; echo exit=$?

Mong đợi: tiến trình bị kill (exit 137), vì vượt 256 MB. Thêm nếu muốn: fork bomb bị chặn ở 256 tiến trình. Trong lúc đó bob vẫn dùng bình thường.

Cảnh 6: internet có kiểm soát.
alice gõ:

Chạy: curl -sI https://example.com | head -1; curl -s --max-time 5 http://169.254.169.254/; curl -s --max-time 5 http://host.docker.internal:3470/; curl -s --max-time 5 http://192.168.1.1/

Mong đợi:

example.com trả 200.
3 đích nội bộ còn lại bị proxy chặn (private-ip) hoặc không có đường.

Sau đó admin mở /gate/admin, phần log internet, sẽ thấy các dòng của alice, có dòng bị chặn.

⚠ Lần chạy npm run attack gần nhất, mục internet trượt: example.com trả 000, có thể do mạng máy lúc đó. Chạy thử cảnh này trước buổi demo.

Cảnh 7: tài liệu riêng và tài liệu chung.

bob kéo luong.txt vào chat → đi vào tài liệu riêng của bob.
alice hỏi: "Lương của bob bao nhiêu?" → "Không tìm thấy thông tin…"
admin đính kèm quy_che.pdf trong workspace admin → thành tài liệu chung.
alice hỏi về quy chế → trả lời kèm trích dẫn.

Cảnh 8: admin xem nhưng không sửa được.
Admin mở workspace /data/users và gõ:

Chạy: ls /data/users/*/docs; echo x > /data/users/bob/docs/x.txt; curl -sI https://example.com

Mong đợi: thấy tệp của mọi người; ghi thì Read-only file system; curl thất bại (vùng admin-review không có mạng).

Cảnh 9 (tùy chọn): gate.

alice mở http://127.0.0.1:3454/gate/admin → "Không có quyền".
Admin khóa bob ngay lúc bob đang chat → giao diện của bob mất kết nối ngay.