import { test, expect } from 'bun:test'
import { formatBytes, formatMemoryLine, memorySnapshot } from '../../src/term/diagnostics/memory.js'

test('memory line names resident size, JS heap and what the client retains', () => {
  const line = formatMemoryLine({
    rssBytes: 812 * 1024 * 1024,
    heapUsedBytes: 231 * 1024 * 1024,
    heapTotalBytes: 300 * 1024 * 1024,
    externalBytes: 12 * 1024 * 1024,
    retained: { compactRows: 18_400, expandedRows: 64_000, messages: 32 },
  })
  expect(line).toBe('[MEM] rss 812M · js heap 231M/300M · external 12M · rows 18k/64k · msgs 32')
})

test('snapshot reads the live process and carries the retained counts through', () => {
  const snapshot = memorySnapshot({ compactRows: 3, expandedRows: 4, messages: 1 })
  expect(snapshot.rssBytes).toBeGreaterThan(0)
  expect(snapshot.heapUsedBytes).toBeGreaterThan(0)
  expect(snapshot.retained).toEqual({ compactRows: 3, expandedRows: 4, messages: 1 })
})

test('byte formatting picks a unit the eye can compare', () => {
  expect(formatBytes(512)).toBe('512B')
  expect(formatBytes(2048)).toBe('2K')
  expect(formatBytes(8.4 * 1024 * 1024 * 1024)).toBe('8.40G')
})
