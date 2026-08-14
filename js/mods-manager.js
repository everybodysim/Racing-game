const INSTALLED_MODS_KEY = 'racing-installed-mods-v1';
const SHARED_KEY = 'racing-shared-custom-mods-v1';
const CUSTOM_MODS_ENABLED = true;
let currentCatalog = [];

// Community Custom Mods board API. Replace the host with your deployed Cloudflare
// Worker URL (see cloudflare-mods/README.md). When left as the placeholder or
// unreachable, the board panel shows a friendly "not connected yet" message and the
// rest of the Mod Manager keeps working normally.
const MODS_API_BASE = 'https://racing-mods-board-api.ga1010.workers.dev/api/mods';
const BOARD_VOTE_SESSION_KEY = 'modBoardVotes:v1';

import { compressString, compressJson, decompressJson } from './Storage.js';

// localStorage-compact custom-mod entry: LZW-compressed JS source prefixed `zjs:`.
// js/main.js rebuilds the importable `data:` URL at load time. Legacy base64
// `data:` entries keep working, so existing installs are never broken.
function toCompressedJsEntry(code) {
  return `zjs:${compressString(String(code || ''))}`;
}

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
function seedDefaultFreecamOnce() { try { if (localStorage.getItem(INSTALLED_MODS_KEY) === null) localStorage.setItem(INSTALLED_MODS_KEY, JSON.stringify([{ id: 'freecam', name: 'Freecam', entry: 'mods/Freecam.js' }])); } catch { /* ignore */ } }
function readInstalled() { try { seedDefaultFreecamOnce(); const p = JSON.parse(localStorage.getItem(INSTALLED_MODS_KEY) || '[]'); return Array.isArray(p) ? p : []; } catch { return []; } }

// Write the EXACT list given. Returns true only if it actually persisted to
// localStorage (so callers can avoid the "shows installed but gone after reload"
// lie — the UI must always re-render from readInstalled() after a write).
function saveInstalled(mods) {
  const list = Array.isArray(mods) ? mods.slice() : [];
  try { localStorage.setItem(INSTALLED_MODS_KEY, JSON.stringify(list)); return true; }
  catch (e) { return false; }
}

// Upsert a single mod by id (installing a new custom mod KEEPS any other custom
// mods — it no longer replaces them all). On a quota error, evict OLDER custom
// data-URL mods (never `mod` itself, which is what the user just asked to keep).
// Returns { ok, error? } so callers can show an honest failure message instead
// of falsely listing a mod that didn't persist.
function installMod(mod) {
  if (!mod || !mod.id) return { ok: false, error: 'Invalid mod' };
  let list = readInstalled().filter((m) => m.id !== mod.id);
  list.push(mod);
  try { localStorage.setItem(INSTALLED_MODS_KEY, JSON.stringify(list)); return { ok: true }; }
  catch (e) {
    for (let i = 0; i < list.length; ) {
      const m = list[i];
      const isOtherCustom = m && m.id !== mod.id && String(m.id).startsWith('custom-')
        && typeof m.entry === 'string' && (m.entry.startsWith('data:') || m.entry.startsWith('zjs:'));
      if (isOtherCustom) {
        list.splice(i, 1);
        try { localStorage.setItem(INSTALLED_MODS_KEY, JSON.stringify(list)); return { ok: true }; }
        catch { continue; }
      } else { i++; }
    }
    return { ok: false, error: 'Not enough browser storage for this mod. Remove other installed/shared mods and try again.' };
  }
}
function readSharedMods() { try { const p = decompressJson(localStorage.getItem(SHARED_KEY) || '[]', []); return Array.isArray(p) ? p : []; } catch { return []; } }
function saveSharedMods(mods) {
  // Same quota protection as saveInstalled: evict oldest shared payloads on overflow.
  let list = Array.isArray(mods) ? mods.slice() : [];
  for (;;) {
    try { localStorage.setItem(SHARED_KEY, compressJson(list)); return; }
    catch (e) {
      if (!list.length) throw e;
      list.shift();
    }
  }
}

