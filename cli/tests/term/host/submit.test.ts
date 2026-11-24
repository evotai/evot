import { expect, test } from 'bun:test'
import { createSubmitController, type SubmitDeps } from '../../../src/term/host/submit.js'
import type { ContentBlock } from '../../../src/native/index.js'
import type { ReplState } from '../../../src/term/host/state.js'
import { createEditorState, getEditorText, insertText } from '../../../src/term/input/editor.js'
import { PendingQueue, createPendingQueueState } from '../../../src/term/app/queue/pending-queue.js'
import { PendingImages } from '../../../src/term/app/composer/pending-images.js'
import { draft, queueFixture } from '../../helpers/prompt-queue.js'

function harness(text = 'B') {
  const native = queueFixture(), pending = new PendingQueue(createPendingQueueState()), images = new PendingImages()
  pending.begin('session-a')
  const st = {
    editor: insertText(createEditorState(), text), sessionId: 'session-a', logMode: null,
    pendingQueue: pending.state, streamRef: native.stream, pendingEnqueue: null,
    draftEpoch: 0, destroyed: false, isLoading: true,
  } as ReplState
  const history: string[] = [], notices: string[] = [], calls: string[] = []
  const logQueries: { text: string; contentJson?: string }[] = [], queries: { text: string; contentJson?: string }[] = []
  let imageReady = false
  const blocks: ContentBlock[] = [{ type: 'image' as const, mimeType: 'image/png', source: { type: 'base64' as const, data: 'fixture' } }]
  const deps = {
    pendingQueue: pending, pendingImages: images,
    composer: { snapshot: () => draft(getEditorText(st.editor)) },
    buildImageContentBlocks: () => imageReady && getEditorText(st.editor).includes('[Image #1]') ? { blocks, resolvedIds: new Set([1]) } : null,
    getDisplayText: () => getEditorText(st.editor).trim(),
    getExpandedText: () => getEditorText(st.editor).trim(),
    getHistoryText: () => getEditorText(st.editor),
    saveInputHistory: (value: string) => { history.push(value) },
    clearAll: () => { st.editor = createEditorState(); st.draftEpoch++; st.pendingEnqueue = null },
    manualCompaction: { active: false },
    queueEdit: { editingEntry: () => null },
    queueLifecycle: { reconcile: () => {}, dispatchNext: () => { calls.push('dispatch') } },
    renderer: { requestRender: () => {} }, suggestions: { cancel: () => { calls.push('cancel suggestion') } },
    screenLog: { filePath: null },
    scrollback: { commitSystem: (_id: string, message: string) => { notices.push(message) }, commitUserMessage: () => {} },
    runCtl: { runQuery: (text: string, contentJson?: string) => { queries.push({ text, contentJson }) } },
    taskSession: { followUpExtension: () => undefined }, computeSession: { followUpExtension: () => undefined },
    backgroundTerminals: { reclaimTurnForMessage: () => { calls.push('reclaim') } },
    slashCtl: { handleSlashInput: (text: string) => { calls.push(text) }, runLogQuery: (_fork: ReplState['logMode'], text: string, contentJson?: string) => { logQueries.push({ text, contentJson }) } },
  } as unknown as SubmitDeps
  return { st, native, pending, images, history, notices, calls, blocks, logQueries, queries, ctl: createSubmitController(st, deps), ready: () => { imageReady = true } }
}

test('a phone steer joins the original native queue without consuming the terminal draft', () => {
  const h = harness('partially typed local message')
  h.ctl.submitConversationText('phone follow-up', true)
  expect(h.native.calls).toEqual(['steering'])
  expect(h.pending.state.entries[0]?.snapshot.text).toBe('phone follow-up')
  expect(getEditorText(h.st.editor)).toBe('partially typed local message')
  expect(h.history).toEqual([])
  expect(h.calls).toContain('reclaim')
})

test('phone photos become the same image content blocks as a TUI paste, for a new turn and a steer', () => {
  const h = harness('local draft')
  const photo = { mimeType: 'image/jpeg', data: 'AAAA' }
  h.ctl.submitConversationText('what is this?', false, [photo])
  expect(h.queries).toHaveLength(1)
  expect(JSON.parse(h.queries[0]!.contentJson!)).toEqual([
    { type: 'text', text: 'what is this?' },
    { type: 'image', mimeType: 'image/jpeg', source: { type: 'base64', data: 'AAAA' } },
  ])
  h.ctl.submitConversationText('', false, [photo, photo])
  expect(h.queries[1]!.text).toBe('[2 images from phone]')
  expect(JSON.parse(h.queries[1]!.contentJson!).map((b: { type: string }) => b.type)).toEqual(['image', 'image'])
  h.ctl.submitConversationText('look', true, [photo])
  expect(h.pending.state.entries.at(-1)?.snapshot.text).toBe('look\n[Image from phone]')
  expect(JSON.parse(h.pending.state.entries.at(-1)!.contentJson!).at(-1).type).toBe('image')
  expect(getEditorText(h.st.editor)).toBe('local draft')
})

