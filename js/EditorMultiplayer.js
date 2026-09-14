// Collaborative track editing over PeerJS — the Multiplayer Editor mod.
//
// Activated ONLY when the 'multiplayer-editor' mod is installed (the
// activation check lives at the bottom of editor.html's main module and
// hands this module a small bridge to the editor internals). While the
// mod is installed, the minimap is replaced by the same Host / Join /
// ROOM CODE multiplayer panel the game uses.
//
// Topology: the host owns the peer id EDITOR-ROOM-<code> (a dedicated
// prefix so editor rooms never collide with the game's RACE-ROOM- ids);
// joiners connect straight to it. Every edit broadcasts the FULL
// cells+mods state pair — the exact strings share URLs and undo snapshots
// use — and peers apply it through loadEncodedState, a normal in-editor
// load with no page reload. Last writer wins: for a few players building
// a track together this is self-healing and needs no merge logic.
//
// Presence, on top of map sync:
//  - Remote test-drive cars: while a peer drives, their car is streamed
//    (position + quaternion at 12.5 Hz) and rendered live in your
//    editor, smoothly lerped between packets.
//  - Placement previews: each peer's hovered cell + active tool are
//    streamed, so you see a transparent colored ghost of where their
//    block would land (red when they're erasing) with a floating name
//    tag. Ghosts fade out when a peer's cursor goes idle.
//
// The mod is inert in the game itself — it does not modify gameplay, so
// leaderboard submissions are unaffected.

import Peer from 'https://esm.sh/peerjs@1.5.5?bundle';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const PEER_CONFIG = { config: { iceServers: [ { urls: 'stun:stun.l.google.com:19302' } ] } };
const ROOM_PREFIX = 'EDITOR-ROOM-';
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const BROADCAST_DEBOUNCE_MS = 120;
const PRESENCE_TICK_MS = 80;          // 12.5 Hz presence stream
const CURSOR_IDLE_HIDE_MS = 4000;     // hide a peer's ghost if their mouse went idle

let api = null;
let session = null;       // { role: 'host' | 'join', code, peer, conns: Map, hostConn, players: Map }
let applying = false;     // a remote apply must not rebroadcast as a local edit
let knownKey = '';        // last-known local state key (per-peer stable encoding)
let pendingBroadcast = null;
let broadcastTimer = 0;
let carTemplate = null;   // cloned per remote player
const remotes = new Map(); // peerId -> { color, cursor: {...}, car: {...} }
let lastHoverKey = '';
let wasDriving = false;
let presenceTimer = 0;
let rafId = 0;

function playerName() { return api?.playerName?.() || 'Anonymous'; }

function genCode() {

	let code = '';
	for ( let i = 0; i < 6; i ++ ) code += CODE_ALPHABET[ Math.floor( Math.random() * CODE_ALPHABET.length ) ];
	return code;

}

function statusText( text ) {

	const el = document.getElementById( 'mped-status' );
	if ( el ) el.textContent = text || '';

}

function renderPlayers() {

	const list = document.getElementById( 'mped-players' );
	if ( ! list || ! session ) return;
	list.textContent = '';
	const entries = [ ...session.players.entries() ];
	for ( const [ id, name ] of entries ) {

		const li = document.createElement( 'li' );
		const dot = document.createElement( 'span' );
		dot.textContent = '●';
		dot.style.color = peerColor( id );
		dot.style.marginRight = '4px';
		li.appendChild( dot );
		li.appendChild( document.createTextNode( name + ( session.role === 'host' && id === 'host' ? ' (host)' : '' ) ) );
		list.appendChild( li );

	}

}

function safeSend( conn, packet ) {

	if ( ! conn ) return;
	try { conn.send( packet ); } catch ( error ) { console.warn( '[Multiplayer Editor] send failed', error ); }

}

function stateKey( cells, mods ) { return cells + '|' + mods; }

// ─── Presence visuals ────────────────────────────────────────────────

function peerColor( peerId ) {

	let hash = 0;
	const s = String( peerId || '' );
	for ( let i = 0; i < s.length; i ++ ) hash = ( hash * 31 + s.charCodeAt( i ) ) >>> 0;
	return '#' + new THREE.Color().setHSL( ( hash % 360 ) / 360, 0.85, 0.6 ).getHexString();

}

