// Public multiplayer servers client helper.
//
// Provides the predefined public-server list, the read-only track-share board
// fetch (with retries), and the map-signature / redirect-URL helpers. A public
// server is just a fixed PeerJS room (code, e.g. PUBSV1): everyone who joins is
// connected over WebRTC (PeerJS uses the TURN server configured in main.js) and
// shares the host's current map. There is NO round timer, NO deterministic track
// rotation, NO rankings, and NO backend worker — the only network dependency is
// the read-only track share board (GET /api/tracks), used by the map-vote feature
// to look up a pasted track URL's name.
//
// Map switching on a public server is driven by a peer vote (see main.js):
// a player pastes a track URL, the board is searched for its name, everyone
// votes Yes/No, and after 30s a >60% Yes majority switches the track.

// The shared track-share board. Read-only from the public servers' point of
// view — the map-vote lookup only GETs the list, so it costs zero KV writes
// against the Cloudflare free-plan daily quota.
export const TRACK_BOARD_API = 'https://racing-track-board-api.ga1010.workers.dev/api/tracks';

// The fixed public servers. They are NOT locational — they are just three
// parallel rooms so players can spread out if one is full. `code` is the shared
// PeerJS room code (host peer id `RACE-ROOM-<code>`).
export const PUBLIC_SERVERS = [
	{ id: 'server-1', name: 'Server 1', code: 'PUBSV1' },
	{ id: 'server-2', name: 'Server 2', code: 'PUBSV2' },
	{ id: 'server-3', name: 'Server 3', code: 'PUBSV3' },
];

export function findPublicServer( id ) {

	return PUBLIC_SERVERS.find( ( s ) => s.id === id ) || null;

}

// Public servers are always "configured" — they need no backend worker of
// their own. They only need the read-only track share board and PeerJS's default
// cloud signalling (free). Kept as a function so existing call sites keep
// compiling.
export function isPublicServerConfigured() {

	return true;

}

// Robust GET against the track share board with RETRIES.
//
// The board worker is read-only (zero KV writes) but it is flaky: it returns a
// Cloudflare 503 ("error code: 1102" — transient worker invocation failure) on
// roughly 60% of single requests, while the other ~40% succeed. A single-shot
// fetch therefore fails most of the time, which broke the public servers (no
// track resolved → no join redirect, no rankings popup) AND made the tracks.html
// board page say "Cloud board unavailable". Retrying a handful of times makes a
// 200 effectively guaranteed (empirically 8 attempts → 100% success), so the
// community track list reliably loads. This is the fix for the "track share
// board unavailable / public servers broken" reports.
//
// Exported so the game (main.js) and the board page (tracks.html) reuse the
// SAME retry path for their own track-board reads (campaign, shared-track title
// resolution, the board grid), keeping every affected feature working — not just
// multiplayer.
export async function fetchTrackBoardWithRetry( url, { attempts = 8, timeoutMs = 8000, backoffMs = 350 } = {} ) {

	let lastError = null;
	for ( let attempt = 0; attempt < attempts; attempt ++ ) {

		const controller = new AbortController();
		const timeoutId = setTimeout( () => controller.abort(), timeoutMs );
		try {

			const response = await fetch( url, { cache: 'no-store', signal: controller.signal } );
			if ( response.ok ) return await response.json();
			// 503 / 5xx are transient — retry. 4xx (e.g. 404) are permanent — bail.
			lastError = new Error( `tracks-http-${ response.status }` );
			if ( response.status >= 400 && response.status < 500 && response.status !== 429 ) break;

		} catch ( error ) {

			lastError = error;

		} finally {

			clearTimeout( timeoutId );

		}
		// Brief backoff before the next attempt (skip the delay after the last try).
		if ( attempt < attempts - 1 ) await new Promise( ( r ) => setTimeout( r, backoffMs ) );

	}
	throw lastError || new Error( 'tracks-fetch-failed' );

}

