import {expect,test} from 'bun:test'
import {execFileSync} from 'node:child_process'
import {mkdtempSync,mkdirSync,rmSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {hasWorktreeChanges,worktreeStatusCache} from '../../../src/features/remote/worktree-status.js'

import {paintChangesButton} from '../../../src/features/remote/phone-review.js'
import legacy from '../../fixtures/contracts/remote-state-worktree-legacy.json'

test('only confirmed changes light the button; missing legacy status is unknown, not clean',()=>{
  let dot=false
  const button={title:'',ariaLabel:'',disabled:false,toggleAttribute(_:string,on:boolean){dot=on}}
  const current={...legacy,worktreeChanged:true}
  paintChangesButton(button,true,current);expect(dot).toBe(true);expect(button.ariaLabel).toContain('Uncommitted changes')
  paintChangesButton(button,true,{...current,worktreeChanged:false});expect(dot).toBe(false);expect(button.title).toContain('clean')
  paintChangesButton(button,true,legacy);expect(dot).toBe(false);expect(button.title).toBe('Changes')
  paintChangesButton(button,false,current);expect(dot).toBe(false);expect(button.disabled).toBe(true)
  const {worktreeChanged,...legacyFields}=JSON.parse(JSON.stringify(current));expect(worktreeChanged).toBe(true);expect(legacyFields).toStrictEqual(legacy)
})

test('Changes dot tracks the selected directory, including new files, and goes out after commit',async()=>{
  const root=mkdtempSync(join(tmpdir(),'review-status-')), cwd=join(root,'scope'); mkdirSync(cwd)
  const git=(...args:string[])=>execFileSync('git',['-c','user.name=test','-c','user.email=test@example.org',...args],{cwd:root})
  const check=()=>hasWorktreeChanges(cwd), file=join(cwd,'file')
  try {
    expect(await check()).toBeUndefined(); git('init','-q'); expect(await check()).toBe(false)
    writeFileSync(join(root,'.gitignore'),'*.ignored\n'); writeFileSync(join(cwd,'draft.ignored'),'ignore'); expect(await check()).toBe(false)
    writeFileSync(file,'start'); expect(await check()).toBe(true); git('add','.'); expect(await check()).toBe(true)
    git('commit','-qm','first'); expect(await check()).toBe(false); writeFileSync(join(root,'outside'),'outside'); expect(await check()).toBe(false)
    writeFileSync(file,'edited'); expect(await check()).toBe(true); git('add','scope'); expect(await check()).toBe(true)
    writeFileSync(file,'start'); expect(await check()).toBe(false) // review compares the final contents to HEAD
    rmSync(file); expect(await check()).toBe(true)
  } finally {rmSync(root,{recursive:true,force:true})}
})

test('status is lazy and bounded, and an old probe cannot light a different working directory',async()=>{
  let now=0; const calls:string[]=[], waits:((v:boolean|undefined)=>void)[]=[]
  const read=worktreeStatusCache(cwd=>{calls.push(cwd);return new Promise(resolve=>waits.push(resolve))},()=>now)
  const flush=()=>new Promise(resolve=>setImmediate(resolve))
  expect(calls).toEqual([]); expect(read('a')).toBeUndefined();read('a');read('b');expect(calls).toEqual(['a','b'])
  waits[1]!(false);waits[0]!(true);await flush();expect(read('b')).toBe(false)
  now=5000;expect(read('b')).toBe(false);expect(calls).toEqual(['a','b','b']);waits[2]!(true);await flush();expect(read('b')).toBe(true)
})
