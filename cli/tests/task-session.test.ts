import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { AuthIdentityTracker } from '../src/term/app/auth-identity.js'
import { TaskSession, type TaskSessionHost, type TaskSessionApi } from '../src/task/session.js'
import type { SelectorState } from '../src/term/selector.js'
import type { ScheduledTask, TaskListResponse, TaskRunSummary } from '../src/task/types.js'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

const task = (id: string): ScheduledTask => ({
  id, revision: 1, name: id, cron: '* * * * *', timezone: 'UTC', instruction: 'hi', executor_id: 'exec',
  model_policy: 'default', model_spec: '', thinking_level: '', workspace_ref: '',
  delivery_channel: 'feishu', delivery_target: 'oc_me', timeout_seconds: 60,
  max_lateness_seconds: 60, enabled: true, next_run_at: 0,
})
const list = (stale = false): TaskListResponse => ({ tasks: [task('a'), task('b')], cache: { ready: true, synced_at: 1, stale } })
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve() }
const d = { type: 'char', char: 'd' } as const

function harness(api: Partial<TaskSessionApi>, hostOverrides: Partial<TaskSessionHost> = {}) {
  let overlay: SelectorState | null = null
  const errors: string[] = []
  const host: TaskSessionHost = {
    configInfo: () => undefined, activeModel: () => '', activeModelSpec: () => '',
    modelOptionLabel: model => model.model, ensureDelivery: async () => false,
    isTaskOverlay: () => overlay !== null, taskOverlayState: () => overlay,
    currentSessionId: () => 'current-session',
    showSelector: state => { overlay = state }, loadRunTranscript: async () => null, closeOverlay: () => { overlay = null },
    requestRender: () => {}, notifyError: error => { errors.push(error) }, notify: () => {},
    collectAnswers: async () => null, presentModelPicker: async () => null,
    runTaskTurn: () => {}, primeInput: () => {}, destroyed: () => false,
    ...hostOverrides,
  }
  const session = new TaskSession(host, {
    list: async () => list(), get: async id => ({ ...task(id), runs: [] }),
    delete: async () => {}, update: async id => ({ task: task(id), next_runs: [] }),
    run: async () => {}, share: async () => ({ id: '', url: '' }),
    fetchShare: async () => { throw new Error('no share') },
    create: async () => { throw new Error('no create') },
    deliveryDefaults: async () => ({ feishu_ready: false, feishu_target: '' }),
    ...api,
  })
  return { session, errors, view: () => overlay, hideOverlay: () => { overlay = null } }
}

test('cold open is immediate, shares one request, and Esc does not wait for I/O', async () => {
  const pending = deferred<TaskListResponse>()
  let requests = 0
  const h = harness({ list: () => { requests++; return pending.promise } })
  expect(h.session.open()).toBeUndefined()
  expect(h.view()?.emptyMessage).toBe('Loading tasks…')
  h.session.open()
  await flush()
  expect(requests).toBe(1)
  await h.session.handleKey({ type: 'escape' })
  pending.resolve(list())
  await flush()
  expect(h.view()).toBeNull()
  h.session.open()
  expect(h.view()?.items.map(row => row.id)).toEqual(['a', 'b'])
  await flush()
  expect(requests).toBe(1)
  h.session.dispose()
})

test('delete gives immediate feedback, deduplicates presses, and removes without a second list call', async () => {
  const deletion = deferred<void>()
  let deletes = 0
  let lists = 0
  const h = harness({ list: async () => { lists++; return list() }, delete: () => { deletes++; return deletion.promise } })
  h.session.open()
  await flush()
  await h.session.handleKey(d)
  const action = h.session.handleKey(d)
  expect(h.view()?.subtitle).toContain('Deleting')
  expect(h.view()?.items[0]?.detail).toBe('Deleting…')
  await h.session.handleKey(d)
  await h.session.handleKey(d)
  expect(deletes).toBe(1)
  deletion.resolve()
  await action
  expect(h.view()?.items.map(row => row.id)).toEqual(['b'])
  expect(h.view()?.focusIndex).toBe(0)
  expect(lists).toBe(1)
  h.session.dispose()
})

