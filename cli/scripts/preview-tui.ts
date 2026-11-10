#!/usr/bin/env bun
import { buildShellFrame } from '../src/term/viewmodel/shell.js'
import { CURSOR_MARKER } from '../src/term/screen/render-frame.js'
import { previewScene, SCENES, type Scene } from './tui-scenes.js'
import { truncateAnsiToWidth } from '../src/ui/wrap.js'

const args = process.argv.slice(2)
if (args[0] === '--list') {
  console.log(SCENES.join('\n'))
} else {
  const scene = args[0] ?? 'idle'
  const columns = Number(args[1] ?? 80)
  const rows = Number(args[2] ?? 24)
  if (!SCENES.includes(scene as Scene) || !Number.isInteger(columns) || columns < 10 || columns > 300
    || !Number.isInteger(rows) || rows < 8 || rows > 120) {
    console.error('Usage: bun run preview:tui [scene] [columns:10..300] [rows:8..120] (or --list)')
    process.exitCode = 2
  } else {
    const frame = buildShellFrame(previewScene(scene as Scene, columns, rows))
    // Printable component preview, not an interactive terminal session. For a
    // modal, show its content separately; physical compositing is tested by xterm.
    const lines = frame.overlay?.lines ?? frame.lines
    console.log(lines.map(line => truncateAnsiToWidth(line.replaceAll(CURSOR_MARKER, ''), columns)).join('\n'))
  }
}
