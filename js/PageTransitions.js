/**
 * PageTransitions.js — smooth fade transitions between page loads.
 * Loaded in <head> of every page so the fade-in CSS applies before
 * the body renders (no FOUC).  Internal link clicks trigger a quick
 * fade-out before navigation.  External links and modified clicks
 * (ctrl/meta/shift) are left alone.
 */
( function () {

	'use strict';

	var style = document.createElement( 'style' );
	style.textContent =
		'@keyframes skid-page-enter { from { opacity: 0; } to { opacity: 1; } }' +
		'@keyframes skid-page-leave { from { opacity: 1; } to { opacity: 0; } }' +
		'body { animation: skid-page-enter 0.28s ease-out; }' +
		'body.skid-leaving { animation: skid-page-leave 0.18s ease-in forwards; pointer-events: none; }';
	document.head.appendChild( style );

	document.addEventListener( 'click', function ( e ) {

		if ( e.defaultPrevented || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey ) return;
		var link = e.target.closest && e.target.closest( 'a' );
		if ( ! link ) return;
		var href = link.getAttribute( 'href' );
		if ( ! href ) return;
		if ( href.startsWith( '#' ) || href.startsWith( 'mailto:' ) || href.startsWith( 'tel:' ) || href.startsWith( 'javascript:' ) ) return;
		if ( href.startsWith( 'http://' ) || href.startsWith( 'https://' ) ) return;
		if ( link.target === '_blank' ) return;
		if ( document.body.classList.contains( 'skid-leaving' ) ) return;

		e.preventDefault();
		document.body.classList.add( 'skid-leaving' );
		setTimeout( function () { window.location.href = href; }, 180 );

	} );

	window.addEventListener( 'pageshow', function ( e ) {

		if ( e.persisted ) document.body.classList.remove( 'skid-leaving' );

	} );

} )();
