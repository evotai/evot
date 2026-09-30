import { describe, expect, test } from 'bun:test'
import {
  RESUME_SELECTOR_TITLE,
  COMPACT_SUMMARY_PREFIX,
  applySessionText,
  formatSessionItems,
  isSessionIdPrefix,
  normalizeResumeQuery,
  resolveSessionByPrefix,
  sanitizeSessionTitle,
  sessionPreviewLines,
} from '../src/term/app/resume.js'
import { createSelectorState, selectorExpandItems, selectorReplaceItem, selectorType } from '../src/term/selector.js'
import type { SessionMeta, SessionWithText } from '../src/native/index.js'
import { enrichSessionRecognition, type SessionRecognition } from '../src/term/app/session-recognition.js'
import type { TranscriptItem } from '../src/native/index.js'

describe('repl resume helpers', () => {
  const sessions: SessionMeta[] = [
    { session_id: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', title: 'cwd session', cwd: '/work', source: 'local', model: 'm1', turns: 3, updated_at: Date.now() } as any,
    { session_id: 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb', title: 'other session', cwd: '/other', model: 'm2', updated_at: Date.now() } as any,
  ]

  function text(session: SessionMeta, overrides: Partial<SessionWithText> = {}): SessionWithText {
    return { ...session, search_text: '', user_prompts: [], ...overrides }
  }

  test('isSessionIdPrefix accepts hex prefix only', () => {
    expect(isSessionIdPrefix('abc123')).toBe(true)
    expect(isSessionIdPrefix('ABCDEF')).toBe(true)
    expect(isSessionIdPrefix('not-hex')).toBe(false)
    expect(isSessionIdPrefix('')).toBe(false)
  })

  test('normalizeResumeQuery accepts plain and quoted search terms', () => {
    expect(normalizeResumeQuery('NEBULA-4729')).toBe('NEBULA-4729')
    expect(normalizeResumeQuery(" 'NEBULA-4729' ")).toBe('NEBULA-4729')
    expect(normalizeResumeQuery('"NEBULA-4729"')).toBe('NEBULA-4729')
    expect(normalizeResumeQuery('“NEBULA-4729”')).toBe('NEBULA-4729')
    expect(normalizeResumeQuery("'unclosed")).toBe("'unclosed")
  })

  test('resolveSessionByPrefix matches unique prefix', () => {
    const resolved = resolveSessionByPrefix(sessions, 'aaaaaaaa')
    expect(resolved.kind).toBe('matched')
    if (resolved.kind === 'matched') expect(resolved.session).toBe(sessions[0])
  })

  test('resolveSessionByPrefix reports none', () => {
    expect(resolveSessionByPrefix(sessions, 'cccc').kind).toBe('none')
  })

  test('resolveSessionByPrefix reports ambiguous prefixes', () => {
    const ambiguous = [
      { session_id: 'abc11111-1111-4111-8111-aaaaaaaaaaaa' },
      { session_id: 'abc22222-2222-4222-8222-bbbbbbbbbbbb' },
    ] as SessionMeta[]
    const resolved = resolveSessionByPrefix(ambiguous, 'abc')
    expect(resolved.kind).toBe('ambiguous')
  })

  test('formatSessionItems groups current cwd before other cwd', () => {
    const items = formatSessionItems(sessions, '/work')
    expect(items.map(item => item.label)).toEqual([
      'Current cwd · /work',
      'cwd session',
      'Other cwd',
      'other session',
    ])
    expect(items[0]).toMatchObject({ header: true, focusable: false, group: 'current-cwd' })
    expect(items[1]).toMatchObject({ id: sessions[0]!.session_id, group: 'current-cwd' })
    // Sources differ across rows (`local` vs none), so the column is shown.
    expect(items[1]!.detail).toContain('local')
    expect(items[1]!.label).toBe('cwd session')
    expect(items[1]!.detail).toContain('3 turns')
    expect(items[1]!.detail).not.toContain('[3 turns]')
    expect(items[1]!.searchText).toContain('/work')
    expect(items[3]).toMatchObject({ id: sessions[1]!.session_id, group: 'other-cwd' })
    expect(items[3]!.detail).toContain('/other')
  })

  test('formatSessionItems marks other cwd as search-only when current cwd has sessions', () => {
    const items = formatSessionItems(sessions, '/work')
    expect(items[0]!.searchOnly).toBeFalsy()
    expect(items[1]!.searchOnly).toBeFalsy()
    expect(items[2]).toMatchObject({ label: 'Other cwd', searchOnly: true })
    expect(items[3]).toMatchObject({ id: sessions[1]!.session_id, searchOnly: true })
  })

  test('resume defaults to current cwd but searches other cwd', () => {
    const items = formatSessionItems(sessions, '/work')
    let state = createSelectorState(RESUME_SELECTOR_TITLE, items, items)

    expect(state.items.map(item => item.label)).toEqual([
      'Current cwd · /work',
      'cwd session',
    ])
    for (const char of 'other session') state = selectorType(state, char)
    expect(state.items.map(item => item.label)).toEqual(['Other cwd', 'other session'])
  })

  test('formatSessionItems extends colliding UUIDv7 prefixes', () => {
    const colliding = [
      { ...sessions[0]!, session_id: '01a069e9-4c86-77c0-8578-0f959cb03b53' },
      { ...sessions[0]!, session_id: '01a069e9-4d40-7883-a488-480d11386234' },
      { ...sessions[0]!, session_id: '01a069f0-1234-7000-8000-000000000000' },
    ]
    const labels = formatSessionItems(colliding, '/work')
      .filter(item => !item.header)
      .map(item => item.detail?.split(' · ').at(-1))

    expect(labels).toEqual(['01a069e9-4c', '01a069e9-4d', '01a069f0'])
    expect(new Set(labels).size).toBe(labels.length)
  })

  test('formatSessionItems keeps other cwd searchable when current cwd has no sessions', () => {
    const items = formatSessionItems(sessions, '/missing')
    expect(items[0]).toMatchObject({ label: 'Other cwd', header: true, searchOnly: true })
    expect(items.filter(item => !item.header)).toHaveLength(2)

    let state = createSelectorState(RESUME_SELECTOR_TITLE, items, items)
    expect(state.items).toHaveLength(0)
    for (const char of 'cwd session') state = selectorType(state, char)
    expect(state.items.map(item => item.label)).toEqual(['Other cwd', 'cwd session'])
  })

  test('loaded text supplies the searchable body, metadata carries the rest', () => {
    const withText = sessions.map((session, index) => ({
      ...session,
      search_text: index === 0 ? 'current full text body' : 'other full text body',
      user_prompts: [],
    })) as SessionWithText[]
    const byId = new Map(withText.map(row => [row.session_id, row]))
    const items = formatSessionItems(withText, '/work', id => byId.get(id))
    expect(items[1]!.searchText).toContain('current full text body')
    expect(items[3]!.searchText).toContain('other full text body')
    expect(items[3]!.contextPrefix).toBe('/other · ')
  })

  test('session rows carry a preview for the side pane', () => {
    const items = formatSessionItems(sessions, '/work')
    expect(items[1]!.preview?.[0]).toBe('cwd session')
    expect(items[0]!.preview).toBeUndefined()
  })

  test('sessionPreviewLines states identity on one line', () => {
    const lines = sessionPreviewLines(sessions[0]!)
    expect(lines[0]).toBe('cwd session')
    expect(lines[1]).toBe('m1 · 3 turns · just now')
    // cwd lives in the group heading and source in the row, so neither is
    // repeated for a session in the current directory.
    expect(lines.join('\n')).not.toContain('/work')
    expect(lines.join('\n')).not.toContain('local')
  })

  test('sessionPreviewLines adds cwd only for sessions from another directory', () => {
    expect(sessionPreviewLines(sessions[1]!, undefined, true)[1]).toEndWith(' · /other')
  })

  test('sessionPreviewLines splits the opening ask from the latest turns', () => {
    const lines = sessionPreviewLines(sessions[0]!, text(sessions[0]!, {
      user_prompts: ['fix the retry budget', 'now add a test', 'commit it'],
    }))

    expect(lines[2]).toBe('')
    expect(lines.slice(3)).toEqual([
      '# Started with', '› fix the retry budget',
      '',
      '# Latest', '› now add a test', '› commit it',
    ])
  })

  test('sessionPreviewLines keeps only the last three latest turns', () => {
    const lines = sessionPreviewLines(sessions[0]!, text(sessions[0]!, {
      user_prompts: ['one', 'two', 'three', 'four', 'five'],
    }))
    expect(lines).toContain('# Started with')
    expect(lines).toContain('› one')
    expect(lines).toContain('  ⋮')
    expect(lines.slice(lines.indexOf('# Latest'))).toEqual([
      '# Latest', '  ⋮', '› three', '› four', '› five',
    ])
    expect(lines).not.toContain('› two')
  })

  test('sessionPreviewLines keeps a trimmed session\'s real first prompt and lists changed files', () => {
    const lines = sessionPreviewLines(sessions[0]!, text(sessions[0]!, {
      first_prompt: 'build the whole thing',
      user_prompts: ['turn 70', 'turn 71'],
      changed_paths: ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts'],
    }))
    expect(lines.slice(3)).toEqual([
      '# Started with', '› build the whole thing',
      '',
      '# Latest', '› turn 70', '› turn 71',
      '',
      '# Changed 5 files', '  a.ts · b.ts · c.ts · +2',
    ])
  })

  test('sessionPreviewLines does not repeat a one-turn session under Latest', () => {
    const lines = sessionPreviewLines(sessions[0]!, text(sessions[0]!, { user_prompts: ['only ask'] }))
    expect(lines.slice(2)).toEqual(['', '# Started with', '› only ask'])
  })

  test('recognition pane leads with the opening, then the latest request, then a glimpse of the answer', () => {
    const transcript: TranscriptItem[] = [
      { type: 'user', text: 'Build a Hacker News summary task' },
      { type: 'assistant', content: [{ type: 'text', text: 'Created the summary task.' }] },
      { type: 'user', text: 'Send the result hourly' },
      { type: 'assistant', content: [
        { type: 'thinking', text: 'Implementation details must not be shown' },
        { type: 'tool_call', id: 'x', name: 'write', input: { path: 'secret.txt' } },
        { type: 'text', text: 'Updated the schedule to hourly and confirmed the destination.' },
      ] },
      { type: 'tool_result', tool_call_id: 'x', tool_name: 'write', content: 'wrote secret.txt', is_error: false },
    ]
    const session = enrichSessionRecognition(
      text(sessions[0]!, { user_prompts: [], changed_paths: ['a.ts'] }),
      transcript,
    )
    const joined = sessionPreviewLines(sessions[0]!, session).join('\n')
    expect(joined.indexOf('# Started with')).toBeLessThan(joined.indexOf('# Latest request'))
    expect(joined.indexOf('# Latest request')).toBeLessThan(joined.indexOf('# Latest response'))
    expect(joined).toContain('Updated the schedule to hourly')
    expect(joined).toContain('Send the result hourly')
    expect(joined).toContain('Build a Hacker News summary task')
    expect(joined).toContain('# Session')
    expect(joined).toContain('a.ts')
    expect(joined).not.toContain('Implementation details')
    expect(joined).not.toContain('wrote secret.txt')
    expect(joined).not.toContain('secret.txt')
  })

  test('empty conversation and long excerpts degrade without hiding the first request', () => {
    const session = enrichSessionRecognition(text(sessions[0]!), [])
    expect(sessionPreviewLines(sessions[0]!, session).join('\n')).toContain('No user requests or assistant responses')
    const long = enrichSessionRecognition(text(sessions[0]!), [
      { type: 'user', text: 'goal ' + 'x'.repeat(6000) },
      { type: 'assistant', content: [{ type: 'text', text: 'answer ' + 'y'.repeat(6000) }] },
    ])
    const joined = sessionPreviewLines(sessions[0]!, long).join('\n')
    // A one-turn session: its only request is the opening, shown once, and
    // both turns are glimpses rather than walls of text.
    expect(joined).toContain('# Started with')
    expect(joined).not.toContain('# Latest request')
    expect(joined).toContain('goal ')
    expect(joined).toContain('answer ')
    expect(joined).toContain('…')
    expect(joined.length).toBeLessThan(1500)
  })

  test('formatSessionItems hides the source column when every row shares one source', () => {
    const same = sessions.map(session => ({ ...session, source: 'tui' }))
    const items = formatSessionItems(same, '/work')
    expect(items[1]!.detail).not.toContain('tui')
    expect(items[1]!.label).toBe('cwd session')
  })

  test('sessionPreviewLines shows a time span for sessions that ran across time', () => {
    const day = 24 * 3600 * 1000
    const spread = { ...sessions[0]!, created_at: new Date(Date.now() - 3 * day).toISOString(), updated_at: new Date().toISOString() }
    expect(sessionPreviewLines(spread)[1]).toContain(' → ')
  })

  test('sessionPreviewLines omits the separator when no turns are loaded yet', () => {
    expect(sessionPreviewLines(sessions[0]!)).toHaveLength(2)
    expect(sessionPreviewLines(sessions[0]!, text(sessions[0]!, { user_prompts: [] }))).toHaveLength(2)
  })

  test('sessionPreviewLines drops the provider prefix from the model', () => {
    const session = { ...sessions[0]!, provider: 'anthropic', model: 'claude' }
    expect(sessionPreviewLines(session)[1]).toStartWith('claude · ')
  })

  test('sessionPreviewLines falls back to the provider when no model is recorded', () => {
    const session = { ...sessions[0]!, provider: 'anthropic', model: '' }
    expect(sessionPreviewLines(session)[1]).toBe('anthropic · 3 turns · just now')
  })

  test('resume title stays free of implementation shortcuts', () => {
    expect(RESUME_SELECTOR_TITLE).toBe('Sessions')
  })

  test('sanitizeSessionTitle hides compaction boilerplate titles', () => {
    // Full message form, as persisted by an older release.
    expect(sanitizeSessionTitle(
      'The conversation history before this point was compacted into the following summary:\n\nstuff',
    )).toBe('(compacted)')
    // Title already truncated mid-prefix by the 40-char head budget.
    expect(sanitizeSessionTitle('The conversation history before this poi.. … continue')).toBe('(compacted)')
    expect(COMPACT_SUMMARY_PREFIX).toBe('The conversation history before this')
  })

  test('sanitizeSessionTitle passes through real titles and fills empties', () => {
    expect(sanitizeSessionTitle('fix the resume selector')).toBe('fix the resume selector')
    expect(sanitizeSessionTitle('')).toBe('(untitled)')
    expect(sanitizeSessionTitle(undefined)).toBe('(untitled)')
    expect(sanitizeSessionTitle(null)).toBe('(untitled)')
  })

  test('applySessionText fills the focused row and leaves its neighbours alone', () => {
    const items = formatSessionItems(sessions, '/work')
    const loaded = text(sessions[0]!, {
      search_text: 'full body',
      first_prompt: 'ask',
      user_prompts: ['ask', 'later'],
      changed_paths: ['cli/src/term/repl.ts'],
    })
    const patched = applySessionText(items[1]!, loaded, '/work')

    expect(patched.searchText).toContain('full body')
    expect(patched.preview).toContain('# Started with')
    expect(patched.preview).toContain('\u203a ask')
    expect(patched.preview).toContain('# Latest')
    expect(patched.preview).toContain('\u203a later')
    expect(patched.preview).toContain('# Changed 1 file')
    expect(patched.preview).toContain('  repl.ts')
    // Identity is preserved so the selector's caches stay keyed on this row.
    expect(patched.id).toBe(items[1]!.id)
    expect(patched.label).toBe(items[1]!.label)
    expect(patched.detail).toBe(items[1]!.detail)
  })

  test('applySessionText shows the cwd only for a session from another directory', () => {
    const items = formatSessionItems(sessions, '/work')
    const other = applySessionText(items[3]!, text(sessions[1]!, { user_prompts: ['ask'] }), '/work')
    expect(other.preview?.[1]).toEndWith(' \u00b7 /other')
  })

  test('selectorReplaceItem updates both visible and unfiltered pools', () => {
    const items = formatSessionItems(sessions, '/work')
    const state = createSelectorState('Resume session', items)
    const nextItem = { ...items[1]!, preview: ['filled'] }
    const next = selectorReplaceItem(state, sessions[0]!.session_id, nextItem)
    expect(next.items[1]!.preview).toEqual(['filled'])
    expect(next.allItems[1]!.preview).toEqual(['filled'])
  })

  test('the session this REPL is in says so instead of its age', () => {
    const items = formatSessionItems(sessions, '/work', () => undefined, sessions[0]!.session_id)
    const open = items.find(item => item.id === sessions[0]!.session_id)!
    const other = items.find(item => item.id === sessions[1]!.session_id)!
    expect(open.status).toEqual({ text: '● open', tone: 'active' })
    expect(other.status?.text).not.toContain('● open')
    expect(open.preview?.[1]).toContain('this session')
    expect(other.preview?.[1]).not.toContain('this session')
  })

})