function toolLabel( type, erase ) {

	if ( erase ) return 'erasing';
	const t = String( type || '' ).replace( /^(track|overlay|surface|pad)-/, '' ).replace( /-/g, ' ' );
	return t || 'block';

}

function makeNameSprite( text, colorHex ) {

	const canvas = document.createElement( 'canvas' );
	canvas.width = 256;
	canvas.height = 64;
	const ctx = canvas.getContext( '2d' );
	ctx.fillStyle = 'rgba(8,12,18,0.82)';
	ctx.beginPath();
	ctx.roundRect( 4, 8, 248, 48, 12 );
	ctx.fill();
	ctx.strokeStyle = colorHex;
	ctx.lineWidth = 3;
	ctx.stroke();
	ctx.fillStyle = '#fff';
	ctx.font = '700 26px system-ui, sans-serif';
	ctx.textAlign = 'center';
	ctx.textBaseline = 'middle';
	ctx.fillText( String( text ).slice( 0, 18 ), 128, 33 );
	const texture = new THREE.CanvasTexture( canvas );
	const sprite = new THREE.Sprite( new THREE.SpriteMaterial( { map: texture, transparent: true, depthTest: false } ) );
	sprite.scale.set( 4.4, 1.1, 1 );
	return sprite;

}

function remoteEntry( peerId, name ) {

	let entry = remotes.get( peerId );
	if ( entry ) return entry;
	entry = { color: peerColor( peerId ), name: name || 'Anonymous', cursor: null, car: null };
	remotes.set( peerId, entry );
	return entry;

}

function removePeerVisuals( peerId ) {

	const entry = remotes.get( peerId );
	if ( ! entry ) return;
	const scene = api?.getScene?.();
	if ( entry.cursor ) { if ( scene ) scene.remove( entry.cursor.group ); disposeGroup( entry.cursor.group ); entry.cursor = null; }
	if ( entry.car ) { if ( scene ) scene.remove( entry.car.group ); entry.car = null; }
	remotes.delete( peerId );

}

function disposeGroup( group ) {

	group?.traverse( ( child ) => {

		if ( child.isMesh || child.isSprite ) {

			child.material?.dispose?.();
			if ( child.geometry && ! child.geometry.__sharedCar ) child.geometry.dispose?.();

		}

	} );

}

function ensureCarTemplate() {

	if ( carTemplate ) return Promise.resolve();
	return new Promise( ( resolve ) => {

		new GLTFLoader().load( 'models/vehicle-truck-yellow.glb', ( gltf ) => {

			// Same fixes the editor's own drive loader applies: front-side
			// materials and the Godot 0.5 root scale.
			gltf.scene.traverse( ( child ) => { if ( child.isMesh ) child.material.side = THREE.FrontSide; } );
			gltf.scene.scale.setScalar( 0.5 );
			carTemplate = gltf.scene;
			resolve();

		}, undefined, () => resolve() );

	} );

}

function updateRemoteCursor( peerId, packet ) {

	const entry = remoteEntry( peerId, packet.name );
	const scene = api?.getScene?.();
	if ( ! scene ) return;
	if ( ! entry.cursor ) {

		const cell = 7.5; // CELL_RAW * GRID_SCALE — full editor cell in world units
		const group = new THREE.Group();
		const box = new THREE.Mesh(
			new THREE.BoxGeometry( cell * 0.96, cell * 0.22, cell * 0.96 ),
			new THREE.MeshStandardMaterial( { color: entry.color, emissive: entry.color, emissiveIntensity: 0.35, transparent: true, opacity: 0.32, depthWrite: false } )
		);
		box.position.y = cell * 0.11;
		group.add( box );
		const label = makeNameSprite( `${ entry.name } · ${ toolLabel( packet.type, packet.erase ) }`, entry.color );
		label.position.y = cell * 0.55;
		group.add( label );
		scene.add( group );
		entry.cursor = { group, box, label, peerId };

	}
	const [ x, , z ] = api.cellCenter( packet.gx, packet.gz );
	entry.cursor.group.position.set( x, 0, z );
	entry.cursor.box.material.color.set( packet.erase ? '#ff5340' : entry.color );
	entry.cursor.box.material.emissive.set( packet.erase ? '#8f1a10' : entry.color );
	entry.cursor.label.material.map.dispose();
	entry.cursor.label.material.map = makeNameSprite( `${ entry.name } · ${ toolLabel( packet.type, packet.erase ) }`, entry.color ).material.map;
	entry.cursor.label.material.needsUpdate = true;
	entry.cursor.lastAt = Date.now();
	entry.cursor.gx = packet.gx;
	entry.cursor.gz = packet.gz;

}

