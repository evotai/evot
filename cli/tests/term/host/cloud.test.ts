import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveCommand } from '../../../src/commands/index.js'
import { createEditorState, insertText, showCompletions } from '../../../src/term/input/editor.js'
import { createCloudController, type CloudDeps } from '../../../src/term/host/cloud.js'
import type { ReplState } from '../../../src/term/host/state.js'

const current = readFileSync(new URL('../../fixtures/contracts/skill-command-v1.md', import.meta.url), 'utf8')
const legacy = readFileSync(new URL('../../fixtures/contracts/skill-command-v0.md', import.meta.url), 'utf8')

test('catalog sync refreshes command registrations and cancels stale argument suggestions without restarting', () => {
  const root = mkdtempSync(join(tmpdir(), 'evot-command-sync-'))
  try {
    mkdirSync(join(root, 'harden'))
    writeFileSync(join(root, 'harden/SKILL.md'), current)
    const st = { skillEntries: [], deferredSkillNotice: null, editor: insertText(createEditorState(), '/ha') } as unknown as ReplState
    let cancelled = 0, renders = 0
    const notices: string[] = []
    const deps = {
      agent: { skillsDirs: () => [root] }, suggestions: { cancel: () => { cancelled++ } },
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
      agent: { skillsDirs: () => [root] }, suggestions: { cancel: () => { cancelled++ } },
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
