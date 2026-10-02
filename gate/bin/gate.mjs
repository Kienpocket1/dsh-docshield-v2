#!/usr/bin/env node
// dsh-gate CLI.
//   node bin/gate.mjs serve [--plugin]          start the gate (normally done by the dsh-gate DSH plugin)
//   node bin/gate.mjs user add <name> [--role user|admin] [--password-stdin]
//   node bin/gate.mjs user passwd <name> [--password-stdin]
//   node bin/gate.mjs user disable|enable <name>
//   node bin/gate.mjs user approve|reject <name>   (self-registration requests)
//   node bin/gate.mjs user list
//   node bin/gate.mjs audit [n]
import { randomBytes } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import { createGate } from '../src/app.mjs'
import { loadConfig } from '../src/config.mjs'
import { createFilter } from '../src/filter.mjs'
import { hashPassword } from '../src/password.mjs'
import { loadSecret } from '../src/session.mjs'
import { SessionIndex, callUpstream } from '../src/sessions.mjs'
import { GateStore } from '../src/store.mjs'
import { Upstream } from '../src/upstream.mjs'

const config = loadConfig()
mkdirSync(config.varDir, { recursive: true })
const store = new GateStore(path.join(config.varDir, 'gate.db'))
const [cmd, sub, name] = process.argv.slice(2)
const flag = f => process.argv.includes(f)
const option = (f, fallback) => { const i = process.argv.indexOf(f); return i > 0 ? process.argv[i + 1] : fallback }

try {
  if (cmd === 'serve') await serve()
  else if (cmd === 'user' && sub === 'add') {
    store.addUser(name, option('--role', 'user'), await hashPassword(await askPassword(true)))
    store.audit('user_added', { username: name, detail: option('--role', 'user') })
    console.log(`Đã tạo tài khoản ${name}.`)
  } else if (cmd === 'user' && sub === 'passwd') {
    store.setPassword(name, await hashPassword(await askPassword(true)))
    store.audit('password_changed', { username: name })
    console.log(`Đã đổi mật khẩu ${name}; các phiên đăng nhập cũ bị hủy.`)
  } else if (cmd === 'user' && (sub === 'disable' || sub === 'enable')) {
    store.setDisabled(name, sub === 'disable')
    store.audit(`user_${sub}d`, { username: name })
    console.log(`${sub === 'disable' ? 'Đã khóa' : 'Đã mở khóa'} ${name}.`)
  } else if (cmd === 'user' && (sub === 'approve' || sub === 'reject')) {
    store[sub](name)
    store.audit(sub === 'approve' ? 'approved' : 'rejected', { username: name, detail: 'bởi dòng lệnh' })
    console.log(`${sub === 'approve' ? 'Đã duyệt' : 'Đã từ chối'} ${name}.`)
  } else if (cmd === 'user' && sub === 'list') {
    console.table(store.listUsers())
  } else if (cmd === 'audit') {
    console.table(store.recentAudit(Number(sub ?? 30)))
  } else {
    console.log('Dùng: node bin/gate.mjs serve | user add|passwd|disable|enable|approve|reject|list <tên> | audit [n]')
    process.exitCode = 1
  }
} catch (err) {
  console.error(`Lỗi: ${err.message}`)
  process.exitCode = 1
} finally {
  if (cmd !== 'serve') store.close()
}

async function serve() {
  const log = msg => console.log(`${new Date().toISOString().slice(11, 19)} gate: ${msg}`)
  if (!config.upstreamUrl || !config.storageRoot) {
    console.error('[LOI] Gate chay nhu plugin cua DSH (dsh-gate): can GATE_UPSTREAM_URL va DOCSHIELD_STORAGE_ROOT.')
    process.exit(1)
  }
  const upstream = new Upstream(config.upstreamUrl)
  const call = (method, args) => callUpstream(upstream, method, args)
  const sessions = new SessionIndex(call)
  const filter = createFilter({ upstream, sessions, call, storageRoot: config.storageRoot, log })
  // No account yet: allow /gate/setup, guarded by a one-time key only this console shows.
  const setupKey = store.countUsers() === 0 ? randomBytes(6).toString('hex').match(/.{4}/g).join('-') : undefined
  const gate = createGate({ store, secret: loadSecret(path.join(config.varDir, 'secret.key')), upstream, filter, setupKey, trustProxy: config.trustProxy, egressLog: config.egressLog, log })
  await new Promise(resolve => gate.listen(config.port, config.host, resolve))
  log(`http://${config.host}:${config.port} (DSH ${upstream.origin})`)
  if (setupKey !== undefined) {
    console.log('')
    console.log('  ================= THIET LAP LAN DAU =================')
    console.log(`  Chua co tai khoan. Mo http://${config.host}:${config.port}/gate/setup`)
    console.log(`  Ma thiet lap:  ${setupKey}`)
    console.log('  (Ma dung mot lan; trang tu khoa sau khi tao admin.)')
    console.log('  =====================================================')
    console.log('')
  }
  const shutdown = () => {
    gate.close()
    store.close()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
  process.on('SIGHUP', shutdown)
  // Started by the dsh-gate plugin: its pipe closes when DSH exits, and the gate goes with it.
  if (flag('--plugin')) {
    process.stdin.on('end', shutdown)
    process.stdin.on('close', shutdown)
    process.stdin.resume()
  }
}

/** Password from stdin (--password-stdin) or a hidden TTY prompt, asked twice when confirming. */
async function askPassword(confirm) {
  if (flag('--password-stdin')) {
    const chunks = []
    for await (const c of process.stdin) chunks.push(c)
    // PowerShell pipes may prefix a BOM; it is never part of the password.
    return Buffer.concat(chunks).toString('utf8').replace(/^﻿/, '').replace(/\r?\n$/, '')
  }
  const first = await hiddenPrompt('Mật khẩu: ')
  if (confirm && first !== await hiddenPrompt('Nhập lại: ')) throw new Error('Hai lần nhập không khớp.')
  return first
}

function hiddenPrompt(question) {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true })
    rl._writeToOutput = s => { if (s.includes(question)) process.stdout.write(question) }
    rl.question(question, answer => { rl.close(); process.stdout.write('\n'); resolve(answer) })
  })
}
