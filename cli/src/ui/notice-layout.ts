/** Portable command presentation. Neither ANSI, HTML, nor theme state belongs here. */
export type NoticeTone = 'body' | 'muted' | 'label' | 'success' | 'error'

export interface NoticeSpan {
  text: string
  tone?: NoticeTone
  /** A link is its own visible label; no hidden destination is transferred. */
  link?: true
}

export interface CommandNotice {
  message: string
  state?: 'info' | 'progress' | 'success' | 'error'
  label?: string
  /** Unindented detail rows; empty rows retain paragraph spacing. */
  details?: string[]
}

export const SECTION_INDENT = 2
export const SECTION_CONTENT_INDENT = 4

const markers = {
  progress: { text: '⋯', tone: 'muted' },
  success: { text: '✓', tone: 'success' },
  error: { text: '✗', tone: 'error' },
} as const satisfies Record<string, NoticeSpan>

export function layoutCommandNotice({ state = 'info', label, message, details }: CommandNotice): NoticeSpan[] {
  const spans: NoticeSpan[] = [{ text: ' '.repeat(SECTION_INDENT) }]
  if (state !== 'info') spans.push(markers[state], { text: ' ' })
  if (label) spans.push({ text: label, tone: 'label' }, { text: '  ' })
  spans.push({ text: message, tone: state === 'error' ? 'body' : 'muted' })
  for (const detail of details ?? []) {
    spans.push({ text: '\n' })
    if (detail) spans.push({ text: ' '.repeat(SECTION_CONTENT_INDENT) + detail, tone: 'muted' })
  }
  return spans
}

export function noticeResult(text: string, link?: string): NoticeSpan[] {
  const at = link && noticeHref(link) ? text.indexOf(link) : -1
  if (at === -1 || !link) return [{ text, tone: 'body' }]
  return [{ text: text.slice(0, at), tone: 'body' }, { text: link, link: true }, { text: text.slice(at + link.length), tone: 'body' }]
}

/** Shared by both adapters: credential-bearing, opaque or malformed URLs stay plain text. */
export function noticeHref(label: string): string | undefined {
  if (!/^https?:\/\/[^\s<>\\\u0000-\u001f\u007f]+$/i.test(label)) return undefined
  try {
    const url = new URL(label)
    return url.username || url.password ? undefined : url.href
  } catch { return undefined }
}
