/**
 * Entry point of container dsh-main: lay out the DSH profile in the home
 * volume (idempotent, rewritten every start), then exec DSH. The gate plugin
 * starts the sign-in gate; this script decides where it listens: on the
 * container's bridge-network address only (GATE_BIND_SUBNET), so tool
 * containers on the internal network cannot reach it.
 */
import { spawn } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const HOME = process.env.DSH_HOME ?? '/home/dsh'
const PLUGINS = '/opt/plugins'
const PROFILE = path.join(HOME, 'profiles', 'web')

// Profile: the DSH bundles + our three plugins (linked from the image).
mkdirSync(path.join(PROFILE, 'node_modules'), { recursive: true })
writeFileSync(path.join(PROFILE, 'package.json'), `${JSON.stringify({
  name: 'dsh-profile-web', private: true,
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-docshield', 'dsh-gate'] } },
}, null, 2)}\n`)
for (const f of ['cordis.yml', 'cordis.patch.yml']) if (!existsSync(path.join(PROFILE, f))) writeFileSync(path.join(PROFILE, f), '[]\n')
for (const name of ['dsh-docshield', 'dsh-gate', 'dsh-exec-router']) {
  const link = path.join(PROFILE, 'node_modules', name)
  rmSync(link, { force: true, recursive: false })
  symlinkSync(path.join(PLUGINS, name), link, 'dir')
}

// Presets: always the image's (DocShield + harness presets built for this DSH version).
const presets = path.join(HOME, '.agent-presets')
mkdirSync(presets, { recursive: true })
for (const id of ['docshield', 'docshield-admin', 'docshield-harness', 'docshield-admin-harness', 'p3-h1', 'p3-h2', 'p3-h3']) {
  rmSync(path.join(presets, id), { recursive: true, force: true })
  cpSync(path.join(PLUGINS, 'dsh-docshield', 'presets', id), path.join(presets, id), { recursive: true })
}

// Skills: the image's (container/skills) → $DSH_HOME/skills, found by dsh-skill-filesystem (user-dsh root).
for (const id of existsSync('/opt/dsh-skills') ? readdirSync('/opt/dsh-skills') : []) {
  const dst = path.join(HOME, 'skills', id)
  rmSync(dst, { recursive: true, force: true })
  cpSync(path.join('/opt/dsh-skills', id), dst, { recursive: true })
}

// Model settings come from migration (container/migrate.mjs); never invented here.
if (!existsSync(path.join(HOME, 'settings.yaml'))) {
  console.error('[dsh-main] Chưa có settings.yaml trong volume home: chạy container/migrate.mjs trước.')
  process.exit(1)
}
const settings = readFileSync(path.join(HOME, 'settings.yaml'), 'utf8')
if (!/^agent-presets:/m.test(settings)) {
  writeFileSync(path.join(HOME, 'settings.yaml'), `${settings.trimEnd()}\nagent-presets:\n  modeSelectionEnabled: false\n  default: docshield-admin-harness\n`)
}

// Gate listens on the bridge-network address only.
const env = { ...process.env, GATE_USER_PRESET: 'docshield-harness', GATE_ADMIN_REVIEW: '1',
  // Presets a user may pick when the admin assigned none: `docshield` (pure RAG, Project 3 H0). The ticket agents
  // p3-h1..h3 run on the admin side (project3/worker.py as p3admin).
  GATE_USER_EXTRA_PRESETS: process.env.GATE_USER_EXTRA_PRESETS ?? 'docshield',
  // Ticket review page /gate/admin/tickets reads and decides through DocShield's ticket CLI.
  GATE_TICKETS_CLI: path.join(PLUGINS, 'dsh-docshield', 'dist', 'cli', 'tickets.js') }
const subnet = process.env.GATE_BIND_SUBNET
if (subnet) {
  const [base, bits] = subnet.split('/')
  const toInt = ip => ip.split('.').reduce((n, o) => (n << 8) + Number(o), 0) >>> 0
  const mask = bits === '0' ? 0 : (~0 << (32 - Number(bits))) >>> 0
  const ip = Object.values(os.networkInterfaces()).flat().find(a => a?.family === 'IPv4' && ((toInt(a.address) & mask) === (toInt(base) & mask)))?.address
  if (!ip) { console.error(`[dsh-main] không tìm thấy địa chỉ trong ${subnet}`); process.exit(1) }
  env.GATE_HOST = ip
  console.log(`[dsh-main] gate nghe ${ip}:3444 (mạng bridge)`)
}

const dsh = spawn(process.execPath, ['/opt/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js',
  '--patch', '/opt/runtime.patch.yml', '--profile', 'web', '--host', '127.0.0.1', '--port', '0', '--no-open'],
{ env, stdio: 'inherit' })
for (const s of ['SIGTERM', 'SIGINT']) process.on(s, () => dsh.kill(s))
dsh.on('exit', code => process.exit(code ?? 1))
