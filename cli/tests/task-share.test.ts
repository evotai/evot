import { describe, expect, test } from 'bun:test'
import type { AskUserAnswer, AskUserParams } from '../src/term/host-tools.js'
import { commitTaskChange, normalizeTaskArguments } from '../src/task/commit.js'
import { handleTaskKey } from '../src/task/control.js'
import { TASK_CREATE_SPEC, TASK_UPDATE_SPEC } from '../src/task/host-tool.js'
import {
  ADJUST_WITH_AGENT,
  importArguments,
  importAsRequest,
  importExtraFields,
  importModelPreselect,
} from '../src/task/import.js'
import type { TaskModelDefaults, TaskModelPickerRequest } from '../src/task/model-picker.js'
import { createTaskFlowState } from '../src/task/prompt.js'
import { createTaskWindow } from '../src/task/window.js'
import { TaskSession, maskTarget, type TaskSessionApi, type TaskSessionHost } from '../src/task/session.js'
import { TASK_RUNTIME_DEFAULT_MODEL, type ScheduledTask, type TaskShareSnapshot } from '../src/task/types.js'
import { shareSelectorState } from '../src/term/app/share-selector.js'
import type { SelectorState } from '../src/term/selector.js'

const LINK = 'https://evot.ai/share/t/Xk3f9a2bQwErTyUiOpAs12'

const snapshot: TaskShareSnapshot = {
  schema_version: 1, kind: 'task', evot_version: '1.0', title: 'Daily HN digest', created_at: 1,
  data: {
    name: 'Daily HN digest', cron: '0 9 * * 1-5', timezone: 'Asia/Shanghai',
    instruction: 'Summarise the top stories.', model_policy: 'fixed',
    model_spec: 'evot-pro:claude-opus', thinking_level: 'high',
    timeout_seconds: 600, max_lateness_seconds: 3600,
    delivery_channel: 'feishu', delivery_target_masked: 'oc_1a2b••••',
  },
}

const defaults: TaskModelDefaults = {
  model_spec: 'evot-pro:deepseek', thinking_level: 'medium',
  feishu_ready: true, feishu_target: 'oc_mine', env_file: undefined,
  available_models: [
    { spec: 'evot-pro:claude-opus', model: 'claude-opus', label: 'Claude Opus', thinking_level: 'high' },
    { spec: 'evot-pro:deepseek', model: 'deepseek', label: 'DeepSeek', thinking_level: 'medium' },
  ],
}

const task = (id: string): ScheduledTask => ({
  id, revision: 1, name: `Task ${id}`, cron: '0 9 * * *', timezone: 'UTC', instruction: 'hi', executor_id: 'exec',
  model_policy: 'default', model_spec: '', thinking_level: '', workspace_ref: '',
  delivery_channel: 'feishu', delivery_target: 'oc_abcdefghijklmnop', timeout_seconds: 60,
  max_lateness_seconds: 60, enabled: true, next_run_at: 0,
})

const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve() }

