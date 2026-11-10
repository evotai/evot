/**
 * Tail reader for background task output files.
 *
 * The panel shows the last few dozen lines of a task's output, while the engine
 * lets those files grow to 10MB. Reading the whole file to render 40 lines would
 * stall the UI thread on a noisy task, so only the end of the file is read.
 */

import { closeSync, openSync, readSync, statSync } from 'fs'

/**
 * Bytes read from the end of the file.
 *
 * Comfortably covers the tail the panel renders even with very long lines,
 * while staying small enough to read synchronously without a visible pause.
 */
export const TAIL_BYTES = 256 * 1024

/**
 * Read the final `maxBytes` of a file as UTF-8.
 *
 * When the file is larger than the window, the first (possibly partial) line is
 * dropped: it would otherwise render as a fragment, and cutting mid-character
 * would leave replacement characters at the start of the output.
 */
export function readOutputTail(path: string, maxBytes = TAIL_BYTES): string {
  const size = statSync(path).size
  if (size === 0) return ''

  const length = Math.min(size, maxBytes)
  const start = size - length
  const buffer = Buffer.allocUnsafe(length)
  const fd = openSync(path, 'r')
  let read = 0
  try {
    // A single readSync can return short, so loop until the window is filled or
    // the file ends (it can be truncated or appended to concurrently).
    while (read < length) {
      const bytes = readSync(fd, buffer, read, length - read, start + read)
      if (bytes <= 0) break
      read += bytes
    }
  } finally {
    closeSync(fd)
  }

  const text = buffer.subarray(0, read).toString('utf8')
  if (start === 0) return text
  const newline = text.indexOf('\n')
  return newline === -1 ? text : text.slice(newline + 1)
}
