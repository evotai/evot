import { test, expect } from 'bun:test'
import { isShareLink, runShareCommand, type ShareContext } from '../src/commands/share.js'
import type { CloudPushResult, SessionMeta } from '../src/native/index.js'

function synced(visibility: 'private' | 'public', seq = 3): CloudPushResult {
  return {
    kind: 'synced', pushed: seq,
    cloud: { visibility, synced_seq: seq, synced_at: 't', origin_host: 'laptop',
      public_url: visibility === 'public' ? 'https://evot.ai/share/abcdefghijklmnopqrstuv' : null },
  }
}

function setup(result: (visibility: string) => CloudPushResult = v => synced(v === 'public' ? 'public' : 'private')) {
  const output: string[] = []
  const calls: string[] = []
  const ctx: ShareContext = {
    agent: {
      listSessions: async () => [{ session_id: 'abc12345-0000', cwd: '/w', model: 'm', turns: 1, created_at: '', updated_at: '' } as SessionMeta],
      cloudShareSession: async (sid, visibility) => { calls.push(`share:${sid}:${visibility}`); return result(visibility) },
      cloudUnshareSession: async sid => { calls.push(`off:${sid}`) },
      cloudPushSession: async (sid, force) => { calls.push(`push:${sid}:${force}`); return synced('private') },
      cloudForkRemoteSession: async sid => { calls.push(`fork:${sid}`); return { session_id: 'fork0000-1111', cwd: '/w', model: 'm', turns: 1, created_at: '', updated_at: '' } as SessionMeta },
      importSharedSession: async link => { calls.push(`import:${link}`); return { session_id: 'imp00000-2222', cwd: '/w', model: 'm', turns: 1, created_at: '', updated_at: '' } as SessionMeta },
    },
    openShareList: async () => { calls.push('open-list') },
    getSessionId: () => 'session',
    commitSystem: (_, text) => output.push(text),
    flushShareNotices: async () => { calls.push('flush') },
    requestRender() {},
    cloudAcknowledged: sid => { calls.push(`ack:${sid}`) },
    cloudForgotten: sid => { calls.push(`forget:${sid}`) },
    resumeSession: async session => { calls.push(`resume:${session.session_id}`) },
  }
  return { ctx, output, calls }
}

test('bare /share opens the list without mutating or requiring a current session', async () => {
  const { ctx, output, calls } = setup()
  ctx.getSessionId = () => null
  ctx.isBusy = () => true
  await runShareCommand(ctx, '')
  expect(calls).toEqual(['open-list'])
  expect(output).toEqual([])
})

test('/share private explicitly syncs privately', async () => {
  const { ctx, output, calls } = setup()
  await runShareCommand(ctx, 'private')
  expect(calls).toEqual(['flush', 'share:session:private', 'ack:session'])
  // No bar factory here: the notice is one line and the result follows it.
  expect(output[0]).toBe('Syncing to the cloud')
  expect(output[1]).toContain('☁ Shared to cloud')
  expect(output[1]).toContain('any machine')
})

test('with a progress bar the upload is one row that becomes the result', async () => {
  const { ctx, output, calls } = setup()
  const bar: Array<[number, number] | string> = []
  ctx.progressBar = () => ({ set: (done, total) => { bar.push([done, total]) }, finish: text => { bar.push(text) } })
  ctx.agent.cloudShareSession = async (sid, visibility, onProgress) => {
    calls.push(`share:${sid}:${visibility}`)
    onProgress?.({ uploaded_entries: 0, total_entries: 9000, batch: 0, batches: 2 })
    onProgress?.({ uploaded_entries: 5000, total_entries: 9000, batch: 1, batches: 2 })
    onProgress?.({ uploaded_entries: 9000, total_entries: 9000, batch: 2, batches: 2 })
    return synced('public')
  }
  await runShareCommand(ctx, 'public')
  expect(bar.slice(0, 3)).toEqual([[0, 9000], [5000, 9000], [9000, 9000]])
  expect(String(bar.at(-1))).toContain('https://evot.ai/share/')
  // The scope warning is its own line; the result lives in the bar's row.
  expect(output).toHaveLength(1)
  expect(output[0]).toContain('anyone with the link can read it')
})

test('a failed upload closes the progress row before the error line', async () => {
  const { ctx, output } = setup()
  const bar: string[] = []
  ctx.progressBar = () => ({ set: () => {}, finish: text => { bar.push(text) } })
  ctx.agent.cloudShareSession = async () => { throw new Error('invalid session push: too big (HTTP 400)') }
  await runShareCommand(ctx, 'team')
  expect(bar).toEqual(['Sharing with your team — failed'])
  expect(output.at(-1)).toContain('Share failed: invalid session push: too big (HTTP 400)')
})

test('/share public warns before publishing and returns the live page link', async () => {
  const { ctx, output, calls } = setup()
  await runShareCommand(ctx, 'public')
  expect(calls).toEqual(['flush', 'share:session:public', 'ack:session'])
  expect(output[0]).toContain('anyone with the link can read it')
  expect(output.at(-1)).toContain('https://evot.ai/share/')
  expect(output.at(-1)).toContain('🌐')
})

test('/share team warns who can read it and returns the team page link', async () => {
  const team: CloudPushResult = {
    kind: 'synced', pushed: 3,
    cloud: { visibility: 'private', synced_seq: 3, synced_at: 't', origin_host: 'laptop', public_url: null,
      team: true, team_url: 'https://auto.evot.ai/team/abcdefghijklmnopqrstuv', team_name: 'Databend' },
  }
  const { ctx, output, calls } = setup(() => team)
  await runShareCommand(ctx, 'team')
  expect(calls).toEqual(['flush', 'share:session:team', 'ack:session'])
  expect(output[0]).toContain('members of your group who sign in')
  expect(output.at(-1)).toContain('👥 Team Databend')
  expect(output.at(-1)).toContain('https://auto.evot.ai/team/')
})

