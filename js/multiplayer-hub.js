// Multiplayer hub page logic (multiplayer.html).
// Server-browser UI that talks to the cloudflare-servers worker via
// js/MultiplayerServers.js. Joining a server navigates to
// index.html?play=1&server=<id>, which the game picks up via the existing
// deep-link handler. The hub itself has NO chat — chat lives in index.html and
// auto-switches to the server's scoped channel when a server is joined.

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

// Verify the stored token is still valid server-side. Returns true if valid,
// false otherwise (and clears the stale session so the UI updates).
async function verifySessionFresh() {
	if ( ! session?.token ) return false;
	try {
		const res = await fetch( `${ ACCOUNTS_API_BASE }/profile?token=${ encodeURIComponent( session.token ) }` );
		if ( ! res.ok ) { clearStaleSession(); return false; }
		const payload = await res.json();
		if ( ! payload?.ok ) { clearStaleSession(); return false; }
		return true;
	} catch { return false; } // network error — don't clear, just deny this op
}

function clearStaleSession() {
	try { localStorage.removeItem( SESSION_KEY ); } catch {}
	session = null;
	renderMeBar();
	refreshCreatePermAuth();
}

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

// Build a game URL that ALWAYS enters play mode (play=1) so the home menu does
// not cover the screen and the deep-link action is visible.
function gameUrl( params ) {
	const q = new URLSearchParams( params );
	q.set( 'play', '1' );
	return 'index.html?' + q.toString();
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
	// Always play=1 so the game scene is visible + the join deep-link fires.
	return gameUrl( { server: String( server.serverId ) } );
}

function renderTempList( servers ) {
	const list = el( 'temp-list' );
	if ( ! list ) return;
	const items = ( servers || [] ).slice().sort( sortServers );
	if ( ! items.length ) {
		list.innerHTML = '<div class="empty-note">No active temporary servers. Create one to get started.</div>';
		return;
	}
	list.innerHTML = items.map( ( s ) => {
		const full = ( Number( s.playerCount ) || 0 ) >= ( Number( s.maxPlayers ) || 8 );
		const join = full
			? '<button class="btn" disabled>Full</button>'
			: `<a class="btn primary" href="${ joinUrl( s ) }">Join</a>`;
		return `
		<div class="srv">
			<div><span class="tag temp">Temporary</span></div>
			<div class="name">${ esc( s.name ) }<span class="id">#${ s.serverId }</span></div>
			<div class="meta">${ playerLabel( s ) }${ s.hostUsername ? ` • Host: ${ esc( s.hostUsername ) }` : '' }</div>
			<div class="actions">${ join }</div>
		</div>`;
	} ).join( '' );
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
		const full = online && ( Number( s.playerCount ) || 0 ) >= ( Number( s.maxPlayers ) || 8 );
		const join = ! online
			? ( mine
				? `<button class="btn primary" data-start="${ s.serverId }" data-name="${ esc( s.name ) }">Start Session</button>`
				: '<span class="hint" style="font:700 12px sans-serif;color:var(--muted)">Offline — owner must start it</span>' )
			: ( full
				? '<button class="btn" disabled>Full</button>'
				: `<a class="btn primary" href="${ joinUrl( s ) }">Join</a>` );
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
	window.location.href = gameUrl( { createtemp: '1', name, max: String( max ) } );
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
		// Verify the token is still valid before hitting the servers worker
		// (which would otherwise return a vague "Authentication required").
		const fresh = await verifySessionFresh();
		if ( ! fresh ) {
			toast( 'Your session has expired. Please sign in again, then retry.', 'err' );
			window.location.href = 'settings.html';
			return;
		}
		const server = await Servers.createPermanentServer( { token: session.token, name, settings: { maxPlayers: max } } );
		toast( `Created "${ server.name }" — Server #${ server.serverId }`, 'ok' );
		el( 'cp-name' ).value = '';
		activateTab( 'perm' );
		await refreshActiveList( 'perm' );
	} catch ( err ) {
		const msg = String( err?.message || '' );
		if ( /authentication required/i.test( msg ) ) {
			toast( 'Authentication failed. Your session may have expired — signing you back in…', 'err' );
			clearStaleSession();
			setTimeout( () => { window.location.href = 'settings.html'; }, 1200 );
		} else {
			toast( msg || 'Failed to create server.', 'err' );
		}
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
	if ( ! ( await ensureFreshSession() ) ) return;
	try {
		await Servers.renamePermanentServer( serverId, { token: session.token, name: trimmed } );
		toast( 'Renamed.', 'ok' );
		await refreshActiveList( 'perm' );
	} catch ( err ) { toast( err?.message || 'Rename failed.', 'err' ); }
}

