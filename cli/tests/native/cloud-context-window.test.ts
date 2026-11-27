import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { seedSmokeHome, smokeEnvironment } from '../helpers/smoke-home.js'

const integration = process.env.EVOT_TEST_NATIVE_CONTRACT === '1' ? test : test.skip

integration('catalog sync refreshes live capacity without changing an admitted run', async () => {
  const home = mkdtempSync(join(tmpdir(), 'evot-cloud-window-'))
  const model = 'fixture-sol'
  const credential = 'local-test-credential'
  let catalogReads = 0
  const synced = Promise.withResolvers<void>()
  const server = Bun.serve({
    hostname: '127.0.0.1', port: 0,
    async fetch(request, server) {
      if (new URL(request.url).pathname === '/v1/config/models') {
        const initial = ++catalogReads === 1
        if (!initial) synced.resolve()
        return Response.json({
          version: catalogReads,
          default_model: initial ? model : 'fixture-other',
          providers: [{ name: 'evot-pro', protocol: 'openai', api_key: credential,
            base_url: `http://127.0.0.1:${server.port}/v1`, models: [model, 'fixture-other'] }],
          models: [{ id: model, context_window: initial ? 1_000_000 : 500_000 }, { id: 'fixture-other', context_window: 272_000 }],
        })
      }
      if (new URL(request.url).pathname !== '/v1/chat/completions') return new Response(null, { status: 404 })
      await synced.promise
      const chunk = (delta: object, finish_reason: string | null) => ({
        id: 'fixture', object: 'chat.completion.chunk', model,
        choices: [{ index: 0, delta, finish_reason }],
      })
      const body = [chunk({ content: 'fixture reply' }, null), chunk({}, 'stop')]
        .map(event => `data: ${JSON.stringify(event)}\n\n`).join('')
      return new Response(body + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
    },
  })
  let child: ReturnType<typeof Bun.spawn> | undefined
  let deadline: ReturnType<typeof setTimeout> | undefined
  try {
    const root = seedSmokeHome(home)
    await Bun.write(join(root, 'evot.env'), '')
    await Bun.write(join(root, 'auth.json'), JSON.stringify({
      version: 1, server_base_url: `http://127.0.0.1:${server.port}`,
      user: { id: 'fixture', name: 'Fixture', email: 'fixture@example.invalid' },
      cli_token: credential, refresh_token: credential, models_synced_at: 0,
    }))
    const processHandle = Bun.spawn([process.execPath, '--eval', `
      const { Agent, authSyncModels } = await import('./src/native/index.ts');
      const { createReplState } = await import('./src/term/host/state.ts');
      const { createCloudController } = await import('./src/term/host/cloud.ts');
      const { CloudSync, ModelAnnouncer } = await import('./src/term/app/session/cloud-sync.ts');
      await authSyncModels();
      const agent = await Agent.create();
      const state = createReplState(agent.model, agent.cwd);
      state.configInfo = agent.configInfo();
      if (state.configInfo.contextWindow !== 1000000) throw new Error('initial window mismatch');
      let renders = 0;
      const sync = new CloudSync({
        authenticated: async () => true,
        syncNotices: async () => [],
        syncModels: authSyncModels,
        noticesUpdated() {},
        modelsUpdated: () => cloud.reloadCloudContent([]),
      });
      const cloud = createCloudController(state, {
        agent, cloudSync: sync, modelAnnouncer: new ModelAnnouncer(),
        cloudModels: () => state.configInfo.availableModels,
        cloudSessions: { refreshIndex: async () => {} },
        commandWindow: { commandWindowMounted: () => false },
        refreshOpenModelSelector: () => false,
        renderer: { requestRender() { renders++; } },
      });
      const first = await agent.query('First fixture turn');
      let firstWindow;
      for await (const event of first) {
        if (event.kind === 'llm_call_started') await cloud.syncCloudNow();
        if (event.kind === 'llm_call_completed' && !event.payload.error) firstWindow = event.payload.context_window;
      }
      const second = await agent.query('Second fixture turn', first.sessionId);
      let secondWindow;
      for await (const event of second) {
        if (event.kind === 'llm_call_completed' && !event.payload.error) secondWindow = event.payload.context_window;
      }
      console.log(JSON.stringify({ firstWindow, secondWindow, liveWindow: state.configInfo.contextWindow, model: agent.model, renders }));
    `], { cwd: join(import.meta.dir, '../..'), env: smokeEnvironment(home), stdout: 'pipe', stderr: 'pipe' })
    child = processHandle
    deadline = setTimeout(() => processHandle.kill(), 10_000)
    const [code, stdout, stderr] = await Promise.all([
      processHandle.exited, new Response(processHandle.stdout).text(), new Response(processHandle.stderr).text(),
    ])
    expect(code, stderr).toBe(0)
    expect(JSON.parse(stdout)).toEqual({ firstWindow: 1_000_000, secondWindow: 500_000, liveWindow: 500_000, model, renders: 1 })
    expect(catalogReads).toBe(2)
  } finally {
    if (deadline) clearTimeout(deadline)
    if (child) { child.kill(); await child.exited }
    synced.resolve()
    await server.stop(true)
    rmSync(home, { recursive: true, force: true })
  }
}, 15_000)