function hideRemoteCursor( peerId ) {

	const entry = remotes.get( peerId );
	if ( entry?.cursor ) { removePeerVisuals( peerId ); }

}

function updateRemoteCar( peerId, packet ) {

	const entry = remoteEntry( peerId, packet.name );
	const scene = api?.getScene?.();
	if ( ! scene ) return;
	if ( packet.off ) {

		if ( entry.car ) { scene.remove( entry.car.group ); entry.car = null; }
		return;

	}
	if ( ! entry.car ) {

		const group = new THREE.Group();
		if ( carTemplate ) group.add( carTemplate.clone( true ) );
		else { ensureCarTemplate().then( () => { if ( entry.car && ! entry.car.group.children.length && carTemplate ) entry.car.group.add( carTemplate.clone( true ) ); } ); }
		const label = makeNameSprite( entry.name, entry.color );
		label.position.y = 2.6;
		group.add( label );
		group.position.fromArray( packet.p );
		group.quaternion.fromArray( packet.q );
		scene.add( group );
		entry.car = { group, targetP: new THREE.Vector3().fromArray( packet.p ), targetQ: new THREE.Quaternion().fromArray( packet.q ), lastAt: Date.now() };

	}
	entry.car.targetP.fromArray( packet.p );
	entry.car.targetQ.fromArray( packet.q );
	entry.car.lastAt = Date.now();

}

function presenceLoop() {

	if ( presenceTimer ) return;
	presenceTimer = setInterval( () => {

		if ( ! session ) return;
		// Test-drive pose
		let pose = null;
		try { pose = window.__skidEditorDrive?.getVehiclePose?.() || null; } catch { pose = null; }
		if ( pose ) {

			wasDriving = true;
			sendPacket( { t: 'car', p: pose.p, q: pose.q } );

		} else if ( wasDriving ) {

			wasDriving = false;
			sendPacket( { t: 'car', off: true } );

		}
		// Hover placement preview
		const hover = api?.getHoverState?.();
		if ( hover ) {

			const key = `${ hover.gx },${ hover.gz },${ hover.type },${ hover.orient },${ hover.erase }`;
			if ( key !== lastHoverKey ) {

				lastHoverKey = key;
				sendPacket( { t: 'cursor', ...hover, name: playerName() } );

			}

		} else if ( lastHoverKey ) {

			lastHoverKey = '';
			sendPacket( { t: 'cursor', off: true } );

		}

	}, PRESENCE_TICK_MS );
	// Smooth remote cars + hide idle cursors.
	const tick = () => {

		rafId = requestAnimationFrame( tick );
		const now = Date.now();
		for ( const [ , entry ] of remotes ) {

			if ( entry.car ) {

				entry.car.group.position.lerp( entry.car.targetP, 0.3 );
				entry.car.group.quaternion.slerp( entry.car.targetQ, 0.3 );

			}
			if ( entry.cursor && now - entry.cursor.lastAt > CURSOR_IDLE_HIDE_MS ) hideRemoteCursor( entry.cursor.peerId || '' );

		}

	};
	rafId = requestAnimationFrame( tick );

}

function sendPacket( packet ) {

	if ( ! session ) return;
	if ( session.role === 'host' ) { for ( const conn of session.conns.values() ) safeSend( conn, packet ); }
	else if ( session.hostConn ) safeSend( session.hostConn, packet );

}

// ─── Map sync ────────────────────────────────────────────────────────

function broadcastRoster() {

	if ( ! session || session.role !== 'host' ) return;
	const roster = { t: 'roster', players: Object.fromEntries( session.players ) };
	for ( const conn of session.conns.values() ) safeSend( conn, roster );

}

