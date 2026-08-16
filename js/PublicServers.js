// Public multiplayer servers client helper.
//
// Provides the predefined public-server list, the deterministic round-timer
// math, the track-share board fetch, and the deterministic track picker. The
// actual UI/loop wiring lives in js/main.js (it reuses the existing PeerJS
// multiplayer session state + DOM).
//
// NOTE: public servers no longer use the racing-servers-api Cloudflare Worker
// for round/rotation/rankings state — all of that is now derived locally from
// wall-clock UTC (the round timer + track rotation are deterministic) or
// distributed peer-to-peer over the existing PeerJS mesh (rankings + member
// count + host election). The only Cloudflare dependency left is the track
// share board worker, which is read-only (GET /api/tracks) and costs zero KV
// writes, so it never trips the free-plan daily write quota.

// The shared track-share board. The deterministic track picker reads this list
// so every player on a given public server computes the SAME track for the same
// cycle. Read-only from the public servers' point of view — it never writes, so
// it costs zero KV writes against the Cloudflare free-plan daily quota.
export const TRACK_BOARD_API = 'https://racing-track-board-api.ga1010.workers.dev/api/tracks';

// 5 minutes of play per round + 5 seconds of rankings before rotating. The
// timer is anchored to wall-clock UTC (see ROUND_EPOCH / CYCLE_MS below), so it
// is always running and can never freeze — it does not depend on a host or on
// when players joined. Because every client derives the cycle from the same
// UTC epoch, the round boundaries are identical for everyone with no
// coordination at all.
export const PLAY_DURATION_MS = 5 * 60 * 1000;
export const RANKINGS_WINDOW_MS = 5 * 1000;
export const CYCLE_MS = PLAY_DURATION_MS + RANKINGS_WINDOW_MS;

// Fixed anchor in the past. All cycle boundaries are computed relative to this,
// so the timer is deterministic and identical for every player regardless of
// when they joined. (Uses UTC — a single global timezone.) Must match the value
// in main.js (it is mirrored there so the local round loop is self-contained).
export const ROUND_EPOCH = Date.UTC( 2026, 0, 1, 0, 0, 0 ); // 2026-01-01T00:00:00Z

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

// Public servers are always "configured" now — they need no backend worker of
// their own. They only need the read-only track share board (which costs zero
// KV writes) and PeerJS's default cloud signalling (free). Kept as a function
// so existing call sites keep compiling.
export function isPublicServerConfigured() {

	return true;

}

// Compute the cycle timing for a given wall-clock `now` (ms since epoch,
// ideally UTC-derived). Pure function — no state, no host, no network. The
// timer can never freeze because it is just math against the real clock. Every
// client calling this with the same `now` gets the same round boundaries.
export function cycleInfo( now ) {

	const sinceEpoch = now - ROUND_EPOCH;
	const cycleIndex = Math.floor( sinceEpoch / CYCLE_MS );
	const cycleStart = ROUND_EPOCH + cycleIndex * CYCLE_MS;
	const playEnd = cycleStart + PLAY_DURATION_MS;
	const cycleEnd = cycleStart + CYCLE_MS;
	// roundId is the cycle index (stable, monotonic, identical for everyone).
	const roundId = cycleIndex;
	// inRankings = the 5s window after play ends, before the next cycle.
	const inRankings = now >= playEnd && now < cycleEnd;
	// roundOver = the next cycle has begun (a new round is active).
	const roundOver = now >= cycleEnd;
	return { roundId, cycleIndex, cycleStart, playEnd, cycleEnd, inRankings, roundOver };

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

// Random track helper (kept for compatibility). Public servers use the
// deterministic pickTrackForCycle so every player agrees without coordination;
// this random helper is only used by other call sites that want a random track.
export async function fetchRandomTrackPlayUrl() {

	const list = await fetchTrackList();
	return list.length ? list[ Math.floor( Math.random() * list.length ) ].playUrl : null;

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
// from wall-clock UTC (see ROUND_EPOCH / cycleInfo), so this is the
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
