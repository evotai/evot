import { test, expect } from 'bun:test'
import {
  CloudSessionSync, CLOUD_LABEL_WIDTH, cloudBadge, cloudLabel, cloudState, mergeRemoteSessions, describeShareResult, shareAccess,
} from '../src/session/cloud-sessions.js'
import { formatSessionItems } from '../src/term/app/resume.js'
import type { CloudPushResult, RemoteSession, SessionMeta } from '../src/native/index.js'

function meta(id: string, extra: Partial<SessionMeta> = {}): SessionMeta {
  return { session_id: id, cwd: '/w', model: 'm', turns: 2, title: `t-${id}`, created_at: '2024-01-01T00:00:00Z', updated_at: '2024-01-02T00:00:00Z', ...extra }
}

function remote(id: string, seq: number, extra: Partial<RemoteSession> = {}): RemoteSession {
  return { session_id: id, meta: meta(id, { cwd: '/elsewhere' }), seq, visibility: 'private', origin_host: 'macbook', ...extra }
}

test('cloudState reads the relation from metadata alone', () => {
  const synced = meta('a', { cloud: { visibility: 'private', synced_seq: 5, synced_at: '2024-01-03T00:00:00Z' } })
  expect(cloudState(undefined, undefined)).toBe('local')
  expect(cloudState(undefined, remote('a', 5))).toBe('remote_only')
  expect(cloudState(meta('a'), remote('a', 5))).toBe('local')
  expect(cloudState(synced, remote('a', 5))).toBe('synced')
  expect(cloudState(synced, undefined)).toBe('synced')
  expect(cloudState(synced, remote('a', 7))).toBe('pull_pending')
  const edited = { ...synced, updated_at: '2024-01-04T00:00:00Z' }
  expect(cloudState(edited, remote('a', 5))).toBe('push_pending')
  expect(cloudState(edited, remote('a', 7))).toBe('diverged')
})

test('badges: private ☁, public 🌐, suffix says what is pending', () => {
  expect(cloudBadge('local', 'private')).toBe('')
  expect(cloudBadge('synced', 'private')).toBe('☁')
  expect(cloudBadge('synced', 'public')).toBe('🌐')
  expect(cloudBadge('push_pending', 'private')).toBe('☁↑')
  expect(cloudBadge('pull_pending', 'private')).toBe('☁⇣')
  expect(cloudBadge('remote_only', 'public')).toBe('🌐⇣')
  expect(cloudBadge('diverged', 'private')).toBe('☁!')
  expect(cloudBadge('synced', 'private', true)).toBe('👥')
  expect(cloudBadge('push_pending', 'private', true)).toBe('👥↑')
  // Public wins: a stale team flag never hides that anyone can read it.
  expect(cloudBadge('synced', 'public', true)).toBe('🌐')
})

test('remote-only rows join the list after local ones and read as pull-pending', () => {
  const local = [meta('a'), meta('b')]
  const merged = mergeRemoteSessions(local, [remote('b', 3), remote('z', 4), remote('y', 2, { meta: meta('y', { updated_at: '2024-02-01T00:00:00Z' }) })])
  expect(merged.map(s => s.session_id)).toEqual(['a', 'b', 'y', 'z'])
  expect(cloudState(merged[2], remote('y', 2))).toBe('pull_pending')
  expect(merged[2]!.cloud?.origin_host).toBe('macbook')
  expect(mergeRemoteSessions(local, [])).toBe(local)
})

test('list labels spell out who can read the session', () => {
  expect(cloudLabel('local', 'private')).toBe('')
  expect(cloudLabel('synced', 'private')).toBe('private')
  expect(cloudLabel('synced', 'private', true)).toBe('team')
  expect(cloudLabel('synced', 'public')).toBe('public')
  // Public wins over a stale team flag.
  expect(cloudLabel('synced', 'public', true)).toBe('public')
  expect(cloudLabel('push_pending', 'private', true)).toBe('team ↑')
  expect(cloudLabel('remote_only', 'public')).toBe('public ⇣')
  expect(cloudLabel('diverged', 'private')).toBe('private !')
})

test('the sessions list shows a cloud column only when some row is on the cloud', () => {
  const rows = (items: ReturnType<typeof formatSessionItems>) => items.filter(item => item.id)
  const plain = rows(formatSessionItems([meta('a'), meta('b')], '/w'))
  expect(plain[0]!.detail ?? '').not.toContain('☁')
  const synced = meta('a', { cloud: { visibility: 'private', synced_seq: 5, synced_at: '2024-01-03T00:00:00Z' } })
  const items = rows(formatSessionItems([synced, meta('b')], '/w', () => undefined, null,
    s => s.session_id === 'a' ? 'team' : ''))
  // Titles lead; provenance is compact metadata, not a padded column.
  expect(items[0]!.label).toBe('t-a')
  expect(items[1]!.label).toBe('t-b')
  expect(items[0]!.detail).toContain(' · team · ')
  expect(items[1]!.detail).not.toContain('team')
  expect(items[0]!.cloud).toBe(true)
  expect(items[1]!.cloud).toBeUndefined()
  // Remote rows name their origin so the user knows which machine they came from.
  const remoteRow = mergeRemoteSessions([], [remote('z', 4)])
  const remoteItems = formatSessionItems(remoteRow, '/w', () => undefined, null, () => 'private ⇣')
  expect(remoteItems.find(item => item.id === 'z')?.detail).toContain('(macbook)')
})

