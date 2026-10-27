import { describe, test, expect } from 'bun:test'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { smokeEnvironment, seedSmokeHome } from '../helpers/smoke-home.js'
import { suggestionInstructions, suggestionWorkflow } from '../helpers/suggestion-request.js'
import { fixtureClipboard } from '../helpers/clipboard.js'
import { suggestionImageFixture } from '../helpers/suggestion-image.js'
import closedFixture from '../../../src/app/tests/fixtures/schema/suggestion-request-closed.json'
import externalWorkFixture from '../../../src/app/tests/fixtures/schema/suggestion-request-external-work.json'
import handoffFixture from '../../../src/app/tests/fixtures/schema/suggestion-request-handoff.json'
import generalityCases from '../fixtures/suggestion-generality.json'
import { getTheme } from '../../src/render/theme/index.js'
import { ScreenHarness } from '../helpers/screen.js'

const EVOT_BIN = process.env.EVOT_TEST_BIN || join(import.meta.dirname, '..', '..', 'dist', 'evot')
const canRun = process.platform !== 'win32' && existsSync(EVOT_BIN) && !!spawnSync('python3', ['--version']).stdout

function selectionBackgroundAnsi(): string {
  const [red, green, blue] = getTheme().selectionBgHex
    .slice(1)
    .match(/.{2}/g)!
    .map(part => Number.parseInt(part, 16))
  return `\x1b[48;2;${red};${green};${blue}m`
}

const PTY_RELAY = `
import os, pty, select, sys, signal, fcntl, termios, struct, json
status = 0
resize_fd = 3 if os.environ.get('EVOT_TEST_RESIZE_CONTROL') == '1' else None
resize_pending = ''
pid, fd = pty.fork()
if pid == 0:
    os.environ['TERM'] = 'xterm-256color'
    os.execv(sys.argv[1], sys.argv[1:])
try:
    while True:
        inputs = [sys.stdin.buffer, fd] + ([resize_fd] if resize_fd is not None else [])
        r, _, _ = select.select(inputs, [], [], 0.1)
        if resize_fd is not None and resize_fd in r:
            command = os.read(resize_fd, 4096)
            if not command:
                resize_fd = None
            else:
                resize_pending += command.decode()
                while '\\n' in resize_pending:
                    line, resize_pending = resize_pending.split('\\n', 1)
                    columns, rows = json.loads(line)
                    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', rows, columns, 0, 0))
        if sys.stdin.buffer in r:
            data = sys.stdin.buffer.read1(4096)
            if not data:
                break
            os.write(fd, data)
        if fd in r:
            try:
                data = os.read(fd, 65536)
            except OSError:
                break
            if not data:
                break
            sys.stdout.buffer.write(data)
            sys.stdout.buffer.flush()
    _, status = os.waitpid(pid, 0)
except KeyboardInterrupt:
    pass
finally:
    try:
        os.kill(pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
sys.exit(os.waitstatus_to_exitcode(status) if status else 0)
`

type Session = {
  write: (data: string) => void
  resize: (columns: number, rows: number) => void
  outputSince: () => string
  /**
   * Resolve once the output since the last checkpoint matches, or reject after
   * `timeoutMs`.
   *
   * Fixed sleeps made this suite flaky: a 600ms wait is ample on an idle
   * machine and far too short when 40+ test files compete for CPU, so the whole
   * file failed under load while passing in isolation. Polling makes the wait
   * proportional to how long the TUI actually takes.
   */
  waitFor: (match: string | RegExp, timeoutMs?: number) => Promise<string>
  /** Match the physical screen, including rows retained by differential rendering. */
  waitForScreen: (match: string | RegExp, timeoutMs?: number) => Promise<string>
  checkpoint: () => void
  persistedSessionCount: () => number
  historyEntries: () => string[]
  kill: () => Promise<void>
}

function stripAnsi(text: string): string {
  return text.replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\)|_.*?\x07)/g, '')
}

/** Generous by design: it only bounds failure, since a match returns early. */
const DEFAULT_WAIT_MS = 15_000
const POLL_INTERVAL_MS = 50

const SEEDED_SESSION_ID = '018f0000-0000-7000-8000-000000000001'
const OTHER_CWD_SESSION_ID = '028f0000-0000-7000-8000-000000000002'

function seedResumeSession(
  home: string,
  opts: { id?: string; cwd?: string; title?: string; updatedAt?: string } = {},
): void {
  const id = opts.id ?? SEEDED_SESSION_ID
  const sessionDir = join(home, 'sessions', id)
  mkdirSync(sessionDir, { recursive: true })
  const now = opts.updatedAt ?? new Date().toISOString()
  writeFileSync(join(sessionDir, 'session.json'), JSON.stringify({
    session_id: id,
    cwd: opts.cwd ?? process.cwd(),
    model: 'smoke-model',
    provider: 'smoke',
    thinking_level: null,
    title: opts.title ?? 'smoke resume fixture',
    source: 'repl',
    turns: 1,
    message_count: 1,
    context_tokens: 0,
    context_budget: 0,
    total_input_tokens: 0,
    total_output_tokens: 0,
    span_count: 0,
    created_at: now,
    updated_at: now,
  }))
  const transcriptPath = join(sessionDir, 'transcript.jsonl')
  writeFileSync(transcriptPath, `${JSON.stringify([{
    session_id: id,
    run_id: null,
    seq: 1,
    turn: 1,
    item: { type: 'user', text: 'smoke resume prompt', content: [] },
    created_at: now,
  }])}\n`)
  if (opts.updatedAt) {
    const timestamp = new Date(opts.updatedAt)
    utimesSync(transcriptPath, timestamp, timestamp)
  }
}

function seedResumePreviewCacheMiss(home: string): string[] {
  // Startup preloads the globally newest 20 sessions. Make all of those belong
  // to another project, while three older sessions belong to this cwd. The
  // live `/res` preview must therefore expand beyond its startup cache to agree
  // with the full selector opened by Enter.
  for (let index = 0; index < 20; index++) {
    const suffix = (index + 1).toString(16).padStart(12, '0')
    seedResumeSession(home, {
      id: `f00000${index.toString(16).padStart(2, '0')}-0000-7000-8000-${suffix}`,
      cwd: '/tmp/newer-other-project',
      title: `newer other session ${index + 1}`,
      updatedAt: `2026-08-${String(index + 1).padStart(2, '0')}T12:00:00Z`,
    })
  }

  const currentIds = [
    '11000000-0000-7000-8000-000000000001',
    '12000000-0000-7000-8000-000000000002',
    '13000000-0000-7000-8000-000000000003',
  ]
  currentIds.forEach((id, index) => {
    seedResumeSession(home, {
      id,
      title: `older current session ${index + 1}`,
      updatedAt: `2025-01-0${index + 1}T12:00:00Z`,
    })
  })
  return currentIds
}

function seedSuggestionService(stateHome: string, baseUrl: string): void {
  writeFileSync(join(stateHome, 'auth.json'), JSON.stringify({
    version: 1, server_base_url: 'http://127.0.0.1:1',
    user: { id: 'fixture', name: 'Fixture', email: 'fixture@example.invalid' },
    cli_token: 'fixture-token', refresh_token: 'fixture-refresh', models_synced_at: Date.now(),
  }))
  writeFileSync(join(stateHome, 'models.cache.json'), JSON.stringify({ schema_version: 1,
    synced_at: Date.now(), response: { providers: [], models: [], services: { suggestion: {
      model: 'suggestion-fixture', protocol: 'openai', base_url: baseUrl,
      api_key: 'fixture-key', context_window: 8192,
    } } },
  }))
}

function seedCompletedSuggestionHistory(home: string): void {
  const path = join(home, 'sessions', SEEDED_SESSION_ID, 'transcript.jsonl')
  const entries = JSON.parse(readFileSync(path, 'utf8').trim()) as Record<string, unknown>[]
  const items = [
    { type: 'assistant', content: [{ type: 'text', text: 'Implementation is ready.' }], model: 'test-model', provider: 'test-provider', usage: { input: 0, output: 0, cache_read: 0, cache_write: 0, total_tokens: 0 },  stop_reason: 'stop' },
    { type: 'user', text: 'Add the login tests', content: [] },
    { type: 'assistant', content: [{ type: 'text', text: 'The login tests are ready. Should I commit the changes or leave them uncommitted?' }], model: 'test-model', provider: 'test-provider', usage: { input: 0, output: 0, cache_read: 0, cache_write: 0, total_tokens: 0 },  stop_reason: 'stop' },
  ]
  for (const [index, item] of items.entries()) entries.push({ session_id: SEEDED_SESSION_ID, run_id: null,
    seq: index + 2, turn: index + 2, item, created_at: new Date().toISOString() })
  writeFileSync(path, `${JSON.stringify(entries)}\n`)
}

function seedSuggestionConversation(home: string, messages: readonly { role: string; text: string }[]): void {
  const entries = messages.map((message, index) => ({
    session_id: SEEDED_SESSION_ID, run_id: null, seq: index + 1, turn: 1, created_at: new Date().toISOString(),
    item: message.role === 'user' ? { type: 'user', text: message.text, content: [] }
      : { type: 'assistant', content: [{ type: 'text', text: message.text }], stop_reason: 'stop',
        usage: { input: 0, output: 0 }, model: 'smoke-model', provider: 'smoke', timestamp: 0 },
  }))
  writeFileSync(join(home, 'sessions', SEEDED_SESSION_ID, 'transcript.jsonl'), `${JSON.stringify(entries)}\n`)
}

