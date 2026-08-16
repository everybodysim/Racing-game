// Multiplayer hub page logic (multiplayer.html).
// Server-browser UI that talks to the cloudflare-servers worker via
// js/MultiplayerServers.js. Joining a server navigates to index.html?server=<id>,
// which the game picks up via the existing deep-link handler. The hub also hosts
// a global Ably chat preview so the page feels live (server-scoped chat happens
// inside the game once a server is joined).

import * as Servers from './MultiplayerServers.js';

const ACCOUNTS_API_BASE = 'https://racing-account-api.ga1010.workers.dev/api/accounts';
const SESSION_KEY = 'racing-account-session-v1';

// ---- account session (read-only; sign-in happens on index.html) ----
function readSession() {
	try {
		const raw = localStorage.getItem( SESSION_KEY );
		if ( ! raw ) return null;
		const parsed = JSON.parse( raw );
		if ( ! parsed?.token || ! parsed?.username ) return null;
		return parsed;
	} catch { return null; }
}
let session = readSession();

function el( id ) { return document.getElementById( id ); }

function toast( msg, kind = '' ) {
	const t = el( 'toast' );
	if ( ! t ) return;
	t.textContent = msg;
	t.className = 'toast show ' + kind;
	clearTimeout( toast._t );
	toast._t = setTimeout( () => { t.className = 'toast ' + kind; }, 3200 );
}

