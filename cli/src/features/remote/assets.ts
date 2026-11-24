// Build-time allowlist, not a file server or a proxy to localhost. Both chat
// surfaces ship the same visual components and Markdown renderer, offline.
import { createHash } from 'node:crypto'
import { bundlePhone } from './browser-bundle.js' with { type: 'macro' }
import { darkTheme } from '../../ui/theme/dark.js'
import { lightTheme } from '../../ui/theme/light.js'
import type { Theme } from '../../ui/theme/types.js'
import { markdownCss } from './markdown-css.js'
import appCss from '../../../../src/app/assets/console/ui/app.css' with { type: 'text' }
import chatCss from '../../../../src/app/assets/console/ui/chat.css' with { type: 'text' }
import themeCss from '../../../../src/app/assets/console/ui/theme.css' with { type: 'text' }
import chatTheme from '../../../../src/app/assets/console/ui/chat-theme.css' with { type: 'text' }
import themeJs from '../../../../src/app/assets/console/ui/theme.js' with { type: 'text' }
import phoneCss from './phone.css' with { type: 'text' }
import page from './phone.html' with { type: 'text' }

// Emit plain CSS on the computer; the phone does not need chalk, a theme request,
// or a second copy of the TUI palette. The Console keeps its own theme.
function palette(t: Theme) {
  return `--accent:${t.brandHex}; --amber:${t.accentHex}; --green:${t.cursorHex}; --red:${t.errorHex};
    --ink:${t.panelFg}; --muted:${t.panelMutedFg}; --faint:${t.selectionMutedHex};
    --raised-bg:${t.panelBg}; --fill:${t.toolCardBg}; --accent-soft:${t.selectionBgHex};
    --diff-add-bg:${t.diffAddedBg}; --diff-remove-bg:${t.diffRemovedBg}; --diff-add-fg:${t.diffAddedFg}; --diff-remove-fg:${t.diffRemovedFg};
    --diff-add-word:${t.diffAddedWordBg}; --diff-remove-word:${t.diffRemovedWordBg}; --diff-gutter:${t.diffGutterFg};
    --diff-context:${t.diffContextFg}; --diff-header-fg:${t.diffHeaderFg}; --diff-header-bg:${t.diffHeaderBg};`
}
// Dark mode sits on the user's Warp theme, Fancy Dracula (warpdotdev/themes,
// warp_bundled/fancy_dracula.yaml): a #252630 → #3d3f4f vertical gradient. Cards,
// text and accents keep the TUI palette above, as the TUI draws them in that window.
const warp = { top: '#252630', bottom: '#3d3f4f' }
const darkBase = `--page:color-mix(in srgb,${warp.top},${warp.bottom}); --page-gradient:linear-gradient(180deg,${warp.top},${warp.bottom});
    --side-bg:${warp.top}; --bg:var(--raised-bg); --btn-ink:#1a1d24; --line:color-mix(in srgb,var(--ink) 12%,transparent);`
const phonePalette = `html.remote-shell:not([data-theme="light"]) { ${palette(darkTheme())} ${darkBase} }
  html.remote-shell[data-theme="light"] { ${palette(lightTheme())} --page-gradient:none; }
${markdownCss(darkTheme(), lightTheme())}`

// Static build output only, never session or request data. The CSP authorizes
// these exact script and style bytes; do not relax it to unsafe-inline.
// Everything ships inline in one page: through a tunnel, each extra request is a
// round trip before the first paint, so a scan shows the page after one fetch.
const client = bundlePhone()
const css = [appCss, chatCss, themeCss, chatTheme, phonePalette, phoneCss].join('\n')
if (/<\/script\b/i.test(client) || /<\/script\b/i.test(themeJs)) throw Error('Remote browser script cannot be embedded in HTML')
if (/<\/style\b/i.test(css)) throw Error('Remote browser stylesheet cannot be embedded in HTML')
const sha = (text: string) => `'sha256-${createHash('sha256').update(text).digest('base64')}'`
export const phoneScriptHash = `${sha(themeJs)} ${sha(client)}`
export const phoneStyleHash = sha(css)
const html = String(page)
  .replace('<link rel="stylesheet" href="/chat.css"><script src="/theme.js"></script>', () => `<style>${css}</style><script data-theme-boot>${themeJs}</script>`)
  .replace('<!-- phone-client -->', () => `<script data-cfasync="false">${client}</script>`)
if (!html.includes('data-theme-boot')) throw Error('Remote page head changed; inline its assets again')
/** The page, its gzip form and a validator: a repeat scan revalidates instead of downloading. */
export const phonePage = { html, gzip: Bun.gzipSync(html), etag: `"${createHash('sha256').update(html).digest('base64url').slice(0, 22)}"` }
