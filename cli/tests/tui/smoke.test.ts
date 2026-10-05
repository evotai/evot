import { describe, test, expect } from 'bun:test'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { smokeEnvironment, seedSmokeHome } from '../helpers/smoke-home.js'
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
import os, pty, select, sys, signal
status = 0
pid, fd = pty.fork()
if pid == 0:
    os.environ['TERM'] = 'xterm-256color'
    os.execv(sys.argv[1], sys.argv[1:])
try:
    while True:
        r, _, _ = select.select([sys.stdin.buffer, fd], [], [], 0.1)
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

async function startEvot(
  seedSession = false,
  seedOtherCwd = false,
  seedPreviewCacheMiss = false,
  providerUrl?: string,
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
  const child = spawn('python3', ['-c', PTY_RELAY, EVOT_BIN], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: smokeEnvironment(isolatedHome),
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
    await waitFor('Enter a coding task')
  } catch (err) {
    await kill()
    throw err
  }
  return {
    write: data => { child.stdin!.write(data) },
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
    try {
      // A unique prefix immediately renders the formal model window above the
      // composer, but the highlighted row already uses the selector's complete
      // current-row treatment while keyboard focus remains in the composer.
      session.checkpoint()
      session.write('/m')
      const preview = await session.waitFor('Only showing models from configured providers')
      expect(preview).toContain('Model Name:')
      expect(preview).toContain('/m')
      const activeModel = preview.match(/Model Name: ([^\r\n]+)/)?.[1]?.trim()
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
      const navigated = await session.waitFor('Model Name:')
      expect(navigated).not.toContain(`Model Name: ${activeModel}`)
      expect(session.outputSince()).not.toContain('\x1b[2J')

      session.checkpoint()
      session.write('\x1b[A')
      await session.waitFor(`Model Name: ${activeModel}`)

      session.checkpoint()
      session.write('\x1b')
      await session.waitFor('Enter a coding task')

      // Up must also navigate on its first press. Down then returns to the
      // original active model; this does not depend on the catalog's ordering.
      session.checkpoint()
      session.write('/m')
      await session.waitFor(`Model Name: ${activeModel}`)
      session.checkpoint()
      session.write('\x1b[A')
      const navigatedUp = await session.waitFor('Model Name:')
      expect(navigatedUp).not.toContain(`Model Name: ${activeModel}`)
      expect(session.outputSince()).not.toContain('\x1b[2J')
      session.checkpoint()
      session.write('\x1b[B')
      await session.waitFor(`Model Name: ${activeModel}`)

      session.checkpoint()
      session.write('\x1b')
      await session.waitFor('Enter a coding task')

      // Enter keeps its original immediate-submit behavior; arrows are only
      // needed to transfer focus without submitting the command.
      session.checkpoint()
      session.write('/model\x0d')
      const submitted = await session.waitFor('Only showing models from configured providers')
      expect(submitted).toContain('Model Name:')
      session.write('\x1b')
    } finally {
      await session.kill()
    }
  }, 60_000)

  test('skill command window opens live and stays stable through focus', async () => {
    const session = await startEvot()
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
      const switched = await session.waitFor('Model Name:')
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
      const footer = await session.waitFor(/✳ Ran for \d+s · \d+ turns? · done \d{2}:\d{2} (AM|PM)/)
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
      const footer = await session.waitFor(/✳ Ran for \d+s · \d+ turns? · done \d{2}:\d{2} (AM|PM)/)
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
      const footer = await session.waitFor(/✳ Ran for \d+s · \d+ turns? · done \d{2}:\d{2} (AM|PM)/)
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
