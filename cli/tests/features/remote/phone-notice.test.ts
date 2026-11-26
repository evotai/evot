import { expect, test } from 'bun:test'
import { paintCommandNotice } from '../../../src/features/remote/phone-notice.js'
import type { RemoteMessage } from '../../../src/features/remote/protocol.js'
import { layoutCommandNotice, noticeResult } from '../../../src/ui/notice-layout.js'
import legacy from '../../fixtures/contracts/remote-command-notice-v1.json'

class Node {
  textContent = ''
  dataset: Record<string, string> = {}
  childNodes: (Node | string)[] = []
  href?: string
  target?: string
  rel?: string
  classList = new Set<string>()
  ownerDocument = { createElement: (tag: string) => new Node(tag) }
  constructor(readonly tag: string) {}
  append(node: Node | string) { this.childNodes.push(node) }
  get text(): string {
    return this.textContent + this.childNodes.map(node => typeof node === 'string' ? node : node.text).join('')
  }
}

function render(text: string, command: NonNullable<RemoteMessage['command']>) {
  const root = new Node('div')
  paintCommandNotice(root, text, command)
  return { root, nodes:root.childNodes.filter(node => node instanceof Node) }
}

test('paints the shared layout literally, including tone, labels and detail whitespace', () => {
  const spans = layoutCommandNotice({state:'error',label:'Sync',message:'<strong>Offline</strong>',details:['','Try again']})
  const text = '  ✗ Sync  <strong>Offline</strong>\n\n    Try again'
  const {root, nodes} = render(text, {styled:true,spans})
  expect(root.text).toBe(text)
  expect(nodes.map(n => [n.tag,n.dataset.tone,n.text])).toEqual([
    ['span','error','✗'], ['span','label','Sync'], ['span','body','<strong>Offline</strong>'], ['span','muted','    Try again'],
  ])
})

test('reads the legacy styled notice, while a new payload never infers meaning from the glyph', () => {
  const {root, nodes} = render(legacy.text, legacy.command as {styled:true})
  expect(root.text).toBe(legacy.text)
  expect(nodes[0]?.dataset.tone).toBe('error')
  expect(render(legacy.text, {styled:true,spans:noticeResult(legacy.text)}).nodes[0]?.dataset.tone).toBe('body')
})

test('both contracts only create links from visible valid destinations', () => {
  const link = 'https://example.test/team/fixture'
  const text = `Team · ${link}`
  for (const command of [{link},{spans:noticeResult(text, link)}]) {
    const a = render(text, command).nodes.find(n => n.tag === 'a')
    expect(a).toMatchObject({href:link,target:'_blank',rel:'noopener noreferrer',textContent:link})
  }
  for (const text of ['javascript:alert(1)', 'https://user:password@example.test', 'https://[']) {
    const view = render(text, {spans:[{text,link:true}]})
    expect(view.root.text).toBe(text)
    expect(view.nodes.some(n => n.tag === 'a')).toBe(false)
  }
})
