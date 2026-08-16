// Multiplayer Servers Worker (Cloudflare Worker + KV).
//
// Authoritative backend for the Skid Circuit multiplayer *server browser* layer.
// Sits ON TOP of the existing networking (PeerJS/WebRTC + Firebase Realtime
// Database room signaling) — it does NOT replace it. This worker owns:
//
//   1. PERMANENT server definitions (owner, name, settings) — KV-persisted.
//   2. ACTIVE SESSION presence (live "room" metadata + heartbeat) — ephemeral,
//      garbage-collected by heartbeat timeout.
//   3. SERVER CHAT history (last N messages per server) — KV-persisted.
//
// It deliberately does NOT store live WebRTC connection state. The actual
// peer connection is still established PeerJS<->PeerJS using a room code, and
// Firebase still carries per-room player positions / lap times. This worker
// only tracks *which servers exist* and *who is currently inside them* so the
// browser can list servers and enforce capacity/ownership.
//
// ID allocation is SERVER-AUTHORITATIVE and sequential (1, 2, 3, ... first free).
// The client never chooses a server ID. Allocation uses a KV counter with a
// verify-on-conflict retry loop: read counter → probe server:<id> → if absent,
// claim it and bump the counter; otherwise advance and retry. KV is eventually
// consistent across edge regions, so two near-simultaneous creations could in
// principle probe the same free id; the final PUT of server:<id> is last-writer
// wins. To make collisions harmless, creation always (a) re-reads server:<id>
// immediately before writing and (b) the counter is bumped to id+1 only after a
// successful write. In the rare double-claim case the second writer's re-read
// will see the first writer's record and it will advance to the next id. This is
// the strongest atomicity available on plain KV without Durable Objects, and is
// behaviour-identical to the existing accounts/clubs/leaderboard workers (which
// also use KV only). Introducing Durable Objects would be a destructive infra
// change incompatible with the repo's deployment model.

const SERVER_KEY_PREFIX = 'server:';
const SESSION_KEY_PREFIX = 'session:';
const SERVERS_INDEX_KEY = 'servers:index';
const SERVERS_COUNTER_KEY = 'servers:counter';
const SESSIONS_INDEX_KEY = 'sessions:index';
const OWNER_KEY_PREFIX = 'servers:owner:';
const SERVER_CHAT_KEY_PREFIX = 'server:chat:';

const SESSION_HEARTBEAT_TTL_MS = 60 * 1000;          // a session is stale after 60s without a heartbeat
const SESSION_GC_PROBABILITY = 0.25;                  // opportunistically GC stale sessions on list/join
const MAX_SERVER_NAME_LENGTH = 40;
const MIN_SERVER_NAME_LENGTH = 1;
const MAX_CHAT_HISTORY = 50;
const MAX_CHAT_MESSAGE_LENGTH = 300;
const DEFAULT_MAX_PLAYERS = 8;
const HARD_MAX_PLAYERS = 16;
const MAX_SERVERS_LISTED = 200;
const MAX_RENAME_PER_WINDOW = 5;
const RENAME_WINDOW_MS = 60 * 1000;

// The accounts worker is the single source of truth for authentication. We
// verify the caller's token by calling its /api/accounts/profile endpoint rather
// than duplicating password hashing here. This keeps one auth system.
const ACCOUNTS_PROFILE_URL = 'https://racing-account-api.ga1010.workers.dev/api/accounts/profile';

