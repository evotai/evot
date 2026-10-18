import { readdirSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type { CompletionResult } from './completion.js'

interface PathToken {
  word: string
  wordStart: number
  wordEnd: number
  quote?: string
}

/** Lexical path boundaries, with no filesystem traversal. Quoted and escaped
 * spaces are part of the path; URLs are never truncated into fake local paths. */
function pathToken(line: string, cursor: number): PathToken | null {
  const contiguous = /\S+$/u.exec(line.slice(0, cursor))?.[0] ?? ''
  if (/[a-z][a-z\d+.-]*:\/\//iu.test(contiguous) || /^mailto:/iu.test(contiguous)) return null
  let start = 0
  let quote: string | undefined
  let closedAt: number | undefined
  let escaped = false
  for (let i = 0; i < cursor; i++) {
    const ch = line[i]!
    if (escaped) { escaped = false; continue }
    if (ch === '\\') { escaped = true; continue }
    if (quote) {
      if (ch === quote) { closedAt = i; quote = undefined }
      continue
    }
    if (ch === '"' || ch === "'") { quote = ch; start = i + 1; closedAt = undefined }
    else if (/\s|[()[\]{}=<>]/u.test(ch)) { start = i + 1; closedAt = undefined }
  }
  const endOfPrefix = closedAt ?? cursor
  if (endOfPrefix <= start) return null
  let raw = line.slice(start, endOfPrefix)
  if (/^[a-z][a-z\d+.-]*:/i.test(raw) || /^[^\s]+@[^\s]+:/u.test(raw)) return null
  // Preserve the existing ability to complete an explicit path glued to
  // non-Latin prose, while retaining Unicode inside the path itself.
  if (!/^(?:\.{1,2}\/|~\/|\/)/u.test(raw)) {
    const marker = /(?:\.{1,2}\/|~\/)/gu
    for (const match of raw.matchAll(marker)) {
      const previous = raw.slice(0, match.index)
      if (previous && /[^\x00-\x7f]$/u.test(previous)) {
        start += match.index
        raw = raw.slice(match.index)
        break
      }
    }
  }
  const word = raw.replace(/\\(.)/gu, '$1')
  if (!word.includes('/')) return null
  const delimiter = quote ?? (closedAt !== undefined ? line[start - 1] : undefined)
  let end = closedAt ?? cursor
  if (closedAt === undefined) {
    let escape = false
    while (end < line.length) {
      const ch = line[end]!
      if (escape) { escape = false; end++; continue }
      if (ch === '\\') { escape = true; end++; continue }
      if (ch === '/' || ch === delimiter || (!delimiter && /\s|[()[\]{}<>"']/u.test(ch))) break
      end++
    }
  }
  return { word, wordStart: start, wordEnd: end, ...(delimiter ? { quote: delimiter } : {}) }
}

function directoryExists(path: string): boolean {
  try { return statSync(path).isDirectory() } catch { return false }
}

/** Explicit paths remain local even when nonexistent. Ambiguous `A/B`-style
 * text needs directory evidence or a filename extension, not just a slash. */
export function resolvePathTarget(line: string, cursor: number): PathToken | null {
  const token = pathToken(line, cursor)
  if (!token) return null
  if (/^(?:\.{1,2}\/|~\/|\/)/u.test(token.word)) return token
  if (/^\d+(?:\/\d+)+$/u.test(token.word)) return null
  const root = token.word.split('/')[0] ?? ''
  if (directoryExists(root)) return token
  if (/^[a-z](?:\/[a-z])+$/iu.test(token.word)) return null
  return /\.[\p{L}\p{N}][\p{L}\p{N}_.-]*$/u.test(basename(token.word)) ? token : null
}

function renderPath(path: string, quote?: string): string {
  if (quote) return path.replaceAll('\\', '\\\\').replaceAll(quote, `\\${quote}`)
  return path.replace(/[\\\s"'()[\]{}<>]/gu, ch => `\\${ch}`)
}

export function completePath(target: PathToken, cursor: number): CompletionResult | null {
  const { word } = target
  const expanded = word.startsWith('~') ? (process.env.HOME ?? '') + word.slice(1) : word
  const dir = expanded.endsWith('/') ? expanded : dirname(expanded) || '.'
  const prefix = expanded.endsWith('/') ? '' : basename(expanded)
  let entries: string[]
  try { entries = readdirSync(dir) } catch { return null }
  const matches = entries.filter(entry => prefix ? entry.startsWith(prefix) : !entry.startsWith('.')).sort()
  if (!matches.length) return null
  const dirPrefix = word.endsWith('/') ? word : word.slice(0, word.length - prefix.length)
  const candidates = matches.map(entry => renderPath(dirPrefix + entry + (directoryExists(join(dir, entry)) ? '/' : ''), target.quote))
  let replacement = candidates[0] ?? ''
  for (const candidate of candidates.slice(1)) {
    let end = 0
    while (end < replacement.length && replacement[end] === candidate[end]) end++
    replacement = replacement.slice(0, end)
  }
  return { replacement, candidates, wordStart: target.wordStart, ...(target.wordEnd !== cursor ? { wordEnd: target.wordEnd } : {}) }
}
