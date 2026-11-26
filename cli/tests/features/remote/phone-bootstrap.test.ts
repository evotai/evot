import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { phonePage } from '../../../src/features/remote/assets.js'
import { spinnerFrames } from '../../../src/ui/activity-frames.js'
import { DeviceStore } from '../../../src/features/remote/devices.js'
import { DeviceAccess } from '../../../src/features/remote/pairing.js'
import { listenRemote } from '../../../src/features/remote/server.js'

function embeddedClient(html: string) {
  const matches = [...html.matchAll(/<script data-cfasync="false">([\s\S]+?)<\/script>/g)]
  expect(matches).toHaveLength(1)
  return matches[0]![1]!
}

test('the public pairing page ships one complete client allowed by its CSP, with Connect inert until ready', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'evot-phone-boot-'))
  const gateway = listenRemote({snapshot(){throw Error('unused')},act(){}}, new DeviceAccess(new DeviceStore(dir),()=>{}))
  try {
    const r = await fetch(gateway.address), html = await r.text(), client = embeddedClient(html)
    expect(r.status).toBe(200)
    expect([...html.matchAll(/aria-keyshortcuts="([^"]+)"/g)].map(m => m[1])).toEqual(['Tab','Escape'])
    const draft = html.match(/<textarea id="draft"[^>]*>/)?.[0] ?? ''
    for (const attr of ['autocomplete="off"','autocorrect="off"','autocapitalize="none"','spellcheck="false"','writingsuggestions="false"']) expect(draft).toContain(attr)
    expect(draft).not.toContain('readonly')
    expect(draft).not.toContain('placeholder=') // fallback must not paint behind the shared hint
    expect(draft).toContain('aria-describedby="draftHint"')
    expect(html.match(/id="draftHint"/g)).toHaveLength(1)
    expect(html).toContain('<section class="composer-card" id="compose"')
    expect(html).toContain('<button id="send" type="button"')
    expect(html).toMatch(/id="writeMessage"[^>]*aria-label="Open composer"[^>]*inert>Message…/)
    const header = html.match(/<header class="conversation-head">[\s\S]*?<\/header>/)?.[0] ?? ''
    expect(header).toMatch(/id="completionSound"[^>]*aria-label="Round-end sound"[^>]*aria-pressed="false"[^>]*hidden/)
    expect(header).toMatch(/id="bgChip"[^>]*aria-controls="bgPanel"[^>]*hidden><evot-activity id="bgActivity" aria-hidden="true"/)
    expect(html.match(/id="bgChip"/g)).toHaveLength(1)
    expect(html).toMatch(/class="run-state"[^\n]*id="bgStatus"[^>]*aria-controls="bgPanel"/)
    expect(html).not.toContain('id="foldComposer"')
    expect(html).toContain('id="queueSummary" role="status" hidden')
    expect(html).toContain(`data-activity-frames="${spinnerFrames(process.platform, process.env.TERM).join(' ')}"`)
    expect(html).toMatch(/id="pair"[\s\S]*?<button[^>]*disabled[^>]*>Loading…<\/button>/)
    expect(new Bun.Transpiler({loader:'js'}).scanImports(client)).toEqual([])
    const csp = r.headers.get('content-security-policy') ?? ''
    expect(csp).toContain(`'sha256-${createHash('sha256').update(client).digest('base64')}'`)
    expect(csp).not.toMatch(/unsafe-(inline|eval)/)
    expect(csp).toContain("form-action 'none'")
    expect(r.headers.get('cache-control')).toContain('no-transform')
    // One fetch paints the page: styles and scripts are inline and hashed, nothing loads from 'self'.
    expect(html).not.toMatch(/<link\b|<script\b[^>]*\bsrc=/)
    for (const [, body] of html.matchAll(/<(?:script|style)\b[^>]*>([\s\S]*?)<\/(?:script|style)>/g))
      expect(csp).toContain(`'sha256-${createHash('sha256').update(body!).digest('base64')}'`)
    expect(csp).not.toContain("'self'; style-src 'self'")
    const zipped = await fetch(gateway.address, { headers: { 'accept-encoding': 'gzip' }, decompress: false } as RequestInit)
    expect(zipped.headers.get('content-encoding')).toBe('gzip')
    expect(Number(zipped.headers.get('content-length'))).toBeLessThan(html.length / 2)
    const again = await fetch(gateway.address, { headers: { 'if-none-match': r.headers.get('etag')! } })
    expect(again.status).toBe(304)
  } finally { gateway.close(); rmSync(dir, {recursive:true,force:true}) }
})

test('a browser blocking tab storage shows a recovery action instead of a dead Connect button', async () => {
  const client = embeddedClient(phonePage.html)
  const status = {textContent:''}, button = {disabled:true,textContent:'Loading…',onclick:()=>{}}, loc = {hash:'',reload(){reloaded = true}}
  let reloaded = false
  runInNewContext(client, { document:{getElementById:()=>status,querySelector:()=>button},
    location:loc, window:{isSecureContext:true,crypto:{subtle:{}},addEventListener(){}}, URLSearchParams,
    sessionStorage:{getItem(){throw Object.assign(Error('blocked'),{name:'SecurityError'})}} })
  await Bun.sleep(0)
  expect(status.textContent).toContain('Browser storage is blocked')
  expect(button).toMatchObject({disabled:false,textContent:'Reload page'})
  button.onclick(); expect(reloaded).toBe(true)
})
