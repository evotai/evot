import { describe, expect, test } from 'bun:test'
import { updateNoticeSpans, attachUpdateNotice, standaloneUpdateNotice } from '../src/term/viewmodel/update-notice.js'
import { spansWidth } from '../src/term/viewmodel/width.js'
import type { ViewBlock } from '../src/term/viewmodel/types.js'

const input = { status: 'idle', version: '1.2', availableVersion: '1.3', visible: true, busy: false }

describe('update notice presentation', () => {
  test('visibility and busy state preserve priority rules', () => {
    expect(updateNoticeSpans({ ...input, visible: false })).toBeNull()
    expect(updateNoticeSpans({ ...input, busy: true })).toBeNull()
    expect(updateNoticeSpans({ ...input, status: 'failed' })).toBeNull()
    expect(updateNoticeSpans({ ...input, status: 'staged', busy: true })?.map(span => span.text).join('')).toBe('✔ Update ready v1.2 · /restart to apply')
    expect(updateNoticeSpans({ ...input, status: 'downloading', busy: true })?.[0]?.text).toBe('⬇ Auto-updating to v1.2…')
  })

  test('status attachment does not mutate original rows or add vertical space', () => {
    const status: ViewBlock = { lines: [{ spans: [{ text: 'first row' }] }, { spans: [{ text: 'Thinking…' }] }], marginTop: 1 }
    const notice = [{ text: 'update' }]
    const joined = attachUpdateNotice(status, notice, 80)
    expect(joined.lines).toHaveLength(2)
    expect(joined.lines[0]).toBe(status.lines[0])
    expect(joined.marginTop).toBe(1)
    expect(spansWidth(joined.lines[1]!.spans)).toBe(80)
    expect(status.lines[1]?.spans).toEqual([{ text: 'Thinking…' }])
  })

  test('a narrow notice never overflows or displaces the fixed-height run status', () => {
    const status: ViewBlock = { lines: [{ spans: [{ text: 'Running command · esc twice to interrupt' }] }], marginTop: 1 }
    const notice = [{ text: 'Update ready v1.2 · /restart to apply' }]
    expect(attachUpdateNotice(status, notice, 40)).toBe(status)
    expect(spansWidth(standaloneUpdateNotice(notice, 12, false).lines[0]!.spans)).toBeLessThanOrEqual(12)
  })

  test('standalone notice keeps one blank only when it owns the region', () => {
    const notice = [{ text: 'update' }]
    expect(standaloneUpdateNotice(notice, 80, false).marginTop).toBe(1)
    const attached = standaloneUpdateNotice(notice, 80, true)
    expect(attached.marginTop).toBe(0)
    expect(spansWidth(attached.lines[0]!.spans)).toBe(80)
  })
})