function esc( s ) {
	return String( s == null ? '' : s ).replace( /[&<>"']/g, ( c ) => ( { '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[ c ] ) );
}

function statusText( id, txt ) {
	const s = el( id );
	if ( s ) s.textContent = txt || '';
}

// ---- tabs ----
const tabs = [ ...document.querySelectorAll( '.tab' ) ];
const panels = [ ...document.querySelectorAll( '.panel' ) ];
function activateTab( name ) {
	tabs.forEach( ( t ) => t.classList.toggle( 'active', t.dataset.tab === name ) );
	panels.forEach( ( p ) => p.classList.toggle( 'active', p.id === 'panel-' + name ) );
	refreshActiveList( name );
}
tabs.forEach( ( t ) => t.addEventListener( 'click', () => activateTab( t.dataset.tab ) ) );

// ---- server list rendering ----
function playerLabel( server ) {
	const count = Number( server.playerCount ) || 0;
	const max = Number( server.maxPlayers ) || 8;
	const cls = count >= max ? 'players full' : ( count === 0 ? 'players empty' : 'players' );
	return `<span class="${ cls }">${ count }/${ max } players</span>`;
}

function joinUrl( server ) {
	return `index.html?server=${ encodeURIComponent( server.serverId ) }`;
}

function renderTempList( servers ) {
	const list = el( 'temp-list' );
	if ( ! list ) return;
	const items = ( servers || [] ).slice().sort( sortServers );
	if ( ! items.length ) {
		list.innerHTML = '<div class="empty-note">No active temporary servers. Create one to get started.</div>';
		return;
	}
	list.innerHTML = items.map( ( s ) => `
		<div class="srv">
			<div><span class="tag temp">Temporary</span></div>
			<div class="name">${ esc( s.name ) }<span class="id">#${ s.serverId }</span></div>
			<div class="meta">${ playerLabel( s ) }${ s.hostUsername ? ` • Host: ${ esc( s.hostUsername ) }` : '' }</div>
			<div class="actions">
				<a class="btn primary" href="${ joinUrl( s ) }">Join</a>
			</div>
		</div>` ).join( '' );
}

function renderPermList( servers ) {
	const list = el( 'perm-list' );
	if ( ! list ) return;
	const me = ( session?.username || '' ).toLowerCase();
	const items = ( servers || [] ).slice().sort( sortServers );
	if ( ! items.length ) {
		list.innerHTML = '<div class="empty-note">No permanent servers yet. Create one to get started.</div>';
		return;
	}
	list.innerHTML = items.map( ( s ) => {
		const owner = String( s.ownerUsername || '' );
		const mine = owner && owner.toLowerCase() === me;
		const online = s.online !== false;
		const tag = online
			? '<span class="tag perm">Online</span>'
			: '<span class="tag offline">Offline</span>';
		const ownerLine = owner
			? `<div class="owner ${ mine ? 'you' : '' }">Owner: ${ esc( owner ) }${ mine ? ' (you)' : '' }</div>`
			: '';
		const manage = mine ? `
			<button class="btn" data-rename="${ s.serverId }">Rename</button>
			<button class="btn danger" data-delete="${ s.serverId }" data-name="${ esc( s.name ) }">Delete</button>` : '';
		const join = online
			? `<a class="btn primary" href="${ joinUrl( s ) }">Join</a>`
			: `<button class="btn" data-start="${ s.serverId }" data-name="${ esc( s.name ) }">Start Session</button>`;
		return `
		<div class="srv">
			<div>${ tag }<span class="tag perm" style="margin-left:6px">Permanent</span></div>
			<div class="name">${ esc( s.name ) }<span class="id">#${ s.serverId }</span></div>
			<div class="meta">${ playerLabel( s ) }</div>
			${ ownerLine }
			<div class="actions">${ join }${ manage }</div>
		</div>`;
	} ).join( '' );

	// wire owner actions
	list.querySelectorAll( '[data-rename]' ).forEach( ( b ) => b.addEventListener( 'click', () => renameServer( Number( b.dataset.rename ) ) ) );
	list.querySelectorAll( '[data-delete]' ).forEach( ( b ) => b.addEventListener( 'click', () => deleteServer( Number( b.dataset.delete ), b.dataset.name ) ) );
	list.querySelectorAll( '[data-start]' ).forEach( ( b ) => b.addEventListener( 'click', () => startPermSession( Number( b.dataset.start ), b.dataset.name ) ) );
}

function sortServers( a, b ) {
	const ap = Number( a.playerCount ) || 0;
	const bp = Number( b.playerCount ) || 0;
	if ( ap !== bp ) return bp - ap; // more players first
	return ( Number( b.updatedAt ) || 0 ) - ( Number( a.updatedAt ) || 0 );
}

async function refreshActiveList( tabName ) {
	if ( ! Servers.serversReady() ) {
		statusText( 'temp-status', 'Servers backend not connected.' );
		statusText( 'perm-status', 'Servers backend not connected.' );
		return;
	}
	const t = tabName || tabs.find( ( x ) => x.classList.contains( 'active' ) )?.dataset.tab;
	try {
		if ( t === 'temp' ) {
			statusText( 'temp-status', 'Refreshing…' );
			const servers = await Servers.listTemporaryServers();
			renderTempList( servers );
			statusText( 'temp-status', `${ ( servers || [] ).length } server(s)` );
		} else if ( t === 'perm' ) {
			statusText( 'perm-status', 'Refreshing…' );
			const servers = await Servers.listPermanentServers();
			renderPermList( servers );
			statusText( 'perm-status', `${ ( servers || [] ).length } server(s)` );
		}
	} catch ( err ) {
		toast( err?.message || 'Failed to load servers.', 'err' );
		statusText( t === 'perm' ? 'perm-status' : 'temp-status', 'Failed to load.' );
	}
}

el( 'temp-refresh' )?.addEventListener( 'click', () => refreshActiveList( 'temp' ) );
el( 'perm-refresh' )?.addEventListener( 'click', () => refreshActiveList( 'perm' ) );

// ---- create temporary ----
el( 'ct-go' )?.addEventListener( 'click', () => {
	const name = String( el( 'ct-name' )?.value || '' ).trim();
	if ( ! name ) { toast( 'Enter a server name first.', 'err' ); return; }
	const max = clampMax( el( 'ct-max' )?.value );
	// The actual room creation happens in the game (needs PeerJS + Firebase).
	// Navigate to the game with create intent; main.js picks up ?createtemp.
	const params = new URLSearchParams();
	params.set( 'createtemp', '1' );
	params.set( 'name', name );
	params.set( 'max', String( max ) );
	window.location.href = 'index.html?' + params.toString();
} );

// ---- create permanent ----
async function refreshCreatePermAuth() {
	const note = el( 'cp-auth-note' );
	const go = el( 'cp-go' );
	if ( session?.token ) {
		if ( note ) note.style.display = 'none';
		if ( go ) go.disabled = false;
	} else {
		if ( note ) { note.style.display = 'block'; note.textContent = 'Sign in to an account to create a permanent server.'; }
		if ( go ) go.disabled = true;
	}
}
el( 'cp-go' )?.addEventListener( 'click', async () => {
	if ( ! session?.token ) { toast( 'Sign in to create a permanent server.', 'err' ); return; }
	const name = String( el( 'cp-name' )?.value || '' ).trim();
	if ( ! name ) { toast( 'Enter a server name first.', 'err' ); return; }
	const max = clampMax( el( 'cp-max' )?.value );
	const btn = el( 'cp-go' );
	btn.disabled = true; btn.textContent = 'Creating…';
	try {
		const server = await Servers.createPermanentServer( { token: session.token, name, settings: { maxPlayers: max } } );
		toast( `Created "${ server.name }" — Server #${ server.serverId }`, 'ok' );
		el( 'cp-name' ).value = '';
		activateTab( 'perm' );
		await refreshActiveList( 'perm' );
	} catch ( err ) {
		toast( err?.message || 'Failed to create server.', 'err' );
	} finally {
		btn.disabled = false; btn.textContent = 'Create';
	}
} );

// ---- owner rename / delete ----
async function renameServer( serverId ) {
	const newName = window.prompt( 'New server name (1–40 chars):' );
	if ( newName == null ) return;
	const trimmed = String( newName ).trim();
	if ( ! trimmed ) { toast( 'Name was empty.', 'err' ); return; }
	try {
		await Servers.renamePermanentServer( serverId, { token: session.token, name: trimmed } );
		toast( 'Renamed.', 'ok' );
		await refreshActiveList( 'perm' );
	} catch ( err ) { toast( err?.message || 'Rename failed.', 'err' ); }
}

async function deleteServer( serverId, name ) {
	if ( ! window.confirm( `Delete permanent server "${ name }" (#${ serverId })? This cannot be undone.` ) ) return;
	try {
		await Servers.deletePermanentServer( serverId, { token: session.token } );
		toast( 'Server deleted.', 'ok' );
		await refreshActiveList( 'perm' );
	} catch ( err ) { toast( err?.message || 'Delete failed.', 'err' ); }
}

// Start a live session on an offline permanent server (host flow in-game).
function startPermSession( serverId, name ) {
	const params = new URLSearchParams();
	params.set( 'server', String( serverId ) );
	params.set( 'host', '1' );
	params.set( 'name', name || '' );
	window.location.href = 'index.html?' + params.toString();
}

// ---- join by code ----
el( 'jc-go' )?.addEventListener( 'click', () => {
	const code = String( el( 'jc-input' )?.value || '' ).trim().toUpperCase();
	if ( ! /^[A-Z0-9]{6}$/.test( code ) ) { toast( 'Enter a valid 6-character code.', 'err' ); return; }
	window.location.href = 'index.html?joinRoom=' + encodeURIComponent( code );
} );
el( 'jc-input' )?.addEventListener( 'keypress', ( e ) => { if ( e.key === 'Enter' ) el( 'jc-go' ).click(); } );

function clampMax( v ) {
	let n = Number( v );
	if ( ! Number.isFinite( n ) ) n = 8;
	n = Math.max( 2, Math.min( 16, Math.round( n ) ) );
	return n;
}

// ---- me bar ----
function renderMeBar() {
	const name = el( 'me-name' );
	const login = el( 'me-login' );
	if ( session?.username ) {
		if ( name ) name.innerHTML = `Signed in as <b>${ esc( session.username ) }</b>`;
		if ( login ) login.textContent = 'Switch account';
	} else {
		if ( name ) name.textContent = 'Not signed in';
		if ( login ) login.textContent = 'Sign in / Create account';
	}
}
el( 'me-login' )?.addEventListener( 'click', () => { window.location.href = 'index.html?openaccount=1'; } );

// Cross-tab: if the user signs in/out in another tab, refresh.
window.addEventListener( 'storage', ( e ) => {
	if ( e.key === SESSION_KEY ) { session = readSession(); renderMeBar(); refreshCreatePermAuth(); }
} );

// ---- global chat preview (Ably) ----
// The hub shows the existing GLOBAL chat only (server chat lives in the game).
// Reuses the same channel as index.html so messages are shared.
const ABLY_KEY = 'kbFfcw.zJJN7Q:gkQ0QImXKGlMS_rgQxn2DGUHssQd0zRefhfgDjFwDm';
const GLOBAL_CHAT_CHANNEL = 'global-chat';
let ably = null;
let chatChannel = null;

function setupChat() {
	if ( typeof Ably === 'undefined' ) return;
	const wrap = el( 'hub-chat' );
	if ( wrap ) wrap.style.display = 'block';
	try {
		ably = new Ably.Realtime( ABLY_KEY );
		chatChannel = ably.channels.get( GLOBAL_CHAT_CHANNEL );
		chatChannel.subscribe( ( msg ) => addChatMessage( msg.data ) );
		chatChannel.history( { limit: 30 }, ( err, result ) => {
			if ( err ) return;
			( result.items || [] ).reverse().forEach( ( m ) => addChatMessage( m.data ) );
		} );
	} catch ( err ) { console.warn( 'Hub chat init failed', err ); }
}

function addChatMessage( text ) {
	const box = el( 'chat-messages' );
	if ( ! box ) return;
	text = String( text || '' );
	// Skip club-tagged messages (same convention as index.html).
	if ( /^\[[^\]]+\](?:\[(?:owner|announce)\])?\s/.test( text ) ) return;
	const div = document.createElement( 'div' );
	div.className = 'chat-msg';
	div.innerText = text;
	box.appendChild( div );
	box.scrollTop = box.scrollHeight;
	while ( box.childElementCount > 80 ) box.removeChild( box.firstChild );
}

function enableChatInput() {
	const input = el( 'chat-input' );
	const send = el( 'chat-send' );
	if ( ! input || ! send ) return;
	if ( session?.username ) {
		input.disabled = false; send.disabled = false;
		input.placeholder = 'Type a message…';
	}
	send.addEventListener( 'click', sendChat );
	input.addEventListener( 'keypress', ( e ) => { if ( e.key === 'Enter' ) sendChat(); } );
}

function sendChat() {
	const input = el( 'chat-input' );
	if ( ! input || ! input.value.trim() ) return;
	if ( ! session?.username ) { toast( 'Sign in to chat.', 'err' ); return; }
	const msg = `${ session.username }: ${ input.value.trim() }`;
	chatChannel.publish( 'message', msg );
	input.value = '';
}

// ---- deep links the hub itself responds to ----
// ?server=<id>      -> jump to game (handy if someone lands on the hub)
// ?picktrack=<id>    -> (reserved for host track picker; future)
(function applyDeepLinks() {
	const params = new URLSearchParams( window.location.search );
	const sv = params.get( 'server' );
	if ( sv && /^\d+$/.test( sv ) ) {
		window.location.replace( 'index.html?server=' + encodeURIComponent( sv ) );
		return;
	}
	const tab = params.get( 'tab' );
	if ( tab && [ 'temp','perm','create-temp','create-perm','join-code' ].includes( tab ) ) {
		activateTab( tab );
	}
} )();

// ---- boot ----
renderMeBar();
refreshCreatePermAuth();
setupChat();
enableChatInput();
refreshActiveList( 'temp' );
// Gentle auto-refresh of the visible list.
setInterval( () => {
	const active = tabs.find( ( t ) => t.classList.contains( 'active' ) )?.dataset.tab;
	if ( active === 'temp' || active === 'perm' ) refreshActiveList( active );
}, 15000 );
