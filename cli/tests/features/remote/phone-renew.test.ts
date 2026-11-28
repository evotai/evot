import {expect, test} from 'bun:test'
import {deviceChallenge} from '../../../src/features/remote/phone-renew.js'

const params = {key:'device', terminal:'window', ticket:null}, auth = {login:'https://account/connect', renew:'https://account/connect/renew'}
test('silent reconnect gets a fresh account ticket and repeats only the challenge, for the same device and window', async () => {
  const calls:unknown[] = [], stages:string[] = []
  const post = async (path:string, data:typeof params) => { calls.push([path,data]); return data.ticket ? {nonce:'new'} : auth }
  const result = await deviceChallenge(post,params,true,async (url:string, init:RequestInit) => {
    expect(url).toBe(auth.renew)
    expect(init).toMatchObject({method:'POST',credentials:'include',redirect:'error',cache:'no-store'})
    return Response.json({ticket:'fresh'})
  }, (stage:string) => stages.push(stage))
  expect(stages).toEqual(['challenge','renew','challenge'])
  expect(result).toEqual({nonce:'new'})
  expect(calls).toEqual([['/device/challenge',params],['/device/challenge',{...params,ticket:'fresh'}]])
})
test('automatic reconnect follows the login challenge when silent renewal cannot sign in', async () => {
  expect(await deviceChallenge(async()=>auth,params,true,async()=>new Response(null,{status:401}))).toEqual(auth)
  const legacy = {login:auth.login}
  expect(await deviceChallenge(async()=>legacy,params,true)).toEqual(legacy)
  const next = {login:'https://account/connect/new'}
  expect(await deviceChallenge(async(_:string, data:typeof params)=>data.ticket ? next : auth,params,true,
    async()=>Response.json({ticket:'fresh'}))).toEqual(next)
})
test('denial and transient failures are not login redirects', async () => {
  for (const status of [403,503])
    await expect(deviceChallenge(async()=>auth,params,true,async()=>new Response(null,{status}))).rejects.toMatchObject({status})
  await expect(deviceChallenge(async()=>auth,params,true,async()=>{throw TypeError('offline')})).rejects.toThrow('offline')
  expect(await deviceChallenge(async()=>auth,params,false)).toEqual(auth) // explicit sign-in retains the redirect flow
  expect(await deviceChallenge(async()=>({nonce:'local'}),params,true)).toEqual({nonce:'local'})
})
