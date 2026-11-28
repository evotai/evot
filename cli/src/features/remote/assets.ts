// Build-time allowlist, not a file server or a proxy to localhost. The page shares
// only the product palette and base styles (app.css, theme.css/js) with the console.
import { createHash } from 'node:crypto'
import { bundlePhone } from './browser-bundle.js' with { type: 'macro' }
import { spinnerFrames } from '../../ui/activity-frames.js'
import { darkTheme } from '../../ui/theme/dark.js'
import { lightTheme } from '../../ui/theme/light.js'
import { phonePalette } from './phone-palette.js'
import { markdownCss } from './markdown-css.js'
import appCss from '../../../../src/app/assets/console/ui/app.css' with { type: 'text' }
import chatCss from './chat-base.css' with { type: 'text' }
import themeCss from '../../../../src/app/assets/console/ui/theme.css' with { type: 'text' }
import chatTheme from './chat-theme.css' with { type: 'text' }
import themeJs from '../../../../src/app/assets/console/ui/theme.js' with { type: 'text' }
import phoneCss from './phone.css' with { type: 'text' }
import page from './phone.html' with { type: 'text' }


// Static build output only, never session or request data. The CSP authorizes
// these exact script and style bytes; do not relax it to unsafe-inline.
// Everything ships inline in one page: through a tunnel, each extra request is a
// round trip before the first paint, so a scan shows the page after one fetch.
const client = bundlePhone()
const css = [appCss, chatCss, themeCss, chatTheme, phonePalette, markdownCss(darkTheme(), lightTheme()), phoneCss].join('\n')
if (/<\/script\b/i.test(client) || /<\/script\b/i.test(themeJs)) throw Error('Remote browser script cannot be embedded in HTML')
if (/<\/style\b/i.test(css)) throw Error('Remote browser stylesheet cannot be embedded in HTML')
const sha = (text: string) => `'sha256-${createHash('sha256').update(text).digest('base64')}'`
export const phoneScriptHash = `${sha(themeJs)} ${sha(client)}`
export const phoneStyleHash = sha(css)
/** Identifies the served assets, including for older clients. A live chat need not reload them. */
export const phoneBuild = createHash('sha256').update(JSON.stringify([String(page), client, css, themeJs])).digest('base64url').slice(0, 16)
const html = String(page)
  .replace('class="remote-shell"', `class="remote-shell" data-build="${phoneBuild}" data-activity-frames="${spinnerFrames(process.platform, process.env.TERM).join(' ')}"`)
  .replace('<link rel="stylesheet" href="/chat.css"><script src="/theme.js"></script>', () => `<style>${css}</style><script data-theme-boot>${themeJs}</script>`)
  .replace('<!-- phone-client -->', () => `<script data-cfasync="false">${client}</script>`)
if (!html.includes('data-theme-boot')) throw Error('Remote page head changed; inline its assets again')
/** The page, its gzip form and a validator: a repeat scan revalidates instead of downloading. */
export const phonePage = { html, gzip: Bun.gzipSync(html), etag: `"${createHash('sha256').update(html).digest('base64url').slice(0, 22)}"` }
