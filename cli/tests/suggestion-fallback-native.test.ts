import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { seedSmokeHome, smokeEnvironment } from './helpers/smoke-home.js'

const integration = process.env.EVOT_TEST_SUGGESTION_ADDON ? test : test.skip

for (const protocol of ['openai', 'anthropic', 'openai_responses'] as const) {
  integration(`native suggestion resolves ${protocol} service or current model once`, async () => {
    const home = mkdtempSync(join(tmpdir(), 'evot-suggestion-fallback-'))
    const models: string[] = []
    const keys: (string | null)[] = []
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: async request => {
      const expectedPath = protocol === 'anthropic' ? '/v1/messages'
        : protocol === 'openai_responses' ? '/v1/responses' : '/v1/chat/completions'
      expect(new URL(request.url).pathname).toBe(expectedPath)
      const body = await request.json() as Record<string, unknown>
      models.push(String(body.model))
      keys.push(request.headers.get('authorization'))
      expect(JSON.stringify(body)).toContain('SUGGESTION MODE')
      expect(body.tools ?? []).toEqual([])
      expect(body.max_tokens ?? body.max_output_tokens).toBe(192)
      if (body.model === 'dedicated-fail') return new Response('{}', { status: 503 })
      const text = 'Run the targeted tests'
      let events: Record<string, unknown>[]
      if (protocol === 'anthropic') {
        events = [
          { type: 'message_start', message: { id: 'fixture', role: 'assistant', content: [], model: body.model, usage: { input_tokens: 10, output_tokens: 0 } } },
          { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
          { type: 'content_block_stop', index: 0 },
          { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } },
          { type: 'message_stop' },
        ]
      } else if (protocol === 'openai_responses') {
        events = [
          { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'msg', role: 'assistant', content: [] } },
          { type: 'response.output_text.delta', output_index: 0, delta: text },
          { type: 'response.completed', response: { status: 'completed' } },
        ]
      } else {
        events = [
          { id: 'fixture', model: body.model, choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }] },
          { id: 'fixture', model: body.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
        ]
      }
      return new Response(events.map(event => `${event.type ? `event: ${event.type}\n` : ''}data: ${JSON.stringify(event)}\n\n`).join(''),
        { headers: { 'content-type': 'text/event-stream' } })
    } })
    let child: ReturnType<typeof Bun.spawn> | undefined
    let deadline: ReturnType<typeof setTimeout> | undefined
    try {
      const root = seedSmokeHome(home)
      const envPath = join(root, 'evot.env')
      const baseUrl = `http://127.0.0.1:${server.port}${protocol === 'anthropic' ? '' : '/v1'}`
      const envText = (await Bun.file(envPath).text())
        .replace('http://127.0.0.1:1/v1', baseUrl)
        .replace('EVOT_LLM_SMOKE_PROTOCOL=openai', `EVOT_LLM_SMOKE_PROTOCOL=${protocol}`)
      await Bun.write(envPath, envText)
      child = Bun.spawn([process.execPath, '--eval', `
        const { NapiAgent } = require(${JSON.stringify(process.env.EVOT_TEST_SUGGESTION_ADDON)});
        const fs = await import('node:fs/promises');
        const root = ${JSON.stringify(root)};
        const context = JSON.stringify([{role:'user',text:'Implement tests'},{role:'assistant',text:'Implementation is ready.'}]);
        const agent = await NapiAgent.create(null, null);
        async function ready(request) {
          const outcome = await request.outcome();
          if (outcome.status !== 'ready' || outcome.candidates[0] !== 'Run the targeted tests') {
            throw new Error('unexpected suggestion: ' + JSON.stringify(outcome));
          }
        }
        // No cloud login or catalog: snapshot the current route at call time.
        const first = agent.suggestNextPrompt(context);
        agent.model = 'smoke-other-model';
        await ready(first);
        await ready(agent.suggestNextPrompt(context));
        await fs.writeFile(root + '/auth.json', JSON.stringify({version:1,server_base_url:'http://127.0.0.1:1',
          user:{id:'fixture',name:'Fixture',email:'fixture@example.invalid'},cli_token:'fixture-token',refresh_token:'fixture-refresh',models_synced_at:0}));
        async function catalog(services) {
          await fs.writeFile(root + '/models.cache.json', JSON.stringify({schema_version:1,synced_at:1,response:{providers:[],models:[],services}}));
        }
        await catalog({});
        await ready(agent.suggestNextPrompt(context));
        await catalog({suggestion:{model:'broken',protocol:'unsupported'}});
        if ((await agent.suggestNextPrompt(context).outcome()).status !== 'unavailable') throw new Error('malformed service fell back');
        const service = {model:'dedicated-fail',protocol:${JSON.stringify(protocol)},base_url:${JSON.stringify(baseUrl)},api_key:'dedicated-test-key',context_window:8192};
        await catalog({suggestion:service});
        if ((await agent.suggestNextPrompt(context).outcome()).status !== 'failed') throw new Error('service failure did not stop');
        service.model = 'dedicated-good';
        await catalog({suggestion:service});
        await ready(agent.suggestNextPrompt(context));
        await catalog({suggestion:null});
        await ready(agent.suggestNextPrompt(context));
        await catalog({suggestion:service});
        await fs.unlink(root + '/auth.json');
        await ready(agent.suggestNextPrompt(context));
        const original = await fs.readFile(root + '/evot.env', 'utf8');
        if (original !== ${JSON.stringify(envText)}) throw new Error('provider configuration was rewritten');
        // An unauthenticated local endpoint is valid too.
        await fs.writeFile(root + '/evot.env', original.replace('EVOT_LLM_SMOKE_API_KEY=smoke-test-key','EVOT_LLM_SMOKE_API_KEY='));
        const unauthenticated = await NapiAgent.create(null, null);
        await ready(unauthenticated.suggestNextPrompt(context));
        const cancelled = unauthenticated.suggestNextPrompt(context);
        cancelled.abort();
        if ((await cancelled.outcome()).candidates.length) throw new Error('cancelled request returned candidates');
        console.log('fallback contract passed');
      `], { cwd: join(import.meta.dir, '..'), env: smokeEnvironment(home), stdout: 'pipe', stderr: 'pipe' })
      const handle = child
      deadline = setTimeout(() => handle.kill(), 15_000)
      const [code, stdout, stderr] = await Promise.all([
        child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
      ])
      expect(code, stderr).toBe(0)
      expect(stdout.trim()).toBe('fallback contract passed')
      expect(stdout + stderr).not.toContain('smoke-test-key')
      expect(stdout + stderr).not.toContain('dedicated-test-key')
      expect(models).toEqual(['smoke-model', 'smoke-other-model', 'smoke-other-model',
        'dedicated-fail', 'dedicated-good', 'smoke-other-model', 'smoke-other-model', 'smoke-model'])
      // Custom Anthropic endpoints, like the OpenAI transports, use Bearer auth.
      const localKey = 'Bearer smoke-test-key'
      const serviceKey = 'Bearer dedicated-test-key'
      expect(keys.slice(0, 7)).toEqual([localKey, localKey, localKey, serviceKey, serviceKey, localKey, localKey])
    } finally {
      if (deadline) clearTimeout(deadline)
      child?.kill()
      server.stop(true)
      rmSync(home, { recursive: true, force: true })
    }
  }, 20_000)
}