function setInstallStatus(msg, kind) {
  const st = document.getElementById('install-status');
  if (!st) return;
  st.textContent = msg || '';
  st.classList.remove('ok', 'err');
  if (kind === 'ok') st.classList.add('ok');
  else if (kind === 'err') st.classList.add('err');
}
function emptyHint(text) {
  const li = document.createElement('li');
  li.className = 'empty';
  li.textContent = text;
  return li;
}
function renderInstalled(mods) {
  const list = document.getElementById('installed-list');
  list.innerHTML = '';
  if (!mods.length) { list.appendChild(emptyHint('No mods installed yet.')); return; }
  for (const mod of mods) {
    const li = document.createElement('li');
    li.className = 'item';
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = mod.name;
    const actions = document.createElement('div');
    actions.className = 'actions';
    const b = document.createElement('button');
    b.textContent = 'Remove';
    b.className = 'danger';
    b.onclick = () => { const n = readInstalled().filter((x) => x.id !== mod.id); saveInstalled(n); renderInstalled(n); renderCatalog(currentCatalog, n); };
    actions.appendChild(b);
    li.append(name, actions);
    list.appendChild(li);
  }
}
function renderCatalog(catalog, installed) {
  const list = document.getElementById('catalog-list');
  if (!list) return;
  list.innerHTML = '';
  if (!catalog.length) { list.appendChild(emptyHint('Could not load the mod catalog.')); return; }
  for (const mod of catalog) {
    const isInstalled = installed.some((e) => e.id === mod.id);
    const li = document.createElement('li');
    li.className = 'item';
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = mod.name;
    const actions = document.createElement('div');
    actions.className = 'actions';
    if (isInstalled) {
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = 'Installed';
      actions.appendChild(badge);
    } else {
      const inst = document.createElement('button');
      inst.textContent = 'Install';
      inst.className = 'primary';
      inst.onclick = () => { const res = installMod(mod); const actual = readInstalled(); renderInstalled(actual); renderCatalog(currentCatalog, actual); setInstallStatus(res.ok ? `${mod.name} installed.` : `Install failed: ${res.error || 'could not save to storage'}`, res.ok ? 'ok' : 'err'); };
      actions.appendChild(inst);
    }
    li.append(name, actions);
    list.appendChild(li);
  }
}
function renderShared(mods) {
  const list = document.getElementById('shared-mods-list');
  if (!list) return;
  list.innerHTML = '';
  if (!mods.length) { list.appendChild(emptyHint('No shared mods imported yet.')); return; }
  for (const mod of mods) {
    const li = document.createElement('li');
    li.className = 'item';
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = `${mod.modName || mod.modId} (${mod.modId})`;
    const actions = document.createElement('div');
    actions.className = 'actions';

    const install = document.createElement('button');
    install.textContent = 'Install';
    install.className = 'primary';
    install.title = 'Install this custom mod into the game';
    install.onclick = () => {
      const baseId = mod.modId || `custom-${Date.now()}`;
      const id = String(baseId).startsWith('custom-') ? String(baseId) : `custom-${baseId}`;
      let code = String(mod.template || '');
      if (!code.trim()) {
        code = `const SPEC = {};\nexport default { id: ${JSON.stringify(id)}, init(){}, applyFrame(){ return null; }, onCheckpoint(){}, onCrash(){}, onRespawn(){}, onLapFinish(){}, dispose(){} };\n`;
      }
      const res = installMod({ id, name: mod.modName || mod.modId || 'Custom Shared Mod', entry: toCompressedJsEntry(code) });
      // Always re-render from localStorage (source of truth) so the UI can never
      // list a mod that didn't actually persist.
      const actual = readInstalled();
      renderInstalled(actual);
      renderCatalog(currentCatalog, actual);
      setInstallStatus(res.ok ? `Installed "${mod.modName || mod.modId}". Reload the game to activate it.` : `Install failed: ${res.error || 'could not save to storage'}`, res.ok ? 'ok' : 'err');
    };

    const copy = document.createElement('button');
    copy.textContent = 'Copy JSON';
    copy.onclick = () => navigator.clipboard?.writeText(JSON.stringify(mod));

    const rm = document.createElement('button');
    rm.textContent = 'Delete';
    rm.className = 'danger';
    rm.onclick = () => { const n = readSharedMods().filter((x) => x.modId !== mod.modId); saveSharedMods(n); renderShared(n); };

    actions.append(install, copy, rm);
    li.append(name, actions);
    list.appendChild(li);
  }
}
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

