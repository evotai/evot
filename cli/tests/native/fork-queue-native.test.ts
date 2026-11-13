import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { seedSmokeHome, smokeEnvironment } from '../helpers/smoke-home.js'
import { suggestionImageFixture } from '../helpers/suggestion-image.js'

const integration = process.env.EVOT_TEST_NATIVE_CONTRACT === '1' ? test : test.skip
integration('fork structured input and FIFO versioned follow-ups cross the real addon without steering or changing the main session', async () => {
  const home = mkdtempSync(join(tmpdir(), 'evot-fork-queue-native-'))
  const ready = Promise.withResolvers<void>()
  const requests: Record<string, unknown>[] = []
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: async request => {
    if (new URL(request.url).pathname === '/ready') { ready.resolve(); return new Response('ok') }
    requests.push(await request.json())
    if (requests.length === 1) await ready.promise
    const chunk = { id: 'fixture', model: 'smoke-model', choices: [{ index: 0, delta: { content: 'fixture reply' }, finish_reason: 'stop' }] }
    return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } })
  } })
  let child: ReturnType<typeof Bun.spawn> | undefined
  let deadline: ReturnType<typeof setTimeout> | undefined
  try {
    const root = seedSmokeHome(home), env = join(root, 'evot.env')
    await Bun.write(env, (await Bun.file(env).text()).replace('http://127.0.0.1:1/v1', `${server.url.origin}/v1`) + '\nEVOT_LLM_SMOKE_SUPPORTS_IMAGE=true\n')
    const image = suggestionImageFixture()
    child = Bun.spawn([process.execPath, '--eval', `
      const { Agent } = await import('./src/native/index.ts');
      const agent = await Agent.create();
      const main = await agent.createSession();
      const fork = agent.fork('Readonly fixture analysis');
      const content = JSON.stringify([{ type: 'text', text: 'A' }, { type: 'image', mimeType: 'image/png', source: { type: 'base64', data: ${JSON.stringify(image)} } }]);
      const stream = await fork.query('', content);
      let registered = false, finished = 0;
      const sessions = new Set();
      for await (const event of stream) {
        sessions.add(event.session_id);
        if (!registered && event.kind === 'run_started') {
          registered = true;
          stream.followUp('B');
          const c = stream.followUp('C');
          const d = stream.followUp('D');
          const updated = stream.updateQueuedPrompt('follow_up', c.id, c.version, 'C edited');
          if (updated.version !== c.version + 1) throw new Error('update version lost');
          let staleRejected = false;
          try { stream.removeQueuedPrompt('follow_up', c.id, c.version) } catch { staleRejected = true }
          if (!staleRejected) throw new Error('stale mutation accepted');
          stream.removeQueuedPrompt('follow_up', d.id, d.version);
          if (stream.queuedPrompts('follow_up').length !== 2) throw new Error('queue shape lost');
          if (stream.queuedPrompts('steering').length) throw new Error('follow-ups steered');
          await fetch(${JSON.stringify(`${server.url.origin}/ready`)});
        }
        if (event.kind === 'run_finished') finished++;
        if (event.kind === 'error') throw new Error('native fork failed');
      }
      if (!registered || finished !== 1 || sessions.size !== 1) throw new Error('FIFO run/session ownership lost');
      if (stream.queuedPrompts('follow_up').length) throw new Error('queue did not drain');
      if ((await agent.loadTranscript(main.session_id)).length) throw new Error('fork escaped to main');
      // A frozen old caller invokes the addon method with one argument.
      const { NapiAgent } = await import('./src/native/binding.js');
      const raw = await NapiAgent.create(null, null);
      const legacy = await raw.fork('legacy readonly').query('legacy text');
      while (await legacy.next() !== null) {}
      console.log('fork FIFO preserved');
    `], { cwd: join(import.meta.dir, '../..'), env: smokeEnvironment(home), stdout: 'pipe', stderr: 'pipe' })
    const processHandle = child
    deadline = setTimeout(() => processHandle.kill(), 10_000)
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    expect(code, stderr).toBe(0)
    expect(stdout.trim()).toBe('fork FIFO preserved')
    expect(requests).toHaveLength(4)
    const input = requests.map(request => (request.messages as { role: string; content: unknown }[]).filter(message => message.role === 'user').at(-1)?.content)
    expect(JSON.stringify(input[0])).toContain('data:image/png;base64,')
    expect(JSON.stringify(input[1])).toContain('B')
    expect(JSON.stringify(input[2])).toContain('C edited')
    expect(JSON.stringify(input[3])).toContain('legacy text')
    expect(stdout + stderr).not.toContain('smoke-test-key')
  } finally {
    if (deadline) clearTimeout(deadline)
    if (child) { child.kill(); await child.exited }
    ready.resolve()
    await server.stop(true)
    rmSync(home, { recursive: true, force: true })
  }
}, 15_000)
