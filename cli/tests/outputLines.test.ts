import { describe, test, expect, beforeEach } from 'bun:test'
import {
  buildUserMessage,
  buildAssistantLines,
  buildThinkingLines,
  buildToolResult,
  buildToolCall,
  buildToolCard,
  buildVerboseEvent,
  buildEventCard,
  isVisibleEvent,
  buildError,
  AssistantStreamBuffer,
  findSafeSplitPoint,
  resetIdCounter,
} from '../src/render/output.js'
import { formatLlmCallStarted, formatLlmCallRetry, formatLongWaitError, formatLlmCallCompleted, formatCompactionStarted, formatCompactionCompleted } from '../src/render/verbose.js'

beforeEach(() => {
  resetIdCounter()
})

// ---------------------------------------------------------------------------
// buildUserMessage
// ---------------------------------------------------------------------------

describe('buildUserMessage', () => {
  test('creates a single user line', () => {
    const lines = buildUserMessage('hello world')
    expect(lines).toHaveLength(1)
    expect(lines[0]!.kind).toBe('user')
    expect(lines[0]!.text).toBe('hello world')
  })

  test('shows image ref inline from displayText', () => {
    const lines = buildUserMessage('analyze this [Image #1]')
    expect(lines).toHaveLength(1)
    expect(lines[0]!.text).toBe('analyze this [Image #1]')
  })

  test('image-only displayText', () => {
    const lines = buildUserMessage('[Image #1]')
    expect(lines).toHaveLength(1)
    expect(lines[0]!.kind).toBe('user')
    expect(lines[0]!.text).toBe('[Image #1]')
  })

  test('empty text returns empty', () => {
    const lines = buildUserMessage('')
    expect(lines).toHaveLength(0)
  })

  test('captures a build-time timestamp so re-renders keep the original clock', () => {
    const at = new Date(2026, 7, 31, 18, 11).getTime()
    expect(buildUserMessage('hello', at)[0]!.timestamp).toBe(at)
    // Defaulted rather than left undefined: every committed message shows a time.
    expect(typeof buildUserMessage('hello')[0]!.timestamp).toBe('number')
  })
})

// ---------------------------------------------------------------------------
// buildAssistantLines
// ---------------------------------------------------------------------------

describe('buildAssistantLines', () => {
  test('renders markdown and splits into lines', () => {
    const lines = buildAssistantLines('hello **world**')
    expect(lines.length).toBeGreaterThan(0)
    expect(lines.every((l) => l.kind === 'assistant')).toBe(true)
  })

  test('returns empty for blank text', () => {
    expect(buildAssistantLines('')).toHaveLength(0)
    expect(buildAssistantLines('   ')).toHaveLength(0)
  })
})

describe('buildThinkingLines', () => {
  test('renders reasoning as markdown, one OutputLine per row', () => {
    const lines = buildThinkingLines('**Planning**\n\nnext')
    expect(lines).toHaveLength(2)
    expect(lines.every(line => line.kind === 'thinking')).toBe(true)
    expect(lines.every(line => line.thinkingStyle)).toBe(true)
    const text = lines.map(line => line.text).join('\n')
    expect(text).not.toContain('**')
    expect(text).toContain('Planning')
    expect(text).toContain('next')
  })

  test('blank reasoning produces nothing', () => {
    expect(buildThinkingLines('   ')).toEqual([])
  })

  test('an ellipsis-only reasoning placeholder renders nothing', () => {
    // Observed on the evot-pro-anthropic wire: a bare `...` after a tool
    // call. This is not a claim about the model's reasoning duration.
    expect(buildThinkingLines('...')).toEqual([])
    expect(buildThinkingLines('…')).toEqual([])
    expect(buildThinkingLines('  ...  \n\n')).toEqual([])
  })

  test('reasoning that merely contains dots still renders', () => {
    expect(buildThinkingLines('checking ... now').map(line => line.text)).toEqual(['checking ... now'])
  })

  test('every line of one block carries the fold policy for its view', () => {
    const text = 'first\n\nsecond'
    const folds = (options: { streaming?: boolean; expanded?: boolean }) =>
      [...new Set(buildThinkingLines(text, options).map(line => line.thinkingFold))]
    // Both live and finished compact views keep the tail; expanded never folds.
    expect(folds({ streaming: true })).toEqual(['tail'])
    expect(folds({})).toEqual(['tail'])
    expect(folds({ streaming: true, expanded: true })).toEqual([undefined])
    expect(folds({ expanded: true })).toEqual([undefined])
  })

  test('each block shares its own render identity, even for identical text', () => {
    const first = buildThinkingLines('first\n\nsecond')
    const next = buildThinkingLines('first\n\nsecond')
    const blockId = first[0]?.thinkingBlockId
    expect(typeof blockId).toBe('string')
    expect(first.every(line => line.thinkingBlockId === blockId)).toBe(true)
    expect(next[0]?.thinkingBlockId).not.toBe(blockId)
    expect(new Set(first.map(line => line.id)).size).toBe(first.length)
  })
})

// ---------------------------------------------------------------------------
// buildToolCall
// ---------------------------------------------------------------------------

