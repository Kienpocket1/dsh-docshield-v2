// P0 check: DSH's own SSH fs/subprocess/sandbox providers, driven through a
// ToolConnection into a tool container, do every file and process effect
// INSIDE that container. Run in a container on the internal network:
//   TOOL_HOST=tool-alice TOOL_TOKEN=… node exec-router/test/p0.mjs
// Wiring mirrors deepseek-harness/packages/ssh/ssh/tests/live.e2e.ts.
import { Context } from '@deepseek-ai/cordis'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import { SandboxPolicyService } from '@deepseek-ai/dsh-sandbox-policy'
import { SshFileSystem } from '@deepseek-ai/dsh-fs-ssh'
import { SshSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-ssh'
import { SshSandboxProvider } from '@deepseek-ai/dsh-sandbox-ssh'
import { ToolConnection } from '../src/tool-connection.mjs'

const WORKSPACE = process.env.TOOL_WORKSPACE ?? '/data/users/alice'
const results = []
const check = (name, ok, extra = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`) }

const conn = new ToolConnection({ host: process.env.TOOL_HOST ?? 'tool-alice', token: process.env.TOOL_TOKEN, workspace: WORKSPACE })
const hello = await conn.ready
check('bắt tay với helper trong container', hello.platform === 'linux', `node ${hello.nodeVersion}, root ${hello.root}`)

const ctx = new Context()
ctx.provide('ssh', conn)
const fibers = [
  await ctx.plugin(SessionProjectionRegistry),
  await ctx.plugin(SandboxPolicyService, { mode: 'workspace-write', workspaceRoot: WORKSPACE }),
  await ctx.plugin(SshFileSystem),
  await ctx.plugin(SshSubprocessRuntime),
  await ctx.plugin(SshSandboxProvider),
]

/** Run argv inside the container, confined like DSH's bash executor does; collect stdout. */
async function run(argv, { confine = true, limit = 1 << 20 } = {}) {
  const policy = ctx.sandboxPolicy.resolve({ mode: 'workspace-write' })
  const finalArgv = confine ? (await ctx.sandbox.confine(argv, policy)).argv : argv
  const proc = ctx.subprocess.spawn({ argv: finalArgv, cwd: WORKSPACE, stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' }, graceMs: 2000 })
  proc.stderr?.resume()
  const chunks = []
  let size = 0
  for await (const c of proc.stdout) { size += c.length; if (size <= limit) chunks.push(c) }
  const outcome = await proc.done
  return { out: Buffer.concat(chunks).toString('utf8'), size, outcome }
}

try {
  // Files
  const target = await ctx.fs.resolve('p0-ghi-chu.md', { cwd: WORKSPACE })
  await ctx.fs.writeText(target, 'Ghi chú P0: lịch họp thứ Năm.\n', undefined, undefined, ctx.sandboxPolicy.resolve({ mode: 'workspace-write' }))
  const back = await ctx.fs.readText(target)
  check('ghi rồi đọc lại file qua fs', back.includes('lịch họp'))

  // Processes, in the container
  const who = await run(['bash', '-c', 'id -u; hostname; ls /data/users; cat p0-ghi-chu.md'])
  const [uid, host, ...rest] = who.out.trim().split('\n')
  check('bash chạy với uid 1000', uid === '1000', uid)
  check('bash chạy trong container công cụ', host === (process.env.TOOL_HOST ?? 'tool-alice'), host)
  check('chỉ thấy thư mục của mình trong /data/users', rest[0] === WORKSPACE.split('/').pop(), rest[0])
  check('file ghi qua fs nằm trong container', who.out.includes('lịch họp'))

  // ripgrep by DSH's absolute rg path, resolved inside the container
  const rg = await run(['/opt/dsh/node_modules/@vscode/ripgrep/bin/rg', '--no-config', '-l', 'lịch họp', '.'], { confine: false })
  check('rg (đường dẫn của DSH) tìm được chữ', rg.out.includes('p0-ghi-chu.md'), rg.out.trim())

  // Symlink to the container's /etc/passwd read through fs: only the container's own file (TC4)
  await run(['bash', '-c', 'ln -sf /etc/passwd lien-ket.txt'])
  const linked = await ctx.fs.readText(await ctx.fs.resolve('lien-ket.txt', { cwd: WORKSPACE })).catch(e => ({ error: e.message }))
  const text = typeof linked === 'string' ? linked : String(linked.error)
  check('symlink chỉ trỏ tới /etc/passwd của container (hoặc bị chặn)', !/Asus|Windows/i.test(text) && (text.includes('node:x:1000') || 'error' in linked), text.split('\n')[0])

  // Large output does not hang (TC12, rough)
  const t0 = Date.now()
  const big = await run(['bash', '-c', 'head -c 20000000 /dev/zero'], { limit: 1 << 20 })
  check('luồng 20 MB chạy xong, không treo', big.size === 20_000_000 && Date.now() - t0 < 30_000, `${big.size} byte, ${Date.now() - t0} ms`)
} catch (error) {
  check('không lỗi bất ngờ', false, error.stack ?? String(error))
} finally {
  for (const f of fibers.reverse()) await f.dispose().catch(() => {})
  await conn.dispose()
}
const failed = results.filter(r => !r).length
console.log(`\n${results.length - failed}/${results.length} đạt`)
process.exit(failed ? 1 : 0)
