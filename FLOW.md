# Luồng xử lý DSH-DocShield

Tài liệu gồm một sơ đồ tổng quát và 5 sơ đồ chi tiết, mỗi giai đoạn một sơ đồ.
Chưa có trong sơ đồ: đăng ký, trang `/gate/admin` và `/gate/usage`, upload file, watcher nạp tài liệu.

## Tổng quát

```mermaid
sequenceDiagram
    autonumber
    actor U as Người dùng
    participant G as Gate
    participant D as DSH (dsh-main)
    participant M as Model LLM
    participant DS as DocShield
    participant TM as tool-manager
    participant TC as Tool container
    participant EP as Egress proxy

    Note over TM,D: GĐ1 Khởi động
    TM->>D: dựng dsh-main + egress proxy
    D->>G: plugin dsh-gate spawn gate

    Note over U,G: GĐ2 Đăng nhập
    U->>G: POST /gate/login
    G-->>U: cookie phiên gate

    Note over U,M: GĐ3 Chat + hạn mức token
    U->>G: tin nhắn (HTTP/WebSocket)
    G->>D: chuyển tiếp sau khi lọc
    D->>G: IPC reserve (hạn mức)
    G-->>D: ok / QUOTA
    D->>M: gọi model
    M-->>D: trả lời, có thể kèm tool call

    Note over D,DS: GĐ4 Tool DocShield
    D->>DS: scoped_doc_search / answer_with_evidence
    DS-->>D: đoạn tài liệu, trích dẫn đã kiểm chứng

    Note over D,EP: GĐ5 Tool chạy lệnh
    D->>TM: ensure container của vùng (qua exec-router)
    D->>TC: SSH: file, lệnh
    TC->>EP: ra internet (nếu cần)
    TC-->>D: kết quả

    D-->>G: stream trả lời
    G-->>U: hiển thị
```

Giai đoạn 1 chạy một lần khi hệ thống bật. Giai đoạn 2 chạy một lần cho mỗi phiên đăng nhập. Giai đoạn 3 lặp lại ở mỗi lượt gọi model. Giai đoạn 4 và 5 chỉ xảy ra khi model gọi tool, và kết quả tool quay lại giai đoạn 3 (gọi model tiếp).

## Giai đoạn 1. Khởi động

```mermaid
sequenceDiagram
    autonumber
    participant TM as tool-manager (Windows host, :3470)
    participant DK as Docker
    participant D as DSH core (dsh-main)
    participant GP as Plugin dsh-gate
    participant G as Gate (:3454)
    participant EP as Egress proxy

    TM->>TM: sinh secret mới cho lần chạy này
    TM->>DK: docker run egress-proxy (EGRESS_SECRET)
    DK-->>EP: chạy trên mạng <P>-egress + <P>-tools
    TM->>DK: docker run dsh-main (TOOL_MANAGER_URL, TOOL_MANAGER_SECRET)
    DK-->>D: chạy, nạp plugin docshield, dsh-gate, exec-router
    D->>GP: loader.await() xong
    GP->>G: spawn gate.mjs serve --plugin<br/>(stdin pipe + IPC, GATE_UPSTREAM_URL kèm token 1 lần)
    G->>D: đổi token lấy auth cookie DSH
    Note over G,D: Gate là lối vào duy nhất cho trình duyệt.<br/>Pipe stdin đóng thì gate tự thoát.
```

`exec-router/tool-manager.mjs` chạy trên Windows và là thành phần duy nhất gọi Docker. Mỗi lần chạy, nó cấp secret mới và chỉ truyền qua biến môi trường. Khi DSH nạp xong plugin, `gate/plugin/index.mjs` spawn gate làm tiến trình con, có kênh IPC. Gate đổi token dùng một lần lấy cookie của DSH. Trình duyệt không bao giờ có cookie này. DSH dừng thì gate cũng dừng.

## Giai đoạn 2. Đăng nhập

```mermaid
sequenceDiagram
    autonumber
    actor U as Người dùng (Browser)
    participant G as Gate
    participant S as gate.db (store)

    U->>G: GET /gate/login
    G-->>U: form + CSRF token
    U->>G: POST /gate/login (CSRF, user, mật khẩu)
    G->>G: Origin khớp Host? CSRF hợp lệ?
    G->>S: đang bị khóa theo tên+IP?
    alt bị khóa
        G-->>U: 429 thử lại sau N phút
    else
        G->>S: lấy tài khoản, verifyPassword
        alt sai mật khẩu
            G->>S: audit login_failed
            G-->>U: 401
        else chưa được duyệt
            G->>S: audit login_pending
            G-->>U: 403
        else hợp lệ
            G->>S: audit login
            G-->>U: 303 + cookie phiên gate
        end
    end
```

`gate/src/app.mjs` kiểm tra CSRF và chặn POST/WebSocket có `Origin` khác `Host`. Đăng nhập sai nhiều lần thì bị khóa theo tên+IP. Tài khoản chưa được admin duyệt bị từ chối. Mọi kết quả đều được ghi audit.

## Giai đoạn 3. Chat và hạn mức token

