#!/usr/bin/env bun

import { readFileSync, readdirSync, statSync } from 'fs'
import { join } from 'path'
import { sliceAnsi } from 'bun'
import xterm from '@xterm/headless'
import stripAnsi from 'strip-ansi'
import stringWidth from 'string-width'
import type { RendererTraceEntry } from '../src/term/screen/renderer.js'

function usage(): never {
  console.error('Usage: bun run trace:renderer <renderer-run-directory>')
  process.exit(2)
}

const path = process.argv[2]
if (!path) usage()

let segmentPaths: string[]
let truncatedTailRecords = 0
try {
  if (!statSync(path).isDirectory()) usage()
  segmentPaths = readdirSync(path, { withFileTypes: true })
    .filter(entry => entry.isFile() && /^\d{6}\.jsonl$/.test(entry.name))
    .map(entry => join(path, entry.name))
    .sort()
} catch {
  usage()
}

const entries = segmentPaths
  .flatMap((segmentPath, segmentIndex) => {
    const content = readFileSync(segmentPath, 'utf8')
    const lines = content.split('\n')
    return lines.flatMap((line, lineIndex) => {
      if (!line) return []
      try {
        return [JSON.parse(line) as RendererTraceEntry | { kind: string }]
      } catch (error) {
        const isTruncatedTail = segmentIndex === segmentPaths.length - 1
          && lineIndex === lines.length - 1
          && !content.endsWith('\n')
        if (isTruncatedTail) {
          truncatedTailRecords++
          return []
        }
        throw new Error(`Invalid JSONL at ${segmentPath}:${lineIndex + 1}: ${String(error)}`)
      }
    })
  })
  .filter((entry): entry is RendererTraceEntry => entry.kind === 'frame')

if (entries.length === 0) {
  console.error('No renderer frame entries found.')
  process.exit(1)
}

const branches = new Map<string, number>()
let shrinkFrames = 0
let oscFrames = 0
let overWidthFrames = 0
let rightMarginFrames = 0
let clearViewportFrames = 0
let clearScrollbackFrames = 0
let firstMismatch: { entry: RendererTraceEntry; expected: string[]; actual: string[] } | null = null
let originKnown = false
let verifiedFrames = 0
let unverifiedOriginFrames = 0
let terminal: InstanceType<typeof xterm.Terminal> | null = null
let columns = 0
let rows = 0

function flush(term: InstanceType<typeof xterm.Terminal>): Promise<void> {
  return new Promise(resolve => term.write('', resolve))
}

function viewport(term: InstanceType<typeof xterm.Terminal>, height: number): string[] {
  const result: string[] = []
  const buffer = term.buffer.active
  for (let row = 0; row < height; row++) {
    result.push(buffer.getLine(buffer.viewportY + row)?.translateToString(true) ?? '')
  }
  return result
}

const logicalLines = new Map<number, string>()

function updateLogicalFrame(entry: RendererTraceEntry): void {
  if (entry.viewportTail) {
    logicalLines.clear()
    // viewportTail describes what is physically visible. After a one-line
    // shrink, pi-style rendering intentionally keeps the existing viewport
    // origin and clears the bottom row, so this can differ from the logical
    // bottom-aligned targetViewportTop.
    const start = entry.frameState.previousViewportTopAfter
    entry.viewportTail.forEach((line, index) => logicalLines.set(start + index, line))
  }
  if (entry.viewportPatch) {
    entry.viewportPatch.lines.forEach((line, index) => {
      logicalLines.set(entry.viewportPatch!.start + index, line)
    })
  }
  for (const index of logicalLines.keys()) {
    if (index >= entry.frameState.newLines) logicalLines.delete(index)
  }
}

function expectedViewport(entry: RendererTraceEntry): string[] {
  const expected: string[] = []
  for (let row = 0; row < entry.terminal.rows; row++) {
    const index = entry.frameState.previousViewportTopAfter + row
    const line = logicalLines.get(index) ?? ''
    expected.push(stripAnsi(sliceAnsi(line, 0, entry.terminal.columns)))
  }
  return expected
}

