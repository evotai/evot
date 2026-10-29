import chalk from 'chalk'
import type { Token, Tokens } from 'marked'
import stripAnsi from 'strip-ansi'
import { wrapTextWithAnsi } from '../../render/wrap.js'
import {
  EOL,
  SAFETY_MARGIN,
  BOX_DRAWING_RE,
  terminalDisplayWidth,
  terminalContentWidth,
  wrapDisplayTextWithIndent,
  wrapParagraph,
} from '../primitives.js'
import { createHyperlink, isWarpTerminal, supportsHyperlinks, wrapHyperlink } from '../../render/hyperlink.js'
import { linkifyIssueRefs } from '../../render/linkify.js'
import { getTheme, type Theme } from '../../render/theme/index.js'
import { renderLatexMath } from '../math/ansi.js'
import type { MathToken } from '../math/marked.js'

let highlighter: typeof import('cli-highlight') | null = null
try {
  highlighter = await import('cli-highlight')
} catch {
  // cli-highlight not available — code blocks render without syntax highlighting
}

// ---------------------------------------------------------------------------
// CJK ↔ Latin/digit spacing ("pangu")
// ---------------------------------------------------------------------------
//
// Mixed CJK/Latin prose without interstitial whitespace is hard to read
// (`一条trace` looks glued) and starves word-wrap of good break points. We
// insert a regular space between adjacent CJK characters and ASCII
// letters/digits — the classic pangu-style rule. Only applied to plain-text
// leaves, so inline code, links and URLs are preserved verbatim.
//
// Covers CJK Unified (U+4E00–U+9FFF), CJK Extension A (U+3400–U+4DBF),
// CJK Compat (U+F900–U+FAFF), Hiragana (U+3040–U+309F), Katakana
// (U+30A0–U+30FF). Intentionally skipped: CJK punctuation (`，。：`) — those
// already act as visual separators and double-spacing would look wrong.
const CJK_CHAR = '\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff'
const PANGU_CJK_THEN_LATIN_RE = new RegExp(`([${CJK_CHAR}])([A-Za-z0-9])`, 'g')
const PANGU_LATIN_THEN_CJK_RE = new RegExp(`([A-Za-z0-9])([${CJK_CHAR}])`, 'g')

function applyPangu(text: string): string {
  return text
    .replace(PANGU_CJK_THEN_LATIN_RE, '$1 $2')
    .replace(PANGU_LATIN_THEN_CJK_RE, '$1 $2')
}

// Common fence tags that highlight.js doesn't recognise directly. Map them
// onto the closest supported language so the code block still gets coloured
// instead of falling through to plaintext. Only map when the target is a
// reasonable visual approximation — we'd rather render plain than paint the
// wrong grammar over genuinely unrelated syntax.
const LANG_ALIASES: Record<string, string> = {
  // Protocol buffers
  proto: 'protobuf',
  // JSON dialects — all share core JSON syntax
  jsonc: 'json',
  json5: 'json',
  ndjson: 'json',
  jsonl: 'json',
  // Markdown + MDX (MDX is markdown with JSX fragments; core tokens match)
  mdx: 'markdown',
  // Generic "plain" / "txt" tags
  plain: 'plaintext',
  txt: 'plaintext',
  text: 'plaintext',
  // .env / dotenv files share KEY=value syntax with ini
  env: 'ini',
  dotenv: 'ini',
  properties: 'ini',
  conf: 'ini',
  // Shell variants — fish/nushell close enough to bash grammar-wise
  fish: 'bash',
  nu: 'bash',
  nushell: 'bash',
  // Logs
  log: 'accesslog',
  logs: 'accesslog',
  // Component files are mostly HTML templates
  vue: 'html',
  svelte: 'html',
  astro: 'html',
}

function resolveLanguage(lang: string | undefined): string | undefined {
  if (!lang) return undefined
  const normalized = lang.toLowerCase()
  return LANG_ALIASES[normalized] ?? normalized
}

/**
 * Highlight a single code line for streaming display. Matches the look of
 * the finalized code block so tokens committed while a fence is open don't
 * reflow when the fence finally closes. Returns the line verbatim if no
 * highlighter is available or highlighting throws.
 */
