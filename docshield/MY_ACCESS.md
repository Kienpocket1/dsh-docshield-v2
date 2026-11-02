# Báo cáo: tool `my_access` (Quyền của tôi)

Ngày: 2026-10-21 · Phạm vi: plugin DocShield (`dsh-docshield/docshield`)

## 1. Mục tiêu

Người dùng thường hỏi trong chat "Tôi có quyền gì?", "Tôi làm được gì?", "Vai trò của tôi?". Trước đây agent không có công cụ nào cho câu hỏi này nên phải tự suy đoán, có thể trả lời sai.

`my_access` trả lời bằng **quyền thật lấy từ code**, theo danh tính tin cậy của phiên:

- Chỉ **người dùng thường** dùng được. Admin không có tool này.
- Chỉ đọc: không mở thêm quyền nào, không trả dữ liệu của người khác.

## 2. Kết quả trả về

```json
{
  "role": "người dùng",
  "userId": "alice",
  "dataScope": "Tài liệu chung và tài liệu cá nhân của bạn; không xem được dữ liệu của người khác.",
  "allowedTools": ["scoped_doc_search", "answer_with_evidence", "create_support_ticket", "check_ticket_status", "list_documents", "my_access"],
  "deniedFunctions": ["Xem hoặc xử lý phiếu hỗ trợ của người khác", "Công bố hoặc nạp lại tài liệu chung", "Trang quản trị /gate/admin"],
  "documents": { "personal": 1, "public": 1 },
  "tickets": { "total": 0, "open": 0 }
}
```

- `allowedTools` đọc trực tiếp từ `USER_TOOLS`, nên luôn khớp với luật thật.
- `documents` dùng lại `service.listDocuments(scope)`, đã lọc theo phạm vi của người gọi.
- `tickets` dùng lại `service.tickets.list({ userId })`, chỉ đếm phiếu của chính người gọi.

## 3. Các thay đổi

| Tệp | Thay đổi |
|---|---|
| `src/guard.ts` | Thêm `my_access` vào `USER_TOOLS`. Thêm `USER_ONLY_TOOLS` để loại tool này khỏi `ADMIN_TOOLS` (trước đây `ADMIN_TOOLS` chép toàn bộ `USER_TOOLS`). Thêm `DOC_TOOLS` (mọi tool DocShield) và dùng nó trong `createGuard` thay cho `ADMIN_TOOLS` ở hai chỗ, để admin trong container không lọt guard với `my_access`. |
| `src/tools/defs.ts` | Khai báo spec `my_access`: `needs: 'user'`, không tham số. Mô tả hẹp: chỉ gọi khi người dùng hỏi trực tiếp về quyền hoặc vai trò, không gọi khi họ yêu cầu một việc cụ thể. |
| `src/tools/calls.ts` | Hàm xử lý `my_access`; ném `ArgumentError` nếu người gọi không phải `user`. |
| `presets/docshield/agent.cordis.yml` | Thêm 2 quy tắc vào persona: (1) hỏi trực tiếp về quyền thì gọi `my_access`, không suy đoán, không gọi khi được yêu cầu làm việc cụ thể; (2) người dùng không liệt kê được phiếu, chỉ xem theo mã, nên khi thiếu mã thì nhờ họ cung cấp. |
| `tests/guard.spec.ts` | Test: `my_access` thuộc `USER_TOOLS`, không thuộc `ADMIN_TOOLS`; guard cho phép ở workspace user, chặn ở workspace admin, chặn admin trong container, chặn ở vùng "xem mọi user". |
| `tests/server.spec.ts` | Test qua dịch vụ DocShield (docker mode): token của alice nhận đúng dữ liệu của alice; token admin bị từ chối. |

Không sửa: `src/tools/index.ts` (tự đăng ký theo `USER_TOOLS`/`ADMIN_TOOLS`), preset admin, giao diện (kết quả hiện dạng JSON mặc định).

## 4. Workflow