test('the shared list shows sessions from every cwd; resume keeps other cwds for search', () => {
  const here = meta('a', { cwd: '/w' })
  const elsewhere = meta('b', { cwd: '/home/ubuntu/other' })
  const hidden = (items: ReturnType<typeof formatSessionItems>) =>
    items.filter(item => item.searchOnly).map(item => item.id ?? item.label)

  // /resume: other projects are reachable by search, not listed up front.
  expect(hidden(formatSessionItems([here, elsewhere], '/w'))).toEqual(['Other cwd', 'b'])
  // /share: everything shared is listed, with its cwd on the row.
  const shared = formatSessionItems([here, elsewhere], '/w', () => undefined, null, () => 'team', true)
  expect(hidden(shared)).toEqual([])
  expect(shared.map(item => item.header ? item.label.split(' · ')[0] : item.id)).toEqual(['Current cwd', 'a', 'Other cwd', 'b'])
  expect(shared.find(item => item.id === 'b')?.detail).toContain('/home/ubuntu/other')
  // Even when nothing shared is from here.
  expect(hidden(formatSessionItems([elsewhere], '/w', () => undefined, null, () => 'team', true))).toEqual([])
})

test('CloudSessionSync pushes once per settle, coalesces, and reports failures softly', async () => {
  const pushes: string[] = []
  const notices: string[] = []
  let fail = false
  const sync = new CloudSessionSync({
    push: async (id, force) => {
      pushes.push(`${id}:${force}`)
      if (fail) throw new Error('offline')
      return { kind: 'synced', pushed: 1, cloud: { visibility: 'private', synced_seq: 9, synced_at: 't' } }
    },
    list: async () => [remote('a', 5)],
    notify: text => notices.push(text),
  }, 1)
  await sync.refreshIndex()
  expect(sync.remoteFor('a')?.seq).toBe(5)

  sync.schedulePush('a')
  sync.schedulePush('a')
  await new Promise(resolve => setTimeout(resolve, 10))
  expect(pushes).toEqual(['a:false'])
  // The acknowledgement moves the cached remote row so the list agrees at once.
  expect(sync.remoteFor('a')?.seq).toBe(9)
  expect(notices).toEqual([])

  fail = true
  const result = await sync.pushNow('a')
  expect(result).toBeNull()
  expect(notices[0]).toContain('sync failed')
  expect(notices[0]).toContain('offline')

  sync.dispose()
  sync.schedulePush('a')
  await new Promise(resolve => setTimeout(resolve, 5))
  expect(pushes).toHaveLength(2)
})

test('CloudSessionSync surfaces divergence from a background push as a hint, not an error', async () => {
  const notices: string[] = []
  const diverged: CloudPushResult = { kind: 'diverged', local_seq: 3, remote_seq: 8 }
  const sync = new CloudSessionSync({ push: async () => diverged, list: async () => [], notify: text => notices.push(text) }, 1)
  await sync.pushNow('a')
  expect(notices[0]).toContain('☁!')
  expect(notices[0]).toContain('/sessions')
})

test('index refresh notifies the open list after replacing rows, without pushing', async () => {
  let rows: RemoteSession[] = [remote('first', 2)]
  const updates: string[][] = []
  const sync = new CloudSessionSync({
    push: async () => { throw new Error('listing must not push') },
    list: async () => rows,
    notify: () => {},
    indexUpdated: () => updates.push(sync.remoteSessions.map(row => row.session_id)),
  })
  await sync.refreshIndex()
  rows = [remote('second', 3)]
  await sync.refreshIndex()
  rows = []
  await sync.refreshIndex()
  expect(updates).toEqual([['first'], ['second'], []])
  sync.dispose()
  await sync.refreshIndex()
  expect(updates).toHaveLength(3)
})

test('describeShareResult words match the visibility', () => {
  const cloud = { visibility: 'public' as const, synced_seq: 4, synced_at: 't', public_url: 'https://evot.ai/share/x' }
  expect(describeShareResult({ kind: 'synced', cloud, pushed: 4 }, 'public')).toContain('https://evot.ai/share/x')
  expect(describeShareResult({ kind: 'synced', cloud: { ...cloud, visibility: 'private', public_url: null }, pushed: 4 }, 'private')).toContain('any machine')
  expect(describeShareResult({ kind: 'not_shared' }, 'private')).toContain('/share')
  const team = { ...cloud, visibility: 'private' as const, public_url: null, team: true,
    team_url: 'https://auto.evot.ai/team/x', team_name: 'Databend' }
  expect(describeShareResult({ kind: 'synced', cloud: team, pushed: 4 }, 'team')).toContain('👥 Team Databend · https://auto.evot.ai/team/x')
  expect(shareAccess(team)).toBe('team')
  expect(shareAccess({ ...team, visibility: 'public' })).toBe('public')
  expect(shareAccess({ ...team, team: false })).toBe('private')
})