export default {
	async fetch( request, env ) {
		if ( request.method === 'OPTIONS' ) return withCors( new Response( null, { status: 204 } ) );
		const url = new URL( request.url );

		try {
			// ---- Permanent server definitions ----
			if ( url.pathname === '/api/servers/permanent' && request.method === 'GET' ) {
				return withCors( await listPermanentServers( env ) );
			}
			if ( url.pathname === '/api/servers/permanent' && request.method === 'POST' ) {
				return withCors( await createPermanentServer( request, env ) );
			}

			// ---- Active (temporary + permanent) sessions ----
			if ( url.pathname === '/api/servers/temporary' && request.method === 'GET' ) {
				return withCors( await listActiveSessions( env, 'temporary' ) );
			}
			if ( url.pathname === '/api/servers/temporary' && request.method === 'POST' ) {
				return withCors( await createTemporarySession( request, env ) );
			}
			if ( url.pathname === '/api/servers/sessions' && request.method === 'GET' ) {
				return withCors( await listActiveSessions( env, null ) );
			}

			// ---- Per-server routes ----
			const serverMatch = url.pathname.match( /^\/api\/servers\/(\d+)(?:\/(.*))?$/ );
			if ( serverMatch ) {
				const serverId = Number( serverMatch[ 1 ] );
				const action = serverMatch[ 2 ] || '';
				if ( request.method === 'GET' && action === '' ) return withCors( await getServer( env, serverId ) );
				if ( request.method === 'POST' && action === 'join' ) return withCors( await joinSession( request, env, serverId ) );
				if ( request.method === 'POST' && action === 'heartbeat' ) return withCors( await heartbeatSession( request, env, serverId ) );
				if ( request.method === 'POST' && action === 'leave' ) return withCors( await leaveSession( request, env, serverId ) );
				if ( request.method === 'POST' && action === 'rehost' ) return withCors( await rehostSession( request, env, serverId ) );
				if ( request.method === 'POST' && action === 'rename' ) return withCors( await renamePermanentServer( request, env, serverId ) );
				if ( request.method === 'DELETE' && action === '' ) return withCors( await deletePermanentServer( request, env, serverId ) );
				if ( request.method === 'GET' && action === 'chat' ) return withCors( await getServerChat( env, serverId ) );
				if ( request.method === 'POST' && action === 'chat' ) return withCors( await postServerChat( request, env, serverId ) );
			}

			return withCors( json( { ok: false, error: 'Not found' }, 404 ) );
		} catch ( error ) {
			return withCors( json( { ok: false, error: String( error?.message || error || 'Server error' ) }, 500 ) );
		}
	},
};

// ===========================================================================
// Permanent server definitions
// ===========================================================================

async function listPermanentServers( env ) {
	const ids = await getJson( env, SERVERS_INDEX_KEY, [] );
	const out = [];
	for ( const id of ids.slice( 0, MAX_SERVERS_LISTED ) ) {
		const def = await loadServerDef( env, id );
		if ( def ) {
			// Attach live session summary so the browser can show "online now".
			const session = await loadSession( env, id );
			out.push( summarizeServer( def, session ) );
		}
	}
	out.sort( sortServers );
	return json( { ok: true, servers: out } );
}

async function createPermanentServer( request, env ) {
	const body = await parseJsonBody( request );
	if ( ! body.ok ) return body.response;
	const token = String( body.value?.token || '' ).trim();
	const owner = await resolveAccountUsername( token );
	if ( ! owner.usernameKey ) return json( { ok: false, error: 'Authentication required to create a permanent server' }, 401 );

	const name = sanitizeServerName( body.value?.name );
	if ( ! name ) return json( { ok: false, error: 'A server name is required (1-40 chars)' }, 400 );
	const settings = sanitizeServerSettings( body.value?.settings );

	const serverId = await allocateNextServerId( env );
	const def = {
		serverId,
		type: 'permanent',
		name,
		ownerUsername: owner.username,
		ownerUsernameKey: owner.usernameKey,
		createdAt: Date.now(),
		settings,
	};

	await Promise.all( [
		saveJson( env, `${ SERVER_KEY_PREFIX }${ serverId }`, def ),
		addToIndex( env, SERVERS_INDEX_KEY, serverId ),
		addToOwnerIndex( env, owner.usernameKey, serverId ),
	] );
	await advanceCounterPast( env, serverId );

	return json( { ok: true, server: summarizeServer( def, null ) }, 201 );
}

async function getServer( env, serverId ) {
	const def = await loadServerDef( env, serverId );
	const session = await loadSession( env, serverId );
	if ( ! def && ! session ) return json( { ok: false, error: 'Server not found' }, 404 );
	if ( def ) return json( { ok: true, server: summarizeServer( def, session ) } );
	// Temporary servers have no permanent def — summarize from the live session.
	return json( { ok: true, server: summarizeSession( session, null ) } );
}