```mermaid
sequenceDiagram
    autonumber
    actor U as Người dùng
    participant G as Gate
    participant D as DSH core
    participant GP as Plugin dsh-gate (hook llm/stream)
    participant M as Model LLM

    U->>G: HTTP /api/... hoặc WebSocket (cookie gate)
    G->>G: filter.mjs + policy.mjs: mặc định chặn,<br/>phiên phải thuộc user (cwd = users/<tên>)
    alt không khớp luật
        G-->>U: từ chối (log "gate: deny ...")
    else được phép
        G->>D: chuyển tiếp (cookie DSH)
    end
    D->>GP: llm/stream
    GP->>G: IPC reserve {sessionId, model, outCap}
    G->>G: quota.mjs: cửa sổ 5 giờ + tuần (gate.db)
    alt hết hạn mức, gate im 5 s hoặc gate chết
        G-->>GP: ok=false
        GP-->>D: finish error QUOTA (fail-closed, không retry)
    else còn hạn mức
        G-->>GP: ok=true, ticket
        GP->>M: gọi model (stream)
        M-->>GP: chunk + usage
        GP-->>D: chuyển chunk
        GP->>G: IPC settle {ticket, input, output}
    end
    D-->>G: stream trả lời
    G->>G: lọc kết quả theo user
    G-->>U: hiển thị
```

- `gate/src/filter.mjs` và `gate/src/policy.mjs` mặc định chặn. User thường chỉ gọi được các API và tin WebSocket có trong danh sách, và chỉ trên phiên của mình. Danh tính lấy từ cwd phiên `users/<tên>`. Admin được chuyển tiếp nguyên.
- Mỗi lần gọi model, hook `llm/stream` hỏi gate qua IPC (`reserve`). `gate/src/quota.mjs` xét cửa sổ 5 giờ và cửa sổ tuần.
- Gate không trả lời sau 5 s hoặc đã chết thì từ chối luôn. Lỗi `QUOTA` không được retry.
- Gọi xong, plugin báo lượng token thật (`settle`) để gate ghi sổ.

## Giai đoạn 4. Tool DocShield

```mermaid
sequenceDiagram
    autonumber
    participant D as DSH core
    participant GU as guard.ts
    participant SC as scope.ts
    participant DS as DocShield calls.ts
    participant DB as SQLite index
    participant EV as Sổ evidence (theo phiên)

    D->>GU: tool call scoped_doc_search
    GU->>GU: tool thuộc USER_TOOLS / ADMIN_TOOLS?
    GU->>SC: scope từ cwd phiên
    SC-->>GU: user / admin / không scope
    GU->>DS: gọi với scope
    DS->>DB: hybridSearch (FTS + embedding) trong scope đọc được
    DB-->>DS: các chunk
    DS->>EV: ghi chunk đã trả
    DS-->>D: các đoạn tài liệu
    D->>GU: answer_with_evidence (chunkId + quote)
    GU->>DS: gọi với scope
    DS->>EV: chunk đã trả trong phiên này?
    DS->>DB: tài liệu còn hiệu lực, thuộc scope?
    DS->>DS: quote khớp nguyên văn chunk?
    alt đủ 3 điều kiện
        DS-->>D: trích dẫn đã kiểm chứng (thẻ giao diện)
    else
        DS-->>D: lỗi, trích dẫn bị từ chối
    end
```

`docshield/src/guard.ts` cho phép tool theo vai trò. `docshield/src/scope.ts` suy ra scope từ cwd phiên. `scoped_doc_search` ghi mọi chunk đã trả vào sổ evidence (`docshield/src/retrieval/evidence.ts`). `answer_with_evidence` chỉ nhận trích dẫn khi đủ 3 điều kiện:
1. chunk đã được trả trong cùng phiên;
2. tài liệu còn hiệu lực và thuộc scope đọc được;
3. quote khớp nguyên văn với chunk.

Nhờ vậy model không bịa được trích dẫn.

## Giai đoạn 5. Tool chạy lệnh và internet

```mermaid
sequenceDiagram
    autonumber
    participant D as DSH core
    participant ER as exec-router
    participant TM as tool-manager
    participant TC as Tool container (vùng)
    participant EP as Egress proxy
    participant NET as Internet

    D->>ER: fs / subprocess / sandbox
    ER->>ER: zones.mjs: vùng theo phiên, không theo path model viết
    ER->>TM: POST /ensure {zone} (x-tool-secret)
    TM->>TM: tên vùng hợp lệ? vượt TOOL_QUOTA_MB?
    alt vượt hạn mức đĩa
        TM-->>ER: lỗi, vùng bị chặn
    else
        TM->>TC: docker run (tham số cố định, mạng --internal) nếu chưa có
        TM-->>ER: {host, token}
        ER->>TC: SSH (ToolConnection): đọc/ghi file, chạy lệnh
        opt lệnh cần internet (curl, npm, pip)
            TC->>EP: Proxy-Authorization user.<u>:HMAC(zone)
            EP->>EP: chỉ IPv4 công khai, tự resolve DNS 1 lần
            EP->>NET: kết nối đúng địa chỉ đã kiểm
            NET-->>EP: phản hồi
            EP-->>TC: phản hồi (ghi log JSON)
        end
        TC-->>ER: kết quả
        ER-->>D: kết quả tool
    end
```

- `exec-router/src/index.mjs` thay các service `fs`/`subprocess`/`sandbox` của DSH. Tiến trình DSH không bao giờ đụng file người dùng hay tự chạy lệnh.
- Vùng được xác định theo phiên (`exec-router/src/zones.mjs`), không theo đường dẫn model viết.
- tool-manager tạo container riêng cho từng vùng, với tham số `docker run` cố định. Vùng vượt hạn mức đĩa thì bị chặn. Mỗi lượt bị từ chối, tool-manager đo lại, nên admin xóa file là vùng tự được gỡ chặn.
- Container ở mạng `--internal`. Muốn ra internet chỉ có đường qua egress proxy (`container/egress-proxy.mjs`):
  - xác thực bằng HMAC theo vùng;
  - chỉ cho đi tới IPv4 công khai;
  - proxy tự resolve DNS một lần, nên chặn được DNS rebinding;
  - mỗi kết nối được ghi một dòng log JSON.
- Vùng `admin-review` không có mạng.