function highlightJsonLine(line: string): string {
  const chars = Array.from(line)
  let out = ''
  let i = 0
  let expectingKey = true

  while (i < chars.length) {
    const ch = chars[i]!

    if (ch === '"') {
      let token = ch
      i += 1
      let escaped = false
      while (i < chars.length) {
        const next = chars[i]!
        token += next
        i += 1
        if (escaped) {
          escaped = false
        } else if (next === '\\') {
          escaped = true
        } else if (next === '"') {
          break
        }
      }

      let j = i
      while (j < chars.length && /\s/.test(chars[j]!)) j += 1
      if (expectingKey && chars[j] === ':') {
        out += chalk.cyan(token)
        expectingKey = false
      } else {
        out += chalk.green(token)
      }
      continue
    }

    const rest = chars.slice(i).join('')
    const literal = /^(true|false|null)\b/.exec(rest)
    if (literal) {
      out += chalk.magenta(literal[1]!)
      i += literal[1]!.length
      continue
    }

    const number = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(rest)
    if (number) {
      out += chalk.yellow(number[0])
      i += number[0].length
      continue
    }

    if (ch === ':') {
      out += chalk.gray(ch)
      expectingKey = false
      i += 1
      continue
    }
    if (ch === ',') {
      out += chalk.gray(ch)
      expectingKey = true
      i += 1
      continue
    }
    if (ch === '{' || ch === '[') {
      out += chalk.gray(ch)
      expectingKey = true
      i += 1
      continue
    }
    if (ch === '}' || ch === ']') {
      out += chalk.gray(ch)
      expectingKey = false
      i += 1
      continue
    }

    out += ch
    i += 1
  }

  return out
}

function highlightJsonCode(text: string): string {
  return text.split(EOL).map(highlightJsonLine).join(EOL)
}

type LineCommentMarker = '--' | '//' | '#'

interface TrailingCodeComment {
  lineIndex: number
  prefix: string
  comment: string
  prefixWidth: number
}

const SQL_START_RE = /^(SELECT|CREATE|INSERT|UPDATE|DELETE|WITH|ALTER|DROP|MERGE|TRUNCATE)\b/i
const DIAGRAM_ARROW_RE = /(?:[-=]{2,}>|<[-=]{2,}|[→←↑↓↗↘↙↖▲▼▶◀])/
const DIAGRAM_BORDER_OR_SIDE_RE = /[┌└│][─┴┬\s]/
const PLAIN_DIAGRAM_LANGUAGE = '__plain_diagram__'
const DIAGRAM_BRANCH_MARKER_RE = /[├└]─►/g

function looksLikeSqlCode(text: string): boolean {
  const firstContentLine = text.split(EOL).find(line => line.trim())
  return firstContentLine ? SQL_START_RE.test(firstContentLine.trimStart()) : false
}

function lineCommentMarkersForCode(lang: string, text: string): LineCommentMarker[] {
  if (/^(sql|pgsql|plsql|mysql|sqlite|postgresql)$/.test(lang) || looksLikeSqlCode(text)) return ['--']
  if (/^(javascript|js|typescript|ts|tsx|jsx|java|c|cpp|c\+\+|csharp|cs|go|rust|rs|swift|kotlin|scala|php|css|scss|less)$/.test(lang)) return ['//']
  if (/^(bash|sh|zsh|fish|nu|nushell|python|py|ruby|rb|perl|pl|yaml|yml|toml|ini|dockerfile|makefile|make|env|dotenv|properties|conf)$/.test(lang)) return ['#']
  return []
}

function findTrailingCodeComment(line: string, markers: LineCommentMarker[]): Omit<TrailingCodeComment, 'lineIndex' | 'prefixWidth'> | null {
  let quote: string | null = null
  let escaped = false

  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!

    if (quote) {
      if (escaped) {
        escaped = false
      } else if (ch === '\\') {
        escaped = true
      } else if (ch === quote) {
        if (line[i + 1] === quote) {
          i++
        } else {
          quote = null
        }
      }
      continue
    }

    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch
      continue
    }

    for (const marker of markers) {
      if (!line.startsWith(marker, i)) continue
      if (i === 0 || !/\s/.test(line[i - 1]!)) continue

      const prefix = line.slice(0, i).trimEnd()
      if (!prefix.trim()) continue

      return {
        prefix,
        comment: line.slice(i).trimEnd(),
      }
    }
  }

  return null
}

function leadingWhitespace(line: string): string {
  return /^\s*/.exec(line)?.[0] ?? ''
}

function lineIsStandaloneComment(line: string, markers: LineCommentMarker[]): boolean {
  const trimmed = line.trimStart()
  return markers.some(marker => trimmed.startsWith(marker))
}

function lineIsCodeForIndent(line: string, markers: LineCommentMarker[]): boolean {
  return !!line.trim() && !lineIsStandaloneComment(line, markers)
}

function nearestCodeIndent(lines: string[], lineIndex: number, markers: LineCommentMarker[]): string | null {
  for (let i = lineIndex + 1; i < lines.length; i++) {
    if (!lines[i]!.trim()) continue
    if (lineIsCodeForIndent(lines[i]!, markers)) return leadingWhitespace(lines[i]!)
    break
  }

  for (let i = lineIndex - 1; i >= 0; i--) {
    if (!lines[i]!.trim()) continue
    if (lineIsCodeForIndent(lines[i]!, markers)) return leadingWhitespace(lines[i]!)
    break
  }

  return null
}

function alignStandaloneCodeComments(lines: string[], markers: LineCommentMarker[]): boolean {
  let changed = false
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    if (!lineIsStandaloneComment(line, markers)) continue

    const indent = nearestCodeIndent(lines, i, markers)
    if (indent === null) continue
    const aligned = `${indent}${line.trimStart()}`
    if (aligned === line) continue
    lines[i] = aligned
    changed = true
  }
  return changed
}

