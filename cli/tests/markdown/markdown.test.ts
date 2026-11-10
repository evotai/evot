import { describe, test, expect } from 'bun:test'
import { renderMarkdown, renderThinkingMarkdown } from '../../src/render/markdown.js'
import { formatToken } from '../../src/markdown/render/ansi.js'
import { getTheme, resetThemeCache } from '../../src/ui/theme/index.js'
import chalk from 'chalk'
import { marked, type Token } from 'marked'
import stripAnsi from 'strip-ansi'
import stringWidth from 'string-width'
import { withColumns } from '../helpers/stdout-columns.js'

// Helper: render markdown and strip ANSI codes for assertion
function render(md: string): string {
  return stripAnsi(renderMarkdown(md))
}

// Helper: assert every ``` fence sits alone on its line and is never glued to
// adjacent content. Code blocks now render WITH visible ```lang / ``` borders
// (aligned with pi), so the old `not.toContain('```')` proxy — which meant
// "the fence was consumed / didn't leak / didn't glue to a neighbor" — is
// expressed directly here: a fence line is exactly ``` optionally followed by a
// language tag, with nothing else on the line.
function fencesWellFormed(rendered: string): boolean {
  for (const line of rendered.split('\n')) {
    if (!line.includes('```')) continue
    if (!/^```[\w+-]*$/.test(line.trim())) return false
  }
  return true
}

// Helper: lex a single token from markdown
function lexFirst(md: string): Token {
  const tokens = marked.lexer(md)
  return tokens[0]!
}

describe('renderMarkdown', () => {
  test('keeps streamed thinking paragraph spacing stable as later blocks arrive', () => {
    const first = stripAnsi(renderThinkingMarkdown('**Planning**'))
    const second = stripAnsi(renderThinkingMarkdown('**Planning**\n\n<!-- -->\n\n**Designing**'))

    expect(first).toBe('Planning')
    expect(second).toBe('Planning\nDesigning')
    expect(second.split('\n')[0]).toBe(first)
  })

  test('thinking compaction removes only blank rows, not structural content', () => {
    const result = stripAnsi(renderThinkingMarkdown('Intro\n\n- one\n- two\n\n```text\nx\n```'))

    expect(result).toContain('Intro')
    expect(result).toContain('one')
    expect(result).toContain('two')
    expect(result).toContain('```')
    expect(result).toContain('x')
  })

  test('thinking headings keep a blank line above and below even in compact spacing', () => {
    const result = stripAnsi(renderThinkingMarkdown([
      '不用花里胡哨的',
      '### 当前设计的主要问题',
      '1. 协议分裂',
      '### 推荐的干净方案',
      '核心原则：',
      '#### 1. 定义稳定的 ChatNode',
      '```rust',
      'enum ChatEvent {}',
      '```',
    ].join('\n')))

    expect(result).toContain('不用花里胡哨的\n\n### 当前设计的主要问题\n\n1. 协议分裂')
    expect(result).toContain('1. 协议分裂\n\n### 推荐的干净方案\n\n核心原则：')
    expect(result).toContain('核心原则：\n\n#### 1. 定义稳定的 ChatNode\n\n```rust')
  })

  test('renders plain text', () => {
    expect(render('hello world')).toBe('hello world')
  })

  test('returns empty/whitespace input as-is', () => {
    expect(renderMarkdown('')).toBe('')
    expect(renderMarkdown('  ')).toBe('  ')
  })

  test('renders headings', () => {
    const result = render('# Title')
    expect(result).toContain('Title')
  })

  test('renders h2', () => {
    const result = render('## Subtitle')
    expect(result).toContain('Subtitle')
  })

  test('keeps the ### prefix for H3–H6, drops it for H1/H2 (pi-aligned)', () => {
    // H1/H2 are visually distinct via styling, but H3–H6 all render as plain
    // bold, so the hash prefix is what makes their levels distinguishable.
    expect(render('# H1')).not.toContain('# H1')
    expect(render('## H2')).not.toContain('## H2')
    expect(render('### H3')).toContain('### H3')
    expect(render('#### H4')).toContain('#### H4')
    expect(render('##### H5')).toContain('##### H5')
    expect(render('###### H6')).toContain('###### H6')
  })

  test('renders indented h3 headings', () => {
    const result = render('2 行 verbose，工具调用是视觉主体。\n\n  ### 改造后（ctrl+o 展开，和改造前等价）\n\n完全等于改造前的 11 行 — 数据一字不差。')

    // The indented `### ` is recognized as an H3 (not indented code). H3+ keeps
    // its `###` prefix (aligned with pi), but the source-line indent is dropped.
    expect(result).toContain('### 改造后（ctrl+o 展开，和改造前等价）')
    expect(result).not.toContain('  ### 改造后')
  })

  test('renders bold text', () => {
    const result = render('this is **bold** text')
    expect(result).toContain('bold')
  })

  test('does not rewrite emphasis-like text inside code fences', () => {
    const result = render('```text\nliteral **重要。**下一句\n```').replace(/\u200b/g, '')

    expect(result).toContain('literal **重要。**下一句')
    expect(result).not.toContain('<!-- -->')
  })

  test('renders italic text', () => {
    const result = render('this is *italic* text')
    expect(result).toContain('italic')
  })

  test('does not split emphasis after Chinese punctuation into a glued bullet', () => {
    const result = render('这是普通文本。**这是粗体文本**。*这是斜体文本*。')
      .replace(/\u200b/g, '')

    expect(result).toContain('这是普通文本。')
    expect(result).toContain('这是粗体文本')
    expect(result).toContain('这是斜体文本')
    expect(result).not.toContain('\n- 这是斜体文本')
  })

  test('renders inline code', () => {
    const result = render('use `foo()` here')
    expect(result).toContain('foo()')
  })

  test('renders unclosed code fence as code', () => {
    const result = render('```sql\nSELECT 1')
    expect(result).toContain('SELECT 1')
    expect(fencesWellFormed(result)).toBe(true)
  })

  test('renders markdown tables from decimal compatibility log as actual tables', () => {
    const result = render([
      '## Verification matrix',
      '',
      '| Client | Protocol | Focus | Risk |',
      '|---|---|---|---|',
      '| Java mariadb-java-client | MySQL | `ResultSet.getBigDecimal()` precision/scale | low |',
      '| Spark JDBC | MySQL JDBC | **DecimalType limit 38** | **high** |',
    ].join('\n')).replace(/\u200b/g, '')

    expect(result).toContain('Verification matrix')
    expect(result).toContain('┌')
    expect(result).toContain('Java')
    expect(result).toContain('mariadb-java-client')
    expect(result).toContain('Spark JDBC')
    expect(result).not.toContain('|---|---|---|---|')
  })

  test('preserves box-drawing conclusion tables from decimal compatibility log', () => {
    const result = render([
      'Final delivery table',
      '',
      '┌─────────────┬─────────────────────────────┬──────────┐',
      '│    Link     │         Driver              │ Result   │',
      '├─────────────┼─────────────────────────────┼──────────┤',
      '│ Java main   │ mariadb-java-client x.y.z   │ OK       │',
      '└─────────────┴─────────────────────────────┴──────────┘',
    ].join('\n'))

    expect(result).toContain('Final delivery table')
    expect(result).toContain('┌─────────────┬')
    expect(result).toContain('│ Java main   │ mariadb-java-client x.y.z   │ OK')
    // Box-drawing diagram art gets no fence (rendered as-is, not code).
    expect(result).not.toContain('```text')
  })

  test('fenced code blocks align with prose left padding', () => {
    const md = 'Before:\n```bash\nnpm install\n```\nAfter.'
    const result = render(md)
    expect(result).toMatch(/^  npm install$/m)
    // Must not leave literal box-drawing characters.
    expect(result).not.toContain('│')
  })

  test('code comments render as pure code lines', () => {
    const md = [
      '```bash',
      '# Run checks in parallel where possible',
      'cargo fmt --check &',
      '```',
    ].join('\n')
    const result = render(md)
    expect(result).toMatch(/^  # Run checks in parallel where possible$/m)
    expect(result).toMatch(/^  cargo fmt --check &$/m)
    expect(result).not.toContain('│')
  })

  test('aligns trailing SQL comments in fenced code blocks', () => {
    const restore = withColumns(100)
    try {
      const md = [
        '```sql',
        'CREATE TABLE tracelake.events (',
        '  id   STRING NOT NULL STATS_TRUNCATE_LEN 24,   -- 16 hex+ 裕量',
        '  trace_id   STRING NOT NULL STATS_TRUNCATE_LEN 40,    -- 32 hex + 裕量',
        '  parent_id  STRING DEFAULT \'\'STATS_TRUNCATE_LEN 24,',
        '  session_id STRING DEFAULT \'\'STATS_TRUNCATE_LEN 32,   -- session-xxxxxxxxxxxx',
        '  response_id     STRING DEFAULT \'\' STATS_TRUNCATE_LEN 48, -- "resp_" + 16 hex',
        ') CLUSTER BY (start_time, trace_id);',
        '```',
      ].join('\n')
      const result = render(md)
      const commentColumns = result
        .split('\n')
        .filter(line => line.includes('--'))
        .map(line => line.indexOf('--'))

      expect(new Set(commentColumns).size).toBe(1)
    } finally {
      restore()
    }
  })

  test('aligns standalone comments with nearby Python code indentation', () => {
    const restore = withColumns(100)
    try {
      const md = [
        '```python',
        'def generate_trace(profile: str, target_spans: int) -> Iterator[...]:',
        '      trace_id = rand_hex(32)                 # 32 hex → 128-bit',
        '      root_id = rand_hex(16)                  # 16 hex → 64-bit',
        '      # span:',
        '      "id":rand_hex(16),                      # 16 hex → 64-bit',
        '     # session_id: 自定义，非 OTel',
        '      session_id = f"session-{rand_hex(12)}"  # "session-xxxxxxxxxxxx" = 20 字符',
        '```',
      ].join('\n')
      const result = render(md)

      expect(result).toMatch(/^ {8}# span:$/m)
      expect(result).toMatch(/^ {8}# session_id: 自定义，非 OTel$/m)
    } finally {
      restore()
    }
  })

  test('JSON fenced code blocks are highlighted', () => {
    const prevLevel = chalk.level
    chalk.level = 3
    try {
      const result = renderMarkdown('```json\n{\n  "name": "evot",\n  "enabled": true\n}\n```')
      expect(result).toContain('\x1b[')
      expect(result).toContain('"name"')
      expect(result).toContain('true')
    } finally {
      chalk.level = prevLevel
    }
  })

  test('unlabelled fenced code blocks use plaintext instead of language guessing', () => {
    // Reference renderer passes `plaintext` when no fence info string is present.
    // Auto-detection would colour random words and make unlabelled snippets
    // inconsistent with the reference renderer. The ```` fence borders may carry
    // their own dim styling, so assert specifically that the code CONTENT line
    // is uncoloured rather than the whole block.
    const result = renderMarkdown('```\nconst value = 1\n```')
    expect(result).toContain('const value = 1')
    const contentLine = stripAnsi(result)
      .split('\n')
      .find(l => l.includes('const value = 1'))
    expect(contentLine).toBeDefined()
    // The content line, as emitted, contains no ANSI escape (no highlighting).
    const rawContentLine = result.split('\n').find(l => l.includes('const value = 1'))
    expect(rawContentLine).not.toContain('\x1b[')
  })

  test('highlights common alias tags (proto/jsonc/mdx/env/…)', async () => {
    // highlight.js doesn't register these names directly, but models routinely
    // write them in fences. The renderer maps them onto the closest supported
    // grammar so the block is still coloured. We verify the mapping by
    // asserting the target language is one cli-highlight recognises, which is
    // environment-independent (doesn't depend on FORCE_COLOR / TTY detection).
    const cliHighlight = await import('cli-highlight')
    const aliases: Array<[string, string]> = [
      ['proto', 'protobuf'],
      ['jsonc', 'json'],
      ['json5', 'json'],
      ['ndjson', 'json'],
      ['mdx', 'markdown'],
      ['env', 'ini'],
      ['dotenv', 'ini'],
      ['fish', 'bash'],
      ['vue', 'html'],
      ['svelte', 'html'],
      ['log', 'accesslog'],
    ]
    for (const [_alias, target] of aliases) {
      expect(cliHighlight.supportsLanguage(target)).toBe(true)
    }
    // Sanity: content is preserved through the render path even without
    // knowing whether colour is enabled.
    for (const [alias] of aliases) {
      const rendered = render('```' + alias + '\nSAMPLE\n```')
      expect(rendered).toContain('SAMPLE')
    }
  })
  test('splits hr marker glued to bold emphasis on next section', () => {
    // `---**SQL notes**` — the HR separator and the bold section title
    // share a line with no blank around them. Must be split so the HR renders
    // as a separator and the bold text survives on its own line.
    const md = 'Previous sentence.\n---**SQL notes**\n```sql\nSELECT 1\n```'
    const result = render(md)
    expect(result).toContain('Previous sentence')
    expect(result).toContain('SQL notes')
    expect(result).toContain('SELECT 1')
    // Bold markers must be stripped by the renderer.
    expect(result).not.toContain('**SQL')
  })

  test('aligns tree trailing comments to a shared start column', () => {
    // A directory tree with trailing `# …` comments whose `#` columns already
    // line up in the source. The box-drawing preservation pass aligns the
    // comment START columns (two spaces past the widest prefix), so every `#`
    // lands in the same column. Regression for aligning the END column
    // instead, which scattered the `#` markers across different columns and
    // destroyed alignment the author already got right.
    const md = [
      '```',
      'src/',
      '├── host.ts        # host loader',
      '├── api.ts         # public api surface',
      '├── context.ts     # ui primitives',
      '```',
    ].join('\n')

    const rendered = render(md).replace(/\u200b/g, '')
    const hashColumns = rendered
      .split('\n')
      .filter(line => /[├└]/.test(line) && line.includes('#'))
      .map(line => stringWidth(line.slice(0, line.indexOf('#'))))

    expect(hashColumns.length).toBe(3)
    // Every `#` must land in the same column.
    expect(new Set(hashColumns).size).toBe(1)
    // Comments and their prefixes are preserved verbatim (only spacing changes).
    expect(rendered).toContain('# host loader')
    expect(rendered).toContain('# public api surface')
    expect(rendered).toContain('# ui primitives')
  })

  test('styles plain ascii diagrams without changing their visible text', () => {
    const prevLevel = chalk.level
    chalk.level = 3
    const diagram = [
      'prompt ──► Prefill ──► K/V 写入 cache',
      '           │',
      '           ▼',
      '      Decode --> token',
    ].join('\n')

    try {
      const rendered = renderMarkdown(`\`\`\`text\n${diagram}\n\`\`\``)
      const plain = stripAnsi(rendered).replace(/\u200b/g, '')

      for (const line of diagram.split('\n')) {
        expect(plain).toContain(line)
      }
      expect(rendered).not.toBe(plain)
      expect(plain).not.toContain('```')
    } finally {
      chalk.level = prevLevel
    }
  })

  test('does not normalize hr markers inside authored code fences', () => {
    const md = [
      '```text',
      'alpha',
      '---',
      'omega',
      '```',
    ].join('\n')
    const result = render(md)
    expect(result).toMatch(/^  alpha$/m)
    expect(result).toMatch(/^  ---$/m)
    expect(result).toMatch(/^  omega$/m)
  })

  test('renders unclosed tilde fence as code', () => {
    const result = render('~~~sql\nSELECT 1')
    expect(result).toContain('SELECT 1')
    expect(result).not.toContain('~~~')
  })

  test('repairs unclosed code fence before later prose', () => {
    const md = '```json\n[\n  {"id":"evt-001"}\n]\n\ntext after.'
    const result = render(md)
    expect(result).toContain('{"id":"evt-001"}')
    expect(result).toContain('text after')
    expect(fencesWellFormed(result)).toBe(true)
  })

  test('does not normalise `-`/`*` that are not bullet intents', () => {
    // Guard rails — make sure we don't mangle negatives, CLI flags, HR, or
    // emphasis markers.
    expect(render('-1.5 is negative').replace(/\u200b/g, '')).toContain('-1.5 is negative')
    expect(render('--flag is an option').replace(/\u200b/g, '')).toContain('--flag is an option')
    // A bare `---` is an hr and now renders as a full-width ─ rule.
    expect(render('---').replace(/\u200b/g, '')).toMatch(/─+/)
    expect(render('use *emphasis* here').replace(/\u200b/g, '')).toContain('emphasis')
  })

  test('does not normalise ascii bullet-like command options', () => {
    expect(render('-p value').replace(/\u200b/g, '')).toContain('-p value')
    expect(render('-1 remains negative').replace(/\u200b/g, '')).toContain('-1 remains negative')
    expect(render('config:-foo:bar').replace(/\u200b/g, '')).toContain('config:-foo:bar')
    expect(render('This is fine - not a bullet').replace(/\u200b/g, '')).toContain('This is fine - not a bullet')
  })

  test('does not normalise decimals/versions as ordered list', () => {
    // Guard rails — decimals and version strings must stay intact.
    expect(render('3.14 is pi').replace(/\u200b/g, '')).toContain('3.14')
    expect(render('see v1.2.3 for details').replace(/\u200b/g, '')).toContain('v1.2.3')
    expect(render('192.168.1.1 is local').replace(/\u200b/g, '')).toContain(
      '192.168.1.1',
    )
  })

  test('does not split inline JSON-like objects with decimals after a colon', () => {
    // Guard rails for ORDERED_GLUED_AFTER_COLON_RE: `task_1: 0.8` is a
    // colon + decimal, not a colon + ordered marker. Splitting it would
    // rip the line apart and the decimal would become a fake list number.
    const md = 'scores_by_task: {task_1: 0.8, task_2: 1.6}'
    const result = render(md).replace(/\u200b/g, '')
    expect(result).toContain('{task_1: 0.8, task_2: 1.6}')
    expect(result).not.toMatch(/^\s*0\.\s+8/m)
    expect(result).not.toMatch(/^\s*1\.\s+6/m)
  })

  test('preserves `#1` and `#include` (single-# ASCII body)', () => {
    // Issue refs and preprocessor directives must not become headings.
    const issue = render('see #1 for context')
    expect(issue).toContain('#1')
    const preproc = render('#include <stdio.h>')
    expect(preproc).toContain('#include')
  })

  test('splits single-line fenced code', () => {
    const result = render('```const value = 1```')

    expect(result).toContain('const value = 1')
    expect(fencesWellFormed(result)).toBe(true)
  })

  test('repairs unclosed fence before following markdown heading without a blank line', () => {
    const result = render('```json\n{\n  "id": "tr-abc"\n}\n## Step 8: input / output')

    expect(result).toContain('"id": "tr-abc"')
    expect(result.replace(/\u200b/g, '')).toContain('Step 8: input / output')
    expect(fencesWellFormed(result)).toBe(true)
  })

  test('repairs completed json fence before plain chinese paragraph', () => {
    const result = render('Final:\n```json\n{\n  "id": "tr-abc",\n  "is_deleted": 0\n}\ntext after')

    expect(result).toContain('"is_deleted": 0')
    expect(result).toContain('text after')
    expect(fencesWellFormed(result)).toBe(true)
  })

  test('does not close plain text fence without diagram content before bold literal', () => {
    const md = [
      '```text',
      'literal plain text',
      '',
      '**not markdown**',
    ].join('\n')

    const result = render(md).replace(/\u200b/g, '')

    expect(result).toContain('literal plain text')
    expect(result).toContain('**not markdown**')
  })

  test('splits opening fence glued to a heading so later markdown still renders', () => {
    // Production regression: model wrote `### title```\ncode...\n```\n### next`
    // without a newline before the opening fence. marked then treats the later
    // close as a new open and swallows the rest of the document as code.
    const md = [
      '### 3. Query-time merge```',
      'On MV scan (inside the operator):',
      '  1. read base snapshot',
      '```',
      '',
      'Hard evidence: behind_by=1m2s',
      '',
      '### 4. Why those limits exist',
      '',
      '| Limit | Error | Reason |',
      '|---|---|---|',
      '| no join | `Join types` | breaks 1:1 mapping |',
      '',
      '- **Plan proof**: MV Scan is a composite operator',
    ].join('\n')

    const result = render(md).replace(/\u200b/g, '')

    expect(result).toContain('### 3. Query-time merge')
    expect(result).toContain('On MV scan')
    expect(result).toContain('### 4. Why those limits exist')
    expect(result).toContain('┌')
    expect(result).toContain('no join')
    expect(result).toContain('Plan proof')
    // Table separator must be consumed by the table renderer, not left as code.
    expect(result).not.toContain('|---|---|---|')
    // Section 4 must not render as indented code (2-space prefix on the heading).
    expect(result).not.toMatch(/^ {2}### 4\./m)
  })

  test('drops a stray bare fence before prose (overflow chunk boundary)', () => {
    // When overflow drains mid-message, the next chunk can start with a bare
    // ``` that was meant as a close for the previous chunk. Without dropping
    // it, the whole chunk becomes one code block.
    const md = [
      '```',
      '',
      'Hard evidence: behind_by=1m2s',
      '',
      '### 4. Why those limits exist',
      '',
      '| Limit | Error |',
      '|---|---|',
      '| no join | not allowed |',
    ].join('\n')

    const result = render(md).replace(/\u200b/g, '')

    expect(result).toContain('Hard evidence')
    expect(result).toContain('### 4. Why those limits exist')
    expect(result).toContain('┌')
    expect(result).not.toMatch(/^ {2}### 4\./m)
    expect(result).not.toContain('|---|---|')
  })

  test('repairs unclosed json fence so following heading is not code', () => {
    const result = render('```json\n{\n  "id": "tr-abc"\n}\n## Step 8: input / output')
      .replace(/\u200b/g, '')

    expect(result).toContain('"id": "tr-abc"')
    expect(result).toContain('Step 8: input / output')
    // Heading must not sit inside an indented code block.
    expect(result).not.toMatch(/^ {2}## Step 8/m)
    expect(result).not.toMatch(/^ {2}###? Step 8/m)
  })

  test('keeps multi-statement sql fence intact when comments follow a semicolon', () => {
    // Production regression (asst-1633): after `GROUP BY grp;` the next line is
    // `-- CJK comment`. Treating `;` as "code done" + CJK as prose closed the
    // fence early; the real close then re-opened and swallowed the document.
    const md = [
      '### 2. Target semantics',
      '',
      '```sql',
      'CREATE MATERIALIZED VIEW mv AS',
      '  SELECT grp, SUM(val) s',
      '  FROM base_t',
      '  GROUP BY grp;',
      '',
      '-- auto maintain in background',
      '-- query is always correct; behind_by is lag only',
      'SHOW MATERIALIZED VIEWS;  -- with behind_by',
      '```',
      '',
      'Limits align with the Snowflake subset.',
      '',
      '### 3. Phased rollout',
      '',
      '- DDL first',
      '- then incremental refresh',
    ].join('\n')

    const result = render(md).replace(/\u200b/g, '')

    expect(result).toContain('CREATE MATERIALIZED VIEW')
    expect(result).toContain('SHOW MATERIALIZED VIEWS')
    expect(result).toContain('auto maintain in background')
    expect(result).toContain('### 3. Phased rollout')
    expect(result).toContain('- DDL first')
    // Section 3 must not be swallowed into an indented code block.
    expect(result).not.toMatch(/^ {2}### 3\./m)
    // The sql fence must not be torn into an early close + stray open.
    expect(result).not.toMatch(/GROUP BY grp;\s*\n\s*```\s*\n\s*-- auto maintain/)
  })

  test('keeps adjacent prose compact', () => {
    const result = render('a\nb\nc')

    expect(result).toBe('a\nb\nc')
  })

  test('keeps list items compact', () => {
    const result = render('- one\n- two\n- three')

    expect(result).toBe('- one\n- two\n- three')
  })

  test('wraps very long plain lines', () => {
    const restore = withColumns(40)
    try {
      const result = render('INSERT ' + 'x'.repeat(80))
      expect(result.split('\n').length).toBeGreaterThan(1)
    } finally {
      restore()
    }
  })

  test('soft-wraps an over-wide heading instead of overrunning the terminal', () => {
    // Models sometimes glue an entire paragraph onto a heading line with no
    // newline, so the lexer parses one giant h2. Without wrapping it overruns
    // the terminal width and gets visually truncated. Every wrapped line must
    // stay within the content width (columns - SAFETY_MARGIN).
    const columns = 100
    const restore = withColumns(columns)
    try {
      const heading = '## 用这个 demo 的真实任务来说demo 里有个任务（我从 data/teacher_sft.jsonl 和 data/teacher_rl.jsonl 里读出来的真实数据）很长很长的一段文字需要换行处理才行。'
      const lines = render(heading).split('\n').filter(Boolean)
      expect(lines.length).toBeGreaterThan(1)
      for (const line of lines) {
        expect(stringWidth(line)).toBeLessThanOrEqual(columns - 4)
      }
    } finally {
      restore()
    }
  })

  test('keeps wrapped paragraph continuation flush with first line', () => {
    const restore = withColumns(84)
    try {
      const result = render('Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat.')
      const lines = result.split('\n').filter(Boolean)

      expect(lines.length).toBeGreaterThan(1)
      expect(lines.every(line => !line.startsWith(' '))).toBe(true)
    } finally {
      restore()
    }
  })

  test('keeps list item continuation lines hanging indented', () => {
    const restore = withColumns(42)
    try {
      const result = render('- Check `cli/src/render/markdown.ts` with a very very very very long line')
        .replace(/\u200b/g, '')
      const lines = result.split('\n')

      expect(lines.length).toBeGreaterThan(1)
      expect(lines[0]).toStartWith('- ')
      expect(lines.slice(1).every(line => line.startsWith('  '))).toBe(true)
      expect(lines.slice(1).every(line => !line.startsWith('- '))).toBe(true)
    } finally {
      restore()
    }
  })

  test('does not insert word boundaries around every CJK punctuation mark', () => {
    const result = renderMarkdown('中文，标点。继续：说明')

    expect(result).not.toContain(`\u200b，`)
    expect(result).not.toContain(`，\u200b`)
    expect(result).not.toContain(`\u200b。`)
    expect(result).not.toContain(`。\u200b`)
    expect(result).not.toContain(`\u200b：`)
    expect(result).not.toContain(`：\u200b`)
  })

  test('inserts pangu space between CJK and latin/digit characters', () => {
    // `一条trace` reads better (and wraps better) as `一条 trace`.
    const result = render('钉住一条trace，把它当 target').replace(/\u200b/g, '')
    expect(result).toContain('一条 trace')
    expect(result).not.toMatch(/一条trace/)
  })

  test('does not touch latin/digit inside inline code and links', () => {
    // Inline code must stay verbatim so copy-paste matches source.
    const inline = render('用 `eval()` 跑一下 42次').replace(/\u200b/g, '')
    expect(inline).toContain('eval()')
    // Surrounding CJK↔digit still gets a space: `42次` → `42 次`.
    expect(inline).toContain('42 次')
  })

  test('detects markdown syntax after the first 500 characters', () => {
    const result = render(`${'a'.repeat(520)}\n\n# Tail heading`)

    expect(result).toContain('Tail heading')
    expect(result).not.toContain('# Tail heading')
  })

  test('renders code blocks', () => {
    const result = render('```js\nconst x = 1\n```')
    expect(result).toContain('const x = 1')
  })

  test('renders unordered lists', () => {
    const result = render('- one\n- two\n- three')
    expect(result).toContain('- one')
    expect(result).toContain('- two')
    expect(result).toContain('- three')
  })

  test('renders ordered lists', () => {
    const result = render('1. first\n2. second')
    expect(result).toContain('1.')
    expect(result).toContain('first')
    expect(result).toContain('second')
  })

  test('renders blockquotes', () => {
    const result = render('> quoted text')
    expect(result).toContain('quoted text')
  })

  test('blockquote text is italic but not dimmed', () => {
    // Dimming long CJK quotes on dark backgrounds is nearly invisible. We
    // keep italic for emphasis but drop the dim grey foreground.
    const theme = getTheme()
    expect(theme.blockquoteText.paint('x')).toBe(chalk.italic('x'))
    const raw = renderMarkdown('> 引用的一段中文文本')
    expect(raw).toContain(theme.blockquoteText.paint('引用的一段中文文本'))
  })

  test('renders links', () => {
    const prev = process.env.FORCE_HYPERLINK
    process.env.FORCE_HYPERLINK = '1'
    try {
      const result = render('[click](https://example.com)')
      expect(result).toContain('click')
      // With OSC 8 on, the URL is attached as a hyperlink target inside the
      // escape sequence (not stripped by stripAnsi, so test the raw output).
      const raw = renderMarkdown('[click](https://example.com)')
      expect(raw).toContain('https://example.com')
    } finally {
      if (prev === undefined) delete process.env.FORCE_HYPERLINK
      else process.env.FORCE_HYPERLINK = prev
    }
  })

  test('link fallback without OSC 8 shows only the URL', () => {
    // Mirror claudecode: when hyperlinks aren't supported, createHyperlink
    // returns the bare URL. The display text is dropped rather than
    // surfaced as `text (url)` because (a) parentheses are noisy in
    // paragraph-style prose and (b) search/copy still works with the URL
    // alone.
    const prev = process.env.FORCE_HYPERLINK
    process.env.FORCE_HYPERLINK = '0'
    try {
      const result = render('[click](https://example.com)')
      expect(result).toContain('click')
      expect(result).toContain('https://example.com')
    } finally {
      if (prev === undefined) delete process.env.FORCE_HYPERLINK
      else process.env.FORCE_HYPERLINK = prev
    }
  })

  test('link fallback without OSC 8 shows bare URL when there is no text', () => {
    const prev = process.env.FORCE_HYPERLINK
    process.env.FORCE_HYPERLINK = '0'
    try {
      const result = render('<https://example.com>')
      expect(result).toContain('https://example.com')
    } finally {
      if (prev === undefined) delete process.env.FORCE_HYPERLINK
      else process.env.FORCE_HYPERLINK = prev
    }
  })

  test('h1 heading is gold, bold, italic, underlined', () => {
    // evot accent gold + emphasis (matches banner headers + pi's mdHeading).
    // Pin the dark theme + colour level so the assertion is deterministic:
    // getTheme() otherwise caches whichever theme the ambient env resolved
    // (dark locally, light under CI), which flips the accent hue.
    const prevLevel = chalk.level
    const prevTheme = process.env.EVOT_THEME
    chalk.level = 3
    process.env.EVOT_THEME = 'dark'
    resetThemeCache()
    try {
      const theme = getTheme()
      expect(theme.h1.paint('Title')).toBe(chalk.hex('#f0c674').bold.italic.underline('Title'))
      const raw = renderMarkdown('# Title')
      expect(raw).toContain(theme.h1.paint('Title'))
    } finally {
      chalk.level = prevLevel
      if (prevTheme === undefined) delete process.env.EVOT_THEME
      else process.env.EVOT_THEME = prevTheme
      resetThemeCache()
    }
  })

  test('h2 heading is gold and bold', () => {
    // h2+ carry the accent so every level reads as a distinct section marker.
    // See h1 test: pin dark theme + colour level for a deterministic hue.
    const prevLevel = chalk.level
    const prevTheme = process.env.EVOT_THEME
    chalk.level = 3
    process.env.EVOT_THEME = 'dark'
    resetThemeCache()
    try {
      const theme = getTheme()
      expect(theme.h2.paint('Subtitle')).toBe(chalk.hex('#f0c674').bold('Subtitle'))
      const raw = renderMarkdown('## Subtitle')
      expect(raw).toContain(theme.h2.paint('Subtitle'))
    } finally {
      chalk.level = prevLevel
      if (prevTheme === undefined) delete process.env.EVOT_THEME
      else process.env.EVOT_THEME = prevTheme
      resetThemeCache()
    }
  })

  test('list markers carry the teal accent, checkbox stays uncoloured', () => {
    // pi tints list markers with its accent; evot mirrors this with the teal
    // secondary accent so list structure reads at a glance. The [ ]/[x] task
    // glyph is left uncoloured so todo state isn't lost in the accent hue.
    const prevLevel = chalk.level
    chalk.level = 3
    try {
      const bulletMarker = getTheme().bullet.paint('-')
      const orderedMarker = getTheme().listNumber.paint('1.')
      const unordered = renderMarkdown('- item one')
      expect(unordered).toContain(bulletMarker)
      expect(stripAnsi(unordered)).toContain('- item one')

      const ordered = renderMarkdown('1. first')
      expect(ordered).toContain(orderedMarker)
      expect(stripAnsi(ordered)).toContain('1. first')

      // The checkbox glyph is emitted verbatim, not wrapped in the accent hue.
      const task = renderMarkdown('- [x] done')
      expect(task).toContain(bulletMarker)
      expect(task).toContain('[x]')
      expect(stripAnsi(task)).toContain('- [x] done')
    } finally {
      chalk.level = prevLevel
    }
  })

  test('renders horizontal rules', () => {
    // Full-width box-drawing rule (aligned with pi), not a literal `---`.
    const result = render('---')
    expect(result).toMatch(/^─+$/m)
    expect(result).not.toContain('---')
  })

  test('does not split em-dash mid-sentence', () => {
    // Plain em-dash usage with surrounding spaces must stay intact.
    const result = render('foo --- bar').replace(/\u200b/g, '')
    expect(result).toContain('foo --- bar')
  })

  test('preserves hand-drawn box art whitespace via code-fence wrap', () => {
    // Hand-drawn boxes go through a code-fence wrapper so marked does not
    // collapse the internal whitespace as paragraph text. We do NOT pad
    // ambiguous-width pictographs (terminals disagree about their width),
    // so the fix only guarantees the block is preserved verbatim.
    const box = [
      '┌──────────────────┐',
      '│ Service          │',
      '├──────────────────┤',
      '│ 🏠 Dashboard     │',
      '│ 🛠  Evaluators   │',
      '│ ▶  Eval Runs     │',
      '└──────────────────┘',
    ].join('\n')
    const rendered = stripAnsi(renderMarkdown(box)).replace(/\u200b/g, '')
    // Every original line should appear verbatim in the output.
    for (const line of box.split('\n')) {
      expect(rendered).toContain(line)
    }
    // And no raw fence markers should leak through.
    expect(rendered).not.toContain('```')
  })

  test('preserves box art with non-border interior lines', () => {
    // Regression: models sometimes emit boxes whose interior includes lines
    // that don't start with `│` (labels like `Error`, `Trace → ...`). The
    // block detector used to truncate at the first such line, letting the
    // remainder leak into paragraph parsing — where stray ASCII `|` got
    // treated as GFM table column separators, producing misaligned output.
    // By matching `┌...┐`/`└...┘` pairs we keep the whole block inside one
    // code fence regardless of interior line shape.
    const box = [
      '┌─ Samples ─┐',
      '│ ▼ × failed    a1b2c3d4e5f6…   8.2s   │ │',
      'Error   | |',
      '  no numeric metrics in judge output:    | |',
      '  instruction_following,groundedness,... | |',
      'Trace  → 7efc7485db736bcaa114efe991d8cb3 ↗   | |',
      'Sample → dsi_motxmny0_e252389b               | |',
      '[↻ Retry this sample]                        │',
      '└────────────┘',
    ].join('\n')
    const rendered = stripAnsi(renderMarkdown(box)).replace(/\u200b/g, '')
    for (const line of box.split('\n')) {
      expect(rendered).toContain(line)
    }
    // The interior `| |` tokens must NOT be promoted into a GFM table — a
    // table render would produce header separator lines like `┌─┬─┐` on
    // their own at the top of the output, which we assert absent here.
    expect(rendered).not.toContain('```')
    // Ensure the `Error` line keeps its trailing `| |` text intact rather
    // than being split across synthesized table columns.
    expect(rendered).toContain('Error   | |')
  })

  test('preserves tree-style directory listings with branch connectors', () => {
    // `tree`-style output uses `├──` / `└──` connectors but no closed
    // `┌────┐` border. Without special handling the lines get merged as
    // paragraph text (consecutive connectors collapse onto one line) and
    // indentation-only whitespace is lost, producing misaligned output.
    const tree = [
      'evot/',
      '├── .gitignore',
      '├── Cargo.lock',
      '├── Cargo.toml',
      '├── src/',
      '│   ├── app/',
      '│   │   └── src/',
      '│   │       └── lib.rs',
      '│   └── engine/',
      '│       └── src/',
      '│           └── lib.rs',
      '└── cli/',
      '    └── src/',
      '        └── cli.ts',
    ].join('\n')
    const rendered = stripAnsi(renderMarkdown(tree)).replace(/\u200b/g, '')
    for (const line of tree.split('\n')) {
      expect(rendered).toContain(line)
    }
    expect(rendered).not.toContain('```')
  })

  test('does not treat markdown tables containing box-drawing text as streaming tree tails', () => {
    const table = [
      '| Name | Shape |',
      '| --- | --- |',
      '| flow | │ box │ |',
      '',
      'next',
    ].join('\n')

    expect(stripAnsi(renderMarkdown(table))).toContain('Shape')
  })

  test('renders tables with box-drawing characters', () => {
    const md = '| A | B |\n|---|---|\n| 1 | 2 |'
    const result = render(md)
    expect(result).toContain('A')
    expect(result).toContain('B')
    expect(result).toContain('1')
    expect(result).toContain('2')
    expect(result).toContain('┌')
    expect(result).toContain('┐')
    expect(result).toContain('│')
    expect(result).toContain('├')
    expect(result).toContain('┤')
    expect(result).toContain('└')
    expect(result).toContain('┘')
  })

  test('renders <br> inside table cells as a line break', () => {
    // GFM tables don't support literal newlines in a cell, so models use
    // `<br>` to force bullet-style line breaks. Previously our renderer
    // dropped all html tokens, which glued the fragments together into one
    // long blob and word-wrapped anywhere.
    const restore = withColumns(120)
    try {
      const md = [
        '| 维度 | Rust |',
        '|------|------|',
        '| 类型系统 | 静态强类型<br>编译期检查<br>所有权 + 借用 |',
      ].join('\n')
      const result = render(md).replace(/\u200b/g, '')
      const lines = result.split('\n')
      // Each fragment should appear on its own line inside the cell.
      expect(lines.some(l => /│\s*静态强类型\s+│/.test(l))).toBe(true)
      expect(lines.some(l => /│\s*编译期检查\s+│/.test(l))).toBe(true)
      expect(lines.some(l => /│\s*所有权 \+ 借用\s+│/.test(l))).toBe(true)
      // The column width should be based on the longest visual <br> line,
      // not the combined width of every line joined by newlines.
      const borderLine = lines.find(l => l.startsWith('┌'))
      expect(borderLine).toBeDefined()
      expect(borderLine!.length).toBeLessThan(80)
      // And the literal `<br>` must not leak into the output.
      expect(result).not.toContain('<br>')
    } finally {
      restore()
    }
  })

  test('keeps CJK-heavy tables as horizontal tables even when cells wrap', () => {
    // Regression: previously any row whose cell wrapped past 4 lines flipped
    // the whole table to a `label: value` key-value fallback with `────`
    // row separators. CJK-heavy rows tripped this trigger routinely, so
    // legitimate tables silently turned into verbose lists.
    const restore = withColumns(80)
    try {
      const md = [
        '| 事件 | 触发点 | 行为 |',
        '|---|---|---|',
        '| TurnStarted | tasks/mod.rs:332 | 快照 turn_id 和当前 TokenUsage 作为基线；从 DB 读 goal，把 goal_id 绑到这一 turn 的计量快照 |',
        '| ToolCompleted | tools/registry.rs:490 每次工具调用后 | 工具名不是 update_goal 时，调用 account_thread_goal_progress（允许 budget steering 注入） |',
        '| TurnFinished | tasks/mod.rs:737 | 完成时再做一次最终计量；清理 turn 快照；取消 continuation 标记 |',
      ].join('\n')
      const result = render(md).replace(/\u200b/g, '')
      // Must render as a horizontal table with borders, not as the
      // key-value vertical fallback.
      expect(result).toContain('┌')
      expect(result).toContain('└')
      expect(result).toContain('事件')
      expect(result).toContain('触发点')
      // The vertical fallback uses a long `─` separator line between rows —
      // reject any line that is purely `─` repeated (no `┬`/`┴`/`┼`/`│`).
      const lines = result.split('\n')
      const sepOnly = lines.find(l => /^─{10,}$/.test(l))
      expect(sepOnly).toBeUndefined()
      // And must not rewrite the row as `事件: TurnStarted` / `触发点: …`.
      expect(result).not.toMatch(/^事件:\s/m)
      expect(result).not.toMatch(/^触发点:\s/m)
    } finally {
      restore()
    }
  })

  test('aligns emoji-capable symbols in tables using terminal width', () => {
    const md = [
      '| 状态 | 工具 | 说明 |',
      '|---|---|---|',
      '| ▶ | 🛠Read | 读取文件内容 |',
      '| ▶ | 🛠Edit | 编辑已有文件 |',
      '| ▶ | 🛠Bash | 执行 shell 命令 |',
      '| ▶ | 🛠Grep | 搜索代码 |',
    ].join('\n')
    const result = render(md).replace(/\u200b/g, '')
    const lines = result.split('\n').filter(Boolean)

    expect(lines).toContain('│ ▶    │ 🛠Read │ 读取文件内容    │')
    expect(lines).toContain('│ ▶    │ 🛠Edit │ 编辑已有文件    │')
  })

  test('collapses excessive newlines', () => {
    const result = renderMarkdown('hello\n\n\n\nworld')
    expect(result).not.toContain('\n\n\n')
  })

  test('falls back to raw text on parse error', () => {
    // renderMarkdown should never throw
    const result = renderMarkdown('just plain text')
    expect(result).toContain('just plain text')
  })

  test('keeps inline prose mentions of reminder tags and the content after them', () => {
    // Regression: a lazy global strip used to match from an in-prose
    // `<system-reminder>` mention to a later `</system-reminder>` and delete
    // everything in between — including unrelated tables and trailing prose.
    const md = [
      '核心区别：skill 菜单作为 `<system-reminder>` 消息注入对话。',
      '',
      '| 方面 | Claude Code | evot |',
      '|---|---|---|',
      '| 菜单位置 | `<system-reminder>` 消息 | 工具 description |',
      '| 截断策略 | 动态预算 | 固定 250 字 |',
      '',
      '然后把菜单从工具描述里删掉。',
    ].join('\n')
    const result = render(md).replace(/\u200b/g, '')
    expect(result).toContain('核心区别')
    expect(result).toContain('菜单位置')
    expect(result).toContain('截断策略')
    expect(result).toContain('然后把菜单从工具描述里删掉')
    // The inline tag mention is preserved (not stripped as an envelope).
    expect(result).toContain('<system-reminder>')
  })

  test('does not strip reminder tags inside fenced code blocks', () => {
    const md = [
      '示例：',
      '',
      '```',
      '<system-reminder>',
      'The following skills are available:',
      '</system-reminder>',
      '```',
      '',
      '后续说明。',
    ].join('\n')
    const result = render(md)
    expect(result).toContain('<system-reminder>')
    expect(result).toContain('The following skills are available:')
    expect(result).toContain('</system-reminder>')
    expect(result).toContain('后续说明')
  })
})

// ---------------------------------------------------------------------------
// GFM task-list checkboxes
// ---------------------------------------------------------------------------

describe('task-list checkboxes', () => {
  test('renders unchecked and checked boxes in an unordered list', () => {
    const result = stripAnsi(renderMarkdown('- [ ] todo item\n- [x] done item\n- normal item'))
    expect(result).toContain('- [ ] todo item')
    expect(result).toContain('- [x] done item')
    // Non-task items keep a plain bullet with no checkbox.
    expect(result).toContain('- normal item')
    expect(result).not.toContain('- [ ] normal')
  })

  test('renders checkboxes in an ordered list', () => {
    const result = stripAnsi(renderMarkdown('1. [ ] numbered todo\n2. [x] numbered done'))
    expect(result).toContain('1. [ ] numbered todo')
    expect(result).toContain('2. [x] numbered done')
  })

  test('renders checkboxes in nested lists', () => {
    const result = stripAnsi(renderMarkdown('- [ ] outer\n  - [x] nested done\n  - nested normal'))
    expect(result).toContain('- [ ] outer')
    expect(result).toContain('- [x] nested done')
    expect(result).toContain('- nested normal')
  })

  test('aligns all sibling items and wrapped continuations in deeply nested lists', () => {
    const restore = withColumns(44)
    try {
      const md = [
        '1. Top item:',
        '   - Bullet A:',
        '     1. Sub one',
        '     2. Sub two',
        '   - Bullet B:',
        '     continuation line under Bullet B',
        '     - Deep bullet 1 with a long line that wraps onto the next row',
        '     - Deep bullet 2',
      ].join('\n')
      const lines = stripAnsi(renderMarkdown(md)).split('\n')

      expect(lines).toEqual([
        '1. Top item:',
        '  - Bullet A:',
        '    i. Sub one',
        '    ii. Sub two',
        '  - Bullet B:',
        '    continuation line under Bullet B',
        '    - Deep bullet 1 with a long line',
        '      that wraps onto the next row',
        '    - Deep bullet 2',
      ])
      for (const line of lines) {
        expect(stringWidth(line)).toBeLessThanOrEqual(40)
      }
    } finally {
      restore()
    }
  })

  test('wrapped task item aligns continuation under the text', () => {
    const restore = withColumns(40)
    try {
      const md = '- [x] alpha beta gamma delta epsilon zeta eta theta iota'
      const lines = stripAnsi(renderMarkdown(md)).split('\n')
      expect(lines.length).toBeGreaterThan(1)
      expect(lines[0]).toMatch(/^- \[x\] /)
      // Continuation lines indent to the "- [x] " prefix width (6 columns).
      // The wrap primitive preserves the break space, so allow an optional extra space.
      expect(lines[1]).toMatch(/^ {6}/)
      expect(lines[1].trim().length).toBeGreaterThan(0)
    } finally {
      restore()
    }
  })
})

// ---------------------------------------------------------------------------
// Nested inline style continuity
//
// When an inline token (strong/em/codespan/link) closes, it emits its own ANSI
// close code (22/23/24/39 — never a full \x1b[0m reset). We rely on chalk to
// re-open the surrounding style so text after the nested token keeps the outer
// heading/blockquote/emphasis styling. These tests lock that behaviour so a
// theme change or a stray full-reset can't silently strip styling mid-line.
// ---------------------------------------------------------------------------

describe('nested inline style continuity', () => {
  function renderColored(md: string): string {
    const prevLevel = chalk.level
    chalk.level = 3
    try {
      return renderMarkdown(md)
    } finally {
      chalk.level = prevLevel
    }
  }

  test('inline content never emits a full reset (\\x1b[0m)', () => {
    const samples = [
      '# Title with **STRONG** word',
      '# Run `npm test` before commit',
      '## See [docs](https://x.com) now',
      '### Note *emphasis* here',
      '> quote with **bold** and more',
      '> quote with *emphasis* and more text',
      'text ***both*** tail',
    ]
    for (const md of samples) {
      const out = renderColored(md)
      expect(out).not.toContain('\x1b[0m')
    }
  })

  test('italic reopens after a nested em closes inside a blockquote', () => {
    const out = renderColored('> quote with *emphasis* and more text')
    // The nested em closes with \x1b[23m; the trailing text must be re-wrapped
    // in \x1b[3m so it stays italic.
    expect(out).toContain('\x1b[23m\x1b[3m')
    // Sanity: visible text is intact.
    expect(stripAnsi(out)).toContain('quote with emphasis and more text')
  })

  test('heading keeps bold/italic/underline open across a nested codespan', () => {
    const out = renderColored('# Run `npm test` before commit')
    // h1 now opens with the gold accent colour before the decorations, so the
    // string no longer starts with the bold escape. What still matters: the
    // decorations (bold+italic+underline) open together, and the codespan only
    // toggles the foreground colour (39 close) rather than a full reset, so
    // they stay open for the tail.
    expect(out).toContain('\x1b[1m\x1b[3m\x1b[4m')
    expect(out.startsWith('\x1b[')).toBe(true)
    expect(out).toContain('\x1b[39m')
    expect(out).not.toContain('\x1b[0m')
    expect(stripAnsi(out)).toBe('Run npm test before commit')
  })

  test('bold survives after a nested strong closes in a heading', () => {
    const out = renderColored('# Title with **STRONG** word')
    // strong closes bold with \x1b[22m; chalk re-opens \x1b[1m for ' word'.
    expect(out).toContain('\x1b[22m\x1b[1m')
    expect(stripAnsi(out)).toBe('Title with STRONG word')
  })
})

describe('formatToken', () => {
  test('renders paragraph token', () => {
    const token = lexFirst('hello world')
    const result = stripAnsi(formatToken(token))
    expect(result).toContain('hello world')
  })

  test('renders space token as newline', () => {
    const result = formatToken({ type: 'space', raw: '\n\n' } as Token)
    expect(result).toBe('\n')
  })

  test('renders br token as newline', () => {
    const result = formatToken({ type: 'br', raw: '\n' } as Token)
    expect(result).toBe('\n')
  })

  test('renders escape token as text', () => {
    const result = formatToken({ type: 'escape', raw: '\\)', text: ')' } as Token)
    expect(result).toBe(')')
  })

  test('renders hr as horizontal line', () => {
    const result = stripAnsi(formatToken({ type: 'hr', raw: '---' } as Token))
    expect(result).toMatch(/^─+$/m)
  })

  test('renders image as href', () => {
    const result = formatToken({ type: 'image', raw: '![alt](url)', href: 'https://img.png', text: 'alt' } as Token)
    expect(result).toBe('https://img.png')
  })

  test('returns empty string for unknown token types', () => {
    const result = formatToken({ type: 'html', raw: '<div>' } as Token)
    expect(result).toBe('')
  })
})

describe('block styling aligned with pi', () => {
  test('code blocks render with ```lang / ``` borders', () => {
    const out = render('```js\nconst a = 1\n```').split('\n').filter(l => l.trim())
    expect(out[0]).toBe('```js')
    expect(out[out.length - 1]).toBe('```')
    expect(out.some(l => l === '  const a = 1')).toBe(true)
  })

  test('unlabelled code block uses a bare ``` (no plaintext tag)', () => {
    const out = render('```\nplain\n```').split('\n').filter(l => l.trim())
    expect(out[0]).toBe('```')
    expect(out[out.length - 1]).toBe('```')
  })

  test('box-drawing diagram art gets no fence', () => {
    const out = render('```\nA --> B\n│ tree\n```')
    expect(out).not.toContain('```')
    expect(out).toContain('A --> B')
  })

  test('blockquote uses the │ border (not ▎)', () => {
    const out = render('> quoted')
    expect(out).toContain('│ quoted')
    expect(out).not.toContain('▎')
  })

  test('hr renders as a full-width ─ rule capped at 80 cols', () => {
    const rule = render('---').split('\n').find(l => /─/.test(l)) ?? ''
    expect(/^─+$/.test(rule)).toBe(true)
    expect(rule.length).toBeLessThanOrEqual(80)
    expect(render('---')).not.toContain('---')
  })
})

// ---------------------------------------------------------------------------
// File path linkification in codespan and text
// ---------------------------------------------------------------------------

describe('file path linkification', () => {
  const OSC8_START = '\x1b]8;;'

  test('codespan with absolute path produces file:// hyperlink', () => {
    const prev = process.env.FORCE_HYPERLINK
    process.env.FORCE_HYPERLINK = '1'
    try {
      const result = renderMarkdown('see `/tmp/simple.md`')
      expect(result).toContain(OSC8_START)
      expect(result).toContain('file:///tmp/simple.md')
      // The path text should still be present
      expect(stripAnsi(result)).toContain('/tmp/simple.md')
    } finally {
      if (prev === undefined) delete process.env.FORCE_HYPERLINK
      else process.env.FORCE_HYPERLINK = prev
    }
  })

  test('codespan with non-path content does not linkify', () => {
    const prev = process.env.FORCE_HYPERLINK
    process.env.FORCE_HYPERLINK = '1'
    try {
      const result = renderMarkdown('use `foo()` here')
      expect(result).not.toContain(OSC8_START)
    } finally {
      if (prev === undefined) delete process.env.FORCE_HYPERLINK
      else process.env.FORCE_HYPERLINK = prev
    }
  })

  test('plain text with absolute path produces file:// hyperlink', () => {
    const prev = process.env.FORCE_HYPERLINK
    process.env.FORCE_HYPERLINK = '1'
    try {
      const result = renderMarkdown('已生成：/tmp/simple.md')
      expect(result).toContain(OSC8_START)
      expect(result).toContain('file:///tmp/simple.md')
    } finally {
      if (prev === undefined) delete process.env.FORCE_HYPERLINK
      else process.env.FORCE_HYPERLINK = prev
    }
  })

  test('no hyperlink when FORCE_HYPERLINK=0', () => {
    const prev = process.env.FORCE_HYPERLINK
    process.env.FORCE_HYPERLINK = '0'
    try {
      const result = renderMarkdown('see `/tmp/simple.md`')
      expect(result).not.toContain(OSC8_START)
      expect(stripAnsi(result)).toContain('/tmp/simple.md')
    } finally {
      if (prev === undefined) delete process.env.FORCE_HYPERLINK
      else process.env.FORCE_HYPERLINK = prev
    }
  })
})