async function applyRemote( packet ) {

	if ( ! packet || typeof packet.cells !== 'string' || ! packet.cells ) return;
	if ( applying ) return; // one in-flight apply at a time — last writer wins
	applying = true;
	try {

		await api.applyState( packet.cells, packet.mods || '' );

	} catch ( error ) {

		console.warn( '[Multiplayer Editor] failed to apply remote state', error );

	} finally {

		applying = false;

	}

}

function handlePacket( packet, conn ) {

	if ( ! session || ! packet || typeof packet !== 'object' ) return;
	if ( packet.t === 'hello' ) {

		if ( session.role === 'host' ) {

			session.players.set( conn.peer, String( packet.name || 'Anonymous' ).slice( 0, 24 ) || 'Anonymous' );
			renderPlayers();
			broadcastRoster();

		}

	} else if ( packet.t === 'state' ) {

		if ( session.role === 'host' ) for ( const c of session.conns.values() ) if ( c !== conn ) safeSend( c, packet );
		applyRemote( packet );

	} else if ( packet.t === 'car' ) {

		if ( session.role === 'host' ) for ( const c of session.conns.values() ) if ( c !== conn ) safeSend( c, packet );
		updateRemoteCar( conn.peer, packet );

	} else if ( packet.t === 'cursor' ) {

		if ( session.role === 'host' ) for ( const c of session.conns.values() ) if ( c !== conn ) safeSend( c, packet );
		if ( packet.off ) hideRemoteCursor( conn.peer );
		else updateRemoteCursor( conn.peer, packet );

	} else if ( packet.t === 'roster' ) {

		if ( session.role === 'join' ) {

			try { session.players = new Map( Object.entries( packet.players || {} ) ); } catch { /* ignore */ }
			renderPlayers();

		}

	} else if ( packet.t === 'bye' ) {

		if ( session.role === 'host' ) {

			session.players.delete( conn.peer );
			session.conns.delete( conn.peer );
			removePeerVisuals( conn.peer );
			renderPlayers();
			broadcastRoster();

		} else {

			// The host left gracefully — tear down immediately instead of
			// waiting for the data channel to notice.
			statusText( 'Host left the room.' );
			leave();

		}

	}

}

// Called by the editor's save() on EVERY local save (edits and autosave).
function onLocalSave( cells, mods ) {

	if ( ! session ) return;
	const key = stateKey( cells, mods );
	if ( applying ) {

		knownKey = key;
		return;

	}
	if ( ! pendingBroadcast && key === knownKey ) return; // autosave echo — nothing changed
	pendingBroadcast = { cells, mods };
	clearTimeout( broadcastTimer );
	broadcastTimer = setTimeout( () => {

		if ( ! session || ! pendingBroadcast ) return;
		const packet = { t: 'state', cells: pendingBroadcast.cells, mods: pendingBroadcast.mods, name: playerName() };
		knownKey = stateKey( pendingBroadcast.cells, pendingBroadcast.mods );
		pendingBroadcast = null;
		if ( session.role === 'host' ) { for ( const conn of session.conns.values() ) safeSend( conn, packet ); }
		else if ( session.hostConn ) safeSend( session.hostConn, packet );

	}, BROADCAST_DEBOUNCE_MS );

}

export function leave() {

	if ( ! session ) return;
	const current = session;
	session = null;
	applying = false;
	pendingBroadcast = null;
	clearTimeout( broadcastTimer );
	try {

		if ( current.role === 'host' ) { for ( const conn of current.conns.values() ) safeSend( conn, { t: 'bye' } ); }
		else if ( current.hostConn ) safeSend( current.hostConn, { t: 'bye' } );

	} catch { /* ignore */ }
	for ( const peerId of [ ...remotes.keys() ] ) removePeerVisuals( peerId );
	try { current.peer.destroy(); } catch { /* ignore */ }
	const leaveBtn = document.getElementById( 'mped-leave-btn' );
	if ( leaveBtn ) leaveBtn.style.display = 'none';
	for ( const id of [ 'mped-host-btn', 'mped-join-btn' ] ) {

		const btn = document.getElementById( id );
		if ( btn ) btn.style.display = '';

	}
	const list = document.getElementById( 'mped-players' );
	if ( list ) list.textContent = '';
	statusText( '' );

}

