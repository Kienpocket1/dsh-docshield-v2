import assert from 'node:assert/strict'
import path from 'node:path'
import { describe, it } from 'node:test'
import { USER_PRESET, checkCall, checkOpen, collect, filterItem, filterResult, isInside } from '../src/policy.mjs'

const STORAGE = path.resolve('/storage')
const ALICE = path.join(STORAGE, 'users', 'alice')
const BOB = path.join(STORAGE, 'users', 'bob')
const cwd = new Map([['s-alice', ALICE], ['s-alice-sub', path.join(ALICE, 'docs')], ['s-bob', BOB], ['s-admin', path.join(STORAGE, 'admin')]])
const workspaces = new Map([['w-alice', ALICE], ['w-bob', BOB]])

function access() {
  const learned = []
  const grants = new Set()
  const inRoot = p => isInside(ALICE, p)
  return {
    root: ALICE,
    inRoot,
    owns: id => inRoot(cwd.get(id)),
    known: id => cwd.has(id),
    workspacePath: id => workspaces.get(id),
    ownsWorkspace: id => inRoot(workspaces.get(id)),
    learn: (id, p) => learned.push([id, p]),
    grantEvent: id => grants.add(id),
    hasEvent: id => grants.has(id),
    learned,
    grants,
  }
}

describe('isInside', () => {
  it('matches the folder and below, not siblings with a shared prefix', () => {
    assert.ok(isInside(ALICE, ALICE))
    assert.ok(isInside(ALICE, path.join(ALICE, 'docs', 'a.md')))
    assert.ok(!isInside(ALICE, path.join(STORAGE, 'users', 'alice2')))
    assert.ok(!isInside(ALICE, path.join(ALICE, '..', 'bob')))
    assert.ok(!isInside(ALICE, 'docs/a.md'))
    assert.ok(!isInside(ALICE, undefined))
  })
  it('ignores case on Windows', { skip: process.platform !== 'win32' }, () => {
    assert.ok(isInside(ALICE, ALICE.toUpperCase()))
  })
})

describe('collect', () => {
  it('finds ids and paths anywhere except message content', () => {
    const { ids, paths } = collect({ agentId: 'a', request: { sessionId: 'b', address: { kind: 'subagent', parentSessionId: 'c', childSessionId: 'd' }, path: '/x', content: [{ sessionId: 'hidden' }] } })
    assert.deepEqual(ids.sort(), ['a', 'b', 'c', 'd'])
    assert.deepEqual(paths, ['/x'])
  })
})

describe('checkCall', () => {
  it('lets global reads through and fakes the terminal list', () => {
    assert.deepEqual(checkCall('session/modelCatalog', {}, access()), { allow: true })
    assert.deepEqual(checkCall('terminal/list', { sessionId: 's-alice' }, access()), { fake: [] })
  })
  it('requires every session id to be owned', () => {
    assert.equal(checkCall('session/prompt', { request: { sessionId: 's-alice', content: [] } }, access()).allow, true)
    assert.equal(checkCall('session/prompt', { request: { sessionId: 's-bob' } }, access()).allow, false)
    assert.equal(checkCall('session/prompt', { request: {} }, access()).allow, false)
    assert.equal(checkCall('commands/execute', { agentId: 's-bob', line: '/export' }, access()).allow, false)
    assert.equal(checkCall('session/page', { request: { address: { kind: 'session', sessionId: 's-bob' } } }, access()).allow, false)
    assert.equal(checkCall('subagents/prompt', { request: { parentSessionId: 's-alice', childSessionId: 's-bob' } }, access()).allow, false)
  })
  it('refuses unknown and admin-only endpoints', () => {
    for (const m of ['pluginManager/install', 'terminal/create', 'settings/update', 'credentials/set', 'directoryPicker/pick', 'session/openWorkspacePath', 'workspace/delete', 'whatever/new']) {
      assert.equal(checkCall(m, {}, access()).allow, false, m)
    }
  })
  it('creates sessions only in the user folder, forcing the DocShield preset', () => {
    const ok = checkCall('session/create', { request: { workspaceId: 'w-alice', agentPreset: 'standard' } }, access())
    assert.equal(ok.allow, true)
    assert.equal(ok.args.request.agentPreset, USER_PRESET)
    assert.equal(checkCall('session/create', { request: { cwd: path.join(ALICE, 'docs') } }, access()).allow, true)
    assert.equal(checkCall('session/create', { request: { workspaceId: 'w-bob' } }, access()).allow, false)
    assert.equal(checkCall('session/create', { request: { cwd: BOB } }, access()).allow, false)
    assert.equal(checkCall('session/create', { request: {} }, access()).allow, false, 'no cwd would mean the Host process folder')
    assert.equal(checkCall('session/create', { request: { workspaceId: 'w-alice', sessionId: 's-bob' } }, access()).allow, false, 'cannot adopt another user’s session')
    const linked = { ...access(), realInRoot: p => !p.includes('to-bob') }
    assert.equal(checkCall('session/create', { request: { cwd: path.join(ALICE, 'to-bob') } }, linked).allow, false, 'a link out of the folder')
  })
  it('keeps the directory picker inside the user folder', () => {
    const d = checkCall('directoryPicker/list', { request: {} }, access())
    assert.equal(d.args.request.path, ALICE)
    assert.equal(checkCall('directoryPicker/list', { request: { path: BOB } }, access()).allow, false)
  })
  it('refuses workspace file reads for normal users until the tool sandbox reads them', () => {
    assert.equal(checkCall('workspaceFiles/read', { workspaceFileScopeId: 's-alice', path: path.join(ALICE, 'docs', 'a.md') }, access()).allow, false)
    assert.equal(checkCall('workspaceFiles/list', { workspaceFileScopeId: 's-alice', path: ALICE }, access()).allow, false)
    assert.equal(checkCall('workspaceFiles/read', { workspaceFileScopeId: 's-alice', path: path.join(BOB, 'b.md') }, access()).allow, false)
    assert.equal(checkCall('workspaceFiles/readRelated', { workspaceFileScopeId: 's-alice', path: 'docs', relativePath: '../../bob/b.md' }, access()).allow, false)
  })
})

