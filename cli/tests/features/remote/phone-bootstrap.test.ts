import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { phoneAssets } from '../../../src/features/remote/assets.js'
import { DeviceStore } from '../../../src/features/remote/devices.js'
import { DeviceAccess } from '../../../src/features/remote/pairing.js'
import { listenRemote } from '../../../src/features/remote/server.js'

function embeddedClient(html: string) {
  const matches = [...html.matchAll(/<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]+?)<\/script>/g)]
  expect(matches).toHaveLength(1)
  return matches[0]![1]!
}

test('the public pairing page ships one complete client allowed by its CSP, with Connect inert until ready', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'evot-phone-boot-'))
  const gateway = listenRemote({snapshot(){throw Error('unused')},act(){}}, new DeviceAccess(new DeviceStore(dir),()=>{}))
  try {
    const r = await fetch(gateway.address), html = await r.text(), client = embeddedClient(html)
    expect(r.status).toBe(200)
    expect(html).toMatch(/id="pair"[\s\S]*?<button[^>]*disabled[^>]*>Loading…<\/button>/)
    expect(new Bun.Transpiler({loader:'js'}).scanImports(client)).toEqual([])
    const csp = r.headers.get('content-security-policy') ?? ''
    expect(csp).toContain(`'sha256-${createHash('sha256').update(client).digest('base64')}'`)
    expect(csp).not.toMatch(/unsafe-(inline|eval)/)
    expect(csp).toContain("form-action 'none'")
    expect(r.headers.get('cache-control')).toContain('no-transform')
  } finally { gateway.close(); rmSync(dir, {recursive:true,force:true}) }
})

test('a browser blocking tab storage shows a recovery action instead of a dead Connect button', async () => {
  const client = embeddedClient(phoneAssets.get('/')![1])
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
