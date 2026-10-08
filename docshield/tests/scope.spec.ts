import { describe, expect, it } from 'vitest'
import { readableScopes, resolveScope } from '../src/scope.js'

const identity = (p: string) => p
const win = { platform: 'win32' as const, realpath: identity }
const posix = { platform: 'linux' as const, realpath: identity }
const ROOT = 'E:\\Deepseek_Harness\\spike-dshpw\\storage'

describe('resolveScope (win32)', () => {
  it('maps users/<u> and nested folders to that user', () => {
    expect(resolveScope(`${ROOT}\\users\\alice`, ROOT, win)).toEqual({ inside: true, scope: { role: 'user', userId: 'alice' } })
    expect(resolveScope(`${ROOT}\\users\\alice\\docs`, ROOT, win).scope).toEqual({ role: 'user', userId: 'alice' })
  })

  it('maps admin to the admin role', () => {
    expect(resolveScope(`${ROOT}\\admin`, ROOT, win).scope).toEqual({ role: 'admin' })
  })

  it('matches the root case-insensitively and accepts forward slashes', () => {
    expect(resolveScope('e:/deepseek_harness/SPIKE-DSHPW/storage/users/bob', ROOT, win).scope).toEqual({ role: 'user', userId: 'bob' })
  })

  it('denies malformed places inside the root', () => {
    for (const cwd of [ROOT, `${ROOT}\\users`, `${ROOT}\\public_docs`, `${ROOT}\\.docshield`, `${ROOT}\\users\\Alice`, `${ROOT}\\users\\a`, `${ROOT}\\users\\al ice`]) {
      expect(resolveScope(cwd, ROOT, win), cwd).toEqual({ inside: true, scope: null })
    }
  })

  it('normalises traversal before deciding (TC-04)', () => {
    expect(resolveScope(`${ROOT}\\users\\bob\\..\\alice`, ROOT, win).scope).toEqual({ role: 'user', userId: 'alice' })
    expect(resolveScope(`${ROOT}\\users\\bob\\..\\..\\admin`, ROOT, win).scope).toEqual({ role: 'admin' })
    expect(resolveScope(`${ROOT}\\users\\..\\..\\dsh-home`, ROOT, win)).toEqual({ inside: false, scope: null })
  })

  it('treats sibling folders with a shared prefix as outside', () => {
    expect(resolveScope(`${ROOT}-evil\\users\\alice`, ROOT, win)).toEqual({ inside: false, scope: null })
    expect(resolveScope('C:\\Users\\Asus', ROOT, win)).toEqual({ inside: false, scope: null })
    expect(resolveScope(undefined, ROOT, win)).toEqual({ inside: false, scope: null })
  })

  it('denies a link from outside into a user folder (inside, no scope)', () => {
    const realpath = (p: string) => p.replace('\\link-to-bob', '\\storage\\users\\bob')
    expect(resolveScope('E:\\Deepseek_Harness\\spike-dshpw\\link-to-bob', ROOT, { platform: 'win32', realpath }))
      .toEqual({ inside: true, scope: null })
  })
})

describe('resolveScope (links inside a user folder)', () => {
  const R = '/data'
  const linked = (target: string) => ({ platform: 'linux' as const, realpath: (p: string) => p.replace('/data/users/alice/lt', target) })

  it('denies a link to another user or to admin', () => {
    expect(resolveScope('/data/users/alice/lt', R, linked('/data/users/bob'))).toEqual({ inside: true, scope: null })
    expect(resolveScope('/data/users/alice/lt/docs', R, linked('/data/admin'))).toEqual({ inside: true, scope: null })
    expect(resolveScope('/data/users/alice/lt', R, linked('/etc'))).toEqual({ inside: true, scope: null })
  })

  it('keeps the scope when the link stays inside the same user folder', () => {
    expect(resolveScope('/data/users/alice/lt', R, linked('/data/users/alice/docs')).scope).toEqual({ role: 'user', userId: 'alice' })
  })
})

describe('resolveScope (posix)', () => {
  it('is case-sensitive on posix', () => {
    expect(resolveScope('/srv/storage/users/carol', '/srv/storage', posix).scope).toEqual({ role: 'user', userId: 'carol' })
    expect(resolveScope('/srv/STORAGE/users/carol', '/srv/storage', posix)).toEqual({ inside: false, scope: null })
  })
})

describe('readableScopes', () => {
  it('gives users public + own partition and admin public only', () => {
    expect(readableScopes({ role: 'user', userId: 'alice' })).toEqual(['public', 'user:alice'])
    expect(readableScopes({ role: 'admin' })).toEqual(['public'])
  })
})
