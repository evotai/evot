import { expect, test } from 'bun:test'
import { enterIntent } from '../../../src/features/remote/phone-editor.js'
import { completionGesture } from '../../../src/features/remote/phone-commands.js'
import { composerTab, draftHintText, inlineSuggestion, tabIntent } from '../../../src/features/remote/phone-composer-keys.js'
import old from '../../fixtures/contracts/remote-composer-legacy.json'

const running = {...old,input:'steer',composerKeys:{queue:true},commands:[{name:'/review',prefix:'/rev'}]}
const plain = {choices:false,photos:0,ghost:''}
test('inline feedback is never insertable and respects local drafts, dismissal, and older hosts', () => {
  const hint = '· nothing to suggest · ⇥ retry', empty = {...old, suggestionHint:hint}
  expect(inlineSuggestion(empty,true,'')).toEqual({key:hint,candidate:'',text:hint})
  expect(inlineSuggestion(empty,true,hint)).toBeNull()
  for (const view of [{...empty,input:null},{...empty,ask:{id:'ask'}},null]) expect(inlineSuggestion(view,true,'')).toBeNull()
  const ready = {...old, suggestion:'Run tests.'}
  expect(inlineSuggestion(ready,true,'')?.candidate).toBe(ready.suggestion) // old host: candidate only
  expect(inlineSuggestion(ready,false,'')).toBeNull() // user typed, composing, or attached a photo while waiting
  expect(inlineSuggestion(ready,true,ready.suggestion)).toBeNull()
  expect(inlineSuggestion({...ready,suggestionHint:'· suggesting…'},true,'')).toMatchObject({candidate:ready.suggestion,text:'Run tests.  · suggesting…'})
})

test('only one line of guidance owns the empty field, and none paints over typing or IME', () => {
  const preview = {text:'Can you help me debug some code?'}
  expect(draftHintText(true, old, null, 0)).toBe('Ask anything about this project…')
  expect(draftHintText(true, old, preview, 2)).toBe(preview.text)
  expect(draftHintText(false, old, preview, 2)).toBe('')
  expect(draftHintText(true, running, {text:'· nothing to suggest · ⇥ retry'}, 0)).toBe('· nothing to suggest · ⇥ retry')
  expect(draftHintText(true, running, null, 2)).toBe('2 messages queued')
  expect(draftHintText(true, running, null, 0)).toBe('Steer the active run…')
})

test('Tab never submits an idle/legacy draft, an unfinished command or a file completion', () => {
  const tab = (text:string) => tabIntent(running,text,text.length,plain)
  expect(tab('next step')).toBe('Send after'); expect(tab('/rev inspect')).toBe('Send after')
  for (const text of ['hello @name','read src/main.rs','read "./a path"','read ./a\\ path','/unknown command','   ']) expect(tab(text)).toBeNull()
  expect(tab('inspect https://example.org/a')).toBe('Send after'); expect(tab('done 2/3')).toBe('Send after')
  expect(tabIntent(running,'/rev',4,{...plain,choices:true})).toBe('Complete')
  expect(tabIntent(old,'next step',9,plain)).toBeNull(); expect(tabIntent(null,'hi',2,plain)).toBeNull()
  expect(tabIntent({...old,composerKeys:{suggest:true}},'',0,plain)).toBe('Suggest')
  expect(tabIntent(running,'',0,{...plain,photos:1})).toBe('Send after')
})

test('only unmodified Tab is intercepted by the accessory; typing, Shift+Tab and IME stay native', () => {
  const calls:string[] = [], button = {hidden:false,disabled:false,lastElementChild:{textContent:''},onclick(){}},
    draft = {value:'later',selectionStart:5,addEventListener(){},focus(){}}
  const tab = composerTab(draft,button,{commands:{hasChoices:false}, queue:()=>calls.push('queue'), disarm(){}, suggest(){},changed(){}})
  tab.render(old,false,0,''); expect(button.hidden).toBe(true)
  tab.render(running,false,0,''); expect(button.hidden).toBe(false); expect(button.lastElementChild.textContent).toBe('Send after')
  for (const e of [{key:'Tab',shiftKey:true},{key:'Tab',isComposing:true},{key:'Tab',keyCode:229},{key:'k',ctrlKey:true},{key:'ArrowDown'},{key:'d',altKey:true}])
    expect(tab.keydown(e)).toBe(false)
  expect(calls).toBeEmpty(); expect(tab.keydown({key:'Tab',preventDefault(){}})).toBe(true); button.onclick()
  expect(calls).toEqual(['queue','queue'])
})

test('command menu navigation is scoped to visible candidates', () => {
  expect(completionGesture('ArrowUp',3,0,false,false)).toEqual({index:2})
  expect(completionGesture('ArrowDown',3,2,true,false)).toEqual({index:0})
  for (const key of ['Enter','Tab']) expect(completionGesture(key,3,1,true,true)).toEqual({accept:true})
  expect(completionGesture('Enter',2,0,false,true)).toBeNull()
  expect(completionGesture('ArrowDown',0,0,false,false)).toBeNull()
})

test('ordinary desktop Enter keeps continuation, software Return and modified Enter stay native', () => {
  const enter = {key:'Enter'}
  for (const [text,cursor] of [['```ts\nconst x = 1',6],['path\\ rest',5],['a\nb\\',0]] as const)
    expect(enterIntent(enter,'send',text,cursor,true)).toBe('continue')
  expect(enterIntent(enter,'send','```\nx\n```',9,true)).toBe('submit')
  expect(enterIntent(enter,'steer','a\\',2,true)).toBe('submit')
  expect(enterIntent(enter,'send','hi',2,false)).toBeNull()
  for (const prop of ['isComposing','shiftKey','metaKey','altKey','ctrlKey']) expect(enterIntent({...enter,[prop]:true},'send','hi',2,true)).toBeNull()
})