test('/share off removes the cloud copy and keeps the local one', async () => {
  const { ctx, output, calls } = setup()
  await runShareCommand(ctx, 'off')
  expect(calls).toEqual(['flush', 'off:session', 'forget:session'])
  expect(output.at(-1)).toContain('local copy kept')
})

test('a session id prefix targets another session, with or without a visibility word', async () => {
  const { ctx, calls } = setup()
  await runShareCommand(ctx, 'abc1')
  await runShareCommand(ctx, 'public abc1')
  expect(calls.filter(c => c.startsWith('share:'))).toEqual(['share:abc12345-0000:keep', 'share:abc12345-0000:public'])
})

test('divergence is reported as a choice, and each side has a word', async () => {
  const { ctx, output, calls } = setup(() => ({ kind: 'diverged', local_seq: 4, remote_seq: 6 }))
  await runShareCommand(ctx, 'private')
  expect(output.at(-1)).toContain('/share cloud')
  expect(output.at(-1)).toContain('/share local')
  await runShareCommand(ctx, 'cloud')
  expect(calls).toContain('fork:session')
  expect(calls).toContain('resume:fork0000-1111')
  await runShareCommand(ctx, 'local')
  expect(calls).toContain('push:session:true')
  expect(output.at(-1)).toContain('replaced')
})

test('does not sync partial runs, and rejects anything that is not a word or id', async () => {
  const { ctx, output, calls } = setup()
  ctx.isBusy = () => true
  await runShareCommand(ctx, 'public')
  expect(output.at(-1)).toContain('Wait for')
  ctx.isBusy = () => false
  await runShareCommand(ctx, 'https://tmpfiles.org/old#key')
  expect(output.at(-1)).toContain('Usage:')
  await runShareCommand(ctx, 'rm abcdefghijklmnopqrstuv')
  expect(output.at(-1)).toContain('Usage: /share [public | team | private | off | list] [session-id | url]')
  expect(calls).toEqual([])
})

test('list opens the cloud-filtered sessions list', async () => {
  const { ctx, output, calls } = setup()
  await runShareCommand(ctx, 'list')
  expect(calls).toEqual(['open-list'])
  expect(output).toEqual([])
})

test('failed notice persistence prevents an incomplete push', async () => {
  const { ctx, output, calls } = setup()
  ctx.flushShareNotices = async () => { throw new Error('notices unavailable') }
  await runShareCommand(ctx, 'private')
  expect(calls).toEqual([])
  expect(output.at(-1)).toContain('notices unavailable')
})

test('bare /share on a public session opens the list without changing visibility', async () => {
  const { ctx, output, calls } = setup(() => synced('public'))
  await runShareCommand(ctx, '')
  expect(calls).toEqual(['open-list'])
  expect(output).toEqual([])
})

test('list rejects extra arguments instead of silently ignoring them', async () => {
  const { ctx, output, calls } = setup()
  await runShareCommand(ctx, 'list abc1')
  expect(calls).toEqual([])
  expect(output.at(-1)).toContain('Usage:')
})

test('/share <url> imports the public page as a local session and lands in it', async () => {
  const { ctx, output, calls } = setup()
  ctx.getSessionId = () => null // works without a current session
  const url = 'https://evot.ai/share/abcdefghijklmnopqrstuv'
  await runShareCommand(ctx, `  ${url}  `)
  expect(calls).toEqual([`import:${url}`, 'resume:imp00000-2222'])
  expect(output[0]).toContain('Fetching the shared session')
  expect(output[1]).toContain('saved as imp00000')
  expect(output[1]).toContain('original is untouched')
})

test('/share <team-url> with deep-link parameters imports and resumes', async () => {
  const { ctx, output, calls } = setup()
  const url = 'https://auto.evot.ai/team/hRJJIer7dHx160uXgASZxQ?leafId=e135&targetId=e134'
  await runShareCommand(ctx, url)
  expect(calls).toEqual([`import:${url}`, 'resume:imp00000-2222'])
  expect(output.at(-1)).toContain('original is untouched')
})

test('/share <url> reports an import failure and never changes visibility', async () => {
  const { ctx, output, calls } = setup()
  ctx.agent.importSharedSession = async () => { throw new Error('shared session not found; ask the owner') }
  await runShareCommand(ctx, 'https://evot.ai/share/abcdefghijklmnopqrstuv/session.json')
  expect(calls).toEqual([])
  expect(output.at(-1)).toContain('Import failed: shared session not found')
})

test('task links and local ids are not treated as session imports', async () => {
  expect(isShareLink('https://evot.ai/share/abcdefghijklmnopqrstuv')).toBe(true)
  expect(isShareLink('evot.ai/share/abcdefghijklmnopqrstuv/content')).toBe(true)
  expect(isShareLink('https://auto.evot.ai/team/hRJJIer7dHx160uXgASZxQ?leafId=e135&targetId=e134')).toBe(true)
  expect(isShareLink('https://evot.ai/share/t/abcdefghijklmnopqrstuv')).toBe(false)
  expect(isShareLink('abcdefghijklmnopqrstuv')).toBe(false)
  expect(isShareLink('abc12345')).toBe(false)
  expect(isShareLink('public')).toBe(false)
})
