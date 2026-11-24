// Build-time allowlist, not a file server or a proxy to localhost. Both chat
// surfaces ship the same visual components and Markdown renderer, offline.
import { createHash } from 'node:crypto'
import { bundlePhone } from './browser-bundle.js' with { type: 'macro' }
import { darkTheme } from '../../ui/theme/dark.js'
import { lightTheme } from '../../ui/theme/light.js'
import type { Theme } from '../../ui/theme/types.js'
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
    --raised-bg:${t.panelBg}; --fill:${t.toolCardBg}; --accent-soft:${t.selectionBgHex};`
}
const phonePalette = `html.remote-shell { ${palette(darkTheme())} }
  html.remote-shell[data-theme="light"] { ${palette(lightTheme())} }`

// Static build output only, never session or request data. The CSP authorizes
// these exact script bytes; do not relax it to unsafe-inline.
const client = bundlePhone()
if (/<\/script\b/i.test(client)) throw Error('Remote browser bundle cannot be embedded in HTML')
export const phoneScriptHash = `'sha256-${createHash('sha256').update(client).digest('base64')}'`
export const phoneAssets = new Map<string, readonly [string, string]>([
  ['/', ['text/html', String(page).replace('<!-- phone-client -->', () => `<script data-cfasync="false">${client}</script>`)]],
  ['/chat.css', ['text/css', [appCss, chatCss, themeCss, chatTheme, phonePalette, phoneCss].join('\n')]],
  ['/theme.js', ['text/javascript', themeJs]],
])
