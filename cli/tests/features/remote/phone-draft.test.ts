import { expect, test } from 'bun:test'
import { draftLayout } from '../../../src/features/remote/phone-draft.js'

type Node = {nodeType:number;nodeName:string;data?:string;childNodes:Node[];previousSibling?:Node;nextSibling?:Node}
const text = (data:string):Node => ({nodeType:3,nodeName:'#text',data,childNodes:[]})
function el(nodeName:string,...children:Node[]):Node {
  children.forEach((n,i) => { n.previousSibling=children[i-1]; n.nextSibling=children[i+1] })
  return {nodeType:1,nodeName,childNodes:children}
}

test('mobile editable keeps native UTF-16 selections, pasted blank lines and a final Return, not the caret filler', () => {
  const line=text('继续 👋'), end=text('\n'), filler=text('\n')
  const root=el('DIV',line,end,filler), layout=draftLayout(root)
  expect(layout.text).toBe('继续 👋\n'); expect(layout.offset(filler,0)).toBe(6)
  for (let i=0;i<=layout.text.length;i++) expect(layout.offset(...layout.point(i))).toBe(i)
  expect(draftLayout(el('DIV',el('BR'))).text).toBe('')
  expect(draftLayout(el('DIV',text('\n'),el('BR'))).text).toBe('\n') // restored newline-only draft
  expect(draftLayout(el('DIV',el('DIV',text('a')),el('DIV',el('BR')),el('DIV',text('b')))).text).toBe('a\n\nb')
  expect(draftLayout(el('DIV',text('a'),el('BR'),text('b'))).text).toBe('a\nb')
})
