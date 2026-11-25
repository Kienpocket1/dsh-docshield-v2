// Read-only audit of dsh-passwords subuser permissions against DocShield conventions.
//   DSHPW_DB=<platform.db> node scripts/doctor.mjs
// Usernames are encrypted at rest, so subusers are reported by id and folder.
import { existsSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { dshHome, pathKey, PRESET_IDS, storageRoot, USER_ID_PATTERN } from './lib.mjs'

// Presets shipped inside DSH itself (not under <DSH_HOME>/.agent-presets).
const SHIPPED_PRESETS = ['standard', 'minimal', 'ptc', 'cordis']
const dbPath = process.env.DSHPW_DB ?? ''
if (!existsSync(dbPath)) {
  console.error(`Không thấy database dsh-passwords: ${dbPath} (đặt DSHPW_DB)`)
  process.exit(2)
}
const root = storageRoot()
const usersKey = pathKey(path.join(root, 'users'))
const db = new DatabaseSync(dbPath, { readOnly: true })
const rows = db.prepare(`
  SELECT u.id, p.allowed_folders, p.allowed_agent_presets, p.allow_upload, p.banned
  FROM users u LEFT JOIN user_permissions p ON p.user_id = u.id
  WHERE u.role = 'user' ORDER BY u.id`).all()

let problems = 0
const owners = new Map()
const report = (id, level, msg) => {
  if (level === 'LỖI') problems++
  console.log(`  [${level}] ${msg}`)
}

for (const row of rows) {
  console.log(`subuser id=${row.id}${row.banned ? ' (bị cấm)' : ''}`)
  const folders = [...new Set(JSON.parse(row.allowed_folders ?? '[]').map(pathKey))]
  const presets = row.allowed_agent_presets === null ? null : JSON.parse(row.allowed_agent_presets)
  if (folders.length !== 1 || folders[0] === pathKey('__deny__')) {
    report(row.id, 'LỖI', `cần đúng 1 thư mục storage/users/<tên>, đang có: ${JSON.stringify(folders)}`)
  } else {
    const folder = folders[0]
    const rel = path.posix.relative(usersKey, folder)
    if (rel === '' || rel.startsWith('..') || rel.includes('/') || !USER_ID_PATTERN.test(rel)) {
      report(row.id, 'LỖI', `thư mục không phải storage/users/<tên> hợp lệ: ${folder}`)
    } else {
      if (owners.has(rel)) report(row.id, 'LỖI', `thư mục "${rel}" đã cấp cho subuser id=${owners.get(rel)}`)
      owners.set(rel, row.id)
      if (!existsSync(path.join(root, 'users', rel, 'docs'))) report(row.id, 'CẢNH BÁO', `chưa có ${rel}/docs (chạy provision-user.mjs ${rel})`)
      console.log(`  thư mục: users/${rel}`)
    }
  }
  if (presets === null) {
    report(row.id, 'LỖI', 'không giới hạn agent mode → subuser dùng được preset có bash/đọc file')
  } else {
    const extra = presets.filter(p => p !== 'docshield')
    const installed = id => existsSync(path.join(dshHome(), '.agent-presets', id)) || SHIPPED_PRESETS.includes(id)
    const live = extra.filter(installed)
    const stale = extra.filter(p => !installed(p))
    if (!presets.includes('docshield')) report(row.id, 'LỖI', 'chưa tick agent mode "DocShield"')
    if (live.length > 0) report(row.id, 'CẢNH BÁO', `có thêm agent mode ngoài DocShield: ${live.join(', ')} (guard vẫn chặn trong storage/, nên bỏ tick)`)
    if (stale.length > 0) report(row.id, 'GHI CHÚ', `còn lưu agent mode đã gỡ: ${stale.join(', ')} (vô hại, không chọn được)`)
  }
  if (!row.allow_upload) report(row.id, 'CẢNH BÁO', 'chưa tick "Large file upload." → không tải tài liệu lên được')
}

for (const id of PRESET_IDS) {
  if (!existsSync(path.join(dshHome(), '.agent-presets', id, 'agent.cordis.yml'))) {
    console.log(`[LỖI] thiếu preset ${id} trong ${dshHome()}/.agent-presets (chạy install-presets.mjs)`)
    problems++
  }
}
console.log(problems === 0 ? '\nKhông có lỗi.' : `\n${problems} lỗi cần sửa.`)
process.exit(problems === 0 ? 0 : 1)