async function startEvot(
  seedSession = false,
  seedOtherCwd = false,
  seedPreviewCacheMiss = false,
  providerUrl?: string,
  setup?: (stateHome: string) => void,
  startupArgs: string[] = [],
  environment?: (stateHome: string) => Record<string, string>,
): Promise<Session> {
  // Isolate HOME as well as EVOT_HOME: some TS and Rust stores use ~/.evotai.
  // This must also protect developer state when testing an older compiled binary.
  const isolatedHome = mkdtempSync(join(tmpdir(), 'evot-smoke-home-'))
  const stateHome = seedSmokeHome(isolatedHome)
  if (providerUrl) {
    const path = join(stateHome, 'evot.env')
    writeFileSync(path, readFileSync(path, 'utf8').replace('http://127.0.0.1:1/v1', providerUrl))
  }
  if (seedSession) seedResumeSession(stateHome)
  if (seedOtherCwd) {
    seedResumeSession(stateHome, {
      id: OTHER_CWD_SESSION_ID,
      cwd: '/tmp/other-project',
      title: 'other cwd fixture',
    })
  }
  if (seedPreviewCacheMiss) seedResumePreviewCacheMiss(stateHome)
  setup?.(stateHome)
  const child = spawn('python3', ['-c', PTY_RELAY, EVOT_BIN, ...startupArgs], {
    stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
    env: { ...smokeEnvironment(isolatedHome), ...environment?.(stateHome), EVOT_TEST_RESIZE_CONTROL: '1' },
  })
  let all = ''
  let seen = 0
  const screen = new ScreenHarness()
  child.stdout!.on('data', (chunk: Buffer) => {
    all += chunk.toString('utf-8')
    screen.stdout.write(chunk)
  })
  child.stderr!.on('data', (chunk: Buffer) => { all += chunk.toString('utf-8') })
  const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

  const outputSince = () => all.slice(seen)
  const waitForOutput = async (match: string | RegExp, timeoutMs = DEFAULT_WAIT_MS, physicalScreen = false): Promise<string> => {
    const matches = (text: string) =>
      typeof match === 'string' ? text.includes(match) : match.test(text)
    const deadline = Date.now() + timeoutMs
    for (;;) {
      if (physicalScreen) await screen.settle()
      const text = physicalScreen ? screen.viewport().join('\n') : stripAnsi(outputSince())
      if (matches(text)) return text
      if (Date.now() >= deadline) {
        // Surface what did arrive: a bare timeout says nothing about whether the
        // TUI was slow, crashed, or rendered something unexpected.
        const tail = text.slice(-800)
        throw new Error(
          `timed out after ${timeoutMs}ms waiting for ${match}\n--- output tail ---\n${tail}`,
        )
      }
      await wait(POLL_INTERVAL_MS)
    }
  }

  const waitFor = (match: string | RegExp, timeoutMs?: number) => waitForOutput(match, timeoutMs)
  const waitForScreen = (match: string | RegExp, timeoutMs?: number) => waitForOutput(match, timeoutMs, true)

  const kill = async (): Promise<void> => {
    seen = all.length
    child.stdin!.write('\x03')
    await wait(300)
    child.stdin!.write('\x03')
    await wait(500)
    child.kill('SIGKILL')
    screen.terminal.dispose()
    rmSync(isolatedHome, { recursive: true, force: true })
  }
  // Readiness failures must not leave a subprocess or its temporary home behind.
  try {
    // A resumed answer may already have a valid suggestion in the input
    // slot. Readiness is not tied to the empty-placeholder wording.
    await waitFor(/Enter a coding task|⇥ next · → accept/)
  } catch (err) {
    await kill()
    throw err
  }
  return {
    write: data => { child.stdin!.write(data) },
    resize: (columns, rows) => {
      screen.resize(columns, rows)
      const control = child.stdio[3] as import('node:stream').Writable
      control.write(`${JSON.stringify([columns, rows])}\n`)
    },
    outputSince,
    waitFor,
    waitForScreen,
    checkpoint: () => { seen = all.length },
    persistedSessionCount: () => {
      const sessionsDir = join(stateHome, 'sessions')
      return existsSync(sessionsDir) ? readdirSync(sessionsDir).length : 0
    },
    historyEntries: () => {
      const projects = join(stateHome, 'projects')
      if (!existsSync(projects)) return []
      return readdirSync(projects).flatMap(slug => {
        const path = join(projects, slug, 'evot_history')
        return existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean) : []
      })
    },
    kill,
  }
}

