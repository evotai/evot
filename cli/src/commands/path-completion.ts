import { readdirSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { pathToken, type PathToken } from '../ui/path-token.js'
import type { CompletionResult } from './completion.js'

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