async function renamePermanentServer( request, env, serverId ) {
	const body = await parseJsonBody( request );
	if ( ! body.ok ) return body.response;
	const token = String( body.value?.token || '' ).trim();
	const owner = await resolveAccountUsername( token );
	if ( ! owner.usernameKey ) return json( { ok: false, error: 'Authentication required' }, 401 );

	const def = await loadServerDef( env, serverId );
	if ( ! def ) return json( { ok: false, error: 'Server not found' }, 404 );
	if ( def.type !== 'permanent' ) return json( { ok: false, error: 'Only permanent servers can be renamed' }, 400 );
	if ( def.ownerUsernameKey !== owner.usernameKey ) return json( { ok: false, error: 'Only the server owner can rename it' }, 403 );

	// Simple per-owner rename rate-limit to discourage abuse. Stored alongside
	// the owner index; not authoritative security, just friction.
	const rateKey = `servers:rename-rate:${ owner.usernameKey }`;
	const now = Date.now();
	const recent = ( await getJson( env, rateKey, [] ) ).filter( ( t ) => now - Number( t ) < RENAME_WINDOW_MS );
	if ( recent.length >= MAX_RENAME_PER_WINDOW ) return json( { ok: false, error: 'Too many renames. Wait a minute and try again.' }, 429 );

	const name = sanitizeServerName( body.value?.name );
	if ( ! name ) return json( { ok: false, error: 'A server name is required (1-40 chars)' }, 400 );

	def.name = name;
	def.updatedAt = now;
	recent.push( now );
	await Promise.all( [
		saveJson( env, `${ SERVER_KEY_PREFIX }${ serverId }`, def ),
		saveJson( env, rateKey, recent ),
	] );

	const session = await loadSession( env, serverId );
	return json( { ok: true, server: summarizeServer( def, session ) } );
}

async function deletePermanentServer( request, env, serverId ) {
	const body = await parseJsonBody( request );
	if ( ! body.ok ) return body.response;
	const token = String( body.value?.token || '' ).trim();
	const owner = await resolveAccountUsername( token );
	if ( ! owner.usernameKey ) return json( { ok: false, error: 'Authentication required' }, 401 );

	const def = await loadServerDef( env, serverId );
	if ( ! def ) return json( { ok: false, error: 'Server not found' }, 404 );
	if ( def.ownerUsernameKey !== owner.usernameKey ) return json( { ok: false, error: 'Only the server owner can delete it' }, 403 );

	// Remove the definition + indexes + chat history. The active session record
	// (if any) is left to expire via heartbeat timeout; we mark it closed so
	// joiners are rejected immediately while current players finish their lap.
	const session = await loadSession( env, serverId );
	if ( session ) {
		session.closed = true;
		session.closedReason = 'deleted';
		session.updatedAt = Date.now();
		await saveJson( env, `${ SESSION_KEY_PREFIX }${ serverId }`, session );
	}

	await Promise.all( [
		env.SERVERS_KV.delete( `${ SERVER_KEY_PREFIX }${ serverId }` ),
		removeFromIndex( env, SERVERS_INDEX_KEY, serverId ),
		removeFromOwnerIndex( env, def.ownerUsernameKey, serverId ),
		env.SERVERS_KV.delete( `${ SERVER_CHAT_KEY_PREFIX }${ serverId }` ),
	] );

	return json( { ok: true } );
}

// ===========================================================================
// Active sessions (temporary creation + presence + join + heartbeat)
// ===========================================================================

async function listActiveSessions( env, typeFilter ) {
	if ( Math.random() < SESSION_GC_PROBABILITY ) {
		gcStaleSessions( env ).catch( () => {} );
	}
	const ids = await getJson( env, SESSIONS_INDEX_KEY, [] );
	const now = Date.now();
	const out = [];
	const survivors = [];
	for ( const id of ids.slice( 0, MAX_SERVERS_LISTED ) ) {
		const session = await loadSession( env, id );
		if ( ! session ) continue;
		if ( now - ( Number( session.lastHeartbeat ) || 0 ) > SESSION_HEARTBEAT_TTL_MS ) {
			// Stale — drop it from the index lazily.
			await env.SERVERS_KV.delete( `${ SESSION_KEY_PREFIX }${ id }` );
			continue;
		}
		survivors.push( id );
		if ( typeFilter && session.type !== typeFilter ) continue;
		if ( session.closed ) continue;
		// For permanent servers, merge the definition (owner/name) so the
		// browser can show owner info even if the host is offline.
		let def = null;
		if ( session.type === 'permanent' ) def = await loadServerDef( env, id );
		out.push( summarizeSession( session, def ) );
	}
	// Best-effort compaction of the index if it drifted.
	if ( survivors.length !== ids.length ) {
		await saveJson( env, SESSIONS_INDEX_KEY, survivors.slice( 0, MAX_SERVERS_LISTED ) );
	}
	out.sort( sortServers );
	return json( { ok: true, servers: out } );
}

