// Multiplayer Servers client module.
//
// Thin API wrapper for the multiplayer server browser (cloudflare-servers worker).
// Sits ON TOP of the existing PeerJS + Firebase networking — it only handles
// server discovery, ownership, presence (heartbeat), and chat history. The
// actual peer connection is still started by main.js's startPeerMultiplayer().
//
// Placeholder-ready: SERVERS_API_BASE is a placeholder until the worker is
// deployed. isReady() returns false while the placeholder is in place, so the
// UI shows a "not connected yet" message and single-player + existing
// join-by-code multiplayer keep working normally.

const PLACEHOLDER_HOST = 'REPLACE_WITH_YOUR_WORKER_URL';

// Deploy this worker (see cloudflare-servers/README.md) and paste the URL here.
export const SERVERS_API_BASE = 'https://racing-servers-api.ga1010.workers.dev/api/servers';

export function serversReady() {
	return Boolean( SERVERS_API_BASE ) && ! SERVERS_API_BASE.includes( PLACEHOLDER_HOST );
}

const REQUEST_TIMEOUT_MS = 8000;

async function serversRequest( path, options = {} ) {
	if ( ! serversReady() ) {
		throw new Error( 'Servers backend is not connected yet. Deploy the Cloudflare worker (see cloudflare-servers/README.md).' );
	}
	const controller = new AbortController();
	const timeoutId = setTimeout( () => controller.abort(), REQUEST_TIMEOUT_MS );
	try {
		const response = await fetch( `${ SERVERS_API_BASE }${ path }`, {
			headers: { 'Content-Type': 'application/json', ...( options.headers || {} ) },
			...options,
			signal: controller.signal,
		} );
		const payload = await response.json().catch( () => ( {} ) );
		if ( ! response.ok || payload?.ok === false ) {
			throw new Error( payload?.error || `Servers API HTTP ${ response.status }` );
		}
		return payload;
	} catch ( error ) {
		if ( error?.name === 'AbortError' ) throw new Error( 'Servers request timed out. Check your connection.' );
		throw error;
	} finally {
		clearTimeout( timeoutId );
	}
}

// ---- Listing ----

export async function listTemporaryServers() {
	const payload = await serversRequest( '/temporary' );
	return payload.servers || [];
}

export async function listPermanentServers() {
	const payload = await serversRequest( '/permanent' );
	return payload.servers || [];
}

export async function getServer( serverId ) {
	const payload = await serversRequest( `/${ Number( serverId ) }` );
	return payload.server || null;
}

// ---- Temporary server lifecycle ----

export async function createTemporaryServer( { name, roomCode, mapSignature, hostUsername, hostClientId, settings } ) {
	const payload = await serversRequest( '/temporary', {
		method: 'POST',
		body: JSON.stringify( { name, roomCode, mapSignature, hostUsername, hostClientId, settings } ),
	} );
	return payload.server;
}

// ---- Permanent server lifecycle ----

export async function createPermanentServer( { token, name, settings } ) {
	const payload = await serversRequest( '/permanent', {
		method: 'POST',
		body: JSON.stringify( { token, name, settings } ),
	} );
	return payload.server;
}

export async function renamePermanentServer( serverId, { token, name } ) {
	const payload = await serversRequest( `/${ Number( serverId ) }/rename`, {
		method: 'POST',
		body: JSON.stringify( { token, name } ),
	} );
	return payload.server;
}

export async function deletePermanentServer( serverId, { token } ) {
	await serversRequest( `/${ Number( serverId ) }`, {
		method: 'DELETE',
		body: JSON.stringify( { token } ),
	} );
	return true;
}

// ---- Session join / presence ----

export async function joinServer( serverId, { username, clientId } ) {
	const payload = await serversRequest( `/${ Number( serverId ) }/join`, {
		method: 'POST',
		body: JSON.stringify( { username, clientId } ),
	} );
	return payload.server;
}

export async function heartbeatServer( serverId, { username, clientId } ) {
	const payload = await serversRequest( `/${ Number( serverId ) }/heartbeat`, {
		method: 'POST',
		body: JSON.stringify( { username, clientId } ),
	} );
	return payload.server;
}

export async function leaveServer( serverId, { clientId } ) {
	try {
		await serversRequest( `/${ Number( serverId ) }/leave`, {
			method: 'POST',
			body: JSON.stringify( { clientId } ),
		} );
	} catch ( err ) {
		// Leaving is best-effort — the server's heartbeat TTL cleans up regardless.
	}
	return true;
}

// Host moved the server to a new track: updates the session roomCode +
// mapSignature so joiners + existing players follow the host.
export async function rehostServer( serverId, { clientId, roomCode, mapSignature } ) {
	const payload = await serversRequest( `/${ Number( serverId ) }/rehost`, {
		method: 'POST',
		body: JSON.stringify( { clientId, roomCode, mapSignature } ),
	} );
	return payload.server;
}

// ---- Server chat history (live delivery is Ably via ServerChat.js) ----

export async function getServerChat( serverId ) {
	const payload = await serversRequest( `/${ Number( serverId ) }/chat` );
	return payload.messages || [];
}

export async function postServerChat( serverId, { clientId, username, content } ) {
	try {
		await serversRequest( `/${ Number( serverId ) }/chat`, {
			method: 'POST',
			body: JSON.stringify( { clientId, username, content } ),
		} );
	} catch ( err ) {
		// History persistence is best-effort; Ably still delivers live.
	}
	return true;
}

// ---- Display helpers ----

export function serverChatChannelName( serverId ) {
	return `skidcircuit:server:${ Number( serverId ) }:chat`;
}

export function formatServerCardLine( server ) {
	const id = Number( server?.serverId ) || 0;
	const count = Number( server?.playerCount ) || 0;
	const max = Number( server?.maxPlayers ) || 8;
	const status = server?.online === false || count === 0 ? 'Offline' : ( count >= max ? 'Full' : 'Open' );
	return `Server #${ id } — Players: ${ count }/${ max } — ${ status }`;
}
