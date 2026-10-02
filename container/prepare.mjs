// Build inputs that live outside this repo, into container/build/ (gitignored):
//   helper.bundle.mjs  — DSH's SSH helper as one file (natives stay external, installed in the image)
//   ssh-pkgs/<name>/   — package.json + lib/ of dsh-ssh, dsh-fs-ssh, dsh-subprocess-ssh, dsh-sandbox-ssh
// Usage (repo root): node container/prepare.mjs [path/to/deepseek-harness]
import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const dsh = path.resolve(process.argv[2] ?? path.join(here, '..', '..', 'deepseek-harness'))
const out = path.join(here, 'build')
const esbuild = path.join(here, '..', 'docshield', 'node_modules', 'esbuild', 'bin', 'esbuild')

mkdirSync(out, { recursive: true })
execFileSync(process.execPath, [esbuild, path.join(dsh, 'packages/ssh/ssh/src/helper-entry.ts'),
  '--bundle', '--platform=node', '--target=node24', '--format=esm',
  `--outfile=${path.join(out, 'helper.bundle.mjs')}`,
  '--external:node-pty', '--external:@deepseek-ai/node-addon-system', '--external:@deepseek-ai/node-addon-system/*',
  "--banner:js=import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
], { stdio: 'inherit', cwd: path.join(dsh, 'packages/ssh/ssh') })

const pkgs = path.join(out, 'ssh-pkgs')
rmSync(pkgs, { recursive: true, force: true })
for (const name of ['ssh', 'fs-ssh', 'subprocess-ssh', 'sandbox-ssh']) {
  const src = path.join(dsh, 'packages/ssh', name)
  const dst = path.join(pkgs, `dsh-${name}`)
  mkdirSync(dst, { recursive: true })
  cpSync(path.join(src, 'package.json'), path.join(dst, 'package.json'))
  cpSync(path.join(src, 'lib'), path.join(dst, 'lib'), { recursive: true })
  console.log(`copied ${name} → ${path.relative(here, dst)}`)
}
