import { describe, expect, test } from 'bun:test'
import {
  findLastAssistantMarkdown,
  findLastAssistantTurn,
} from '../src/session/assistant-markdown.js'
import {
  resolveShotSource,
  buildShotHtml,
  ansiToHtml,
  renderAssistantAnsi,
  renderShotAnsi,
  writeMarkdownShot,
  formatShotModelLabel,
  buildShotHeroTime,
  shotWindowSize,
  ansiMaxColumns,
  shotScaleFactor,
  withPngDpi,
  resolveChromeBinary,
} from '../src/commands/log-shot.js'
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

describe('findLastAssistantMarkdown', () => {
  test('returns null for empty history', () => {
    expect(findLastAssistantMarkdown([])).toBeNull()
  })

  test('returns the last assistant rawMarkdown chunk', () => {
    const last = findLastAssistantMarkdown([
      { kind: 'user', id: 'u1' },
      { kind: 'assistant', id: 'a1', rawMarkdown: 'first' },
      { kind: 'tool', id: 't1' },
      { kind: 'assistant', id: 'a2', rawMarkdown: 'second' },
      { kind: 'system', id: 's1' },
    ])
    expect(last).toEqual({ id: 'a2', rawMarkdown: 'second' })
  })

  test('skips empty rawMarkdown', () => {
    const last = findLastAssistantMarkdown([
      { kind: 'assistant', id: 'a1', rawMarkdown: 'keep' },
      { kind: 'assistant', id: 'a2', rawMarkdown: '   ' },
    ])
    expect(last).toEqual({ id: 'a1', rawMarkdown: 'keep' })
  })
})

describe('findLastAssistantTurn', () => {
  test('joins all assistant chunks after the last user message', () => {
    const turn = findLastAssistantTurn([
      { kind: 'user', id: 'u0' },
      { kind: 'assistant', id: 'old', rawMarkdown: 'previous answer' },
      { kind: 'user', id: 'u1' },
      { kind: 'assistant', id: 'a1', rawMarkdown: '# Title\n\n' },
      { kind: 'assistant', id: 'a1b', rawMarkdown: '# Title\n\n' }, // same chunk, multi-line
      { kind: 'tool', id: 't1' },
      { kind: 'assistant', id: 'a2', rawMarkdown: '## Section\n\nbody' },
    ])
    expect(turn).not.toBeNull()
    expect(turn!.chunkCount).toBe(2)
    expect(turn!.id).toBe('a1')
    expect(turn!.rawMarkdown).toBe('# Title\n\n## Section\n\nbody')
  })

  test('returns null when no assistant after last user', () => {
    expect(findLastAssistantTurn([
      { kind: 'assistant', id: 'a0', rawMarkdown: 'old' },
      { kind: 'user', id: 'u1' },
      { kind: 'tool', id: 't1' },
    ])).toBeNull()
  })
})

