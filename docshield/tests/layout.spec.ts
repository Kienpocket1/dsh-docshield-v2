import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { targetForPath, uploadDirFor } from '../src/ingest/layout.js'

const root = path.resolve('/s')
const alice = { role: 'user', userId: 'alice' } as const

describe('workspace docs', () => {
  it('uploads land in the session workspace', () => {
    expect(uploadDirFor(root, alice, path.join(root, 'users/alice/wsp1/src')).dir).toBe(path.join(root, 'users/alice/wsp1/docs'))
    expect(uploadDirFor(root, alice, path.join(root, 'users/alice')).dir).toBe(path.join(root, 'users/alice/docs'))
    expect(uploadDirFor(root, alice, path.join(root, 'users/alice/docs')).dir).toBe(path.join(root, 'users/alice/docs'))
    expect(uploadDirFor(root, alice, path.join(root, 'users/bob/wsp1')).dir).toBe(path.join(root, 'users/alice/docs'))
  })

  it('indexes workspace docs under the user scope with distinct keys', () => {
    const a = targetForPath(root, path.join(root, 'users/alice/wsp1/docs/a.txt'))
    const b = targetForPath(root, path.join(root, 'users/alice/wsp2/docs/a.txt'))
    expect(a?.scope).toBe('user:alice')
    expect(a?.docKey).not.toBe(b?.docKey)
    expect(targetForPath(root, path.join(root, 'users/alice/docs/a.txt'))?.docKey).toBe('doc_a')
    expect(targetForPath(root, path.join(root, 'users/alice/x/y/docs/a.txt'))).toBeNull()
    expect(targetForPath(root, path.join(root, 'users/alice/docs/docs/a.txt'))).toBeNull()
  })
})
