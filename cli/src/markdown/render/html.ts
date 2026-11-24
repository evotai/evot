/**
 * The TUI's Markdown, laid out as HTML for the phone. Same pipeline as
 * `render/markdown.ts` (fence repair, table pipes, the marked lexer with the
 * math and CJK extensions) and the same choices per token as `ansi.ts`:
 * pangu spacing, `###` prefixes from H3, link text when the target can be
 * opened (the TUI's OSC 8 rule; the phone can always open a link), mailto as
 * its bare address, box/arrow art without a fence. Only layout differs: prose
 * reflows to the phone's width instead of the terminal's.
 *
 * Every text node and attribute is escaped here; the phone inserts the result.
 * Styling is by class only (`md-*`, `hljs-*`), coloured from the TUI theme.
 */
import type { Token, Tokens } from 'marked'
import hljs from 'highlight.js'
import { prepareMarkdownFences } from '../normalize/fences/index.js'
import { escapePipesInTableInlineCode } from '../normalize/tables.js'
import { lexMarkdownTokens } from '../parse/marked.js'
import { renderLatexMath } from '../math/ansi.js'
import type { MathToken } from '../math/marked.js'
import { alignTrailingCodeComments, applyPangu, codeBlockLanguage, normalizeDiagramIndent } from './ansi.js'

const escape = (text: string) => text.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
const plain = (text: string) => text.replace(/\x1b\[[\d;]*m/g, '')
const safeHref = (href: string) => /^https?:\/\/[^\s"'<>]+$/i.test(href)
const children = (tokens: Token[] | undefined, depth = 0) => (tokens ?? []).map(t => html(t, depth)).join('')

function codeBlock(text: string, lang: string | undefined): string {
  const language = codeBlockLanguage(text, lang)
  if (language === null) return `<pre class="md-diagram">${escape(normalizeDiagramIndent(text))}</pre>`
  const aligned = alignTrailingCodeComments(text, language)
  let body = escape(aligned)
  if (language !== 'plaintext' && hljs.getLanguage(language)) {
    try { body = hljs.highlight(aligned, { language, ignoreIllegals: true }).value } catch { /* plain, as in the TUI */ }
  }
  // The fence label echoes the author's first info word, like the TUI's ```lang line.
  const label = language === 'plaintext' ? 'text' : (lang ?? '').trim().split(/\s+/)[0] || language
  return '<div class="code-block"><div class="code-head"><span class="code-lang">' + escape(label) + '</span>' +
    '<button class="code-copy" type="button" data-copy-code aria-label="Copy code">⧉</button></div><pre><code>' + body + '</code></pre></div>'
}

function html(token: Token, depth = 0): string {
  switch (token.type) {
    case 'paragraph': return `<p>${children(token.tokens)}</p>`
    case 'text':
      return token.tokens ? children(token.tokens, depth) : escape(applyPangu((token as Tokens.Text).text))
    case 'escape': return escape(token.text)
    case 'strong': return `<strong class="md-strong">${children(token.tokens)}</strong>`
    case 'em': return `<em class="md-em">${children(token.tokens)}</em>`
    case 'codespan': return `<code class="md-code">${escape(token.text)}</code>`
    case 'br': return '<br>'
    case 'del': return ''
    case 'heading': {
      const { depth: level } = token as Tokens.Heading
      const prefix = level >= 3 ? '#'.repeat(level) + ' ' : ''
      const tag = 'h' + Math.min(6, level + 1)
      return `<${tag} class="md-h${level}">${escape(prefix)}${children(token.tokens)}</${tag}>`
    }
    case 'hr': return '<hr class="md-hr">'
    case 'blockquote': return `<blockquote class="md-quote">${children(token.tokens)}</blockquote>`
    case 'link': {
      const href = (token as Tokens.Link).href
      if (href.startsWith('mailto:')) return escape(href.slice(7))
      const text = children(token.tokens)
      if (!safeHref(href)) return text || escape(href)
      return `<a class="md-link" href="${escape(href)}" target="_blank" rel="noopener noreferrer">${text || escape(href)}</a>`
    }
    case 'image': return safeHref(token.href) ? `<a class="md-link" href="${escape(token.href)}" target="_blank" rel="noopener noreferrer">${escape(token.href)}</a>` : escape(token.href)
    case 'list': {
      const list = token as Tokens.List
      const tag = list.ordered ? 'ol' : 'ul'
      const start = list.ordered && list.start !== 1 && typeof list.start === 'number' ? ` start="${list.start}"` : ''
      return `<${tag} class="md-list md-depth-${Math.min(depth, 3)}"${start}>${list.items.map(item => html(item, depth)).join('')}</${tag}>`
    }
    case 'list_item': {
      const item = token as Tokens.ListItem
      const box = item.task ? `[${item.checked ? 'x' : ' '}] ` : ''
      const body = (item.tokens ?? []).map(t => t.type === 'list' ? html(t, depth + 1) : t.type === 'text' && !t.tokens
        ? escape(applyPangu((t as Tokens.Text).text)) : t.type === 'text' ? children(t.tokens, depth) : html(t, depth)).join('')
      return `<li>${escape(box)}${body}</li>`
    }
    case 'code': return codeBlock((token as Tokens.Code).text, (token as Tokens.Code).lang)
    case 'math_block': return `<div class="md-math">${escape(plain(renderLatexMath((token as unknown as MathToken).text)))}</div>`
    case 'math_inline': return `<span class="md-math">${escape(plain(renderLatexMath((token as unknown as MathToken).text)))}</span>`
    case 'table': {
      const table = token as Tokens.Table
      const align = (i: number) => table.align[i] === 'center' || table.align[i] === 'right' ? ` class="md-${table.align[i]}"` : ''
      const head = table.header.map((cell, i) => `<th${align(i)}>${children(cell.tokens)}</th>`).join('')
      const rows = table.rows.map(row => `<tr>${row.map((cell, i) => `<td${align(i)}>${children(cell.tokens)}</td>`).join('')}</tr>`).join('')
      return `<div class="table-wrap"><table class="md-table"><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table></div>`
    }
    case 'html': return /^\s*<\s*br\s*\/?\s*>\s*$/i.test((token as Tokens.HTML).text ?? '') ? '<br>' : ''
    case 'space': case 'def': return ''
    default: return 'text' in token && typeof token.text === 'string' ? escape(token.text) : ''
  }
}

const cache = new Map<string, string>()
/** HTML for an assistant text block; the last 64 results are reused across polls. */
export function markdownToHtml(text: string): string {
  const hit = cache.get(text)
  if (hit !== undefined) { cache.delete(text); cache.set(text, hit); return hit }
  let out: string
  try {
    const lexText = escapePipesInTableInlineCode(prepareMarkdownFences(text.replace(/\t/g, '   ')))
    out = lexMarkdownTokens(lexText, text).map(t => html(t)).join('')
  } catch {
    out = `<p>${escape(text)}</p>`
  }
  cache.set(text, out)
  if (cache.size > 64) cache.delete(cache.keys().next().value!)
  return out
}
