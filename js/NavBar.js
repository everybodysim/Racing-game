/**
 * NavBar.js — injects a consistent top navigation bar into every sub-page.
 * Reads the current page name from the URL and shows it alongside the brand.
 */
( function () {

	'use strict';

	var PAGE_NAMES = {
		'campaign.html': 'Campaign',
		'clubs.html': 'Clubs',
		'coins.html': 'Coin Leaderboard',
		'competitions.html': 'Competitions',
		'custommods.html': 'Custom Mods Lab',
		'editor.html': 'Track Editor',
		'mods.html': 'Mod Manager',
		'multiplayer.html': 'Multiplayer Hub',
		'replay.html': 'Replay Watcher',
		'settings.html': 'Settings',
		'share.html': 'Share Time',
		'tas-viewer.html': 'TAS Viewer',
		'totd.html': 'Track of the Day',
		'tracks.html': 'Track Browser',
		'weekly-cup.html': 'Weekly Cup',
	};

	var path = location.pathname.split( '/' ).pop() || '';
	var pageName = PAGE_NAMES[ path ] || '';

	function injectNav() {
		var nav = document.createElement( 'nav' );
		nav.className = 'skid-nav';
		nav.setAttribute( 'aria-label', 'Page navigation' );

		var brand = document.createElement( 'a' );
		brand.className = 'skid-nav-brand';
		brand.href = 'index.html';
		brand.textContent = 'Skid Circuit';

		var right = document.createElement( 'div' );
		right.className = 'skid-nav-right';

		if ( pageName ) {
			var label = document.createElement( 'span' );
			label.className = 'skid-nav-page';
			label.textContent = pageName;
			right.appendChild( label );
		}

		var back = document.createElement( 'a' );
		back.className = 'skid-nav-link skid-nav-back';
		back.href = 'index.html';
		back.textContent = '\u2190 Back to Game';
		right.appendChild( back );

		nav.appendChild( brand );
		nav.appendChild( right );

		// Insert as the very first child of body so it sits at the top
		document.body.insertBefore( nav, document.body.firstChild );
	}

	if ( document.readyState === 'loading' ) {
		document.addEventListener( 'DOMContentLoaded', injectNav );
	} else {
		injectNav();
	}

} )();
