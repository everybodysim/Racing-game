const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS', 'access-control-allow-headers': 'content-type,x-owner-username,x-actor-username' }
});

const normalize = (value) => String(value || '').trim();
const keyify = (value) => normalize(value).toLowerCase();
const nowIso = () => new Date().toISOString();
const id = (prefix = 'id') => `${prefix}_${crypto.randomUUID()}`;

async function getJson(kv, key, fallback) {
  const raw = await kv.get(key);
  return raw ? JSON.parse(raw) : fallback;
}

async function saveJson(kv, key, data) {
  await kv.put(key, JSON.stringify(data));
}

async function loadClub(env, clubId) {
  return getJson(env.CLUBS_KV, `club:${clubId}`, null);
}

function ownerOnly(club, actorName) {
  return keyify(club.ownerUsername) === keyify(actorName);
}

async function appendHistory(env, clubId, stream, message) {
  const key = `club:${clubId}:chat:${stream}`;
  const history = await getJson(env.CLUBS_KV, key, []);
  history.push(message);
  while (history.length > 15) history.shift();
  await saveJson(env.CLUBS_KV, key, history);
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return json({ ok: true });
    const url = new URL(request.url);
    try {
      if (request.method === 'GET' && url.pathname === '/clubs') {
        const ids = await getJson(env.CLUBS_KV, 'clubs:index', []);
        const clubs = [];
        for (const clubId of ids) {
          const club = await loadClub(env, clubId);
          if (club) clubs.push(club);
        }
        return json({ clubs });
      }

      if (request.method === 'POST' && url.pathname === '/clubs') {
        const body = await request.json();
        const displayName = normalize(body.displayName);
        const ownerUsername = normalize(body.ownerUsername);
        if (!displayName || !ownerUsername) return json({ error: 'displayName and ownerUsername required' }, 400);
        const nameIndex = await getJson(env.CLUBS_KV, 'clubs:name-index', {});
        const nameKey = keyify(displayName);
        if (nameIndex[nameKey]) return json({ error: 'Club name already exists' }, 409);
        const clubId = id('club');
        const club = { clubId, displayName, ownerUsername, members: [ownerUsername], mutedMembers: [], createdAt: nowIso(), settings: { public: body?.public !== false, inviteOnly: false }, description: body?.description || '' };
        nameIndex[nameKey] = clubId;
        const ids = await getJson(env.CLUBS_KV, 'clubs:index', []);
        ids.push(clubId);
        await Promise.all([
          saveJson(env.CLUBS_KV, 'clubs:name-index', nameIndex),
          saveJson(env.CLUBS_KV, 'clubs:index', ids),
          saveJson(env.CLUBS_KV, `club:${clubId}`, club)
        ]);
        return json({ club }, 201);
      }

      const clubMatch = url.pathname.match(/^\/clubs\/([^/]+)(?:\/(.*))?$/);
      if (!clubMatch) return json({ error: 'Not found' }, 404);
      const clubId = clubMatch[1];
      const action = clubMatch[2] || '';
      const club = await loadClub(env, clubId);
      if (!club) return json({ error: 'Club not found' }, 404);

      if (request.method === 'GET' && action === '') return json({ club });
      if (request.method === 'GET' && action === 'messages') {
        const normal = await getJson(env.CLUBS_KV, `club:${clubId}:chat:normal`, []);
        const owner = await getJson(env.CLUBS_KV, `club:${clubId}:chat:owner`, []);
        return json({ normal, owner });
      }

      if (request.method === 'POST' && action === 'members') {
        const actor = request.headers.get('x-actor-username') || '';
        if (!ownerOnly(club, actor)) return json({ error: 'Owner only action' }, 403);
        const body = await request.json();
        const username = normalize(body.username);
        if (!username) return json({ error: 'username required' }, 400);
        if (!club.members.find((m) => keyify(m) === keyify(username))) club.members.push(username);
        await saveJson(env.CLUBS_KV, `club:${clubId}`, club);
        return json({ club });
      }
      if (request.method === 'POST' && action === 'kick') {
        const actor = request.headers.get('x-actor-username') || '';
        if (!ownerOnly(club, actor)) return json({ error: 'Owner only action' }, 403);
        const body = await request.json();
        const username = keyify(body.username);
        club.members = club.members.filter((m) => keyify(m) !== username);
        club.mutedMembers = club.mutedMembers.filter((m) => keyify(m) !== username);
        await saveJson(env.CLUBS_KV, `club:${clubId}`, club);
        return json({ club });
      }
      if (request.method === 'POST' && action === 'mute') {
        const actor = request.headers.get('x-actor-username') || '';
        if (!ownerOnly(club, actor)) return json({ error: 'Owner only action' }, 403);
        const body = await request.json();
        const username = normalize(body.username);
        if (!club.mutedMembers.find((m) => keyify(m) === keyify(username))) club.mutedMembers.push(username);
        await saveJson(env.CLUBS_KV, `club:${clubId}`, club);
        return json({ club });
      }
      if (request.method === 'POST' && action === 'transfer') {
        const actor = request.headers.get('x-actor-username') || '';
        if (!ownerOnly(club, actor)) return json({ error: 'Owner only action' }, 403);
        const body = await request.json();
        const username = normalize(body.username);
        if (!club.members.find((m) => keyify(m) === keyify(username))) return json({ error: 'New owner must be a member' }, 400);
        club.ownerUsername = username;
        await saveJson(env.CLUBS_KV, `club:${clubId}`, club);
        return json({ club });
      }
      if (request.method === 'POST' && action === 'rename') {
        const actor = request.headers.get('x-actor-username') || '';
        if (!ownerOnly(club, actor)) return json({ error: 'Owner only action' }, 403);
        const body = await request.json();
        const newName = normalize(body.displayName);
        if (!newName) return json({ error: 'displayName required' }, 400);
        const nameIndex = await getJson(env.CLUBS_KV, 'clubs:name-index', {});
        const newKey = keyify(newName);
        if (nameIndex[newKey] && nameIndex[newKey] !== clubId) return json({ error: 'Club name already exists' }, 409);
        delete nameIndex[keyify(club.displayName)];
        nameIndex[newKey] = clubId;
        club.displayName = newName;
        await Promise.all([saveJson(env.CLUBS_KV, 'clubs:name-index', nameIndex), saveJson(env.CLUBS_KV, `club:${clubId}`, club)]);
        return json({ club });
      }
      if (request.method === 'DELETE' && action === '') {
        const actor = request.headers.get('x-actor-username') || '';
        if (!ownerOnly(club, actor)) return json({ error: 'Owner only action' }, 403);
        const ids = (await getJson(env.CLUBS_KV, 'clubs:index', [])).filter((id) => id !== clubId);
        const nameIndex = await getJson(env.CLUBS_KV, 'clubs:name-index', {});
        delete nameIndex[keyify(club.displayName)];
        await Promise.all([
          saveJson(env.CLUBS_KV, 'clubs:index', ids), saveJson(env.CLUBS_KV, 'clubs:name-index', nameIndex),
          env.CLUBS_KV.delete(`club:${clubId}`), env.CLUBS_KV.delete(`club:${clubId}:chat:normal`), env.CLUBS_KV.delete(`club:${clubId}:chat:owner`)
        ]);
        return json({ ok: true });
      }
      if (request.method === 'POST' && action === 'messages') {
        const actor = normalize(request.headers.get('x-actor-username') || '');
        if (!actor) return json({ error: 'Account username required' }, 401);
        const body = await request.json();
        const stream = body.stream === 'owner' ? 'owner' : 'normal';
        const content = normalize(body.content);
        if (!content) return json({ error: 'content required' }, 400);
        const isMember = club.members.find((m) => keyify(m) === keyify(actor));
        if (!isMember) return json({ error: 'Only club members can post' }, 403);
        if (club.mutedMembers.find((m) => keyify(m) === keyify(actor))) return json({ error: 'Muted member' }, 403);
        if (stream === 'owner' && !ownerOnly(club, actor)) return json({ error: 'Only owner can post announcements' }, 403);
        const message = { messageId: id('msg'), username: actor, content, timestamp: nowIso() };
        await appendHistory(env, clubId, stream, message);
        return json({ ok: true, message });
      }

      return json({ error: 'Unsupported route' }, 404);
    } catch (error) {
      return json({ error: error.message || 'Server error' }, 500);
    }
  }
};
