import { expect, test } from 'bun:test'
import { renderMarkdown } from '../../../src/app/assets/console/ui/chat-markdown.js'

test('both chat surfaces render prose, lists, tables and open streaming fences', () => {
  const html = renderMarkdown('# Title\n- **one**\n- `two`\n\nA|B\n---|---\n1|2\n```ts\nconst x = 1;')
  for (const part of ['<h2>Title</h2>','<ul><li><strong>one</strong></li>','<code>two</code>','<td>2</td>','class="code-block"','data-copy-code','<code>const x = 1;</code>']) expect(html).toContain(part)
})

test('user-provided markup is text; only web and mail links become anchors', () => {
  const html = renderMarkdown('<img> [no](file:///tmp) [yes](https://example.com/) `**literal**`')
  expect(html).toContain('&lt;img&gt;'); expect(html).not.toContain('href="file:'); expect(html).toContain('href="https://example.com/"'); expect(html).toContain('<code>**literal**</code>')
})

test('bare web addresses become links without their trailing punctuation', () => {
  const html = renderMarkdown('See https://evot.ai/docs. Or <https://x.io/a_b>, then `https://not.a/link`.')
  expect(html).toContain('<a href="https://evot.ai/docs" target="_blank" rel="noopener noreferrer">https://evot.ai/docs</a>.')
  expect(html).toContain('<a href="https://x.io/a_b" target="_blank" rel="noopener noreferrer">https://x.io/a_b</a>,')
  expect(html).toContain('<code>https://not.a/link</code>')
  expect(renderMarkdown('javascript:alert(1) and http://ok.io"onmouseover=x')).not.toContain('onmouseover="')
  expect(renderMarkdown('[docs](https://evot.ai/d)')).toContain('>docs</a>')
})