describe('import helpers', () => {
  test('the recipe is imported; delivery never is', () => {
    expect(importArguments(snapshot)).toEqual({
      name: 'Daily HN digest', cron: '0 9 * * 1-5', timezone: 'Asia/Shanghai',
      instruction: 'Summarise the top stories.', timeout_seconds: 600, max_lateness_seconds: 3600,
    })
    // Through the same normaliser as a tool call: device delivery is bound.
    const patch = normalizeTaskArguments(importArguments(snapshot), createTaskFlowState('create'), defaults)
    expect(patch.delivery_channel).toBe('feishu')
    expect(patch.delivery_target).toBe('oc_mine')
    expect(JSON.stringify(patch)).not.toContain('oc_1a2b')
  })

  test('the shared model positions the picker only when this device has it', () => {
    expect(importModelPreselect(snapshot, defaults)).toEqual({
      request: { preferredSpec: 'evot-pro:claude-opus', preferredThinkingLevel: 'high' },
    })
    const missing = importModelPreselect(
      { ...snapshot, data: { ...snapshot.data, model_spec: 'other:gpt-9', thinking_level: 'max' } },
      defaults,
    )
    expect(missing.request).toEqual({ preferredSpec: 'evot-pro:deepseek', preferredThinkingLevel: 'medium' })
    expect(missing.note).toBe('Shared task used gpt-9; not available here')
    expect(importModelPreselect(
      { ...snapshot, data: { ...snapshot.data, model_policy: 'default', model_spec: '' } },
      defaults,
    )).toEqual({ request: { preferredSpec: TASK_RUNTIME_DEFAULT_MODEL } })
  })

  test('confirmation names the source and says shared delivery is not used', () => {
    expect(importExtraFields(snapshot, LINK)).toEqual([
      `source: ${LINK}`,
      'shared delivery: masked, not imported — your own chat is used',
    ])
    expect(importAsRequest(snapshot, LINK)).toContain('cron: 0 9 * * 1-5')
    expect(importAsRequest(snapshot, LINK)).toContain('Summarise the top stories.')
  })

  test('tool schemas and the normaliser agree on which fields a proposer may set', () => {
    const create = Object.keys(TASK_CREATE_SPEC.parameters_schema.properties)
    const update = Object.keys(TASK_UPDATE_SPEC.parameters_schema.properties)
    const flow = createTaskFlowState('create')
    const all = Object.fromEntries([...create, 'executor_id', 'idempotency_key', 'user_id'].map(key => [key, 'x']))
    const patch = normalizeTaskArguments({ ...all, delivery_channel: '', delivery_target: '' }, flow, defaults)
    expect(Object.keys(patch).sort()).toEqual(
      create.filter(key => key !== 'model' && key !== 'thinking_level').sort(),
    )
    expect(update).toEqual(expect.arrayContaining(['task_id', 'revision', 'enabled', ...create]))
  })
})

describe('commit pipeline for an import', () => {
  function run(answer: string, picked: TaskModelPickerRequest[] = []) {
    const flow = createTaskFlowState('create')
    let question = ''
    const outcome = commitTaskChange({
      flow,
      defaults: async () => defaults,
      pickModel: async request => { picked.push(request); return { spec: 'evot-pro:claude-opus', thinkingLevel: 'high' } },
      collectAnswers: async (params: AskUserParams): Promise<AskUserAnswer[]> => {
        question = params.questions[0]?.question ?? ''
        return [{ header: 'Task', question, answer }]
      },
    }, {
      arguments: importArguments(snapshot),
      modelPreselect: resolved => importModelPreselect(snapshot, resolved).request,
      extraFields: importExtraFields(snapshot, LINK),
      extraOptions: [{ label: ADJUST_WITH_AGENT, description: 'x' }],
    })
    return { outcome, flow, question: () => question }
  }

  test('an import opens the picker on the shared model and confirms with the source', async () => {
    const picked: TaskModelPickerRequest[] = []
    const { outcome, flow, question } = run(ADJUST_WITH_AGENT, picked)
    expect(await outcome).toEqual({ kind: 'declined', choice: ADJUST_WITH_AGENT })
    expect(picked).toEqual([{ preferredSpec: 'evot-pro:claude-opus', preferredThinkingLevel: 'high' }])
    expect(question()).toContain('model: Claude Opus · high')
    expect(question()).toContain('delivery: Feishu · oc_mine')
    expect(question()).toContain(`source: ${LINK}`)
    expect(question()).not.toContain('oc_1a2b')
    expect(flow.mutationAttempted).toBe(true)
  })

  test('cancelling sends nothing', async () => {
    const { outcome } = run('Cancel')
    expect((await outcome).kind).toBe('cancelled')
  })
})

