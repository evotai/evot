import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveCommand } from '../../../src/commands/index.js'
import { getSkillEntries } from '../../../src/commands/skill/scan.js'
import type { SuggestionOutcome } from '../../../src/native/contracts/ports.js'
import { PromptSuggestion, SuggestionContext } from '../../../src/term/app/suggestion/index.js'
import { createEditorState, editorCursorOffset, getEditorText, insertText, showCompletions } from '../../../src/term/input/editor.js'
import { createCloudController, type CloudDeps } from '../../../src/term/host/cloud.js'
import type { ReplState } from '../../../src/term/host/state.js'

const current = readFileSync(new URL('../../fixtures/contracts/skill-command-v1.md', import.meta.url), 'utf8')
const legacy = readFileSync(new URL('../../fixtures/contracts/skill-command-v0.md', import.meta.url), 'utf8')

const tick = () => new Promise<void>(resolve => setImmediate(resolve))

/** Exercise the real suggestion owner, not only a spy on its invalidation. */
function suggestionSyncHarness(draft: string) {
  const root = mkdtempSync(join(tmpdir(), 'evot-suggestion-sync-'))
  mkdirSync(join(root, 'harden'))
  writeFileSync(join(root, 'harden/SKILL.md'), current)
  const st = { skillEntries: getSkillEntries([root]), editor: insertText(createEditorState(), draft) } as unknown as ReplState
  const context = new SuggestionContext()
  context.user('Implement the change')
  context.observe({ kind: 'assistant_completed', payload: { stop_reason: 'stop', content: [{ type: 'text', text: 'The change is ready.' }] } })
  let requests = 0, aborted = 0
  let resolve!: (outcome: SuggestionOutcome) => void
  const outcome = new Promise<SuggestionOutcome>(yes => { resolve = yes })
  const suggestions = new PromptSuggestion({
    key: () => 'session', eligible: () => true, context: () => context.snapshot(),
    draft: () => getEditorText(st.editor), cursor: () => editorCursorOffset(st.editor),
    skills: () => st.skillEntries, changed: () => {},
    start: () => {
      requests++
      return { result: async () => (await outcome).candidates[0] ?? null, outcome: () => outcome, abort: () => { aborted++ } }
    },
  })
  const cloud = createCloudController(st, {
    agent: { skillsDirs: () => [root] }, suggestions,
    frames: { refreshBannerData: () => {} }, renderer: { requestRender: () => {} },
  } as unknown as CloudDeps)
  return {
    suggestions, requests: () => requests, aborted: () => aborted,
    resolve: () => resolve({ status: 'ready', candidates: ['Run the targeted tests', 'Review the diff', 'Commit the change'] }),
    draft: (text: string) => { st.editor = insertText(createEditorState(), text); suggestions.reconcile() },
    sync: () => { writeFileSync(join(root, 'harden/SKILL.md'), legacy); cloud.noteOfficialSkillSync() },
    close: () => { suggestions.cancel(); rmSync(root, { recursive: true, force: true }) },
  }
}

test.each(['pending', 'ready'] as const)('catalog changes preserve %s prose suggestions and their selection', async stage => {
  for (const mode of ['automatic', 'explicit', 'draft'] as const) {
    const draft = mode === 'draft' ? 'Please ' : ''
    const h = suggestionSyncHarness(draft)
    try {
      if (mode === 'automatic') h.suggestions.start()
      else h.suggestions.complete(draft)
      if (stage === 'ready') {
        h.resolve()
        await tick()
        if (mode !== 'automatic') { h.suggestions.next(); h.suggestions.next() }
        // A temporary slash draft must not turn an empty-input batch into a
        // command-bound request when the background sync finishes.
        if (!draft) h.draft('/re')
      }
      h.sync()
      if (stage === 'pending') { h.resolve(); await tick() }
      else if (!draft) h.draft('')
      const selected = stage === 'ready' && mode !== 'automatic' ? 3 : 1
      expect(h.suggestions.text()).toBe(selected === 3 ? 'Commit the change' : 'Run the targeted tests')
      expect(h.suggestions.position()).toEqual({ current: selected, total: 3 })
      expect(h.requests()).toBe(1)
      expect(h.aborted()).toBe(0)
    } finally {
      h.close()
    }
  }
})

