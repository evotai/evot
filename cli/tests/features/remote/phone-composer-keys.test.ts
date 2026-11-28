import { expect, test } from 'bun:test'
import { enterIntent } from '../../../src/features/remote/phone-editor.js'
import { commandMenu, phoneCompletion } from '../../../src/features/remote/phone-commands.js'
import { composerTab, draftHintText, inlineSuggestion, tabIntent } from '../../../src/features/remote/phone-composer-keys.js'
import { phoneCommandHints } from '../../../src/term/app/remote/commands.js'
import old from '../../fixtures/contracts/remote-composer-legacy.json'

const running = {...old,input:'steer',composerKeys:{queue:true},commands:[{name:'/review',prefix:'/rev'}]}
const plain = {choices:false,photos:0,ghost:''}
test('inline feedback is never insertable and respects local drafts, dismissal, and older hosts', () => {
  const hint = '· nothing to suggest · ⇥ retry', empty = {...old, suggestionHint:hint}
  expect(inlineSuggestion(empty,true,'')).toEqual({key:hint,candidate:'',text:hint})
  expect(inlineSuggestion(empty,true,hint)).toBeNull()
  expect(inlineSuggestion({...old,suggestionHint:'no suggestion'},true,'')).toBeNull()
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
  expect(tabIntent({...old,composerKeys:{suggest:true}},'',0,{...plain,ghost:'Run tests.'})).toBe('Accept')
  expect(tabIntent(running,'',0,{...plain,photos:1})).toBe('Send after')
})

test('showing builtins in the shared hint catalog does not let them queue', () => {
  const catalog = phoneCommandHints([{name:'harden',dir:'/private/fixture',command:{description:'Review a plan'}}])
  const view = {...running,slashHints:{catalog,forked:false,inventory:{models:[],sessions:[]}}}
  for (const text of ['/share team', '/restart now', '/remote off', '/remote hide', '/skill list']) {
    expect(tabIntent(view,text,text.length,plain)).toBeNull()
  }
  const task = '/ha check edge cases'
  expect(tabIntent(view,task,task.length,plain)).toBe('Send after')
})

test('only unmodified Tab is intercepted by the accessory; typing, Shift+Tab and IME stay native', () => {
  const calls:string[] = [], button = {hidden:false,disabled:false,lastElementChild:{textContent:''},onclick(){},addEventListener(){}},
    doc = {activeElement:null as object | null}, draft = {ownerDocument:doc,value:'later',selectionStart:5,addEventListener(){},focus(){}}
  const tab = composerTab(draft,button,{commands:{hasChoices:false}, queue:()=>calls.push('queue'), disarm(){}, suggest(){},changed(){}})
  draft.value = ''; const idle = {...old,composerKeys:{suggest:true}}
  tab.render(idle,false,0,''); expect(button.hidden).toBe(true)
  doc.activeElement = draft; tab.render(idle,false,0,''); expect(button.hidden).toBe(false)
  tab.render(idle,true,0,''); expect(button.hidden).toBe(true)
  draft.value = 'later'; tab.render(old,false,0,''); expect(button.hidden).toBe(true)
  tab.render(running,false,0,''); expect(button.hidden).toBe(false); expect(button.lastElementChild.textContent).toBe('Send after')
  for (const e of [{key:'Tab',shiftKey:true},{key:'Tab',isComposing:true},{key:'Tab',keyCode:229},{key:'k',ctrlKey:true},{key:'ArrowDown'},{key:'d',altKey:true}])
    expect(tab.keydown(e)).toBe(false)
  expect(calls).toBeEmpty(); expect(tab.keydown({key:'Tab',preventDefault(){}})).toBe(true); button.onclick()
  expect(calls).toEqual(['queue','queue'])
  tab.setCompact(true); tab.render(running,false,0,''); expect(button.hidden).toBe(true)
  button.onclick(); expect(tab.keydown({key:'Tab'})).toBe(false); expect(calls).toHaveLength(2)
  tab.setCompact(false); expect(button.hidden).toBe(false); button.onclick(); expect(calls).toHaveLength(3)
})

test('slash hints stay inline; only explicit completion opens a menu or edits the draft', () => {
  const doc = {createElement: (tag: string) => new Element(tag)}
  class Element {
    ownerDocument = doc
    children: Element[] = []
    hidden = true
    textContent = ''
    onclick?: () => void
    constructor(readonly tag: string) {}
    addEventListener() {}
    append(child: Element) { this.children.push(child) }
    replaceChildren() { this.children.length = 0 }
    querySelectorAll(tag: string) { return this.children.filter(child => child.tag === tag) }
    toggleAttribute() {}
    scrollIntoView() {}
  }
  const panel = new Element('panel')
  const draft = {value:'',selectionStart:0,selectionEnd:0,maxLength:8192,ownerDocument:doc,
    focus(){},setAttribute(){},removeAttribute(){},
    setSelectionRange(start:number,end:number) { this.selectionStart = start; this.selectionEnd = end },
    setRangeText(text:string,start:number,end:number) {
      this.value = this.value.slice(0,start) + text + this.value.slice(end)
      this.setSelectionRange(start+text.length,start+text.length)
    }}
  const view = {slashHints:{catalog:phoneCommandHints([]),forked:false,inventory:{models:[],sessions:[]}}}
  const commands = commandMenu(draft,panel,() => commands.render(view))
  const type = (text: string) => { draft.value = text; draft.setSelectionRange(text.length,text.length); commands.render(view) }
  const press = (key:string) => commands.keydown({key,target:draft,preventDefault(){}})
  type('/share pu')
  expect(commands.hint).toBe('blic'); expect(panel.hidden).toBe(true)
  expect(press('Enter')).toBe(false); expect(press('ArrowDown')).toBe(false)
  expect(draft.value).toBe('/share pu')
  commands.complete()
  expect(draft.value).toBe('/share public '); expect(panel.hidden).toBe(true)
  type('/share ')
  expect(commands.hint).toBe('  [public  team  private  off  list]'); expect(panel.hidden).toBe(true)
  commands.complete()
  expect(panel.hidden).toBe(false); expect(commands.hint).toBe(''); expect(draft.value).toBe('/share ')
  expect(press('ArrowDown')).toBe(true); expect(press('Enter')).toBe(true)
  expect(draft.value).toBe('/share team '); expect(panel.hidden).toBe(true)
  type('/share pr'); expect(commands.dismiss()).toBe(true); expect(commands.hint).toBe('')
  expect(draft.value).toBe('/share pr')
  type('/share p'); expect(commands.hint).toContain('private')
})

test('selected text and unavailable views suppress inline completion; old windows still work', () => {
  expect(phoneCompletion('/share pu',7,9,running)).toBeNull()
  expect(phoneCompletion('/review',7,7,null)).toBeNull()
  expect(phoneCompletion('/rev',4,4,running)?.hint).toBe('iew')
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
