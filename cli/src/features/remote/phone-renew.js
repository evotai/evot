// Refresh account attestation, not the page. The gateway still requires the signed
// challenge and the computer's device grant; the account cookie never goes to it.
export async function deviceChallenge(post, params, background, request = fetch, progress = () => {}) {
  const challenge = data => { progress('challenge'); return post('/device/challenge', data); };
  const first = await challenge(params);
  if (!background || !first.login || !first.renew) return first;
  progress('renew');
  const r = await request(first.renew, {method:'POST', credentials:'include', redirect:'error', cache:'no-store', signal:AbortSignal.timeout(15000)});
  if (r.status === 401) return first; // Signed out: use the gateway's interactive login URL.
  if (!r.ok) throw Object.assign(Error(r.status === 403 ? 'Remote access denied.' : 'Could not verify account.'), {status:r.status});
  const {ticket} = await r.json();
  if (!ticket) throw Error('Missing account verification.');
  return challenge({...params, ticket});
}
