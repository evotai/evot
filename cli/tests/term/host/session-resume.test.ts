import { expect, test } from 'bun:test'
import { createSessionController, type SessionDeps } from '../../../src/term/host/session.js'
import type { ReplState } from '../../../src/term/host/state.js'
import type { SessionMeta } from '../../../src/native/index.js'

/**
 * Just enough of the REPL to drive `resumeSession` up to the model-selection
 * step. Both scenarios return before any UI is touched, so the harness only
 * needs the dependencies on that path.
 */
function harness(agent: Record<string, unknown>) {
  const st = { logMode: null, destroyed: false, composerRevision: 0, draftImageEpoch: 0, suggestionContextId: 0 } as unknown as ReplState
  const notices: string[] = []
  const ctl = createSessionController(st, {
    agent,
    cloudSessions: { remoteFor: () => undefined },
    resumeCache: { metadata: [] },
    runCtl: { abandonRun: () => {} },
    queueLifecycle: { pause: () => {} },
    suggestions: { cancel: () => {} },
    taskSession: { cancelFlow: () => {} },
    computeSession: { cancelFlow: () => {} },
    loopSession: { reset: () => {} },
    scrollback: { commitSystem: (_id: string, text: string) => { notices.push(text) } },
  } as unknown as SessionDeps)
  return { ctl, notices }
}

const session = { session_id: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', model: 'gpt-5.5', provider: 'openai', thinking_level: 'low', cwd: '/work' } as SessionMeta

test('an explicit startup level the resumed model cannot run is reported as selection_rejected', async () => {
  const h = harness({
    model: 'gpt-5.5',
    loadResumeTranscript: async () => [],
    reloadProvider: () => true,
    restoreThinkingLevel: () => {},
    applyThinkingLevel: (level: string) => { throw new Error(`thinking level '${level}' is not supported by openai/gpt-5.5`) },
  })
  expect(await h.ctl.resumeSession(session, undefined, { thinkingLevel: 'max' })).toBe('selection_rejected')
  expect(h.notices.join('\n')).toContain("thinking level 'max' is not supported")
})

test('a resume failure unrelated to the startup flags is reported as failed', async () => {
  const h = harness({
    model: 'gpt-5.5',
    loadResumeTranscript: async () => { throw new Error('transcript unreadable') },
    applyThinkingLevel: () => { throw new Error('must not be reached') },
  })
  expect(await h.ctl.resumeSession(session, undefined, { thinkingLevel: 'max' })).toBe('failed')
  expect(h.notices.join('\n')).toContain('Failed to resume: transcript unreadable')
})
