const INSTALLED_MODS_KEY = 'racing-installed-mods-v1';
const SHARED_KEY = 'racing-shared-custom-mods-v1';
const CUSTOM_MODS_ENABLED = true;
let currentCatalog = [];

function toBase64JsDataUrl(code) {
  const bytes = new TextEncoder().encode(String(code || ''));
  let bin = '';
  bytes.forEach((b) => { bin += String.fromCharCode(b); });
  return `data:text/javascript;base64,${btoa(bin)}`;
}

function fromBase64Url(raw) {
  const norm = String(raw || '').replace(/-/g, '+').replace(/_/g, '/');
  const padded = norm + '==='.slice((norm.length + 3) % 4);
  const bin = atob(padded);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}


async function loadCatalog() { const r = await fetch('./mods/mods.json', { cache: 'no-store' }); if (!r.ok) throw new Error('Failed to load mod catalog'); const p = await r.json(); return Array.isArray(p?.mods) ? p.mods : []; }
function readInstalled() { try { const p = JSON.parse(localStorage.getItem(INSTALLED_MODS_KEY) || '[]'); const list = Array.isArray(p) ? p : []; if (!list.some((m) => m?.id === 'freecam')) list.push({ id: 'freecam', name: 'Freecam', entry: 'mods/Freecam.js' }); return list; } catch { return []; } }
function saveInstalled(mods) { localStorage.setItem(INSTALLED_MODS_KEY, JSON.stringify(mods)); }
function readSharedMods() { try { const p = JSON.parse(localStorage.getItem(SHARED_KEY) || '[]'); return Array.isArray(p) ? p : []; } catch { return []; } }
function saveSharedMods(mods) { localStorage.setItem(SHARED_KEY, JSON.stringify(mods)); }

function renderInstalled(mods) { const list = document.getElementById('installed-list'); list.innerHTML=''; for (const mod of mods){ const li=document.createElement('li'); li.textContent=mod.name; const b=document.createElement('button'); b.textContent='Remove'; b.style.marginLeft='8px'; b.onclick=()=>{const n=readInstalled().filter((x)=>x.id!==mod.id); saveInstalled(n); renderInstalled(n); renderCatalog(currentCatalog,n);}; li.appendChild(b); list.appendChild(li);} }
function renderCatalog(catalog, installed) { const list=document.getElementById('catalog-list'); if(!list) return; list.innerHTML=''; for(const mod of catalog){ const li=document.createElement('li'); li.textContent=`${mod.name}${installed.some((e)=>e.id===mod.id)?' — Installed':''}`; list.appendChild(li);} }
function renderShared(mods) { const list=document.getElementById('shared-mods-list'); if(!list) return; list.innerHTML=''; for(const mod of mods){ const li=document.createElement('li'); li.textContent=`${mod.modName||mod.modId} (${mod.modId})`; const install=document.createElement('button'); install.textContent='Install'; install.style.marginLeft='8px'; install.disabled=false; install.title='Install this custom mod into the game'; install.onclick=()=>{ try { let code = String(mod.template||''); if(!code.trim()){ // Fallback for shared mods saved without a template: emit a no-op runtime so install never breaks.
 code = `const SPEC = {};\nexport default { id: ${JSON.stringify('custom-'+(mod.modId||Date.now()))}, init(){}, applyFrame(){ return null; }, onCheckpoint(){}, onCrash(){}, onRespawn(){}, onLapFinish(){}, dispose(){} };\n`; } const installed = readInstalled(); const id = `custom-${mod.modId||Date.now()}`; const next = installed.filter((m)=>m.id!==id); next.push({ id, name: mod.modName||mod.modId||'Custom Shared Mod', entry: toBase64JsDataUrl(code) }); saveInstalled(next); renderInstalled(next); renderCatalog(currentCatalog,next); const st=document.getElementById('install-status'); if(st) st.textContent=`Installed "${mod.modName||mod.modId}". Reload the game to activate it.`; } catch(e){ const st=document.getElementById('install-status'); if(st) st.textContent=`Install failed: ${e.message||e}`; } }; const copy=document.createElement('button'); copy.textContent='Copy JSON'; copy.style.marginLeft='8px'; copy.onclick=()=>navigator.clipboard?.writeText(JSON.stringify(mod)); const rm=document.createElement('button'); rm.textContent='Delete'; rm.style.marginLeft='8px'; rm.onclick=()=>{const n=readSharedMods().filter((x)=>x.modId!==mod.modId); saveSharedMods(n); renderShared(n);}; li.append(install,copy,rm); list.appendChild(li);} }
function findModByName(catalog, query) { const q=String(query||'').trim().toLowerCase(); if(!q) return null; return catalog.find((e)=>[e.name,e.id,e.folder].filter(Boolean).some((v)=>String(v).toLowerCase()===q))||null; }

function parseSharedInput(raw) {
  const txt = String(raw || '').trim();
  if (!txt) throw new Error('No input provided');
  if (txt.startsWith('{')) return JSON.parse(txt);
  const url = new URL(txt);
  const share = url.searchParams.get('share');
  if (!share) throw new Error('No share param in URL');
  return JSON.parse(fromBase64Url(share));
}

(async function init(){
  const installBtn=document.getElementById('install-btn'); const nameInput=document.getElementById('mod-name'); const status=document.getElementById('install-status');
  if (CUSTOM_MODS_ENABLED) status.textContent='Custom mods are enabled. Import or install a shared Blockly mod to use it in-game.';
  let catalog=[]; try{catalog=await loadCatalog(); currentCatalog=catalog;}catch(e){status.textContent=e.message;}
  let installed=readInstalled(); renderInstalled(installed); renderCatalog(catalog,installed); renderShared(readSharedMods());
  installBtn?.addEventListener('click',()=>{ const mod=findModByName(catalog,nameInput?.value); if(!mod) return status.textContent='Mod not found.'; if(installed.some((e)=>e.id===mod.id)) return status.textContent='Already installed'; installed=[...installed,mod]; saveInstalled(installed); renderInstalled(installed); renderCatalog(catalog,installed); status.textContent=`${mod.name} installed.`; });
  document.getElementById('import-shared-btn')?.addEventListener('click',()=>{ try{ const payload=parseSharedInput(document.getElementById('shared-mod-input')?.value); if(payload.type!=='racing-custom-mod-share-v1') throw new Error('Invalid payload type'); const all=readSharedMods().filter((x)=>x.modId!==payload.modId); all.push(payload); saveSharedMods(all); renderShared(all); status.textContent=`Imported shared mod ${payload.modName||payload.modId}`;}catch(e){ status.textContent=`Import failed: ${e.message}`; }});
})();