async function deleteServer( serverId, name ) {
	if ( ! window.confirm( `Delete permanent server "${ name }" (#${ serverId })? This cannot be undone.` ) ) return;
	if ( ! ( await ensureFreshSession() ) ) return;
	try {
		await Servers.deletePermanentServer( serverId, { token: session.token } );
		toast( 'Server deleted.', 'ok' );
		await refreshActiveList( 'perm' );
	} catch ( err ) { toast( err?.message || 'Delete failed.', 'err' ); }
}

// Common guard: verify the session is still valid before an owner-only op.
// Returns true if ok, false (and redirects to sign-in) if expired.
async function ensureFreshSession() {
	if ( ! session?.token ) { toast( 'Sign in first.', 'err' ); window.location.href = 'settings.html'; return false; }
	const fresh = await verifySessionFresh();
	if ( ! fresh ) {
		toast( 'Your session has expired. Please sign in again.', 'err' );
		window.location.href = 'settings.html';
		return false;
	}
	return true;
}

// Start a live session on an offline permanent server (host flow in-game).
function startPermSession( serverId, name ) {
	// play=1 + host=1 so the game enters play mode and rehosts the server.
	window.location.href = gameUrl( { server: String( serverId ), host: '1', name: name || '' } );
}

// ---- join by code (existing flow, preserved) ----
el( 'jc-go' )?.addEventListener( 'click', () => {
	const code = String( el( 'jc-input' )?.value || '' ).trim().toUpperCase();
	if ( ! /^[A-Z0-9]{6}$/.test( code ) ) { toast( 'Enter a valid 6-character code.', 'err' ); return; }
	// play=1 so the game loads + the join deep-link fires visibly.
	window.location.href = gameUrl( { joinRoom: code } );
} );
el( 'jc-input' )?.addEventListener( 'keypress', ( e ) => { if ( e.key === 'Enter' ) el( 'jc-go' ).click(); } );

// ---- host by code (classic host flow, now on the hub) ----
el( 'hc-go' )?.addEventListener( 'click', () => {
	const name = String( el( 'hc-name' )?.value || '' ).trim();
	// hostcode=1 triggers the classic Host flow in main.js (generates a room
	// code, starts PeerJS host). play=1 so the game is visible.
	const params = { hostcode: '1' };
	if ( name ) params.name = name;
	window.location.href = gameUrl( params );
} );

// ---- switch map (host launches game on a specific track) ----
el( 'sm-go' )?.addEventListener( 'click', () => {
	const raw = String( el( 'sm-input' )?.value || '' ).trim();
	if ( ! raw ) { toast( 'Paste a track URL or share code first.', 'err' ); return; }
	const params = parseTrackInput( raw );
	if ( ! params ) { toast( 'Could not read that track URL/code.', 'err' ); return; }
	// Host a fresh room on this map. hostcode=1 + map so the game hosts on load.
	params.hostcode = '1';
	window.location.href = gameUrl( params );
} );

// Accept a full URL (extract its map/mods/pack params) or a bare share code.
function parseTrackInput( raw ) {
	try {
		// Full URL?
		if ( /https?:\/\//i.test( raw ) ) {
			const u = new URL( raw );
			const out = {};
			for ( const k of [ 'map', 'mods', 'pack', 'localPack', 'sharedPack' ] ) {
				const v = u.searchParams.get( k );
				if ( v ) out[ k ] = v;
			}
			if ( out.map ) return out;
		}
		// Bare share code (track-board short code) -> let the game resolve it.
		if ( /^[A-Za-z0-9_-]{4,32}$/.test( raw ) ) return { map: raw };
	} catch { /* fall through */ }
	return null;
}

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
// Account management lives in the game (mode-menu account tab) or settings.html.
// We deep-link there and dismiss the home menu via play=1 is NOT used (that
// starts a race); instead we go to settings.html which has its own account UI.
el( 'me-login' )?.addEventListener( 'click', () => {
	if ( session?.username ) {
		// Switch account -> the account panel in-game.
		window.location.href = 'index.html?openaccount=1&play=1';
	} else {
		// Sign in -> settings.html cloud tab (has the full account UI).
		window.location.href = 'settings.html';
	}
} );

// Cross-tab: if the user signs in/out in another tab, refresh.
window.addEventListener( 'storage', ( e ) => {
	if ( e.key === SESSION_KEY ) { session = readSession(); renderMeBar(); refreshCreatePermAuth(); }
} );

// ---- deep links the hub itself responds to ----
// ?server=<id>      -> jump to game (handy if someone lands on the hub)
(function applyDeepLinks() {
	const params = new URLSearchParams( window.location.search );
	const sv = params.get( 'server' );
	if ( sv && /^\d+$/.test( sv ) ) {
		window.location.replace( gameUrl( { server: sv } ) );
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
refreshActiveList( 'temp' );
// Gentle auto-refresh of the visible list.
setInterval( () => {
	const active = tabs.find( ( t ) => t.classList.contains( 'active' ) )?.dataset.tab;
	if ( active === 'temp' || active === 'perm' ) refreshActiveList( active );
}, 15000 );
