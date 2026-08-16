// Public multiplayer servers client helper.
//
// Provides the predefined public-server list, the worker API base, and thin
// fetch wrappers. The actual UI/loop wiring lives in js/main.js (it reuses the
// existing PeerJS multiplayer session state + DOM).

// Deployed worker URL (see cloudflare-servers/worker). The KV binding is
// SERVERS_KV. This is the source of truth for the synced 5-minute round timer,
// round rotation, and per-round best-lap rankings.
export const SERVERS_API_BASE = 'https://racing-servers-api.ga1010.workers.dev/api/servers';

// The shared track-share board. Any player in a public server picks a random
// track from here for the next cycle during the rankings window (first-writer-
// wins on the worker). It is NOT a host-only action.
export const TRACK_BOARD_API = 'https://racing-track-board-api.ga1010.workers.dev/api/tracks';

// 5 minutes of play per round + 5 seconds of rankings before rotating
// (mirrors the worker). The timer is anchored to wall-clock UTC (see the
// worker's ROUND_EPOCH / CYCLE_MS), so it is always running and can never
// freeze — it does not depend on a host or on when players joined.
export const PLAY_DURATION_MS = 5 * 60 * 1000;
export const RANKINGS_WINDOW_MS = 5 * 1000;
export const CYCLE_MS = PLAY_DURATION_MS + RANKINGS_WINDOW_MS;

// The fixed public servers. They are NOT locational — they are just three
// parallel rooms so players can spread out if one is full. `code` is the shared
// PeerJS room code (host peer id `RACE-ROOM-<code>`). Keep in sync with the
// worker's PREDEFINED_SERVERS list (same ids/codes/names).
export const PUBLIC_SERVERS = [
	{ id: 'server-1', name: 'Server 1', code: 'PUBSV1' },
	{ id: 'server-2', name: 'Server 2', code: 'PUBSV2' },
	{ id: 'server-3', name: 'Server 3', code: 'PUBSV3' },
];

export function findPublicServer( id ) {

	return PUBLIC_SERVERS.find( ( s ) => s.id === id ) || null;

}

export function isPublicServerConfigured() {

	return Boolean( SERVERS_API_BASE && ! SERVERS_API_BASE.includes( 'REPLACE_WITH' ) );

}

async function serverRequest( path, method = 'GET', payload = undefined ) {

	const controller = new AbortController();
	const timeoutId = setTimeout( () => controller.abort(), 6000 );
	try {

		const response = await fetch( `${ SERVERS_API_BASE }${ path }`, {
			method,
			headers: payload !== undefined ? { 'Content-Type': 'application/json' } : undefined,
			body: payload !== undefined ? JSON.stringify( payload ) : undefined,
			cache: 'no-store',
			signal: controller.signal,
		} );
		if ( ! response.ok ) {

			let detail = '';
			try { detail = await response.text(); } catch { detail = ''; }
			throw new Error( `server-http-${ response.status }${ detail ? `:${ detail.slice( 0, 200 ) }` : '' }` );

		}
		return await response.json();

	} finally {

		clearTimeout( timeoutId );

	}

}

export async function fetchServerState( serverId ) {

	return serverRequest( `/${ encodeURIComponent( serverId ) }`, 'GET' );

}

export async function joinServer( serverId, clientId, name ) {

	return serverRequest( `/${ encodeURIComponent( serverId ) }/join`, 'POST', { clientId, name } );

}

export async function claimServerHost( serverId, clientId, name ) {

	return serverRequest( `/${ encodeURIComponent( serverId ) }/claim-host`, 'POST', { clientId, name } );

}

export async function heartbeatServer( serverId, clientId, name ) {

	return serverRequest( `/${ encodeURIComponent( serverId ) }/heartbeat`, 'POST', { clientId, name } );

}

export async function submitServerLap( serverId, clientId, name, time ) {

	return serverRequest( `/${ encodeURIComponent( serverId ) }/lap`, 'POST', { clientId, name, time } );

}

// Set the track for a specific cycle index (first-writer-wins). ANY player may
// call this — it is not host-gated. Typically called during the rankings
// window to set the NEXT cycle's track so the rotation keeps going even if the
// (hidden) host peer disappears.
export async function setServerTrack( serverId, clientId, cycleIndex, trackPlayUrl, trackMapSignature ) {

	return serverRequest( `/${ encodeURIComponent( serverId ) }/set-track`, 'POST', {
		clientId,
		cycleIndex,
		trackPlayUrl,
		trackMapSignature,
	} );

}

