import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { seedSmokeHome, smokeEnvironment } from './helpers/smoke-home.js'
import { decodeQueryEvent, isHostToolEvent } from '../src/native/contracts/query-event.js'
import { decodeConfigInfo } from '../src/native/contracts/config-info.js'

// Explicit opt-in: run against a freshly built addon, never a developer's HOME.
const integration = process.env.EVOT_TEST_NATIVE_CONTRACT === '1' ? describe : describe.skip
integration('live NAPI ConfigInfo contract', () => {
  for (const hostTool of [false, true]) test(`real native streaming decodes ${hostTool ? 'host tool round-trip' : 'text completion'} using a local provider`, async () => {
    const home = mkdtempSync(join(tmpdir(), 'evot-run-contract-'))
    let requests = 0
    const server = Bun.serve({
      hostname: '127.0.0.1', port: 0,
      fetch: () => {
        requests++
        if (hostTool && requests === 1) {
          const chunks = [
            { id: 'fixture', model: 'smoke-model', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call-1', type: 'function', function: { name: 'ask_user', arguments: '{"questions":[]}' } }] }, finish_reason: null }] },
            { id: 'fixture', model: 'smoke-model', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
          ]
          return new Response(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
        }
        return new Response([
        'data: {"id":"fixture","object":"chat.completion.chunk","created":0,"model":"smoke-model","choices":[{"index":0,"delta":{"role":"assistant","content":"fixture reply"},"finish_reason":null}]}',
        '',
        'data: {"id":"fixture","object":"chat.completion.chunk","created":0,"model":"smoke-model","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
        '', 'data: [DONE]', '', '',
      ].join('\n'), { headers: { 'content-type': 'text/event-stream' } })
      },
    })
    let child: ReturnType<typeof Bun.spawn> | undefined
    let deadline: ReturnType<typeof setTimeout> | undefined
    try {
      const root = seedSmokeHome(home)
      const envPath = join(root, 'evot.env')
      const file = await Bun.file(envPath).text()
      await Bun.write(envPath, file.replace('http://127.0.0.1:1/v1', `http://127.0.0.1:${server.port}/v1`))
      child = Bun.spawn([process.execPath, '--eval', `
        const { Agent } = await import('./src/native/index.ts');
        const agent = await Agent.create();
        const specs = ${hostTool} ? JSON.stringify([{ name: 'ask_user', label: 'Ask User', description: 'Ask the user', parameters_schema: { type: 'object', properties: { questions: { type: 'array' } } } }]) : undefined;
        const stream = await agent.query('reply briefly', undefined, ${hostTool} ? 'interactive' : undefined, undefined, specs);
        for await (const event of stream) {
          console.log(JSON.stringify(event));
          if (event.kind === 'host_tool_call') await stream.respondHostTool(JSON.stringify({ tool_call_id: event.payload.tool_call_id, content: [{ type: 'text', text: 'fixture response' }], is_error: false }));
        }
      `], { cwd: join(import.meta.dir, '..'), env: smokeEnvironment(home), stdout: 'pipe', stderr: 'pipe' })
      const processHandle = child
      deadline = setTimeout(() => processHandle.kill(), 10_000)
      const [code, stdout, stderr] = await Promise.all([
        child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
      ])
      expect(code, stderr).toBe(0)
      const events = stdout.trim().split('\n').map(decodeQueryEvent)
      expect(events.some(isHostToolEvent)).toBe(hostTool)
      expect(events.some(event => event.kind === 'run_finished')).toBe(true)
      const completed = events.find(event => event.kind === 'assistant_completed' && JSON.stringify(event.payload).includes('fixture reply'))
      expect(completed).toBeDefined()
      if (!completed || isHostToolEvent(completed)) throw new Error('missing completion')
      expect(JSON.stringify(completed.payload)).toContain('fixture reply')
      expect(stdout).not.toContain('smoke-test-key')
    } finally {
      if (deadline) clearTimeout(deadline)
      if (child) { child.kill(); await child.exited }
      await server.stop(true)
      rmSync(home, { recursive: true, force: true })
    }
  }, 15_000)

  test('headless authentication failure returns nonzero without exposing credentials', async () => {
    const home = mkdtempSync(join(tmpdir(), 'evot-headless-failure-'))
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => Response.json({ error: { type: 'invalid_key', message: 'invalid API key' } }, { status: 401 }) })
    let child: ReturnType<typeof Bun.spawn> | undefined
    let deadline: ReturnType<typeof setTimeout> | undefined
    try {
      const root = seedSmokeHome(home)
      const path = join(root, 'evot.env')
      await Bun.write(path, (await Bun.file(path).text()).replace('http://127.0.0.1:1/v1', `http://127.0.0.1:${server.port}/v1`))
      child = Bun.spawn([join(import.meta.dir, '../dist/evot'), '-p', 'fixture'], { env: smokeEnvironment(home), stdout: 'pipe', stderr: 'pipe' })
      const handle = child
      deadline = setTimeout(() => handle.kill(), 10000)
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
      expect(code).toBe(1)
      expect(stderr).toContain('invalid API key')
      expect(stdout + stderr).not.toContain('smoke-test-key')
    } finally {
      if (deadline) clearTimeout(deadline)
      if (child) { child.kill(); await child.exited }
      await server.stop(true)
      rmSync(home, { recursive: true, force: true })
    }
  }, 15000)

  async function hostCancellationFixture() {
    const home = mkdtempSync(join(tmpdir(), 'evot-host-cancel-'))
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => {
      const chunk = { id: 'fixture', model: 'smoke-model', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call-cancel', type: 'function', function: { name: 'ask_user', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] }
      return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } })
    } })
    let child: ReturnType<typeof Bun.spawn> | undefined
    let deadline: ReturnType<typeof setTimeout> | undefined
    try {
      const root = seedSmokeHome(home)
      const envPath = join(root, 'evot.env')
      await Bun.write(envPath, (await Bun.file(envPath).text()).replace('http://127.0.0.1:1/v1', `http://127.0.0.1:${server.port}/v1`))
      child = Bun.spawn([process.execPath, '--eval', `
        const { Agent } = await import('./src/native/index.ts');
        const agent = await Agent.create();
        const specs = JSON.stringify([{ name: 'ask_user', label: 'Ask', description: 'Ask', parameters_schema: { type: 'object' } }]);
        const stream = await agent.query('ask', undefined, 'interactive', undefined, specs);
        let session;
        for await (const event of stream) {
          if (event.kind === 'host_tool_call') { session = stream.sessionId; stream.abort(); break; }
        }
        if (!session) throw new Error('host call missing');
        // A new run must acquire the same session gate without a host reply.
        const next = await agent.query('again', session, 'interactive', undefined, specs);
        next.abort();
        console.log('released');
      `], { cwd: join(import.meta.dir, '..'), env: smokeEnvironment(home), stdout: 'pipe', stderr: 'pipe' })
      const handle = child
      deadline = setTimeout(() => handle.kill(), 10_000)
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
      expect(code, stderr).toBe(0)
      expect(stdout.trim()).toBe('released')
    } finally {
      if (deadline) clearTimeout(deadline)
      if (child) { child.kill(); await child.exited }
      await server.stop(true)
      rmSync(home, { recursive: true, force: true })
    }
  }
  test('aborting an unanswered host tool releases the session', hostCancellationFixture, 15_000)

  test('native cancellation releases multiple pending reads', async () => {
    const home = mkdtempSync(join(tmpdir(), 'evot-cancel-contract-'))
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0,
      fetch: () => {
        return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(': waiting\n\n')) } }), { headers: { 'content-type': 'text/event-stream' } })
      },
    })
    let child: ReturnType<typeof Bun.spawn> | undefined
    let deadline: ReturnType<typeof setTimeout> | undefined
    try {
      const root = seedSmokeHome(home)
      const envPath = join(root, 'evot.env')
      await Bun.write(envPath, (await Bun.file(envPath).text()).replace('http://127.0.0.1:1/v1', `http://127.0.0.1:${server.port}/v1`))
      child = Bun.spawn([process.execPath, '--eval', `
        const { NapiAgent } = await import('./src/native/binding.js');
        const agent = await NapiAgent.create(null, null);
        const outcome = await agent.query('wait', null, null, null, null);
        const run = outcome.takeRun();
        const reads = Array.from({length: 32}, () => run.next());
        run.abort();
        await Promise.all(reads);
        if (await run.next() !== null) throw new Error('aborted stream remained readable');
        console.log('cancelled');
      `], { cwd: join(import.meta.dir, '..'), env: smokeEnvironment(home), stdout: 'pipe', stderr: 'pipe' })
      const processHandle = child
      deadline = setTimeout(() => processHandle.kill(), 10_000)
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
      expect(code, stderr).toBe(0)
      expect(stdout.trim()).toBe('cancelled')
    } finally {
      if (deadline) clearTimeout(deadline)
      if (child) { child.kill(); await child.exited }
      await server.stop(true)
      rmSync(home, { recursive: true, force: true })
    }
  }, 15_000)

  test('user cancellation stays readable but cannot wake an idle model across the native bridge', async () => {
    const home = mkdtempSync(join(tmpdir(), 'evot-background-wake-'))
    let requests = 0
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => {
      requests++
      const choice = requests === 1
        ? { index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'bg-1', type: 'function', function: { name: 'bash', arguments: JSON.stringify({ command: 'sleep 30', description: 'Exercise background task cancellation without waking the model', run_in_background: true }) } }] }, finish_reason: 'tool_calls' }
        : { index: 0, delta: { role: 'assistant', content: 'Background task started.' }, finish_reason: 'stop' }
      return new Response(`data: ${JSON.stringify({ id: 'fixture', model: 'smoke-model', choices: [choice] })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } })
    } })
    let child: ReturnType<typeof Bun.spawn> | undefined
    let deadline: ReturnType<typeof setTimeout> | undefined
    try {
      const root = seedSmokeHome(home)
      const envPath = join(root, 'evot.env')
      await Bun.write(envPath, (await Bun.file(envPath).text()).replace('http://127.0.0.1:1/v1', `http://127.0.0.1:${server.port}/v1`))
      child = Bun.spawn([process.execPath, '--eval', `
        const { Agent } = await import('./src/native/index.ts');
        const agent = await Agent.create();
        try {
          const session = await agent.createSession();
          const id = session.session_id;
          const stream = await agent.query('start background work', id, 'interactive');
          for await (const event of stream) {}
          if (agent.backgroundProcesses(id).filter(task => task.status === 'running').length !== 1) throw new Error('missing background task');
          await agent.stopAllBackgroundProcesses(id);
          if (agent.pendingProcessNotifications(id) !== 1) throw new Error('cancellation notice was lost');
          if (agent.pendingProcessWakeNotifications(id) !== 0) throw new Error('cancellation can wake model');
          if (agent.pendingProcessWakeNotifications('missing') !== 0) throw new Error('unknown session has notifications');
          console.log('cancelled without wake');
        } finally { agent.killAllBackgroundProcessesNow(); }
      `], { cwd: join(import.meta.dir, '..'), env: smokeEnvironment(home), stdout: 'pipe', stderr: 'pipe' })
      const handle = child
      deadline = setTimeout(() => handle.kill(), 10_000)
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
      expect(code, stderr).toBe(0)
      expect(stdout.trim()).toBe('cancelled without wake')
    } finally {
      if (deadline) clearTimeout(deadline)
      if (child) { child.kill(); await child.exited }
      await server.stop(true)
      rmSync(home, { recursive: true, force: true })
    }
  }, 15_000)

  test('current Rust writer reaches the validated TypeScript reader', async () => {
    const home = mkdtempSync(join(tmpdir(), 'evot-config-contract-'))
    try {
      seedSmokeHome(home)
      const script = `
        const { Agent } = await import('./src/native/index.ts');
        const agent = await Agent.create();
        const session = await agent.createSession();
        if (session.title !== null) throw new Error('new session title must be null');
        await agent.listSessions();
        await agent.listSessionsWithText();
        await agent.findSession(session.session_id);
        await agent.loadTranscript(session.session_id);
        const focused = await agent.sessionWithText(session.session_id);
        if (focused?.session_id !== session.session_id) throw new Error('focused session contract mismatch');
        await agent.loadContextTranscript(session.session_id);
        await agent.loadResumeTranscript(session.session_id);
        agent.backgroundProcesses(session.session_id);
        await agent.stopAllBackgroundProcesses(session.session_id);
        agent.listVariables();
        console.log(JSON.stringify(agent.configInfo()));
      `
      const child = Bun.spawn([process.execPath, '--eval', script], {
        cwd: join(import.meta.dir, '..'),
        env: smokeEnvironment(home), stdout: 'pipe', stderr: 'pipe',
      })
      const [code, stdout, stderr] = await Promise.all([
        child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
      ])
      expect(code, stderr).toBe(0)
      const info = decodeConfigInfo(stdout.trim())
      expect(info.provider).toBe('smoke')
      expect(info.availableModels.map(model => model.spec)).toEqual(['smoke:smoke-model', 'smoke:smoke-other-model'])
      expect(info.hasApiKey).toBe(true)
      expect(info.thinkingLevel).toBe('')
      expect(stdout).not.toContain('smoke-test-key')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})
