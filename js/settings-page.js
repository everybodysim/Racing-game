/**
 * settings-page.js — controller for settings.html.
 *
 * Binds every control on the settings page to the shared GameSettings module.
 * On any change, the setting is validated + persisted to localStorage (and the
 * legacy per-subsystem keys, so the game picks it up) and pushed live to a
 * running game in another tab via window.__gameSettingsApplyLive (a no-op when
 * the game isn't loaded, e.g. on this standalone page).
 */
import GameSettings from './GameSettings.js';

( function () {

	'use strict';

	const $ = ( id ) => document.getElementById( id );

	// ---- Tri-state (null = follow preset/default) helpers for sliders ----
	// A slider whose value sits at its min represents "auto" (null) for fields
	// that support a preset default; otherwise it's a real number.
	function sliderValueOrNull( el ) {
		// Treat the leftmost position as "auto" for null-capable fields.
		if ( el.dataset.nullText != null && Number( el.value ) <= Number( el.min ) ) return null;
		return Number( el.value );
	}

	function setSlider( el, value, valueLabel, fmt ) {
		if ( value == null ) {
			el.value = el.min;
			if ( valueLabel ) valueLabel.textContent = el.dataset.nullText || 'auto';
		} else {
			el.value = value;
			if ( valueLabel ) valueLabel.textContent = fmt ? fmt( value ) : String( value );
		}
	}

	// ---- Tri-state checkbox (null = auto) ----
	function triState( checkbox, value, stateEl, onText, offText ) {
		if ( value == null ) {
			checkbox.checked = false;
			checkbox.indeterminate = true;
			if ( stateEl ) stateEl.textContent = 'auto (follows preset)';
		} else {
			checkbox.checked = Boolean( value );
			checkbox.indeterminate = false;
			if ( stateEl ) stateEl.textContent = value ? onText : offText;
		}
	}

	function patchAndApply( patch ) {
		GameSettings.patchSettings( patch );
		GameSettings.applyLive();
	}

	// ---- Tab switching ----
	const tabBtns = Array.from( document.querySelectorAll( '.tab-btn' ) );
	const panels = Array.from( document.querySelectorAll( '.tab-panel' ) );
	function activateTab( name ) {
		tabBtns.forEach( ( b ) => {
			const on = b.dataset.tab === name;
			b.classList.toggle( 'active', on );
			b.setAttribute( 'aria-selected', String( on ) );
		} );
		panels.forEach( ( p ) => p.classList.toggle( 'active', p.id === 'tab-' + name ) );
		// Persist last-opened tab so a reload returns to it.
		try { localStorage.setItem( 'racing-settings-tab-v1', name ); } catch ( e ) {}
	}
	tabBtns.forEach( ( b ) => b.addEventListener( 'click', () => activateTab( b.dataset.tab ) ) );

	// ---- Populate UI from current settings ----
	function syncUiFromSettings() {
		const s = GameSettings.getSettings();
		const g = s.graphics;

		// Preset segmented control — Custom lights up only when overrides exist.
		const overrides = g.maxPixelRatio != null || g.smokeParticles != null
			|| g.bloomStrength != null || g.bloomRadius != null || g.shadows != null;
		const customBtn = $( 'gfx-custom-btn' );
		if ( customBtn ) customBtn.disabled = ! overrides;
		document.querySelectorAll( '#gfx-preset-row button' ).forEach( ( b ) => {
			b.classList.toggle( 'active', b.dataset.preset === g.preset );
		} );
		const statusEl = $( 'gfx-preset-status' );
		if ( statusEl ) {
			if ( g.preset === 'custom' ) statusEl.textContent = 'Custom (based on ' + ( g.basePreset || 'high' ) + '). Tweak any slider to adjust.';
			else statusEl.textContent = 'Follows the ' + g.preset + ' preset. All advanced options are auto.';
		}

		setSlider( $( 'gfx-maxPixelRatio' ), g.maxPixelRatio, $( 'val-maxPixelRatio' ), ( v ) => v.toFixed( 2 ) + 'x' );
		setSlider( $( 'gfx-smokeParticles' ), g.smokeParticles, $( 'val-smokeParticles' ), ( v ) => String( v ) );
		setSlider( $( 'gfx-bloomStrength' ), g.bloomStrength, $( 'val-bloomStrength' ), ( v ) => v.toFixed( 3 ) );
		setSlider( $( 'gfx-bloomRadius' ), g.bloomRadius, $( 'val-bloomRadius' ), ( v ) => v.toFixed( 3 ) );
		triState( $( 'gfx-shadows' ), g.shadows, $( 'gfx-shadows-state' ), 'on', 'off' );
		$( 'gfx-antialias' ).checked = g.antialias;
		$( 'gfx-reduceMotion' ).checked = g.reduceMotion;

		// Audio
		const a = s.audio;
		setSlider( $( 'aud-sfxVolume' ), a.sfxVolume, $( 'val-sfxVolume' ), ( v ) => Math.round( v * 100 ) + '%' );
		setSlider( $( 'aud-musicVolume' ), a.musicVolume, $( 'val-musicVolume' ), ( v ) => Math.round( v * 100 ) + '%' );
		$( 'aud-musicMode' ).value = String( a.musicMode );

		// Gameplay
		const gp = s.gameplay;
		$( 'gp-showFps' ).checked = gp.showFps;
		$( 'gp-showBestGhost' ).checked = gp.showBestGhost != null ? Boolean( gp.showBestGhost ) : true;
		$( 'gp-recentGhosts' ).checked = gp.recentGhostsEnabled;
		setSlider( $( 'gp-recentGhostCount' ), gp.recentGhostCount, $( 'val-recentGhostCount' ), ( v ) => String( v ) );
		setSlider( $( 'gp-cameraDistance' ), gp.cameraDistance, $( 'val-cameraDistance' ), ( v ) => v.toFixed( 1 ) );
		setSlider( $( 'gp-cameraHeight' ), gp.cameraHeight, $( 'val-cameraHeight' ), ( v ) => v.toFixed( 1 ) );
		setSlider( $( 'gp-cameraLag' ), gp.cameraLag, $( 'val-cameraLag' ), ( v ) => Math.round( v * 100 ) + '%' );
	}

	// ---- Wire controls ----
	// Graphics preset buttons: clicking Low/Medium/High resets ALL advanced
	// overrides back to "auto" (null) so the chosen preset is followed fully.
	// The Custom button is only enabled once a slider has been tweaked; clicking
	// it just re-applies the existing custom state (a no-op reassurance).
	const REAL_PRESETS = [ 'low', 'medium', 'high' ];
	function selectPreset( preset ) {
		if ( REAL_PRESETS.indexOf( preset ) >= 0 ) {
			patchAndApply( { graphics: {
				preset, basePreset: preset,
				maxPixelRatio: null, shadows: null,
				bloomStrength: null, bloomRadius: null, smokeParticles: null,
			} } );
		}
		syncUiFromSettings();
	}
	document.querySelectorAll( '#gfx-preset-row button' ).forEach( ( b ) => {
		b.addEventListener( 'click', () => selectPreset( b.dataset.preset ) );
	} );

	// Graphics sliders (null-capable). Customizing ANY slider switches the preset
	// to "custom" (keeping the last real preset as basePreset) so the Custom
	// button lights up and the other untouched fields still follow basePreset.
	// (shadowMapSize has no slider — it's always preset-driven / "normal".)
	function bindGfxSlider( id, field, valueId, fmt ) {
		const el = $( id );
		const label = $( valueId );
		if ( ! el ) return;
		el.addEventListener( 'input', () => {
			const v = sliderValueOrNull( el );
			if ( label ) label.textContent = v == null ? ( el.dataset.nullText || 'auto' ) : ( fmt ? fmt( v ) : String( v ) );
			const cur = GameSettings.getSettings().graphics;
			const patch = { graphics: { [ field ]: v } };
			// Moving a slider to "auto" doesn't force custom by itself; only a real
			// override value flips to custom. If ALL overrides become null again,
			// snap back to the real preset.
			const overrideFields = [ 'maxPixelRatio', 'smokeParticles', 'bloomStrength', 'bloomRadius', 'shadows' ];
			const nextOverrides = Object.assign(
				{},
				{ maxPixelRatio: cur.maxPixelRatio, smokeParticles: cur.smokeParticles, bloomStrength: cur.bloomStrength, bloomRadius: cur.bloomRadius, shadows: cur.shadows },
				{ [ field ]: v }
			);
			const anyOverride = overrideFields.some( ( f ) => nextOverrides[ f ] != null );
			if ( anyOverride ) {
				patch.graphics.preset = 'custom';
				patch.graphics.basePreset = REAL_PRESETS.indexOf( cur.preset ) >= 0 ? cur.preset : ( cur.basePreset || 'high' );
			} else if ( cur.preset === 'custom' ) {
				// All overrides cleared -> restore to the base real preset.
				patch.graphics.preset = cur.basePreset || 'high';
				patch.graphics.basePreset = cur.basePreset || 'high';
			}
			patchAndApply( patch );
			syncUiFromSettings();
		} );
	}
	bindGfxSlider( 'gfx-maxPixelRatio', 'maxPixelRatio', 'val-maxPixelRatio', ( v ) => v.toFixed( 2 ) + 'x' );
	bindGfxSlider( 'gfx-smokeParticles', 'smokeParticles', 'val-smokeParticles', ( v ) => String( v ) );
	bindGfxSlider( 'gfx-bloomStrength', 'bloomStrength', 'val-bloomStrength', ( v ) => v.toFixed( 3 ) );
	bindGfxSlider( 'gfx-bloomRadius', 'bloomRadius', 'val-bloomRadius', ( v ) => v.toFixed( 3 ) );

	// Tri-state shadows checkbox: click cycles off -> on -> auto. Like sliders,
	// setting a real value (on/off) switches to custom; returning to auto may
	// snap back to the real preset if no other overrides remain.
	const shadowsBox = $( 'gfx-shadows' );
	if ( shadowsBox ) {
		shadowsBox.addEventListener( 'click', () => {
			const cur = GameSettings.getSettings().graphics;
			let next;
			if ( cur.shadows == null ) next = true;       // auto -> on
			else if ( cur.shadows === true ) next = false; // on -> off
			else next = null;                              // off -> auto
			const patch = { graphics: { shadows: next } };
			const overrideFields = [ 'maxPixelRatio', 'smokeParticles', 'bloomStrength', 'bloomRadius' ];
			const nextOverrides = Object.assign(
				{},
				{ maxPixelRatio: cur.maxPixelRatio, smokeParticles: cur.smokeParticles, bloomStrength: cur.bloomStrength, bloomRadius: cur.bloomRadius },
				{ shadows: next }
			);
			const anyOverride = overrideFields.some( ( f ) => nextOverrides[ f ] != null ) || next != null;
			if ( anyOverride ) {
				patch.graphics.preset = 'custom';
				patch.graphics.basePreset = REAL_PRESETS.indexOf( cur.preset ) >= 0 ? cur.preset : ( cur.basePreset || 'high' );
			} else if ( cur.preset === 'custom' ) {
				patch.graphics.preset = cur.basePreset || 'high';
				patch.graphics.basePreset = cur.basePreset || 'high';
			}
			patchAndApply( patch );
			syncUiFromSettings();
		} );
	}

	$( 'gfx-antialias' )?.addEventListener( 'change', ( e ) => {
		patchAndApply( { graphics: { antialias: e.target.checked } } );
	} );
	$( 'gfx-reduceMotion' )?.addEventListener( 'change', ( e ) => {
		patchAndApply( { graphics: { reduceMotion: e.target.checked } } );
	} );

	// Audio
	function bindAudioSlider( id, field, valueId, fmt ) {
		const el = $( id ), label = $( valueId );
		el?.addEventListener( 'input', () => {
			if ( label ) label.textContent = fmt( Number( el.value ) );
			patchAndApply( { audio: { [ field ]: Number( el.value ) } } );
		} );
	}
	bindAudioSlider( 'aud-sfxVolume', 'sfxVolume', 'val-sfxVolume', ( v ) => Math.round( v * 100 ) + '%' );
	bindAudioSlider( 'aud-musicVolume', 'musicVolume', 'val-musicVolume', ( v ) => Math.round( v * 100 ) + '%' );
	$( 'aud-musicMode' )?.addEventListener( 'change', ( e ) => {
		patchAndApply( { audio: { musicMode: Number( e.target.value ) } } );
	} );

	// Gameplay
	$( 'gp-showFps' )?.addEventListener( 'change', ( e ) => patchAndApply( { gameplay: { showFps: e.target.checked } } ) );
	$( 'gp-showBestGhost' )?.addEventListener( 'change', ( e ) => patchAndApply( { gameplay: { showBestGhost: e.target.checked } } ) );
	$( 'gp-recentGhosts' )?.addEventListener( 'change', ( e ) => patchAndApply( { gameplay: { recentGhostsEnabled: e.target.checked } } ) );
	const rgc = $( 'gp-recentGhostCount' );
	if ( rgc ) {
		rgc.addEventListener( 'input', () => {
			$( 'val-recentGhostCount' ).textContent = String( rgc.value );
			patchAndApply( { gameplay: { recentGhostCount: Number( rgc.value ) } } );
		} );
	}
	function bindGpSlider( id, field, valueId, fmt ) {
		const el = $( id ), label = $( valueId );
		el?.addEventListener( 'input', () => {
			const v = sliderValueOrNull( el );
			if ( label ) label.textContent = v == null ? ( el.dataset.nullText || 'auto' ) : ( fmt ? fmt( v ) : String( v ) );
			patchAndApply( { gameplay: { [ field ]: v } } );
		} );
	}
	bindGpSlider( 'gp-cameraDistance', 'cameraDistance', 'val-cameraDistance', ( v ) => v.toFixed( 1 ) );
	bindGpSlider( 'gp-cameraHeight', 'cameraHeight', 'val-cameraHeight', ( v ) => v.toFixed( 1 ) );
	{
		const el = $( 'gp-cameraLag' ), label = $( 'val-cameraLag' );
		el?.addEventListener( 'input', () => {
			label.textContent = Math.round( Number( el.value ) * 100 ) + '%';
			patchAndApply( { gameplay: { cameraLag: Number( el.value ) } } );
		} );
	}


	// ---- Cloud sync ----
	function refreshCloud() {
		const st = GameSettings.getCloudStatus();
		const who = $( 'cloud-who' );
		const state = $( 'cloud-state' );
		if ( st.signedIn ) {
			who.innerHTML = 'Signed in as <strong>' + escapeHtml( st.username ) + '</strong><small>Cloud sync ready.</small>';
			state.textContent = 'online';
			state.style.color = 'var(--skid-accent,#77f3b1)';
			$( 'cloud-save-btn' ).disabled = false;
			$( 'cloud-load-btn' ).disabled = false;
		} else {
			who.innerHTML = 'Not signed in<small>Open the game and log in (E → Account) to enable cloud sync.</small>';
			state.textContent = 'offline';
			state.style.color = 'var(--skid-muted,#b5c2da)';
			$( 'cloud-save-btn' ).disabled = true;
			$( 'cloud-load-btn' ).disabled = true;
		}
	}

	function setCloudStatus( msg, kind ) {
		const el = $( 'cloud-status' );
		el.textContent = msg || '';
		el.className = 'status ' + ( kind || '' );
	}

	$( 'cloud-save-btn' )?.addEventListener( 'click', async () => {
		setCloudStatus( 'Saving to cloud…', '' );
		try {
			await GameSettings.saveSettingsToCloud();
			setCloudStatus( 'Settings saved to your cloud account.', 'ok' );
		} catch ( err ) {
			setCloudStatus( err.message, 'err' );
		}
	} );

	$( 'cloud-load-btn' )?.addEventListener( 'click', async () => {
		setCloudStatus( 'Loading from cloud…', '' );
		try {
			await GameSettings.loadSettingsFromCloud();
			syncUiFromSettings();
			setCloudStatus( 'Settings loaded from cloud and applied locally.', 'ok' );
		} catch ( err ) {
			setCloudStatus( err.message, 'err' );
		}
	} );

	$( 'cloud-refresh-btn' )?.addEventListener( 'click', () => {
		refreshCloud();
		setCloudStatus( 'Status refreshed.', 'ok' );
	} );

	// ---- Local data ----
	$( 'reset-btn' )?.addEventListener( 'click', () => {
		if ( ! confirm( 'Reset ALL settings to their defaults? This cannot be undone.' ) ) return;
		GameSettings.resetToDefaults();
		GameSettings.applyLive();
		syncUiFromSettings();
		setLocalStatus( 'Settings reset to defaults.', 'ok' );
	} );

	$( 'export-btn' )?.addEventListener( 'click', async () => {
		const json = JSON.stringify( GameSettings.getSettings(), null, 2 );
		try {
			await navigator.clipboard.writeText( json );
			setLocalStatus( 'Settings JSON copied to clipboard.', 'ok' );
		} catch ( err ) {
			setLocalStatus( 'Clipboard unavailable. Open the console for the JSON.', 'err' );
			console.log( 'Settings JSON:', json );
		}
	} );

	function setLocalStatus( msg, kind ) {
		const el = $( 'local-status' );
		el.textContent = msg || '';
		el.className = 'status ' + ( kind || '' );
	}

	function setClearStatus( msg, kind ) {
		const el = $( 'clear-status' );
		el.textContent = msg || '';
		el.className = 'status ' + ( kind || '' );
	}

	$( 'clear-local-btn' )?.addEventListener( 'click', () => {
		const ok = confirm(
			'This will erase ALL Skid Circuit data in this browser:\n' +
			'settings, coins, garage, campaign, ghosts, account session,\n' +
			'installed mods, track shares — everything. Cloud saves are NOT affected.\n\n' +
			'The game will reload afterwards. Continue?'
		);
		if ( ! ok ) return;
		setClearStatus( 'Clearing local storage…', '' );
		try {
			const removed = GameSettings.clearLocalStorage();
			setClearStatus( 'Cleared ' + removed.length + ' local storage key(s). Reloading…', 'ok' );
			setTimeout( () => { window.location.href = 'index.html'; }, 900 );
		} catch ( err ) {
			setClearStatus( 'Failed: ' + ( err && err.message ? err.message : err ), 'err' );
		}
	} );

	$( 'apply-live-btn' )?.addEventListener( 'click', () => {
		GameSettings.applyLive();
		const el = $( 'apply-status' );
		el.textContent = 'Live-applicable settings pushed. (Graphics preset, audio, camera, FPS apply if the game is running in another tab. Antialiasing needs a reload.)';
		el.className = 'status ok';
	} );

	// ---- Helpers ----
	function escapeHtml( s ) {
		return String( s ).replace( /[&<>"]/g, ( ch ) => ( { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ ch ] ) );
	}

	// ---- Cross-tab sync: if settings change in another tab, refresh this UI ----
	window.addEventListener( 'storage', ( e ) => {
		if ( e.key === GameSettings.UNIFIED_KEY ) {
			GameSettings.refresh();
			syncUiFromSettings();
		}
	} );

	// ---- Init ----
	syncUiFromSettings();
	refreshCloud();

	// Restore last-opened tab.
	try {
		const savedTab = localStorage.getItem( 'racing-settings-tab-v1' );
		if ( savedTab && document.querySelector( '.tab-btn[data-tab="' + savedTab + '"]' ) ) {
			activateTab( savedTab );
		}
	} catch ( e ) {}

} )();
