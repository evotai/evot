import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Real TLS, HOME, private sockets and subprocess supervision; no production
// identities, Cloudflare credentials, network routes or global module mocks.
test('approved phone survives a Connect server upgrade on the same gateway and session', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'evot-upgrade-'))
  try {
    const cert = join(dir, 'cert.pem')
    const tls = Bun.spawnSync(['openssl','req','-x509','-newkey','rsa:2048','-nodes','-days','1',
      '-subj','/CN=127.0.0.1','-addext','subjectAltName=IP:127.0.0.1','-keyout',join(dir,'key.pem'),'-out',cert])
    expect(tls.exitCode).toBe(0)
    const child = Bun.spawn([process.execPath, join(import.meta.dir, '../../helpers/remote-upgrade.ts')], {
      env: { HOME: dir, EVOT_HOME: join(dir,'.evotai'), PATH: dir, NODE_EXTRA_CA_CERTS: cert, TMPDIR: tmpdir() },
      stdout:'ignore', stderr:'pipe', timeout:18_000,
    })
    const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
    if (code !== 0) throw Error(`Isolated gateway scenario exited ${code}: ${stderr}`)
  } finally { rmSync(dir,{recursive:true,force:true}) }
}, 20_000)
