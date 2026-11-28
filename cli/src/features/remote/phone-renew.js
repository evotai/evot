// Refresh account attestation, not the page. The gateway still requires the signed
// challenge and the computer's device grant; the account cookie never goes to it.
export async function deviceChallenge(post, params, background, request = fetch) {
  const challenge = data => post('/device/challenge', data);
  const first = await challenge(params);
  if (!background || !first.login) return first;
  const signIn = () => Object.assign(Error('Sign in to reconnect.'), {signIn:true});
  if (!first.renew) throw signIn(); // Older account server: wait for a user gesture.
  const r = await request(first.renew, {method:'POST', credentials:'include', redirect:'error', cache:'no-store', signal:AbortSignal.timeout(15000)});
  if (r.status === 401) throw signIn();
  if (!r.ok) throw Object.assign(Error(r.status === 403 ? 'Remote access denied.' : 'Could not verify account.'), {status:r.status});
  const {ticket} = await r.json();
  if (!ticket) throw Error('Missing account verification.');
  const next = await challenge({...params, ticket});
  if (next.login) throw signIn(); // Never navigate during a background attempt.
  return next;
}