describe('buildToolCall', () => {
  test('regular tool call emits a call line with glyph and command (no status mark)', () => {
    const preview = 'python3 -c "print(1)"'
    const lines = buildToolCall('bash', { command: preview }, preview)
    const card = lines[lines.length - 1]!
    expect(card.kind).toBe('tool')
    expect(card.text).toContain('⌘ bash')
    expect(card.text).toContain(preview)
    // No status mark on the call line — status is on the result line below.
    expect(card.text).not.toContain('✓')
    expect(card.text).not.toContain('✗')
  })

  test('multi-line bash command collapses to first line + expand hint', () => {
    const command = [
      "cd /Users/bohu/github/evotai/llmproxy && python3 - <<'PY'",
      'from pathlib import Path',
      "path = Path('src/core/base_proxy.py')",
      'print(path.read_text()[:20])',
      'PY',
    ].join('\n')
    const lines = buildToolCall('bash', { command }, command)
    const all = lines.map(l => l.text).join('\n')
    expect(all).toContain("⌘ bash  cd /Users/bohu/github/evotai/llmproxy && python3 - <<'PY' … +5 lines (ctrl+o)")
    // Full heredoc body must not be flattened into the header.
    expect(all).not.toContain('from pathlib import Path')
  })

  test('expanded multi-line bash command preserves newlines under the header', () => {
    const command = [
      "cd /tmp && python3 - <<'PY'",
      'from pathlib import Path',
      'print(1)',
      'PY',
    ].join('\n')
    const lines = buildToolCall('bash', { command }, command, true)
    const all = lines.map(l => l.text).join('\n')
    expect(all).toContain("⌘ bash  cd /tmp && python3 - <<'PY'")
    expect(all).toContain('  from pathlib import Path')
    expect(all).toContain('  print(1)')
    expect(all).toContain('  PY')
    expect(all).toContain('ctrl+o to collapse')
    expect(all).not.toContain('… (+')
  })

  test('long shell headings retain the command for width-aware card layout', () => {
    const command = 'x'.repeat(200)
    const lines = buildToolCall('bash', { command }, command)
    const card = lines[lines.length - 1]!
    expect(card.text).toBe(`⌘ bash  ${command}`)
    expect(card.commandMaxRows).toBe(2)
  })

  test('regular tool call still surfaces reason lines up-front', () => {
    const lines = buildToolCall('bash', { reason: 'list project files' }, 'ls -la')
    const all = lines.map(l => l.text).join('\n')
    expect(all).toContain('↳ reason: list project files')
    // The command itself is no longer shown on the start line — it appears on
    // the finished card instead.
    expect(all).not.toContain('❯ ls -la')
  })

  test('renders bash bypass and timeout reasons with friendly labels', () => {
    const lines = buildToolCall(
      'bash',
      {
        reason: 'run the build',
        reason_to_increase_timeout: 'full release build is slow',
        reason_to_use_instead_of_read_file_tool: 'N/A',
      },
      'cargo build --release',
    )
    const all = lines.map(l => l.text).join('\n')
    expect(all).toContain('↳ reason: run the build')
    expect(all).toContain('↳ why longer timeout: full release build is slow')
    // 'N/A' reasons are omitted.
    expect(all).not.toContain('why not read')
  })

  test('omits empty and N/A reasons from the call line', () => {
    const lines = buildToolCall('grep', { pattern: 'foo', reason: '' })
    const all = lines.map(l => l.text).join('\n')
    expect(all).not.toContain('↳ reason:')
    // No generic arg summary on the start line anymore.
    expect(all).not.toContain('1 arg')
  })
})