test('failed delete preserves the row and releases busy state', async () => {
  const deletion = deferred<void>()
  const h = harness({ delete: () => deletion.promise })
  h.session.open()
  await flush()
  await h.session.handleKey(d)
  const action = h.session.handleKey(d)
  deletion.reject(new Error('timeout'))
  await action
  expect(h.view()?.items.map(row => row.id)).toEqual(['a', 'b'])
  expect(h.view()?.items[0]?.detail).not.toBe('Deleting…')
  expect(h.errors[0]).toContain('timeout')
  h.session.dispose()
})

test('a refresh started before deletion cannot resurrect the deleted row', async () => {
  const refresh = deferred<TaskListResponse>()
  let lists = 0
  const h = harness({ list: () => ++lists === 1 ? Promise.resolve(list(true)) : refresh.promise })
  h.session.open()
  await flush()
  h.session.open()
  await flush()
  await h.session.handleKey(d)
  await h.session.handleKey(d)
  refresh.resolve(list())
  await flush()
  expect(h.view()?.items.map(row => row.id)).toEqual(['b'])
  h.session.dispose()
})

test('deleting while navigating does not steal focus, and completion cannot reopen a closed list', async () => {
  const deletion = deferred<void>()
  const h = harness({ delete: () => deletion.promise })
  h.session.open()
  await flush()
  await h.session.handleKey(d)
  const action = h.session.handleKey(d)
  await h.session.handleKey({ type: 'down' })
  expect(h.view()?.items[h.view()!.focusIndex]?.id).toBe('b')
  await h.session.handleKey({ type: 'escape' })
  deletion.resolve()
  await action
  expect(h.view()).toBeNull()
  h.session.open()
  expect(h.view()?.items.map(row => row.id)).toEqual(['b'])
  h.session.dispose()
})

test('run now while a run is in flight reports queued, not a failure', async () => {
  const h = harness(
    { run: async () => { throw new Error('/v1/tasks/x/run: task already has an active run') } },
    { collectAnswers: async questions => questions.map(q => ({ header: q.header, question: q.question, answer: 'Run now' })) },
  )
  h.session.open()
  await flush()
  await h.session.handleKey({ type: 'char', char: 'r' })
  await flush()
  expect(h.errors.some(e => e.includes('already has a run in flight'))).toBe(true)
  expect(h.errors.some(e => e.includes('Task operation failed'))).toBe(false)
  h.session.dispose()
})

test('run now restores focus on the acted-on row after the confirm overlay', async () => {
  const h = harness({}, {
    collectAnswers: async questions => {
      h.hideOverlay() // the ask-user overlay replaces the task window
      return questions.map(q => ({ header: q.header, question: q.question, answer: 'Run now' }))
    },
  })
  h.session.open()
  await flush()
  await h.session.handleKey({ type: 'down' })
  expect(h.view()?.items[h.view()!.focusIndex]?.id).toBe('b')
  await h.session.handleKey({ type: 'char', char: 'r' })
  await flush()
  expect(h.view()?.items[h.view()!.focusIndex]?.id).toBe('b')
  h.session.dispose()
})

test('background refresh preserves navigation and armed deletion', async () => {
  const refresh = deferred<TaskListResponse>()
  let calls = 0
  const h = harness({ list: () => ++calls === 1 ? Promise.resolve(list(true)) : refresh.promise })
  h.session.open()
  await flush()
  h.session.open()
  expect(h.view()?.items.map(row => row.id)).toEqual(['a', 'b'])
  expect(h.view()?.subtitle).toBe('Refreshing…')
  await h.session.handleKey({ type: 'down' })
  await h.session.handleKey(d)
  refresh.resolve(list(true))
  await flush()
  expect(h.view()?.items[h.view()!.focusIndex]?.id).toBe('b')
  expect(h.view()?.pendingDeleteId).toBe('b')
  h.session.dispose()
})

test('repeated cold list failures stay in the task window without transcript errors', async () => {
  let calls = 0
  const h = harness({ list: async () => { calls++; throw new Error('offline') } })
  try {
    h.session.open()
    await flush()
    expect(h.view()?.emptyMessage).toBe('Could not load tasks · reopen /task to retry')
    // Empty keeps the Task header, with no subtitle echoing the body.
    expect(h.view()?.subtitle).toBe('')
    for (let i = 0; i < 3; i++) await h.session.refreshIfVisible()
    expect(calls).toBe(4)
    expect(h.view()?.emptyMessage).toBe('Could not load tasks · reopen /task to retry')
    expect(h.errors).toEqual([])

    await h.session.handleKey({ type: 'escape' })
    await h.session.refreshIfVisible()
    expect(calls).toBe(4)
    expect(h.view()).toBeNull()

    h.session.open()
    await flush()
    expect(calls).toBe(5)
    expect(h.errors).toEqual([])
  } finally {
    h.session.dispose()
  }
})

