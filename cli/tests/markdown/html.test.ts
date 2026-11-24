import { expect, test } from 'bun:test'
import { markdownToHtml } from '../../src/markdown/render/html.js'
import { assistantRow } from '../../src/term/app/remote/conversation.js'

test('the phone gets the TUI Markdown: same parse, pangu, heading prefixes, link rule and escaping', () => {
  const html = markdownToHtml([
    '# 标题', '### 三级', '',
    '一条trace 看 https://evot.ai/x. 和 [文档](https://evot.ai/d)，[m](mailto:a@b.c)，[bad](javascript:alert(1))。',
    '**粗** *斜* `code` <img src=x onerror=alert(1)> a & b', '',
    '- a', '  1. b', '- [x] done', '',
    '```ts', 'const x = 1 // one', 'const longer = 2 // two', '```', '',
    '```', '┌──┐', '└──┘', '```',
  ].join('\n'))
  expect(html).toContain('<h2 class="md-h1">标题</h2>')
  expect(html).toContain('<h4 class="md-h3">### 三级</h4>')
  expect(html).toContain('一条 trace 看') // pangu, as in the terminal
  expect(html).toContain('<a class="md-link" href="https://evot.ai/x" target="_blank" rel="noopener noreferrer">https://evot.ai/x</a>.')
  expect(html).toContain('>文档</a>') // the target can be opened, so the text is the link
  expect(html).toContain('，a@b.c，') // mailto shows its bare address
  expect(html).not.toContain('javascript:')
  expect(html).not.toContain('<img')
  expect(html).toContain('a &amp; b')
  expect(html).toContain('<strong class="md-strong">粗</strong>')
  expect(html).toContain('<li>[x] done</li>')
  expect(html).toContain('<ol class="md-list md-depth-1">')
  expect(html).toContain('<span class="hljs-keyword">const</span> x = <span class="hljs-number">1</span>       <span class="hljs-comment">// one</span>')
  expect(html).toContain('<pre class="md-diagram">┌──┐\n└──┘</pre>')
})

test('assistant text reaches the phone with its HTML', () => {
  const row = assistantRow([{ type: 'text', contentIndex: 0, text: 'Run `make check`.' }])
  expect(row?.blocks).toEqual([{ kind: 'text', text: 'Run `make check`.', html: '<p>Run <code class="md-code">make check</code>.</p>' }])
  const thought = assistantRow([{ type: 'thinking', contentIndex: 0, text: '**Waiting for input**' }])
  expect(thought?.blocks).toEqual([{ kind: 'thinking', text: '**Waiting for input**', html: '<p><strong class="md-strong">Waiting for input</strong></p>' }])
})