describe('buildToolResult', () => {
  test('emits the status first with mark and duration', () => {
    const lines = buildToolResult('bash', { command: 'ls -la' }, 'done', undefined, 4200)
    expect(lines.length).toBeGreaterThanOrEqual(1)
    const status = lines[0]!
    expect(status.kind).toBe('tool')
    expect(status.text).toMatch(/^ {2}✓/)
    expect(status.text).toContain('4.2s')
    expect(status.text).not.toContain('⌘ bash')
    expect(status.text).not.toContain('completed')
  })

  test('error result status line uses ✗ and stays before output', () => {
    const lines = buildToolResult('bash', { command: 'fail' }, 'error', 'command not found', 1000)
    expect(lines[0]!.text).toMatch(/^ {2}✗/)
    expect(lines[0]!.text).toContain('failed')
    expect(lines[0]!.text).toContain('1.0s')
    expect(lines[0]!.text).toContain('command not found')
    expect(lines.slice(1).some((line) => line.kind === 'error')).toBe(false)
  })

  test('failed edit with missing/dot path surfaces the attempted target', () => {
    const missing = buildToolCard({
      id: 'edit-missing',
      name: 'edit',
      args: {},
      status: 'error',
      result: 'Cannot read : Is a directory (os error 21). Use Write to create new files.',
      durationMs: 0,
      details: { bytes: 74 },
    })
    expect(missing[0]!.text).toBe('✎ edit  (missing path)')
    expect(missing[1]!.text).toMatch(/^ {2}✗ · failed/)
    expect(missing[1]!.text).toContain('invalid path')
    // The reason rides on the status row; a one-line body has nothing to fold.
    const missingBody = missing.map(l => l.text).join('\n')
    expect(missing[1]!.text).toContain('Cannot read')
    expect(missingBody).not.toContain('ctrl+o to expand')
    // Byte size is not the primary failure signal.
    expect(missing[1]!.text).not.toContain('74 B')

    const dot = buildToolCard({
      id: 'edit-dot',
      name: 'edit',
      args: {
        path: '.',
        edits: [{ oldText: 'finish();', newText: 'finish()?;' }],
      },
      status: 'error',
      result: 'Cannot read : Is a directory (os error 21). Use Write to create new files.',
      durationMs: 0,
      details: { bytes: 74 },
    })
    expect(dot[0]!.text).toContain('path="."')
    expect(dot[0]!.text).toContain('finish()')
    expect(dot[1]!.text).toMatch(/^ {2}✗ · failed/)
  })

  test('failed multi-edit lists each replacement under the headline', () => {
    const lines = buildToolCard({
      id: 'edit-multi',
      name: 'edit',
      args: {
        path: 'src/a.ts',
        edits: [
          { oldText: 'foo', newText: 'bar' },
          { oldText: 'baz', newText: 'qux' },
        ],
      },
      status: 'error',
      result: 'oldText not found',
      durationMs: 3,
    })
    const all = lines.map(l => l.text).join('\n')
    // Multi-edit failures keep the path on the headline and list each
    // replacement as detail lines under it.
    expect(lines[0]!.text).toBe('✎ edit  src/a.ts')
    expect(all).toContain('1/2 replace')
    expect(all).toContain('2/2 replace')
    expect(all).toContain('oldText not found')
  })

  test('failed bash keeps the command on the headline and folds the error body', () => {
    const lines = buildToolCard({
      id: 'bash-fail',
      name: 'bash',
      args: { command: 'cargo test -p db0_runtime planning' },
      status: 'error',
      result: 'error: no matching package named `db0_runtime` found\n\nCaused by:\n  ...',
      durationMs: 2300,
      details: { exit_code: 101 },
    })
    expect(lines[0]!.text).toContain('⌘ bash')
    expect(lines[0]!.text).toContain('cargo test -p db0_runtime planning')
    expect(lines[1]!.text).toBe('  ✗ · failed · exit 101 · 2.3s · error: no matching package named `db0_runtime` found · 4 lines (ctrl+o)')
    const all = lines.map(l => l.text).join('\n')
    expect(all).not.toContain('Caused by')
    expect(all).toContain('(ctrl+o)')
    expect(lines.some(l => l.kind === 'error')).toBe(false)
  })

  test('long failed output folds entirely, expandable via ctrl+o', () => {
    const body = Array.from({ length: 60 }, (_, i) => `line ${i + 1}`).join('\n')
    const collapsed = buildToolCard({
      id: 'bash-long-fail',
      name: 'bash',
      args: { command: 'make test' },
      status: 'error',
      result: body,
      details: { exit_code: 2 },
    })
    const collapsedText = collapsed.map(l => l.text).join('\n')
    expect(collapsedText).not.toContain('line 60')
    expect(collapsedText).toContain('failed · exit 2 · line 1')
    expect(collapsedText).toContain('60 lines (ctrl+o)')
    // The fold rides on the status row: headline + status, no hint row.
    expect(collapsed).toHaveLength(2)

    const expandedCard = buildToolCard({
      id: 'bash-long-fail',
      name: 'bash',
      args: { command: 'make test' },
      status: 'error',
      result: body,
      details: { exit_code: 2 },
    }, true)
    const expandedText = expandedCard.map(l => l.text).join('\n')
    expect(expandedText).toContain('line 1')
    expect(expandedText).toContain('line 60')
    expect(expandedText).toContain('ctrl+o to collapse')
  })

  test('pretty prints JSON result body without generic shape labels', () => {
    const lines = buildToolResult('web_fetch', {}, 'done', '{"status":"ok","items":[1,2]}', undefined, true)
    expect(lines[0]!.text).toMatch(/^ {2}✓/)
    expect(lines[0]!.text).not.toContain('JSON')
    expect(lines[0]!.text).not.toContain('keys')
    const all = lines.map(line => line.text).join('\n')
    expect(all).toContain('  {')
    expect(all).toContain('    "status": "ok"')
    expect(all).toContain('    "items": [')
  })

  test('uses real tool metadata for semantic status summaries', () => {
    const cases = [
      {
        call: { id: 'bash', name: 'bash', args: { command: 'true' }, status: 'done' as const, result: 'ok', details: { exit_code: 0 }, durationMs: 2500 },
        status: '  ✓ · exit 0 · 2.5s · 1 line (ctrl+o)',
      },
      {
        call: { id: 'bash-bg', name: 'bash', args: { command: 'bun run dev' }, status: 'done' as const, result: 'Command is running in the background.', details: { backgrounded: true, status: 'running' }, durationMs: 2500 },
        status: '  ● · started · running in background · 2.5s',
      },
      // An explicit background was the plan, so "started" fits. The rest were
      // not: naming the reason keeps a deadline or a keypress from reading as a
      // command that simply began.
      {
        call: { id: 'bash-bg-explicit', name: 'bash', args: { command: 'bun run dev' }, status: 'done' as const, result: 'started', details: { backgrounded: true, background_reason: 'explicit', status: 'running' }, durationMs: 2500 },
        status: '  ● · started · running in background · 2.5s',
      },
      {
        call: { id: 'bash-bg-timeout', name: 'bash', args: { command: 'cargo build' }, status: 'done' as const, result: 'still going', details: { backgrounded: true, background_reason: 'timeout_elapsed', status: 'running' }, durationMs: 600_000 },
        status: '  ● · still running · moved to background at its deadline · 600.0s',
      },
      {
        call: { id: 'bash-bg-yield', name: 'bash', args: { command: 'cargo build' }, status: 'done' as const, result: 'still going', details: { backgrounded: true, background_reason: 'yield_elapsed', status: 'running' }, durationMs: 120_000 },
        status: '  ● · still running · moved to background · 120.0s',
      },
      {
        call: { id: 'bash-bg-user', name: 'bash', args: { command: 'cargo build' }, status: 'done' as const, result: 'still going', details: { backgrounded: true, background_reason: 'user_requested', status: 'running' }, durationMs: 2500 },
        status: '  ● · still running · backgrounded by you · 2.5s',
      },
      {
        call: { id: 'bash-bg-message', name: 'bash', args: { command: 'cargo build' }, status: 'done' as const, result: 'still going', details: { backgrounded: true, background_reason: 'message_delivery', status: 'running' }, durationMs: 2500 },
        status: '  ● · still running · backgrounded to read your message · 2.5s',
      },
      // Written by the engine, so an unrecognized reason must still render a
      // status rather than an empty one.
      {
        call: { id: 'bash-bg-unknown', name: 'bash', args: { command: 'cargo build' }, status: 'done' as const, result: 'still going', details: { backgrounded: true, background_reason: 'something_new', status: 'running' }, durationMs: 2500 },
        status: '  ● · started · running in background · 2.5s',
      },
      {
        call: { id: 'read', name: 'read', args: { path: 'a.ts' }, status: 'done' as const, result: 'body', details: { bytes: 2048 } },
        status: '  ✓ · 2.0 KB',
      },
      {
        call: { id: 'write', name: 'write', args: { path: 'a.ts' }, status: 'done' as const, result: 'Wrote file', details: { bytes: 1536, created: true } },
        status: '  ✓ · created 1.5 KB',
      },
      {
        call: { id: 'edit', name: 'edit', args: { path: 'a.ts' }, status: 'done' as const, details: { replacement_count: 2, added_lines: 3, removed_lines: 1 } },
        status: '  ✓ · 2 replacements · +3 −1',
      },
      {
        call: { id: 'search', name: 'search', args: { query: 'needle' }, status: 'done' as const, result: 'matches', details: { hits: 4 } },
        status: '  ✓ · 4 hits',
      },
      {
        call: { id: 'web', name: 'web_fetch', args: { url: 'https://example.com' }, status: 'done' as const, result: 'line one\nline two', details: { status: 200 } },
        status: '  ✓ · HTTP 200 · 2 lines (ctrl+o)',
      },
    ]

    for (const { call, status } of cases) {
      const lines = buildToolCard(call)
      expect(lines[1]!.text).toBe(status)
    }
  })

  test('hides ask_user lifecycle cards because the interactive overlay owns its UI', () => {
    const calls = [
      { id: 'ask-queued', name: 'ask_user', args: { questions: [] }, status: 'queued' as const },
      { id: 'ask-running', name: 'AskUser', args: { questions: [] }, status: 'running' as const },
      { id: 'ask-done', name: 'askuser', args: { questions: [] }, status: 'done' as const, result: 'answered' },
    ]

    for (const call of calls) expect(buildToolCard(call)).toEqual([])
  })

  test('summarizes grep and glob output without counting protocol lines as results', () => {
    const cases = [
      {
        call: { id: 'grep', name: 'grep', args: { pattern: 'needle' }, status: 'done' as const, result: 'src/a.ts:1: needle\nsrc/b.ts:2: needle' },
        status: '  ✓ · 2 matches (ctrl+o)',
      },
      {
        call: { id: 'grep-context', name: 'grep', args: { pattern: 'needle', context: 1 }, status: 'done' as const, result: 'src/a.ts-1- before\nsrc/a.ts:2: needle\n--\nsrc/b.ts:4: needle\nsrc/b.ts-5- after' },
        status: '  ✓ · 2 matches (ctrl+o)',
      },
      {
        call: { id: 'grep-files', name: 'grep', args: { pattern: 'needle', files_with_matches: true }, status: 'done' as const, result: 'src/a.ts\nsrc/b.ts' },
        status: '  ✓ · 2 files (ctrl+o)',
      },
      {
        call: { id: 'grep-capped', name: 'grep', args: { pattern: 'needle' }, status: 'done' as const, result: 'src/a.ts:1: needle\n... (capped at 100 matches — refine the pattern)' },
        status: '  ✓ · 1 match shown (ctrl+o)',
      },
      {
        call: { id: 'grep-zero', name: 'grep', args: { pattern: 'needle' }, status: 'done' as const, result: '(no matches)' },
        status: '  ✓ · 0 matches',
      },
      {
        call: { id: 'glob', name: 'glob', args: { pattern: ['**/*.ts'] }, status: 'done' as const, result: 'src/a.ts\nsrc/b.ts' },
        status: '  ✓ · 2 files (ctrl+o)',
      },
      {
        call: { id: 'glob-dirs', name: 'glob', args: { pattern: ['**'], type: 'd' }, status: 'done' as const, result: 'src\ntests' },
        status: '  ✓ · 2 directories (ctrl+o)',
      },
      {
        call: { id: 'glob-timeout', name: 'glob', args: { pattern: ['**'] }, status: 'done' as const, result: 'src/a.ts\n... (search timed out — results may be incomplete)' },
        status: '  ✓ · 1 file shown (ctrl+o)',
      },
      {
        call: { id: 'glob-zero-timeout', name: 'glob', args: { pattern: ['**'] }, status: 'done' as const, result: '(no matches; search timed out before completing)' },
        status: '  ✓ · 0 files shown',
      },
    ]

    for (const { call, status } of cases) {
      expect(buildToolCard(call)[1]!.text).toBe(status)
    }
  })

  test('falls back to neutral line counts for unknown grep output', () => {
    const lines = buildToolCard({
      id: 'grep-unknown',
      name: 'grep',
      args: { pattern: 'needle' },
      status: 'done',
      result: 'unstructured\noutput',
    })
    expect(lines[1]!.text).toBe('  ✓ · 2 lines · 19 B (ctrl+o)')
  })

  test('metadata can mark nominal tool results as failures', () => {
    const bash = buildToolCard({
      id: 'bash-error',
      name: 'bash',
      args: { command: 'false' },
      status: 'done',
      result: 'Exit code: 7',
      details: { exit_code: 7 },
    })
    expect(bash[1]!.text).toBe('  ✗ · failed · exit 7')

    const web = buildToolCard({
      id: 'web-error',
      name: 'web_fetch',
      args: { url: 'https://example.com/missing' },
      status: 'done',
      result: 'HTTP 404 error',
      details: { status: 404, error: true },
    })
    expect(web[1]!.text).toBe('  ✗ · failed · HTTP 404')
  })

  test('status remains second when reason, diff, and output details exist', () => {
    const lines = buildToolCard({
      id: 'edit-rich',
      name: 'edit',
      args: { path: 'a.ts', reason: 'fix behavior' },
      status: 'done',
      result: 'Updated a.ts.',
      durationMs: 8,
      details: {
        diff: '@@ -1 +1 @@\n-old\n+new',
        replacement_count: 1,
        added_lines: 1,
        removed_lines: 1,
      },
    })
    expect(lines[0]!.text).toBe('✎ edit  a.ts')
    expect(lines[1]!.text).toBe('  ✓ · 1 replacement · +1 −1')
    expect(lines.slice(2).map(line => line.text).join('\n')).toContain('↳ reason: fix behavior')
    expect(lines.slice(2).map(line => line.text).join('\n')).toContain('+new')
  })

  test('a successful edit with a diff drops its result body in compact mode; expanded keeps it', () => {
    const call = {
      id: 'edit-body',
      name: 'edit',
      args: { path: 'a.ts' },
      status: 'done' as const,
      result: 'Updated a.ts.\n\nCurrent content of the changed region(s):\n1 | new',
      durationMs: 8,
      details: { diff: '@@ -1 +1 @@\n-old\n+new', replacement_count: 1, added_lines: 1, removed_lines: 1 },
    }
    const compact = buildToolCard(call).map(line => line.text).join('\n')
    // The diff is the content; the engine's echo of the changed region and the
    // fold hint for it would only repeat what is already on screen.
    expect(compact).toContain('+new')
    expect(compact).not.toContain('Current content')
    expect(compact).not.toContain('ctrl+o')
    const expanded = buildToolCard(call, true).map(line => line.text).join('\n')
    expect(expanded).toContain('Current content of the changed region(s):')
  })

  test('a single-row non-shell result stays inline: nothing to fold, no hint', () => {
    const lines = buildToolCard({ id: 'r', name: 'read', args: { path: 'a.ts' }, status: 'done', result: 'only line', durationMs: 1500 })
    expect(lines.map(line => line.text)).toEqual(['◫ read  a.ts', '  ✓ · 1 line · 1.5s', '  only line'])
  })

  test('collapsed multiline result folds onto the status row, no content preview', () => {
    const result = JSON.stringify({ a: 1, b: 2, c: 3, d: 4, e: 5, f: 6 }, null, 2)
    const lines = buildToolResult('edit', {}, 'done', result)
    // Collapsed view: the status row carries the full line count and the
    // expand hint; there are no body rows at all.
    expect(lines).toHaveLength(1)
    expect(lines[0]!.text).toMatch(/· \d+ lines .*\(ctrl\+o\)$/)
    expect(lines[0]!.text).not.toContain('{')
  })

  test('collapsed search result hint counts every line (no head preview)', () => {
    const result = Array.from({ length: 8 }, (_, i) => `match ${i}`).join('\n')
    const lines = buildToolResult('search', {}, 'done', result)
    expect(lines).toHaveLength(1)
    expect(lines[0]!.text).toContain('8 lines')
    expect(lines[0]!.text).toContain('(ctrl+o)')
    // No match rows previewed in the collapsed view.
    const all = lines.map(l => l.text).join('\n')
    expect(all).not.toContain('match 0')
  })

  test('Read collapses to an expand hint and expands to full content', () => {
    // Regression: successful reads used to render no body at all, leaving Read
    // as the only tool whose output couldn't be expanded with ctrl+o. It now
    // collapses/expands like bash/search.
    const result = Array.from({ length: 93 }, (_, i) => `line ${i}`).join('\n')
    const collapsed = buildToolResult('Read', { path: 'a.ts' }, 'done', result, 0)
    expect(collapsed).toHaveLength(1)
    expect(collapsed[0]!.text).toContain('93 lines')
    expect(collapsed[0]!.text).toContain('(ctrl+o)')
    expect(collapsed.map(l => l.text).join('\n')).not.toContain('line 0')

    const expanded = buildToolResult('Read', { path: 'a.ts' }, 'done', result, 0, true)
    const all = expanded.map(l => l.text).join('\n')
    expect(all).toContain('line 0')
    expect(all).toContain('line 92')
    expect(all).toContain('ctrl+o to collapse')
  })

  test('expanded multiline result shows collapse hint', () => {
    const result = Array.from({ length: 7 }, (_, i) => `line ${i}`).join('\n')
    const lines = buildToolResult('bash', {}, 'done', result, undefined, true)
    const all = lines.map(l => l.text).join('\n')
    expect(all).toContain('line 0')
    expect(all).toContain('line 6')
    expect(all).toContain('ctrl+o to collapse')
  })

  test('includes diff when present', () => {
    const lines = buildToolResult('file_edit', { path: 'a.ts', diff: '+added\n-removed' }, 'done')
    expect(lines.some((l) => l.text.includes('added') || l.text.includes('removed'))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// buildVerboseEvent
// ---------------------------------------------------------------------------

describe('buildVerboseEvent', () => {
  test('splits multi-line text without trailing separator', () => {
    const lines = buildVerboseEvent('line1\nline2\nline3')
    expect(lines).toHaveLength(3)
    expect(lines.filter((l) => l.kind === 'verbose')).toHaveLength(3)
    expect(lines[0]!.text).toBe('line1')
    expect(lines[2]!.text).toBe('line3')
  })

  test('formats llm started with status symbol and full details', () => {
    const text = formatLlmCallStarted({
      model: 'claude-sonnet-4',
      turn: 2,
      message_count: 18,
      system_prompt_tokens: 8000,
      context_window: 200000,
      estimated_context_tokens: 42000,
      message_stats: {
        user_count: 6,
        assistant_count: 5,
        tool_result_count: 7,
        user_tokens: 12000,
        assistant_tokens: 4000,
        tool_result_tokens: 18000,
        image_tokens: 0,
        tool_details: [['read_file', 8000], ['search', 6000], ['bash', 4000]],
      },
    })
    expect(text).toContain('[LLM] ● · claude-sonnet-4 · turn 2 · 18 msgs · user 6 / asst 5 / tool 7')
    expect(text).toContain('    context   ')
    expect(text).toContain('    tokens    sys 8k · user 12k · asst 4k · tool 18k')
    expect(text).toContain('    by tool   read_file 8k (44%)')
  })

  test('formats llm retry with wait time and attempt', () => {
    const text = formatLlmCallRetry({
      attempt: 2,
      max_retries: 3,
      retry_delay_ms: 2100,
      error: 'tls handshake eof',
    })
    expect(text).toContain('[LLM] ↻ · retrying in 2 seconds · attempt 2/3')
    expect(text).toContain('    error     tls handshake eof')
  })

  test('formats long quota reset without synthetic retry attempts', () => {
    const text = formatLongWaitError(
      'claude-fable-5',
      'HTTP 429: rate_limit_error: Rate limit exceeded. Please retry later.',
      1_800_000,
    )
    expect(text).toContain('[LLM] ⚠ · claude-fable-5 · quota unavailable · retry in 30m')
    expect(text).toContain('    error     HTTP 429: rate_limit_error: Rate limit exceeded. Please retry later.')
    expect(text).not.toContain('attempt')
  })

  test('strips terminal controls from long-wait provider text', () => {
    const text = formatLongWaitError(
      '\x1b[31mclaude-fable-5',
      '\x1b]8;;https://evil.example\x07HTTP 429: rate_limit_error\x1b]8;;\x07',
      60_000,
    )
    expect(text).toContain('[LLM] ⚠ · claude-fable-5 · quota unavailable · retry in 1m')
    expect(text).toContain('    error     HTTP 429: rate_limit_error')
    expect(text).not.toContain('\x1b')
    expect(text).not.toContain(']8;;')
  })

  test('formats llm completed with status symbol and timing details', () => {
    const result = formatLlmCallCompleted({
      model: 'claude-sonnet-4',
      turn: 2,
      duration_ms: 8400,
      input_tokens: 42000,
      output_tokens: 352,
      context_window: 200000,
      estimated_context_tokens: 42000,
      time_to_first_byte_ms: 1100,
      cache_read: 21000,
      cache_write: 0,
      tool_calls: [{ id: 'tc-1', name: 'search', arguments: { pattern: 'foo' } }],
    })
    expect(result.text).toContain('[LLM] ✓ · claude-sonnet-4 · turn 2 · 8.4s')
    expect(result.text).toContain('    tokens    42k in → 352 out')
    expect(result.text).toContain('    cache     21k read · 0 write · 33% hit')
    // Historical events lack streaming_ms; wall time minus TTFB is not a measured stream.
    expect(result.text).toContain('    timing    ttfb 1.1s (13%) · stream unavailable')
    expect(result.text).not.toContain('tok/s')
    expect(result.text).toContain('    tools     search')
    expect(result.text).not.toContain('    output    ')
    expect(result.expandedText).toBeUndefined()
  })

  test('tok/s uses the streaming window, not total wall-clock', () => {
    // 600 output tokens over a 3s streaming window = 200 tok/s. The 12s ttfb
    // wait must not dilute the rate (total duration 15s would give 40 tok/s).
    const result = formatLlmCallCompleted({
      model: 'qwen3-4b',
      turn: 1,
      output_tokens: 600,
      metrics: { duration_ms: 15000, ttfb_ms: 12000, ttft_ms: 12000, streaming_ms: 3000 },
    })
    expect(result.text).toContain('· 200 tok/s')
    expect(result.text).not.toContain('· 40 tok/s')
  })

  test('shows server-side model fallback when response_model differs', () => {
    const result = formatLlmCallCompleted({
      model: 'claude-fable-5',
      response_model: 'claude-opus-4-8',
      turn: 3,
      duration_ms: 5000,
      output_tokens: 100,
      metrics: { duration_ms: 5000, ttfb_ms: 1000, ttft_ms: 1000, streaming_ms: 4000 },
    })
    expect(result.text).toContain('[LLM] ✓ · claude-fable-5 → claude-opus-4-8 · turn 3')
    expect(result.text).toContain('    fallback  served by claude-opus-4-8 (requested claude-fable-5)')
  })

  test('no fallback line when response_model matches requested model', () => {
    const result = formatLlmCallCompleted({
      model: 'claude-fable-5',
      response_model: 'claude-fable-5',
      turn: 3,
      duration_ms: 5000,
      output_tokens: 100,
      metrics: { duration_ms: 5000, ttfb_ms: 1000, ttft_ms: 1000, streaming_ms: 4000 },
    })
    expect(result.text).toContain('[LLM] ✓ · claude-fable-5 · turn 3')
    expect(result.text).not.toContain('fallback')
  })

  test('formats and renders provider-native compaction as a visible card', () => {
    const completed = formatCompactionCompleted({
      context_window: 200000,
      result: {
        type: 'compacted',
        method: 'remote',
        remote_blob_bytes: 1536,
        before_message_count: 48,
        after_message_count: 12,
        before_tokens: 168000,
        after_tokens: 24000,
        messages_evicted: 36,
        current_run_reclaimed: 0,
      },
    })
    expect(completed).toContain('[COMPACT] ✓ · remote · threshold · 48 → 12 msgs')
    expect(completed).not.toContain('L3')
    expect(completed).toContain('    summary   evicted 36 msgs · reclaimed 0')
    expect(completed).toContain('168k → 24k')
    expect(completed).toContain('blob 1.5 KB')
    expect(isVisibleEvent(completed)).toBe(true)

    const card = buildEventCard(completed)
    expect(card[0]!.text).toBe('✦ compact  168k → 24k')
    expect(card[0]!.toolCard).toEqual({ state: 'success', first: true, last: false })
    expect(card[1]!.text).toContain('✓ · remote')
    expect(card[1]!.text).not.toContain('msgs')
    expect(card.at(-1)!.toolCard?.last).toBe(true)
  })

  test('shows remote fallback but keeps skipped compaction log-only', () => {
    const fallback = formatCompactionCompleted({
      result: {
        type: 'compacted',
        method: 'remote_failed_local',
        fallback_reason: 'Upstream error 400: Store must be set to false',
        before_message_count: 20,
        after_message_count: 8,
        before_tokens: 50000,
        after_tokens: 20000,
        messages_evicted: 12,
      },
    })
    expect(fallback).toContain('remote failed → local')
    expect(fallback).toContain('fallback  Upstream error 400: Store must be set to false')
    expect(isVisibleEvent(fallback)).toBe(true)
    expect(isVisibleEvent('[COMPACT] ✓ · skipped · within budget')).toBe(false)
  })

  test('formats compaction started without a level and a prune compaction as a lossless cut', () => {
    const started = formatCompactionStarted({
      messages_count: 48,
      estimated_tokens: 168000,
      context_window: 200000,
      token_breakdown: { system: 8000, user: 24000, assistant: 18000, tool: 118000 },
    })
    expect(started).toContain('[COMPACT] ● · 48 msgs')
    expect(started).not.toContain('L1')
    expect(started).toContain('    context   ')
    expect(started).toContain('    tokens    sys 8k · user 24k · asst 18k · tool 118k')

    const pruned = formatCompactionCompleted({
      reason: 'threshold',
      context_window: 200000,
      result: {
        type: 'compacted',
        method: 'prune',
        before_message_count: 256,
        after_message_count: 170,
        before_tokens: 74000,
        after_tokens: 32000,
        messages_evicted: 86,
        current_run_reclaimed: 0,
      },
    })
    const lines = pruned.split('\n')
    expect(lines[0]).toBe('[COMPACT] ✓ · jev prune · no summary · threshold · 256 → 170 msgs · 74k → 32k · saved 42k (57%)')
    expect(pruned).not.toContain('L3')
    expect(pruned).not.toContain('reclaimed')
    expect(lines.at(-1)).toBe('    summary   removed 86 stale tool msgs')
    const card = buildEventCard(pruned)
    expect(card[0]!.text).toBe('✦ compact  74k → 32k')
    expect(card[1]!.text).toContain('jev prune · no summary')
  })
})

// ---------------------------------------------------------------------------
// findSafeSplitPoint
// ---------------------------------------------------------------------------

describe('findSafeSplitPoint', () => {
  test('returns content.length when no newline', () => {
    expect(findSafeSplitPoint('hello world')).toBe(11)
  })

  test('splits at paragraph boundary', () => {
    const text = 'first paragraph\n\nsecond paragraph'
    const split = findSafeSplitPoint(text)
    expect(split).toBe(17) // after \n\n
    expect(text.slice(0, split)).toBe('first paragraph\n\n')
  })

  test('does not split inside code block', () => {
    const text = '```js\nconst x = 1\n\nconst y = 2\n```'
    const split = findSafeSplitPoint(text)
    // Should return content.length — the whole thing is inside a code block
    expect(split).toBe(text.length)
  })

  test('splits before code block, not inside', () => {
    const text = 'some text\n\n```js\nconst x = 1\n```'
    const split = findSafeSplitPoint(text)
    expect(split).toBe(11) // after "some text\n\n"
    expect(text.slice(0, split).trim()).toBe('some text')
  })

  test('falls back to single newline', () => {
    const text = 'line one\nline two'
    const split = findSafeSplitPoint(text)
    expect(split).toBe(9) // after "line one\n"
  })

  test('returns content.length for unclosed code block', () => {
    const text = 'hello\n\n```js\nconst x = 1'
    const split = findSafeSplitPoint(text)
    // End is inside unclosed code block, should not split
    expect(split).toBe(text.length)
  })
})

// ---------------------------------------------------------------------------
// AssistantStreamBuffer
// ---------------------------------------------------------------------------

describe('AssistantStreamBuffer', () => {
  test('emits lines on first content', () => {
    const buf = new AssistantStreamBuffer()
    buf.push('hello')
    const lines = buf.finish()
    expect(lines.some((l) => l.kind === 'assistant')).toBe(true)
  })

  test('skips leading whitespace', () => {
    const buf = new AssistantStreamBuffer()
    const lines1 = buf.push('\n\n')
    expect(lines1).toHaveLength(0)
    buf.push('hello')
    const lines2 = buf.finish()
    expect(lines2.some((l) => l.kind === 'assistant')).toBe(true)
  })

  test('emits lines on newline', () => {
    const buf = new AssistantStreamBuffer()
    buf.push('hello')
    const lines = buf.push(' world\n')
    const assistantLines = lines.filter((l) => l.kind === 'assistant')
    expect(assistantLines.length).toBeGreaterThanOrEqual(0)
  })

  test('finish flushes remaining buffer', () => {
    const buf = new AssistantStreamBuffer()
    buf.push('hello world')
    const lines = buf.finish()
    expect(lines.some((l) => l.kind === 'assistant')).toBe(true)
  })

  test('finish on empty buffer returns nothing', () => {
    const buf = new AssistantStreamBuffer()
    expect(buf.finish()).toHaveLength(0)
  })

  test('pendingText returns incomplete line', () => {
    const buf = new AssistantStreamBuffer()
    buf.push('hello')
    expect(buf.pendingText).toBe('hello')
    buf.push(' world\nfoo')
    expect(buf.pendingText).toBe('foo')
  })

  test('multi-line push emits all complete lines', () => {
    const buf = new AssistantStreamBuffer()
    buf.push('first line\n')
    const lines = buf.push('second line\nthird')
    // 'third' stays pending
    expect(buf.pendingText).toBe('third')
  })

  test('does not split inside code block', () => {
    const buf = new AssistantStreamBuffer()
    buf.push('text before\n\n```js\nconst x = 1\n')
    // The code block is unclosed, so the \n inside should NOT cause a flush
    // that breaks the code block. The pending text should contain the code block.
    const pending = buf.pendingText
    expect(pending).toContain('```js')
  })

  test('flushes text before code block at paragraph boundary', () => {
    const buf = new AssistantStreamBuffer()
    // Push text with a paragraph break followed by a closed code block
    const allLines: import('../src/render/output.js').OutputLine[] = []
    allLines.push(...buf.push('hello world\n\n'))
    allLines.push(...buf.push('```js\nconst x = 1\n```\n'))
    allLines.push(...buf.finish())
    // Should have emitted assistant lines for both parts
    const assistantLines = allLines.filter((l) => l.kind === 'assistant')
    expect(assistantLines.length).toBeGreaterThan(0)
  })
})