test('failed background refresh keeps cached rows and focus, then recovers silently', async () => {
  let offline = false
  const h = harness({ list: async () => {
    if (offline) throw new Error('offline')
    return list()
  } })
  try {
    h.session.open()
    await flush()
    await h.session.handleKey({ type: 'down' })
    offline = true
    for (let i = 0; i < 3; i++) await h.session.refreshIfVisible()
    expect(h.view()?.items.map(row => row.id)).toEqual(['a', 'b'])
    expect(h.view()?.items[h.view()!.focusIndex]?.id).toBe('b')
    expect(h.view()?.subtitle).toBe('Could not refresh · reopen /task to retry')
    expect(h.errors).toEqual([])

    offline = false
    await h.session.refreshIfVisible()
    expect(h.view()?.subtitle).not.toContain('Could not refresh')
    expect(h.view()?.subtitle).not.toBe('Refreshing…')
    expect(h.view()?.items[h.view()!.focusIndex]?.id).toBe('b')
    expect(h.errors).toEqual([])
  } finally {
    h.session.dispose()
  }
})

test('task refresh preserves the active search, focus and input ownership', async () => {
  const h = harness()
  try {
    h.session.open()
    await flush()
    await h.session.handleKey({ type: 'char', char: '/' })
    await h.session.handleKey({ type: 'char', char: 'b' })
    const before = h.view()
    expect(before?.query).toBe('b')
    expect(before?.listFocused).toBe(false)
    const ids = before?.items.map(row => row.id)
    const focused = before?.items[before.focusIndex]?.id
    await h.session.refreshIfVisible()
    expect(h.view()?.query).toBe('b')
    expect(h.view()?.listFocused).toBe(false)
    expect(h.view()?.items.map(row => row.id)).toEqual(ids)
    expect(h.view()?.items[h.view()!.focusIndex]?.id).toBe(focused)
    expect(h.view()?.pendingDeleteId).toBeUndefined()
  } finally {
    h.session.dispose()
  }
})

test('failed composer preview loads stay inline without opening an overlay', async () => {
  const h = harness({ list: async () => { throw new Error('offline') } })
  let repaints = 0
  const mounted = h.session.preview(() => { repaints++ })
  try {
    await flush()
    expect(repaints).toBeGreaterThan(0)
    expect(h.session.previewState().emptyMessage).toBe('Could not load tasks · reopen /task to retry')
    expect(h.view()).toBeNull()
    expect(h.errors).toEqual([])
  } finally {
    mounted.unmount()
    h.session.dispose()
  }
})

test('task list stays open during same-account auth/catalog refresh and closes on real account switch', async () => {
  const root = mkdtempSync(join(tmpdir(), 'evot-task-auth-'))
  const h = harness({})
  try {
    const path = join(root, 'auth.json')
    const auth = { user: { id: 'a' }, server_base_url: 'https://cloud.example', cli_token: 'test-token' }
    writeFileSync(path, JSON.stringify(auth))
    const identity = new AuthIdentityTracker(() => h.session.resetIdentity(), root)
    h.session.open()
    await flush()
    await h.session.handleKey({ type: 'down' })
    await h.session.handleKey(d)
    const before = h.view()
    writeFileSync(path, JSON.stringify({ ...auth, cli_token: 'rotated-token', models_synced_at: 123 }))
    writeFileSync(join(root, 'models.cache.json'), '{"revision":2}')
    identity.refresh()
    expect(h.view()).toBe(before)
    expect(h.view()?.pendingDeleteId).toBe('b')
    writeFileSync(path, JSON.stringify({ ...auth, user: { id: 'b' } }))
    identity.refresh()
    expect(h.view()).toBeNull()
  } finally {
    h.session.dispose()
    rmSync(root, { recursive: true, force: true })
  }
})