function viewportsMatch(
  entry: RendererTraceEntry,
  expected: string[],
  actual: string[],
): boolean {
  return expected.every((line, row) => {
    const sourceIndex = entry.frameState.previousViewportTopAfter + row
    const source = logicalLines.get(sourceIndex) ?? ''
    if (stringWidth(stripAnsi(source)) < entry.terminal.columns) {
      return actual[row] === line
    }
    // With DECAWM disabled, terminals repeatedly overwrite the last cell when
    // handed an over-width line. The renderer intentionally relies on that cell
    // for clipping, so its final glyph is terminal-specific and not part of the
    // stable logical viewport. Compare every addressable cell before it.
    const stableColumns = Math.max(0, entry.terminal.columns - 1)
    return sliceAnsi(actual[row] ?? '', 0, stableColumns) === sliceAnsi(line, 0, stableColumns)
  })
}

for (const entry of entries) {
  branches.set(entry.branch, (branches.get(entry.branch) ?? 0) + 1)
  if (entry.frameState.newLines < entry.frameState.previousLines) shrinkFrames++
  if (entry.frameState.osc133Markers > 0) oscFrames++
  if (entry.frameState.maxVisibleWidth > entry.terminal.columns) overWidthFrames++
  if (entry.frameState.maxVisibleWidth >= entry.terminal.columns) rightMarginFrames++

  const ansi = entry.ansiWrites.join('')
  if (ansi.includes('\x1b[2J\x1b[H')) originKnown = true
  if (ansi.includes('\x1b[2J\x1b[H')) clearViewportFrames++
  if (ansi.includes('\x1b[3J')) clearScrollbackFrames++

  if (!terminal) {
    columns = entry.terminal.columns
    rows = entry.terminal.rows
    terminal = new xterm.Terminal({
      cols: columns,
      rows,
      allowProposedApi: true,
      scrollback: 20_000,
    })
  } else if (columns !== entry.terminal.columns || rows !== entry.terminal.rows) {
    columns = entry.terminal.columns
    rows = entry.terminal.rows
    terminal.resize(columns, rows)
  }

  for (const write of entry.ansiWrites) terminal.write(write)
  await flush(terminal)
  updateLogicalFrame(entry)

  if (!originKnown) {
    unverifiedOriginFrames++
  } else {
    verifiedFrames++
  }
  if (originKnown && !firstMismatch) {
    const expected = expectedViewport(entry)
    const actual = viewport(terminal, rows)
    if (!viewportsMatch(entry, expected, actual)) {
      firstMismatch = { entry, expected, actual }
    }
  }
}

console.log(JSON.stringify({
  runDirectory: path,
  segments: segmentPaths.length,
  frames: entries.length,
  truncatedTailRecords,
  terminal: entries[0]?.terminal,
  branches: Object.fromEntries([...branches.entries()].sort((a, b) => a[0].localeCompare(b[0]))),
  shrinkFrames,
  clearViewportFrames,
  clearScrollbackFrames,
  osc133Frames: oscFrames,
  overWidthFrames,
  rightMarginFrames,
  verifiedFrames,
  unverifiedOriginFrames,
  firstReplayMismatch: firstMismatch
    ? {
        frame: firstMismatch.entry.frame,
        ts: firstMismatch.entry.ts,
        branch: firstMismatch.entry.branch,
        frameState: firstMismatch.entry.frameState,
      }
    : null,
}, null, 2))

if (firstMismatch) {
  console.log('\n--- expected viewport ---')
  firstMismatch.expected.forEach((line, index) => console.log(`${index.toString().padStart(3)} ${line}`))
  console.log('\n--- replayed viewport ---')
  firstMismatch.actual.forEach((line, index) => console.log(`${index.toString().padStart(3)} ${line}`))
  process.exitCode = 1
}
