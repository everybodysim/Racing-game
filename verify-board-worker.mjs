// Unit tests for the track board Cloudflare Worker (cloudflare/worker/src/index.js)
// using a Map-backed mock KV. Covers the new creator field:
//   - POST with creator -> stored sanitized
//   - POST without creator -> 'Anonymous'
//   - script-tag / oversize creators sanitized
//   - legacy entries without creator survive GET untouched
// Run: node verify-board-worker.mjs
import { readFileSync, writeFileSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const workerSrc = readFileSync( 'cloudflare/worker/src/index.js', 'utf8' );
const tmpDir = mkdtempSync( join( tmpdir(), 'board-worker-' ) );
// Node treats .js as CJS; re-export the real source as ESM verbatim.
writeFileSync( join( tmpDir, 'index.mjs' ), workerSrc );
const worker = ( await import( join( tmpDir, 'index.mjs' ) ) ).default;

class MockKV {
	constructor( seed = {} ) { this.map = new Map( Object.entries( seed ) ); }
	async get( key ) { return this.map.has( key ) ? this.map.get( key ) : null; }
	async put( key, value ) { this.map.set( key, value ); }
	async delete( key ) { this.map.delete( key ); }
}

const b64 = ( v ) => Buffer.from( JSON.stringify( v ) ).toString( 'base64url' );
const ghostCode = b64( {
	url: 'https://everybodysim.github.io/Racing-game/index.html?map=compacttoken&mods=none',
	ghost: { bestLapSeconds: 12.34, samples: [ { t: 0, x: 0, z: 1 }, { t: 1, x: 0, z: 2 } ] },
} );

async function post( env, body ) {
	const res = await worker.fetch( new Request( 'https://w/api/tracks', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify( body ),
	} ), env );
	return { status: res.status, json: await res.json() };
}

let pass = 0, fail = 0;
const check = ( label, cond ) => { cond ? pass ++ : fail ++; console.log( `  ${ cond ? '✓' : '✗' } ${ label }` ); };

// 1. POST with a logged-in creator
{
	const env = { TRACKS_KV: new MockKV(), ADMIN_TOKEN: 'tok' };
	const { status, json } = await post( env, { name: 'T1', ghostCode, creator: '  Speedy   Dave ' } );
	check( 'POST ok', status === 200 && json.ok === true );
	check( 'creator whitespace collapsed', json.entry.creator === 'Speedy Dave' );
	const list = await ( await worker.fetch( new Request( 'https://w/api/tracks' ), env ) ).json();
	check( 'creator persisted through GET', list.entries[ 0 ].creator === 'Speedy Dave' );
}

// 2. POST without creator -> Anonymous
{
	const env = { TRACKS_KV: new MockKV(), ADMIN_TOKEN: 'tok' };
	const { json } = await post( env, { name: 'T2', ghostCode } );
	check( 'missing creator -> Anonymous', json.entry.creator === 'Anonymous' );
	const { json: j2 } = await post( env, { name: 'T3', ghostCode, creator: '   ' } );
	check( 'blank creator -> Anonymous', j2.entry.creator === 'Anonymous' );
}

// 3. Sanitization: script tags stripped, 40+ char names sliced to 32
{
	const env = { TRACKS_KV: new MockKV(), ADMIN_TOKEN: 'tok' };
	const { json } = await post( env, { name: 'T4', ghostCode, creator: '<script>alert(1)</script>Eve' } );
	check( 'script tags stripped', json.entry.creator === 'scriptalert(1)/scriptEve' );
	const { json: j2 } = await post( env, { name: 'T5', ghostCode, creator: 'A'.repeat( 80 ) } );
	check( 'creator sliced to 32 chars', j2.entry.creator.length === 32 );
}

// 4. Legacy entries without creator survive untouched
{
	const legacy = [ { id: 'old-1', name: 'Old', playUrl: 'https://x/?map=abc', viewCount: 5, createdAt: 1 } ];
	const env = { TRACKS_KV: new MockKV( { 'tracks:all': JSON.stringify( legacy ) } ), ADMIN_TOKEN: 'tok' };
	const list = await ( await worker.fetch( new Request( 'https://w/api/tracks' ), env ) ).json();
	check( 'legacy entry still returned', list.entries.length === 1 && list.entries[ 0 ].id === 'old-1' );
	check( 'legacy entry has no creator key', ! ( 'creator' in list.entries[ 0 ] ) );
	const { json } = await post( env, { name: 'New', ghostCode, creator: 'Modern' } );
	const list2 = await ( await worker.fetch( new Request( 'https://w/api/tracks' ), env ) ).json();
	const names = list2.entries.map( ( e ) => e.name );
	check( 'new entry prepended alongside legacy', names.includes( 'New' ) && names.includes( 'Old' ) );
	check( 'new entry keeps its creator', list2.entries.find( ( e ) => e.name === 'New' ).creator === 'Modern' );
}

// 5. Invalid posts still rejected
{
	const env = { TRACKS_KV: new MockKV(), ADMIN_TOKEN: 'tok' };
	const r1 = await post( env, { name: 'X' } );
	check( 'missing ghostCode rejected', r1.status === 400 );
}

console.log( `\nworker creator tests: ${ pass } pass, ${ fail } fail` );
process.exit( fail ? 1 : 0 );