test.each(['immediate', 'steering', 'follow_up'])('skill invocation is model input for %s submission', kind => {
  const h = harness('/x-review inspect changes')
  h.st.skillEntries = [{ name: 'x-review', dir: '/fixture/x-review', command: {} }]
  if (kind === 'immediate') {
    h.st.isLoading = false
    h.ctl.submitDraft()
    expect(h.queries[0]?.text).toContain('/fixture/x-review/SKILL.md')
  } else {
    if (kind === 'steering') h.ctl.handleLoadingEnter()
    else h.ctl.enqueueDraft()
    expect(h.pending.state.entries[0]?.expandedText).toContain('/fixture/x-review/SKILL.md')
    expect(h.pending.state.entries[0]?.text).toBe('/x-review inspect changes')
    expect(h.native.calls).toEqual([kind])
  }
})

test.each(['immediate', 'steering', 'follow_up'])('migrated harden follows the %s skill submission path', kind => {
  const h = harness('/harden changes')
  h.st.skillEntries = [{ name: 'harden', dir: '/fixture/skills/harden', command: {} }]
  if (kind === 'immediate') {
    h.st.isLoading = false
    h.ctl.submitDraft()
    expect(h.queries[0]?.text).toContain('/fixture/skills/harden/SKILL.md')
  } else {
    if (kind === 'steering') h.ctl.handleLoadingEnter()
    else h.ctl.enqueueDraft()
    expect(h.pending.state.entries[0]?.expandedText).toContain('/fixture/skills/harden/SKILL.md')
    expect(h.pending.state.entries[0]?.text).toBe('/harden changes')
    expect(h.native.calls).toEqual([kind])
  }
  expect(h.history).toEqual(['/harden changes'])
})

test.each(['immediate', 'steering', 'follow_up'])('skill %s image submission preserves source annotations and image payload', kind => {
  const h = harness('/x-review inspect [Image #1]')
  h.st.skillEntries = [{ name: 'x-review', dir: '/fixture/x-review', command: {} }]
  h.blocks.unshift({ type: 'text', text: '/x-review inspect\nImage source: /fixture/source.png' })
  h.ready()
  let content: string | undefined
  if (kind === 'immediate') {
    h.st.isLoading = false
    h.ctl.submitDraft()
    content = h.queries[0]?.contentJson
  } else {
    if (kind === 'steering') h.ctl.handleLoadingEnter()
    else h.ctl.enqueueDraft()
    content = h.pending.state.entries[0]?.contentJson
  }
  const blocks = JSON.parse(content ?? '[]') as ContentBlock[]
  expect(blocks[0]).toMatchObject({ type: 'text' })
  expect(JSON.stringify(blocks[0])).toContain('/fixture/x-review/SKILL.md')
  expect(JSON.stringify(blocks[0])).toContain('/fixture/source.png')
  expect(blocks[1]).toEqual({ type: 'image', mimeType: 'image/png', source: { type: 'base64', data: 'fixture' } })
})

for (const kind of ['text', 'mixed-image', 'image-only']) {
  test(`Tab accepts ${kind} without steering, foreground reclaim, abort, or duplicate history`, () => {
    const h = harness(kind === 'image-only' ? '[Image #1]' : kind === 'mixed-image' ? 'B [Image #1]' : 'B')
    if (kind !== 'text') h.ready()
    h.ctl.enqueueDraft(); h.ctl.enqueueDraft()
    expect(h.native.calls).toEqual(['follow_up'])
    expect(h.history).toHaveLength(1)
    expect(h.calls).not.toContain('reclaim')
    expect(getEditorText(h.st.editor)).toBe('')
    expect(h.pending.state.entries).toHaveLength(1)
  })
}

for (const busy of [false, true]) {
  test.each(['/log', '/version', '/_mem', '/help'])('inspection command %s preserves suggestions (busy=' + busy + ')', text => {
    const h = harness(text)
    h.st.isLoading = busy
    if (busy) h.ctl.handleLoadingEnter()
    else h.ctl.submitDraft()
    expect(getEditorText(h.st.editor)).toBe('')
    expect(h.calls).not.toContain('cancel suggestion')
  })
}

test.each(['/model', '/resume', '/skill list', '/typo', '/new', '/log analyze this'])('local command %s owns its own suggestion lifecycle', text => {
  const h = harness(text)
  h.st.isLoading = false
  h.ctl.submitDraft()
  expect(h.calls).toEqual([text])
  expect(h.queries).toEqual([])
})

test('a blocked command does not cancel the running turn’s suggestions', () => {
  const h = harness('/clear')
  h.ctl.handleLoadingEnter()
  expect(h.notices[0]).toContain("Commands don't queue")
  expect(getEditorText(h.st.editor)).toBe('/clear')
  expect(h.calls).not.toContain('cancel suggestion')
})

test('suggestions are invalidated after steering is accepted, not just attempted', () => {
  const h = harness('next question')
  h.ctl.handleLoadingEnter()
  expect(h.native.calls).toEqual(['steering'])
  expect(h.calls).toContain('cancel suggestion')
})