test('identity change discards cached rows and in-flight responses', async () => {
  const old = deferred<TaskListResponse>()
  let calls = 0
  const h = harness({ list: () => ++calls === 1 ? old.promise : Promise.resolve({ ...list(), tasks: [task('new-account')] }) })
  h.session.open()
  await flush()
  h.session.resetIdentity()
  h.session.open()
  await flush()
  old.resolve(list())
  await flush()
  expect(h.view()?.items.map(row => row.id)).toEqual(['new-account'])
  h.session.dispose()
})

test('list refresh invalidates detail data even when task revision is unchanged', async () => {
  let calls = 0
  const h = harness({
    list: async () => { calls++; return { ...list(true), tasks: [{ ...task('a'), name: calls > 1 ? 'Fresh' : 'Old' }] } },
    get: async () => ({ ...task('a'), name: 'Old detail', runs: [] }),
  })
  h.session.open()
  await flush()
  await h.session.handleKey({ type: 'enter' })
  h.session.open()
  await flush()
  expect(h.view()?.items[0]?.label).toContain('Fresh')
  expect(h.view()?.items[0]?.label).not.toContain('Old')
  h.session.dispose()
})

test('late task details cannot replace another overlay', async () => {
  const detail = deferred<ScheduledTask & { runs: [] }>()
  const h = harness({ get: () => detail.promise })
  h.session.open()
  await flush()
  const action = h.session.handleKey({ type: 'enter' })
  await h.session.handleKey({ type: 'escape' })
  detail.resolve({ ...task('a'), runs: [] })
  await action
  expect(h.view()).toBeNull()
  h.session.dispose()
})

test('composer preview: snapshot now, repaint on load, silent after unmount, promoted by open', async () => {
  const pending = deferred<TaskListResponse>()
  let requests = 0
  const h = harness({ list: () => { requests++; return pending.promise } })
  let repaints = 0

  // Cold cache: the first frame is a loading placeholder and the list request
  // starts, but no overlay is shown — the composer still owns the screen.
  const mounted = h.session.preview(() => { repaints++ })
  expect(mounted.state.listFocused).toBe(false)
  expect(mounted.state.emptyMessage).toBe('Loading tasks…')
  expect(mounted.state.subtitle).toBe('')
  expect(h.view()).toBeNull()
  await flush()
  expect(requests).toBe(1)

  pending.resolve(list())
  await flush()
  expect(repaints).toBeGreaterThan(0)
  const loaded = h.session.previewState()
  expect(loaded.items.map(row => row.id)).toEqual(['a', 'b'])
  expect(loaded.listFocused).toBe(false)
  expect(h.view()).toBeNull()

  // Unmounted previews hear nothing more.
  mounted.unmount()
  const before = repaints
  h.session.open()
  await flush()
  expect(repaints).toBe(before)

  // Promotion reuses the cache: one request served both the preview and the list.
  expect(h.view()?.items.map(row => row.id)).toEqual(['a', 'b'])
  expect(h.view()?.listFocused).toBe(true)
  expect(requests).toBe(1)
  h.session.dispose()
})

test('composer preview from a warm cache neither requests nor repaints', async () => {
  let requests = 0
  const h = harness({ list: async () => { requests++; return list() } })
  h.session.open()
  await flush()
  await h.session.handleKey({ type: 'escape' })
  expect(requests).toBe(1)

  let repaints = 0
  const mounted = h.session.preview(() => { repaints++ })
  expect(mounted.state.items.map(row => row.id)).toEqual(['a', 'b'])
  await flush()
  expect(requests).toBe(1)
  expect(repaints).toBe(0)
  h.session.dispose()
})

const finishedRun: TaskRunSummary = {
  id: 'r1', status: 'succeeded', source: 'manual', delivery_status: 'sent',
  scheduled_for: 1000, session_id: 'session-r1',
}
const preAgentFailure: TaskRunSummary = {
  id: 'r2', status: 'failed', source: 'scheduled', delivery_status: 'not_requested',
  scheduled_for: 2000, error: 'model unavailable',
}