function alignTrailingCodeComments(text: string, lang: string): string {
  const markers = lineCommentMarkersForCode(lang, text)
  if (markers.length === 0) return text

  const lines = text.split(EOL)
  const standaloneChanged = alignStandaloneCodeComments(lines, markers)

  const comments: TrailingCodeComment[] = []
  for (let i = 0; i < lines.length; i++) {
    const comment = findTrailingCodeComment(lines[i]!, markers)
    if (!comment) continue
    comments.push({
      ...comment,
      lineIndex: i,
      prefixWidth: terminalDisplayWidth(comment.prefix),
    })
  }

  if (comments.length < 2) return standaloneChanged ? lines.join(EOL) : text

  const targetColumn = Math.max(...comments.map(comment => comment.prefixWidth)) + 2
  for (const comment of comments) {
    const padding = ' '.repeat(Math.max(2, targetColumn - comment.prefixWidth))
    lines[comment.lineIndex] = `${comment.prefix}${padding}${comment.comment}`
  }

  return lines.join(EOL)
}

function leftmostIndexOfAny(line: string, re: RegExp): number | null {
  const match = new RegExp(re.source, re.flags.replace('g', '')).exec(line)
  return match ? match.index : null
}

function padLineToColumn(line: string, fromIndex: number, targetColumn: number): string {
  const before = line.slice(0, fromIndex)
  const beforeWidth = terminalDisplayWidth(before)
  if (beforeWidth >= targetColumn) return line
  return `${before}${' '.repeat(targetColumn - beforeWidth)}${line.slice(fromIndex)}`
}

function medianColumn(columns: number[]): number | null {
  if (columns.length < 2) return null
  const sorted = [...columns].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)] ?? null
}

function normalizeDiagramIndent(text: string): string {
  if (!BOX_DRAWING_RE.test(text)) return text
  const lines = text.split(EOL)
  const borderColumns = lines
    .flatMap(line => {
      const cols: number[] = []
      const side = leftmostIndexOfAny(line, DIAGRAM_BORDER_OR_SIDE_RE)
      if (side !== null) cols.push(terminalDisplayWidth(line.slice(0, side)))
      return cols
    })
  const branchColumns = lines
    .flatMap(line => {
      const cols: number[] = []
      const matches = line.matchAll(DIAGRAM_BRANCH_MARKER_RE)
      for (const match of matches) cols.push(terminalDisplayWidth(line.slice(0, match.index)))
      return cols
    })

  const targetBorder = medianColumn(borderColumns)
  const targetBranch = medianColumn(branchColumns)
  if (targetBorder === null && targetBranch === null) return text

  return lines.map(line => {
    if (targetBorder !== null) {
      const borderIndex = leftmostIndexOfAny(line, DIAGRAM_BORDER_OR_SIDE_RE)
      if (borderIndex !== null) return padLineToColumn(line, borderIndex, targetBorder)
    }
    if (targetBranch !== null) {
      const branchIndex = leftmostIndexOfAny(line, DIAGRAM_BRANCH_MARKER_RE)
      if (branchIndex !== null) return padLineToColumn(line, branchIndex, targetBranch)
    }
    return line
  }).join(EOL)
}

function styleDiagramCode(text: string, theme: Theme): string {
  const hasDiagramMarkers = BOX_DRAWING_RE.test(text) || DIAGRAM_ARROW_RE.test(text)
  if (!hasDiagramMarkers) return text

  return text
    .split(EOL)
    .map(line => line
      .replace(/[\u2500-\u257f]/g, ch => theme.tableBorder.paint(ch))
      .replace(/[-=]{2,}>|<[-=]{2,}|[→←↑↓↗↘↙↖▲▼▶◀]/g, arrow => theme.hr.paint(arrow)),
    )
    .join(EOL)
}

export function padCodeBlock(code: string): string {
  return code
    .split(EOL)
    .map(line => line.length > 0 ? `  ${line}` : line)
    .join(EOL)
}

