import { describe, expect, test } from 'bun:test'
import { findPreviousSession, shouldPreloadStartupSessions, selectResumeMessages, resumeElidedLine, reloadResumeModel, resumeModelUnavailableNote, RESUME_DISPLAY_LIMIT } from '../../src/session/session-view.js'
import type { SessionMeta } from '../../src/native/index.js'
import type { UIMessage } from '../../src/render/message-types.js'

describe('repl session view helpers', () => {
  const sessions: SessionMeta[] = [
    { session_id: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', title: 'cwd session', cwd: '/work', source: 'local', updated_at: '2026-01-02T00:00:00Z' } as any,
    { session_id: 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb', title: 'other session', cwd: '/other', updated_at: '2026-01-03T00:00:00Z' } as any,
  ]

  test('plain startup does not preload previous sessions', () => {
    expect(shouldPreloadStartupSessions({})).toBe(false)
  })

  test('continue and resume startup preload sessions', () => {
    expect(shouldPreloadStartupSessions({ continueLatest: true })).toBe(true)
    expect(shouldPreloadStartupSessions({ resumeSessionId: 'aaaaaaaa' })).toBe(true)
  })

  test('findPreviousSession returns latest interactive cwd session, not a task run', () => {
    const older = { session_id: 'cccccccc-3333-4333-8333-cccccccccccc', title: 'older cwd session', cwd: '/work', updated_at: '2026-01-01T00:00:00Z' } as any
    const run = { ...older, session_id: 'task-run', source: 'automation', updated_at: '2026-01-04T00:00:00Z' }
    expect(findPreviousSession([older, run, ...sessions], '/work')).toBe(sessions[0])
    expect(findPreviousSession([run], '/work')).toBeUndefined()
  })

  const makeMessages = (n: number): UIMessage[] =>
    Array.from({ length: n }, (_, i) => ({ id: `m${i}`, role: i % 2 === 0 ? 'user' : 'assistant', text: `msg ${i}`, timestamp: 0 } as UIMessage))

  test('selectResumeMessages returns all when under the limit', () => {
    const msgs = makeMessages(10)
    const { shown, hidden } = selectResumeMessages(msgs)
    expect(hidden).toBe(0)
    expect(shown).toBe(msgs)
  })

  test('selectResumeMessages keeps only the most recent when over the limit', () => {
    const msgs = makeMessages(200)
    const { shown, hidden } = selectResumeMessages(msgs)
    expect(hidden).toBe(200 - RESUME_DISPLAY_LIMIT)
    expect(shown.length).toBe(RESUME_DISPLAY_LIMIT)
    // Keeps the tail, not the head.
    expect(shown[0]!.id).toBe(`m${200 - RESUME_DISPLAY_LIMIT}`)
    expect(shown[shown.length - 1]!.id).toBe('m199')
  })

  test('selectResumeMessages respects a custom limit', () => {
    const { shown, hidden } = selectResumeMessages(makeMessages(50), 10)
    expect(hidden).toBe(40)
    expect(shown.length).toBe(10)
    expect(shown[0]!.id).toBe('m40')
  })

  test('selectResumeMessages at exactly the limit hides nothing', () => {
    const { shown, hidden } = selectResumeMessages(makeMessages(RESUME_DISPLAY_LIMIT))
    expect(hidden).toBe(0)
    expect(shown.length).toBe(RESUME_DISPLAY_LIMIT)
  })

  test('resumeElidedLine reports the hidden count and pluralizes', () => {
    const many = resumeElidedLine(120)
    expect(many.kind).toBe('system')
    expect(many.id).toBe('sys-resumed-elided')
    expect(many.text).toContain('120 earlier messages hidden')
    expect(many.text).toContain(`latest ${RESUME_DISPLAY_LIMIT}`)
    expect(resumeElidedLine(1).text).toContain('1 earlier message hidden')
  })

  test('reloadResumeModel restores the session thinking level over the config default', () => {
    const calls: string[] = []
    const restored: string[] = []
    const agent = {
      model: 'claude-opus-4-8',
      reloadProvider(spec: string) {
        calls.push(spec)
        return true
      },
      restoreThinkingLevel(level: string) {
        restored.push(level)
      },
    }

    expect(reloadResumeModel(agent, 'gpt-5.5', 'openai', 'high')).toBeNull()
    expect(calls).toEqual(['openai:gpt-5.5'])
    expect(restored).toEqual(['high'])

    // No recorded level keeps the config-applied default.
    expect(reloadResumeModel(agent, undefined, 'openai', null)).toBeNull()
    expect(calls).toHaveLength(1)
    expect(restored).toHaveLength(1)
  })

  test('reloadResumeModel reports unavailable saved selections and reload errors', () => {
    const restored: string[] = []
    const unavailable = {
      model: 'claude-opus-4-8',
      reloadProvider: (_spec: string) => false,
      restoreThinkingLevel(level: string) {
        restored.push(level)
      },
    }
    // The thinking level is still restored onto the kept live model.
    expect(reloadResumeModel(unavailable, 'grok-4.5', 'grok', 'low'))
      .toBe("  provider 'grok' unavailable · kept claude-opus-4-8 · /model to switch")
    expect(restored).toEqual(['low'])

    const failing = {
      model: 'claude-opus-4-8',
      reloadProvider: (_spec: string): boolean => { throw new Error('bad config') },
      restoreThinkingLevel: (_level: string): void => { throw new Error('unsupported') },
    }
    expect(reloadResumeModel(failing, 'missing-model', undefined, 'xhigh'))
      .toBe("  model 'missing-model' unavailable · kept claude-opus-4-8 · /model to switch")
  })

  test('resumeModelUnavailableNote keeps live model and points to /model', () => {
    expect(resumeModelUnavailableNote({
      provider: 'grok',
      model: 'grok-4.5',
      keptModel: 'claude-opus-4-8',
    })).toBe("  provider 'grok' unavailable · kept claude-opus-4-8 · /model to switch")

    expect(resumeModelUnavailableNote({
      model: 'missing-model',
      keptModel: 'claude-opus-4-8',
    })).toBe("  model 'missing-model' unavailable · kept claude-opus-4-8 · /model to switch")
  })
})
