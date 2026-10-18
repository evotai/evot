import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { seedSmokeHome, smokeEnvironment } from './helpers/smoke-home.js'
import { suggestionInstructions, suggestionMessageText } from './helpers/suggestion-request.js'

// Explicit opt-in to a freshly built addon; never use the developer's HOME.
const integration = process.env.EVOT_TEST_SUGGESTION_ADDON ? test : test.skip
for (const protocol of ['openai', 'anthropic'] as const) {
integration(`native ${protocol} suggestion preserves message roles and stops after withdrawal`, async () => {
  const home = mkdtempSync(join(tmpdir(), 'evot-suggestion-native-'))
  const requests: Record<string, unknown>[] = []
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: async request => {
    expect(new URL(request.url).pathname).toBe(protocol === 'openai' ? '/v1/chat/completions' : '/v1/messages')
    const body = await request.json() as Record<string, unknown>
    requests.push(body)
    const prompt = suggestionInstructions(body)
    if (requests.length === 3) return new Response(JSON.stringify({ error: { message: 'temporary fixture error' } }), { status: 503 })
    const text = prompt.includes('CURSOR REWRITE MODE')
      ? JSON.stringify(prompt.includes('COMMAND ARGUMENT ASSISTANCE') ? [' 5m check CI', ' status', ' 10m run tests'] : ['unit tests', 'integration tests\nThen review', 'smoke tests'])
      : prompt.includes('\nCommit\n') ? 'Commit current changes\nCommit after reviewing the diff\nCommit and push the branch'
      : requests.length === 1 ? 'Run the tests' : 'Run the full suite\nRun the unit tests\nRun the integration tests\nRun the smoke tests\nRun the lint checks\nRun the extra checks'
    if (protocol === 'anthropic') {
      const events = [
        { type: 'message_start', message: { id: 'fixture', role: 'assistant', content: [], model: 'service-model', usage: { input_tokens: 10, output_tokens: 0 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } },
        { type: 'message_stop' },
      ]
      return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } })
    }
    return new Response([
      `data: ${JSON.stringify({ id: 'fixture', model: 'service-model', choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }] })}`,
      '',
      'data: {"id":"fixture","model":"service-model","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
      '', 'data: [DONE]', '', '',
    ].join('\n'), { headers: { 'content-type': 'text/event-stream' } })
  } })
  let child: ReturnType<typeof Bun.spawn> | undefined
  let deadline: ReturnType<typeof setTimeout> | undefined
  try {
    const root = seedSmokeHome(home)
    await Bun.write(join(root, 'auth.json'), JSON.stringify({
      version: 1, server_base_url: 'http://127.0.0.1:1',
      user: { id: 'fixture', name: 'Fixture', email: 'fixture@example.invalid' },
      cli_token: 'fixture-token', refresh_token: 'fixture-refresh', models_synced_at: 0,
    }))
    const endpoint = { model: 'service-model', protocol,
      base_url: `http://127.0.0.1:${server.port}${protocol === 'openai' ? '/v1' : ''}`, api_key: 'service-test-key', context_window: 8192 }
    await Bun.write(join(root, 'models.cache.json'), JSON.stringify({ schema_version: 1,
      synced_at: 1, response: { providers: [], models: [], services: { suggestion: endpoint } } }))
    child = Bun.spawn([process.execPath, '--eval', `
      const { NapiAgent } = require(${JSON.stringify(process.env.EVOT_TEST_SUGGESTION_ADDON)});
      const agent = await NapiAgent.create(null, null);
      const context = JSON.stringify([{role:'user',text:'Implement the tests'},{role:'assistant',text:'Implementation is ready.'},{role:'user',text:'Add the tests'}, {role:'assistant',text:'Tests are ready.'}]);
      const request = agent.suggestNextPrompt(context);
      const progress = request.nextCandidates();
      if (await request.result() !== 'Run the tests') throw new Error('legacy string result changed');
      if (JSON.stringify(await progress) !== JSON.stringify(['Run the tests'])) throw new Error('candidate updates lost');
      if (await request.nextCandidates() !== null) throw new Error('candidate stream did not close');
      const detailed = JSON.stringify({messages: JSON.parse(context), draft: 'Run the', rejected: ['Run the tests']});
      const expected = JSON.stringify({candidates:[' full suite',' unit tests',' integration tests'],status:'ready'});
      if (JSON.stringify(await agent.suggestNextPrompt(detailed).outcome()) !== expected) throw new Error('missing draft continuation');
      const failed = await agent.suggestNextPrompt(detailed).outcome();
      if (failed.status !== 'failed' || failed.candidates.length) throw new Error('error mistaken for empty prediction');
      if (JSON.stringify(await agent.suggestNextPrompt(detailed).outcome()) !== expected) throw new Error('retry failed');
      const interrupted = JSON.stringify({messages:[{role:'user',text:'Commit'}],explicit:true,draft:'Commit'});
      const continuation = await agent.suggestNextPrompt(interrupted).outcome();
      if (continuation.status !== 'ready' || JSON.stringify(continuation.candidates) !== JSON.stringify([' current changes',' after reviewing the diff',' and push the branch'])) throw new Error('interrupted Tab blocked');
      const rewrite = JSON.stringify({messages:JSON.parse(context),explicit:true,draft:'Run the ',suffix:'old suite'});
      const rewritten = await agent.suggestNextPrompt(rewrite).outcome();
      if (rewritten.status !== 'ready' || rewritten.candidates[0] !== 'unit tests' || !rewritten.candidates[1].includes(String.fromCharCode(10))) throw new Error('replacement contract broken');
      const command = JSON.stringify({messages:JSON.parse(context),explicit:true,draft:'/loop',suffix:'',command:{name:'/loop',description:'Repeat a task',usage:'/loop [interval] [prompt] | stop | status'}});
      const arguments_ = await agent.suggestNextPrompt(command).outcome();
      if (arguments_.status !== 'ready' || arguments_.candidates[0] !== ' 5m check CI') throw new Error('command argument contract broken');
      const workflow = await Bun.file(${JSON.stringify(new URL('../../src/app/tests/fixtures/schema/suggestion-request-workflow.json', import.meta.url).pathname)}).json();
      workflow.explicit = false;
      delete workflow.suffix;
      if ((await agent.suggestNextPrompt(JSON.stringify(workflow)).outcome()).status !== 'ready') throw new Error('workflow recovery without assistant text blocked');
      const execution = await Bun.file(${JSON.stringify(new URL('../../src/app/tests/fixtures/schema/suggestion-request-execution.json', import.meta.url).pathname)}).json();
      execution.explicit = false;
      delete execution.suffix;
      if ((await agent.suggestNextPrompt(JSON.stringify(execution)).outcome()).status !== 'ready') throw new Error('execution chronology blocked');
      const image = await Bun.file(${JSON.stringify(new URL('../../src/app/tests/fixtures/schema/suggestion-request-images.json', import.meta.url).pathname)}).json();
      if ((await agent.suggestNextPrompt(JSON.stringify(image)).outcome()).status !== 'ready') throw new Error('image suggestion blocked');
      const closed = await Bun.file(${JSON.stringify(new URL('../../src/app/tests/fixtures/schema/suggestion-request-closed.json', import.meta.url).pathname)}).json();
      if ((await agent.suggestNextPrompt(JSON.stringify(closed)).outcome()).status !== 'empty') throw new Error('completed request should abstain');
      closed.messages.at(-1).text = 'Deploy to staging or production?';
      if ((await agent.suggestNextPrompt(JSON.stringify(closed)).outcome()).status !== 'ready') throw new Error('unanswered question was suppressed');
      const fs = await import('node:fs/promises');
      await fs.writeFile(${JSON.stringify(join(root, 'models.cache.json'))}, JSON.stringify({schema_version:1,synced_at:2,response:{services:{}}}));
      if ((await agent.suggestNextPrompt(context).outcome()).status !== 'unavailable') throw new Error('unexpected fallback');
      const cancelled = agent.suggestNextPrompt(context);
      cancelled.abort();
      if (await cancelled.result() !== null) throw new Error('cancelled request returned text');
      console.log('suggestion contract passed');
    `], { cwd: join(import.meta.dir, '..'), env: smokeEnvironment(home), stdout: 'pipe', stderr: 'pipe' })
    const handle = child
    deadline = setTimeout(() => handle.kill(), 10_000)
    const [code, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ])
    expect(code, stderr).toBe(0)
    expect(stdout.trim()).toBe('suggestion contract passed')
    expect(stdout + stderr).not.toContain('service-test-key')
    expect(requests).toHaveLength(11)
    expect(suggestionInstructions(requests[10]!)).toContain('INTENT GROUPS, most relevant first: close, respond')
    expect(JSON.stringify(requests)).not.toContain('All 227 tests passed')
    const imageRequest = requests[9] as { messages: { content: { type: string; source?: { type: string; data: string }; image_url?: { url: string } }[] }[] }
    const imageContent = imageRequest.messages.at(-1)?.content
    expect(Array.isArray(imageContent)).toBe(true)
    if (protocol === 'anthropic') expect(imageContent?.find(block => block.type === 'image')?.source?.data).toBeTruthy()
    else expect(imageContent?.find(block => block.type === 'image_url')?.image_url?.url).toStartWith('data:image/png;base64,')
    expect(suggestionInstructions(requests[9]!)).toContain('Use the visible images')
    expect(suggestionInstructions(requests[8]!)).toContain('EXECUTION CHRONOLOGY')
    expect(suggestionInstructions(requests[8]!)).toContain('"since_last_reply":3')
    expect(suggestionInstructions(requests[8]!)).not.toContain('first: resume_recover, respond')
    expect(suggestionInstructions(requests[7]!)).toContain('resume_recover, respond, advance_tasks')
    expect(suggestionInstructions(requests[7]!)).toContain('"session":"resumed"')
    expect(suggestionInstructions(requests[7]!)).toContain('"last_turn":"interrupted"')
    expect(requests[5]!.max_tokens).toBe(320)
    expect(suggestionInstructions(requests[6]!)).toContain('COMMAND ARGUMENT ASSISTANCE')
    const detailedPrompt = suggestionInstructions(requests[1]!)
    expect(detailedPrompt).toContain('DRAFT IN PROGRESS')
    expect(detailedPrompt).toContain('3 distinct suggestions')
    expect(detailedPrompt).not.toContain('ALREADY REJECTED')
    const messages = requests[0]!.messages as { role: string; content: unknown }[]
    expect(messages.map(message => message.role)).toEqual(['user', 'assistant', 'user', 'assistant', 'user'])
    expect(suggestionMessageText(messages[2]!.content)).toBe('Add the tests')
    expect(suggestionMessageText(messages[3]!.content)).toBe('Tests are ready.')
    expect(suggestionMessageText(messages[4]!.content)).toContain('<next_prompt_suggestion>')
    expect(requests[0]!.model).toBe('service-model')
    expect(requests[0]!.max_tokens).toBe(192)
    expect(requests[0]!.tools ?? []).toEqual([])
    expect(JSON.stringify(requests[0]!.messages)).not.toContain('language_reference')
  } finally {
    if (deadline) clearTimeout(deadline)
    if (child) { child.kill(); await child.exited }
    await server.stop(true)
    rmSync(home, { recursive: true, force: true })
  }
}, 15_000)
}