export function formatToken(
  token: Token,
  listDepth = 0,
  orderedListNumber: number | null = null,
  parent: Token | null = null,
  theme: Theme = getTheme(),
): string {
  switch (token.type) {
    case 'blockquote': {
      const inner = (token.tokens ?? [])
        .map(t => formatToken(t, 0, null, null, theme))
        .join('')
      const bar = theme.blockquoteBorder.paint('│')
      return inner
        .split(EOL)
        .map(line =>
          stripAnsi(line).trim() ? `${bar} ${theme.blockquoteText.paint(line)}` : line,
        )
        .join(EOL)
    }
    case 'code': {
      const text = token.text as string
      const lang = resolveLanguage((token as Tokens.Code).lang) ?? (BOX_DRAWING_RE.test(text) || DIAGRAM_ARROW_RE.test(text) ? PLAIN_DIAGRAM_LANGUAGE : 'plaintext')
      let highlighted = alignTrailingCodeComments(text, lang)
      const isPlainDiagram = lang === PLAIN_DIAGRAM_LANGUAGE || (lang === 'plaintext' && (BOX_DRAWING_RE.test(highlighted) || DIAGRAM_ARROW_RE.test(highlighted)))
      if (isPlainDiagram) {
        highlighted = styleDiagramCode(normalizeDiagramIndent(highlighted), theme)
        // Box-drawing / arrow diagrams are visual art, not code: no ```lang
        // fence, just the 2-space indent (as before) so the art stays aligned
        // with surrounding prose.
        return padCodeBlock(highlighted) + EOL
      } else if (lang === 'json') {
        highlighted = highlightJsonCode(highlighted)
      } else if (highlighter) {
        try {
          if (highlighter.supportsLanguage(lang)) {
            highlighted = highlighter.highlight(highlighted, { language: lang })
          }
        } catch {
          // fallback to plain text
        }
      }
      // Wrap fenced code in ```lang / ``` borders (matching pi) so a code block
      // is visually distinct from ordinary indented prose. Echo the FIRST word
      // of the original info string (preserving the author's casing, like pi),
      // not the resolved/lowercased highlight language — and only the first
      // word so a stray multi-word info string can't glue extra text onto the
      // fence line. `plaintext` (our fallback for untagged blocks) prints a
      // bare ``` to avoid a noisy tag.
      const rawLang = ((token as Tokens.Code).lang ?? '').trim().split(/\s+/)[0] ?? ''
      const fenceLang = lang === 'plaintext' ? '' : rawLang
      const openFence = theme.codeBlockBorder.paint('```' + fenceLang)
      const closeFence = theme.codeBlockBorder.paint('```')
      return openFence + EOL + padCodeBlock(highlighted) + EOL + closeFence + EOL
    }
    case 'math_block': {
      const formula = renderLatexMath((token as unknown as MathToken).text)
      return wrapDisplayTextWithIndent(theme.mathBlock.paint(formula), '  ', '  ') + EOL
    }
    case 'math_inline': {
      const formula = renderLatexMath((token as unknown as MathToken).text)
      return theme.mathInline.paint(formula)
    }
    case 'codespan': {
      const raw = token.text as string
      const isFilePath = /^[~/][\w./_-]+$/.test(raw)
      // Warp auto-detects file paths in plain text; ANSI codes break detection.
      // Skip coloring for file paths unless hyperlinks are force-enabled.
      if (isFilePath && isWarpTerminal() && process.env.FORCE_HYPERLINK !== '1') {
        return raw
      }
      const colored = theme.codeInline.paint(raw)
      // Make absolute file paths clickable (file:// hyperlink)
      if (supportsHyperlinks() && isFilePath) {
        const resolved = raw.startsWith('~')
          ? raw.replace('~', process.env.HOME ?? '~')
          : raw
        return wrapHyperlink(`file://${resolved}`, colored)
      }
      return colored
    }
    case 'del':
      // del is disabled via configureMarked; if somehow reached, render as-is
      return ''
    case 'em':
      return theme.italic.paint(
        (token.tokens ?? [])
          .map(t => formatToken(t, 0, null, parent, theme))
          .join(''),
      )
    case 'strong':
      return theme.bold.paint(
        (token.tokens ?? [])
          .map(t => formatToken(t, 0, null, parent, theme))
          .join(''),
      )
    case 'heading': {
      const text = (token.tokens ?? [])
        .map(t => formatToken(t, 0, null, null, theme))
        .join('')
      const depth = (token as Tokens.Heading).depth
      const style = depth === 1 ? theme.h1
        : depth === 2 ? theme.h2
          : depth === 3 ? theme.h3
            : depth === 4 ? theme.h4
              : depth === 5 ? theme.h5
                : theme.h6
      // Keep the `###` prefix for H3 and deeper (matching pi). H1/H2 are
      // distinct enough via styling (bold/italic/underline), but H3–H6 all
      // render as plain bold, so without the hash prefix their levels are
      // visually indistinguishable. The prefix is painted with the heading
      // style so it reads as part of the heading.
      const prefix = depth >= 3 ? '#'.repeat(depth) + ' ' : ''
      // Soft-wrap over-wide headings the same way paragraphs are wrapped.
      // Models sometimes glue an entire paragraph onto a heading line with no
      // newline (`## title<prose…>`), which the lexer parses as one giant
      // heading. Without wrapping it overruns the terminal and gets visually
      // truncated. wrapParagraph preserves the heading styling
      // across the inserted line breaks.
      return wrapParagraph(style.paint(prefix + text)) + EOL
    }
    case 'hr': {
      // Full-width horizontal rule (matching pi): a run of ─ capped at 80
      // columns, sized to the current content width. Reads as a clear section
      // break instead of a literal `---`.
      const ruleWidth = Math.min(terminalContentWidth(), 80)
      return theme.hr.paint('─'.repeat(Math.max(1, ruleWidth))) + EOL
    }
    case 'link': {
      if (token.href.startsWith('mailto:')) {
        return token.href.replace(/^mailto:/, '')
      }
      const linkText = (token.tokens ?? [])
        .map(t => formatToken(t, 0, null, token, theme))
        .join('')
      const plainText = stripAnsi(linkText)
      // Delegate to createHyperlink: when OSC 8 is supported it wraps
      // `linkText` (or the URL if there's no meaningful text) in a
      // clickable escape sequence. When unsupported it returns the raw
      // URL — matching claudecode's behavior so users at least see
      // something copyable instead of silently dropping the href.
      if (plainText && plainText !== token.href) {
        return createHyperlink(token.href, plainText)
      }
      return createHyperlink(token.href)
    }
    case 'list':
      return (token as Tokens.List).items
        .map((item: Token, index: number) =>
          formatToken(
            item,
            listDepth,
            (token as Tokens.List).ordered ? ((token as Tokens.List).start as number) + index : null,
            token,
            theme,
          ),
        )
        .join('')
    case 'list_item': {
      const listItem = token as Tokens.ListItem
      const marker = orderedListNumber === null
        ? '-'
        : `${getListNumber(listDepth + 1, orderedListNumber)}.`
      // GFM task-list checkbox: marked sets task/checked on the list_item and
      // strips the `[ ]`/`[x]` from the item text. Re-emit it after the bullet
      // so todo state survives rendering (matches pi's TUI behaviour).
      const checkbox = listItem.task ? `[${listItem.checked ? 'x' : ' '}] ` : ''
      // Tint the marker (bullet or ordinal) with the list accent so the list
      // structure reads at a glance, matching pi's mdListBullet. Ordered and
      // unordered markers use the same accent; the checkbox stays uncoloured
      // so todo state (the [x]/[ ] glyph) isn't lost in the accent hue.
      const markerStyle = orderedListNumber === null ? theme.bullet : theme.listNumber
      const coloredMarker = markerStyle.paint(marker)
      const prefix = `${coloredMarker} ${checkbox}`
      const depthPad = '  '.repeat(listDepth)
      const firstIndent = `${depthPad}${prefix}`
      // terminalDisplayWidth strips ANSI before measuring, so the accent
      // colour on the marker doesn't inflate the continuation indent width.
      const restIndent = `${depthPad}${' '.repeat(terminalDisplayWidth(prefix))}`

      let emittedFirstText = false
      return (token.tokens ?? [])
        .map(t => {
          if (t.type === 'list') {
            return formatToken(t, listDepth + 1, null, token, theme)
          }
          if (t.type === 'space') {
            return EOL
          }
          if (t.type === 'text' || t.type === 'paragraph') {
            const inner = t.tokens
              ? t.tokens.map(child => formatToken(child, listDepth + 1, orderedListNumber, t, theme)).join('')
              : linkifyIssueRefs(applyPangu(t.text))
            const startIndent = emittedFirstText ? restIndent : firstIndent
            emittedFirstText = true
            return `${wrapDisplayTextWithIndent(inner, startIndent, restIndent)}${EOL}`
          }
          const rendered = formatToken(t, listDepth + 1, orderedListNumber, token, theme)
          const trimmed = rendered.replace(/\n$/, '')
          const lines = trimmed.split(EOL)
          return lines
            .map((line, index) => {
              if (!emittedFirstText && index === 0) {
                emittedFirstText = true
                return `${firstIndent}${line}`
              }
              return line.length > 0 ? `${restIndent}${line}` : line
            })
            .join(EOL) + (rendered.endsWith(EOL) ? EOL : '')
        })
        .join('')
    }
    case 'paragraph': {
      const rendered = (token.tokens ?? [])
        .map(t => formatToken(t, 0, null, null, theme))
        .join('')
      // Preserve verbatim whenever the paragraph contains box-drawing
      // characters (U+2500–U+257F) — these indicate tree/diagram art whose
      // indentation must not be reflowed. Otherwise soft-wrap long lines so
      // very wide output stays readable on narrow terminals.
      if (BOX_DRAWING_RE.test(stripAnsi(rendered))) {
        return rendered + EOL
      }
      if (rendered.includes(EOL)) {
        return wrapParagraph(rendered) + EOL
      }
      return wrapParagraph(rendered)
        .split(EOL)
        .map(line => line.trimStart())
        .join(EOL) + EOL
    }
    case 'space':
      return EOL
    case 'br':
      return EOL
    case 'text': {
      if (parent?.type === 'link') {
        return token.text
      }
      if (token.tokens) {
        return token.tokens.map(t => formatToken(t, listDepth, orderedListNumber, token, theme)).join('')
      }
      // Plain text nodes: emit verbatim (claudecode-style). Do not soft-wrap
      // here — marked keeps the original newlines/indentation in token.text
      // (including tree-art and box-drawing lines), and re-wrapping here
      // collapses multi-space indentation. Apply pangu spacing so mixed
      // CJK/Latin prose ("一条trace") gets a breathable space.
      return linkifyIssueRefs(applyPangu(token.text))
    }
    case 'table': {
      const tableToken = token as Tokens.Table
      const numCols = tableToken.header.length
      const termWidth = terminalContentWidth()
      const MIN_COL = 3

      // --- helpers ---
      function renderCell(tokens: Token[] | undefined): string {
        return tokens?.map(t => formatToken(t, 0, null, null, theme)).join('').trimEnd() ?? ''
      }
      function plainText(tokens: Token[] | undefined): string {
        return stripAnsi(renderCell(tokens))
      }
      function visualLineWidths(tokens: Token[] | undefined): number[] {
        const lines = plainText(tokens).split(EOL)
        return lines.length > 0 ? lines.map(line => terminalDisplayWidth(line)) : [0]
      }
      function longestWord(tokens: Token[] | undefined): number {
        const words = plainText(tokens).split(/\s+/).filter(w => w.length > 0)
        if (words.length === 0) return MIN_COL
        return Math.max(...words.map(w => terminalDisplayWidth(w)), MIN_COL)
      }
      function idealWidth(tokens: Token[] | undefined): number {
        return Math.max(...visualLineWidths(tokens), MIN_COL)
      }

      // --- column width calculation ---
      const minWidths = tableToken.header.map((h, ci) => {
        let w = longestWord(h.tokens)
        for (const row of tableToken.rows) w = Math.max(w, longestWord(row[ci]?.tokens))
        return w
      })
      const idealWidths = tableToken.header.map((h, ci) => {
        let w = idealWidth(h.tokens)
        for (const row of tableToken.rows) w = Math.max(w, idealWidth(row[ci]?.tokens))
        return w
      })

      // border overhead: │ cell │ cell │ = 1 + numCols * 3
      const borderOverhead = 1 + numCols * 3
      const available = Math.max(termWidth - borderOverhead - SAFETY_MARGIN, numCols * MIN_COL)
      const totalIdeal = idealWidths.reduce((s, w) => s + w, 0)
      const totalMin = minWidths.reduce((s, w) => s + w, 0)

      let colWidths: number[]
      if (totalIdeal <= available) {
        colWidths = idealWidths
      } else if (totalMin > available) {
        // Table wider than terminal at minimum widths — shrink proportionally
        const scaleFactor = available / totalMin
        colWidths = minWidths.map(w => Math.max(Math.floor(w * scaleFactor), MIN_COL))
      } else {
        // give each column its min, distribute remaining proportionally
        colWidths = [...minWidths]
        let remaining = available - totalMin
        const extras = idealWidths.map((ideal, i) => ideal - minWidths[i]!)
        const totalExtra = extras.reduce((s, e) => s + e, 0)
        if (totalExtra > 0) {
          for (let i = 0; i < numCols; i++) {
            const share = Math.floor((extras[i]! / totalExtra) * remaining)
            colWidths[i] = colWidths[i]! + share
          }
        }
      }

      // --- ANSI-aware word wrap (CJK-safe) via the shared primitive ---
      function wrapCell(text: string, width: number): string[] {
        if (width <= 0) return [text]
        const trimmed = text.trimEnd()
        const lines = wrapTextWithAnsi(trimmed, width).filter(line => line.length > 0)
        return lines.length > 0 ? lines : ['']
      }

      // --- vertical key-value fallback ---
      // Used only when the rendered horizontal table genuinely does not fit
      // in the terminal (see safety check after the table body is built).
      // We intentionally do NOT flip to this form based on per-cell line
      // count: CJK-heavy cells wrap often and demoting a legitimate table
      // into `label: value` lines separated by `────` loses the column
      // structure the author wrote the table for.
      function renderVerticalFormat(): string {
        const headers = tableToken.header.map(h => plainText(h.tokens))
        const separatorWidth = Math.max(0, Math.min(termWidth - 1, 40))
        const separator = '─'.repeat(separatorWidth)
        const wrapIndent = '  '
        const vLines: string[] = []

        tableToken.rows.forEach((row, ri) => {
          if (ri > 0) vLines.push(separator)
          row.forEach((cell, ci) => {
            const label = headers[ci] || `Column ${ci + 1}`
            const rawValue = renderCell(cell.tokens).trimEnd()
            const value = rawValue.replace(/\n+/g, ' ').replace(/\s+/g, ' ').trim()

            // Two-pass wrap: first line is narrower (label takes space),
            // continuation lines get the full width minus indent.
            const firstLineWidth = termWidth - terminalDisplayWidth(label) - 3
            const subsequentLineWidth = termWidth - wrapIndent.length - 1
            const firstPassLines = wrapCell(value, Math.max(firstLineWidth, 10))
            const firstLine = firstPassLines[0] || ''

            let wrappedValue: string[]
            if (firstPassLines.length <= 1 || subsequentLineWidth <= firstLineWidth) {
              wrappedValue = firstPassLines
            } else {
              // Re-join remaining text and re-wrap to the wider continuation width
              const remainingText = firstPassLines.slice(1).map(l => stripAnsi(l).trim()).join(' ')
              const rewrapped = wrapCell(remainingText, subsequentLineWidth)
              wrappedValue = [firstLine, ...rewrapped]
            }

            vLines.push(`${theme.tableHeader.paint(label)}: ${wrappedValue[0] || ''}`)
            for (let i = 1; i < wrappedValue.length; i++) {
              const ln = wrappedValue[i]!
              if (!stripAnsi(ln).trim()) continue
              vLines.push(`${wrapIndent}${ln}`)
            }
          })
        })
        return vLines.join(EOL) + EOL
      }

      // --- horizontal table with wrapping ---
      function borderLine(left: string, mid: string, cross: string, right: string): string {
        let line = left
        colWidths.forEach((w, i) => {
          line += mid.repeat(w + 2)
          line += i < numCols - 1 ? cross : right
        })
        // Same gray as diagram box-drawing (theme.tableBorder) so tables
        // read as structure, not as body text.
        return theme.tableBorder.paint(line)
      }
      function renderRow(cells: { tokens?: Token[] }[], forceCenter = false): string {
        const wrapped = cells.map((cell, ci) =>
          wrapCell(renderCell(cell.tokens), colWidths[ci]!),
        )
        const height = Math.max(...wrapped.map(w => w.length))
        const lines: string[] = []
        const bar = theme.tableBorder.paint('│')
        for (let li = 0; li < height; li++) {
          let line = bar
          for (let ci = 0; ci < numCols; ci++) {
            // Vertical centering: offset content lines to the middle
            const cellLines = wrapped[ci]!
            const vPad = Math.floor((height - cellLines.length) / 2)
            const vi = li - vPad
            const content = (vi >= 0 && vi < cellLines.length) ? cellLines[vi]! : ''
            const dw = terminalDisplayWidth(content)
            const align = forceCenter ? 'center' : tableToken.align?.[ci]
            line += ' ' + padAligned(content, dw, colWidths[ci]!, align) + ' ' + bar
          }
          lines.push(line)
        }
        return lines.join(EOL)
      }

      const tableLines: string[] = []
      tableLines.push(borderLine('┌', '─', '┬', '┐'))
      tableLines.push(renderRow(tableToken.header, true))
      tableLines.push(borderLine('├', '─', '┼', '┤'))
      tableToken.rows.forEach((row, ri) => {
        tableLines.push(renderRow(row))
        if (ri < tableToken.rows.length - 1) {
          tableLines.push(borderLine('├', '─', '┼', '┤'))
        }
      })
      tableLines.push(borderLine('└', '─', '┴', '┘'))

      // Safety check: if any single rendered line exceeds terminal width
      // (e.g. terminal resized between width computation and render), fall
      // back to the vertical form. Row strings built by renderRow can span
      // multiple visual lines (wrapped cells), so split on EOL first before
      // measuring — otherwise stringWidth effectively sums the widths of
      // every wrapped line in the row, which trips the guard on every CJK
      // row and silently destroys the table layout.
      const maxLineWidth = Math.max(
        ...tableLines.flatMap(chunk => chunk.split(EOL).map(l => terminalDisplayWidth(l))),
      )
      if (maxLineWidth > termWidth) {
        return renderVerticalFormat() + EOL
      }

      return tableLines.join(EOL) + EOL + EOL
    }
    case 'escape':
      return token.text
    case 'image':
      return token.href
    case 'def':
      return ''
    case 'html': {
      // `marked` lexes `<br>` as an html token. It's the most common inline
      // HTML models emit — especially inside table cells, where it's the
      // canonical way to force a line break (GFM tables don't support
      // literal newlines inside cells). Convert it to an actual newline so
      // downstream wrapping sees the intended break; strip everything else.
      const raw = (token as Tokens.HTML).text ?? (token as Tokens.HTML).raw ?? ''
      if (/^\s*<\s*br\s*\/?\s*>\s*$/i.test(raw)) return EOL
      return ''
    }
    default:
      return ''
  }
}

