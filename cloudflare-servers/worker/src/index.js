// Public Racing Servers API (Cloudflare Worker + KV).
//
// Stores synced round/rotation state + per-round best-lap rankings for the
// "public servers" feature in the multiplayer widget (index.html).
//
// KV binding: SERVERS_KV
// KV keys:
//   servers:index        → JSON array of { id, name, code, memberCount }
//   server:<id>          → JSON full server state (round, members, laps, host)
//
// Public servers are predefined (see PREDEFINED_SERVERS). They are lazily
// initialized on first access via ensureServer().

const KV_SERVER_PREFIX = 'server:';
const KV_INDEX = 'servers:index';

const ROUND_DURATION_MS = 5 * 60 * 1000;   // 5 minutes per round.
const RANKINGS_WINDOW_MS = 5 * 1000;        // 5 seconds of rankings before rotate.
const HOST_STALE_MS = 15 * 1000;            // host heartbeat staleness threshold.
const MEMBER_STALE_MS = 30 * 1000;          // members pruned after this.

// The fixed public servers. `code` is the shared 6-char PeerJS room code
// (matches /^[A-Z0-9]{6}$/) — every player in a server connects to the same
// PeerJS room (host peer id `RACE-ROOM-<code>`).
const PREDEFINED_SERVERS = [
	{ id: 'na-1', name: 'North America', code: 'PUBNA1' },
	{ id: 'eu-1', name: 'Europe', code: 'PUBEU1' },
	{ id: 'as-1', name: 'Asia', code: 'PUBAS1' },
];

const SERVER_BY_ID = new Map( PREDEFINED_SERVERS.map( ( s ) => [ s.id, s ] ) );

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

			const nextMatch = url.pathname.match( /^\/api\/servers\/([^/]+)\/next-round$/ );
			if ( nextMatch && request.method === 'POST' ) {
				return withCors( await nextRound( decodeURIComponent( nextMatch[ 1 ] ), request, env ) );
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
		round: {
			roundId: 1,
			startAt: now,
			durationMs: ROUND_DURATION_MS,
			trackPlayUrl: '',
			trackMapSignature: 'default|none',
			laps: {},
		},
		updatedAt: now,
	};
}

async function saveServer( state, env ) {
	state.updatedAt = Date.now();
	await env.SERVERS_KV.put( KV_SERVER_PREFIX + state.id, JSON.stringify( state ) );
	await refreshIndex( env );
	return state;
}

async function refreshIndex( env ) {
	const summaries = [];
	for ( const def of PREDEFINED_SERVERS ) {
		const raw = await env.SERVERS_KV.get( KV_SERVER_PREFIX + def.id );
		let memberCount = 0;
		if ( raw ) {
			try { memberCount = Object.keys( JSON.parse( raw ).members || {} ).length; } catch {}
		}
		summaries.push( { id: def.id, name: def.name, code: def.code, memberCount } );
	}
	await env.SERVERS_KV.put( KV_INDEX, JSON.stringify( summaries ) );
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
		out.push( {
			id: state.id,
			name: state.name,
			code: state.code,
			memberCount: Object.keys( state.members ).length,
			roundEndAt: Number( state.round.startAt ) + Number( state.round.durationMs ),
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
	// If no live host, this joiner claims host.
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
	pruneMembers( state, now );
	if ( ! state.members[ clientId ] ) state.members[ clientId ] = { name: cleanName( payload?.name ), lastSeenAt: now };
	let isHost = false;
	if ( ! isHostFresh( state, now ) ) {
		state.hostId = clientId;
		state.hostHeartbeatAt = now;
		isHost = true;
	} else {
		isHost = state.hostId === clientId;
	}
	await saveServer( state, env );
	return json( { ok: true, server: publicView( state, now ), isHost } );
}

async function heartbeat( id, request, env ) {
	const state = await loadServer( id, env );
	if ( ! state ) return json( { ok: false, error: 'Unknown server' }, 404 );
	const payload = await readJson( request );
	const clientId = cleanId( payload?.clientId );
	if ( ! clientId ) return json( { ok: false, error: 'clientId required' }, 400 );
	const now = Date.now();
	pruneMembers( state, now );
	state.members[ clientId ] = { name: cleanName( payload?.name ), lastSeenAt: now };
	// If no live host, this heartbeat claims the seat so the server is never
	// host-less (keeps the PeerJS host peer alive for joiners).
	if ( ! isHostFresh( state, now ) ) {
		state.hostId = clientId;
		state.hostHeartbeatAt = now;
	} else if ( state.hostId === clientId ) {
		state.hostHeartbeatAt = now;
	}
	await saveServer( state, env );
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
	pruneMembers( state, now );
	const laps = state.round.laps || ( state.round.laps = {} );
	const existing = laps[ clientId ];
	if ( ! existing || time < Number( existing.time ) ) {
		laps[ clientId ] = { name, time, updatedAt: now };
	}
	await saveServer( state, env );
	return json( { ok: true, server: publicView( state, now ), isHost: state.hostId === clientId } );
}

async function nextRound( id, request, env ) {
	const state = await loadServer( id, env );
	if ( ! state ) return json( { ok: false, error: 'Unknown server' }, 404 );
	const payload = await readJson( request );
	const clientId = cleanId( payload?.clientId );
	if ( ! clientId ) return json( { ok: false, error: 'clientId required' }, 400 );
	const now = Date.now();
	pruneMembers( state, now );
	if ( state.hostId !== clientId ) return json( { ok: false, error: 'only host can advance round' }, 403 );
	// Only allow advancement once the round + rankings window have elapsed.
	const roundEndAt = Number( state.round.startAt ) + Number( state.round.durationMs );
	if ( now < roundEndAt + RANKINGS_WINDOW_MS - 500 ) {
		return json( { ok: false, error: 'round not over yet', roundEndAt, now }, 409 );
	}
	const trackPlayUrl = String( payload?.trackPlayUrl || '' ).slice( 0, 2000 );
	const trackMapSignature = String( payload?.trackMapSignature || 'default|none' ).slice( 0, 200 );
	state.round = {
		roundId: Number( state.round.roundId || 1 ) + 1,
		startAt: now,
		durationMs: ROUND_DURATION_MS,
		trackPlayUrl,
		trackMapSignature,
		laps: {},
	};
	await saveServer( state, env );
	return json( { ok: true, server: publicView( state, now ), isHost: true } );
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

function publicView( state, now ) {
	const round = state.round || {};
	const roundEndAt = Number( round.startAt ) + Number( round.durationMs );
	const inRankings = now >= roundEndAt && now < roundEndAt + RANKINGS_WINDOW_MS;
	const roundOver = now >= roundEndAt + RANKINGS_WINDOW_MS;
	return {
		id: state.id,
		name: state.name,
		code: state.code,
		hostId: state.hostId,
		hostHeartbeatAt: state.hostHeartbeatAt,
		members: state.members,
		memberCount: Object.keys( state.members ).length,
		round: {
			roundId: round.roundId,
			startAt: round.startAt,
			durationMs: round.durationMs,
			trackPlayUrl: round.trackPlayUrl,
			trackMapSignature: round.trackMapSignature,
			laps: round.laps || {},
		},
		roundEndAt,
		inRankings,
		roundOver,
		rankingsEndAt: roundEndAt + RANKINGS_WINDOW_MS,
		now,
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
