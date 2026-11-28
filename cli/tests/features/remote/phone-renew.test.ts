import {expect, test} from 'bun:test'
import {deviceChallenge} from '../../../src/features/remote/phone-renew.js'

const params = {key:'device', terminal:'window', ticket:null}, auth = {login:'https://account/connect', renew:'https://account/connect/renew'}
test('silent reconnect gets a fresh account ticket and repeats only the challenge, for the same device and window', async () => {
  const calls:unknown[] = []
  const post = async (path:string, data:typeof params) => { calls.push([path,data]); return data.ticket ? {nonce:'new'} : auth }
  const result = await deviceChallenge(post,params,true,async (url:string, init:RequestInit) => {
    expect(url).toBe(auth.renew)
    expect(init).toMatchObject({method:'POST',credentials:'include',redirect:'error',cache:'no-store'})
    return Response.json({ticket:'fresh'})
  })
  expect(result).toEqual({nonce:'new'})
  expect(calls).toEqual([['/device/challenge',params],['/device/challenge',{...params,ticket:'fresh'}]])
})
test('background attempts never return a navigation on signed-out, older, denied or offline servers', async () => {
  for (const [status, reason] of [[401,{signIn:true}],[403,{status:403}],[503,{status:503}]] as const)
    await expect(deviceChallenge(async()=>auth,params,true,async()=>new Response(null,{status}))).rejects.toMatchObject(reason)
  await expect(deviceChallenge(async()=>({login:auth.login}),params,true)).rejects.toMatchObject({signIn:true})
  await expect(deviceChallenge(async()=>auth,params,true,async()=>{throw TypeError('offline')})).rejects.toThrow('offline')
  expect(await deviceChallenge(async()=>auth,params,false)).toEqual(auth) // explicit sign-in retains the redirect flow
  expect(await deviceChallenge(async()=>({nonce:'local'}),params,true)).toEqual({nonce:'local'})
})
