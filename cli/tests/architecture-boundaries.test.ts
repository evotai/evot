import { describe, expect, test } from 'bun:test'

async function source(path: string): Promise<string> {
  return Bun.file(new URL(path, import.meta.url)).text()
}

/** Architecture acceptance tests focus on explicit dependency edges rather
 * than file size. A move must update the production owner, not leave wrappers. */
describe('module dependency boundaries', () => {
  test('generic selector and design rules do not import application features', async () => {
    for (const file of ['selector.ts', 'design/key-hints.ts', 'render-wakeup.ts']) {
      const text = await source(`../src/term/${file}`)
      expect(text).not.toMatch(/from ['"].*(?:\/app\/|native\/|repl\.js)/)
    }
  })

  test('layout producers depend on frame data, never the terminal backend', async () => {
    for (const file of ['shell', 'prompt', 'selector', 'manual-compaction']) {
      const text = await source(`../src/term/viewmodel/${file}.ts`)
      expect(text).not.toContain("from '../renderer.js'")
    }
    const frame = await source('../src/term/render-frame.ts')
    expect(frame).not.toContain('process.')
    expect(frame).not.toContain('import ')
    const host = await source('../src/term/repl.ts')
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
    for (const file of ['commands', 'repl-control', 'overlay-state']) {
      const text = await source(`../src/term/app/${file}.ts`)
      expect(text).not.toContain('viewmodel/')
    }
  })

  test('background synchronization depends on injected ports, not the native binding', async () => {
    const text = await source('../src/term/app/cloud-sync.ts')
    expect(text).not.toContain('native/')
    expect(text).not.toContain('setInterval(')
    expect(text).not.toContain('process.')
  })

  test('run reducers cannot bypass payload typing with any records', async () => {
    for (const file of ['reducer', 'stream', 'compaction-record']) {
      const text = await source(`../src/term/app/${file}.ts`)
      expect(text).not.toContain('Record<string, any>')
      expect(text).not.toMatch(/\bas any\b/)
      expect(text).not.toMatch(/\bas (?:number|string|boolean)\b/)
    }
    const reducer = await source('../src/term/app/reducer.ts')
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
    const host = await source('../src/term/repl.ts')
    expect(host).toContain('manualCompactionLines(outcome)')
    expect(host).not.toContain('formatCompactionCompleted(')
  })

  test('busy submission and queue projections are independent of terminal side effects', async () => {
    for (const file of ['busy-submission', 'prompt-queue', 'manual-compaction', 'file-completion', 'queue-edit']) {
      const text = await source(`../src/term/app/${file}.ts`)
      for (const forbidden of ['binding.js', 'renderer', 'process.', 'setTimeout', 'setInterval', ' as any']) {
        expect(text).not.toContain(forbidden)
      }
    }
    const host = await source('../src/term/repl.ts')
    expect(host).toContain('busySubmissionAction(')
    expect(host).toContain('reconcileQueuedUserMessages(')
    const queueEdit = await source('../src/term/app/queue-edit.ts')
    expect(queueEdit).toContain('reconcilePromptQueue(')
    expect(host).not.toContain('function queueEntryText(')
    expect(host).toContain('await manualCompaction.run(')
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
