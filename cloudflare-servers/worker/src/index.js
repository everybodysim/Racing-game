// Public Racing Servers API (Cloudflare Worker + KV).
//
// Stores synced round/rotation state + per-round best-lap rankings for the
// "public servers" feature in the multiplayer widget (index.html).
//
// KV binding: SERVERS_KV
// KV keys:
//   server:<id>          → JSON full server state (members, host, laps, tracks)
//
// (There is no `servers:index` key — the summary list is built live by
// listServers() from each server's state, which it reads anyway. Rewriting an
// index on every save used to double the write count and was a major cause of
// blowing through the Cloudflare KV free-plan daily write quota.)
//
// Public servers are predefined (see PREDEFINED_SERVERS). They are lazily
// initialized on first access via ensureServer().
//
// ROUND TIMING IS HOST-INDEPENDENT AND ALWAYS RUNNING.
// The round/cycle boundary is derived PURELY from wall-clock UTC time, split
// into fixed chunks anchored to ROUND_EPOCH. No host "starts" a round, no
// client advances it — the boundary is math, so it can never freeze or get
// stuck. Any player (not just the host) may set the track for an upcoming
// cycle (first-writer-wins), so the rotation keeps working even if the host
// disappears.

const KV_SERVER_PREFIX = 'server:';

// A cycle = 5 minutes of play + 5 seconds of rankings, then the next cycle.
const PLAY_DURATION_MS = 5 * 60 * 1000;    // 5 minutes of racing.
const RANKINGS_WINDOW_MS = 5 * 1000;       // 5 seconds of rankings before rotate.
const CYCLE_MS = PLAY_DURATION_MS + RANKINGS_WINDOW_MS; // 305000 ms per cycle.

// Fixed anchor in the past. All cycle boundaries are computed relative to this,
// so the timer is deterministic and identical for every player regardless of
// when they joined. (Uses UTC — a single global timezone, as requested.)
const ROUND_EPOCH = Date.UTC( 2026, 0, 1, 0, 0, 0 ); // 2026-01-01T00:00:00Z

const HOST_STALE_MS = 45 * 1000;            // host heartbeat staleness threshold.
const MEMBER_STALE_MS = 120 * 1000;         // members pruned after this.
const MAX_TRACK_CYCLES = 24;                // cap stored per-cycle tracks.
// Coalesce windows: a heartbeat only PERSISTS the member's lastSeenAt / the
// host's hostHeartbeatAt when the previously-stored value is older than this.
// This is the key write-amplification fix — without it every 4–12s heartbeat
// wrote a fresh KV put (≈1800 puts/hour/player) and exhausted the Cloudflare KV
// free-plan daily write quota (1000/day) in well under a day. With coalescing a
// single idle player writes roughly once a minute, and only when state actually
// changed (host reclaim / member prune / stale liveness refresh).
const MEMBER_LASTSEEN_REFRESH_MS = 60 * 1000;   // refresh lastSeenAt when > this old.
const HOST_HEARTBEAT_REFRESH_MS = 30 * 1000;    // refresh hostHeartbeatAt when > this old.

// The fixed public servers. `code` is the shared 6-char PeerJS room code
// (matches /^[A-Z0-9]{6}$/) — every player in a server connects to the same
// PeerJS room (host peer id `RACE-ROOM-<code>`).
const PREDEFINED_SERVERS = [
	{ id: 'server-1', name: 'Server 1', code: 'PUBSV1' },
	{ id: 'server-2', name: 'Server 2', code: 'PUBSV2' },
	{ id: 'server-3', name: 'Server 3', code: 'PUBSV3' },
];

const SERVER_BY_ID = new Map( PREDEFINED_SERVERS.map( ( s ) => [ s.id, s ] ) );

