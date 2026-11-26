import { expect, test } from 'bun:test'
import type { RemoteMessage } from '../../../../src/features/remote/protocol.js'
import { renderNoticeSpans } from '../../../../src/ui/command-notice.js'
import { layoutCommandNotice, noticeResult } from '../../../../src/ui/notice-layout.js'
import { ConversationTail } from '../../../../src/term/app/remote/conversation.js'
import legacyNotice from '../../../fixtures/contracts/remote-notice-legacy.json'

test('plain notices are unchanged and older phones still see a clickable result', () => {
  const history = new ConversationTail()
  const legacy = legacyNotice as RemoteMessage
  history.append(legacy.role, legacy.text)
  expect(history.messages[0]).toEqual(legacy)
  const link = 'https://example.test/team/fixture'
  const spans = noticeResult(`Team · ${link}`, link)
  history.commitCommand([{id:'share',kind:'system',preStyled:true,text:renderNoticeSpans(spans),noticeSpans:spans}])
  // The old phone only reads these fields; the structured spans are additive.
  const {role, text, command} = JSON.parse(JSON.stringify(history.messages.at(-1))) as RemoteMessage
  expect({ role, text, styled:command?.styled, link:command?.link }).toStrictEqual({role:'notice',text:`Team · ${link}`,styled:true,link})
  expect(command?.spans).toEqual(spans)
})

test('the projection carries only visible text with safe styles and links', () => {
  const history = new ConversationTail()
  const link = 'https://example.test/team/fixture'
  const hidden = 'https://private.test/hidden'
  const spans = layoutCommandNotice({state:'progress',label:'Share',message:`<b>Loading</b>\x1b]8;;${hidden}\x07…\x1b]8;;\x07`})
  history.commitCommand([{id:'progress',kind:'system',preStyled:true,text:renderNoticeSpans(spans),noticeSpans:spans}])
  expect(history.messages[0]?.command?.spans?.at(-1)).toEqual({text:'<b>Loading</b>…',tone:'muted'})
  expect(JSON.stringify(history.messages)).not.toContain(hidden)
  history.replaceCommand('progress', link, [{text:hidden,link:true}])
  expect(history.messages[0]).toEqual({role:'notice',text:link,command:{styled:true}})
  history.replaceCommand('progress', 'javascript:alert(1)', [{text:'javascript:alert(1)',link:true}])
  expect(history.messages[0]?.command).toEqual({styled:true,spans:[{text:'javascript:alert(1)'}]})
})

test('large outputs fall back to bounded plain text without hidden spans', () => {
  const history = new ConversationTail()
  const spans = noticeResult('not-in-tail ' + 'x'.repeat(10_000))
  history.commitCommand([{id:'progress',kind:'system',preStyled:true,text:renderNoticeSpans(spans),noticeSpans:spans}])
  expect(history.messages[0]?.text).toHaveLength(8192)
  expect(history.messages[0]?.command?.spans).toBeUndefined()
  expect(JSON.stringify(history.messages)).not.toContain('not-in-tail')
})
