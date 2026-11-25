/**
 * Image build step: the presets "DocShield + công cụ" (user and admin) = DSH's
 * own Standard preset rows (shell, files, search, jobs, skills, plans,
 * subagents…) + DocShield persona and tools. Every tool of these rows reaches
 * files and processes only through ctx.fs / ctx.subprocess / ctx.sandbox,
 * which the exec-router plugin sends to the session's tool container.
 *
 * Dropped rows: `tool-web` (web_fetch/web_search run INSIDE the DSH process,
 * around the sandbox), `tool-plugin-manager` (rewrites the DSH profile),
 * `tool-pwsh` (Windows only) and the Standard persona (replaced).
 *   node make-harness-presets.mjs <dsh standard preset dir> <docshield presets dir>
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const [standardDir, presetsDir] = process.argv.slice(2)
const standard = readFileSync(path.join(standardDir, 'agent.cordis.yml'), 'utf8')
const rows = standard.split(/^(?=- id: )/m).filter(chunk => chunk.startsWith('- id: '))
const DROP = ['persona', 'tool-web', 'tool-plugin-manager', 'tool-pwsh']
const id = row => /^- id: (\S+)/.exec(row)[1]
for (const d of DROP) if (!rows.some(r => id(r) === d)) throw new Error(`make-harness-presets: Standard preset has no "${d}" row; its layout changed`)
const toolRows = rows.filter(row => !DROP.includes(id(row)))
for (const need of ['tool-bash', 'tool-fs', 'tool-fs-search']) if (!toolRows.some(r => id(r) === need)) throw new Error(`make-harness-presets: missing ${need}`)
if (toolRows.some(r => /dsh-tool-web|dsh-mcp|plugin-manager/.test(r))) throw new Error('make-harness-presets: a network/plugin tool slipped through')

const indent = (text, spaces) => text.trimEnd().split('\n').map(line => (line ? `${' '.repeat(spaces)}${line}` : '')).join('\n')
const rules = readFileSync(path.join(presetsDir, 'persona-rules.txt'), 'utf8')

const WORKSPACE = [
  'Ngoài tra cứu tài liệu, bạn là một agent đầy đủ: có shell, đọc/ghi/sửa file, tìm file, chạy job, lập kế hoạch và subagent.',
  'Mọi công cụ chạy trong một container riêng của người dùng này: chỉ thấy thư mục {{cwd}}; không đọc được dữ liệu của người khác.',
  '- File đặt trong {{cwd}}/docs được DocShield tự nạp làm tài liệu cá nhân (tài liệu chung chỉ admin công bố).',
  '- Câu hỏi về NỘI DUNG tài liệu (quy chế, hồ sơ, tài liệu đã nạp) vẫn phải theo đúng quy trình DocShield dưới đây, không trả lời bằng hiểu biết riêng hay bằng cách tự đọc file thay cho scoped_doc_search.',
  '- Việc khác (soạn/sửa file, xử lý dữ liệu, viết và chạy code…) thì làm bằng các công cụ trên, trong thư mục làm việc.',
  '- Có internet qua proxy cho curl, python, node, npm (trang công khai, cổng 80/443; địa chỉ nội bộ, máy chủ và cổng khác bị chặn, có giới hạn lưu lượng). Riêng workspace xem dữ liệu mọi người (/data/users) không có mạng.',
].join('\n')

const make = (header, role, extra) => `# Generated at image build by container/make-harness-presets.mjs: DSH Standard tool rows + DocShield.
# Tools run in per-user tool containers (exec-router); docshield-core has allowOtherTools + toolSandbox.

- id: persona
  name: '@deepseek-ai/dsh-persona'
  config:
    suffix: 'Thư mục làm việc: {{cwd}}.'
    prefix: |-
${indent(`${header}\n${WORKSPACE}${extra ? `\n${extra}` : ''}\n\nVới câu hỏi về nội dung tài liệu:\n${rules}`, 6)}

${toolRows.map(row => row.trimEnd()).join('\n')}

- id: docshield-tools
  name: 'dsh-docshield/tools'
  config:
    role: ${role}
`

const write = (presetId, name, description, body) => {
  mkdirSync(path.join(presetsDir, presetId), { recursive: true })
  writeFileSync(path.join(presetsDir, presetId, 'preset.yml'), `name: ${name}\ndescription: ${description}\norder: 0\n`)
  writeFileSync(path.join(presetsDir, presetId, 'agent.cordis.yml'), body)
}
write('docshield-harness', 'DocShield + công cụ', 'Tra cứu tài liệu có trích dẫn, kèm shell và file trong container riêng.',
  make('Bạn là DocShield, trợ lý tra cứu tài liệu nội bộ của nhà trường.', 'user', ''))
write('docshield-admin-harness', 'DocShield Admin + công cụ', 'Quản trị tài liệu chung và phiếu hỗ trợ, kèm shell và file trong container riêng.',
  make('Bạn là DocShield Admin, trợ lý của cán bộ quản trị tài liệu chung và phiếu hỗ trợ.', 'admin',
    'Với yêu cầu quản trị (xem/cập nhật phiếu hỗ trợ, công bố hoặc nạp lại tài liệu chung) hãy dùng list_tickets, update_ticket, publish_public_doc, reindex_document. "rejected" luôn kèm lý do trong reply. Phiên trong /data/users (xem dữ liệu mọi người) là chỉ đọc và không có mạng.'))

// Project 3 ticket agents, admin side (run by project3/worker.py as account p3admin in /data/admin/p3): H1 tools + retrieval
// loop + code, H2 + planning, H3 + subagents. Read-only on tickets: no write tools; the admin decides on /gate/admin/tickets.
// No ask-user (batch runs, nobody answers). Persona = docshield/presets/p3-ticket-rules.txt.
const p3rules = readFileSync(path.join(presetsDir, 'p3-ticket-rules.txt'), 'utf8')
const P3_DROP = { 'p3-h1': ['planning', 'tool-todo', 'delegation'], 'p3-h2': ['delegation'], 'p3-h3': [] }
for (const [pid, drop] of Object.entries(P3_DROP)) {
  for (const d of drop) if (!toolRows.some(r => id(r) === d)) throw new Error(`make-harness-presets: no "${d}" row for ${pid}`)
  const keep = toolRows.filter(r => ![...drop, 'tool-ask-user'].includes(id(r)))
  write(pid, `Project 3 ${pid.slice(3).toUpperCase()}`, 'Agent xử lý phiếu hỗ trợ (thí nghiệm Project 3).', `# Generated by container/make-harness-presets.mjs (Project 3 ${pid}).

- id: persona
  name: '@deepseek-ai/dsh-persona'
  config:
    suffix: 'Thư mục làm việc: {{cwd}}.'
    prefix: |-
${indent(`${WORKSPACE}\n\n${p3rules}`, 6)}

${keep.map(row => row.trimEnd()).join('\n')}

- id: docshield-tools
  name: 'dsh-docshield/tools'
  config:
    role: admin
    exclude: [list_tickets, update_ticket, publish_public_doc, reindex_document, create_support_ticket, check_ticket_status]
`)
}
console.log(`harness presets: ${toolRows.length} Standard rows (${toolRows.map(id).join(', ')}) + DocShield`)