// ============ COMMUNITY CUSTOM MODS BOARD ============
function boardReady() {
  return typeof MODS_API_BASE === 'string' && !/REPLACE_WITH_YOUR_WORKER_URL/.test(MODS_API_BASE);
}

async function boardApi(path = '', options = {}) {
  const res = await fetch(`${MODS_API_BASE}${path}`, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { throw new Error(`Bad response from server (HTTP ${res.status})`); }
  if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
  return data;
}

function loadBoardVotes() {
  try { return new Set(JSON.parse(sessionStorage.getItem(BOARD_VOTE_SESSION_KEY) || '[]')); }
  catch { return new Set(); }
}

function saveBoardVotes(set) {
  try { sessionStorage.setItem(BOARD_VOTE_SESSION_KEY, JSON.stringify([...set])); } catch { /* ignore */ }
}

function setBoardStatus(msg, kind) {
  const st = document.getElementById('board-status');
  if (!st) return;
  st.textContent = msg || '';
  st.classList.remove('ok', 'err');
  if (kind === 'ok') st.classList.add('ok');
  else if (kind === 'err') st.classList.add('err');
}

function fmtBoardDate(ms) {
  const t = Number(ms);
  if (!Number.isFinite(t)) return '';
  const diff = Date.now() - t;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return new Date(t).toLocaleDateString();
}

let boardEntries = [];
const boardVotedActions = loadBoardVotes();

function renderBoard(entries) {
  const list = document.getElementById('board-list');
  if (!list) return;
  list.innerHTML = '';
  if (!entries.length) {
    const li = document.createElement('li');
    li.className = 'board-empty';
    li.textContent = 'No community mods yet. Be the first to publish one!';
    list.appendChild(li);
    return;
  }
  for (const mod of entries) {
    const li = document.createElement('li');
    li.className = 'item';

    const main = document.createElement('div');
    main.style.flex = '1';
    main.style.minWidth = '0';

    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = mod.modName || mod.modId || 'Custom Mod';

    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = [
      mod.author ? `by ${mod.author}` : '',
      mod.modId ? `· ${mod.modId}` : '',
      fmtBoardDate(mod.createdAt),
    ].filter(Boolean).join(' ');

    main.append(name);
    if (mod.description) {
      const desc = document.createElement('div');
      desc.className = 'desc';
      desc.textContent = mod.description;
      main.appendChild(desc);
    }
    main.appendChild(meta);

    const actions = document.createElement('div');
    actions.className = 'actions';
    actions.style.flexDirection = 'column';
    actions.style.alignItems = 'stretch';
    actions.style.gap = '6px';

    const install = document.createElement('button');
    install.textContent = 'Install';
    install.className = 'primary';
    install.onclick = () => installBoardMod(mod, install);
    actions.appendChild(install);

    const counts = document.createElement('div');
    counts.className = 'votes';
    const installPill = document.createElement('span');
    installPill.className = 'count-pill';
    installPill.textContent = `↓ ${Number(mod.installCount) || 0} installs`;
    counts.appendChild(installPill);

    const up = document.createElement('button');
    up.textContent = `👍 ${Number(mod.thumbsUp) || 0}`;
    const down = document.createElement('button');
    down.textContent = `👎 ${Number(mod.thumbsDown) || 0}`;
    const voted = boardVotedActions.has(mod.id);
    if (voted) { up.disabled = true; down.disabled = true; }
    up.onclick = () => voteBoardMod(mod, 1, up, down, installPill);
    down.onclick = () => voteBoardMod(mod, -1, up, down, installPill);
    counts.append(up, down);
    actions.appendChild(counts);

    li.append(main, actions);
    list.appendChild(li);
  }
}

async function loadBoard() {
  const list = document.getElementById('board-list');
  if (!list) return;
  if (!boardReady()) {
    list.innerHTML = '';
    const li = document.createElement('li');
    li.className = 'board-empty';
    li.textContent = 'Community board not connected yet. See cloudflare-mods/README.md to set it up.';
    list.appendChild(li);
    return;
  }
  list.innerHTML = '';
  const li = document.createElement('li');
  li.className = 'board-empty';
  li.textContent = 'Loading community mods…';
  list.appendChild(li);
  try {
    const data = await boardApi('', { method: 'GET' });
    boardEntries = Array.isArray(data?.entries) ? data.entries : [];
    renderBoard(filterBoard(boardEntries));
  } catch (e) {
    list.innerHTML = '';
    const errLi = document.createElement('li');
    errLi.className = 'board-empty';
    errLi.textContent = `Could not load the board: ${e.message || e}`;
    list.appendChild(errLi);
  }
}

function filterBoard(entries) {
  const q = String(document.getElementById('board-search')?.value || '').trim().toLowerCase();
  if (!q) return entries;
  return entries.filter((m) =>
    String(m.modName || '').toLowerCase().includes(q) ||
    String(m.author || '').toLowerCase().includes(q) ||
    String(m.modId || '').toLowerCase().includes(q));
}

async function installBoardMod(mod, btn) {
  const prev = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = 'Installing…'; }
  try {
    const data = await boardApi(`/${encodeURIComponent(mod.id)}`, { method: 'GET' });
    const payload = data?.mod;
    if (!payload || payload.type !== 'racing-custom-mod-share-v1') throw new Error('Invalid mod data from server');
    const installId = payload.modId && String(payload.modId).startsWith('custom-') ? String(payload.modId) : `custom-${payload.modId}`;
    const code = String(payload.template || '').trim() || `const SPEC = {};\nexport default { id: ${JSON.stringify(installId)}, init(){}, applyFrame(){ return null; } };\n`;
    const res = installMod({ id: installId, name: payload.modName || payload.modId || 'Community Mod', entry: toCompressedJsEntry(code) });
    // Bump install counter (fire-and-forget; never blocks the install UX).
    boardApi(`/${encodeURIComponent(mod.id)}/install`, { method: 'POST' }).then((d) => {
      if (d?.entry) {
        const idx = boardEntries.findIndex((e) => e.id === mod.id);
        if (idx !== -1) { boardEntries[idx] = { ...boardEntries[idx], ...d.entry }; renderBoard(filterBoard(boardEntries)); }
      }
    }).catch(() => {});
    const actual = readInstalled();
    renderInstalled(actual);
    renderCatalog(currentCatalog, actual);
    setBoardStatus(res.ok ? `Installed "${payload.modName || payload.modId}". Reload the game to activate it.` : `Install failed: ${res.error || 'could not save to storage'}`, res.ok ? 'ok' : 'err');
  } catch (e) {
    setBoardStatus(`Could not install: ${e.message || e}`, 'err');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = prev; }
  }
}

