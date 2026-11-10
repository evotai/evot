import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, expect, test } from 'bun:test'
import { ScreenLog } from '../../src/term/diagnostics/screen-log.js'

describe('ScreenLog', () => {
  test('writes rendered screen output without creating a markdown trace', () => {
    const originalHome = process.env.HOME
    const tmp = mkdtempSync(join(tmpdir(), 'evot-screen-log-'))
    process.env.HOME = tmp

    try {
      const log = new ScreenLog()
      log.bind('00000000-0000-0000-0000-000000000001')
      log.logLines(['Title', 'rendered table'])

      const screen = readFileSync(log.filePath ?? '', 'utf8')
      expect(screen).toContain('Title')
      expect(screen).toContain('rendered table')
      expect(screen).not.toContain('[raw markdown]')
      expect(existsSync(join(tmp, '.evotai', 'logs', '00000000-0000-0000-0000-000000000001.markdown.log'))).toBe(false)
    } finally {
      if (originalHome === undefined) delete process.env.HOME
      else process.env.HOME = originalHome
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})