describe.skipIf(!canRun)('evot binary smoke (PTY)', () => {
  test('--continue with no history exits cleanly during partial startup', async () => {
    const home = mkdtempSync(join(tmpdir(), 'evot-continue-home-'))
    seedSmokeHome(home)
    const child = spawn('python3', ['-c', PTY_RELAY, EVOT_BIN, '--continue'], {
      env: smokeEnvironment(home), stdio: ['pipe', 'pipe', 'pipe'],
    })
    let output = ''
    child.stdout.on('data', data => { output += data.toString() })
    child.stderr.on('data', data => { output += data.toString() })
    const timer = setTimeout(() => child.kill('SIGTERM'), 15_000)
    try {
      const code = await new Promise<number | null>((resolve, reject) => {
        child.once('error', reject)
        child.once('close', resolve)
      })
      expect(code).toBe(1)
      expect(output).not.toContain('ReferenceError')
      expect(output).not.toContain('before initialization')
    } finally {
      clearTimeout(timer)
      child.kill('SIGTERM')
      rmSync(home, { recursive: true, force: true })
    }
  }, 20_000)

  test('resizing a long completed answer keeps the latest viewport and suggestion across geometry changes', async () => {
    let requests = 0
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => {
      requests++
      const content = 'Run the targeted tests\nReview the diff\nCommit the changes'
      return new Response([
        `data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: null }] })}\n\n`,
        `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`,
      ].join(''), { headers: { 'content-type': 'text/event-stream' } })
    } })
    let session: Session | undefined
    try {
      session = await startEvot(true, false, false, undefined, home => {
        seedSuggestionService(home, `http://127.0.0.1:${server.port}/v1`)
        const history = Array.from({ length: 800 }, (_, row) =>
          `Result ${row}: the completed operation produced a long diagnostic entry that must stay in native scrollback.`)
        seedSuggestionConversation(home, [
          { role: 'user', text: 'Review the completed operation' },
          { role: 'assistant', text: `${history.join('\n')}\n\nLATEST RESIZE ANSWER` },
        ])
      }, ['--resume', SEEDED_SESSION_ID])
      await session.waitForScreen(/LATEST RESIZE ANSWER[\s\S]*Run the targeted tests/)
      for (const [columns, rows] of [[81, 24], [95, 24], [65, 24], [90, 30], [80, 24]] as const) {
        session.checkpoint()
        session.resize(columns, rows)
        await session.waitFor('Run the targeted tests')
        await session.waitForScreen(/LATEST RESIZE ANSWER[\s\S]*Run the targeted tests/)
        const output = session.outputSince()
        // These history rows wrap differently at every width. Repainting once
        // is the only correct way to restore the terminal's physical row base;
        // patching a new logical tail over the reflowed scrollback duplicates
        // rows and leaves partial-width backgrounds.
        expect(output).toContain('\x1b[3J')
        expect(output.match(/Result 0:/g)).toHaveLength(1)
      }
      session.write('draft after resize')
      await session.waitForScreen('draft after resize')
      session.write('\x15')
      await session.waitForScreen('Run the targeted tests')
      session.write('\t')
      await session.waitForScreen('Review the diff')
      expect(requests).toBe(1)
    } finally {
      if (session) await session.kill()
      server.stop(true)
    }
  }, 60_000)

  test('renders the composer and echoes typed text', async () => {
    const session = await startEvot()
    try {
      // startEvot already waited for the prompt; assert it explicitly so the
      // readiness contract is visible in the test body.
      expect(stripAnsi(session.outputSince())).toContain('Enter a coding task')

      session.write('hello smoke')
      await session.waitFor('hello smoke')
    } finally {
      await session.kill()
    }
  }, 60_000)

  test('/new stays unbound until the first real prompt', async () => {
    const session = await startEvot()
    try {
      expect(session.persistedSessionCount()).toBe(0)
      session.write('/new\x0d')
      await session.waitFor('new session')
      expect(session.persistedSessionCount()).toBe(0)
    } finally {
      await session.kill()
    }
  }, 60_000)

  test('a command window previews live, then the first arrow focuses and navigates', async () => {
    const session = await startEvot()
    // This test asserts the full selector's details, not its compact layout.
    session.resize(100, 50)
    try {
      // A unique prefix immediately renders the formal model window above the
      // composer, but the highlighted row already uses the selector's complete
      // current-row treatment while keyboard focus remains in the composer.
      session.checkpoint()
      session.write('/m')
      const preview = await session.waitFor('Only showing models from configured providers')
      expect(preview).toContain('Model:')
      expect(preview).toContain('/m')
      const activeModel = preview.match(/Model: ([^\r\n]+)/)?.[1]?.trim()
      expect(activeModel).toBeTruthy()
      expect(preview).toContain(`· ${activeModel}`)
      expect(session.outputSince()).toContain(selectionBackgroundAnsi())

      // Continued typing still belongs to the composer, not the model filter.
      session.checkpoint()
      session.write('odel')
      const continued = await session.waitFor('/model')
      expect(continued).toContain('/model')
      expect(continued).not.toContain('❭ odel')

      // Argument entry hides the no-argument command window immediately. When
      // the command becomes argument-free again, the same preview returns.
      session.checkpoint()
      session.write(' ')
      await session.waitFor('/model ')
      session.checkpoint()
      session.write('\x7f')
      const restored = await session.waitFor('Only showing models from configured providers')
      expect(restored).toContain('/model')

      // The first arrow both focuses and navigates, without replacing the
      // selector/composer layout or requiring a focus-only keypress.
      session.checkpoint()
      session.write('\x1b[B')
      const navigated = await session.waitFor('Model:')
      expect(navigated).not.toContain(`Model: ${activeModel}`)
      expect(session.outputSince()).not.toContain('\x1b[2J')

      session.checkpoint()
      session.write('\x1b[A')
      await session.waitFor(`Model: ${activeModel}`)

      session.checkpoint()
      session.write('\x1b')
      await session.waitFor('Enter a coding task')

      // Up must also navigate on its first press. Down then returns to the
      // original active model; this does not depend on the catalog's ordering.
      session.checkpoint()
      session.write('/m')
      await session.waitFor(`Model: ${activeModel}`)
      session.checkpoint()
      session.write('\x1b[A')
      const navigatedUp = await session.waitFor('Model:')
      expect(navigatedUp).not.toContain(`Model: ${activeModel}`)
      expect(session.outputSince()).not.toContain('\x1b[2J')
      session.checkpoint()
      session.write('\x1b[B')
      await session.waitFor(`Model: ${activeModel}`)

      session.checkpoint()
      session.write('\x1b')
      await session.waitFor('Enter a coding task')

      // Enter keeps its original immediate-submit behavior; arrows are only
      // needed to transfer focus without submitting the command.
      session.checkpoint()
      session.write('/model\x0d')
      const submitted = await session.waitFor('Only showing models from configured providers')
      expect(submitted).toContain('Model:')
      session.write('\x1b')
    } finally {
      await session.kill()
    }
  }, 60_000)

  test('skill command window opens live and stays stable through focus', async () => {
    const session = await startEvot()
    session.resize(100, 50)
    try {
      // `/ski` uniquely identifies `/skill`; no Enter is needed to open the
      // installed-skill inventory and the composer keeps keyboard focus.
      session.checkpoint()
      session.write('/ski')
      const preview = await session.waitFor('Search skills…')
      expect(preview).toContain('Skills')
      expect(preview).toContain('/ski')
      expect(preview).not.toContain('\x1b[2J')

      // The first arrow focuses and navigates without replacing or clearing
      // the selector/composer frame. Enter on an individual skill is inert;
      // package rows may expand in place. Management stays explicit via `/skill ...`.
      session.checkpoint()
      session.write('\x1b[B')
      await Bun.sleep(100)
      expect(session.outputSince()).not.toContain('\x1b[2J')

      session.checkpoint()
      session.write('\x0d')
      await Bun.sleep(100)
      expect(session.outputSince()).not.toContain('\x1b[2J')

      session.checkpoint()
      session.write('\x1b')
      await session.waitFor('Enter a coding task')
    } finally {
      await session.kill()
    }
  }, 60_000)

  test('e renames a session and the new name is searchable after reopening', async () => {
    const session = await startEvot(true)
    try {
      session.checkpoint()
      session.write('/sessions\x0d')
      await session.waitFor('smoke resume fixture')
      session.checkpoint()
      session.write('e')
      await session.waitFor('Rename session')
      session.write('\x15production alerts\x0d')
      await session.waitFor('Session renamed')
      session.checkpoint()
      session.write('\x1b')
      await session.waitFor('Enter a coding task')
      session.checkpoint()
      session.write('/sessions\x0d')
      await session.waitFor('production alerts')
      session.checkpoint()
      session.write('/production')
      // Search snippets can truncate the inline ID. Check the actual filtered
      // row and count rather than requiring hidden metadata to fit on screen.
      const filtered = await session.waitForScreen(/Search\s+production(?:\s|$)/)
      expect(filtered).toMatch(/Sessions\s+1 \/ 1(?:\r|\n)/)
      expect(filtered).toMatch(/·\s+production alerts/)
      session.write('\x1b')
    } finally {
      await session.kill()
    }
  }, 60_000)

  test('resume preview stays responsive through rapid typing and deletion', async () => {
    const session = await startEvot(true)
    session.resize(100, 50)
    try {
      const createdSessionId = SEEDED_SESSION_ID.slice(0, 8)

      // The whole command can arrive in one input burst. Delete it completely
      // and retype the /re prefix immediately; input must remain responsive.
      session.checkpoint()
      session.write('/resume\x7f\x7f\x7f\x7f\x7f\x7f\x7f/re')
      const preview = await session.waitForScreen('❭ /resume', 1_000)
      expect(preview).toMatch(/Sessions\s+\d+(?:\r|\n)/)
      expect(preview).toContain('Search  / to search')
      expect(preview).toContain('type search')

      // A unique prefix is enough: the existing session appears without
      // completing /resume or pressing an arrow. Like `/mo`, the preview uses
      // the complete shared current-row treatment before keyboard promotion.
      const populated = await session.waitForScreen(createdSessionId)
      expect(populated).toMatch(/Sessions\s+1(?:\r|\n)/)
      expect(populated).toMatch(/·\s+smoke resume fixture/)
      expect(session.outputSince()).toContain(selectionBackgroundAnsi())

      // An ambiguous bare slash is a bridge between command windows. Keep the
      // session window mounted while `/re` is erased, then replace it in place
      // once `/mo` identifies the model window. Wait for the initial async
      // session paint first so each checkpoint observes one editor transition.
      await Bun.sleep(200)
      session.checkpoint()
      session.write('\x7f')
      const shortened = await session.waitFor('❭ /r')
      expect(shortened).not.toContain('\x1b[2J')
      session.checkpoint()
      session.write('\x7f')
      const bridged = await session.waitFor('❭ /')
      expect(bridged).not.toContain('\x1b[2J')
      session.checkpoint()
      session.write('mo')
      const switched = await session.waitFor('Model:')
      expect(switched).toContain('/mo')
      expect(switched).not.toContain('\x1b[2J')

      // Return to resume so the rest of this test exercises its focus path.
      session.checkpoint()
      session.write('\x7f\x7fre')
      await session.waitForScreen(createdSessionId)

      // The first arrow transfers focus directly to the first session. The /re
      // composer remains in the same frame while metadata expansion waits for
      // keyboard idle; no intermediate Filter-focused keypress is required.
      session.checkpoint()
      session.write('\x1b[A')
      await Bun.sleep(100)
      expect(session.outputSince()).not.toContain('\x1b[2J')

      session.checkpoint()
      session.write('\x1b')
      await session.waitFor('Enter a coding task')

      // Closing immediately after focus promotion must cancel deferred metadata
      // enrichment. A late native result may fill caches, but must never reopen
      // the selector after Esc returned to the empty composer.
      session.checkpoint()
      session.write('/re\x1b[B\x1b')
      await session.waitFor('Enter a coding task')
      await Bun.sleep(250)
      const afterQuickClose = stripAnsi(session.outputSince())
      expect(afterQuickClose).not.toContain('Loading sessions…')
    } finally {
      await session.kill()
    }
  }, 60_000)

  test('submitted resume stays closed when Esc wins the async load', async () => {
    const session = await startEvot(true, false, true)
    try {
      // Submit the command rather than using the live command window, then
      // cancel in the same input burst. Any metadata/text result that resolves
      // later belongs to the cancelled generation and must not reopen it.
      session.checkpoint()
      session.write('/resume\x0d\x1b')
      await session.waitFor('Enter a coding task')
      session.checkpoint()
      await Bun.sleep(300)
      const afterLoad = stripAnsi(session.outputSince())
      expect(afterLoad).not.toContain('Loading sessions…')
      expect(afterLoad).not.toMatch(/Sessions\s+\d+/)
    } finally {
      await session.kill()
    }
  }, 60_000)

  test('a first prompt invalidates resume caches and exposes its new session', async () => {
    const session = await startEvot()
    try {
      // Opening and closing first creates a complete empty cache. The prompt
      // then persists a formerly unbound session; reopening must not reuse the
      // empty snapshot.
      session.write('/resume\x0d')
      await session.waitFor('No sessions found')
      session.checkpoint()
      session.write('cache refresh smoke\x0d')
      await session.waitFor('┃ cache refresh smoke')
      for (let i = 0; i < 100 && session.persistedSessionCount() !== 1; i++) {
        await Bun.sleep(20)
      }
      expect(session.persistedSessionCount()).toBe(1)

      // Persistence happens before the provider necessarily finishes. Return
      // to an idle composer so the next command is executed, not queued. Esc
      // arms first and interrupts on the confirming press, but only once the
      // run owns a stream: the session reaches disk inside the query, so a
      // press sent before that is not yet an interrupt and would be dropped.
      // Wait for the footer to offer the gesture, then arm it.
      await session.waitForScreen(/esc\s+twice\s+to\s+interrupt/)
      session.checkpoint()
      session.write('\x1b')
      // A retry hint can wrap after `esc`. Differential rendering may only
      // write `again to interrupt`, retaining `esc` from an earlier frame.
      // Assert the actual screen, not contiguous bytes in the output stream.
      await session.waitForScreen(/esc\s+again\s+to\s+interrupt/)
      session.write('\x1b')
      await session.waitFor('Interrupted.')

      session.checkpoint()
      session.write('/resume\x0d')
      // The first paint can be the async metadata placeholder (count 0).
      // Wait for the real list rather than asserting on that intermediate frame.
      const reopened = await session.waitForScreen(/Sessions\s+1(?:\r|\n)/)
      expect(reopened).toContain('Current cwd')
      // The local provider fails promptly, so the fallback title can already
      // be set. Assert the actual prompt rather than racing title generation.
      expect(reopened).toContain('cache refresh smoke')
    } finally {
      await session.kill()
    }
  }, 60_000)

  test('resume defaults to current cwd and searches other cwd on demand', async () => {
    const session = await startEvot(true, true)
    try {
      session.checkpoint()
      session.write('/re')
      const current = await session.waitForScreen(SEEDED_SESSION_ID.slice(0, 8))
      expect(current).toMatch(/Sessions\s+1(?:\r|\n)/)
      expect(current).toContain('smoke resume fixture')
      expect(current).not.toContain('Other cwd')
      expect(current).not.toContain('other cwd fixture')

      // With only one current-project session, the first arrow focuses that
      // row without stopping in the filter input.
      session.checkpoint()
      session.write('\x1b[B')
      await Bun.sleep(100)
      expect(session.outputSince()).not.toContain('\x1b[2J')

      // Typing after activation returns focus to Filter and expands search to
      // cross-project history without making it part of the default recents.
      session.checkpoint()
      session.write('other cwd fixture')
      // The title search produces a context snippet instead of the inline ID.
      const searched = await session.waitForScreen(/Search\s+other cwd fixture(?:\s|$)/)
      expect(searched).toContain('Other cwd')
      expect(searched).toMatch(/·\s+other cwd fixture/)
      expect(searched).not.toContain('smoke resume fixture')
    } finally {
      await session.kill()
    }
  }, 60_000)

  test('resume preview expands beyond the global startup cache without Enter', async () => {
    const session = await startEvot(false, false, true)
    try {
      session.checkpoint()
      session.write('/res')

      // The globally newest 20 fixtures all belong to another cwd, so none of
      // these current-project rows can come from the bounded startup cache.
      // Seeing all three proves the live preview automatically loaded the same
      // complete metadata catalog used by submitted `/resume`.
      await session.waitForScreen('11000000')
      await session.waitForScreen('12000000')
      const expanded = await session.waitForScreen('13000000')
      expect(expanded).toMatch(/Sessions\s+3(?:\r|\n)/)
      expect(expanded).toContain('older current session 1')
      expect(expanded).not.toContain('Other cwd')
      expect(expanded).not.toContain('newer other session')
    } finally {
      await session.kill()
    }
  }, 60_000)

  test('submitting a prompt commits it to the transcript', async () => {
    const session = await startEvot()
    try {
      expect(session.historyEntries()).toEqual([])
      session.write('echo smoke test\x0d')
      await session.waitFor('┃ echo smoke test')
      expect(session.historyEntries()).toEqual(['echo smoke test'])
    } finally {
      await session.kill()
    }
  }, 60_000)

  test('without a published service suggestions use the current local provider and model', async () => {
    let chatRequests = 0
    let suggestionRequests = 0
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: async request => {
      const body = await request.json() as Record<string, unknown>
      expect(body.model).toBe('smoke-model')
      expect(request.headers.get('authorization')).toBe('Bearer smoke-test-key')
      const suggesting = JSON.stringify(body.messages).includes('SUGGESTION MODE')
      let content = 'Implementation is ready. Should I run tests or review the diff?'
      if (suggesting) {
        suggestionRequests++
        suggestionInstructions(body)
        expect(body.tools ?? []).toEqual([])
        expect(body.max_tokens).toBe(192)
        content = 'Run the targeted tests\nReview the diff'
      } else chatRequests++
      const chunk = { id: 'fixture', model: body.model, choices: [{ index: 0,
        delta: { role: 'assistant', content }, finish_reason: 'stop' }] }
      return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
        headers: { 'content-type': 'text/event-stream' },
      })
    } })
    let session: Session | undefined
    try {
      session = await startEvot(false, false, false, `http://127.0.0.1:${server.port}/v1`)
      session.write('Implement the requested change\x0d')
      await session.waitForScreen(/Run the targeted tests\s+1\/2 ⇥/)
      expect(chatRequests).toBe(1)
      expect(suggestionRequests).toBe(1)
      session.write('temporary draft')
      await session.waitForScreen(/^(?![\s\S]*⇥)[\s\S]*temporary draft/)
      session.write('\x7f'.repeat('temporary draft'.length))
      await session.waitForScreen(/Run the targeted tests\s+1\/2 ⇥/)
      session.write('\t')
      await session.waitForScreen(/Review the diff\s+2\/2 ⇥/)
      session.write('\x1b[C')
      await session.waitForScreen(/^(?![\s\S]*⇥)[\s\S]*Review the diff/)
      expect(chatRequests).toBe(1)
      expect(suggestionRequests).toBe(1)
      expect(session.historyEntries()).toEqual(['Implement the requested change'])
    } finally {
      if (session) await session.kill()
      await server.stop(true)
    }
  }, 60_000)

  test('published suggestion returns three cached candidates and Tab wraps without more requests', async () => {
    const input = '\x1b[C'
    let chatRequests = 0
    let suggestionRequests = 0
    const suggestionBodies: string[] = []
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: async request => {
      const body = await request.json() as { model: string; max_tokens: number; messages: { content: string }[] }
      const suggesting = body.model === 'suggestion-fixture'
      let content = 'The implementation is ready. Should I run the targeted tests, review the diff, or commit the change?'
      if (suggesting) {
        suggestionRequests++
        suggestionBodies.push(body.messages.at(-1)?.content ?? '')
        expect(body.max_tokens).toBe(192)
        await Bun.sleep(1600)
        content = 'Run the targeted tests\nReview the diff\nCommit the change'
      } else {
        chatRequests++
      }
      const chunk = { id: 'fixture', model: body.model, choices: [{ index: 0,
        delta: { role: 'assistant', content },
        finish_reason: 'stop',
      }] }
      return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
        headers: { 'content-type': 'text/event-stream' },
      })
    } })
    let session: Session | undefined
    try {
      const baseUrl = `http://127.0.0.1:${server.port}/v1`
      session = await startEvot(false, false, false, baseUrl, stateHome => seedSuggestionService(stateHome, baseUrl))
      session.write('Implement the requested change\x0d')
      await session.waitFor('The implementation is ready.')
      // The very first final answer may already contain a pending decision.
      await session.waitForScreen(/Run the targeted tests\s+1\/3 ⇥/)
      expect(suggestionRequests).toBe(1)
      expect(suggestionBodies[0]).not.toContain('ALREADY REJECTED')
      // Exercise the automatic result before Tab promotes it to explicit input
      // assistance; cycling first would miss automatic-only invalidation.
      for (const [draft, clear] of [
        ['temporary input', '\x15'],
        ['中文输入', '\x03'],
        ['temporary input', '\x7f'.repeat('temporary input'.length)],
        ['中文输入', '\x7f'.repeat(4)],
        ['temporary input', '\x01' + '\x1b[3~'.repeat('temporary input'.length)],
        ['\x1b[200~pasted draft\x1b[201~', '\x15'],
        ['/re', '\x7f'.repeat(3)],
        ['@README', '\x7f'.repeat(7)],
      ] as const) {
        session.write(draft)
        await session.waitForScreen(/^(?![\s\S]*⇥)[\s\S]*/)
        session.write(clear)
        await session.waitForScreen(/Run the targeted tests\s+1\/3 ⇥/)
        expect(suggestionRequests).toBe(1)
      }
      session.write('\t')
      await session.waitForScreen(/Review the diff\s+2\/3 ⇥/)
      session.write('\t')
      await session.waitForScreen(/Commit the change\s+3\/3 ⇥/)
      session.write('\t')
      await session.waitForScreen(/Run the targeted tests\s+1\/3 ⇥/)
      session.write('\t\t')
      await session.waitForScreen(/Commit the change\s+3\/3 ⇥/)
      expect(suggestionRequests).toBe(1)
      // Typing hides the placeholder without discarding its selected candidate.
      session.write('temporary draft')
      await session.waitForScreen(/^(?![\s\S]*⇥)[\s\S]*temporary draft/)
      session.write('\x15') // Ctrl+U clears the draft.
      await session.waitForScreen(/Commit the change\s+3\/3 ⇥/)
      session.write('x')
      await session.waitForScreen(/^(?![\s\S]*⇥)[\s\S]*x/)
      session.write('\x7f') // Backspace also restores the placeholder.
      await session.waitForScreen(/Commit the change\s+3\/3 ⇥/)
      expect(suggestionRequests).toBe(1)
      const beforeAccept = chatRequests
      session.write(input)
      const screen = await session.waitForScreen(/^(?![\s\S]*⇥)[\s\S]*Commit the change/)
      expect(screen).not.toContain('⇥')
      expect(chatRequests).toBe(beforeAccept)
      // Once accepted, Right is ordinary cursor motion again, not a second
      // acceptance or submission; typing continues to edit the same draft.
      session.write('\x1b[D\x1b[C!')
      await session.waitForScreen(/Commit the change!/)
      expect(chatRequests).toBe(beforeAccept)
      expect(session.historyEntries()).toEqual(['Implement the requested change'])
    } finally {
      if (session) await session.kill()
      await server.stop(true)
    }
  }, 60_000)

  test('draft Tab retries an initial failure then cycles the same three completions locally', async () => {
    let chats = 0
    const drafts: string[] = []
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: async request => {
      const body = await request.json() as { model: string; messages: { content: string }[] }
      let content = 'What can I help you with?'
      if (body.model === 'suggestion-fixture') {
        const prompt = suggestionInstructions(body)
        content = '' // No unprompted suggestion for the greeting.
        if (prompt.includes('CURSOR REWRITE MODE') && prompt.includes('"prefix":"hi --"')) {
          drafts.push(prompt)
          await Bun.sleep(700)
          if (drafts.length === 1) return new Response(JSON.stringify({ error: { message: 'temporary failure' } }), { status: 503 })
          content = JSON.stringify([' help me debug this?', ' explain this code', ' review this change'])
        }
      } else chats++
      const chunk = { id: 'fixture', model: body.model, choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: 'stop' }] }
      return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } })
    } })
    let session: Session | undefined
    try {
      const base = `http://127.0.0.1:${server.port}/v1`
      session = await startEvot(false, false, false, base, home => seedSuggestionService(home, base))
      session.write('hi\x0d')
      await session.waitForScreen(/What can I help you with/)
      await session.waitForScreen(/Enter a coding task/)
      session.write('hi --\t')
      await session.waitForScreen(/suggesting…/)
      await session.waitForScreen(/suggestion failed · ⇥ retry/)
      session.write('\t')
      await session.waitForScreen(/help me debug this\?\s+1\/3 ⇥/)
      session.write('\t')
      await session.waitForScreen(/explain this code\s+2\/3 ⇥/)
      session.write('\t')
      await session.waitForScreen(/review this change\s+3\/3 ⇥/)
      session.write('\t')
      await session.waitForScreen(/help me debug this\?\s+1\/3 ⇥/)
      expect(drafts).toHaveLength(2)
      expect(drafts[1]).not.toContain('ALREADY REJECTED')
      session.write('\x1b[C')
      await session.waitForScreen(/^(?![\s\S]*⇥)[\s\S]*hi -- help me debug this\?/)
      expect(chats).toBe(1)
      expect(session.historyEntries()).toEqual(['hi'])
    } finally {
      if (session) await session.kill()
      await server.stop(true)
    }
  }, 60_000)

  test('Tab assists input during foreground work and keeps the cached batch after completion', async () => {
    let foreground = 0
    let suggestions = 0
    let finishForeground: (() => void) | undefined
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: async request => {
      const body = await request.json() as { model: string; messages: { content: string }[] }
      if (body.model !== 'suggestion-fixture') {
        foreground++
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(': waiting\n\n'))
            finishForeground = () => {
              const chunk = { id: 'work', model: body.model, choices: [{ index: 0,
                delta: { role: 'assistant', content: 'Foreground work completed.' }, finish_reason: 'stop' }] }
              controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`))
              controller.close()
            }
          },
        }), { headers: { 'content-type': 'text/event-stream' } })
      }
      suggestions++
      const prompt = suggestionInstructions(body)
      expect(prompt).toContain('CURSOR REWRITE MODE')
      await Bun.sleep(500)
      const chunk = { id: 'suggestion', model: body.model, choices: [{ index: 0,
        delta: { role: 'assistant', content: JSON.stringify([' target', ' approach', ' schedule']) }, finish_reason: 'stop' }] }
      return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } })
    } })
    let session: Session | undefined
    try {
      const base = `http://127.0.0.1:${server.port}/v1`
      session = await startEvot(false, false, false, base, home => seedSuggestionService(home, base))
      session.write('Run the long task\x0d')
      await session.waitForScreen(/Guide.*works/)
      session.write('Change the\t')
      await session.waitForScreen(/suggesting…/)
      await session.waitForScreen(/target\s+1\/3 ⇥/)
      session.write('\t')
      await session.waitForScreen(/approach\s+2\/3 ⇥/)
      session.write('\t')
      await session.waitForScreen(/schedule\s+3\/3 ⇥/)
      expect(foreground).toBe(1)
      expect(suggestions).toBe(1)
      if (!finishForeground) throw new Error('foreground stream did not start')
      finishForeground()
      await session.waitForScreen(/Foreground work completed/)
      await session.waitForScreen(/schedule\s+3\/3 ⇥/)
      session.write('\t')
      await session.waitForScreen(/target\s+1\/3 ⇥/)
      expect(suggestions).toBe(1)
      session.write('\x1b[C')
      await session.waitForScreen(/^(?![\s\S]*⇥)[\s\S]*Change the target/)
      expect(foreground).toBe(1)
      expect(session.historyEntries()).toEqual(['Run the long task'])
    } finally {
      if (session) await session.kill()
      await server.stop(true)
    }
  }, 60_000)

  test('Tab after an interrupted turn can generate from a trailing user and cycle without more requests', async () => {
    let suggestions = 0
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: async request => {
      const body = await request.json() as { model: string; messages: { role: string; content: string }[] }
      if (body.model !== 'suggestion-fixture') return new Response(new ReadableStream({
        start(controller) { controller.enqueue(new TextEncoder().encode(': waiting\n\n')) },
      }), { headers: { 'content-type': 'text/event-stream' } })
      suggestions++
      suggestionInstructions(body)
      await Bun.sleep(500)
      const chunk = { id: 'fixture', model: body.model, choices: [{ index: 0,
        delta: { role: 'assistant', content: JSON.stringify([' current changes', ' after reviewing the diff', ' and push the branch']) }, finish_reason: 'stop' }] }
      return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } })
    } })
    let session: Session | undefined
    try {
      const base = `http://127.0.0.1:${server.port}/v1`
      session = await startEvot(false, false, false, base, home => seedSuggestionService(home, base))
      session.write('Commit\x0d')
      await session.waitFor('┃ Commit')
      session.write('\x1b')
      await session.waitFor(/esc\s+again\s+to\s+interrupt/)
      session.write('\x1b')
      await session.waitFor('Interrupted.')
      expect(suggestions).toBe(0)
      session.write('Commit\t')
      await session.waitForScreen(/suggesting…/)
      await session.waitForScreen(/ current changes\s+1\/3 ⇥/)
      session.write('\t')
      await session.waitForScreen(/ after reviewing the diff\s+2\/3 ⇥/)
      session.write('\t')
      await session.waitForScreen(/ and push the branch\s+3\/3 ⇥/)
      session.write('\t')
      await session.waitForScreen(/ current changes\s+1\/3 ⇥/)
      expect(suggestions).toBe(1)
      session.write('\x1b[C')
      await session.waitForScreen(/^(?![\s\S]*⇥)[\s\S]*Commit current changes/)
      expect(session.historyEntries()).toEqual(['Commit'])
    } finally {
      if (session) await session.kill()
      await server.stop(true)
    }
  }, 60_000)

  test('Esc only dismisses input assistance, undo restores the suffix, and repeated drafts use cache', async () => {
    let foreground = 0
    let predictions = 0
    let finish: (() => void) | undefined
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: async request => {
      const body = await request.json() as Record<string, unknown>
      if (body.model !== 'suggestion-fixture') {
        foreground++
        return new Response(new ReadableStream<Uint8Array>({ start(controller) {
          controller.enqueue(new TextEncoder().encode(': waiting\n\n'))
          finish = () => {
            const chunk = { id: 'work', model: body.model, choices: [{ index: 0, delta: { role: 'assistant', content: 'Work completed normally.' }, finish_reason: 'stop' }] }
            controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`))
            controller.close()
          }
        } }), { headers: { 'content-type': 'text/event-stream' } })
      }
      predictions++
      const instructions = suggestionInstructions(body)
      expect(instructions).toContain('CURRENT STAGE: foreground_running')
      const chunk = { id: 'prediction', model: body.model, choices: [{ index: 0, delta: { role: 'assistant', content: JSON.stringify(['new', 'another', 'later']) }, finish_reason: 'stop' }] }
      return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } })
    } })
    let session: Session | undefined
    try {
      const base = `http://127.0.0.1:${server.port}/v1`
      session = await startEvot(false, false, false, base, home => seedSuggestionService(home, base))
      session.write('Run the task\x0d')
      await session.waitForScreen(/Guide.*works/)
      session.write('Run old\x01' + '\x1b[C'.repeat(4) + '\t')
      await session.waitForScreen(/new\s+1\/3.*replace rest/)
      session.write('\x1b')
      const screen = await session.waitForScreen(/Run old/)
      expect(screen).not.toMatch(/esc\s+again\s+to\s+interrupt/)
      expect(screen).not.toContain('Interrupted.')
      session.write('\t')
      await session.waitForScreen(/new\s+1\/3.*replace rest/)
      expect(predictions).toBe(1)
      session.write('\x1b[C')
      await session.waitForScreen(/Run new/)
      session.write('\x1f')
      await session.waitForScreen(/Run old/)
      expect(foreground).toBe(1)
      if (!finish) throw new Error('foreground did not start')
      finish()
      await session.waitForScreen(/Work completed normally/)
      expect(session.historyEntries()).toEqual(['Run the task'])
    } finally {
      if (session) await session.kill()
      await server.stop(true)
    }
  }, 60_000)

  test('first suggestion is usable before the rest of the streamed batch', async () => {
    let requests = 0
    let second: (() => void) | undefined
    let finish: (() => void) | undefined
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: async request => {
      const body = await request.json() as Record<string, unknown>
      expect(body.model).toBe('suggestion-fixture')
      suggestionInstructions(body)
      requests++
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          const send = (content: string, stop = false) => controller.enqueue(new TextEncoder().encode(
            `data: ${JSON.stringify({ id: 'progress', model: body.model, choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: stop ? 'stop' : null }] })}\n\n`,
          ))
          send('["unit tests",')
          second = () => send('"integration tests",')
          finish = () => { send('"smoke tests"]', true); controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n')); controller.close() }
        },
      }), { headers: { 'content-type': 'text/event-stream' } })
    } })
    let session: Session | undefined
    try {
      const base = `http://127.0.0.1:${server.port}/v1`
      session = await startEvot(false, false, false, base, home => seedSuggestionService(home, base))
      session.write('Run \t')
      // The server deliberately has not finished. Waiting for the full batch
      // would deadlock this test before either release callback can run.
      await session.waitForScreen(/unit tests\s+⇥/)
      expect(requests).toBe(1)
      session.write('\t')
      if (!second) throw new Error('stream not started')
      second()
      await session.waitForScreen(/integration tests\s+2\/2 ⇥/)
      if (!finish) throw new Error('stream not started')
      finish()
      await session.waitForScreen(/integration tests\s+2\/3 ⇥/)
      session.write('\t')
      await session.waitForScreen(/smoke tests\s+3\/3 ⇥/)
      session.write('\x1b[C')
      await session.waitForScreen(/^(?![\s\S]*⇥)[\s\S]*Run smoke tests/)
      expect(requests).toBe(1)
      expect(session.historyEntries()).toEqual([])
    } finally {
      if (session) await session.kill()
      await server.stop(true)
    }
  }, 60_000)

  test('path Tab completion wins in prose and slash arguments without model requests', async () => {
    const requests: Record<string, unknown>[] = []
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: async request => {
      const body = await request.json() as Record<string, unknown>
      requests.push(body)
      expect(body.model).toBe('suggestion-fixture')
      suggestionInstructions(body)
      const chunk = { id: 'suggestion', model: body.model, choices: [{ index: 0,
        delta: { role: 'assistant', content: JSON.stringify(['and report failures', 'and check logs', 'and summarize findings']) }, finish_reason: 'stop' }] }
      return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } })
    } })
    let session: Session | undefined
    try {
      const base = `http://127.0.0.1:${server.port}/v1`
      session = await startEvot(false, false, false, base, home => seedSuggestionService(home, base))
      session.write('Read ../cli/tests/completion.te\t')
      let screen = await session.waitForScreen(/Read \.\.\/cli\/tests\/completion\.test\.ts/)
      expect(screen).not.toContain('suggesting…')
      expect(requests).toHaveLength(0)
      session.write('\x15/loop inspect ../cli/tests/completion.te\t')
      screen = await session.waitForScreen(/\/loop inspect \.\.\/cli\/tests\/completion\.test\.ts/)
      expect(screen).not.toContain('suggesting…')
      expect(requests).toHaveLength(0)
      // Once the path token is finished, a space returns Tab to intent input.
      session.write(' \t')
      await session.waitForScreen(/and report failures/)
      expect(requests).toHaveLength(1)
      session.write('\x1b[C')
      await session.waitForScreen(/completion\.test\.ts and report failures/)
      expect(session.historyEntries()).toEqual([])
    } finally {
      if (session) await session.kill()
      await server.stop(true)
    }
  }, 60_000)

  test('caret rewrites and slash arguments share cached input assistance without submitting', async () => {
    const prompts: string[] = []
    let foregroundRequests = 0
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: async request => {
      const body = await request.json() as Record<string, unknown>
      if (body.model !== 'suggestion-fixture') foregroundRequests++
      const prompt = suggestionInstructions(body)
      prompts.push(prompt)
      expect(body.max_tokens).toBe(320)
      const options = prompt.includes('COMMAND ARGUMENT ASSISTANCE')
        ? prompt.includes('"suffix":"rerun tests"') ? ['watch CI', 'rerun failed tests', 'check status'] : [' 5m watch CI', ' 10m rerun tests', ' status']
        : ['unit tests', 'integration tests', 'smoke tests']
      const chunk = { id: 'suggestion', model: body.model, choices: [{ index: 0,
        delta: { role: 'assistant', content: JSON.stringify(options) }, finish_reason: 'stop' }] }
      return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } })
    } })
    let session: Session | undefined
    try {
      const base = `http://127.0.0.1:${server.port}/v1`
      session = await startEvot(false, false, false, base, home => seedSuggestionService(home, base))
      session.write('Run the old suite\x01' + '\x1b[C'.repeat(8) + '\t')
      let screen = await session.waitForScreen(/unit tests\s+1\/3.*replace rest/)
      expect(screen).not.toContain('old suite')
      expect(prompts[0]).toContain('"prefix":"Run the "')
      expect(prompts[0]).toContain('"suffix":"old suite"')
      // Cancelling the preview restores the original suffix unchanged.
      session.write('\x1b[D')
      await session.waitForScreen(/old suite/)
      session.write('\x1b[C\t')
      await session.waitForScreen(/unit tests\s+1\/3.*replace rest/)
      session.write('\t')
      await session.waitForScreen(/integration tests\s+2\/3.*replace rest/)
      session.write('\x1b[C')
      screen = await session.waitForScreen(/^(?![\s\S]*⇥)[\s\S]*Run the integration tests/)
      expect(screen).not.toContain('old suite')
      expect(prompts).toHaveLength(1)
      // Partial names keep local completion and cannot issue a model request.
      session.write('\x15/lo\t')
      await session.waitForScreen(/\/loop/)
      expect(prompts).toHaveLength(1)
      session.write('\x15/loop\t')
      await session.waitForScreen(/5m watch CI\s+1\/3 ⇥/)
      expect(prompts[1]).toContain('COMMAND ARGUMENT ASSISTANCE')
      expect(prompts[1]).toContain('/loop [interval] [prompt] | stop | status')
      session.write('\t')
      await session.waitForScreen(/10m rerun tests\s+2\/3 ⇥/)
      session.write('\x1b[C')
      await session.waitForScreen(/^(?![\s\S]*⇥)[\s\S]*\/loop 10m rerun tests/)
      // Command arguments support the same caret rewrite as ordinary prose.
      session.write('\x01' + '\x1b[C'.repeat(10) + '\t')
      await session.waitForScreen(/watch CI\s+1\/3.*replace rest/)
      expect(prompts[2]).toContain('"prefix":"/loop 10m "')
      expect(prompts[2]).toContain('"suffix":"rerun tests"')
      session.write('\x1b[C')
      await session.waitForScreen(/^(?![\s\S]*⇥)[\s\S]*\/loop 10m watch CI/)
      expect(prompts).toHaveLength(3)
      expect(foregroundRequests).toBe(0)
      expect(session.historyEntries()).toEqual([])
    } finally {
      if (session) await session.kill()
      await server.stop(true)
    }
  }, 60_000)

  test.each([0, 1])('resume input schema v%i keeps runtime context out of user bubbles and Tab requests', async version => {
    const requests: Record<string, unknown>[] = []
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: async request => {
      const body = await request.json() as Record<string, unknown>
      requests.push(body)
      expect(body.model).toBe('suggestion-fixture')
      const instructions = suggestionInstructions(body)
      const candidates = ['Review the diff', 'Run tests first', 'Commit changes']
      const content = instructions.includes('CURSOR REWRITE MODE') ? JSON.stringify(candidates) : candidates.join('\n')
      const chunk = { id: 'suggestion', model: body.model, choices: [{ index: 0,
        delta: { role: 'assistant', content }, finish_reason: 'stop' }] }
      return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } })
    } })
    let session: Session | undefined
    let transcriptPath = ''
    let original = ''
    try {
      const base = `http://127.0.0.1:${server.port}/v1`
      session = await startEvot(false, false, false, base, home => {
        seedResumeSession(home)
        seedSuggestionService(home, base)
        const item = JSON.parse(readFileSync(new URL(`../../../src/app/tests/fixtures/schema/user-input-v${version}.json`, import.meta.url), 'utf8'))
        transcriptPath = join(home, 'sessions', SEEDED_SESSION_ID, 'transcript.jsonl')
        original = `${JSON.stringify([{ session_id: SEEDED_SESSION_ID, run_id: null, seq: 1, turn: 1,
          item, created_at: new Date().toISOString() }])}\n`
        writeFileSync(transcriptPath, original)
      }, ['--resume', SEEDED_SESSION_ID])
      const screen = await session.waitForScreen(/resumed session/)
      expect(screen).toContain('Commit')
      expect(screen).not.toContain('<system-reminder>')
      expect(screen).not.toContain('Context supplied by an earlier runtime')
      expect(screen).not.toContain('Arbitrary runtime content')
      // Recovery now also samples an unfinished restored exchange.
      await session.waitForScreen(/Review the diff\s+1\/3 ⇥/)
      session.write('\t')
      await session.waitForScreen(/Run tests first\s+2\/3 ⇥/)
      session.write('\t')
      await session.waitForScreen(/Commit changes\s+3\/3 ⇥/)
      session.write('\t')
      await session.waitForScreen(/Review the diff\s+1\/3 ⇥/)
      expect(requests).toHaveLength(1)
      const modelInput = JSON.stringify(requests[0]!.messages)
      expect(modelInput).toContain('Commit')
      expect(modelInput).not.toContain('<system-reminder>')
      expect(modelInput).not.toContain('Context supplied by an earlier runtime')
      expect(modelInput).not.toContain('Arbitrary runtime content')
      expect(readFileSync(transcriptPath, 'utf8')).toBe(original)
    } finally {
      if (session) await session.kill()
      await server.stop(true)
    }
  }, 60_000)

  test('resume and plan transitions keep product guidance local and model input recent-only', async () => {
    const contexts: string[] = []
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: async request => {
      const body = await request.json() as { model: string; messages: { content: string }[] }
      expect(body.model).toBe('suggestion-fixture')
      const instruction = suggestionInstructions(body)
      contexts.push(instruction)
      const text = contexts.length === 2 ? '/done' : 'Continue the login tests'
      const chunk = { id: 'fixture', model: body.model, choices: [{ index: 0,
        delta: { role: 'assistant', content: text }, finish_reason: 'stop' }] }
      return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } })
    } })
    let session: Session | undefined
    try {
      const base = `http://127.0.0.1:${server.port}/v1`
      session = await startEvot(true, false, false, base, home => { seedSuggestionService(home, base); seedCompletedSuggestionHistory(home) })
      session.write(`/resume ${SEEDED_SESSION_ID}\x0d`)
      await session.waitForScreen(/Continue the login tests\s+⇥/)
      expect(contexts).toHaveLength(1)
      session.write('/plan\x0d')
      const screen = await session.waitForScreen(/\/done\s+⇥/)
      expect(screen).toContain('no edits')
      expect(contexts[1]).toContain('"mode":"plan"')
      expect(contexts[0]).toContain('"mode":"normal"')
      session.write('/done\x0d')
      await session.waitForScreen(/Continue the login tests\s+⇥/)
      expect(contexts).toHaveLength(3)
      expect(contexts[2]).toBe(contexts[0])
      session.write('\x1b')
      await session.waitForScreen(/Enter a coding task/)
      expect(contexts).toHaveLength(3)
    } finally {
      if (session) await session.kill()
      await server.stop(true)
    }
  }, 60_000)

  for (const scenario of [
    { name: 'interrupted work', reason: 'aborted', text: '- [x] Implement changes\n- [ ] Run validation', candidate: 'Resume remaining validation' },
    { name: 'pending question', reason: 'stop', text: 'Unit tests or integration tests?', candidate: 'Run the unit tests' },
    { name: 'tool-only interrupted work', reason: 'aborted', text: '', candidate: 'Continue the remaining validation', execution: true },
  ]) test(`workflow-aware resume distinguishes ${scenario.name} without executing input`, async () => {
    const requests: Record<string, unknown>[] = []
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: async request => {
      const body = await request.json() as Record<string, unknown>
      expect(body.model).toBe('suggestion-fixture')
      requests.push(body)
      const instruction = suggestionInstructions(body)
      expect(suggestionWorkflow(body).last_turn).toBe(scenario.reason === 'stop' ? 'answered' : 'interrupted')
      expect(instruction).toContain('"session":"resumed"')
      expect(instruction).toContain('"background_tasks":0')
      if ('execution' in scenario) {
        expect(instruction).toContain('"since_last_reply":3')
        expect(instruction).toContain('Inspect the remaining layout mismatch')
        expect(suggestionWorkflow(body).progress?.awaiting_input).toBe(false)
        expect(JSON.stringify(body)).not.toContain('DO_NOT_SEND')
      }
      const text = instruction.includes('CURSOR REWRITE MODE') ? JSON.stringify([scenario.candidate]) : scenario.candidate
      const chunk = { id: 'workflow', model: body.model, choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: 'stop' }] }
      return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } })
    } })
    let session: Session | undefined
    try {
      const base = `http://127.0.0.1:${server.port}/v1`
      session = await startEvot(true, false, false, base, home => {
        seedSuggestionService(home, base)
        const path = join(home, 'sessions', SEEDED_SESSION_ID, 'transcript.jsonl')
        const entries = JSON.parse(readFileSync(path, 'utf8').trim()) as Record<string, unknown>[]
        const items: Record<string, unknown>[] = 'execution' in scenario
          ? JSON.parse(readFileSync(new URL('../fixtures/suggestion-interrupted-execution.json', import.meta.url), 'utf8'))
          : [{ type: 'assistant', content: [{ type: 'text', text: scenario.text }], stop_reason: scenario.reason }]
        for (const [index, item] of items.entries()) {
          entries.push({ session_id: SEEDED_SESSION_ID, run_id: null, seq: index + 2, turn: 1, created_at: new Date().toISOString(),
            item: { usage: { input: 0, output: 0 }, model: 'smoke-model', provider: 'smoke', timestamp: 0, ...item } })
        }
        writeFileSync(path, `${JSON.stringify(entries)}\n`)
      }, ['--resume', SEEDED_SESSION_ID])
      await session.waitForScreen(scenario.candidate)
      // Dismiss then explicitly request again; both routes carry workflow.
      session.write('\x1b')
      await session.waitForScreen(/Enter a coding task/)
      session.write('\t')
      await session.waitForScreen(scenario.candidate)
      session.write('\x1b[C')
      await session.waitForScreen(new RegExp(`^(?![\\s\\S]*⇥)[\\s\\S]*${scenario.candidate}`))
      expect(session.historyEntries()).toEqual([])
      expect(requests).toHaveLength(2)
      expect(suggestionInstructions(requests[1]!)).toContain('CURSOR REWRITE MODE')
    } finally {
      if (session) await session.kill()
      await server.stop(true)
    }
  }, 60_000)

  test('completed work stays quiet on resume and Tab, while an explicit new draft still works', async () => {
    let requests = 0
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: async request => {
      requests++
      const body = await request.json() as Record<string, unknown>
      const instruction = suggestionInstructions(body)
      const explicit = instruction.includes('"prefix":"Explain "')
      const text = explicit ? JSON.stringify(['why catalog synchronization delayed the UI'])
        : instruction.includes('CURSOR REWRITE MODE') ? '[]' : ''
      const chunk = { id: 'explicit-followup', model: body.model, choices: [{ index: 0,
        delta: { role: 'assistant', content: text }, finish_reason: 'stop' }] }
      return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } })
    } })
    let session: Session | undefined
    try {
      const base = `http://127.0.0.1:${server.port}/v1`
      session = await startEvot(true, false, false, base, home => {
        seedSuggestionService(home, base)
        seedSuggestionConversation(home, closedFixture.messages)
      }, ['--resume', SEEDED_SESSION_ID])
      session.write('\t')
      await session.waitForScreen(/nothing to suggest/)
      expect(requests).toBeGreaterThan(0) // abstention comes from the model, not a local question-mark gate
      const beforeDraft = requests
      session.write('Explain \t')
      await session.waitForScreen(/why catalog synchronization delayed the UI/)
      expect(requests).toBe(beforeDraft + 1)
      expect(session.historyEntries()).toEqual([])
    } finally {
      if (session) await session.kill()
      await server.stop(true)
    }
  }, 60_000)

  test('remote work reported without a question still gets grounded suggestions on resume and Tab', async () => {
    let requests = 0
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: async request => {
      requests++
      const body = await request.json() as Record<string, unknown>
      expect(body.model).toBe('suggestion-fixture')
      const instruction = suggestionInstructions(body)
      expect(JSON.stringify(body.messages)).toContain('The image build has started')
      expect(instruction).toContain('"execution":"idle"')
      expect(suggestionWorkflow(body).runtime.background_tasks).toBe(0)
      const candidates = ['Check the image build progress', 'Show the resulting image tag']
      const text = instruction.includes('CURSOR REWRITE MODE') ? JSON.stringify(candidates) : candidates.join('\n')
      const chunk = { id: 'remote-work', model: body.model, choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: 'stop' }] }
      return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } })
    } })
    let session: Session | undefined
    try {
      const base = `http://127.0.0.1:${server.port}/v1`
      session = await startEvot(true, false, false, base, home => {
        seedSuggestionService(home, base)
        seedSuggestionConversation(home, externalWorkFixture.messages)
      }, ['--resume', SEEDED_SESSION_ID])
      await session.waitForScreen(/Check the image build progress\s+1\/2 ⇥/)
      session.write('\x1b')
      await session.waitForScreen(/Enter a coding task/)
      session.write('\t')
      await session.waitForScreen(/Check the image build progress\s+1\/2 ⇥/)
      session.write('\t')
      await session.waitForScreen(/Show the resulting image tag\s+2\/2 ⇥/)
      expect(requests).toBe(2)
      expect(session.historyEntries()).toEqual([])
    } finally {
      if (session) await session.kill()
      await server.stop(true)
    }
  }, 60_000)

  for (const scenario of [
    { name: 'validated but uncommitted changes offer a grounded handoff without sending or executing it',
      messages: handoffFixture.messages, evidence: 'have not been committed or pushed',
      candidates: ['Commit the documentation changes', 'Commit and push the changes'] },
    { name: 'quality assessment suggestions preserve the latest deferral through resume, Tab and acceptance',
      messages: generalityCases.find(item => item.name === 'quality assessment supersedes earlier release request')?.request.messages ?? [],
      evidence: 'Do not commit yet', candidates: ['Show actual suggestion examples', 'Investigate the failed evaluation request'] },
  ]) test(scenario.name, async () => {
    let requests = 0
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: async request => {
      requests++
      const body = await request.json() as Record<string, unknown>
      expect(body.model).toBe('suggestion-fixture')
      const instruction = suggestionInstructions(body)
      expect(suggestionWorkflow(body).last_turn).toBe('answered')
      expect(JSON.stringify(body.messages)).toContain(scenario.evidence)
      const candidates = scenario.candidates
      const content = instruction.includes('CURSOR REWRITE MODE') ? JSON.stringify(candidates) : candidates.join('\n')
      const chunk = { id: 'handoff', model: body.model, choices: [{ index: 0,
        delta: { role: 'assistant', content }, finish_reason: 'stop' }] }
      return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } })
    } })
    let session: Session | undefined
    try {
      const base = `http://127.0.0.1:${server.port}/v1`
      session = await startEvot(true, false, false, base, home => {
        seedSuggestionService(home, base)
        expect(scenario.messages.length).toBeGreaterThan(0)
        seedSuggestionConversation(home, scenario.messages)
      }, ['--resume', SEEDED_SESSION_ID])
      await session.waitForScreen(new RegExp(`${scenario.candidates[0]}\\s+1/2 ⇥`))
      session.write('\x1b')
      await session.waitForScreen(/Enter a coding task/)
      session.write('\t')
      await session.waitForScreen(new RegExp(`${scenario.candidates[0]}\\s+1/2 ⇥`))
      session.write('\t')
      await session.waitForScreen(new RegExp(`${scenario.candidates[1]}\\s+2/2 ⇥`))
      session.write('\x1b[C')
      await session.waitForScreen(new RegExp(`^(?![\\s\\S]*⇥)[\\s\\S]*${scenario.candidates[1]}`))
      expect(requests).toBe(2)
      expect(session.historyEntries()).toEqual([])
    } finally {
      if (session) await session.kill()
      await server.stop(true)
    }
  }, 60_000)

  test('startup resume produces one suggestion without a new turn', async () => {
    let requests = 0
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: async request => {
      const body = await request.json() as { model: string; messages: { content: string }[] }
      expect(body.model).toBe('suggestion-fixture')
      // The oldest ask falls out of the verbatim window but is carried, condensed,
      // in the trajectory so the long-horizon goal is not lost.
      expect(body.messages.slice(0, -1).every(message => !message.content.includes('smoke resume prompt'))).toBe(true)
      const instruction = suggestionInstructions(body)
      expect(instruction).toContain('TRAJECTORY')
      expect(instruction).toContain('1. [fresh] → user: "smoke resume prompt"')
      expect(instruction).toContain('CURRENT STAGE: answered')
      requests++
      const chunk = { id: 'fixture', model: body.model, choices: [{ index: 0,
        delta: { role: 'assistant', content: 'Review the most recent refinement' }, finish_reason: 'stop' }] }
      return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } })
    } })
    let session: Session | undefined
    try {
      const base = `http://127.0.0.1:${server.port}/v1`
      session = await startEvot(true, false, false, base, home => {
        seedSuggestionService(home, base)
        const path = join(home, 'sessions', SEEDED_SESSION_ID, 'transcript.jsonl')
        const original = JSON.parse(readFileSync(path, 'utf8').trim()) as Record<string, unknown>[]
        const followups = Array.from({ length: 100 }, (_, index) => ({
          session_id: SEEDED_SESSION_ID, run_id: null, seq: index + 2, turn: index + 2,
          item: index % 2 === 0 ? { type: 'user', text: `Recent refinement ${index} ${'current task '.repeat(30)}`, content: [] }
            : { type: 'assistant', content: [{ type: 'text', text: `Completed refinement ${index} ${'current result '.repeat(30)}${index === 99 ? ' Which recent refinement should I check next?' : ''}` }], model: 'test-model', provider: 'test-provider', usage: { input: 0, output: 0, cache_read: 0, cache_write: 0, total_tokens: 0 },  stop_reason: 'stop' },
          created_at: new Date().toISOString(),
        }))
        writeFileSync(path, `${JSON.stringify([...original, ...followups])}\n`)
      }, ['--resume', SEEDED_SESSION_ID])
      await session.waitForScreen(/Review the most recent refinement\s+⇥/)
      expect(requests).toBe(1)
    } finally {
      if (session) await session.kill()
      await server.stop(true)
    }
  }, 60_000)

  test('pasted images above the old text limit survive Tab cycling, acceptance and cursor rewrites', async () => {
    const image = suggestionImageFixture()
    expect(image.length).toBeGreaterThan(100_000)
    const imageCounts: number[] = []
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: async request => {
      const body = await request.json() as Record<string, unknown>
      expect(body.model).toBe('suggestion-fixture')
      const instruction = suggestionInstructions(body)
      const messages = body.messages as { content: string | { type: string; image_url?: { url: string } }[] }[]
      const content = messages.at(-1)?.content
      const images = Array.isArray(content) ? content.filter(block => block.type === 'image_url') : []
      imageCounts.push(images.length)
      const index = imageCounts.length
      if (index < 3) {
        expect(images).toHaveLength(1)
        expect(images[0]?.image_url?.url).toBe(`data:image/png;base64,${image}`)
        expect(instruction).toContain('Use the visible images')
      }
      const candidates = index === 1 ? [' explain the screenshot', ' inspect the layout']
        : index === 2 ? ['Review this screenshot [Image #1]', 'Compare the layout [Image #1]'] : [' the tests']
      const chunk = { id: 'image-suggestion', model: body.model, choices: [{ index: 0, delta: { role: 'assistant', content: JSON.stringify(candidates) }, finish_reason: 'stop' }] }
      return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } })
    } })
    let session: Session | undefined
    try {
      const base = `http://127.0.0.1:${server.port}/v1`
      session = await startEvot(false, false, false, base, home => {
        seedSuggestionService(home, base)
        fixtureClipboard(home, image)
      }, [], home => ({ PATH: `${join(home, 'clipboard-bin')}:${process.env.PATH ?? ''}` }))
      session.write('\x16')
      await session.waitForScreen('[Image #1]')
      session.write('\t')
      await session.waitForScreen(/explain the screenshot\s+1\/2 ⇥/)
      session.write('\t\x1b[C')
      await session.waitForScreen(/\[Image #1\] inspect the layout/)
      expect(imageCounts).toEqual([1])
      session.write('\x01\t')
      await session.waitForScreen(/Review this screenshot \[Image #1\]\s+1\/2 ⇥/)
      session.write('\x1b[C')
      await session.waitForScreen(/^(?![\s\S]*⇥)[\s\S]*Review this screenshot \[Image #1\]/)
      session.write('\x15Run\t')
      await session.waitForScreen(/the tests\s+⇥/)
      expect(imageCounts).toEqual([1, 1, 0])
      expect(session.historyEntries()).toEqual([])
    } finally {
      if (session) await session.kill()
      await server.stop(true)
    }
  }, 60_000)

  test('background suggestions follow the live task both during a reply and after interruption', async () => {
    let mainCalls = 0
    const states: string[] = []
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: async request => {
      const body = await request.json() as Record<string, unknown>
      if (body.model === 'suggestion-fixture') {
        const prompt = suggestionInstructions(body)
        expect(suggestionWorkflow(body).runtime.activities?.length).toBeGreaterThan(0)
        expect(prompt).toContain('Run focused authentication tests')
        expect(prompt).toContain('"kind":"background"')
        expect(prompt).not.toContain('PRIVATE_SHELL_MARKER')
        states.push(prompt)
        const chunk = { id: 'bg-suggestion', model: body.model, choices: [{ index: 0, delta: { role: 'assistant', content: JSON.stringify(['Check authentication test progress', 'Show the latest test results']) }, finish_reason: 'stop' }] }
        return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } })
      }
      mainCalls++
      if (mainCalls === 1) {
        const chunk = { id: 'bg', model: body.model, choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'bg-auth', type: 'function', function: { name: 'bash', arguments: JSON.stringify({ command: 'sleep 30 # PRIVATE_SHELL_MARKER', description: 'Run focused authentication tests', run_in_background: true }) } }] }, finish_reason: 'tool_calls' }] }
        return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } })
      }
      return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(': waiting\n\n')) } }), { headers: { 'content-type': 'text/event-stream' } })
    } })
    let session: Session | undefined
    try {
      const base = `http://127.0.0.1:${server.port}/v1`
      session = await startEvot(false, false, false, base, home => seedSuggestionService(home, base))
      session.write('Run authentication tests\x0d')
      await session.waitFor('1 background shell running')
      session.write('\t')
      await session.waitForScreen(/Check authentication test progress\s+1\/2 ⇥/)
      expect(states[0]).toContain('"execution":"running"')
      session.write('\x1b') // dismiss only
      await session.waitForScreen(/Guide.*works/)
      session.write('\x1b')
      await session.waitForScreen(/esc\s+again\s+to\s+interrupt/)
      session.write('\x1b')
      await session.waitFor('Interrupted.')
      session.write('\t')
      await session.waitForScreen(/Check authentication test progress\s+1\/2 ⇥/)
      expect(states[1]).toContain('"execution":"waiting"')
      expect(mainCalls).toBe(2)
      expect(session.historyEntries()).toEqual(['Run authentication tests'])
    } finally {
      if (session) await session.kill()
      await server.stop(true)
    }
  }, 60_000)

  test('a running loop exposes its current goal and cycle without suggesting a second run', async () => {
    let mainCalls = 0
    let suggestions = 0
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: async request => {
      const body = await request.json() as Record<string, unknown>
      if (body.model !== 'suggestion-fixture') {
        mainCalls++
        return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(': waiting\n\n')) } }), { headers: { 'content-type': 'text/event-stream' } })
      }
      suggestions++
      const prompt = suggestionInstructions(body)
      expect(prompt).toContain('"kind":"loop"')
      expect(prompt).toContain('"goal":"monitor authentication CI"')
      expect(prompt).toContain('"phase":"running"')
      expect(prompt).toContain('"iteration":1')
      expect(suggestionWorkflow(body).runtime.activities?.length).toBeGreaterThan(0)
      const chunk = { id: 'loop-suggestion', model: body.model, choices: [{ index: 0, delta: { role: 'assistant', content: JSON.stringify(['Check authentication CI progress']) }, finish_reason: 'stop' }] }
      return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } })
    } })
    let session: Session | undefined
    try {
      const base = `http://127.0.0.1:${server.port}/v1`
      session = await startEvot(false, false, false, base, home => seedSuggestionService(home, base))
      session.write('/loop 15m monitor authentication CI\x0d')
      await session.waitForScreen(/Guide.*works/)
      session.write('\t')
      await session.waitForScreen(/Check authentication CI progress\s+⇥/)
      expect(mainCalls).toBe(1)
      expect(suggestions).toBe(1)
    } finally {
      if (session) await session.kill()
      await server.stop(true)
    }
  }, 60_000)

  test('loop waiting does not auto-sample incomplete tool flow, but manual Tab remains available', async () => {
    let suggestions = 0
    let foreground = 0
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: async request => {
      const body = await request.json() as { model: string; messages: { content: string }[] }
      const suggesting = body.model === 'suggestion-fixture'
      let delta: Record<string, unknown>
      if (suggesting) {
        suggestions++
        const prompt = suggestionInstructions(body)
        expect(prompt).toContain('CURRENT STAGE: loop')
        expect(prompt).toContain('"goal":"check the login tests"')
        expect(prompt).toContain('"phase":"waiting"')
        expect(prompt).toContain('"interval_ms":900000')
        expect(prompt).toContain('"wait_reason":"Wait for the next check."')
        delta = { role: 'assistant', content: JSON.stringify(['Check latest login test results', 'Which login tests still need attention?', 'Show changes since the last pass']) }
      } else {
        foreground++
        delta = { role: 'assistant', content: 'Waiting for the next check.', tool_calls: [{ index: 0, id: 'schedule-1', type: 'function',
          function: { name: 'schedule_wakeup', arguments: JSON.stringify({ delay_seconds: 900, reason: 'Wait for the next check.', noop: false }) } }] }
      }
      const chunk = { id: 'fixture', model: body.model, choices: [{ index: 0, delta, finish_reason: suggesting ? 'stop' : 'tool_calls' }] }
      return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } })
    } })
    let session: Session | undefined
    try {
      const base = `http://127.0.0.1:${server.port}/v1`
      session = await startEvot(false, false, false, base, home => seedSuggestionService(home, base))
      session.write('/loop 15m check the login tests\x0d')
      const screen = await session.waitForScreen(/Loop waiting/)
      expect(screen).toContain('esc twice to stop')
      expect(screen).not.toContain('⇥ next')
      const before = foreground
      expect(suggestions).toBe(0)
      session.write('\t')
      await session.waitForScreen(/Check latest login test results\s+1\/3 ⇥/)
      expect(foreground).toBe(before)
      expect(suggestions).toBe(1)
      expect(session.historyEntries()).toEqual(['/loop 15m check the login tests'])
    } finally {
      if (session) await session.kill()
      await server.stop(true)
    }
  }, 60_000)

  test('Esc stops the reply first, then confirms background stop in the footer without waking again', async () => {
    let requests = 0
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => {
      requests++
      if (requests === 1) {
        const chunk = { id: 'fixture', model: 'smoke-model', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'bg-1', type: 'function', function: { name: 'bash', arguments: JSON.stringify({ command: 'sleep 30', run_in_background: true }) } }] }, finish_reason: 'tool_calls' }] }
        return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } })
      }
      return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(': waiting\n\n')) } }), { headers: { 'content-type': 'text/event-stream' } })
    } })
    let session: Session | undefined
    try {
      session = await startEvot(false, false, false, `http://127.0.0.1:${server.port}/v1`)
      session.write('start a background task\x0d')
      await session.waitFor('1 background shell running')
      session.checkpoint()
      session.write('\x1b')
      await session.waitFor(/esc\s+again\s+to\s+interrupt/)
      session.checkpoint()
      session.write('\x1b')
      await session.waitFor('Interrupted.')
      await session.waitFor(/esc\s+twice\s+to\s+stop\s+all/)
      expect(stripAnsi(session.outputSince())).toContain('1 background shell running')
      session.checkpoint()
      session.write('\x1b')
      await session.waitFor(/esc\s+again\s+to\s+stop\s+all\s+1\s+task/)
      session.checkpoint()
      const beforeStop = requests
      session.write('\x1b')
      await session.waitFor('Stopped 1 background terminal.')
      await Bun.sleep(1200)
      expect(requests).toBe(beforeStop)
    } finally {
      if (session) await session.kill()
      await server.stop(true)
    }
  }, 60_000)

  test('Esc on an idle ask overlay releases the tab title for the next overlay', async () => {
    // The plan review is an ask overlay with no stream behind it, exactly like
    // the /task confirmations: Esc goes through close-overlay, not cancel-ask.
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => {
      const chunk = {
        id: 'fixture',
        model: 'smoke-model',
        choices: [{ index: 0, delta: { role: 'assistant', content: 'Plan:\n1. Read the config loader\n2. Add the missing field\n' }, finish_reason: 'stop' }],
      }
      return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } })
    } })
    const titles = (raw: string) => [...raw.matchAll(/\x1b\]0;([^\x07]*)\x07/g)].map(match => match[1] ?? '')
    // Title writes and frame writes are separate stdout writes, so a frame can
    // be observed a tick before the title that accompanies it.
    const waitForTitle = async (current: Session, prefix: string): Promise<string[]> => {
      const deadline = Date.now() + 5_000
      for (;;) {
        const seen = titles(current.outputSince())
        if (seen.at(-1)?.startsWith(prefix)) return seen
        if (Date.now() >= deadline) throw new Error(`no title starting with ${JSON.stringify(prefix)}; saw ${JSON.stringify(seen)}`)
        await Bun.sleep(50)
      }
    }
    let session: Session | undefined
    try {
      session = await startEvot(true, false, false, `http://127.0.0.1:${server.port}/v1`)
      session.write('/plan\x0d')
      await session.waitFor('plan mode', 5_000).catch(() => {})
      session.checkpoint()
      session.write('plan the config change\x0d')
      await session.waitFor('Plan mode - what next?')
      await waitForTitle(session, '? evot')

      session.checkpoint()
      session.write('\x1b')
      await session.waitFor('Describe what to plan')
      // Leaving the ask must hand the title back: no '?' may survive it.
      await waitForTitle(session, '✳ evot')

      // And a later overlay is free to repaint it. Before the fix the title
      // stayed frozen on '?' for the rest of the process.
      session.checkpoint()
      session.write('/sessions\x0d')
      await session.waitFor('smoke resume fixture')
      session.write('\x1b')
      await session.waitFor('Describe what to plan')
      expect(titles(session.outputSince()).every(title => !title.startsWith('?'))).toBe(true)
    } finally {
      if (session) await session.kill()
      await server.stop(true)
    }
  }, 60_000)

  test('a settled run closes with its total duration', async () => {
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => {
      const chunk = {
        id: 'fixture',
        model: 'smoke-model',
        choices: [{ index: 0, delta: { role: 'assistant', content: 'done thinking' }, finish_reason: 'stop' }],
      }
      return new Response(new ReadableStream({
        async start(controller) {
          await Bun.sleep(1500)
          controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`))
          controller.close()
        },
      }), { headers: { 'content-type': 'text/event-stream' } })
    } })
    let session: Session | undefined
    try {
      session = await startEvot(false, false, false, `http://127.0.0.1:${server.port}/v1`)
      session.write('how long did this take\x0d')
      await session.waitFor('done thinking')
      const footer = await session.waitFor(/✳ Ran for \d+s · \d+ turns? · done \d{2}:\d{2}:\d{2}/)
      expect(footer).toMatch(/Ran for [1-9]\d*s · 1 turn ·/)
    } finally {
      if (session) await session.kill()
      await server.stop(true)
    }
  }, 60_000)

  test('a multi-turn run counts every model round-trip', async () => {
    let requests = 0
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => {
      requests++
      const chunk = requests === 1
        ? { id: 'fixture', model: 'smoke-model', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'tc-1', type: 'function', function: { name: 'bash', arguments: JSON.stringify({ command: 'echo first' }) } }] }, finish_reason: 'tool_calls' }] }
        : { id: 'fixture', model: 'smoke-model', choices: [{ index: 0, delta: { role: 'assistant', content: 'both turns done' }, finish_reason: 'stop' }] }
      return new Response(new ReadableStream({
        async start(controller) {
          if (requests > 1) await Bun.sleep(1200)
          controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`))
          controller.close()
        },
      }), { headers: { 'content-type': 'text/event-stream' } })
    } })
    let session: Session | undefined
    try {
      session = await startEvot(false, false, false, `http://127.0.0.1:${server.port}/v1`)
      session.write('run a command then answer\x0d')
      await session.waitFor('both turns done')
      const footer = await session.waitFor(/✳ Ran for \d+s · \d+ turns? · done \d{2}:\d{2}:\d{2}/)
      expect(footer).toMatch(/Ran for [1-9]\d*s · 2 turns ·/)
      expect(requests).toBeGreaterThanOrEqual(2)
    } finally {
      if (session) await session.kill()
      await server.stop(true)
    }
  }, 60_000)

  test('an interrupted run still reports the time it spent', async () => {
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () =>
      new Response(new ReadableStream({
        start(controller) { controller.enqueue(new TextEncoder().encode(': waiting\n\n')) },
      }), { headers: { 'content-type': 'text/event-stream' } }) })
    let session: Session | undefined
    try {
      session = await startEvot(false, false, false, `http://127.0.0.1:${server.port}/v1`)
      session.write('hang forever\x0d')
      await Bun.sleep(1500)
      session.write('\x1b')
      await session.waitFor(/esc\s+again\s+to\s+interrupt/)
      session.write('\x1b')
      await session.waitFor('Interrupted.')
      const footer = await session.waitFor(/✳ Ran for \d+s · \d+ turns? · done \d{2}:\d{2}:\d{2}/)
      expect(footer).toMatch(/Ran for [1-9]\d*s · 1 turn ·/)
    } finally {
      if (session) await session.kill()
      await server.stop(true)
    }
  }, 60_000)

  test('ctrl+c twice exits cleanly', async () => {
    const session = await startEvot()
    try {
      session.write('\x03')
      await session.waitFor(/Press Ctrl\+C again|exited|Goodbye|bye/i)
      session.write('\x03')
    } finally {
      await session.kill()
    }
  }, 60_000)
})