async function voteBoardMod(mod, vote, upBtn, downBtn, installPill) {
  if (boardVotedActions.has(mod.id)) return;
  upBtn.disabled = true; downBtn.disabled = true;
  try {
    const data = await boardApi(`/${encodeURIComponent(mod.id)}/vote`, { method: 'POST', body: JSON.stringify({ vote }) });
    if (data?.entry) {
      const idx = boardEntries.findIndex((e) => e.id === mod.id);
      if (idx !== -1) { boardEntries[idx] = { ...boardEntries[idx], ...data.entry }; }
      boardVotedActions.add(mod.id);
      saveBoardVotes(boardVotedActions);
      renderBoard(filterBoard(boardEntries));
    } else {
      upBtn.disabled = false; downBtn.disabled = false;
    }
  } catch (e) {
    upBtn.disabled = false; downBtn.disabled = false;
    setBoardStatus(`Vote failed: ${e.message || e}`, 'err');
  }
}

function populateBoardPublishSource() {
  const sel = document.getElementById('board-publish-source');
  if (!sel) return;
  const saved = readSharedMods();
  // Keep the leading placeholder option, rebuild the rest.
  while (sel.options.length > 1) sel.remove(1);
  for (const m of saved) {
    const opt = document.createElement('option');
    opt.value = JSON.stringify(m);
    opt.textContent = `${m.modName || m.modId} (${m.modId})`;
    sel.appendChild(opt);
  }
}