test('task -> runs -> read-only transcript -> runs -> tasks, including failed pre-agent run', async () => {
  let reads = 0
  const h = harness({ get: async id => ({ ...task(id), runs: [finishedRun, preAgentFailure] }) }, {
    loadRunTranscript: async id => {
      reads++
      expect(id).toBe('session-r1')
      return [{ type: 'user', text: 'Review the report' },
        { type: 'assistant', content: [{ type: 'text', text: 'Report ready' }] }]
    },
  })
  h.session.open()
  await flush()
  await h.session.handleKey({ type: 'enter' })
  expect(h.view()?.title).toBe('a · Runs')
  expect(h.view()?.items.map(row => row.id)).toEqual(['r2', 'r1'])
  await h.session.handleKey({ type: 'enter' })
  expect(h.view()?.items[h.view()!.focusIndex]?.preview?.join(' ')).toContain('model unavailable')
  expect(reads).toBe(0)
  await h.session.handleKey({ type: 'down' })
  await h.session.handleKey({ type: 'enter' })
  expect(reads).toBe(1)
  expect(h.view()?.title).toBe('a · Transcript')
  expect(h.view()?.items.map(row => row.label)).toEqual(['User', 'Assistant'])
  await h.session.handleKey({ type: 'escape' })
  expect(h.view()?.title).toBe('a · Runs')
  expect(h.view()?.items[h.view()!.focusIndex]?.id).toBe('r1')
  await h.session.handleKey({ type: 'escape' })
  expect(h.view()?.title).toBe('Tasks')
  expect(h.view()?.items[h.view()!.focusIndex]?.id).toBe('a')
  h.session.dispose()
})

test('closing task history while a transcript loads cannot reopen it', async () => {
  const pending = deferred<{ type: string; text: string }[]>()
  const h = harness({ get: async id => ({ ...task(id), runs: [finishedRun] }) }, {
    loadRunTranscript: () => pending.promise,
  })
  h.session.open()
  await flush()
  await h.session.handleKey({ type: 'enter' })
  const load = h.session.handleKey({ type: 'enter' })
  await h.session.handleKey({ type: 'escape' })
  expect(h.view()?.title).toBe('Tasks')
  pending.resolve([{ type: 'user', text: 'hi' }])
  await load
  expect(h.view()?.title).toBe('Tasks')
  h.session.dispose()
})

test('editing a task sends a normal visible user turn through the run stream', async () => {
  const turns: { user: string; prompt: string }[] = []
  const h = harness({}, { runTaskTurn: (user, prompt) => { turns.push({ user, prompt }) } })
  h.session.open()
  await flush()
  await h.session.handleKey({ type: 'char', char: 'e' })
  expect(h.view()).toBeNull()
  expect(turns).toHaveLength(1)
  expect(turns[0]?.user).toBe('/task edit a')
  expect(turns[0]?.prompt).toContain('user-visible sentence')
  expect(turns[0]?.prompt).toContain('ordinary assistant text')
  h.session.dispose()
})

test('unfinished task edit retains its tool for a plain-text follow-up, but not another session', async () => {
  const extensions: import('../src/term/host-tools.js').HostToolExtension[] = []
  const h = harness({}, { runTaskTurn: (_user, _prompt, extension) => { extensions.push(extension) } })
  h.session.open()
  await flush()
  await h.session.handleKey({ type: 'char', char: 'e' })
  const tool = extensions[0]
  expect(tool?.handles('automation_task_update')).toBe(true)
  expect(h.session.unfinishedFlow(tool)).toBe(true)
  // The model ended with "send me the new instruction". The user's reply
  // must use the same flow rather than silently becoming a coding chat.
  expect(h.session.followUpExtension('current-session')).toBe(tool)
  expect(h.session.followUpExtension('another-session')).toBeUndefined()
  expect(h.session.unfinishedFlow(tool)).toBe(false)
  h.session.dispose()
})

test('task edit flow can be cancelled explicitly and cannot leak into the next reply', async () => {
  const h = harness({})
  h.session.open()
  await flush()
  await h.session.handleKey({ type: 'char', char: 'e' })
  expect(h.session.cancelFlow()).toBe(true)
  expect(h.session.followUpExtension('current-session')).toBeUndefined()
  expect(h.session.cancelFlow()).toBe(false)
  h.session.dispose()
})

test('a task flow started without a chat binds its new session before follow-up', () => {
  let extension: import('../src/term/host-tools.js').HostToolExtension | undefined
  const h = harness({}, {
    currentSessionId: () => null,
    runTaskTurn: (_user, _prompt, tool) => { extension = tool },
  })
  h.session.create('/task daily report', 'daily report')
  expect(extension).toBeDefined()
  h.session.bindFlowSession('new-session', extension)
  expect(h.session.followUpExtension('new-session')).toBe(extension)
  expect(h.session.followUpExtension('other-session')).toBeUndefined()
  h.session.dispose()
})
