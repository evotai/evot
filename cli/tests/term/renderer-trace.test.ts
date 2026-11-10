import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, expect, test } from 'bun:test'
import { RendererTrace } from '../../src/term/diagnostics/renderer-trace.js'
import { RollingLogWriter } from '../../src/term/diagnostics/rolling-log.js'
import { TermRenderer, type RendererTraceEntry } from '../../src/term/screen/renderer.js'
import { Writable } from 'node:stream'

class TraceStdout extends Writable {
  rows = 6
  columns = 40

  _write(_chunk: Buffer | string, _encoding: string, callback: () => void): void {
    callback()
  }
}

function segments(runDirectory: string): string[] {
  return readdirSync(runDirectory)
    .filter(name => /^\d{6}\.jsonl$/.test(name))
    .sort()
}

function frameEntries(path: string): RendererTraceEntry[] {
  return readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line))
    .filter(entry => entry.kind === 'frame')
}

function analyzeRun(runDirectory: string): { exitCode: number; stdout: string; stderr: string } {
  const result = Bun.spawnSync({
    cmd: ['bun', 'scripts/analyze-renderer-trace.ts', runDirectory],
    cwd: join(import.meta.dir, '../..'),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  }
}

describe('RollingLogWriter', () => {
  test('rolls segments and retains only the configured newest segments', () => {
    const root = mkdtempSync(join(tmpdir(), 'evot-rolling-log-'))
    try {
      const writer = new RollingLogWriter({
        rootDirectory: root,
        namespace: 'test-log',
        segmentMaxBytes: 40,
        retainSegments: 2,
        retainRuns: 3,
      })
      for (let index = 0; index < 6; index++) {
        writer.append(JSON.stringify({ index, payload: 'x'.repeat(30) }))
      }

      const names = segments(writer.runDirectory)
      expect(names).toEqual(['000005.jsonl', '000006.jsonl'])
      expect(statSync(join(writer.runDirectory, names[0]!)).mode & 0o777).toBe(0o600)
      expect(statSync(writer.runDirectory).mode & 0o777).toBe(0o700)
      expect(existsSync(join(writer.runDirectory, '.active'))).toBe(true)
      writer.close()
      expect(existsSync(join(writer.runDirectory, '.active'))).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('retains closed managed runs but never deletes active or unrelated directories', () => {
    const root = mkdtempSync(join(tmpdir(), 'evot-rolling-runs-'))
    try {
      const unrelated = join(root, 'business-data')
      writeFileSync(unrelated, 'keep me')

      const first = new RollingLogWriter({
        rootDirectory: root,
        namespace: 'test-log',
        segmentMaxBytes: 100,
        retainSegments: 2,
        retainRuns: 2,
      })
      first.close()
      const second = new RollingLogWriter({
        rootDirectory: root,
        namespace: 'test-log',
        segmentMaxBytes: 100,
        retainSegments: 2,
        retainRuns: 2,
      })
      second.close()
      const third = new RollingLogWriter({
        rootDirectory: root,
        namespace: 'test-log',
        segmentMaxBytes: 100,
        retainSegments: 2,
        retainRuns: 2,
      })
      third.close()
      const active = new RollingLogWriter({
        rootDirectory: root,
        namespace: 'test-log',
        segmentMaxBytes: 100,
        retainSegments: 2,
        retainRuns: 2,
      })

      const retainedClosed = [first.runDirectory, second.runDirectory, third.runDirectory]
        .filter(directory => existsSync(directory))
      expect(retainedClosed).toHaveLength(2)
      expect(existsSync(active.runDirectory)).toBe(true)
      expect(readFileSync(unrelated, 'utf8')).toBe('keep me')
      active.close()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('reclaims a dead active marker into closed-run retention', () => {
    const root = mkdtempSync(join(tmpdir(), 'evot-rolling-stale-'))
    try {
      const stale = new RollingLogWriter({
        rootDirectory: root,
        namespace: 'test-log',
        segmentMaxBytes: 100,
        retainSegments: 2,
        retainRuns: 1,
      })
      // Simulate an abnormal exit: leave .active behind, but point it at a PID
      // that cannot exist on supported platforms.
      writeFileSync(join(stale.runDirectory, '.active'), '999999999\n')

      const current = new RollingLogWriter({
        rootDirectory: root,
        namespace: 'test-log',
        segmentMaxBytes: 100,
        retainSegments: 2,
        retainRuns: 1,
      })
      expect(existsSync(stale.runDirectory)).toBe(true)
      expect(existsSync(join(stale.runDirectory, '.active'))).toBe(false)
      expect(existsSync(current.runDirectory)).toBe(true)
      current.close()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('does not inspect or alter stale markers owned by another namespace', () => {
    const root = mkdtempSync(join(tmpdir(), 'evot-rolling-namespace-'))
    try {
      const other = new RollingLogWriter({
        rootDirectory: root,
        namespace: 'other-log',
        segmentMaxBytes: 100,
        retainSegments: 2,
        retainRuns: 1,
      })
      const marker = join(other.runDirectory, '.active')
      writeFileSync(marker, '999999999\n')

      const current = new RollingLogWriter({
        rootDirectory: root,
        namespace: 'test-log',
        segmentMaxBytes: 100,
        retainSegments: 2,
        retainRuns: 1,
      })
      expect(readFileSync(marker, 'utf8')).toBe('999999999\n')
      expect(existsSync(other.runDirectory)).toBe(true)
      current.close()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('RendererTrace rolling storage', () => {
  test('is disabled by default and opts in via EVOT_TUI_TRACE=1', () => {
    const previous = process.env.EVOT_TUI_TRACE
    delete process.env.EVOT_TUI_TRACE
    try {
      const dflt = new RendererTrace()
      expect(dflt.isEnabled).toBe(false)
      dflt.bind('default-off')
      expect(dflt.filePath).toBeNull()
      process.env.EVOT_TUI_TRACE = '1'
      expect(new RendererTrace().isEnabled).toBe(true)
      // Explicit rootDirectory (tests/tooling) opts in without the env var…
      delete process.env.EVOT_TUI_TRACE
      expect(new RendererTrace({ rootDirectory: '/tmp/unused' }).isEnabled).toBe(true)
      // …but =0 force-disables either way.
      process.env.EVOT_TUI_TRACE = '0'
      const disabled = new RendererTrace({ rootDirectory: '/tmp/unused' })
      expect(disabled.isEnabled).toBe(false)
      disabled.bind('disabled')
      expect(disabled.filePath).toBeNull()
    } finally {
      if (previous === undefined) delete process.env.EVOT_TUI_TRACE
      else process.env.EVOT_TUI_TRACE = previous
    }
  })

  test('buffers before bind and writes compact frame patches to a managed run', () => {
    const root = mkdtempSync(join(tmpdir(), 'evot-renderer-run-'))
    try {
      const trace = new RendererTrace({
        rootDirectory: root,
        segmentMaxBytes: 1_000_000,
        retainSegments: 3,
        retainRuns: 3,
      })
      const stdout = new TraceStdout() as unknown as NodeJS.WriteStream
      const renderer = new TermRenderer({ stdout, trace: entry => trace.log(entry) })
      let lines = ['history', 'prompt']
      renderer.setRenderCallback(() => lines)
      renderer.init()
      ;(renderer as any).doRender()
      lines = ['history', 'answer', 'prompt']
      ;(renderer as any).doRender()
      trace.bind('00000000-0000-0000-0000-000000000001')

      const run = trace.filePath
      expect(run).not.toBeNull()
      const names = segments(run ?? '')
      expect(names).toEqual(['000001.jsonl'])
      const entries = frameEntries(join(run ?? '', names[0]!))
      expect(entries).toHaveLength(2)
      expect(entries[0].branch).toBe('first_render')
      const reset = '\x1b[0m\x1b]8;;\x07'
      expect(entries[0].viewportTail).toEqual([`history${reset}`, `prompt${reset}`])
      expect(entries[1].viewportTail).toBeUndefined()
      expect(entries[1].viewportPatch).toEqual({ start: 1, lines: [`answer${reset}`, `prompt${reset}`] })
      expect(entries[0].terminal).toMatchObject({ columns: 40, rows: 6 })
      renderer.destroy()
      trace.close()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('retained segments replay independently and tolerate a truncated final record', () => {
    const root = mkdtempSync(join(tmpdir(), 'evot-renderer-replay-'))
    try {
      const trace = new RendererTrace({
        rootDirectory: root,
        segmentMaxBytes: 2_000,
        retainSegments: 2,
        retainRuns: 2,
      })
      trace.bind('00000000-0000-0000-0000-000000000003')
      const stdout = new TraceStdout() as unknown as NodeJS.WriteStream
      const renderer = new TermRenderer({
        stdout,
        trace: entry => trace.log(entry),
      })
      let lines = ['history 0', 'history 1', 'body', '────────', '❯ ', '────────']
      renderer.setRenderCallback(() => lines)
      renderer.init()
      ;(renderer as any).doRender()
      for (let frame = 1; frame <= 20; frame++) {
        lines = [
          'history 0',
          'history 1',
          ...Array.from({ length: frame }, (_, index) => `stream ${index}`),
          '────────',
          '❯ ',
          '────────',
        ]
        ;(renderer as any).doRender()
      }
      renderer.destroy()
      trace.close()

      const run = trace.filePath ?? ''
      const names = segments(run)
      expect(names).toHaveLength(2)
      expect(names).not.toContain('000001.jsonl')

      const replay = analyzeRun(run)
      expect(replay.exitCode).toBe(0)
      expect(replay.stderr).not.toContain('Invalid JSONL')
      expect(JSON.parse(replay.stdout).firstReplayMismatch).toBeNull()

      appendFileSync(join(run, names.at(-1)!), '{"kind":')
      const crashReplay = analyzeRun(run)
      expect(crashReplay.exitCode).toBe(0)
      expect(JSON.parse(crashReplay.stdout).firstReplayMismatch).toBeNull()
      expect(JSON.parse(crashReplay.stdout).truncatedTailRecords).toBe(1)

      appendFileSync(join(run, names.at(-1)!), '\n')
      const corruptReplay = analyzeRun(run)
      expect(corruptReplay.exitCode).not.toBe(0)
      expect(corruptReplay.stderr).toContain('Invalid JSONL')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('analyzer replays a visible shrink using the retained physical viewport origin', () => {
    const root = mkdtempSync(join(tmpdir(), 'evot-renderer-shrink-origin-'))
    try {
      const trace = new RendererTrace({
        rootDirectory: root,
        segmentMaxBytes: 1_000_000,
        retainSegments: 2,
        retainRuns: 2,
      })
      trace.bind('00000000-0000-0000-0000-000000000008')
      const stdout = new TraceStdout() as unknown as NodeJS.WriteStream
      const renderer = new TermRenderer({ stdout, trace: entry => trace.log(entry) })
      let lines = Array.from({ length: 10 }, (_, index) => `line ${index}`)
      renderer.setRenderCallback(() => lines)
      renderer.init()
      renderer.clearScreen()
      ;(renderer as any).doRender()

      // Remove a live footer row and repaint the rows above it. The renderer
      // keeps viewportTop=4 even though the logical target moves from 4 to 3.
      lines = [
        ...lines.slice(0, 4),
        'line 4 changed',
        ...lines.slice(5, -1),
      ]
      ;(renderer as any).doRender()
      renderer.destroy()
      trace.close()

      const run = trace.filePath ?? ''
      const entries = frameEntries(join(run, segments(run)[0]!))
      const shrink = entries.at(-1)!
      expect(shrink.frameState.newLines).toBe(9)
      expect(shrink.frameState.targetViewportTop).toBe(3)
      expect(shrink.frameState.previousViewportTopAfter).toBe(4)

      const analyzed = analyzeRun(run)
      expect(analyzed.exitCode).toBe(0)
      expect(JSON.parse(analyzed.stdout).firstReplayMismatch).toBeNull()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('analyzer does not claim absolute viewport verification before a clear-home baseline', () => {
    const root = mkdtempSync(join(tmpdir(), 'evot-renderer-origin-'))
    try {
      const trace = new RendererTrace({
        rootDirectory: root,
        segmentMaxBytes: 1_000_000,
        retainSegments: 2,
        retainRuns: 2,
      })
      trace.bind('00000000-0000-0000-0000-000000000007')
      const stdout = new TraceStdout() as unknown as NodeJS.WriteStream
      const renderer = new TermRenderer({ stdout, trace: entry => trace.log(entry) })
      let lines = ['body', 'prompt']
      renderer.setRenderCallback(() => lines)
      renderer.init()
      ;(renderer as any).doRender()
      lines = ['body changed', 'prompt']
      ;(renderer as any).doRender()
      renderer.destroy()
      trace.close()

      const analyzed = analyzeRun(trace.filePath ?? '')
      expect(analyzed.exitCode).toBe(0)
      const summary = JSON.parse(analyzed.stdout)
      expect(summary.verifiedFrames).toBe(0)
      expect(summary.unverifiedOriginFrames).toBe(2)
      expect(summary.firstReplayMismatch).toBeNull()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('analyzer tolerates only the unstable last cell of an over-width nowrap line', () => {
    const root = mkdtempSync(join(tmpdir(), 'evot-renderer-nowrap-'))
    try {
      const trace = new RendererTrace({
        rootDirectory: root,
        segmentMaxBytes: 1_000_000,
        retainSegments: 2,
        retainRuns: 2,
      })
      trace.bind('00000000-0000-0000-0000-000000000006')
      const stdout = new TraceStdout() as unknown as NodeJS.WriteStream
      const overWidth = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwx'
      const renderer = new TermRenderer({ stdout, trace: entry => trace.log(entry) })
      renderer.init()
      renderer.clearScreen()
      renderer.setRenderCallback(() => [overWidth, 'footer'])
      ;(renderer as any).doRender()
      renderer.destroy()
      trace.close()

      const run = trace.filePath ?? ''
      const clean = analyzeRun(run)
      expect(clean.exitCode).toBe(0)
      expect(JSON.parse(clean.stdout).verifiedFrames).toBe(1)
      expect(JSON.parse(clean.stdout).unverifiedOriginFrames).toBe(0)

      const segment = join(run, segments(run)[0]!)
      const records = readFileSync(segment, 'utf8').trim().split('\n').map(line => JSON.parse(line))
      const frame = records.find(record => record.kind === 'frame')
      frame.ansiWrites = frame.ansiWrites.map((write: string) =>
        write.replace(overWidth, `!${overWidth.slice(1)}`))
      writeFileSync(segment, `${records.map(record => JSON.stringify(record)).join('\n')}\n`)

      const corrupted = analyzeRun(run)
      expect(corrupted.exitCode).not.toBe(0)
      const summary = JSON.parse(corrupted.stdout.split('\n\n--- expected viewport ---')[0]!)
      expect(summary.firstReplayMismatch).not.toBeNull()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('pre-bind overflow and session switch both start from replayable checkpoints', () => {
    const root = mkdtempSync(join(tmpdir(), 'evot-renderer-checkpoints-'))
    try {
      const trace = new RendererTrace({
        rootDirectory: root,
        segmentMaxBytes: 1_000_000,
        retainSegments: 2,
        retainRuns: 2,
      })
      const stdout = new TraceStdout() as unknown as NodeJS.WriteStream
      const renderer = new TermRenderer({ stdout, trace: entry => trace.log(entry) })
      let lines = ['frame 0', '────────', '❯ ', '────────']
      renderer.setRenderCallback(() => lines)
      renderer.init()
      for (let frame = 0; frame < 300; frame++) {
        lines = [`frame ${frame}`, '────────', '❯ ', '────────']
        ;(renderer as any).doRender()
      }

      trace.bind('00000000-0000-0000-0000-000000000004')
      const overflowRun = trace.filePath ?? ''
      const overflowRecords = readFileSync(join(overflowRun, segments(overflowRun)[0]!), 'utf8')
        .trim().split('\n').map(line => JSON.parse(line))
      expect(overflowRecords[0]?.branch).toBe('segment_checkpoint')
      expect(overflowRecords.some(entry => entry.kind === 'buffer_overflow')).toBe(true)
      expect(analyzeRun(overflowRun).exitCode).toBe(0)

      lines = ['after bind', '────────', '❯ ', '────────']
      ;(renderer as any).doRender()
      trace.bind('00000000-0000-0000-0000-000000000005')
      const switchedRun = trace.filePath ?? ''
      expect(switchedRun).not.toBe(overflowRun)
      const switchedEntries = frameEntries(join(switchedRun, segments(switchedRun)[0]!))
      expect(switchedEntries[0]?.branch).toBe('segment_checkpoint')
      expect(analyzeRun(switchedRun).exitCode).toBe(0)

      renderer.destroy()
      trace.close()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('renderer overwide line tracing', () => {
  test('records overwideLines when a rendered line exceeds terminal width', async () => {
    const root = mkdtempSync(join(tmpdir(), 'evot-overwide-'))
    try {
      const stdout = new TraceStdout()
      stdout.columns = 10
      stdout.rows = 8
      const entries: RendererTraceEntry[] = []
      const renderer = new TermRenderer({
        stdout: stdout as unknown as NodeJS.WriteStream,
        trace: entry => entries.push(entry),
      })
      renderer.init()
      renderer.setRenderCallback(() => ['this-line-is-definitely-wider-than-ten'])
      renderer.requestRender()
      await new Promise(resolve => process.nextTick(resolve))
      await Bun.sleep(20)
      renderer.destroy()
      expect(entries.length).toBeGreaterThan(0)
      const first = entries[0]!
      expect(first.frameState.overwideLines.length).toBeGreaterThan(0)
      expect(first.frameState.overwideLines[0]!.width).toBeGreaterThan(10)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