test('idle Enter in log mode preserves structured attachments like queued follow-ups', () => {
  const h = harness('inspect [Image #1]')
  h.st.isLoading = false; h.st.streamRef = null
  h.st.logMode = {} as NonNullable<ReplState['logMode']>
  h.ready()
  h.ctl.submitDraft()
  expect(h.logQueries).toEqual([{ text: '', contentJson: JSON.stringify(h.blocks) }])
  expect(h.history).toEqual(['inspect [Image #1]'])
  expect(getEditorText(h.st.editor)).toBe('')
})

test('busy Enter remains steering and foreground reclaim, never a follow-up', () => {
  const h = harness()
  h.ctl.handleLoadingEnter()
  expect(h.native.calls).toEqual(['steering'])
  expect(h.calls).toContain('reclaim')
})

test.each(['', '  ', '/compact'])('non-prompt enqueue attempt preserves draft and never calls native: %j', text => {
  const h = harness(text)
  h.ctl.enqueueDraft()
  expect(getEditorText(h.st.editor)).toBe(text)
  expect(h.pending.state.entries).toEqual([])
  expect(h.native.calls).toEqual([])
})

test.each(['[Image #1]', '[Image #1] [Image #2]'])('missing or partial image content preserves the entire draft: %s', text => {
  const h = harness(text)
  if (text.includes('#2')) h.ready()
  h.ctl.enqueueDraft()
  expect(h.pending.state.entries).toEqual([])
  expect(h.native.calls).toEqual([])
  expect(h.history).toEqual([])
  expect(getEditorText(h.st.editor)).toBe(text)
})

test('Enter during async startup is retained as steering until the stream arrives', () => {
  const h = harness()
  h.st.streamRef = null
  h.ctl.handleLoadingEnter()
  expect(h.pending.state.entries[0]?.queue).toBe('steering')
  expect(h.native.calls).toEqual([])
  expect(h.history).toEqual(['B'])
  h.pending.attach(h.native.stream)
  expect(h.native.calls).toEqual(['steering'])
})

test('registration failure and unresolved ownership preserve draft and history without reclaim', () => {
  const rejected = harness()
  rejected.native.failEnqueue()
  rejected.ctl.handleLoadingEnter()
  expect(rejected.history).toEqual([])
  expect(rejected.pending.state.entries).toEqual([])
  expect(getEditorText(rejected.st.editor)).toBe('B')
  expect(rejected.calls).not.toContain('reclaim')
  const blocked = harness()
  blocked.pending.state.blocked = true
  blocked.ctl.enqueueDraft()
  expect(getEditorText(blocked.st.editor)).toBe('B')
  expect(blocked.history).toEqual([])
  expect(blocked.native.calls).toEqual([])
})

test('idle Tab does not create a staging queue', () => {
  const h = harness()
  h.st.isLoading = false; h.st.streamRef = null
  h.ctl.enqueueDraft()
  expect(h.pending.state.entries).toEqual([])
  expect(getEditorText(h.st.editor)).toBe('B')
})

test('image preparation preserves enqueue intent across normal completion', async () => {
  const h = harness('[Image #1]')
  let resolve = () => {}
  const load = new Promise<void>(done => { resolve = done })
  h.images.track(1, load)
  h.ctl.enqueueDraft(); h.ctl.enqueueDraft()
  expect(h.pending.state.entries).toEqual([])
  h.pending.settle(h.pending.state.chain, true)
  h.st.isLoading = false; h.st.streamRef = null
  h.ready(); resolve()
  await load; await Promise.resolve(); await Promise.resolve()
  expect(h.pending.state.entries).toHaveLength(1)
  expect(h.pending.state.entries[0]?.paused).toBe(false)
  expect(h.history).toHaveLength(1)
  expect(h.native.calls).toEqual([])
})

test('image preparation finishing after terminal failure leaves a paused entry', async () => {
  const h = harness('[Image #1]')
  let resolve = () => {}
  const load = new Promise<void>(done => { resolve = done })
  h.images.track(1, load); h.ctl.enqueueDraft()
  h.pending.settle(h.pending.state.chain, false)
  h.st.isLoading = false; h.st.streamRef = null
  h.ready(); resolve()
  await load; await Promise.resolve(); await Promise.resolve()
  expect(h.pending.state.entries[0]?.paused).toBe(true)
})

for (const invalidation of ['clear', 'edit', 'session', 'destroy', 'chain']) {
  test(`stale image callback cannot submit a replacement after ${invalidation}`, async () => {
    const h = harness('[Image #1]')
    let resolve = () => {}
    const load = new Promise<void>(done => { resolve = done })
    h.images.track(1, load); h.ctl.enqueueDraft()
    h.st.editor = insertText(createEditorState(), 'replacement')
    if (invalidation === 'clear' || invalidation === 'edit') h.st.draftEpoch++
    if (invalidation === 'session') h.st.sessionId = 'other'
    if (invalidation === 'destroy') h.st.destroyed = true
    if (invalidation === 'chain') h.pending.begin('session-a')
    h.ready(); resolve()
    await load; await Promise.resolve(); await Promise.resolve()
    expect(h.pending.state.entries).toEqual([])
    expect(h.native.calls).toEqual([])
    expect(getEditorText(h.st.editor)).toBe('replacement')
  })
}
