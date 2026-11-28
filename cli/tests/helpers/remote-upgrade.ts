// Subprocess of server-upgrade.test.ts. All credentials and socket names below
// are created for this run. The mock edge forwards to the real gateway handler.
import assert from 'node:assert/strict'
import { createHmac, randomBytes } from 'node:crypto'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { machineIdentity } from '../../src/features/remote/machine-identity.js'
import { ConnectDenied, ConnectRetryable, machineSocketDirectory } from '../../src/features/remote/cloud-connect.js'
import { openEnvironment, type SharedEnvironment } from '../../src/features/remote/environment.js'
import { privateSocketDirectory, registerTerminal } from '../../src/features/remote/discovery.js'
import { gatewayPolicy, updateGatewayPolicy } from '../../src/features/remote/gateway-policy.js'
import { phoneWorkspace } from '../../src/features/remote/workspace.js'
import type { RemoteHost } from '../../src/features/remote/protocol.js'
import { approvePairing, manageGrants } from '../../src/features/remote/grants.js'
import { deviceId } from '../../src/features/remote/devices.js'
import { testDevice } from './remote-device.js'

const root = homedir(), home = join(root,'.evotai'), scope = randomBytes(12).toString('hex')
const identity = machineIdentity(root,true), gateDir = machineSocketDirectory(identity.environment)
const origin = 'https://fixture.invalid', socket = join(gateDir,'gateway.sock'), material = randomBytes(32), binding = randomBytes(16).toString('hex')
const tls = {key:readFileSync(join(root,'key.pem')),cert:readFileSync(join(root,'cert.pem'))}
const phone = await testDevice(), terminal = crypto.randomUUID(), session = 'original-conversation'
let status = 200, up = false, registrations = 0, attempts = 0, actions = 0, approvals = 0, code = '', exited = ''
const bindings: unknown[] = []
function connectServer(port = 0) {
  return Bun.serve({hostname:'127.0.0.1',port,tls,async fetch(req) {
    if (new URL(req.url).pathname !== '/v2/connect/host' || req.method !== 'POST') return new Response(null,{status:404})
    assert.equal(req.headers.get('authorization'),'Bearer fixture-cli'); const body = await req.json()
    assert.equal(body.secret,identity.secret); bindings.push(body.binding); registrations++
    if (status !== 200) return Response.json({error:'upgrade fixture'},{status})
    return Response.json({version:2,environment:identity.environment,origin,binding,connector:'fixture-connector',ticket_key:material.toString('base64url')})
  }})
}
let control = connectServer(); const port = control.port!, base = `https://127.0.0.1:${port}`
writeFileSync(join(home,'auth.json'),JSON.stringify({server_base_url:base,user:{id:'fixture'},cli_token:'fixture-cli'}),{mode:0o600})
// Supervise a real child, but do not download or run Cloudflare. Its PID is
// private to this test and survives exec so killing it triggers the real retry.
writeFileSync(join(root,'cloudflared'),'#!/bin/sh\necho $$ > "$HOME/connector.pid"\nexec /bin/sleep 60\n',{mode:0o700})
const host: RemoteHost = {
  snapshot:()=>({sessionId:session,generation:1,status:'idle',messages:[],live:'',input:'send',canStop:false,ask:null,models:{active:'test',effort:'',pending:null,revision:'0',options:[]}}),
  act:()=>{actions++},
}
const bus = registerTerminal(home,host,()=>({session,workspace:'fixture',title:'Original',phase:'idle'}),terminal)
bus.share(scope)
const workspace = phoneWorkspace(bus,{listSessions:async()=>[],listSessionsWithText:async()=>[],deleteSession:async()=>false},home,'/fixture',scope)
let gateway: SharedEnvironment | undefined
const launch = () => openEnvironment({home,scope,account:JSON.stringify([base,'fixture']),workspace,host,
  active:()=>gatewayPolicy(home)===scope,pending:c=>{code=c; approvals++},presenceChanged(){},exited:reason=>{exited=reason;gateway?.close()}},
  async (_ms,signal)=>{attempts++; await delay(40,undefined,{signal})})