test.each(['pending', 'ready'] as const)('catalog changes discard %s command argument suggestions and late results', async stage => {
  const h = suggestionSyncHarness('/harden inspect ')
  try {
    h.suggestions.complete('/harden inspect ')
    if (stage === 'ready') { h.resolve(); await tick(); expect(h.suggestions.text()).not.toBe('') }
    h.sync()
    if (stage === 'pending') { h.resolve(); await tick() }
    expect(h.suggestions.text()).toBe('')
    expect(h.suggestions.feedback()).toBeUndefined()
    expect(h.suggestions.next()).toBe(false)
    expect(h.requests()).toBe(1)
    expect(h.aborted()).toBe(stage === 'pending' ? 1 : 0)
  } finally {
    h.close()
  }
})

test('catalog sync refreshes command registrations and cancels stale argument suggestions without restarting', () => {
  const root = mkdtempSync(join(tmpdir(), 'evot-command-sync-'))
  try {
    mkdirSync(join(root, 'harden'))
    writeFileSync(join(root, 'harden/SKILL.md'), current)
    const st = { skillEntries: [], deferredSkillNotice: null, editor: insertText(createEditorState(), '/ha') } as unknown as ReplState
    let cancelled = 0, renders = 0
    const notices: string[] = []
    const deps = {
      agent: { skillsDirs: () => [root] }, suggestions: { cancelCommand: () => { cancelled++ } },
      frames: { refreshBannerData: () => {} }, renderer: { requestRender: () => { renders++ } },
      commandWindow: { commandWindowMounted: () => true },
      scrollback: { commitSystem: (_id: string, message: string) => { notices.push(message) } },
    } as unknown as CloudDeps
    const ctl = createCloudController(st, deps)
    const result = { installed: ['harden'], updated: [], removed: [], unchanged: [], skipped: [] }
    ctl.noteOfficialSkillSync(result)
    expect(resolveCommand('/harden changes', st.skillEntries)).toMatchObject({ kind: 'skill' })
    expect(st.editor.ghostHint).toContain('rden')
    expect(st.deferredSkillNotice).toContain('harden')
    expect(notices).toEqual([])
    writeFileSync(join(root, 'harden/SKILL.md'), legacy)
    ctl.noteOfficialSkillSync({ ...result, installed: [], updated: ['harden'] })
    expect(st.skillEntries.map(skill => skill.name)).toEqual(['harden'])
    expect(resolveCommand('/harden', st.skillEntries)).toEqual({ kind: 'unknown' })
    expect(st.editor.ghostHint).toBe('')
    rmSync(join(root, 'harden'), { recursive: true })
    ctl.noteOfficialSkillSync({ ...result, installed: [], removed: ['harden'] })
    expect(st.skillEntries).toEqual([])
    expect(cancelled).toBe(3)
    expect(renders).toBe(3)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('no-op and failed maintenance reconcile external changes without announcing success or cancelling unchanged input', () => {
  const root = mkdtempSync(join(tmpdir(), 'evot-command-sync-'))
  try {
    const st = { skillEntries: [], deferredSkillNotice: null, editor: insertText(createEditorState(), '/ha') } as unknown as ReplState
    let cancelled = 0, renders = 0
    const deps = {
      agent: { skillsDirs: () => [root] }, suggestions: { cancelCommand: () => { cancelled++ } },
      frames: { refreshBannerData: () => {} }, renderer: { requestRender: () => { renders++ } },
    } as unknown as CloudDeps
    const ctl = createCloudController(st, deps)
    // Another process synced first; this process's pass reports fresh/current.
    mkdirSync(join(root, 'harden'))
    writeFileSync(join(root, 'harden/SKILL.md'), current)
    ctl.noteOfficialSkillSync()
    expect(resolveCommand('/harden', st.skillEntries)).toMatchObject({ kind: 'skill' })
    expect(st.editor.ghostHint).toContain('rden')
    expect(st.deferredSkillNotice).toBeNull()
    expect(cancelled).toBe(1)
    expect(renders).toBe(1)
    st.editor = showCompletions(st.editor, [{ label: '/harden', value: '/harden ' }], 0)
    const editor = st.editor
    ctl.noteOfficialSkillSync({ installed: [], updated: [], removed: [], unchanged: ['harden'], skipped: [] })
    expect(st.editor).toBe(editor)
    expect(cancelled).toBe(1)
    expect(renders).toBe(1)
    // A sync wrote one unit before a later unit failed; do not leave a stale menu.
    writeFileSync(join(root, 'harden/SKILL.md'), legacy)
    ctl.noteOfficialSkillSync()
    expect(resolveCommand('/harden', st.skillEntries)).toEqual({ kind: 'unknown' })
    expect(st.editor.completion).toBeNull()
    expect(st.editor.ghostHint).toBe('')
    expect(st.deferredSkillNotice).toBeNull()
    expect(cancelled).toBe(2)
    expect(renders).toBe(2)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