async function createTemporarySession( request, env ) {
	const body = await parseJsonBody( request );
	if ( ! body.ok ) return body.response;

	const name = sanitizeServerName( body.value?.name );
	if ( ! name ) return json( { ok: false, error: 'A server name is required (1-40 chars)' }, 400 );
	const settings = sanitizeServerSettings( body.value?.settings );
	const roomCode = sanitizeRoomCode( body.value?.roomCode );
	if ( ! roomCode ) return json( { ok: false, error: 'A room code is required to host a temporary server' }, 400 );
	const mapSignature = sanitizeMapSignature( body.value?.mapSignature );
	const hostUsername = sanitizeUsername( body.value?.hostUsername ) || 'Host';
	const hostClientId = String( body.value?.hostClientId || '' ).slice( 0, 64 );
	const maxPlayers = clampMaxPlayers( settings.maxPlayers );

	// Optional: bind this session to an EXISTING server id (e.g. starting an
	// offline permanent server). The id must already exist as a permanent def OR
	// be free. This keeps the permanent server's id stable across sessions.
	let serverId = null;
	let boundPermanent = false;
	const requestedId = Number( body.value?.serverId );
	if ( Number.isFinite( requestedId ) && requestedId > 0 ) {
		const existingDef = await env.SERVERS_KV.get( `${ SERVER_KEY_PREFIX }${ requestedId }` );
		const existingSession = await env.SERVERS_KV.get( `${ SESSION_KEY_PREFIX }${ requestedId }` );
		if ( existingDef && ! existingSession ) {
			serverId = requestedId; // bind to the existing permanent server (now online)
			boundPermanent = true;
		} else if ( existingSession ) {
			return json( { ok: false, error: 'That server already has an active session' }, 409 );
		}
	}
	if ( ! serverId ) serverId = await allocateNextServerId( env );
	const now = Date.now();
	const session = {
		serverId,
		type: boundPermanent ? 'permanent' : 'temporary',
		name,
		roomCode,
		mapSignature,
		hostUsername,
		hostClientId,
		playerCount: 1,
		maxPlayers,
		players: [ { username: hostUsername, clientId: hostClientId, isHost: true, lastSeen: now } ],
		lastHeartbeat: now,
		createdAt: now,
		updatedAt: now,
	};

	await Promise.all( [
		saveJson( env, `${ SESSION_KEY_PREFIX }${ serverId }`, session ),
		addToIndex( env, SESSIONS_INDEX_KEY, serverId ),
	] );
	await advanceCounterPast( env, serverId );

	return json( { ok: true, server: summarizeSession( session, null ) }, 201 );
}

async function joinSession( request, env, serverId ) {
	const body = await parseJsonBody( request );
	if ( ! body.ok ) return body.response;

	const session = await loadSession( env, serverId );
	if ( ! session ) {
		// Maybe it's a permanent server with no live session yet — the caller
		// should host-start it first. Tell them so.
		const def = await loadServerDef( env, serverId );
		if ( def ) return json( { ok: false, error: 'This server is currently offline. Ask the owner to start it, or start it yourself.' }, 409 );
		return json( { ok: false, error: 'That server is no longer available.' }, 404 );
	}
	if ( session.closed ) {
		return json( { ok: false, error: session.closedReason === 'deleted' ? 'This server was deleted by its owner.' : 'This server is closed.' }, 410 );
	}
	const now = Date.now();
	if ( now - ( Number( session.lastHeartbeat ) || 0 ) > SESSION_HEARTBEAT_TTL_MS ) {
		await env.SERVERS_KV.delete( `${ SESSION_KEY_PREFIX }${ serverId }` );
		return json( { ok: false, error: 'That server is no longer available.' }, 404 );
	}

	const joinerUsername = sanitizeUsername( body.value?.username ) || 'Player';
	const joinerClientId = String( body.value?.clientId || '' ).slice( 0, 64 );

	// Already in the server? Re-join is idempotent (e.g. reconnect).
	const existing = session.players.find( ( p ) => p.clientId && p.clientId === joinerClientId );
	if ( existing ) {
		existing.username = joinerUsername;
		existing.lastSeen = now;
	} else {
		// Capacity is enforced server-side. The browser's count can be stale, so
		// this is the authoritative check against the final slot.
		if ( session.players.length >= session.maxPlayers ) {
			return json( { ok: false, error: 'This server is full.' }, 409 );
		}
		session.players.push( { username: joinerUsername, clientId: joinerClientId, isHost: false, lastSeen: now } );
	}
	session.playerCount = session.players.length;
	session.lastHeartbeat = now;
	session.updatedAt = now;
	await saveJson( env, `${ SESSION_KEY_PREFIX }${ serverId }`, session );

	return json( { ok: true, server: summarizeSession( session, null ) } );
}