describe('log-shot ansi + render', () => {
  test('ansiToHtml preserves truecolor fg (chalk.hex style)', () => {
    const html = ansiToHtml('\x1b[38;2;106;106;106m```\x1b[39m plain')
    expect(html).toContain('color:#6a6a6a')
    expect(html).toContain('```')
    expect(html).toContain('plain')
    expect(html).not.toContain('opacity')
    expect(html).not.toContain('\x1b')
  })

  test('ansiToHtml uses double-width cells for CJK (TUI string-width)', () => {
    const html = ansiToHtml('A中B')
    // Width-1 Latin keeps natural mono advance (no forced cell class).
    expect(html).toContain('A')
    expect(html).toContain('class="w2">中</span>')
    expect(html).toContain('B')
    expect(html).not.toContain('class="c"')
  })

  test('ansiToHtml handles bold/italic and 256-color', () => {
    const html = ansiToHtml('\x1b[1mbold\x1b[22m \x1b[3mitalic\x1b[23m \x1b[38;5;141mx\x1b[39m')
    expect(html).toContain('font-weight:700')
    expect(html).toContain('font-style:italic')
    expect(html).toContain('color:#af87ff')
  })

  test('ansiToHtml strips OSC 133 zone markers', () => {
    const html = ansiToHtml('\x1b]133;A\x07hello\x1b]133;B\x07\x1b]133;C\x07')
    expect(html).toContain('hello')
    expect(html).not.toContain('\x1b')
    expect(html).not.toContain('133')
  })

  test('renderAssistantAnsi uses TUI prefix and theme colors', () => {
    const ansi = renderAssistantAnsi('## Title\n\n**bold** and `code`\n\n```\nfoo\n```')
    expect(ansi).toContain('⏺')
    expect(ansi).toContain('\x1b[38;2;')
    expect(ansi).toContain('240;198;116')
    expect(ansi).toContain('177;185;249')
  })

  test('resolveShotSource uses the last committed history turn', () => {
    const source = resolveShotSource({
      historyLines: [
        { kind: 'user', id: 'u1' },
        { kind: 'assistant', id: 'h1', rawMarkdown: '# Full\n\n' },
        { kind: 'assistant', id: 'h2', rawMarkdown: 'body from history' },
      ],
    })
    expect(source).not.toBeNull()
    expect(source?.rawMarkdown).toBe('# Full\n\nbody from history')
    expect(source?.chunkCount).toBe(2)
    expect(source?.paintedLines).toHaveLength(2)
  })

  test('resolveShotSource returns null without committed history', () => {
    expect(resolveShotSource({ historyLines: [] })).toBeNull()
    expect(resolveShotSource({})).toBeNull()
  })

  test('resolveShotSource falls back to raw history when painted text is absent', () => {
    const source = resolveShotSource({
      historyLines: [{ kind: 'assistant', id: 'mem', rawMarkdown: 'from memory' }],
    })
    expect(source).not.toBeNull()
    expect(source?.rawMarkdown).toBe('from memory')
    expect(source?.id).toBe('mem')
    expect(source?.chunkCount).toBe(1)
    expect(source?.paintedLines?.length).toBe(1)
  })

  test('buildShotHtml matches TUI: ⏺, gold heading, slate canvas, full turn content', () => {
    const source = resolveShotSource({
      historyLines: [
        { kind: 'user', id: 'u' },
        { kind: 'assistant', id: 'a1', rawMarkdown: '## Hello\n\n' },
        { kind: 'assistant', id: 'a2', rawMarkdown: '```\ncode\n```\n\n`inline`' },
      ],
    })
    expect(source).not.toBeNull()
    const html = buildShotHtml(source!)
    expect(html).not.toContain('2 chunks')
    expect(html).toContain('⏺')
    expect(html).toContain('Hello')
    expect(html).toContain('code')
    expect(html).toContain('color:#f0c674')
    expect(html).toContain('color:#b1b9f9')
    expect(html).toContain('color:#6a6a6a')
    expect(html).toContain('--bg: #3f404e')
    expect(html).toContain('Menlo') // terminal mono stack
    expect(html).toContain('.w2') // CJK cell metric present in CSS
    expect(html).not.toContain('background:#39c5cf')
    expect(html).not.toContain('background:#56b6c2')
  })

  test('buildShotHtml header is a single line: brand left, muted meta right', () => {
    const source = resolveShotSource({
      historyLines: [
        { kind: 'assistant', id: 'a1', rawMarkdown: 'hi' },
      ],
    })
    expect(source).not.toBeNull()
    const html = buildShotHtml(source!, {
      header: {
        model: 'claude-opus-4-8',
        thinkingLevel: 'high',
        sessionId: '019f5621-a16e-7453-83e0-d649dd632c14',
        cwd: `${process.env.HOME}/github/evotai/evot`,
        branch: 'main',
      },
    })
    expect(html).toContain('class="shot-header"')
    expect(html).toContain('class="shot-brand">evot</span>')
    // Model · time collapse into one muted right-side run — no pill.
    expect(html).toMatch(/class="shot-right">claude-opus-4-8 · high · \d{4}-\d{2}-\d{2} \d{2}:\d{2}</)
    expect(html).not.toContain('shot-model')
    expect(html).not.toContain('shot-rule')
    expect(html).not.toContain('@anthropic')
    expect(html).not.toContain('provider')
    // No workspace path on the share image.
    expect(html).not.toContain('~/github/evotai/evot')
    expect(html).not.toContain('session 019f5621')
    expect(html).not.toContain('100 cols')
    expect(html).not.toContain('class="chip"')
    // Footer is just the command — signature and how-to in one word.
    expect(html).toContain('class="shot-footer">/log shot</footer>')
    expect(html).not.toContain('Generated with')
    expect(html).toContain('<title>evot shot · claude-opus-4-8 · high ·')
  })

  test('formatShotModelLabel omits provider and empty parts', () => {
    expect(formatShotModelLabel({ model: 'gpt-5.5' })).toBe('gpt-5.5')
    expect(formatShotModelLabel({ model: 'gpt-5.5', thinkingLevel: 'off' })).toBe('gpt-5.5 · thinking off')
    expect(formatShotModelLabel({})).toBe('')
  })

  test('painted history lines keep TUI wrap 1:1 (no raw reflow)', () => {
    // SGR-tagged text forces the painted path (colorless text would re-render).
    const long =
      'Snowflake 的 Incremental MV 不是整表全量重算，而是维护一个可合并的中间态，并在 refresh 时做增量 merge。'
    const painted = `\x1b[37m${long}\x1b[39m`
    const source = resolveShotSource({
      historyLines: [{
        kind: 'assistant',
        id: 'p1',
        rawMarkdown: long,
        text: painted,
      }],
    })
    expect(source).not.toBeNull()
    const ansi = renderShotAnsi(source!, 40)
    // Soft-wrap may split display, but the original long token sequence remains
    // (no markdown re-lex into headings/tables).
    expect(ansi).toContain('Incremental MV')
    expect(ansi).toContain('⏺')
    expect(source!.paintedLines?.[0]?.text).toBe(painted)
  })

  test('shot header helpers show capture time only', () => {
    expect(buildShotHeroTime('2026-07-09T14:05:54')).toContain('2026-07-09 14:05')
  })

  test('table cells keep TUI alignment metrics in HTML', () => {
    const source = resolveShotSource({
      historyLines: [{
        kind: 'assistant',
        id: 't1',
        rawMarkdown: '| 类型 | 分片内容 |\n|---|---|\n| 投影/过滤 MV | 源行子集 |\n',
      }],
    })
    expect(source).not.toBeNull()
    const html = buildShotHtml(source!, { columns: 100 })
    // Box borders from the shared TUI table renderer, painted with tableBorder.
    expect(html).toContain('┌')
    expect(html).toContain('│')
    expect(html).toContain('color:#8a8a8a')
    // CJK forced to 2-cell advance so borders stay aligned in the browser.
    expect(html).toMatch(/class="w2"[^>]*>类</)
    expect(html).toContain('--bg: #3f404e')
    expect(html).toContain('Menlo')
    // No soft-wrap that would shatter the grid.
    expect(html).toContain('white-space: pre;')
  })

  test('writeMarkdownShot writes full-turn HTML from history', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'evot-shot-out-'))
    try {
      const progress: string[] = []
      const result = await writeMarkdownShot({
        historyLines: [
          { kind: 'user', id: 'u1' },
          { kind: 'assistant', id: 'asst-10', rawMarkdown: '# Snowflake MV\n\nintro' },
          { kind: 'assistant', id: 'asst-11', rawMarkdown: '## Conclusion\n\ndone' },
        ],
        outDir: join(dir, 'shots'),
        png: false,
        open: false,
        onProgress: stage => progress.push(stage),
      })
      expect(progress).toEqual(['rendering_html'])
      expect(result.messageId).toBe('asst-10')
      expect(result.chunkCount).toBe(2)
      expect(existsSync(result.htmlPath)).toBe(true)
      const body = readFileSync(result.htmlPath, 'utf8')
      expect(body).toContain('Snowflake MV')
      expect(body).toContain('Conclusion')
      expect(body).toContain('⏺')
      expect(body).toContain('padding: 14px 16px 18px')
      expect(body).toContain('class="shot-footer"')
      expect(body).toContain('/log shot')
      expect(body).not.toContain('shot-rule')
      expect(result.pngPath).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('shotWindowSize tracks content height without a 900px floor', () => {
    const short = shotWindowSize(80, 20)
    expect(short.height).toBeLessThan(900)
    expect(short.height).toBeGreaterThan(200)
    const long = shotWindowSize(80, 200)
    expect(long.height).toBeGreaterThan(short.height)
    expect(long.height).toBeLessThanOrEqual(16000)
    // Wide content still gets a usable width, but not a tall empty frame.
    expect(shotWindowSize(40, 5).width).toBeGreaterThanOrEqual(480)
  })

  test('ansiMaxColumns ignores trailing whitespace', () => {
    expect(ansiMaxColumns('short   \nwide line')).toBe(9)
    expect(ansiMaxColumns('\x1b[31mred\x1b[0m      ')).toBe(3)
  })

  test('shotScaleFactor keeps narrow shots pixel-dense', () => {
    expect(shotScaleFactor(550)).toBe(3) // 1650px — no chat-app upscale blur
    expect(shotScaleFactor(360)).toBe(4)
    expect(shotScaleFactor(1400)).toBe(2) // wide shots stay plain retina
    expect(shotScaleFactor(3000)).toBe(2)
    expect(shotScaleFactor(0)).toBe(2)
  })

  test('withPngDpi inserts a valid pHYs chunk after IHDR', () => {
    // Minimal synthetic PNG: signature + IHDR + IEND.
    const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    const ihdrBody = Buffer.alloc(17)
    ihdrBody.write('IHDR', 0, 'latin1')
    const ihdr = Buffer.concat([
      Buffer.from([0, 0, 0, 13]),
      ihdrBody,
      Buffer.from([0, 0, 0, 0]),
    ])
    const iend = Buffer.from([0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82])
    const png = Buffer.concat([sig, ihdr, iend])

    const out = withPngDpi(png, 216) // 72 × 3
    const at = sig.length + ihdr.length
    expect(out.readUInt32BE(at)).toBe(9)
    expect(out.subarray(at + 4, at + 8).toString('latin1')).toBe('pHYs')
    expect(out.readUInt32BE(at + 8)).toBe(Math.round(216 / 0.0254))
    expect(out.readUInt8(at + 16)).toBe(1)
    // Non-PNG input passes through untouched.
    const junk = Buffer.from('not a png')
    expect(withPngDpi(junk, 144)).toBe(junk)
  })

  test('canvas hugs narrow content instead of the wide wrap budget', () => {
    const source = resolveShotSource({
      historyLines: [{ kind: 'assistant', id: 'a', rawMarkdown: 'short reply' }],
    })
    expect(source).not.toBeNull()
    // Captured in a very wide terminal: the canvas must track the painted
    // content width, not leave a ~200ch empty right band.
    const html = buildShotHtml(source!, { columns: 220 })
    const m = html.match(/\.shot-frame \{\s*width: (\d+)ch/)
    expect(m).not.toBeNull()
    expect(Number(m![1])).toBeLessThan(80)
  })
})

describe('resolveChromeBinary', () => {
  const none = {
    env: {} as NodeJS.ProcessEnv,
    which: () => null,
    exists: () => false,
  }

  test('linux does not inherit the macOS Chrome.app path', () => {
    expect(resolveChromeBinary({ ...none, platform: 'linux' })).toBeNull()
  })

  test('linux prefers an existing chromium binary over PATH names', () => {
    const exists = (path: string) => path === '/usr/bin/chromium-browser'
    expect(resolveChromeBinary({
      ...none,
      platform: 'linux',
      exists,
    })).toBe('/usr/bin/chromium-browser')
  })

  test('linux resolves chromium from PATH when no absolute path exists', () => {
    expect(resolveChromeBinary({
      ...none,
      platform: 'linux',
      which: command => command === 'chromium' ? '/opt/bin/chromium' : null,
    })).toBe('/opt/bin/chromium')
  })

  test('darwin only uses Chrome.app when the file exists', () => {
    const mac = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    expect(resolveChromeBinary({
      ...none,
      platform: 'darwin',
      exists: path => path === mac,
    })).toBe(mac)
    expect(resolveChromeBinary({ ...none, platform: 'darwin' })).toBeNull()
  })

  test('EVOT_CHROME wins when the override exists', () => {
    expect(resolveChromeBinary({
      ...none,
      platform: 'linux',
      env: { EVOT_CHROME: '/opt/chrome/chrome' } as NodeJS.ProcessEnv,
      exists: path => path === '/opt/chrome/chrome',
    })).toBe('/opt/chrome/chrome')
  })

  test('missing EVOT_CHROME override is skipped instead of spawned', () => {
    expect(resolveChromeBinary({
      ...none,
      platform: 'linux',
      env: { EVOT_CHROME: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' } as NodeJS.ProcessEnv,
      which: command => command === 'chromium' ? '/usr/bin/chromium' : null,
    })).toBe('/usr/bin/chromium')
  })
})
