import { describe, expect, it } from 'vitest'
import path from 'node:path'
import { ADMIN_TOOLS, createGuard, USER_TOOLS } from '../src/guard.js'

const ROOT = 'E:\\storage'
const guard = createGuard(ROOT, { platform: 'win32', realpath: p => p })
const call = (name: string, cwd?: string) => guard({
  name,
  ...cwd === undefined ? {} : { agent: { session: { id: 's1', header: { cwd } } } },
})

describe('createGuard', () => {
  it('allows user tools in a user workspace', () => {
    for (const tool of USER_TOOLS) expect(call(tool, 'E:\\storage\\users\\alice'), tool).toBeUndefined()
  })

  it('denies shell and file tools in a user workspace, whatever the preset (TC-07, TC-08)', () => {
    for (const tool of ['bash', 'pwsh', 'read', 'write', 'edit', 'glob', 'grep', 'web_fetch', 'run_code', 'subagent', 'probe_echo']) {
      expect(call(tool, 'E:\\storage\\users\\bob'), tool).toMatch(/không được phép/)
    }
  })

  it('denies admin tools to users', () => {
    for (const tool of ['list_tickets', 'update_ticket', 'publish_public_doc', 'reindex_document']) {
      expect(call(tool, 'E:\\storage\\users\\alice'), tool).toMatch(/không được phép/)
    }
  })

  it('allows every admin tool in the admin workspace', () => {
    for (const tool of ADMIN_TOOLS) expect(call(tool, 'E:\\storage\\admin'), tool).toBeUndefined()
    expect(call('bash', 'E:\\storage\\admin')).toMatch(/không được phép/)
  })

  it('my_access is a user-only tool: the admin never gets it, in or out of a container', () => {
    expect(USER_TOOLS.has('my_access')).toBe(true)
    expect(ADMIN_TOOLS.has('my_access')).toBe(false)
    expect(call('my_access', 'E:\\storage\\users\\alice')).toBeUndefined()
    expect(call('my_access', 'E:\\storage\\admin')).toMatch(/không được phép/)
    const admin = createGuard('/storage', { identity: { role: 'admin' } }, true)
    expect(admin({ name: 'my_access', agent: { session: { id: 's', header: { cwd: '/storage/admin' } } } })).toMatch(/không được phép/)
    const sandboxed = createGuard(path.resolve('/data'), {}, true)
    expect(sandboxed({ name: 'my_access', agent: { session: { id: 's', header: { cwd: path.join(path.resolve('/data'), 'users') } } } })).toMatch(/không dùng/)
  })

  it('denies everything in malformed places under the root', () => {
    expect(call('scoped_doc_search', 'E:\\storage\\public_docs')).toMatch(/không nằm trong workspace hợp lệ/)
    expect(call('scoped_doc_search', 'E:\\storage')).toMatch(/không nằm trong workspace hợp lệ/)
  })

  it('in a container (allowOtherTools) lets harness tools run but keeps DocShield admin tools admin-only', () => {
    const open = createGuard('/storage', { identity: { role: 'user', userId: 'alice' } }, true)
    const as = (name: string) => open({ name, agent: { session: { id: 's', header: { cwd: '/storage/users/alice' } } } })
    for (const tool of ['bash', 'read', 'write', 'edit', 'glob', 'grep', 'subagent', ...USER_TOOLS]) expect(as(tool), tool).toBeUndefined()
    for (const tool of ['list_tickets', 'update_ticket', 'publish_public_doc', 'reindex_document']) expect(as(tool), tool).toMatch(/không được phép/)
  })

  it('tool sandbox: the admin "all users" workspace runs harness tools but no DocShield tool', () => {
    const root = path.resolve('/data')
    const sandboxed = createGuard(root, {}, true)
    const at = (name: string, cwd: string) => sandboxed({ name, agent: { session: { id: 's', header: { cwd } } } })
    for (const tool of ['bash', 'read', 'glob', 'grep']) expect(at(tool, path.join(root, 'users')), tool).toBeUndefined()
    for (const tool of ADMIN_TOOLS) expect(at(tool, path.join(root, 'users')), tool).toMatch(/không dùng/)
    // Without the tool sandbox the same folder stays fully blocked, and other odd folders stay blocked too.
    expect(createGuard(root, {}, false)({ name: 'bash', agent: { session: { id: 's', header: { cwd: path.join(root, 'users') } } } })).toMatch(/mọi công cụ bị chặn/)
    expect(at('bash', path.join(root, 'public_docs'))).toMatch(/mọi công cụ bị chặn/)
  })

  it('does not interfere outside the storage root or without an agent', () => {
    expect(call('bash', 'E:\\projects\\app')).toBeUndefined()
    expect(call('bash')).toBeUndefined()
  })
})
