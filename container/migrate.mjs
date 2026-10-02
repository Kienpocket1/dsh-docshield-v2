// One-time copy of the Windows runtime into the Docker volumes of the shared DSH.
//   node container/migrate.mjs [--from E:\Deepseek_Harness\runtime] [--prefix docshield] [--force]
// Never deletes the source. Refuses non-empty volumes unless --force.
// Everything copied is chowned to 1000:1000 (dsh-main and tool containers run as uid 1000), then checked.
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'

const arg = (name, fallback) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : fallback }
const FROM = path.resolve(arg('--from', 'E:\\Deepseek_Harness\\runtime'))
const P = arg('--prefix', 'docshield')
const FORCE = process.argv.includes('--force')
if (!/^[a-z][a-z0-9-]{1,20}$/.test(P)) throw new Error('prefix không hợp lệ')
const DOCKER = existsSync('E:/Docker/DockerDesktop/resources/bin/docker.exe') ? 'E:/Docker/DockerDesktop/resources/bin/docker.exe' : 'docker'
const VOL = { storage: `${P}-storage`, home: `${P}-home`, db: `${P}-db`, gate: `${P}-gate` }
for (const sub of ['storage', 'home', 'gate-var']) if (!existsSync(path.join(FROM, sub))) throw new Error(`thiếu ${path.join(FROM, sub)}`)

const docker = args => execFileSync(DOCKER, args, { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'inherit'] })
for (const v of Object.values(VOL)) docker(['volume', 'create', v])

// The copy runs in a throwaway root container: source read-only, destinations the volumes.
const script = `
set -e
for d in /dst/storage /dst/home /dst/db /dst/gate; do
  if [ -n "$(ls -A $d)" ] && [ "$FORCE" != 1 ]; then echo "volume $d không rỗng (dùng --force)"; exit 3; fi
done
# Documents and models; the database goes to its own volume.
cp -a /src/storage/. /dst/storage/
rm -f /dst/storage/.docshield/docshield.db /dst/storage/.docshield/docshield.db-wal /dst/storage/.docshield/docshield.db-shm
for f in docshield.db docshield.db-wal docshield.db-shm; do [ -f /src/storage/.docshield/$f ] && cp /src/storage/.docshield/$f /dst/db/$f || true; done
# DSH home: model settings + key reference only (profile and presets are written by dsh-main at start).
cp /src/home/settings.yaml /dst/home/settings.yaml
[ -f /src/home/.credentials.yaml ] && cp /src/home/.credentials.yaml /dst/home/.credentials.yaml || true
sed -i 's#http://127.0.0.1:20128#http://host.docker.internal:20128#g; s#http://localhost:20128#http://host.docker.internal:20128#g' /dst/home/settings.yaml
# Gate accounts and cookie secret.
cp /src/gate-var/gate.db /dst/gate/gate.db
[ -f /src/gate-var/secret.key ] && cp /src/gate-var/secret.key /dst/gate/secret.key || echo "chưa có secret.key: gate sẽ tự tạo"
chown -R 1000:1000 /dst/storage /dst/home /dst/db /dst/gate
chmod 600 /dst/gate/secret.key /dst/home/.credentials.yaml 2>/dev/null || true
# Check: nothing left that uid 1000 does not own.
bad=$(find /dst/storage /dst/home /dst/db /dst/gate ! -user 1000 | head -5)
if [ -n "$bad" ]; then echo "chưa đổi chủ: $bad"; exit 4; fi
echo "users: $(ls /dst/storage/users | tr '\\n' ' ')"
echo "db: $(ls -la /dst/db | tail -n +4 | awk '{print $5, $9}' | tr '\\n' ' ')"
echo "model: $(grep -o 'host.docker.internal:[0-9]*' /dst/home/settings.yaml | head -1)"
`
const out = docker(['run', '--rm', '-e', `FORCE=${FORCE ? 1 : 0}`,
  '-v', `${FROM}:/src:ro`,
  '-v', `${VOL.storage}:/dst/storage`, '-v', `${VOL.home}:/dst/home`, '-v', `${VOL.db}:/dst/db`, '-v', `${VOL.gate}:/dst/gate`,
  'alpine', 'sh', '-c', script])
console.log(out.trim())
console.log(`Đã chép ${FROM} → ${Object.values(VOL).join(', ')}`)