/**
 * Pad content to targetWidth respecting alignment.
 * displayWidth is the visible width (caller computes via stringWidth on
 * stripAnsi'd text, so ANSI codes don't affect padding).
 */
function padAligned(
  content: string,
  displayWidth: number,
  targetWidth: number,
  align: string | null | undefined,
): string {
  const padding = Math.max(0, Number.isFinite(targetWidth - displayWidth) ? Math.floor(targetWidth - displayWidth) : 0)
  if (align === 'center') {
    const left = Math.floor(padding / 2)
    return ' '.repeat(left) + content + ' '.repeat(padding - left)
  }
  if (align === 'right') {
    return ' '.repeat(padding) + content
  }
  return content + ' '.repeat(padding)
}

// ---------------------------------------------------------------------------
// Ordered list numbering — depth-aware (number → letter → roman)
// ---------------------------------------------------------------------------

function getListNumber(listDepth: number, n: number): string {
  switch (listDepth) {
    case 0:
    case 1:
      return n.toString()
    case 2:
      return numberToLetter(n)
    case 3:
      return numberToRoman(n)
    default:
      return n.toString()
  }
}

function numberToLetter(n: number): string {
  let result = ''
  while (n > 0) {
    n--
    result = String.fromCharCode(97 + (n % 26)) + result
    n = Math.floor(n / 26)
  }
  return result
}

