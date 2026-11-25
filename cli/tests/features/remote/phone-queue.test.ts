import { expect, test } from 'bun:test'
import { lastDraft, queueRows } from '../../../src/features/remote/phone-queue.js'
import legacy from '../../fixtures/contracts/remote-composer-legacy.json'

const steer = {kind:'steer',draftId:'a',text:'same'}, later = {kind:'queue',draftId:'b',text:'same'}

test('TUI order/state wins; repeated captions never identify an item, another composer remains private', () => {
  const promptQueue = [{state:'after',draftId:'b'},{state:'now'},{state:'paused',draftId:'a'}]
  const items = [steer,later,{kind:'send',text:'normal'}]
  expect(queueRows({promptQueue},items)).toStrictEqual([{state:'after',item:later},{state:'now',item:undefined},{state:'paused',item:steer}])
  expect(queueRows({promptQueue},[]).map(r => r.item)).toEqual([undefined,undefined,undefined])
})

test('in-flight queue requests appear once before the snapshot, older hosts need no new fields', () => {
  const item = {...steer,sending:true}
  expect(queueRows(legacy,[item])).toStrictEqual([{state:'sending',item}])
  expect(queueRows({pendingSteers:['a']},[item])).toStrictEqual([{state:'now',item}])
  expect(queueRows({pendingDrafts:['b'],pendingSteers:[]},[later])).toStrictEqual([{state:'after',item:later}])
  expect(queueRows(legacy,[])).toEqual([])
  expect(queueRows({promptQueue:[],pendingDrafts:[]},[steer])).toEqual([]) // removed on computer; no phantom steer
  expect(lastDraft({promptQueue:[{draftId:'a'},{}],pendingDrafts:['a']})).toBeUndefined()
  expect(lastDraft({pendingSteers:['a']})).toBe('a')
})