async function heartbeatSession( request, env, serverId ) {
	const body = await parseJsonBody( request );
	if ( ! body.ok ) return body.response;
	const session = await loadSession( env, serverId );
	if ( ! session ) return json( { ok: false, error: 'Session expired' }, 404 );
	const now = Date.now();
	const clientId = String( body.value?.clientId || '' ).slice( 0, 64 );

	// Refresh the caller's own presence and drop players we haven't heard from.
	for ( const p of session.players ) {
		if ( clientId && p.clientId === clientId ) {
			p.username = sanitizeUsername( body.value?.username ) || p.username || 'Player';
			p.lastSeen = now;
		}
	}
	// Drop players whose lastSeen is older than the heartbeat TTL.
	session.players = session.players.filter( ( p ) => now - ( Number( p.lastSeen ) || 0 ) <= SESSION_HEARTBEAT_TTL_MS );
	session.playerCount = session.players.length;
	session.lastHeartbeat = now;
	session.updatedAt = now;
	await saveJson( env, `${ SESSION_KEY_PREFIX }${ serverId }`, session );

	// Return the fresh player list so the caller can render it.
	return json( { ok: true, server: summarizeSession( session, null ) } );
}

// Host moved the server to a new track/room. Updates the session's roomCode +
// mapSignature so joiners + existing players (via heartbeat) follow the host to
// the new map. Only the current session host may rehost.
async function rehostSession( request, env, serverId ) {
	const body = await parseJsonBody( request );
	if ( ! body.ok ) return body.response;
	const session = await loadSession( env, serverId );
	if ( ! session ) return json( { ok: false, error: 'Session expired' }, 404 );
	const clientId = String( body.value?.clientId || '' ).slice( 0, 64 );
	const host = session.players.find( ( p ) => p.isHost );
	if ( ! host || host.clientId !== clientId ) {
		return json( { ok: false, error: 'Only the host can change the track' }, 403 );
	}
	const roomCode = String( body.value?.roomCode || '' ).slice( 0, 16 ).toUpperCase();
	const mapSignature = String( body.value?.mapSignature || '' ).slice( 0, 120 );
	if ( ! roomCode || ! mapSignature ) return json( { ok: false, error: 'roomCode and mapSignature are required' }, 400 );
	session.roomCode = roomCode;
	session.mapSignature = mapSignature;
	session.lastHeartbeat = Date.now();
	session.updatedAt = Date.now();
	await saveJson( env, `${ SESSION_KEY_PREFIX }${ serverId }`, session );
	return json( { ok: true, server: summarizeSession( session, null ) } );
}

async function leaveSession( request, env, serverId ) {
	const body = await parseJsonBody( request );
	if ( ! body.ok ) return body.response;
	const session = await loadSession( env, serverId );
	if ( ! session ) return json( { ok: true } ); // already gone — idempotent
	const clientId = String( body.value?.clientId || '' ).slice( 0, 64 );
	session.players = session.players.filter( ( p ) => !( clientId && p.clientId === clientId ) );
	session.playerCount = session.players.length;
	session.updatedAt = Date.now();
	const now = Date.now();
	const alive = session.players.some( ( p ) => now - ( Number( p.lastSeen ) || 0 ) <= SESSION_HEARTBEAT_TTL_MS );
	if ( session.type === 'temporary' && ! alive ) {
		// Temporary servers die as soon as nobody is left + heartbeat-stale.
		await env.SERVERS_KV.delete( `${ SESSION_KEY_PREFIX }${ serverId }` );
		await removeFromIndex( env, SESSIONS_INDEX_KEY, serverId );
	} else {
		await saveJson( env, `${ SESSION_KEY_PREFIX }${ serverId }`, session );
	}
	return json( { ok: true } );
}

