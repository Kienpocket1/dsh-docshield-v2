/**
 * Tool catalogue. M1 ships the final names, descriptions and parameter
 * schemas with placeholder bodies; later milestones replace `execute`.
 */
import type { ContentBlock, RawToolDefinition } from '../dsh-types.js'
import type { DocInvoke } from './calls.js'
import { requireScope, type ScopeSource } from './scope-check.js'

type Needs = 'user' | 'admin' | 'any'

interface ToolSpec {
  readonly name: string
  readonly needs: Needs
  readonly description: string
  readonly parameters: Record<string, unknown>
}

const str = (description: string, extra: Record<string, unknown> = {}) => ({ type: 'string', description, ...extra })
const obj = (properties: Record<string, unknown>, required: string[]) =>
  ({ type: 'object', properties, required, additionalProperties: false })

export const TOOL_SPECS: readonly ToolSpec[] = [
  {
    name: 'scoped_doc_search',
    needs: 'any',
    description: 'Tìm các đoạn tài liệu liên quan tới câu hỏi trong phạm vi được phép (tài liệu chung và tài liệu của chính người dùng). Luôn gọi trước khi trả lời câu hỏi về nội dung.',
    parameters: obj({ query: str('Câu hỏi hoặc từ khóa cần tìm', { minLength: 1 }), k: { type: 'integer', minimum: 1, maximum: 8, description: 'Số đoạn tối đa (mặc định 5)' } }, ['query']),
  },
  {
    name: 'answer_with_evidence',
    needs: 'any',
    description: 'Trả lời người dùng kèm trích dẫn nguyên văn từ các đoạn đã tìm được bằng scoped_doc_search trong phiên này. Mỗi trích dẫn phải là chuỗi con chính xác của đoạn nguồn.',
    parameters: obj({
      answer: str('Câu trả lời ngắn gọn, chỉ dựa trên trích dẫn', { minLength: 1 }),
      citations: {
        type: 'array',
        minItems: 1,
        items: obj({ chunkId: str('chunkId lấy từ kết quả scoped_doc_search'), quote: str('Câu trích nguyên văn từ đoạn đó', { minLength: 1 }) }, ['chunkId', 'quote']),
      },
    }, ['answer', 'citations']),
  },
  {
    name: 'create_support_ticket',
    needs: 'any',
    description: 'Tạo phiếu hỗ trợ chuyển cho cán bộ khi tài liệu không có câu trả lời.',
    parameters: obj({ question: str('Câu hỏi gốc của người dùng', { minLength: 1 }), reason: str('Vì sao tài liệu không trả lời được', { minLength: 1 }) }, ['question', 'reason']),
  },
  {
    name: 'check_ticket_status',
    needs: 'any',
    description: 'Xem trạng thái một phiếu hỗ trợ theo mã, ví dụ TICK-12.',
    parameters: obj({ code: str('Mã phiếu, ví dụ TICK-101', { minLength: 1 }) }, ['code']),
  },
  {
    name: 'list_documents',
    needs: 'any',
    description: 'Liệt kê tài liệu trong phạm vi được phép và trạng thái nạp của chúng.',
    parameters: obj({}, []),
  },
  {
    name: 'my_access',
    needs: 'user',
    description: 'Cho người dùng biết quyền của chính họ: vai trò, phạm vi dữ liệu được xem, chức năng được dùng và không được dùng, số tài liệu và phiếu hỗ trợ của họ. Chỉ gọi khi người dùng hỏi trực tiếp về quyền hoặc vai trò của họ (ví dụ "tôi có quyền gì", "tôi làm được gì", "vai trò của tôi"). Không gọi khi họ yêu cầu làm một việc cụ thể (liệt kê phiếu, tìm tài liệu…): khi đó dùng công cụ phù hợp, hoặc nói rõ chức năng đó không có.',
    parameters: obj({}, []),
  },
  {
    name: 'list_tickets',
    needs: 'admin',
    description: 'Admin: liệt kê phiếu hỗ trợ, có thể lọc theo trạng thái.',
    parameters: obj({ status: { type: 'string', enum: ['open', 'in_progress', 'resolved', 'rejected'] } }, []),
  },
  {
    name: 'update_ticket',
    needs: 'admin',
    description: 'Admin: cập nhật trạng thái và phản hồi cho một phiếu hỗ trợ. "resolved" khi đã trả lời được câu hỏi; "rejected" khi từ chối xử lý (bắt buộc ghi lý do trong reply); "in_progress" khi đang xử lý.',
    parameters: obj({
      code: str('Mã phiếu, ví dụ TICK-101', { minLength: 1 }),
      status: { type: 'string', enum: ['open', 'in_progress', 'resolved', 'rejected'] },
      reply: str('Phản hồi gửi người dùng (bắt buộc khi status là rejected)'),
    }, ['code', 'status']),
  },
  {
    name: 'publish_public_doc',
    needs: 'admin',
    description: 'Admin: công bố một file đã có trong public_docs làm phiên bản hiện hành của tài liệu chung doc_key. Mọi file khác cùng doc_key, và file ở "replaces" (nếu có), bị thay thế: không còn được tìm kiếm hay trích dẫn. Dùng khi có bản quy chế mới thay bản cũ (khác tên file). Xem tên file và doc_key hiện tại bằng list_documents.',
    parameters: obj({
      filename: str('Tên file mới trong public_docs, đúng như list_documents hiển thị'),
      doc_key: str('Khóa định danh tài liệu, ví dụ quy_che_dao_tao', { pattern: '^[a-z0-9_-]{2,64}$' }),
      replaces: str('(Tùy chọn) tên file bản cũ bị thay thế, ví dụ quy_che_v1.pdf'),
    }, ['filename', 'doc_key']),
  },
  {
    name: 'reindex_document',
    needs: 'admin',
    description: 'Admin: nạp lại chỉ mục cho một tài liệu chung theo doc_key.',
    parameters: obj({ doc_key: str('Khóa tài liệu', { pattern: '^[a-z0-9_-]{2,64}$' }) }, ['doc_key']),
  },
]

export type ToolRender = (value: unknown) => string

/**
 * Wrap a spec with scope enforcement and a JSON-object result; `render` shapes
 * the model-facing text. `invoke` runs the call in this process or, in docker
 * mode, in the host DocShield service (which re-checks the role from its token).
 */
export function defineDocTool(spec: ToolSpec, source: ScopeSource, invoke: DocInvoke, render?: ToolRender): RawToolDefinition {
  return {
    name: spec.name,
    description: spec.description,
    parameters: spec.parameters,
    output: {
      schema: { type: 'object' },
      render: (_args, value): ContentBlock[] => [{ type: 'text', text: render ? render(value) : JSON.stringify(value) }],
      presentationMeta: (_args, value) => value,
    },
    async execute(args, exec) {
      const scope = requireScope(exec, source, spec.needs)
      if (typeof args !== 'object' || args === null || Array.isArray(args)) {
        throw new Error('DocShield: tham số công cụ phải là object.')
      }
      return invoke(spec.name, args as Record<string, unknown>, { scope, sessionId: exec.agent?.session.id ?? 'unknown' })
    },
  }
}