const ROMAN_VALUES: ReadonlyArray<[number, string]> = [
  [1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'],
  [100, 'c'], [90, 'xc'], [50, 'l'], [40, 'xl'],
  [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i'],
]

function numberToRoman(n: number): string {
  let result = ''
  for (const [value, numeral] of ROMAN_VALUES) {
    while (n >= value) {
      result += numeral
      n -= value
    }
  }
  return result
}

const BLOCK_TYPES = new Set([
  'paragraph', 'code', 'heading', 'list', 'blockquote', 'hr', 'table', 'math_block',
])

// ---------------------------------------------------------------------------
// Per-token render cache (streaming hot path)
//
// The live assistant message is re-rendered on every paint while it grows.
// Lexing must stay whole-document (later input can move earlier block
// boundaries), but formatting one top-level token is a pure function of
// (token.raw, theme, terminal width). Stable tokens — finished paragraphs,
// highlighted code fences, built tables — are therefore reused across paints,
// and only the still-growing tail token re-formats. The tail is deliberately
// never cached: its raw changes on every delta and would only churn the LRU.
// ---------------------------------------------------------------------------
const TOKEN_CACHE_MAX = 500
const tokenRenderCache = new Map<string, string>()
let tokenCacheTheme: Theme | null = null
let tokenCacheWidth = -1

function tokenCacheKey(token: Token): string | null {
  const raw = (token as { raw?: string }).raw
  if (typeof raw !== 'string' || raw.length === 0) return null
  // Long raws (big code fences) are keyed by length + hash + boundary chars
  // instead of the full text to keep key comparison cheap.
  const body = raw.length > 4096
    ? `#${raw.length}:${hashString(raw)}:${raw.slice(0, 32)}:${raw.slice(-32)}`
    : raw
  return `${token.type}\0${body}`
}

function hashString(s: string): string {
  let h = 0
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0
  }
  return h.toString(36)
}

function cachedFormatToken(token: Token, theme: Theme, cacheable: boolean): string {
  const key = cacheable ? tokenCacheKey(token) : null
  if (key !== null) {
    const hit = tokenRenderCache.get(key)
    if (hit !== undefined) {
      // LRU touch.
      tokenRenderCache.delete(key)
      tokenRenderCache.set(key, hit)
      return hit
    }
  }
  const rendered = formatToken(token, 0, null, null, theme)
  if (key !== null) {
    tokenRenderCache.set(key, rendered)
    if (tokenRenderCache.size > TOKEN_CACHE_MAX) {
      const first = tokenRenderCache.keys().next().value
      if (first !== undefined) tokenRenderCache.delete(first)
    }
  }
  return rendered
}

export interface FormatTokensOptions {
  blockSpacing?: 'normal' | 'compact'
}

export function formatTokens(tokens: Token[], options: FormatTokensOptions = {}): string {
  const theme = getTheme()
  // Rendered output wraps at terminal width and paints with the active theme;
  // either changing invalidates every cached token.
  const width = terminalContentWidth()
  if (theme !== tokenCacheTheme || width !== tokenCacheWidth) {
    tokenRenderCache.clear()
    tokenCacheTheme = theme
    tokenCacheWidth = width
  }
  let out = ''
  let prevWasBlock = false
  let prevWasHeading = false

  // The trailing content token is still growing during streaming; formatting
  // it is never cached (see cache note above).
  let lastContentIndex = -1
  for (let index = tokens.length - 1; index >= 0; index--) {
    const type = tokens[index]?.type
    if (type === 'space' || type === 'html') continue
    lastContentIndex = index
    break
  }

  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!
    if (options.blockSpacing === 'compact' && (token.type === 'space' || token.type === 'html')) {
      continue
    }
    const rendered = cachedFormatToken(token, theme, index !== lastContentIndex)
    if (!rendered) continue
    const isBlock = BLOCK_TYPES.has(token.type)
    const isHeading = token.type === 'heading'
    // Insert a blank line between consecutive block-level elements. Compact
    // thinking collapses ordinary paragraph/list gaps, but headings still need
    // a row of air or they glue to the previous block (`###` sitting on the
    // last prose line).
    if (isBlock && prevWasBlock && (
      options.blockSpacing !== 'compact' || isHeading || prevWasHeading
    )) {
      out += EOL
    }
    out += rendered
    prevWasBlock = isBlock
    if (isBlock) prevWasHeading = isHeading
  }

  // Strip only leading/trailing newlines. `.trim()` would also eat leading
  // spaces — which corrupts tree/box-drawing art where the first line relies
  // on indentation to line up with deeper nodes below it.
  return out.replace(/^\n+|\n+$/g, '')
}


