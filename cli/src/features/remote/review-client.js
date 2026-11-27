// Standalone review document. Never poll: keep the reviewed snapshot until Refresh.
const el = id => document.getElementById(id), params = new URLSearchParams(location.search);
const terminal = params.get('terminal'), dark = params.get('theme') === 'dark';
document.documentElement.dataset.theme = dark ? 'dark' : 'light';
let split = matchMedia('(min-width: 850px)').matches, snapshot;
// Import only passive diff layout nodes. Repository content cannot supply links,
// attributes, scripts, interactive controls or external resources to this page.
function diffFragment(markup) {
  const template = document.createElement('template'); template.innerHTML = markup;
  const allowed = new Set(['DIV','SPAN','TABLE','TBODY','TR','TD','INS','DEL','CODE','PRE']);
  for (const node of template.content.querySelectorAll('*')) {
    if (!allowed.has(node.tagName)) { node.remove(); continue; }
    for (const attr of [...node.attributes]) if (attr.name !== 'class') node.removeAttribute(attr.name);
    if (node.classList.contains('d2h-file-header')) node.remove();
  }
  return template.content;
}
function paint() {
  const files = el('files'), jump = el('jump'); files.replaceChildren(); jump.replaceChildren(new Option('Files ('+snapshot.files.length+')',''));
  jump.hidden = snapshot.files.length < 2; el('layout').hidden = !snapshot.files.some(f=>f.unified);
  el('count').textContent = `${snapshot.files.length} ${snapshot.files.length === 1 ? 'file' : 'files'}`;
  el('unified').setAttribute('aria-pressed',String(!split)); el('split').setAttribute('aria-pressed',String(split));
  el('folder').textContent = [snapshot.folder,snapshot.branch].filter(Boolean).join(' · ');
  el('message').textContent = snapshot.message || (snapshot.files.length ? '' : 'Working tree clean.');
  for (const [i,file] of snapshot.files.entries()) {
    const row = document.createElement('details'), title = document.createElement('summary'); row.open = true;
    const name = document.createElement('span'), badge = document.createElement('span');
    name.className = 'filename'; name.textContent = file.name;
    badge.className = 'status'; badge.dataset.kind = file.status; badge.textContent = ({'?':'New',A:'Added',M:'Modified',D:'Deleted',R:'Renamed',T:'Type changed'})[file.status] || file.status;
    title.append(name,badge); row.append(title);
    if (file.unified) row.append(diffFragment(split ? file.split : file.unified));
    else { const note = document.createElement('p'); note.className='note'; note.textContent=file.note; row.append(note); }
    files.append(row); jump.add(new Option(file.name,String(i)));
  }
}
async function refresh() {
  el('refresh').disabled = true; el('message').textContent = 'Loading changes…';
  try {
    const token = sessionStorage.getItem('evot.remote'); if (!token || !terminal) throw Error('Open Changes from a connected chat.');
    const r = await fetch('/changes/snapshot',{headers:{Authorization:'Bearer '+token,'X-Evot-Terminal':terminal},cache:'no-store',signal:AbortSignal.timeout(20000)});
    if (!r.ok) {
      if ([401,403,409].includes(r.status)) { snapshot=null; el('files').replaceChildren(); el('jump').hidden=el('layout').hidden=true; }
      throw Error(r.status===404 ? 'Update the selected evot window to review changes.' : r.status===401 ? 'Reconnect in chat to review changes.' : 'Changes unavailable. Return to chat or try again.');
    }
    snapshot = await r.json(); paint();
  } catch(e) { el('message').textContent=e.message || 'Could not refresh changes.'; }
  finally { el('refresh').disabled=false; }
}
el('refresh').onclick=refresh;
el('jump').onchange=e=>{if(e.target.value!==''){const row=el('files').children[Number(e.target.value)];row.open=true;row.scrollIntoView();e.target.value='';}};
for (const id of ['unified','split']) el(id).onclick=()=>{
  if (split === (id==='split')) return;
  const rows = [...el('files').children], collapsed = rows.map(row=>!row.open);
  split=id==='split';paint(); collapsed.forEach((closed,i)=>{if(closed)el('files').children[i].open=false;});
};
el('back').onclick=()=>{if(parent!==window)parent.postMessage('evot-close-changes', location.origin);else location.assign('/');};
void refresh();
