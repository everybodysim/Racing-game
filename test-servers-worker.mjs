// In-process validation of the multiplayer servers worker.
// Stubs env.SERVERS_KV as an in-memory Map and stubs the accounts-worker
// fetch (token verification) so we can exercise create/list/join/capacity/
// rename/delete/ID-allocation without deploying anything.
import worker from './cloudflare-servers/worker/src/index.js';

function makeKv() {
	const store = new Map();
	return {
		async get( key ) { return store.has( key ) ? store.get( key ) : null; },
		async put( key, val ) { store.set( key, val ); },
		async delete( key ) { store.delete( key ); },
	};
}

const TOKEN = 'goodtoken';
// Stub global fetch so resolveAccountUsername resolves the token to a username.
globalThis.fetch = async ( url ) => {
	if ( String( url ).includes( '/api/accounts/profile?token=' ) ) {
		const t = String( url ).split( 'token=' )[ 1 ];
		if ( t === TOKEN ) {
			return new Response( JSON.stringify( { ok: true, username: 'Racer1' } ), { status: 200, headers: { 'Content-Type': 'application/json' } } );
		}
		return new Response( JSON.stringify( { ok: false, error: 'Invalid' } ), { status: 401 } );
	}
	return new Response( 'not found', { status: 404 } );
};

let pass = 0, fail = 0;
function check( cond, msg ) { if ( cond ) { pass++; } else { fail++; console.log( '  FAIL:', msg ); } }

async function call( env, method, path, body ) {
	const opts = { method };
	if ( body !== undefined ) {
		opts.body = JSON.stringify( body );
		opts.headers = { 'Content-Type': 'application/json' };
	}
	const req = new Request( `https://x/api/servers${ path }`, opts );
	const res = await worker.fetch( req, env );
	return { status: res.status, json: await res.json() };
}

