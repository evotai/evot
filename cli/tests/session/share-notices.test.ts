import { test, expect } from 'bun:test'
import { ShareNotices } from '../../src/session/share-notices.js'
import { Committer } from '../../src/term/screen/committer.js'
import { modelShareEvents } from '../../src/session/share-events.js'
import type { ShareNotice } from '../../src/native/contracts/share.js'

function harness(write: (sid: string, batch: ShareNotice[]) => Promise<void>) {
  const notices = new ShareNotices(write)
  const committer = new Committer({
    compactLines: [], expandedLines: [], isExpanded: () => false, columns: () => 80,
    logLines() {}, requestRender() {}, invalidateHistory() {},
    notices: lines => notices.record('session-a', lines),
  })
  return { notices, committer }
}

test('captures client notices once; restore and revealed secrets never persist', async () => {
  const saved: ShareNotice[] = []
  const { notices, committer } = harness(async (_, batch) => { saved.push(...batch) })
  committer.system('error', '\x1b[31mCannot reach server\x1b[0m', 'error')
  committer.restore([{ id: 'old', kind: 'error', text: 'old' }])
  committer.revealTemporarily('secret', 'TOKEN', '***', 1)
  committer.system('sys-share', 'private share URL')
  await notices.flush()
  expect(saved.map(n => n.text)).toEqual(['Cannot reach server', '***'])
  committer.flushReveals()
})

test('captures session ownership at enqueue, not completion', async () => {
  const saved: string[] = []
  const notices = new ShareNotices(async (sid, batch) => { saved.push(`${sid}:${batch[0]?.text}`) })
  notices.record('a', [{ id: '1', kind: 'system', text: 'one' }])
  notices.record('b', [{ id: '2', kind: 'system', text: 'two' }])
  await notices.flush()
  expect(saved).toEqual(['a:one', 'b:two'])
})

test('agent output is not re-persisted as a notice; client-only lines are', async () => {
  const saved: ShareNotice[] = []
  const { notices, committer } = harness(async (_, batch) => { saved.push(...batch) })
  // A failing tool already lives in the transcript as a tool_result; its rendered
  // error rows must not be stored a second time.
  committer.commitDual(
    [{ id: 'tool-res-1', kind: 'error', text: '  bash: no such file' }],
    [{ id: 'tool-res-1', kind: 'error', text: '  bash: no such file' }],
  )
  committer.commitNotice([{ id: 'cancel', kind: 'cancelled', text: 'Interrupted by user' }])
  // `sys-model` is already a model_change transcript entry; `sys-think` is not.
  committer.commitStatus({ id: 'sys-model', kind: 'system', text: '  Model → test' })
  committer.commitStatus({ id: 'sys-think', kind: 'system', text: '  Thinking level → high' })
  await notices.flush()
  expect(saved.map(n => `${n.level}:${n.text}`))
    .toEqual(['cancelled:Interrupted by user', 'system:  Thinking level → high'])
})

test('structured settings preserve values independently of display copy', async () => {
  const saved: ShareNotice[] = []
  const { notices, committer } = harness(async (_, batch) => { saved.push(...batch) })
  committer.commitStatus({ id: 'sys-model', kind: 'system', text: '任意文案',
    shareEvents: modelShareEvents('provider', 'model', 'high') })
  committer.commitStatus({ id: 'sys-think', kind: 'system', text: 'arbitrary copy',
    shareEvents: [{ kind: 'thinking_level_change', data: { thinking_level: 'off' } }] })
  await notices.flush()
  expect(saved.map(n => [n.kind, n.data])).toEqual([
    ['model_change', { provider: 'provider', model: 'model' }],
    ['thinking_level_change', { thinking_level: 'high' }],
    ['thinking_level_change', { thinking_level: 'off' }],
  ])
})

test('a failed batch blocks that share and names the cause, then allows a retry', async () => {
  let attempt = 0
  const { notices, committer } = harness(async () => {
    attempt += 1
    if (attempt === 1) throw new Error('storage is read-only')
  })
  committer.system('sys-warn', 'first')
  await expect(notices.flush()).rejects.toThrow('storage is read-only')
  committer.system('sys-warn', 'second')
  await notices.flush()
  expect(attempt).toBe(2)
})
