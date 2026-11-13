import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

async function source(path: string): Promise<string> {
  return Bun.file(new URL(path, import.meta.url)).text()
}

/** The REPL host: `repl.ts` wiring plus the controllers it assembles. */
function hostSource(): string {
  const dir = resolve(import.meta.dir, '../src/term')
  const controllers = readdirSync(join(dir, 'host')).filter(name => name.endsWith('.ts')).sort()
  return [join(dir, 'repl.ts'), ...controllers.map(name => join(dir, 'host', name))].map(path => readFileSync(path, 'utf8')).join('\n')
}

/** Architecture acceptance tests focus on explicit dependency edges rather
 * than file size. A move must update the production owner, not leave wrappers. */
describe('module dependency boundaries', () => {
  test('generic selector and design rules do not import application features', async () => {
    for (const file of ['ui/selector.ts', 'ui/key-hints.ts', 'term/screen/render-wakeup.ts']) {
      const text = await source(`../src/${file}`)
      expect(text).not.toMatch(/from ['"].*(?:\/app\/|native\/|repl\.js)/)
    }
  })

  test('layout producers depend on frame data, never the terminal backend', async () => {
    for (const file of ['shell', 'prompt', 'selector', 'manual-compaction']) {
      const text = await source(`../src/term/viewmodel/${file}.ts`)
      expect(text).not.toContain("from '../renderer.js'")
    }
    const frame = await source('../src/term/screen/render-frame.ts')
    expect(frame).not.toContain('process.')
    expect(frame).not.toContain('import ')
    const host = hostSource()
    expect(host).toContain('buildShellFrame({')
    expect(host).not.toContain('bottomAnchorStart:')
  })

  test('overlay composition does not own timers or surface implementation', async () => {
    const text = await source('../src/term/viewmodel/overlays.ts')
    for (const forbidden of ['setTimeout', 'setInterval', 'process.', 'function buildSelectorBlocks', 'function buildAskBlocks', 'function buildHelpBlocks']) {
      expect(text).not.toContain(forbidden)
    }
    for (const surface of ['ask', 'help', 'selector']) {
      expect(text).toContain(`from './${surface}.js'`)
    }
  })

  test('Web clients are independent of DOM and UI modules', async () => {
    for (const file of ['chat-transport', 'chat-control', 'chat-state', 'chat-stream-state', 'json-client', 'login-errors']) {
      const text = await source(`../../src/app/assets/console/ui/${file}.js`)
      for (const forbidden of ['document.', 'window.', 'from "./app.js"', 'from "./chat.js"']) expect(text).not.toContain(forbidden)
    }
  })

  test('Web runtime state owns run and navigation generations, not DOM code', async () => {
    const host = await source('../../src/app/assets/console/ui/chat.js')
    expect(host).toContain('runtime.begin(currentSessionId)')
    expect(host).toContain('runtime.ownsNavigation(navigation)')
    expect(host).toContain('runtime.canRestoreSubmission(generation, input.value)')
    expect(host).toContain('state.content.resetAssistant()')
    for (const removed of ['let streaming =', 'let stopping =', 'let streamController =', 'state.buffers.set(']) {
      expect(host).not.toContain(removed)
    }
  })

  test('input and command controllers do not depend on the viewmodel barrel', async () => {
    for (const file of ['composer/slash-commands', 'composer/repl-control', 'selector/overlay-state']) {
      const text = await source(`../src/term/app/${file}.ts`)
      expect(text).not.toContain('viewmodel/')
    }
  })

  test('background synchronization depends on injected ports, not the native binding', async () => {
    const text = await source('../src/term/app/session/cloud-sync.ts')
    expect(text).not.toContain('native/')
    expect(text).not.toContain('setInterval(')
    expect(text).not.toContain('process.')
  })

  test('run reducers cannot bypass payload typing with any records', async () => {
    for (const file of ['run/reducer', 'run/stream', 'run/compaction-record']) {
      const text = await source(`../src/term/app/${file}.ts`)
      expect(text).not.toContain('Record<string, any>')
      expect(text).not.toMatch(/\bas any\b/)
      expect(text).not.toMatch(/\bas (?:number|string|boolean)\b/)
    }
    const reducer = await source('../src/term/app/run/reducer.ts')
    expect(reducer).not.toContain('as RunPayloads')
    expect(reducer).toContain('switch (event.kind)')
    expect(reducer).toContain('isKnownRunEvent(event)')
    const decoder = await source('../src/native/contracts/query-event.ts')
    expect(decoder).toContain('validateRunPayload(value.kind, value.payload)')
  })

  test('native result contracts and pure compaction presentation keep their boundary', async () => {
    const contracts = await source('../src/native/contracts/results.ts')
    expect(contracts).not.toMatch(/from ['"].*(?:term\/|render\/|binding)/)
    expect(contracts).not.toContain('process.')
    const projection = await source('../src/term/viewmodel/manual-compaction.ts')
    for (const forbidden of ['binding.js', 'setTimeout', 'setInterval', 'loadContextTranscript', 'clearScreen', 'requestRender']) {
      expect(projection).not.toContain(forbidden)
    }
    const host = hostSource()
    expect(host).toContain('manualCompactionLines(outcome)')
    expect(host).not.toContain('formatCompactionCompleted(')
  })

  test('busy submission and queue projections are independent of terminal side effects', async () => {
    for (const file of ['queue/busy-submission', 'run/manual-compaction', 'composer/file-completion-controller', 'queue/queue-edit', 'queue/pending-queue', 'queue/queue-lifecycle', 'composer/input-action']) {
      const text = await source(`../src/term/app/${file}.ts`)
      for (const forbidden of ['binding.js', 'renderer', 'process.', 'setTimeout', 'setInterval', ' as any']) {
        expect(text).not.toContain(forbidden)
      }
    }
    const host = hostSource()
    expect(host).toContain('busySubmissionAction(')
    expect(host).toContain('queueLifecycle.reconcile(')
    const queueEdit = await source('../src/term/app/queue/queue-edit.ts')
    expect(queueEdit).not.toContain('runQueued(')
    expect(queueEdit).not.toContain('queue.settle(')
    const lifecycle = await source('../src/term/app/queue/queue-lifecycle.ts')
    expect(lifecycle).toContain('queue.reconcile(')
    expect(host).not.toContain('queuedUserMessages')
    // Queue state changes only through PendingQueue, and "which queue is
    // current" has one definition.
    for (const text of [host, lifecycle, queueEdit]) expect(text).not.toMatch(/(?:pendingQueue|queue\.state)\.\w+ = /)
    expect(host).not.toContain('st.logMode ?? st.sessionId')
    // composer owns command grammar; suggestion may use it, never the reverse.
    const composerDir = resolve(import.meta.dir, '../src/term/app/composer')
    for (const name of readdirSync(composerDir)) expect(readFileSync(join(composerDir, name), 'utf8'), name).not.toContain("'../suggestion/")
    // One hook resolution: Rust config. The CLI never re-reads the variable.
    const cli = resolve(import.meta.dir, '../src')
    for (const file of ['session/hook.ts', 'headless/prompt.ts', 'term/repl.ts']) {
      const text = readFileSync(join(cli, file), 'utf8')
      expect(text, file).not.toContain('env.EVOT_SESSION_HOOK')
      if (file !== 'session/hook.ts') expect(text, file).toContain('configInfo().sessionHook')
    }
    const pendingQueue = await source('../src/term/app/queue/pending-queue.ts')
    expect(pendingQueue).toContain("stream.queuedPrompts('steering')")
    expect(pendingQueue).toContain("stream.queuedPrompts('follow_up')")
    expect(host).not.toContain('function queueEntryText(')
    expect(host).toContain('manualCompaction.run(')
    expect(host).not.toContain('compactionTask = agent.compact(')
    expect(host).toContain('resources.add(() => fileCompletion.dispose())')
    expect(host).not.toContain('fdAbort')
  })

  test('published config decoding remains transport-only', async () => {
    const text = await source('../src/native/contracts/config-info.ts')
    expect(text).not.toContain('binding.js')
    expect(text).not.toMatch(/from ['"].*(?:term\/|render\/)/)
    expect(text).not.toContain('process.')
  })
})


describe('REPL host', () => {
  const dir = resolve(import.meta.dir, '../src/term/host')
  const controllers = readdirSync(dir).filter(name => name.endsWith('.ts'))

  test('mutable host state lives in ReplState, not in startRepl locals', () => {
    const host = readFileSync(resolve(dir, '../repl.ts'), 'utf8')
    expect(host).not.toMatch(/^ {2}let /m)
    expect(host).toContain('const st = {} as ReplState')
  })

  test('controllers reach the host and each other only through declared ports', () => {
    expect(controllers.length).toBeGreaterThan(5)
    for (const name of controllers) {
      const text = readFileSync(join(dir, name), 'utf8')
      expect(text).not.toMatch(/from ['"]\.\.\/repl\.js['"]/)
      for (const match of text.matchAll(/^import (type )?.*from ['"]\.\/([\w-]+)\.js['"]/gm)) {
        if (match[2] !== 'timing') expect(`${name}: ${match[0]}`).toContain('import type ')
      }
    }
  })
})

/** Lowest layer first: a directory may import only directories listed before
 * it. `index.ts` and `cli.ts` are the entry points and sit above everything. */
const LAYERS = ['native', 'ui', 'markdown', 'render', 'session', 'features', 'commands', 'update', 'term', 'headless'] as const

describe('directory layering', () => {
  const root = resolve(import.meta.dir, '../src')

  function sources(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) return sources(path)
      return /\.(?:ts|tsx)$/.test(entry.name) && !entry.name.endsWith('.d.ts') ? [path] : []
    })
  }

  function layerOf(path: string): number {
    const top = relative(root, path).split('/')[0]!
    return LAYERS.indexOf(top as typeof LAYERS[number])
  }

  test('every source directory has a declared layer', () => {
    const tops = readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name)
    expect(tops.sort()).toEqual([...LAYERS].sort())
  })

  test('imports only point at lower layers', () => {
    const upward: string[] = []
    for (const file of sources(root)) {
      const from = layerOf(file)
      if (from < 0) continue
      const text = readFileSync(file, 'utf8')
      for (const match of text.matchAll(/(?:from\s+|import\s*\(\s*|import\s+)['"](\.{1,2}\/[^'"]+)['"]/g)) {
        const target = resolve(dirname(file), match[1]!)
        if (!target.startsWith(root + '/')) continue
        const to = layerOf(target)
        if (to > from) upward.push(`${relative(root, file)} -> ${relative(root, target)}`)
      }
    }
    expect(upward).toEqual([])
  })
})