async function main() {
	const env = { SERVERS_KV: makeKv() };

	// 1. List empty.
	let r = await call( env, 'GET', '/permanent' );
	check( r.status === 200 && r.json.servers.length === 0, 'empty permanent list' );

	// 2. Create permanent server (auth required).
	r = await call( env, 'POST', '/permanent', { name: 'Drift Kings' } );
	check( r.status === 401, 'create permanent without token rejected' );

	r = await call( env, 'POST', '/permanent', { token: TOKEN, name: 'Drift Kings' } );
	check( r.status === 201 && r.json.server.serverId === 1, 'first permanent server gets id 1' );
	check( r.json.server.name === 'Drift Kings', 'server name stored' );
	check( r.json.server.ownerUsername === 'Racer1', 'owner attributed' );
	const s1 = r.json.server.serverId;

	// 3. Second server gets id 2 (sequential).
	r = await call( env, 'POST', '/permanent', { token: TOKEN, name: 'Speed Squad' } );
	check( r.status === 201 && r.json.server.serverId === 2, 'second server gets id 2' );

	// 4. Empty/invalid name rejected.
	r = await call( env, 'POST', '/permanent', { token: TOKEN, name: '   ' } );
	check( r.status === 400, 'empty name rejected' );
	r = await call( env, 'POST', '/permanent', { token: TOKEN, name: 'a'.repeat( 50 ) } );
	check( r.status === 201 && r.json.server.name.length === 40, 'overlong name truncated to max length' );

	// 5. Name sanitization strips control chars + collapses whitespace.
	r = await call( env, 'POST', '/permanent', { token: TOKEN, name: '  Hello\tWorld\n ' } );
	check( r.json.server.name === 'Hello World', 'name sanitized' );

	// 6. Duplicate names allowed.
	r = await call( env, 'POST', '/permanent', { token: TOKEN, name: 'Drift Kings' } );
	check( r.status === 201, 'duplicate name allowed' );

	// 7. Temporary server creation.
	r = await call( env, 'POST', '/temporary', { name: 'Quick Race', roomCode: 'ABC123', mapSignature: 'default|none', hostUsername: 'Host', hostClientId: 'c1' } );
	check( r.status === 201 && r.json.server.serverId === 6, 'temp server gets next sequential id' );
	const tId = r.json.server.serverId;
	check( r.json.server.playerCount === 1, 'temp host counts as 1 player' );

	// 8. Join enforces capacity server-side.
	r = await call( env, 'POST', `/${ tId }/join`, { username: 'P2', clientId: 'c2' } );
	check( r.status === 200 && r.json.server.playerCount === 2, 'join succeeds, count 2' );
	r = await call( env, 'POST', `/${ tId }/join`, { username: 'P2b', clientId: 'c2' } );
	check( r.json.server.playerCount === 2, 're-join by same clientId is idempotent' );

	// 9. Capacity: create a 2-player temp server, fill it, then reject.
	r = await call( env, 'POST', '/temporary', { name: 'Duo', roomCode: 'DUO001', settings: { maxPlayers: 2 }, hostClientId: 'h' } );
	const duo = r.json.server.serverId;
	await call( env, 'POST', `/${ duo }/join`, { username: 'J1', clientId: 'j1' } );
	r = await call( env, 'POST', `/${ duo }/join`, { username: 'J2', clientId: 'j2' } );
	check( r.status === 409, 'full server rejects 3rd joiner (capacity server-side)' );

	// 10. Heartbeat refreshes + returns player list.
	r = await call( env, 'POST', `/${ tId }/heartbeat`, { clientId: 'c2', username: 'P2' } );
	check( r.status === 200 && Array.isArray( r.json.server.players ), 'heartbeat returns player list' );

	// 11. Leave reduces count; temp server dies when empty+stale-ish (leave alone doesn't kill until no players).
	r = await call( env, 'POST', `/${ tId }/leave`, { clientId: 'c2' } );
	check( r.status === 200, 'leave ok' );

	// 12. Rename owner-only.
	r = await call( env, 'POST', `/${ s1 }/rename`, { token: 'badtoken', name: 'Hacked' } );
	check( r.status === 401, 'rename with bad token rejected' );
	r = await call( env, 'POST', `/${ s1 }/rename`, { token: TOKEN, name: 'Drift Legends' } );
	check( r.status === 200 && r.json.server.name === 'Drift Legends', 'rename by owner works' );

	// 13. Delete owner-only + removes from list.
	r = await call( env, 'DELETE', `/${ s1 }`, { token: 'badtoken' } );
	check( r.status === 401, 'delete with bad token rejected' );
	r = await call( env, 'DELETE', `/${ s1 }`, { token: TOKEN } );
	check( r.status === 200, 'delete by owner works' );
	r = await call( env, 'GET', '/permanent' );
	check( ! r.json.servers.some( ( s ) => s.serverId === s1 ), 'deleted server gone from list' );

	// 14. Chat authorization: only session members can post.
	r = await call( env, 'POST', `/${ tId }/chat`, { clientId: 'outsider', username: 'X', content: 'hi' } );
	check( r.status === 403, 'non-member cannot post chat' );
	r = await call( env, 'POST', `/${ tId }/chat`, { clientId: 'c1', username: 'Host', content: 'hello racers' } );
	check( r.status === 200, 'member can post chat' );
	r = await call( env, 'GET', `/${ tId }/chat` );
	check( r.json.messages.length === 1 && r.json.messages[ 0 ].content === 'hello racers', 'chat history persisted' );

	// 15. Join a non-existent server.
	r = await call( env, 'POST', '/9999/join', { username: 'P', clientId: 'z' } );
	check( r.status === 404, 'join non-existent server returns 404' );

	// 16. Invalid server id route.
	r = await call( env, 'GET', '/notanumber' );
	check( r.status === 404, 'non-numeric id returns 404' );

	// 17. getServer works for a temporary (session-only, no def) server.
	r = await call( env, 'GET', `/${ tId }` );
	check( r.status === 200 && r.json.server.serverId === tId && r.json.server.roomCode === 'ABC123', 'getServer returns temp session (no def)' );

	// 18. Host can rehost (change track) — non-host cannot.
	r = await call( env, 'POST', `/${ tId }/rehost`, { clientId: 'c2', roomCode: 'ROOM2B', mapSignature: 'mapB|sig' } );
	check( r.status === 403, 'non-host cannot rehost' );
	r = await call( env, 'POST', `/${ tId }/rehost`, { clientId: 'c1', roomCode: 'ROOM2B', mapSignature: 'mapB|sig' } );
	check( r.status === 200 && r.json.server.roomCode === 'ROOM2B' && r.json.server.mapSignature === 'mapB|sig', 'host rehost updates room + map' );
	r = await call( env, 'GET', `/${ tId }` );
	check( r.json.server.roomCode === 'ROOM2B', 'rehosted room visible to getServer' );
	r = await call( env, 'POST', `/${ tId }/rehost`, { clientId: 'c1', roomCode: '', mapSignature: '' } );
	check( r.status === 400, 'rehost rejects empty room/map' );

	console.log( `\n${ pass } passed, ${ fail } failed` );
	process.exit( fail ? 1 : 0 );
}
main().catch( ( e ) => { console.error( e ); process.exit( 1 ); } );