// Compute the cycle timing for a given wall-clock `now`. Pure function — no
// state, no host, no KV. The timer can never freeze because it is just math
// against the real clock.
function cycleInfo( now ) {

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

export default {
	async fetch( request, env ) {
		const url = new URL( request.url );
		if ( request.method === 'OPTIONS' ) return withCors( new Response( null, { status: 204 } ) );

		try {
			if ( url.pathname === '/api/servers' && request.method === 'GET' ) {
				return withCors( await listServers( env ) );
			}

			const serverMatch = url.pathname.match( /^\/api\/servers\/([^/]+)$/ );
			if ( serverMatch ) {
				const id = decodeURIComponent( serverMatch[ 1 ] );
				if ( request.method === 'GET' ) return withCors( await getServer( id, env ) );
				if ( request.method === 'POST' ) return withCors( await joinServer( id, request, env ) );
			}

			const joinMatch = url.pathname.match( /^\/api\/servers\/([^/]+)\/join$/ );
			if ( joinMatch && request.method === 'POST' ) {
				return withCors( await joinServer( decodeURIComponent( joinMatch[ 1 ] ), request, env ) );
			}

			const claimMatch = url.pathname.match( /^\/api\/servers\/([^/]+)\/claim-host$/ );
			if ( claimMatch && request.method === 'POST' ) {
				return withCors( await claimHost( decodeURIComponent( claimMatch[ 1 ] ), request, env ) );
			}

			const heartbeatMatch = url.pathname.match( /^\/api\/servers\/([^/]+)\/heartbeat$/ );
			if ( heartbeatMatch && request.method === 'POST' ) {
				return withCors( await heartbeat( decodeURIComponent( heartbeatMatch[ 1 ] ), request, env ) );
			}

			const lapMatch = url.pathname.match( /^\/api\/servers\/([^/]+)\/lap$/ );
			if ( lapMatch && request.method === 'POST' ) {
				return withCors( await submitLap( decodeURIComponent( lapMatch[ 1 ] ), request, env ) );
			}

			// Any player may set the track for a cycle (first-writer-wins). This is
			// NOT a host-only action — it keeps the rotation working even if the
			// (hidden) host peer disappears. `cycleIndex` selects which cycle the
			// track applies to (typically the NEXT one, set during rankings).
			const setTrackMatch = url.pathname.match( /^\/api\/servers\/([^/]+)\/set-track$/ );
			if ( setTrackMatch && request.method === 'POST' ) {
				return withCors( await setTrack( decodeURIComponent( setTrackMatch[ 1 ] ), request, env ) );
			}

			const leaveMatch = url.pathname.match( /^\/api\/servers\/([^/]+)\/leave$/ );
			if ( leaveMatch && request.method === 'POST' ) {
				return withCors( await leaveServer( decodeURIComponent( leaveMatch[ 1 ] ), request, env ) );
			}

			return withCors( json( { ok: false, error: 'Not found' }, 404 ) );
		} catch ( err ) {
			return withCors( json( { ok: false, error: String( err?.message || err || 'server-error' ) }, 500 ) );
		}
	},
};

function withCors( response ) {
	const headers = new Headers( response.headers );
	headers.set( 'Access-Control-Allow-Origin', '*' );
	headers.set( 'Access-Control-Allow-Methods', 'GET,POST,OPTIONS' );
	headers.set( 'Access-Control-Allow-Headers', 'Content-Type' );
	return new Response( response.body, { status: response.status, headers } );
}

function json( value, status = 200 ) {
	return new Response( JSON.stringify( value ), {
		status,
		headers: { 'Content-Type': 'application/json' },
	} );
}

async function loadServer( id, env ) {
	const def = SERVER_BY_ID.get( id );
	if ( ! def ) return null;
	const raw = await env.SERVERS_KV.get( KV_SERVER_PREFIX + id );
	if ( raw ) {
		try { return JSON.parse( raw ); } catch { /* fall through to init */ }
	}
	return initServer( def );
}

function initServer( def ) {
	const now = Date.now();
	return {
		id: def.id,
		name: def.name,
		code: def.code,
		hostId: '',
		hostHeartbeatAt: 0,
		members: {},
		// Laps keyed by cycle index: { [cycleIndex]: { [clientId]: {name,time} } }.
		// Tracks keyed by cycle index: { [cycleIndex]: {playUrl,sig,setAt} }.
		laps: {},
		tracks: {},
		updatedAt: now,
	};
}

// Persist a server state. This is the ONLY place a `server:<id>` KV put for
// full-state happens. NOTE: there is intentionally NO `refreshIndex()` here —
// the `servers:index` summary used to be rewritten on every save (doubling the
// write count for every operation), but `listServers()` already builds the
// summaries live by reading each server, so the index key is redundant. Dropping
// it HALVES the total KV writes and was a major contributor to blowing through
// the Cloudflare KV free-plan daily write quota (1000/day).
async function saveServer( state, env ) {
	state.updatedAt = Date.now();
	// Prune old per-cycle laps/tracks so the stored blob stays bounded.
	pruneCycleData( state );
	await env.SERVERS_KV.put( KV_SERVER_PREFIX + state.id, JSON.stringify( state ) );
	return state;
}

// Keep only the most recent MAX_TRACK_CYCLES cycles of laps + tracks. The
// current cycle is always retained (computed from wall-clock).
function pruneCycleData( state ) {

	const info = cycleInfo( Date.now() );
	const keepFrom = info.cycleIndex - MAX_TRACK_CYCLES;
	if ( state.laps ) {
		for ( const k of Object.keys( state.laps ) ) {
			if ( Number( k ) < keepFrom ) delete state.laps[ k ];
		}
	}
	if ( state.tracks ) {
		for ( const k of Object.keys( state.tracks ) ) {
			if ( Number( k ) < keepFrom ) delete state.tracks[ k ];
		}
	}

}

function pruneMembers( state, now ) {
	let changed = false;
	for ( const [ cid, m ] of Object.entries( state.members ) ) {
		if ( now - ( Number( m.lastSeenAt ) || 0 ) > MEMBER_STALE_MS ) {
			delete state.members[ cid ];
			changed = true;
		}
	}
	// If the host member disappeared (or host heartbeat is stale), release host.
	if ( state.hostId && ( ! state.members[ state.hostId ] || now - ( Number( state.hostHeartbeatAt ) || 0 ) > HOST_STALE_MS ) ) {
		state.hostId = '';
		state.hostHeartbeatAt = 0;
		changed = true;
	}
	return changed;
}

function isHostFresh( state, now ) {
	return Boolean( state.hostId )
		&& state.members[ state.hostId ]
		&& ( now - ( Number( state.hostHeartbeatAt ) || 0 ) <= HOST_STALE_MS );
}

async function listServers( env ) {
	const out = [];
	for ( const def of PREDEFINED_SERVERS ) {
		const state = await loadServer( def.id, env );
		const now = Date.now();
		pruneMembers( state, now );
		const info = cycleInfo( now );
		out.push( {
			id: state.id,
			name: state.name,
			code: state.code,
			memberCount: Object.keys( state.members ).length,
			roundEndAt: info.playEnd,
			inRankings: info.inRankings,
		} );
	}
	return json( { ok: true, servers: out } );
}

async function getServer( id, env ) {
	const state = await loadServer( id, env );
	if ( ! state ) return json( { ok: false, error: 'Unknown server' }, 404 );
	const now = Date.now();
	pruneMembers( state, now );
	return json( { ok: true, server: publicView( state, now ) } );
}

async function joinServer( id, request, env ) {
	const state = await loadServer( id, env );
	if ( ! state ) return json( { ok: false, error: 'Unknown server' }, 404 );
	const payload = await readJson( request );
	const clientId = cleanId( payload?.clientId );
	const name = cleanName( payload?.name );
	if ( ! clientId ) return json( { ok: false, error: 'clientId required' }, 400 );
	const now = Date.now();
	pruneMembers( state, now );
	state.members[ clientId ] = { name, lastSeenAt: now };
	// If no live host, this joiner claims host (purely for PeerJS peer-id
	// election — it grants NO extra privileges; everyone is an equal player).
	let claimedHost = false;
	if ( ! isHostFresh( state, now ) ) {
		state.hostId = clientId;
		state.hostHeartbeatAt = now;
		claimedHost = true;
	}
	await saveServer( state, env );
	return json( { ok: true, server: publicView( state, now ), isHost: state.hostId === clientId, claimedHost } );
}

async function claimHost( id, request, env ) {
	const state = await loadServer( id, env );
	if ( ! state ) return json( { ok: false, error: 'Unknown server' }, 404 );
	const payload = await readJson( request );
	const clientId = cleanId( payload?.clientId );
	if ( ! clientId ) return json( { ok: false, error: 'clientId required' }, 400 );
	const now = Date.now();
	const pruned = pruneMembers( state, now );
	if ( ! state.members[ clientId ] ) state.members[ clientId ] = { name: cleanName( payload?.name ), lastSeenAt: now };
	let isHost = false;
	let hostChanged = false;
	if ( ! isHostFresh( state, now ) ) {
		state.hostId = clientId;
		state.hostHeartbeatAt = now;
		isHost = true;
		hostChanged = true;
	} else {
		isHost = state.hostId === clientId;
	}
	// Only persist if the host seat actually changed or members were pruned.
	// If we're already the fresh host and nothing else changed, this is a no-op.
	if ( hostChanged || pruned ) {
		await saveServer( state, env );
	}
	return json( { ok: true, server: publicView( state, now ), isHost } );
}

async function heartbeat( id, request, env ) {
	const state = await loadServer( id, env );
	if ( ! state ) return json( { ok: false, error: 'Unknown server' }, 404 );
	const payload = await readJson( request );
	const clientId = cleanId( payload?.clientId );
	if ( ! clientId ) return json( { ok: false, error: 'clientId required' }, 400 );
	const now = Date.now();
	const pruned = pruneMembers( state, now );
	const prevMember = state.members[ clientId ];
	const prevLastSeen = Number( prevMember?.lastSeenAt ) || 0;
	state.members[ clientId ] = { name: cleanName( payload?.name ), lastSeenAt: now };
	// If no live host, this heartbeat claims the seat so the server is never
	// host-less (keeps the PeerJS host peer alive for joiners). No privileges.
	let hostChanged = false;
	const prevHostHeartbeat = Number( state.hostHeartbeatAt ) || 0;
	if ( ! isHostFresh( state, now ) ) {
		state.hostId = clientId;
		state.hostHeartbeatAt = now;
		hostChanged = true;
	} else if ( state.hostId === clientId ) {
		// We are the host — refresh hostHeartbeatAt, but only persist when it is
		// getting close to stale (coalescing). The in-memory view always reflects
		// `now`; only the KV-stored value is throttled.
		if ( now - prevHostHeartbeat > HOST_HEARTBEAT_REFRESH_MS ) hostChanged = true;
		state.hostHeartbeatAt = now;
	}
	// Decide whether this heartbeat needs to persist. Writing on EVERY heartbeat
	// (the old behaviour) blew through the KV free-plan write quota in hours.
	// We persist only when something material changed:
	//   - the host seat flipped (claimed/reclaimed), or
	//   - members were pruned, or
	//   - this member's persisted lastSeenAt is getting stale (> refresh window),
	//     so it won't be wrongly pruned before the next heartbeat.
	const memberLivenessStale = ( now - prevLastSeen ) > MEMBER_LASTSEEN_REFRESH_MS;
	if ( hostChanged || pruned || memberLivenessStale ) {
		await saveServer( state, env );
	}
	return json( { ok: true, server: publicView( state, now ), isHost: state.hostId === clientId } );
}

async function submitLap( id, request, env ) {
	const state = await loadServer( id, env );
	if ( ! state ) return json( { ok: false, error: 'Unknown server' }, 404 );
	const payload = await readJson( request );
	const clientId = cleanId( payload?.clientId );
	const time = Number( payload?.time );
	const name = cleanName( payload?.name );
	if ( ! clientId || ! Number.isFinite( time ) || time < 0 ) return json( { ok: false, error: 'invalid lap' }, 400 );
	const now = Date.now();
	const pruned = pruneMembers( state, now );
	// Store the lap under the CURRENT cycle index (wall-clock derived). This
	// means laps are always scoped to the right round even if a client's clock
	// drifted slightly — the worker's clock is authoritative.
	const info = cycleInfo( now );
	if ( ! state.laps ) state.laps = {};
	const cycleLaps = state.laps[ info.cycleIndex ] || ( state.laps[ info.cycleIndex ] = {} );
	const existing = cycleLaps[ clientId ];
	let improved = false;
	if ( ! existing || time < Number( existing.time ) ) {
		cycleLaps[ clientId ] = { name, time, updatedAt: now };
		improved = true;
	}
	// Only persist when the lap actually improved OR members were pruned. The old
	// code unconditionally saved on every lap submission (even no-improvement
	// pings), burning a KV write each time.
	if ( improved || pruned ) {
		await saveServer( state, env );
	}
	return json( { ok: true, server: publicView( state, now ), isHost: state.hostId === clientId } );
}

// Any player may set the track for a cycle (first-writer-wins). This replaces
// the old host-only "next-round" advance: because round timing is wall-clock
// based, a round begins automatically — someone just needs to have picked a
// track for it. The first player to set it wins; later attempts are ignored
// (200 ok, alreadySet=true) so there's no conflict/race.
async function setTrack( id, request, env ) {
	const state = await loadServer( id, env );
	if ( ! state ) return json( { ok: false, error: 'Unknown server' }, 404 );
	const payload = await readJson( request );
	const clientId = cleanId( payload?.clientId );
	const cycleIndex = Number( payload?.cycleIndex );
	const playUrl = String( payload?.trackPlayUrl || '' ).slice( 0, 2000 );
	const sig = String( payload?.trackMapSignature || 'default|none' ).slice( 0, 200 );
	if ( ! clientId ) return json( { ok: false, error: 'clientId required' }, 400 );
	if ( ! Number.isFinite( cycleIndex ) ) return json( { ok: false, error: 'invalid cycleIndex' }, 400 );
	if ( ! playUrl ) return json( { ok: false, error: 'trackPlayUrl required' }, 400 );
	const now = Date.now();
	pruneMembers( state, now );
	if ( ! state.tracks ) state.tracks = {};
	let alreadySet = Boolean( state.tracks[ cycleIndex ] );
	if ( ! alreadySet ) {
		state.tracks[ cycleIndex ] = { playUrl, sig, setAt: now, setBy: clientId };
		await saveServer( state, env );
	}
	return json( { ok: true, server: publicView( state, now ), alreadySet } );
}

async function leaveServer( id, request, env ) {
	const state = await loadServer( id, env );
	if ( ! state ) return json( { ok: false, error: 'Unknown server' }, 404 );
	const payload = await readJson( request );
	const clientId = cleanId( payload?.clientId );
	if ( ! clientId ) return json( { ok: false, error: 'clientId required' }, 400 );
	const now = Date.now();
	delete state.members[ clientId ];
	if ( state.hostId === clientId ) {
		state.hostId = '';
		state.hostHeartbeatAt = 0;
	}
	pruneMembers( state, now );
	await saveServer( state, env );
	return json( { ok: true } );
}

// Build the client-facing view. Timing is computed from wall-clock UTC (via
// cycleInfo) so every client sees identical round boundaries regardless of
// host state or join time. `round` exposes the current cycle's track + laps,
// and `nextRound` exposes the upcoming cycle's track (set during rankings).
function publicView( state, now ) {

	const info = cycleInfo( now );
	const tracks = state.tracks || {};
	const laps = state.laps || {};
	const currentTrack = tracks[ info.cycleIndex ] || null;
	const nextCycleIndex = info.cycleIndex + 1;
	const nextTrack = tracks[ nextCycleIndex ] || null;
	const currentLaps = laps[ info.cycleIndex ] || {};
	return {
		id: state.id,
		name: state.name,
		code: state.code,
		hostId: state.hostId,
		hostHeartbeatAt: state.hostHeartbeatAt,
		members: state.members,
		memberCount: Object.keys( state.members ).length,
		now,
		round: {
			roundId: info.roundId,
			cycleIndex: info.cycleIndex,
			trackPlayUrl: currentTrack?.playUrl || '',
			trackMapSignature: currentTrack?.sig || 'default|none',
			laps: currentLaps,
		},
		nextRound: {
			cycleIndex: nextCycleIndex,
			trackPlayUrl: nextTrack?.playUrl || '',
			trackMapSignature: nextTrack?.sig || 'default|none',
			hasTrack: Boolean( nextTrack ),
		},
		// Timing (authoritative — clients should display against these, not their
		// own clock, to stay perfectly in sync).
		cycleStart: info.cycleStart,
		playEnd: info.playEnd,       // == roundEndAt (end of the 5-min play).
		cycleEnd: info.cycleEnd,     // end of the 5s rankings window.
		roundEndAt: info.playEnd,
		rankingsEndAt: info.cycleEnd,
		inRankings: info.inRankings,
		roundOver: info.roundOver,
	};

}

async function readJson( request ) {
	try { return await request.json(); } catch { return {}; }
}

function cleanId( v ) {
	return String( v || '' ).trim().slice( 0, 120 );
}
function cleanName( v ) {
	return String( v || '' ).trim().slice( 0, 40 ) || 'Player';
}
