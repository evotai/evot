import { expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { registerTerminal } from '../../../src/features/remote/discovery.js'
import { DeviceStore } from '../../../src/features/remote/devices.js'
import { DeviceAccess } from '../../../src/features/remote/pairing.js'
import { listenRemote } from '../../../src/features/remote/server.js'
import { phoneWorkspace } from '../../../src/features/remote/workspace.js'
import { pendingDevice } from '../../helpers/remote-device.js'
import { worktreeReview } from '../../../src/features/remote/worktree-review.js'

function repository() {
  const root = mkdtempSync(join(tmpdir(),'evot-review-')), cwd = join(root,'project')
  mkdirSync(cwd)
  const git = (...args:string[]) => execFileSync('git',['-c','user.name=test','-c','user.email=test@example.org',...args],{cwd:root})
  git('init','-q','-b','review')
  return {root,cwd,git,write:(name:string, text:string|Buffer)=>writeFileSync(join(cwd,name),text)}
}

test('review compares the selected cwd to HEAD once, including staged, unstaged and untracked files',async()=>{
  const {root,cwd,git,write} = repository()
  try {
    write('file.ts','original\n'); write('.gitignore','*.ignored\n'); writeFileSync(join(root,'outside'),'original'); git('add','.'); git('commit','-qm','fixture')
    expect((await worktreeReview(cwd)).files).toEqual([])
    write('file.ts','staged\n'); git('add','.'); write('file.ts','final\n'); writeFileSync(join(root,'outside'),'changed')
    write('draft.ignored','ignore me'); write('new <name>.ts','<example>\n'); write('binary',Buffer.from([0,1])); write('huge','a'.repeat(200000)); symlinkSync('../outside',join(cwd,'link'))
    const r = await worktreeReview(cwd)
    expect(r.folder).toBe('project'); expect(r.branch).toBe('review')
    expect(r.files.map(f=>f.name)).toEqual(['binary','file.ts','huge','link','new <name>.ts'])
    const edited=r.files[1]!
    expect(edited.status).toBe('M'); expect(edited.unified).toContain('original'); expect(edited.unified).toContain('final'); expect(edited.unified).not.toContain('staged'); expect(edited.split).toContain('d2h-file-side-diff')
    expect(r.files[4]?.unified).toContain('&lt;example&gt;'); expect(r.files.slice(2,4).every(f=>f.note&&!f.unified)).toBe(true); expect(r.files[0]?.note).toBe('Binary file.')
  } finally {rmSync(root,{recursive:true,force:true})}
})
test('only an authenticated GET for a shared target can start a review; shell and state are lazy',async()=>{
  const home=mkdtempSync(join(tmpdir(),'review-window-')), scope='test-review'
  const badge=()=>({session:'',workspace:'fixture',title:'fixture',phase:'idle' as const})
  let reads=0
  const host={snapshot(){throw Error('unexpected snapshot')},act(){},async changes(){reads++;return {folder:'selected',branch:'main',files:[]}}}
  const bus=registerTerminal(home,{...host,async changes(){throw Error('wrong window')}},badge), peer=registerTerminal(home,host,badge)
  bus.share(scope); peer.share(scope)
  const access=new DeviceAccess(new DeviceStore(home),()=>{})
  const server=listenRemote(host,access,{workspace:phoneWorkspace(bus,{listSessions:async()=>[],listSessionsWithText:async()=>[],deleteSession:async()=>true},home,home,scope)})
  try {
    const url=server.address+'/changes/snapshot', target={'x-evot-terminal':peer.id}
    expect((await fetch(server.address+'/changes')).status).toBe(200)
    expect((await fetch(url,{headers:target})).status).toBe(401)
    const device=await pendingDevice(server.address); access.approve(device.code)
    const headers={...target,authorization:'Bearer '+(await device.poll()).token}
    expect((await fetch(url,{headers,method:'POST'})).status).toBe(405); expect(reads).toBe(0)
    expect(await (await fetch(url+'?cwd=/not-the-window',{headers})).json()).toMatchObject({folder:'selected'}); expect(reads).toBe(1)
    peer.share(null); expect((await fetch(url,{headers})).status).toBe(403); expect(reads).toBe(1)
  } finally {server.close();peer.close();bus.close();rmSync(home,{recursive:true,force:true})}
})

test('a new repo compares staged changes against its empty tree; non-git folders are explicit',async()=>{
  const {root,cwd,git,write}=repository()
  try {
    write('new','hello'); git('add','project/new'); expect((await worktreeReview(cwd)).files[0]).toMatchObject({name:'new',status:'A'})
    rmSync(join(root,'.git'),{recursive:true}); expect((await worktreeReview(cwd)).message).toMatch(/No Git/)
  } finally {rmSync(root,{recursive:true,force:true})}
})
