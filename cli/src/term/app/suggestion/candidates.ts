import type { SuggestionPosition } from './types.js'
import { parsePasteRefs } from '../../input/paste_refs.js'

const MAX_CANDIDATES = 3

/** A fixed local batch. Validation and selection know nothing about requests,
 * retries, sessions or rendering; cycling can never generate network traffic. */
export class SuggestionCandidates {
  private readonly candidates: string[] = []
  private index = 0
  private readonly references: string[]

  constructor(result: unknown, private readonly draft: string, private readonly allowsCommand: (text: string) => boolean,
    private readonly replacement?: { suffix: string; command?: string },
    private readonly validate: (text: string) => boolean = () => true,
    private readonly identity?: (text: string) => string | undefined) {
    this.references = parsePasteRefs(draft + (replacement?.suffix ?? '')).map(ref => ref.match)
    this.append(result)
  }

  /** Progressive batches only append; highlighted text does not change. */
  append(result: unknown): boolean {
    if (!Array.isArray(result) || this.candidates.length >= MAX_CANDIDATES) return false
    const before = this.candidates.length
    const { draft, replacement, allowsCommand } = this
    const rewriting = replacement !== undefined
    const seen = new Set(this.candidates.map(text => this.key(text)))
    for (const item of result) {
      if (typeof item !== 'string' || item.length > 320 || /[\p{Cc}\p{Cf}]/u.test(rewriting ? item.replaceAll('\n', '') : item)
        || (!rewriting && /^\s*[`<]/.test(item))) continue
      // A rewrite is literal replacement text, including line breaks/spaces.
      const text = rewriting ? item : draft ? item.trimEnd() : item.trim()
      if (!text.trim() || (replacement && text === replacement.suffix) || !this.accepts(text)) continue
      if (replacement?.command && (draft + text).trimStart().split(/\s+/, 1)[0] !== replacement.command) continue
      if (text.trimStart().startsWith('/') && (rewriting ? !draft.trim() && !allowsCommand(text) : draft || !allowsCommand(text))) continue
      const key = this.key(text)
      if (seen.has(key)) continue
      seen.add(key)
      this.candidates.push(text)
      if (this.candidates.length === MAX_CANDIDATES) break
    }
    return before !== this.candidates.length
  }

  /** Revalidate the final result without resetting the selected candidate. */
  finish(result: unknown): void {
    const selected = this.text()
    const final = new SuggestionCandidates(result, this.draft, this.allowsCommand, this.replacement, this.validate, this.identity)
    this.candidates.splice(0, this.candidates.length, ...final.candidates)
    this.index = Math.max(0, this.visible().indexOf(selected))
  }

  private key(text: string): string {
    return this.identity?.(this.draft + text) ?? text.trim().replace(/\s+/g, ' ').toLowerCase()
  }

  private accepts(text: string): boolean {
    const full = this.draft + text
    const refs = parsePasteRefs(full)
    return refs.length === this.references.length && refs.every((ref, index) => ref.match === this.references[index])
      && this.validate(full)
  }

  private visible(): string[] {
    return this.candidates.filter(text => (!text.startsWith('/') || this.allowsCommand(text)) && this.accepts(text))
  }

  values(): readonly string[] { return this.visible() }
  count(): number { return this.visible().length }

  text(): string {
    const visible = this.visible()
    return visible.length ? visible[this.index % visible.length] ?? '' : ''
  }

  position(): SuggestionPosition {
    const total = this.count()
    return total ? { current: (this.index % total) + 1, total } : { current: 1, total: 1 }
  }

  next(): boolean {
    const total = this.count()
    if (!total) return false
    this.index = (this.index + 1) % total
    return true
  }
}
