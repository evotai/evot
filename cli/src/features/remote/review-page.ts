import { createHash } from 'node:crypto'
import { phonePalette } from './phone-palette.js'
import css from './review.css' with { type:'text' }
import script from './review-client.js' with { type:'text' }

const styles = phonePalette + '\n' + css
const hash = (s:string) => `'sha256-${createHash('sha256').update(s).digest('base64')}'`
const icon = (path:string) => `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${path}"/></svg>`
export const reviewPage = {
  csp:`default-src 'none'; connect-src 'self'; script-src ${hash(script)}; style-src ${hash(styles)}; frame-ancestors 'self'; base-uri 'none'; form-action 'none'`,
  html:`<!doctype html><html lang="en" class="remote-shell"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>Changes · evot remote</title><style>${styles}</style>
<header><button id="back" title="Back to chat" aria-label="Back to chat">${icon('m14 5-7 7 7 7')}</button><div class="identity"><h1>Changes</h1><div id="folder"></div></div><button id="refresh" title="Refresh changes" aria-label="Refresh changes">${icon('M20 4v6h-6m5.5-1a8 8 0 1 0 .2 6')}</button></header>
<main><nav aria-label="Review controls"><span class="picker"><span id="count"></span><select id="jump" hidden aria-label="Jump to file"></select></span><div id="layout" hidden role="group" aria-label="Diff layout"><button id="unified">Unified</button><button id="split">Split</button></div></nav><p id="message" role="status">Loading changes…</p><div id="files"></div></main><script data-cfasync="false">${script}</script></html>`,
}