async function gcStaleSessions( env ) {
	const ids = await getJson( env, SESSIONS_INDEX_KEY, [] );
	const now = Date.now();
	const survivors = [];
	for ( const id of ids.slice( 0, MAX_SERVERS_LISTED ) ) {
		const session = await loadSession( env, id );
		if ( ! session ) continue;
		const alivePlayers = session.players.filter( ( p ) => now - ( Number( p.lastSeen ) || 0 ) <= SESSION_HEARTBEAT_TTL_MS );
		if ( alivePlayers.length === 0 && now - ( Number( session.lastHeartbeat ) || 0 ) > SESSION_HEARTBEAT_TTL_MS ) {
			await env.SERVERS_KV.delete( `${ SESSION_KEY_PREFIX }${ id }` );
			if ( session.type === 'temporary' ) continue; // drop from index
		}
		session.players = alivePlayers;
		session.playerCount = alivePlayers.length;
		await saveJson( env, `${ SESSION_KEY_PREFIX }${ id }`, session );
		survivors.push( id );
	}
	await saveJson( env, SESSIONS_INDEX_KEY, survivors.slice( 0, MAX_SERVERS_LISTED ) );
}

// ===========================================================================
// Server chat history (the live delivery is Ably; this is persisted history)
// ===========================================================================

async function getServerChat( env, serverId ) {
	const history = await getJson( env, `${ SERVER_CHAT_KEY_PREFIX }${ serverId }`, [] );
	return json( { ok: true, messages: history } );
}

async function postServerChat( request, env, serverId ) {
	const body = await parseJsonBody( request );
	if ( ! body.ok ) return body.response;
	// Chat is only writable by someone currently in the session. We verify by
	// checking the active session's player list (matched by clientId). This is a
	// lightweight server-side authorization: a player may only post to a server
	// they have actually joined. The Ably channel itself is shared-key, so this
	// history endpoint is the enforcement point; Ably delivery trusts the same
	// channel naming the client derives from the joined serverId.
	const session = await loadSession( env, serverId );
	if ( ! session ) return json( { ok: false, error: 'Server is not active' }, 404 );
	if ( session.closed ) return json( { ok: false, error: 'Server is closed' }, 410 );
	const clientId = String( body.value?.clientId || '' ).slice( 0, 64 );
	const username = sanitizeUsername( body.value?.username ) || 'Player';
	const inSession = session.players.some( ( p ) => clientId && p.clientId === clientId );
	if ( ! inSession ) return json( { ok: false, error: 'You must join this server before chatting' }, 403 );

	const content = sanitizeChatMessage( body.value?.content );
	if ( ! content ) return json( { ok: false, error: 'Message is empty' }, 400 );

	const message = {
		messageId: `${ nowIso() }-${ Math.random().toString( 36 ).slice( 2, 8 ) }`,
		username,
		content,
		timestamp: nowIso(),
	};
	const key = `${ SERVER_CHAT_KEY_PREFIX }${ serverId }`;
	const history = await getJson( env, key, [] );
	history.push( message );
	while ( history.length > MAX_CHAT_HISTORY ) history.shift();
	await saveJson( env, key, history );
	return json( { ok: true, message } );
}

// ===========================================================================
// Server-authoritative sequential ID allocation
// ===========================================================================

async function allocateNextServerId( env ) {
	// Counter starts at 0; first server gets id 1. We probe-and-claim with a
	// bounded retry loop. The re-read-before-write makes double-claims
	// self-correcting (see file header). Counter is shared between temporary and
	// permanent servers so ids are globally unique and monotonic.
	const MAX_ATTEMPTS = 64;
	for ( let attempt = 0; attempt < MAX_ATTEMPTS; attempt++ ) {
		const counterRaw = await env.SERVERS_KV.get( SERVERS_COUNTER_KEY );
		let counter = Number( counterRaw );
		if ( ! Number.isFinite( counter ) || counter < 0 ) counter = 0;
		const candidateId = counter + 1;
		// Verify the candidate is actually free (covers counter drift / manual edits).
		const existingDef = await env.SERVERS_KV.get( `${ SERVER_KEY_PREFIX }${ candidateId }` );
		const existingSession = await env.SERVERS_KV.get( `${ SESSION_KEY_PREFIX }${ candidateId }` );
		if ( existingDef || existingSession ) {
			// Counter drifted behind reality — bump it past the collision and retry.
			await env.SERVERS_KV.put( SERVERS_COUNTER_KEY, String( candidateId ) );
			continue;
		}
		return candidateId;
	}
	throw new Error( 'Failed to allocate a server id (too many collisions)' );
}