export function host( code = genCode() ) {

	if ( session ) leave();
	const peer = new Peer( ROOM_PREFIX + code, PEER_CONFIG );
	session = { role: 'host', code, peer, conns: new Map(), hostConn: null, players: new Map( [ [ 'host', playerName() ] ] ) };
	peer.on( 'open', () => {

		const input = document.getElementById( 'mped-code-input' );
		if ( input ) input.value = code;
		statusText( `Hosting room ${ code } — share the code.` );
		renderPlayers();

	} );
	peer.on( 'error', ( error ) => {

		statusText( `Room error: ${ error?.message || error }` );
		leave();

	} );
	peer.on( 'connection', ( conn ) => {

		conn.on( 'open', () => {

			if ( ! session || session.role !== 'host' ) return;
			session.conns.set( conn.peer, conn );
			// The joiner immediately gets the host's current map — applied
			// with a normal in-editor load, never a reload.
			const state = api.getState();
			safeSend( conn, { t: 'state', cells: state.cells, mods: state.mods } );
			broadcastRoster();

		} );
		conn.on( 'data', ( packet ) => handlePacket( packet, conn ) );
		conn.on( 'close', () => {

			if ( ! session || session.role !== 'host' ) return;
			session.conns.delete( conn.peer );
			session.players.delete( conn.peer );
			removePeerVisuals( conn.peer );
			renderPlayers();
			broadcastRoster();

		} );

	} );
	const leaveBtn = document.getElementById( 'mped-leave-btn' );
	if ( leaveBtn ) leaveBtn.style.display = '';
	for ( const id of [ 'mped-host-btn', 'mped-join-btn' ] ) {

		const btn = document.getElementById( id );
		if ( btn ) btn.style.display = 'none';

	}
	return code;

}

export function join( code ) {

	const clean = String( code || '' ).trim().toUpperCase();
	if ( ! /^[A-Z0-9]{4,10}$/.test( clean ) ) {

		statusText( 'Enter a valid room code first.' );
		return false;

	}
	if ( session ) leave();
	const peer = new Peer( undefined, PEER_CONFIG );
	session = { role: 'join', code: clean, peer, conns: new Map(), hostConn: null, players: new Map() };
	statusText( `Connecting to room ${ clean }...` );
	peer.on( 'open', () => {

		if ( ! session || session.role !== 'join' ) return;
		const conn = peer.connect( ROOM_PREFIX + clean, { reliable: true } );
		conn.on( 'open', () => {

			if ( ! session || session.role !== 'join' ) return;
			session.hostConn = conn;
			safeSend( conn, { t: 'hello', name: playerName() } );
			statusText( `Connected to room ${ clean } — loading the host's map.` );

		} );
		conn.on( 'data', ( packet ) => handlePacket( packet, conn ) );
		conn.on( 'close', () => {

			if ( session && session.role === 'join' ) {

				statusText( 'Host left the room.' );
				leave();

			}

		} );
		conn.on( 'error', ( error ) => statusText( `Connection error: ${ error?.message || error }` ) );

	} );
	peer.on( 'error', ( error ) => {

		statusText( `Room error: ${ error?.message || error }` );
		leave();

	} );
	const leaveBtn = document.getElementById( 'mped-leave-btn' );
	if ( leaveBtn ) leaveBtn.style.display = '';
	for ( const id of [ 'mped-host-btn', 'mped-join-btn' ] ) {

		const btn = document.getElementById( id );
		if ( btn ) btn.style.display = 'none';

	}
	return true;

}

function info() {

	if ( ! session ) return { active: false };
	return {
		active: true,
		role: session.role,
		code: session.code,
		connected: session.role === 'host' ? session.conns.size : ( session.hostConn ? 1 : 0 ),
		players: [ ...session.players.values() ],
		remotes: [ ...remotes.entries() ].map( ( [ id, entry ] ) => ( {
			id,
			cursor: entry.cursor ? { gx: entry.cursor.gx, gz: entry.cursor.gz } : null,
			car: entry.car ? { p: entry.car.group.position.toArray() } : null,
		} ) ),
	};

}