const edge = Bun.serve({hostname:'127.0.0.1',port:0,async fetch(req){
  if (!up) return new Response(null,{status:502})
  const headers = new Headers(req.headers); headers.set('host','fixture.invalid'); headers.set('origin',origin)
  return fetch('http://localhost'+new URL(req.url).pathname,{unix:socket,method:req.method,headers,body:req.method==='GET'?undefined:await req.arrayBuffer()})
}})
const call = (path:string,token='',data?:unknown) => fetch(`http://127.0.0.1:${edge.port}${path}`,{
  method:data===undefined?'GET':'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json','x-evot-terminal':terminal},body:JSON.stringify(data)})
async function prove() {
  const msg=Buffer.from(JSON.stringify({env:identity.environment,key:phone.key,nonce:crypto.randomUUID(),exp:Math.floor(Date.now()/1000)+90})).toString('base64url')
  const ticket=msg+'.'+createHmac('sha256',material).update(msg).digest('base64url')
  const {nonce}=await (await call('/device/challenge','',{key:phone.key,ticket})).json(); assert.equal(typeof nonce,'string')
  return (await call('/device/prove','',{nonce,signature:await phone.sign(nonce)})).json()
}
async function until(predicate:()=>boolean) {
  const end=Date.now()+3000; while(!predicate()){assert.ok(Date.now()<end,'condition did not converge');await Bun.sleep(5)}
}
const pid = () => {try{return Number(readFileSync(join(root,'connector.pid'),'utf8').trim())}catch{return 0}}
try {
  await updateGatewayPolicy(home,scope,'enable',()=>true)
  status=503; await assert.rejects(launch(),ConnectRetryable); assert.equal(gatewayPolicy(home),scope)
  status=200; gateway=await launch(); const original=gateway
  assert.equal((await call('/')).status,502); assert.equal(gateway.address,origin)
  up=true; const {receipt}=await prove(); assert.ok(receipt); assert.equal(await approvePairing(home,scope,terminal,code),true)
  const {token}=await (await call('/device/poll','',{receipt})).json(); assert.equal(typeof token,'string')
  assert.equal((await (await call('/state',token)).json()).sessionId,session)
  // No connector failure: the control plane may stop altogether. The phone's
  // existing authenticated session still works through the independent edge.
  await control.stop(true); assert.equal((await call('/action',token,{kind:'stop',generation:1})).status,204)
  // Compound outage: kill the connector while Connect is down. Exercise real
  // connection refusal, a 503 from the replacement, then healthy registration.
  await until(()=>pid()>0); const oldPid=pid(); up=false; process.kill(oldPid,'SIGTERM')
  await until(()=>attempts>=2); const beforeRestart=registrations; status=503; control=connectServer(port)
  await until(()=>registrations>beforeRestart); assert.equal(gatewayPolicy(home),scope); assert.equal(exited,'')
  status=200; await until(()=>pid()>0 && pid()!==oldPid); up=true
  assert.equal(gateway,original); assert.ok(bindings.slice(beforeRestart).every(x=>x===binding))
  assert.equal((await (await call('/state',token)).json()).sessionId,session)
  assert.equal((await call('/action',token,{kind:'stop',generation:1})).status,204); assert.equal(actions,2); assert.equal(approvals,1)
  // The host image itself restarts. Bearer tokens expire, but the original
  // device key still proves possession against the persisted approval.
  const preRestartPid=pid(); original.close(); gateway=await launch(); assert.equal(gateway.address,origin)
  await until(()=>pid()>0 && pid()!==preRestartPid)
  assert.equal((await call('/state',token)).status,401); const resumed=await prove(); assert.equal(typeof resumed.token,'string')
  assert.equal((await (await call('/state',resumed.token)).json()).sessionId,session); assert.equal(approvals,1)
  await manageGrants(home,scope,deviceId(phone.key),()=>true); assert.equal((await call('/state',resumed.token)).status,401)
  // A changed account binding on automatic refresh is not an outage. Never
  // follow that 409 with an unbound retry which could take the address back.
  status=409; process.kill(pid(),'SIGTERM'); await until(()=>!!exited)
  assert.match(exited,/binding changed/); assert.equal(bindings.at(-1),binding); assert.equal(gateway.active(),false)
  assert.equal(gatewayPolicy(home),null)
  await updateGatewayPolicy(home,scope,'enable',()=>true)
  status=403; await assert.rejects(launch(),ConnectDenied); assert.equal(gatewayPolicy(home),null)
} finally {
  gateway?.close(); bus.close(); await edge.stop(true); await control.stop(true)
  rmSync(gateDir,{recursive:true,force:true}); rmSync(privateSocketDirectory(home),{recursive:true,force:true})
}