describe('sharing from the task list', () => {
  test('s publishes the focused task and the window hints say so', () => {
    const state = createTaskWindow({ tasks: [task('a')], cache: { ready: true, synced_at: 1, stale: false } })
    expect(handleTaskKey(state, { type: 'char', char: 's' })).toEqual({ kind: 'share', id: 'a' })
    expect(state.hints?.some(hint => hint.action === 'share')).toBe(true)
  })

  test('the publish confirmation masks the chat and the link is announced after the server answers', async () => {
    let overlay: SelectorState | null = null
    const notes: string[] = []
    const questions: string[] = []
    const shared: string[] = []
    const host: TaskSessionHost = {
      configInfo: () => undefined, activeModel: () => '', activeModelSpec: () => '',
      modelOptionLabel: model => model.model, ensureDelivery: async () => false,
      isTaskOverlay: () => overlay !== null, taskOverlayState: () => overlay,
      currentSessionId: () => null,
      showSelector: state => { overlay = state }, loadRunTranscript: async () => null, closeOverlay: () => { overlay = null },
      requestRender: () => {}, notifyError: error => { notes.push(`error: ${error}`) },
      notify: text => { notes.push(text) }, hyperlink: url => `<${url}>`,
      collectAnswers: async qs => {
        questions.push(qs[0]?.question ?? '')
        return [{ header: 'Share task', question: '', answer: 'Publish' }]
      },
      presentModelPicker: async () => null, runTaskTurn: () => {}, primeInput: () => {}, destroyed: () => false,
    }
    const api: TaskSessionApi = {
      list: async () => ({ tasks: [task('a')], cache: { ready: true, synced_at: 1, stale: false } }),
      get: async id => ({ ...task(id), runs: [] }), delete: async () => {},
      update: async id => ({ task: task(id), next_runs: [] }), run: async () => {},
      share: async id => { shared.push(id); return { id: 'Xk3f9a2bQwErTyUiOpAs12', url: LINK } },
      fetchShare: async () => snapshot,
      create: async () => { throw new Error('not created here') },
      deliveryDefaults: async () => ({ feishu_ready: true, feishu_target: 'oc_mine' }),
    }
    const session = new TaskSession(host, api)
    session.open()
    await flush()
    await session.handleKey({ type: 'char', char: 's' })
    await flush()
    expect(shared).toEqual(['a'])
    expect(questions[0]).toContain('Publish “Task a” as a public link?')
    expect(questions[0]).toContain('Delivery: Feishu · oc_abcd•••• (masked on the page)')
    expect(questions[0]).not.toContain('oc_abcdefghijklmnop')
    expect(notes).toEqual([`Shared “Task a”: <${LINK}>`])
    expect(overlay).not.toBeNull()
    session.dispose()
  })

  test('maskTarget keeps four characters and names the broadcast policy', () => {
    expect(maskTarget('oc_abcdefghijklmnop')).toBe('oc_abcd••••')
    expect(maskTarget('p2p:*')).toBe('all bot direct conversations')
    expect(maskTarget('weird')).toBe('••••')
  })
})

