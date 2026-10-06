// First run of a CLEAN instance (no Windows runtime to migrate): create its Docker volumes with the
// empty layout, a model-settings template without any API key, and optionally the embedding model
// copied from another instance's storage volume (read-only; only .docshield/models is read).
//   node container/init-instance.mjs --prefix congty [--model-from docshield-storage] [--force]
// The first admin is created in the browser (/gate/setup, one-time code printed in the log); the
// model's API key is entered by that admin in DSH's model settings. Nothing secret is written here.
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'

const arg = (name, fallback) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : fallback }
const P = arg('--prefix')
const MODEL_FROM = arg('--model-from')
const FORCE = process.argv.includes('--force')
if (!/^[a-z][a-z0-9-]{1,20}$/.test(P ?? '')) throw new Error('cần --prefix hợp lệ (chữ thường, số, gạch ngang)')
if (MODEL_FROM !== undefined && !/^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/.test(MODEL_FROM)) throw new Error('--model-from không hợp lệ')
const DOCKER = existsSync('E:/Docker/DockerDesktop/resources/bin/docker.exe') ? 'E:/Docker/DockerDesktop/resources/bin/docker.exe' : 'docker'
const docker = args => execFileSync(DOCKER, args, { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'inherit'] }).trim()
const VOL = { storage: `${P}-storage`, home: `${P}-home`, db: `${P}-db`, gate: `${P}-gate` }
for (const v of Object.values(VOL)) docker(['volume', 'create', v])

// Model settings: the router on this machine (9Router at :20128), key read from NIEN_ROUTER_API_KEY,
// which the admin fills in through DSH's settings. Change provider/model in the UI as needed.
const SETTINGS = `ui-onboarding:
  welcomeNoticeVersion: 2026-08-13.1
llm-pi-ai:
  providers:
    nien-router:
      apiKeyEnv: NIEN_ROUTER_API_KEY
      api: openai-completions
      baseURL: http://host.docker.internal:20128/v1
      models:
        - id: my-models-free
agent-default-model:
  provider: nien-router
  model: my-models-free
agent-presets:
  modeSelectionEnabled: false
  default: docshield-admin-harness
`
const script = `
set -e
if [ -n "$(ls -A /h)" ] && [ "$FORCE" != 1 ]; then echo "volume ${VOL.home} không rỗng: bản này đã khởi tạo (dùng --force để ghi lại settings)"; exit 3; fi
mkdir -p /s/users /s/admin/docs /s/public_docs /s/.docshield
[ -f /h/settings.yaml ] && [ "$FORCE" != 1 ] || printf '%s' "$SETTINGS" > /h/settings.yaml
chown -R 1000:1000 /s /h /d /g
chmod 750 /s/users /s/admin /s/admin/docs /s/public_docs
echo "storage: $(ls /s | tr '\\n' ' ')"
`
console.log(docker(['run', '--rm', '-e', `FORCE=${FORCE ? 1 : 0}`, '-e', `SETTINGS=${SETTINGS}`,
  '-v', `${VOL.storage}:/s`, '-v', `${VOL.home}:/h`, '-v', `${VOL.db}:/d`, '-v', `${VOL.gate}:/g`, 'alpine', 'sh', '-c', script]))

if (MODEL_FROM) {
  // Only the model folder is read from the source volume, mounted read-only.
  const out = docker(['run', '--rm', '-v', `${MODEL_FROM}:/src:ro`, '-v', `${VOL.storage}:/s`, 'alpine', 'sh', '-c',
    'if [ ! -d /src/.docshield/models ]; then echo "không có mô hình trong nguồn"; exit 0; fi; if [ -d /s/.docshield/models ]; then echo "đã có mô hình"; exit 0; fi; cp -a /src/.docshield/models /s/.docshield/ && chown -R 1000:1000 /s/.docshield && du -sh /s/.docshield/models'])
  console.log(`mô hình nhúng: ${out}`)
} else {
  console.log('chưa có mô hình nhúng: DocShield sẽ không nạp được tài liệu cho tới khi chép mô hình vào .docshield/models')
}
console.log(`Đã khởi tạo bản sạch ${Object.values(VOL).join(', ')}`)