```
Người dùng (alice) gõ "Tôi có quyền gì?"
        │
        ▼
Gate :3454 ── kiểm tra đăng nhập, phiên thuộc alice (gate/src/policy.mjs)
        │
        ▼
congty-dsh-main ── LLM đọc mô tả tool + persona, quyết định gọi my_access
        │
        ├─ Lớp 1 · Đăng ký (src/tools/index.ts)
        │     preset user đăng ký tool trong USER_TOOLS → có my_access
        │     preset admin đăng ký ADMIN_TOOLS → KHÔNG có my_access
        │
        ├─ Lớp 2 · Guard toàn cục (src/guard.ts, createGuard)
        │     cwd phiên → scope (users/<tên> = user, admin = admin)
        │     tool không thuộc tập của vai trò → từ chối
        │
        ├─ Lớp 3 · Trong tool (src/tools/scope-check.ts, requireScope)
        │     needs: 'user' → admin gọi sẽ bị ném lỗi
        │
        └─ Lớp 4 · Dịch vụ DocShield (src/tools/calls.ts, invokeWith)
              docker mode: scope lấy từ token do gate cấp, không tin container
              kiểm lại USER_TOOLS/ADMIN_TOOLS, rồi chạy hàm my_access
        │
        ▼
Kết quả JSON → LLM diễn giải thành câu trả lời tiếng Việt
```

Danh tính (`userId`, `role`) không bao giờ lấy từ lời người dùng. Nó lấy từ thư mục của phiên hoặc từ token do gate cấp.

## 5. Kiểm thử

- `npx vitest run tests/guard.spec.ts tests/server.spec.ts`: 14/14 qua.
- `npm test` toàn bộ: 113/114 qua. Test fail là `safe-fs` "swap race (TC9)", không liên quan đến thay đổi này: chạy riêng thì qua, kể cả trên code chưa sửa, nên đây là test race chập chờn khi máy bận.
- `tsc --noEmit`: không lỗi.

Thử thật sau `start.cmd rebuild` (đọc phiên bằng `tools-local/read-sessions.mjs`):

| Ai | Prompt | Quan sát |
|---|---|---|
| alice | "Tôi làm được gì" | `CALL my_access {}` → kết quả đúng `userId: alice` |
| admin | "Tôi làm được gì" | Không có `CALL my_access`; model tự trả lời (đúng thiết kế) |
| bob | "Liệt kê tickets" (trước khi thu hẹp mô tả) | Gọi `my_access`: không sai quyền nhưng không cần thiết → đã sửa mô tả (mục 3) |
| alice / bob | "Liệt kê tickets" (sau khi sửa) | Đều nhờ người dùng cung cấp mã phiếu; alice qua `ask_user_question`, bob bằng chữ (model không cố định cách hỏi) |

## 6. Giới hạn đã biết

- **Việc gọi tool do LLM quyết định.** Mô tả và persona làm tăng khả năng gọi đúng, nhưng không đảm bảo 100%. An ninh không phụ thuộc vào điều này: quyền thật vẫn do gate, guard và dịch vụ DocShield kiểm.
- **Admin hỏi "tôi làm được gì"** thì model tự suy đoán từ danh sách tool của nó. Muốn chính xác, thêm danh sách quyền admin vào `presets/docshield-admin/agent.cordis.yml`.
- **Không có hạn mức token và đĩa.** Số liệu này nằm trong `gate.db`, DocShield không đọc được. Người dùng xem ở `/gate/usage`.
- **Số phiếu tối đa 50**, do `tickets.list` mặc định giới hạn 50.
- Người dùng **không liệt kê được phiếu của mình**; chỉ xem theo mã. Muốn có, thêm tool `list_my_tickets` (dùng lại `service.tickets.list({ userId })`).

## 7. Triển khai

Code nằm trong image `congty-dsh-main`: sau mỗi lần sửa phải chạy `start.cmd rebuild`, rồi thử trong **phiên chat mới** (phiên cũ còn giữ ngữ cảnh trước).