describe('/task <link> in the session', () => {
  function harness(answer: string, fetch: TaskSessionApi['fetchShare'] = async () => snapshot) {
    let overlay: SelectorState | null = null
    const notes: string[] = []
    const turns: string[] = []
    const created: Record<string, unknown>[] = []
    const picked: TaskModelPickerRequest[] = []
    let question = ''
    const host: TaskSessionHost = {
      configInfo: () => undefined, activeModel: () => '', activeModelSpec: () => 'evot-pro:deepseek',
      modelOptionLabel: model => model.model, ensureDelivery: async () => false,
      isTaskOverlay: () => overlay !== null, taskOverlayState: () => overlay,
      currentSessionId: () => null,
      showSelector: state => { overlay = state }, loadRunTranscript: async () => null, closeOverlay: () => { overlay = null },
      requestRender: () => {}, notifyError: error => { notes.push(`error: ${error}`) },
      notify: text => { notes.push(text) },
      collectAnswers: async qs => { question = qs[0]?.question ?? ''; return [{ header: 'Task', question, answer }] },
      presentModelPicker: async request => { picked.push(request); return { spec: TASK_RUNTIME_DEFAULT_MODEL } },
      runTaskTurn: (_line, prompt) => { turns.push(prompt) }, primeInput: () => {}, destroyed: () => false,
    }
    const api: TaskSessionApi = {
      list: async () => ({ tasks: [task('new')], cache: { ready: true, synced_at: 1, stale: false } }),
      get: async id => ({ ...task(id), runs: [] }), delete: async () => {},
      update: async id => ({ task: task(id), next_runs: [] }), run: async () => {},
      share: async () => ({ id: '', url: '' }),
      fetchShare: fetch,
      create: async input => { created.push(input); return { task: { ...task('new'), name: String(input.name) }, next_runs: [] } },
      deliveryDefaults: async () => ({ feishu_ready: true, feishu_target: 'oc_mine' }),
    }
    return { session: new TaskSession(host, api), notes, turns, created, picked, question: () => question, view: () => overlay }
  }

  test('confirm creates from the recipe with this device\'s delivery and opens the list on it', async () => {
    const h = harness('Confirm')
    await h.session.import(LINK)
    await flush()
    expect(h.created).toHaveLength(1)
    const body = h.created[0] ?? {}
    expect(body.name).toBe('Daily HN digest')
    expect(body.cron).toBe('0 9 * * 1-5')
    expect(body.delivery_channel).toBe('feishu')
    expect(body.delivery_target).toBe('oc_mine')
    expect(body.model_policy).toBe('default')
    expect(JSON.stringify(body)).not.toContain('oc_1a2b')
    // No catalog on this host, so the shared model is not available here: the
    // picker opens on the live model and says what the sharer used.
    expect(h.picked[0]?.note).toBe('Shared task used claude-opus; not available here')
    expect(h.question()).toContain(`source: ${LINK}`)
    expect(h.notes).toEqual(['Fetching shared task…', 'Created Daily HN digest. Next run: paused.'])
    expect(h.view()?.items.map(item => item.id)).toEqual(['new'])
    expect(h.turns).toEqual([])
    h.session.dispose()
  })

  test('"Adjust with agent" hands the recipe to the create flow instead of saving', async () => {
    const h = harness(ADJUST_WITH_AGENT)
    await h.session.import(LINK)
    expect(h.created).toEqual([])
    expect(h.turns).toHaveLength(1)
    expect(h.turns[0]).toContain('Create a scheduled task from this request:')
    expect(h.turns[0]).toContain('cron: 0 9 * * 1-5')
    expect(h.turns[0]).toContain(LINK)
    h.session.dispose()
  })

  test('typed feedback at the import confirmation goes to the agent with the feedback first', async () => {
    // Same road as "Adjust with agent": nothing is created, the recipe and
    // the objection become the create request.
    const h = harness('改成每天 8 点，别发飞书')
    await h.session.import(LINK)
    expect(h.created).toEqual([])
    expect(h.turns).toHaveLength(1)
    expect(h.turns[0]).toContain('cron: 0 9 * * 1-5')
    expect(h.turns[0]).toContain('Before saving, change this: 改成每天 8 点，别发飞书')
    h.session.dispose()
  })

  test('cancelling and a revoked link both leave nothing behind', async () => {
    const cancelled = harness('Cancel')
    await cancelled.session.import(LINK)
    expect(cancelled.created).toEqual([])
    expect(cancelled.notes.at(-1)).toBe('Import cancelled. Nothing was created.')
    cancelled.session.dispose()

    const revoked = harness('Confirm', async () => { throw new Error('shared task not found; the link may have been revoked') })
    await revoked.session.import(LINK)
    expect(revoked.created).toEqual([])
    expect(revoked.notes).toEqual([
      'Fetching shared task…',
      'error: Could not import shared task: shared task not found; the link may have been revoked',
    ])
    revoked.session.dispose()
  })
})

describe('shared links selector', () => {
  test('tasks and sessions are grouped, labelled by kind, and previewed differently', () => {
    const state = shareSelectorState([
      { id: 'sess00000001', url: 'https://evot.ai/share/sess00000001', title: 'Fix flaky test', created_at: 1 },
      { id: 'task00000001', url: 'https://evot.ai/share/t/task00000001', title: 'Daily HN digest', kind: 'task', created_at: 2,
        summary: { cron: '0 9 * * 1-5', timezone: 'Asia/Shanghai', model: 'claude-opus', model_policy: 'fixed', thinking_level: 'high', source_task_revision: 7 } },
    ])
    expect(state.title).toBe('Shared links')
    expect(state.allItems.filter(item => item.header).map(item => item.label)).toEqual(['Tasks', 'Sessions'])
    const rows = state.allItems.filter(item => !item.header)
    expect(rows.map(item => item.id)).toEqual(['task00000001', 'sess00000001'])
    expect(rows[0]?.label).toBe('Daily HN digest')
    expect(rows[0]?.detail).toBe('task · task0000')
    expect(rows[0]?.preview).toEqual(expect.arrayContaining([
      'Schedule: 0 9 * * 1-5 · Asia/Shanghai', 'Model: claude-opus · high', 'Task revision: 7',
      'Deleting revokes this link, not the task.',
    ]))
    expect(rows[1]?.preview).toEqual(expect.arrayContaining(['Deleting revokes this link, not the local session.']))
    // A list of one kind stays flat, as it always was.
    const flat = shareSelectorState([{ id: 'sess00000001', url: 'u', title: 't' }])
    expect(flat.allItems.some(item => item.header)).toBe(false)
    expect(flat.allItems[0]?.label).toBe('t')
    expect(flat.allItems[0]?.detail).toBe('session · sess0000')
  })
})