export async function leaveServer( serverId, clientId ) {

	return serverRequest( `/${ encodeURIComponent( serverId ) }/leave`, 'POST', { clientId } );

}

export async function fetchRandomTrackPlayUrl() {

	const list = await fetchTrackList();
	return list.length ? list[ Math.floor( Math.random() * list.length ) ].playUrl : null;

}

// Fetch the full community-track list from the board (sorted by a stable key so
// the deterministic picker below is reproducible across clients). Each entry is
// { id, name, playUrl, ... }. We sort by `id` (a stable uuid set at publish
// time) and fall back to `playUrl` so the order is identical for every client
// regardless of insertion order or KV iteration order.
export async function fetchTrackList() {

	const controller = new AbortController();
	const timeoutId = setTimeout( () => controller.abort(), 6000 );
	try {

		const response = await fetch( TRACK_BOARD_API, { cache: 'no-store', signal: controller.signal } );
		if ( ! response.ok ) throw new Error( `tracks-http-${ response.status }` );
		const data = await response.json();
		const entries = Array.isArray( data?.entries ) ? data.entries : [];
		const usable = entries.filter( ( e ) => typeof e?.playUrl === 'string' && e.playUrl );
		usable.sort( ( a, b ) => {
			const ka = String( a.id || a.playUrl );
			const kb = String( b.id || b.playUrl );
			return ka < kb ? -1 : ka > kb ? 1 : 0;
		} );
		return usable;

	} finally {

		clearTimeout( timeoutId );

	}

}

// Deterministic seeded PRNG (mulberry32). Given the same seed it always produces
// the same sequence, so every client picking a track for the same cycle gets the
// SAME result — no worker write needed to agree on a track.
function mulberry32( seed ) {

	let a = seed >>> 0;
	return function () {

		a |= 0; a = ( a + 0x6D2B79F5 ) | 0;
		let t = Math.imul( a ^ ( a >>> 15 ), 1 | a );
		t = ( t + Math.imul( t ^ ( t >>> 7 ), 61 | t ) ) ^ t;
		return ( ( t ^ ( t >>> 14 ) ) >>> 0 ) / 4294967296;

	};

}

// Hash a string into a 32-bit int (FNV-1a-ish). Used to fold the server id into
// the seed so different public servers get different track sequences for the
// same cycle (more variety), while still being fully deterministic.
function hashString( str ) {

	let h = 2166136261 >>> 0;
	for ( let i = 0; i < str.length; i++ ) {

		h ^= str.charCodeAt( i );
		h = Math.imul( h, 16777619 );

	}
	return h >>> 0;

}

// Pick the track for a given cycle deterministically. The cycle index is derived
// from wall-clock UTC (see the worker's ROUND_EPOCH / CYCLE_MS), so this is the
// "seed from a single world timezone" approach: every player computes the same
// cycleIndex and therefore the same track, with no coordination write. The
// server id is folded into the seed so the three public servers don't all race
// the same track on the same cycle. Returns the chosen entry, or null if the
// list is empty.
export function pickTrackForCycle( cycleIndex, serverId, trackList ) {

	if ( ! Array.isArray( trackList ) || trackList.length === 0 ) return null;
	let seed = ( Math.imul( Number( cycleIndex ) || 0, 2654435761 ) ) >>> 0;
	seed = ( seed ^ hashString( String( serverId || '' ) ) ) >>> 0;
	const rng = mulberry32( seed );
	const idx = Math.floor( rng() * trackList.length );
	return trackList[ idx ] || null;

}

// Build the mapSignature ("map|mods") from a track playUrl so clients can tell
// when the server's round track differs from their currently-loaded map.
export function mapSignatureFromPlayUrl( playUrl ) {

	try {

		const parsed = new URL( playUrl, window.location.href );
		const map = parsed.searchParams.get( 'map' ) || 'default';
		const mods = parsed.searchParams.get( 'mods' ) || 'none';
		return `${ map }|${ mods }`;

	} catch {

		return 'default|none';

	}

}

// Turn a track board playUrl into a same-tab navigation URL that rejoins the
// public server after the redirect (preserves the pubServer param). The playUrl
// is a relative index.html URL like `index.html?map=...&mods=...#ghost=...`.
export function buildServerTrackRedirectUrl( playUrl, serverId ) {

	try {

		const parsed = new URL( playUrl, window.location.href );
		parsed.searchParams.set( 'pubServer', serverId );
		parsed.searchParams.set( 'play', '1' );
		// Keep the hash (ghost=...) intact.
		return `${ parsed.pathname }${ parsed.search }${ parsed.hash }`;

	} catch {

		return playUrl;

	}

}
