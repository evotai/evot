/**
 * Markdown rendering facade for terminal output.
 *
 * Pipeline:
 *   raw markdown
 *   → minimal fence-boundary repair (glued opens / stray closes / unclosed)
 *   → escape `|` inside inline code on table rows (GFM cell pipes)
 *   → marked lexer (partial closing fences trimmed for streaming stability)
 *   → ANSI token renderer
 *
 * Fence repair is intentionally narrow: only cases where an unpaired or glued
 * fence would otherwise swallow subsequent headings/tables/prose as a single
 * code block. Broader glue-normalization (tables/headings/hr) stays off so
 * well-formed model output still renders as-is (pi-aligned).
 */

import { prepareMarkdownFences } from '../markdown/normalize/fences/index.js'
import { escapePipesInTableInlineCode } from '../markdown/normalize/tables.js'
import { lexMarkdownTokens } from '../markdown/parse/marked.js'
import { formatTokens } from '../markdown/render/ansi.js'

/**
 * Render markdown text to terminal-friendly ANSI output.
 */
export interface MarkdownRenderOptions {
  blockSpacing?: 'normal' | 'compact'
  streaming?: boolean
}

export function renderMarkdown(text: string, options: MarkdownRenderOptions = {}): string {
  if (!text || text.trim().length === 0) return text

  try {
    // Tabs → spaces (matches pi), then repair fence boundaries and table cell
    // pipes inside inline code before lex.
    const lexText = escapePipesInTableInlineCode(
      prepareMarkdownFences(text.replace(/\t/g, '   ')),
    )
    const tokens = lexMarkdownTokens(lexText, text)
    return formatTokens(tokens, {
      blockSpacing: options.blockSpacing,
    })
  } catch {
    return text
  }
}

export function renderThinkingMarkdown(
  text: string,
  options: { streaming?: boolean } = {},
): string {
  return renderMarkdown(text, { blockSpacing: 'compact', streaming: options.streaming })
}
