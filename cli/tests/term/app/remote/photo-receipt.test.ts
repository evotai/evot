import { expect, test } from 'bun:test'
import { ConversationTail } from '../../../../src/term/app/remote/conversation.js'
import legacy from '../../../fixtures/contracts/remote-photo-legacy.json'

test('a photo receipt is additive: an old phone reads the same row and never receives photo bytes', () => {
  const tail = new ConversationTail(), id = crypto.randomUUID()
  tail.append('user',legacy.message.text)
  tail.append('user',legacy.message.text,id)
  expect(tail.messages).toStrictEqual([legacy.message, {...legacy.message,photoId:id}])
  for (const {role,text,blocks} of tail.view(true)) {
    expect({role,text}).toStrictEqual(legacy.message)
    expect(blocks).toBeUndefined()
  }
})
