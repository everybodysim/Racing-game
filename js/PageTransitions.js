/**
 * PageTransitions.js — smooth fade transitions between page loads.
 * Loaded in <head> of every page so the fade-in CSS applies before
 * the body renders (no FOUC).  Internal link clicks trigger a quick
 * fade-out before navigation.  External links and modified clicks
 * (ctrl/meta/shift) are left alone.
 *
 * Embedded / CrazyGames mode: when the game runs inside an iframe
 * (e.g. on CrazyGames, itch.io, or any game portal), opening the game in a
 * new tab would escape the portal's iframe. So in embedded mode every
 * same-origin game-page navigation — whether from `window.open(..., '_blank')`
 * or an `<a target="_blank">` link — is redirected to the CURRENT tab
 * (replacing the page) instead of spawning a new tab. Standalone gameplay
 * (not in an iframe) is left exactly as before. Content URLs that are not
 * game pages (blob:/data:/about:blank media or document popups) keep using
 * real popups so e.g. the video recorder and raw-ghost-code views still work.
 */
( function () {

	'use strict';

	function computeEmbedded() {
		try { return window.self !== window.top; }
		catch ( e ) { return true; } // cross-origin parent access throws → treat as embedded
	}

	var isEmbedded = computeEmbedded();
	var TRACK_PACK_API = 'https://racing-track-board-api.ga1010.workers.dev/api/packs/';

	// True for http(s) URLs that resolve to the same origin as the current page
	// (covers relative links and same-origin absolute URLs). False for external
	// sites, blob:, data:, about:, mailto:, etc.
	function isSameOriginPageUrl( raw ) {
		if ( ! raw || typeof raw !== 'string' ) return false;
		var s = raw.trim();
		if ( ! s || s.charAt( 0 ) === '#' ) return false;
		if ( /^(mailto:|tel:|javascript:|blob:|data:|about:)/i.test( s ) ) return false;
		try {
			var u = new URL( s, window.location.href );
			return ( u.protocol === 'http:' || u.protocol === 'https:' ) && u.origin === window.location.origin;
		} catch ( e ) { return false; }
	}

	function navigateSameTab( url ) {
		if ( document.body && ! document.body.classList.contains( 'skid-leaving' ) ) {
			document.body.classList.add( 'skid-leaving' );
			setTimeout( function () { window.location.href = url; }, 180 );
		} else {
			window.location.href = url;
		}
	}

	var style = document.createElement( 'style' );
	style.textContent =
		'@keyframes skid-page-enter { from { opacity: 0; } to { opacity: 1; } }' +
		'@keyframes skid-page-leave { from { opacity: 1; } to { opacity: 0; } }' +
		'body { animation: skid-page-enter 0.28s ease-out; }' +
		'body.skid-leaving { animation: skid-page-leave 0.18s ease-in forwards; pointer-events: none; }';
	document.head.appendChild( style );

	// Pack tracks are stored server-side under a short 16-character id. The
	// editor normally expects its map data in localStorage, so when an Edit
	// This Track action starts from a ?pack= URL, fetch the pack first and put
	// its map/mod data into the editor's normal storage slots. This avoids ever
	// constructing editor.html?map=<huge payload>, which can trigger HTTP 414.
	async function openPackedTrackInEditor( packId, trigger ) {
		if ( ! packId ) return false;
		var button = trigger && trigger.tagName === 'BUTTON' ? trigger : null;
		var originalText = button ? button.textContent : '';
		if ( button ) {
			button.disabled = true;
			button.textContent = 'Loading track…';
		}
		try {
			var response = await fetch( TRACK_PACK_API + encodeURIComponent( packId ), { cache: 'no-store' } );
			if ( ! response.ok ) throw new Error( 'Pack request failed (' + response.status + ')' );
			var payload = await response.json();
			if ( ! payload || ! payload.ok || ! payload.map ) throw new Error( payload?.error || 'Pack did not contain map data' );
			localStorage.setItem( 'racing-editor-cells', String( payload.map ) );
			localStorage.setItem( 'racing-editor-mods', String( payload.mods || '' ) );
			navigateSameTab( 'editor.html' );
			return true;
		} catch ( error ) {
			if ( button ) {
				button.disabled = false;
				button.textContent = originalText;
			}
			console.warn( 'Could not load packed track into the editor:', error );
			alert( 'Could not load this packed track into the editor. Please try again.' );
			return false;
		}
	}

	// The editor toolbar is mostly organized by what can place a block. Keep
	// the few utility-only controls together instead of burying them inside a
	// placement category. Moving existing DOM nodes preserves their listeners.
	function initEditorUtilityCategory() {
		if ( ! /(^|\/)editor\.html$/i.test( window.location.pathname ) ) return;
		var toolbar = document.getElementById( 'toolbar' );
		if ( ! toolbar || toolbar.querySelector( '[data-cat="tools"]' ) ) return;

		var group = document.createElement( 'div' );
		group.className = 'toolbar-group';
		group.setAttribute( 'aria-label', 'Editor tools' );
		group.setAttribute( 'data-cat', 'tools' );
		var label = document.createElement( 'span' );
		label.className = 'toolbar-group-label';
		label.textContent = 'Tools';
		group.appendChild( label );

		var move = function ( id ) {
			var el = document.getElementById( id );
			if ( el ) group.appendChild( el );
		};
		move( 'btn-rotate' );
		move( 'btn-overlap-toggle' );

		if ( group.children.length > 1 ) toolbar.appendChild( group );
	}

	// In embedded mode, redirect same-origin game-page `window.open` calls
	// (share.html, replay.html, track play URLs, …) to the current tab so the
	// game never pops out of the portal iframe. Content/media popups
	// (blob:/data:/about:blank) are left as real popups.
	if ( isEmbedded ) {
		var origOpen = window.open;
		window.open = function ( url, target, features ) {
			if ( isSameOriginPageUrl( url ) ) {
				navigateSameTab( String( url ) );
				return null;
			}
			return origOpen.apply( window, arguments );
		};
	}

	// Capture packed-track editor navigation before page-specific handlers run.
	// This is important because index.html/tracks.html may already have built a
	// long ?map= link from the packed track by the time the user clicks it.
	document.addEventListener( 'click', function ( e ) {
		if ( e.defaultPrevented || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey ) return;
		var packId = new URLSearchParams( window.location.search ).get( 'pack' );
		if ( ! packId ) return;
		var target = e.target && e.target.closest ? e.target.closest( 'a,button' ) : null;
		if ( ! target ) return;
		var href = target.tagName === 'A' ? ( target.getAttribute( 'href' ) || '' ) : '';
		var isEditorLink = target.id === 'nav-edit-this-track' || /(?:^|\/)editor\.html(?:[?#]|$)/i.test( href );
		if ( ! isEditorLink ) return;
		e.preventDefault();
		e.stopImmediatePropagation();
		openPackedTrackInEditor( packId, target );
	}, true );

	document.addEventListener( 'DOMContentLoaded', function () {
		initEditorUtilityCategory();
	} );

	document.addEventListener( 'click', function ( e ) {

		if ( e.defaultPrevented || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey ) return;
		var link = e.target.closest && e.target.closest( 'a' );
		if ( ! link ) return;
		var href = link.getAttribute( 'href' );
		if ( ! href ) return;
		if ( href.startsWith( '#' ) || href.startsWith( 'mailto:' ) || href.startsWith( 'tel:' ) || href.startsWith( 'javascript:' ) ) return;

		// target="_blank" links: in embedded mode, convert same-origin game
		// pages to same-tab navigation; leave external/modified opens alone.
		if ( link.target === '_blank' ) {
			if ( isEmbedded && isSameOriginPageUrl( href ) ) {
				e.preventDefault();
				navigateSameTab( href );
			}
			return;
		}

		if ( href.startsWith( 'http://' ) || href.startsWith( 'https://' ) ) return;
		if ( document.body.classList.contains( 'skid-leaving' ) ) return;

		e.preventDefault();
		navigateSameTab( href );

	} );

	document.addEventListener( 'DOMContentLoaded', function () {

		if ( document.body ) document.body.classList.remove( 'skid-leaving' );

	} );

	window.addEventListener( 'pageshow', function ( e ) {

		if ( e.persisted ) document.body.classList.remove( 'skid-leaving' );

	} );

	// Expose a tiny API for other scripts / diagnostics.
	window.SkidNav = {
		isEmbedded: isEmbedded,
		isSameOriginPageUrl: isSameOriginPageUrl,
		open: function ( url, target, features ) { return window.open( url, target, features ); }
	};

} )();