describe('filterResult', () => {
  it('trims lists to owned sessions', () => {
    const list = filterResult('session/list', { items: [{ sessionId: 's-alice', cwd: ALICE }, { sessionId: 's-bob', cwd: BOB }] }, access())
    assert.deepEqual(list.items.map(s => s.sessionId), ['s-alice'])
    const search = filterResult('session/search', { items: [{ sessionId: 's-bob' }, { sessionId: 's-alice' }], hasMore: false }, access())
    assert.deepEqual(search.items.map(s => s.sessionId), ['s-alice'])
    assert.deepEqual(filterResult('workspace/archiveSession', { archivedSessionIds: ['s-bob', 's-alice'] }, access()).archivedSessionIds, ['s-alice'])
  })
})

describe('streams', () => {
  it('opens only the four UI streams, session/follow for owned sessions', () => {
    assert.equal(checkOpen('workspace/follow', {}, access()).allow, true)
    assert.equal(checkOpen('terminal/follow', { agentId: 's-alice' }, access()).allow, false)
    assert.equal(checkOpen('session/follow', { request: { address: { kind: 'session', sessionId: 's-alice' } } }, access()).allow, true)
    assert.equal(checkOpen('session/follow', { request: { address: { kind: 'session', sessionId: 's-bob' } } }, access()).allow, false)
  })
  it('filters the workspace baseline and learns its sessions', () => {
    const a = access()
    const out = filterItem('workspace/follow', { type: 'baseline', value: { items: [{ workspaceId: 'w-alice', path: ALICE, sessionIds: ['s-alice'] }, { workspaceId: 'w-bob', path: BOB, sessionIds: ['s-bob'] }], archivedSessionIds: ['s-bob'] } }, a)
    assert.deepEqual(out.value.value.items.map(w => w.workspaceId), ['w-alice'])
    assert.deepEqual(out.value.value.archivedSessionIds, [])
    assert.deepEqual(a.learned, [['s-alice', ALICE]])
    assert.equal(filterItem('workspace/follow', { type: 'upsert', workspace: { workspaceId: 'w-bob', path: BOB } }, a).keep, false)
    assert.deepEqual(filterItem('workspace/follow', { type: 'order', workspaceIds: ['w-bob', 'w-alice'] }, a).value.workspaceIds, ['w-alice'])
  })
  it('filters session control records', () => {
    const out = filterItem('session/control', { type: 'baseline', value: { jobs: { 's-alice': [], 's-bob': [] }, projections: { 's-bob': {} } } }, access())
    assert.deepEqual(Object.keys(out.value.value.jobs), ['s-alice'])
    assert.deepEqual(out.value.value.projections, {})
    assert.equal(filterItem('session/control', { type: 'jobs', sessionId: 's-bob', jobs: [] }, access()).keep, false)
  })
  it('refuses a follow snapshot from another folder', () => {
    assert.equal(filterItem('session/follow', { type: 'snapshot', header: { id: 's-bob', cwd: BOB } }, access()).keep, false)
    assert.equal(filterItem('session/follow', { type: 'snapshot', header: { id: 's-alice', cwd: ALICE } }, access()).keep, true)
  })
  it('forwards only own approvals and session events', () => {
    const a = access()
    assert.equal(filterItem('$events', { type: 'ready', clientId: 'c' }, a).keep, true)
    assert.equal(filterItem('$events', { type: 'waterfall', event: 'approval/request', eventId: 'e1', agentId: 's-alice', request: {} }, a).keep, true)
    assert.ok(a.grants.has('e1'))
    assert.equal(filterItem('$events', { type: 'waterfall', event: 'approval/request', eventId: 'e2', agentId: 's-bob', request: {} }, a).keep, false)
    assert.equal(filterItem('$events', { type: 'cancel', eventId: 'e2' }, a).keep, false)
    assert.equal(filterItem('$events', { type: 'emit', event: 'api-session/status', args: ['s-bob', 'running'] }, a).keep, false)
    assert.equal(filterItem('$events', { type: 'emit', event: 'api-session/status', args: ['s-alice', 'running'] }, a).keep, true)
    assert.equal(filterItem('$events', { type: 'emit', event: 'api-session/added', args: [{ sessionId: 'new', cwd: ALICE }] }, a).keep, true)
    assert.deepEqual(a.learned.at(-1), ['new', ALICE])
    assert.equal(filterItem('$events', { type: 'emit', event: 'plugin-manager/changed', args: [] }, a).keep, false)
    assert.equal(filterItem('$events', { type: 'emit', event: 'commands/change', args: [] }, a).keep, true)
  })
})
