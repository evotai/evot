import { describe, expect, test } from 'bun:test'

import { createProgressLine, type ProgressLinePort } from '../../src/ui/progress-line.js'

interface Recorded {
  commits: Array<{ id: string; text: string }>
  replaces: Array<{ id: string; text: string }>
}

function port(options: { replaceSucceeds?: boolean } = {}): { port: ProgressLinePort; log: Recorded } {
  const log: Recorded = { commits: [], replaces: [] }
  return {
    log,
    port: {
      commit: (id, text) => { log.commits.push({ id, text }) },
      replace: (id, text) => {
        log.replaces.push({ id, text })
        return options.replaceSucceeds ?? true
      },
    },
  }
}

describe('createProgressLine', () => {
  test('commits once, then rewrites the same line for every later phase', () => {
    const { port: deps, log } = port()
    const line = createProgressLine('sys-skill-progress-0', deps)

    line.update('downloading...')
    line.update('extracting...')
    line.finish('Installed')

    expect(log.commits).toEqual([{ id: 'sys-skill-progress-0', text: 'downloading...' }])
    expect(log.replaces).toEqual([
      { id: 'sys-skill-progress-0', text: 'extracting...' },
      { id: 'sys-skill-progress-0', text: 'Installed' },
    ])
  })

  test('a whole operation costs one row of scrollback', () => {
    const { port: deps, log } = port()
    const line = createProgressLine('id', deps)
    for (const phase of ['a', 'b', 'c', 'd']) line.update(phase)
    line.finish('done')
    expect(log.commits).toHaveLength(1)
  })

  test('re-commits when the line is gone, so the result is never lost', () => {
    // The normal path after /clear: the transcript no longer holds the line, so
    // replacing it fails and the outcome has to be committed afresh.
    const { port: deps, log } = port({ replaceSucceeds: false })
    const line = createProgressLine('id', deps)

    line.update('downloading...')
    line.finish('Installed')

    expect(log.replaces).toEqual([{ id: 'id', text: 'Installed' }])
    expect(log.commits).toEqual([
      { id: 'id', text: 'downloading...' },
      { id: 'id', text: 'Installed' },
    ])
  })

  test('finishing without any update still shows the result', () => {
    const { port: deps, log } = port()
    createProgressLine('id', deps).finish('no skills installed')
    expect(log.commits).toEqual([{ id: 'id', text: 'no skills installed' }])
    expect(log.replaces).toEqual([])
  })

  test('two concurrent operations keep separate lines', () => {
    const { port: deps, log } = port()
    const first = createProgressLine('op-1', deps)
    const second = createProgressLine('op-2', deps)

    first.update('installing...')
    second.update('updating...')
    first.finish('Installed')
    second.finish('Updated')

    expect(log.commits.map((entry) => entry.id)).toEqual(['op-1', 'op-2'])
    expect(log.replaces).toEqual([
      { id: 'op-1', text: 'Installed' },
      { id: 'op-2', text: 'Updated' },
    ])
  })
})