// Called by the create flows after a successful write to advance the counter
// past the claimed id. Exported via the module for the create handlers.
async function advanceCounterPast( env, serverId ) {
	const counterRaw = await env.SERVERS_KV.get( SERVERS_COUNTER_KEY );
	const counter = Number( counterRaw );
	if ( ! Number.isFinite( counter ) || counter < serverId ) {
		await env.SERVERS_KV.put( SERVERS_COUNTER_KEY, String( serverId ) );
	}
}

// ===========================================================================
// Account verification (reuses the existing accounts worker — single auth)
// ===========================================================================

async function resolveAccountUsername( token ) {
	if ( ! token ) return { username: '', usernameKey: '' };
	try {
		const res = await fetch( `${ ACCOUNTS_PROFILE_URL }?token=${ encodeURIComponent( token ) }`, {
			headers: { 'Content-Type': 'application/json' },
		} );
		if ( ! res.ok ) return { username: '', usernameKey: '' };
		const payload = await res.json();
		if ( ! payload?.ok ) return { username: '', usernameKey: '' };
		const username = sanitizeUsername( payload.username );
		return { username, usernameKey: username.toLowerCase() };
	} catch {
		return { username: '', usernameKey: '' };
	}
}

// ===========================================================================
// KV helpers (mirror the clubs worker pattern)
// ===========================================================================

async function loadServerDef( env, serverId ) {
	return getJson( env, `${ SERVER_KEY_PREFIX }${ serverId }`, null );
}

async function loadSession( env, serverId ) {
	return getJson( env, `${ SESSION_KEY_PREFIX }${ serverId }`, null );
}

async function getJson( env, key, fallback ) {
	const raw = await env.SERVERS_KV.get( key );
	if ( raw == null ) return fallback;
	try {
		return JSON.parse( raw );
	} catch {
		return fallback;
	}
}

async function saveJson( env, key, data ) {
	await env.SERVERS_KV.put( key, JSON.stringify( data ) );
}

async function addToIndex( env, indexKey, id ) {
	const ids = await getJson( env, indexKey, [] );
	if ( ! ids.includes( id ) ) ids.push( id );
	await saveJson( env, indexKey, ids.slice( 0, MAX_SERVERS_LISTED ) );
}

async function removeFromIndex( env, indexKey, id ) {
	const ids = ( await getJson( env, indexKey, [] ) ).filter( ( x ) => x !== id );
	await saveJson( env, indexKey, ids );
}

async function addToOwnerIndex( env, usernameKey, serverId ) {
	const ids = await getJson( env, `${ OWNER_KEY_PREFIX }${ usernameKey }`, [] );
	if ( ! ids.includes( serverId ) ) ids.push( serverId );
	await saveJson( env, `${ OWNER_KEY_PREFIX }${ usernameKey }`, ids.slice( 0, MAX_SERVERS_LISTED ) );
}

async function removeFromOwnerIndex( env, usernameKey, serverId ) {
	const ids = ( await getJson( env, `${ OWNER_KEY_PREFIX }${ usernameKey }`, [] ) ).filter( ( x ) => x !== serverId );
	await saveJson( env, `${ OWNER_KEY_PREFIX }${ usernameKey }`, ids );
}

// ===========================================================================
// Sanitizers + summarizers
// ===========================================================================

function summarizeServer( def, session ) {
	return {
		serverId: def.serverId,
		type: def.type,
		name: def.name,
		ownerUsername: def.ownerUsername,
		createdAt: def.createdAt,
		updatedAt: def.updatedAt || def.createdAt,
		settings: def.settings,
		online: Boolean( session && ! session.closed ),
		playerCount: session && ! session.closed ? session.playerCount : 0,
		maxPlayers: session ? session.maxPlayers : ( def.settings?.maxPlayers || DEFAULT_MAX_PLAYERS ),
		roomCode: session && ! session.closed ? session.roomCode : null,
		mapSignature: session && ! session.closed ? session.mapSignature : null,
		hostUsername: session && ! session.closed ? session.hostUsername : null,
	};
}

