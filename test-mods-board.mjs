// Minimal end-to-end test of the mods-board Worker logic using an in-memory KV.
// Run: node test-mods-board.mjs
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('./cloudflare-mods/worker/src/index.js', import.meta.url), 'utf8');
// The worker default-exports a fetch handler expecting (request, env) with env.MODS_KV.
const mod = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));

function makeKv() {
  const store = new Map();
  return {
    async get(key) { return store.has(key) ? store.get(key) : null; },
    async put(key, val) { store.set(key, val); },
    async delete(key) { store.delete(key); },
    _store: store,
  };
}

const env = { MODS_KV: makeKv(), ADMIN_TOKEN: 'sekret' };
const base = 'https://test.example.com';

async function call(method, path, { body, headers } = {}) {
  const init = { method, headers: headers || {} };
  if (body !== undefined) { init.headers['Content-Type'] = 'application/json'; init.body = typeof body === 'string' ? body : JSON.stringify(body); }
  const req = new Request(base + path, init);
  const res = await mod.default.fetch(req, env);
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, json };
}

let pass = 0, fail = 0;
function assert(cond, msg) { if (cond) { pass++; } else { fail++; console.error('FAIL:', msg); } }

// 1. Empty list
let r = await call('GET', '/api/mods');
assert(r.status === 200 && Array.isArray(r.json.entries) && r.json.entries.length === 0, 'empty list');

// 2. Publish a mod
const payload = {
  type: 'racing-custom-mod-share-v1',
  modId: 'custom-nitro',
  modName: 'Nitro Mod',
  author: 'Alex',
  description: 'Hold space for boost',
  xml: '<xml></xml>',
  template: 'export default {};',
};
r = await call('POST', '/api/mods', { body: payload });
assert(r.status === 200 && r.json.ok === true && r.json.entry?.modName === 'Nitro Mod', 'publish returns entry');
const modId = r.json.entry.id;
assert(!!modId, 'published mod has id');

// 3. Reject invalid payload type
r = await call('POST', '/api/mods', { body: { type: 'bogus' } });
assert(r.status === 400, 'reject non-share payload');

// 4. Reject missing template
r = await call('POST', '/api/mods', { body: { type: 'racing-custom-mod-share-v1', modId: 'x' } });
assert(r.status === 400, 'reject missing template');

// 5. List shows the mod
r = await call('GET', '/api/mods');
assert(r.json.entries.length === 1 && r.json.entries[0].modName === 'Nitro Mod', 'list shows published mod');

// 6. Get full mod (also bumps viewCount)
r = await call('GET', `/api/mods/${modId}`);
assert(r.status === 200 && r.json.ok && r.json.mod?.template === 'export default {};', 'get full mod');

// 7. viewCount incremented
r = await call('GET', '/api/mods');
assert(Number(r.json.entries[0].viewCount) === 1, 'viewCount incremented on get');

// 8. Install bump
r = await call('POST', `/api/mods/${modId}/install`);
assert(r.status === 200 && Number(r.json.entry?.installCount) === 1, 'install count bumped');

// 9. Vote up
r = await call('POST', `/api/mods/${modId}/vote`, { body: { vote: 1 } });
assert(r.status === 200 && Number(r.json.entry?.thumbsUp) === 1, 'thumbs up');

// 10. Vote down
r = await call('POST', `/api/mods/${modId}/vote`, { body: { vote: -1 } });
assert(r.status === 200 && Number(r.json.entry?.thumbsDown) === 1, 'thumbs down');

// 11. Reject invalid vote
r = await call('POST', `/api/mods/${modId}/vote`, { body: { vote: 5 } });
assert(r.status === 400, 'reject invalid vote');

// 12. Delete without token -> 401
r = await call('DELETE', `/api/mods/${modId}`);
assert(r.status === 401, 'delete requires admin token');

// 13. Delete with wrong token -> 401
r = await call('DELETE', `/api/mods/${modId}`, { headers: { 'X-Admin-Token': 'wrong' } });
assert(r.status === 401, 'delete wrong token 401');

// 14. Delete with correct token
r = await call('DELETE', `/api/mods/${modId}`, { headers: { 'X-Admin-Token': 'sekret' } });
assert(r.status === 200 && r.json.ok === true, 'delete with token');

// 15. Gone after delete
r = await call('GET', `/api/mods/${modId}`);
assert(r.status === 404, 'mod gone after delete');
r = await call('GET', '/api/mods');
assert(r.json.entries.length === 0, 'list empty after delete');

// 16. Invalid id rejected
r = await call('GET', '/api/mods/!@#');
assert(r.status === 400, 'invalid id rejected');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
