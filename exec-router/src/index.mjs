/**
 * exec-router: DSH plugin that replaces the host `fs`, `subprocess` and
 * `sandbox` services with facades. Every call is routed — by the session that
 * runs it (zones.mjs), never by a model-written path — to that zone's tool
 * container, through DSH's own SSH providers over a ToolConnection. The DSH
 * process itself never touches user files or runs user commands.
 *
 * Containers are started by the tool-manager on the host (tool-manager.mjs);
 * this plugin only knows its URL and a per-run secret (environment).
 */
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { FileSystem } from '@deepseek-ai/dsh-fs'
import { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { SandboxProvider } from '@deepseek-ai/dsh-sandbox'
import { SshFileSystem } from '@deepseek-ai/dsh-fs-ssh'
import { SshSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-ssh'
import { SshSandboxProvider } from '@deepseek-ai/dsh-sandbox-ssh'
import { ToolConnection } from './tool-connection.mjs'
import { ZoneError, assertInZone, rootsOf, zoneOfCall } from './zones.mjs'

export const name = 'exec-router'
export const inject = ['agents', 'sandboxPolicy']

const IDLE_MS = 15 * 60_000
const SWEEP_MS = 60_000

/**
 * @param {any} ctx
 * @param {{ managerUrl?: string, idleMinutes?: number }} [config]
 */
export function apply(ctx, config = {}) {
  const managerUrl = config.managerUrl ?? process.env.TOOL_MANAGER_URL
  const secret = process.env.TOOL_MANAGER_SECRET
  if (!managerUrl || !secret) throw new Error('exec-router: cần TOOL_MANAGER_URL và TOOL_MANAGER_SECRET')
  const idleMs = (config.idleMinutes ?? 15) * 60_000 || IDLE_MS
  const log = msg => console.log(`exec-router: ${msg}`)
  const policyService = ctx.sandboxPolicy

  async function manager(action, zone) {
    const res = await fetch(`${managerUrl}/${action}`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-tool-secret': secret }, body: JSON.stringify({ zone }),
    })
    const body = await res.json().catch(() => ({}))
    if (!res.ok) throw new ZoneError(body.error ?? `tool-manager: HTTP ${res.status}`)
    return body
  }

  /** The `ssh` service of one zone: connects (and reconnects) to its container lazily. */
  function lazyConnection(zone) {
    let conn
    let pending
    const get = () => {
      if (conn && conn.failure === undefined && !conn.closed) return conn.ready.then(() => conn)
      pending ??= (async () => {
        const { host, token } = await manager('ensure', zone)
        const c = new ToolConnection({ host, token, workspace: rootsOf(zone)[0] })
        await c.ready
        conn = c
        return c
      })().finally(() => { pending = undefined })
      return pending
    }
    return {
      get ready() { return get().then(c => c.ready) },
      async request(...args) { return (await get()).request(...args) },
      async connectStream(...args) { return (await get()).connectStream(...args) },
      async dispose() { await conn?.dispose(); conn = undefined },
    }
  }

  /** zone → { fs, subprocess, sandbox, ssh, last } built synchronously (spawn is synchronous). */
  const zones = new Map()
  function bundle(zone) {
    let b = zones.get(zone)
    if (b === undefined) {
      const zctx = new Context()
      const ssh = lazyConnection(zone)
      zctx.provide('ssh', ssh)
      zctx.provide('sandboxPolicy', policyService)
      b = { ssh, fs: new SshFileSystem(zctx), subprocess: new SshSubprocessRuntime(zctx), sandbox: new SshSandboxProvider(zctx), last: 0 }
      zones.set(zone, b)
      log(`vùng ${zone} sẵn sàng`)
    }
    b.last = Date.now()
    return b
  }
  const sweeper = setInterval(() => {
    for (const [zone, b] of zones) {
      if (Date.now() - b.last < idleMs) continue
      zones.delete(zone)
      void b.ssh.dispose().catch(() => {})
      void manager('release', zone).catch(() => {})
      log(`vùng ${zone} rảnh, đã tắt`)
    }
  }, SWEEP_MS)
  sweeper.unref()
  ctx.effect(() => () => {
    clearInterval(sweeper)
    for (const [zone, b] of zones) { void b.ssh.dispose().catch(() => {}); void manager('release', zone).catch(() => {}) }
    zones.clear()
  }, 'exec-router: zones')

  const zoneNow = policy => zoneOfCall(ctx.agents, ctx.get('sessions'), policy?.sessionId, log)
  const targetIn = (zone, target) => assertInZone(zone, String(target?.targetKey))

  class RoutedFileSystem extends FileSystem {
    get sandboxMode() { return policyService.defaultMode }
    async resolve(p, opts) {
      const zone = zoneNow()
      assertInZone(zone, p, opts?.cwd ?? rootsOf(zone)[0])
      const target = await bundle(zone).fs.resolve(p, opts)
      targetIn(zone, target) // the helper resolved links: the result must stay inside too
      return target
    }
    processPath(target) { return String(target.targetKey) }
    fileUrl(target) { return pathToFileURL(this.processPath(target)).href }
    contains(parent, child) {
      const rel = path.posix.relative(this.processPath(parent), this.processPath(child))
      return rel === '' || (!rel.startsWith('../') && rel !== '..' && !path.posix.isAbsolute(rel))
    }
    async stat(target, signal) { const z = zoneNow(); targetIn(z, target); return bundle(z).fs.stat(target, signal) }
    async lstat(p, opts, signal) { const z = zoneNow(); assertInZone(z, p, opts?.cwd ?? rootsOf(z)[0]); return bundle(z).fs.lstat(p, opts, signal) }
    async readText(target, signal) { const z = zoneNow(); targetIn(z, target); return bundle(z).fs.readText(target, signal) }
    async streamText(target, signal) { const z = zoneNow(); targetIn(z, target); return bundle(z).fs.streamText(target, signal) }
    async readBytes(target, signal, maxBytes) { const z = zoneNow(); targetIn(z, target); return bundle(z).fs.readBytes(target, signal, maxBytes) }
    async readByteRange(target, range, signal) { const z = zoneNow(); targetIn(z, target); return bundle(z).fs.readByteRange(target, range, signal) }
    async listDir(target, signal) { const z = zoneNow(); targetIn(z, target); return bundle(z).fs.listDir(target, signal) }
    async writeText(target, content, expected, signal, policy) {
      const z = zoneNow(policy); targetIn(z, target)
      return bundle(z).fs.writeText(target, content, expected, signal, policy)
    }
    async editText(target, edit, expected, signal, policy) {
      const z = zoneNow(policy); targetIn(z, target)
      return bundle(z).fs.editText(target, edit, expected, signal, policy)
    }
  }

  class RoutedSubprocess extends SubprocessRuntime {
    spawn(spec) {
      const z = zoneNow()
      assertInZone(z, spec.cwd)
      return bundle(z).subprocess.spawn(spec)
    }
    async spawnTerminal() { throw new ZoneError('Terminal tương tác chưa được hỗ trợ trong sandbox công cụ.') }
    async resolveExecutable(command, env, signal) { return bundle(zoneNow()).subprocess.resolveExecutable(command, env, signal) }
    async terminalEnvironment(signal) { return bundle(zoneNow()).subprocess.terminalEnvironment(signal) }
  }

  /** Throw away a zone's container and connection; the next call starts a fresh one. */
  async function recycle(zone, reason) {
    const b = zones.get(zone)
    zones.delete(zone)
    await b?.ssh.dispose().catch(() => {})
    await manager('release', zone).catch(() => {})
    log(`vùng ${zone}: tạo lại container (${reason})`)
  }

  class RoutedSandbox extends SandboxProvider {
    async confine(argv, policy, signal) {
      const z = zoneNow(policy)
      assertInZone(z, policy.workspaceRoot)
      try {
        return await bundle(z).sandbox.confine(argv, policy, signal)
      } catch (error) {
        // The container's sandbox probe failed (a container still starting, or one whose
        // processes are exhausted): recreate it once instead of leaving the user stuck.
        if (error?.name !== 'SandboxUnavailableError') throw error
        await recycle(z, error.message.slice(0, 80))
        return bundle(z).sandbox.confine(argv, policy, signal)
      }
    }
  }

  ctx.plugin(RoutedFileSystem)
  ctx.plugin(RoutedSubprocess)
  ctx.plugin(RoutedSandbox)
  log(`định tuyến công cụ qua ${managerUrl}`)
}