function summarizeSession( session, def ) {
	const base = {
		serverId: session.serverId,
		type: session.type,
		name: def ? def.name : session.name,
		roomCode: session.roomCode,
		mapSignature: session.mapSignature,
		hostUsername: session.hostUsername,
		playerCount: session.playerCount,
		maxPlayers: session.maxPlayers,
		players: session.players.map( ( p ) => ( { username: p.username, isHost: Boolean( p.isHost ) } ) ),
		online: true,
		createdAt: session.createdAt,
		updatedAt: session.updatedAt,
	};
	if ( def ) {
		base.ownerUsername = def.ownerUsername;
		base.settings = def.settings;
	}
	return base;
}

function sortServers( a, b ) {
	// Joinable servers with players first, then more players, then recently active.
	const ap = Number( a.playerCount ) || 0;
	const bp = Number( b.playerCount ) || 0;
	if ( ap !== bp ) return bp - ap;
	const at = Number( a.updatedAt || a.createdAt ) || 0;
	const bt = Number( b.updatedAt || b.createdAt ) || 0;
	return bt - at;
}

function sanitizeServerName( value ) {
	// Collapse whitespace, strip control chars, cap length. No HTML escaping is
	// needed here because the client renders with textContent (never innerHTML).
	const cleaned = String( value || '' ).replace( /\s+/g, ' ' ).replace( /[\u0000-\u001F\u007F]/g, '' ).trim();
	if ( cleaned.length < MIN_SERVER_NAME_LENGTH ) return '';
	return cleaned.slice( 0, MAX_SERVER_NAME_LENGTH );
}

function sanitizeServerSettings( value ) {
	const s = value && typeof value === 'object' ? value : {};
	return {
		maxPlayers: clampMaxPlayers( s.maxPlayers ),
		public: s.public !== false,
	};
}

function clampMaxPlayers( value ) {
	const n = Math.floor( Number( value ) );
	if ( ! Number.isFinite( n ) || n < 2 ) return DEFAULT_MAX_PLAYERS;
	return Math.min( n, HARD_MAX_PLAYERS );
}

function sanitizeUsername( value ) {
	const cleaned = String( value || '' ).replace( /\s+/g, ' ' ).trim().slice( 0, 24 );
	if ( ! /^[a-zA-Z0-9_\-. ]+$/.test( cleaned ) ) return '';
	return cleaned;
}

function sanitizeRoomCode( value ) {
	const cleaned = String( value || '' ).trim().toUpperCase().slice( 0, 8 );
	if ( ! /^[A-Z0-9]{4,8}$/.test( cleaned ) ) return '';
	return cleaned;
}

function sanitizeMapSignature( value ) {
	return String( value || '' ).slice( 0, 200 );
}

function sanitizeChatMessage( value ) {
	const cleaned = String( value || '' ).replace( /\s+/g, ' ' ).replace( /[\u0000-\u001F\u007F]/g, '' ).trim();
	if ( ! cleaned ) return '';
	return cleaned.slice( 0, MAX_CHAT_MESSAGE_LENGTH );
}

function nowIso() {
	return new Date().toISOString();
}

// ===========================================================================
// HTTP helpers (mirror accounts worker CORS shape)
// ===========================================================================

async function parseJsonBody( request ) {
	try {
		const value = await request.json();
		return { ok: true, value };
	} catch {
		return { ok: false, response: json( { ok: false, error: 'Invalid JSON body' }, 400 ) };
	}
}

function json( payload, status = 200 ) {
	return new Response( JSON.stringify( payload ), {
		status,
		headers: { 'Content-Type': 'application/json' },
	} );
}

function withCors( response ) {
	const headers = new Headers( response.headers );
	headers.set( 'Access-Control-Allow-Origin', '*' );
	headers.set( 'Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS' );
	headers.set( 'Access-Control-Allow-Headers', 'Content-Type' );
	return new Response( response.body, { status: response.status, headers } );
}
