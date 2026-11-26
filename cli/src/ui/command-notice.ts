import chalk from 'chalk'
import { wrapHyperlink } from './hyperlink.js'
import { layoutCommandNotice, noticeHref, type CommandNotice, type NoticeSpan } from './notice-layout.js'
import { getTheme } from './theme/index.js'

/** TUI adapter for the same spans the browser paints with its CSS theme. */
export function renderNoticeSpans(spans: readonly NoticeSpan[]): string {
  const theme = getTheme()
  return spans.map(({ text, tone, link }) => {
    const href = link ? noticeHref(text) : undefined
    if (href) return wrapHyperlink(href, theme.brand.paint(text))
    switch (tone) {
      case 'muted': return chalk.hex(theme.panelMutedFg)(text)
      case 'label': return theme.brandBold.paint(text)
      case 'success': return chalk.hex(theme.cursorHex)(text)
      case 'error': return chalk.hex(theme.errorHex)(text)
      default: return text
    }
  }).join('')
}

export function renderCommandNotice(notice: CommandNotice): string {
  return renderNoticeSpans(layoutCommandNotice(notice))
}

export function renderErrorNotice(message: string): string {
  return renderCommandNotice({ state: 'error', message })
}
