// Exercise the real TUI, browser, approval file and revocation on this Mac.
// No account, user sessions, external provider, or Cloudflare resources are used.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { seedSmokeHome, smokeEnvironment } from '../tests/helpers/smoke-home.js'

const binary = join(import.meta.dir, '../dist/evot')
if (!(await Bun.file(binary).exists())) throw Error('Build the CLI first: cd cli && bun run build:cli')
const home = mkdtempSync(join(tmpdir(), 'evot-remote-preview-'))
const provider = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch() {
  const event = { id:'preview', model:'demo', choices:[{ index:0, delta:{role:'assistant',content:'Message received in the isolated Mac preview.'}, finish_reason:'stop' }] }
  return new Response(`data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`,{headers:{'content-type':'text/event-stream'}})
}})
try {
  const root = seedSmokeHome(home)
  writeFileSync(join(root,'evot.env'), `EVOT_LLM_PROVIDER=demo\nEVOT_LLM_DEMO_BASE_URL=http://127.0.0.1:${provider.port}/v1\nEVOT_LLM_DEMO_MODEL=demo\nEVOT_LLM_DEMO_API_KEY=local-demo\nEVOT_LLM_DEMO_PROTOCOL=openai\n`)
  console.log('Isolated preview: type /remote, then open its loopback URL in a browser on this Mac.')
  const p=Bun.spawn([binary],{cwd:home,env:smokeEnvironment(home),stdin:'inherit',stdout:'inherit',stderr:'inherit'})
  process.exitCode=await p.exited
} finally {await provider.stop(true);rmSync(home,{recursive:true,force:true})}