function resolvePublishPayload() {
  const paste = String(document.getElementById('board-paste')?.value || '').trim();
  if (paste) return parseSharedInput(paste);
  const sel = document.getElementById('board-publish-source');
  const val = String(sel?.value || '').trim();
  if (val) return JSON.parse(val);
  throw new Error('Pick a saved mod or paste a share URL/JSON first.');
}

async function publishToBoard() {
  if (!boardReady()) return setBoardStatus('Community board not connected yet. See cloudflare-mods/README.md.', 'err');
  let payload;
  try { payload = resolvePublishPayload(); }
  catch (e) { return setBoardStatus(e.message || e, 'err'); }
  if (payload.type !== 'racing-custom-mod-share-v1') return setBoardStatus('That is not a valid custom mod share payload.', 'err');
  const author = String(document.getElementById('board-author')?.value || '').trim();
  const description = String(document.getElementById('board-desc')?.value || '').trim();
  const body = { ...payload, author, description };
  const btn = document.getElementById('board-publish-btn');
  const prev = btn?.textContent;
  if (btn) { btn.disabled = true; btn.textContent = 'Publishing…'; }
  try {
    const data = await boardApi('', { method: 'POST', body: JSON.stringify(body) });
    setBoardStatus(`Published "${data?.entry?.modName || payload.modName}" to the board.`, 'ok');
    const pasteEl = document.getElementById('board-paste');
    if (pasteEl) pasteEl.value = '';
    await loadBoard();
  } catch (e) {
    setBoardStatus(`Could not publish: ${e.message || e}`, 'err');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = prev; }
  }
}

(async function init(){
  const installBtn=document.getElementById('install-btn'); const nameInput=document.getElementById('mod-name');
  if (CUSTOM_MODS_ENABLED) setInstallStatus('Custom mods are enabled. Import or install a shared Blockly mod to use it in-game.');
  let catalog=[]; try{catalog=await loadCatalog(); currentCatalog=catalog;}catch(e){ setInstallStatus(e.message, 'err'); }
  let installed=readInstalled(); renderInstalled(installed); renderCatalog(catalog,installed); renderShared(readSharedMods());
  installBtn?.addEventListener('click',()=>{ const mod=findModByName(catalog,nameInput?.value); if(!mod) return setInstallStatus('Mod not found. Type a name from the catalog below.', 'err'); const res=installMod(mod); installed=readInstalled(); renderInstalled(installed); renderCatalog(catalog,installed); setInstallStatus(res.ok ? `${mod.name} installed.` : `Install failed: ${res.error||'could not save to storage'}`, res.ok ? 'ok' : 'err'); });
  document.getElementById('import-shared-btn')?.addEventListener('click',()=>{ try{ const payload=parseSharedInput(document.getElementById('shared-mod-input')?.value); if(payload.type!=='racing-custom-mod-share-v1') throw new Error('Invalid payload type'); const all=readSharedMods().filter((x)=>x.modId!==payload.modId); all.push(payload); saveSharedMods(all); renderShared(all); populateBoardPublishSource(); setInstallStatus(`Imported shared mod ${payload.modName||payload.modId}`, 'ok'); }catch(e){ setInstallStatus(`Import failed: ${e.message}`, 'err'); }});
  nameInput?.addEventListener('keydown',(e)=>{ if(e.key==='Enter'){ e.preventDefault(); installBtn?.click(); } });

  // Community board wiring.
  populateBoardPublishSource();
  loadBoard();
  document.getElementById('board-refresh')?.addEventListener('click', () => loadBoard());
  document.getElementById('board-search')?.addEventListener('input', () => renderBoard(filterBoard(boardEntries)));
  document.getElementById('board-publish-btn')?.addEventListener('click', () => publishToBoard());
  document.getElementById('board-publish-source')?.addEventListener('change', () => { const p = document.getElementById('board-paste'); if (p) p.value = ''; });
})();