// Fetch the full community-track list from the board (sorted by a stable key so
// the deterministic picker below is reproducible across clients). Each entry is
// { id, name, playUrl, ... }. We sort by `id` (a stable uuid set at publish
// time) and fall back to `playUrl` so the order is identical for every client
// regardless of insertion order or KV iteration order. Retries via
// fetchTrackBoardWithRetry so a transient 503 never leaves the public servers
// without a track to race.
export async function fetchTrackList() {

	const data = await fetchTrackBoardWithRetry( TRACK_BOARD_API );
	const entries = Array.isArray( data?.entries ) ? data.entries : [];
	const usable = entries.filter( ( e ) => typeof e?.playUrl === 'string' && e.playUrl );
	usable.sort( ( a, b ) => {
		const ka = String( a.id || a.playUrl );
		const kb = String( b.id || b.playUrl );
		return ka < kb ? -1 : ka > kb ? 1 : 0;
	} );
	return usable;

}

// Search the fetched track list for an entry whose playUrl matches `url` and
// return it (with a clean name), or null. Used by the public-server map-vote:
// a player pastes a track URL, the board is searched, and the track's name is
// shown on everyone's vote prompt. Matching is by the playUrl string (the board
// stores absolute playUrls), normalized so a trailing fragment / query-order
// difference doesn't defeat the lookup.
export function findTrackByPlayUrl( url, trackList ) {

	const target = normalizePlayUrlForMatch( url );
	if ( ! target ) return null;
	const list = Array.isArray( trackList ) ? trackList : [];
	for ( const entry of list ) {

		if ( ! entry || typeof entry.playUrl !== 'string' ) continue;
		if ( normalizePlayUrlForMatch( entry.playUrl ) === target ) {

			const name = typeof entry.name === 'string' && entry.name.trim() ? entry.name.trim() : 'Shared track';
			return { name, playUrl: entry.playUrl };

		}

	}
	return null;

}

// Is `url` a playable racing-game track URL? It must parse as a URL and carry a
// non-empty `map` query param (the track data the game loads). Used by the
// public-server map-vote to allow a pasted URL that isn't on the share board
// (a private/unlisted track) — the vote still proceeds, just labelled "Custom
// track".
export function isRacingGameTrackUrl( url ) {

	try {

		const parsed = new URL( String( url || '' ), window.location.href );
		const map = parsed.searchParams.get( 'map' );
		return Boolean( map && map.trim() );

	} catch {

		return false;

	}

}

// Normalize a playUrl for equality comparison: strip the hash (the board stores
// a base64 ghost blob there which is huge and irrelevant to identity), and sort
// the query params so different insertion orders don't defeat the match.
function normalizePlayUrlForMatch( url ) {

	try {

		const parsed = new URL( String( url || '' ), window.location.href );
		const params = [ ...parsed.searchParams.entries() ].sort( ( a, b ) => a[ 0 ] < b[ 0 ] ? -1 : a[ 0 ] > b[ 0 ] ? 1 : 0 );
		const qs = new URLSearchParams( params ).toString();
		return `${ parsed.origin }${ parsed.pathname }${ qs ? `?${ qs }` : '' }`;

	} catch {

		return '';

	}

}

// Build the mapSignature ("map|mods") from a track playUrl so clients can tell
// when a public server's current map differs from their own.
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
// from the board is an ABSOLUTE URL.
// We must NOT use its origin/pathname — the game may be running on a different
// host (CrazyGames iframe, localhost, a custom domain) where that path doesn't
// exist (→ 404 → track never loads). Instead we keep the CURRENT page's pathname
// and carry over ONLY the map + mods query params from the playUrl, then add
// pubServer + play. This works on every deployment.
export function buildServerTrackRedirectUrl( playUrl, serverId ) {

	try {

		const src = new URL( playUrl, window.location.href );
		const map = src.searchParams.get( 'map' ) || '';
		const mods = src.searchParams.get( 'mods' ) || '';
		const out = new URL( window.location.href );
		// Reset query: keep only what we set.
		const params = new URLSearchParams();
		if ( map ) params.set( 'map', map );
		if ( mods && mods !== 'none' ) params.set( 'mods', mods );
		params.set( 'pubServer', String( serverId || '' ) );
		params.set( 'play', '1' );
		return `${ window.location.pathname }?${ params.toString() }${ window.location.hash || ( src.hash || '' ) }`;

	} catch {

		return playUrl;

	}

}