function buildPanel() {

	if ( document.getElementById( 'mped-panel' ) ) return;
	const style = document.createElement( 'style' );
	// Mirrors the game's #mp-panel styling (index.html) — "the exact same
	// UI as in the normal game", docked where the minimap lived.
	style.textContent = `
		#mped-panel { position: absolute; left: 12px; top: 70px; z-index: 15; width: 210px; box-sizing: border-box; background: rgba(8,12,18,0.88); border: 1px solid rgba(255,255,255,0.18); border-radius: 10px; padding: 10px; color: #fff; font: 13px/1.3 sans-serif; backdrop-filter: blur(2px); box-shadow: 0 4px 20px rgba(0,0,0,0.45); }
		#mped-title { font: 700 13px/1 sans-serif; margin-bottom: 8px; opacity: 0.95; }
		#mped-actions { display: flex; gap: 6px; margin-bottom: 8px; }
		#mped-actions button { border: none; border-radius: 6px; background: rgba(255,255,255,0.16); color: #fff; padding: 6px 9px; font: 600 12px/1 sans-serif; cursor: pointer; }
		#mped-actions button:hover { background: rgba(255,255,255,0.27); }
		#mped-code-row { display: flex; gap: 6px; align-items: center; margin-bottom: 8px; }
		#mped-code-input { flex: 1; min-width: 0; border-radius: 6px; border: 1px solid rgba(255,255,255,0.24); background: rgba(20,20,20,0.45); color: #fff; padding: 6px 8px; font: 700 12px/1 monospace; text-transform: uppercase; }
		#mped-copy-btn { border: none; border-radius: 6px; background: rgba(83,212,255,0.25); color: #fff; padding: 6px 8px; font: 600 12px/1 sans-serif; cursor: pointer; }
		#mped-copy-btn:hover { background: rgba(83,212,255,0.4); }
		#mped-status { display: none; color: #ffe9a9; font: 600 12px/1.3 sans-serif; text-shadow: 0 1px 3px rgba(0,0,0,0.8); }
		#mped-status:not(:empty) { display: block; }
		#mped-players { display: none; margin: 8px 0 0; padding: 8px 0 0 0; list-style: none; border-top: 1px solid rgba(255,255,255,0.18); max-height: 120px; overflow: auto; font: 600 11px/1.35 sans-serif; }
		#mped-players:not(:empty) { display: block; }
	`;
	document.head.appendChild( style );
	const panel = document.createElement( 'div' );
	panel.id = 'mped-panel';
	panel.innerHTML = `
		<div id="mped-title">Multiplayer Editor</div>
		<div id="mped-actions">
			<button id="mped-host-btn" type="button">Host</button>
			<button id="mped-join-btn" type="button">Join</button>
			<button id="mped-leave-btn" type="button" style="display:none;">Leave</button>
		</div>
		<div id="mped-code-row">
			<input id="mped-code-input" type="text" maxlength="6" placeholder="ROOM CODE" aria-label="Room code">
			<button id="mped-copy-btn" type="button">Copy</button>
		</div>
		<div id="mped-status" aria-live="polite"></div>
		<ol id="mped-players"></ol>
	`;
	document.body.appendChild( panel );
	document.getElementById( 'mped-host-btn' ).addEventListener( 'click', () => host() );
	document.getElementById( 'mped-join-btn' ).addEventListener( 'click', () => join( document.getElementById( 'mped-code-input' ).value ) );
	document.getElementById( 'mped-leave-btn' ).addEventListener( 'click', () => leave() );
	document.getElementById( 'mped-copy-btn' ).addEventListener( 'click', async () => {

		const input = document.getElementById( 'mped-code-input' );
		try { await navigator.clipboard.writeText( input.value || '' ); statusText( 'Code copied!' ); }
		catch { input.select(); }

	} );
	// Leaving the page should not strand peers.
	window.addEventListener( 'beforeunload', () => { try { leave(); } catch { /* ignore */ } } );

}

export function activateEditorMultiplayer( editorApi ) {

	api = editorApi;
	buildPanel();
	api.setBroadcast( onLocalSave );
	presenceLoop();
	// The minimap is rarely used; the multiplayer panel takes its place
	// while the mod is installed.
	const wrap = document.getElementById( 'minimap-wrap' );
	if ( wrap ) wrap.style.display = 'none';
	window.__EDITOR_MP__ = { host, join, leave, info };

}
