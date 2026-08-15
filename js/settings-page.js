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

		// Preset segmented control
		document.querySelectorAll( '#gfx-preset-row button' ).forEach( ( b ) => {
			b.classList.toggle( 'active', b.dataset.preset === g.preset );
		} );

		setSlider( $( 'gfx-maxPixelRatio' ), g.maxPixelRatio, $( 'val-maxPixelRatio' ), ( v ) => v.toFixed( 2 ) + 'x' );
		setSlider( $( 'gfx-shadowMapSize' ), g.shadowMapSize, $( 'val-shadowMapSize' ), ( v ) => String( v ) );
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
		triState( $( 'gp-countdown' ), gp.countdownEnabled, $( 'gp-countdown-state' ), 'on', 'off' );
		$( 'gp-recentGhosts' ).checked = gp.recentGhostsEnabled;
		setSlider( $( 'gp-recentGhostCount' ), gp.recentGhostCount, $( 'val-recentGhostCount' ), ( v ) => String( v ) );
		setSlider( $( 'gp-cameraDistance' ), gp.cameraDistance, $( 'val-cameraDistance' ), ( v ) => v.toFixed( 1 ) );
		setSlider( $( 'gp-cameraHeight' ), gp.cameraHeight, $( 'val-cameraHeight' ), ( v ) => v.toFixed( 1 ) );
		setSlider( $( 'gp-cameraLag' ), gp.cameraLag, $( 'val-cameraLag' ), ( v ) => Math.round( v * 100 ) + '%' );

		// Controls
		const c = s.controls;
		$( 'ctrl-invertSteer' ).checked = c.invertSteer;
		$( 'ctrl-keyboardOnly' ).checked = c.keyboardOnly;
		setSlider( $( 'ctrl-steerSmoothing' ), c.steerSmoothing, $( 'val-steerSmoothing' ), ( v ) => Math.round( v * 100 ) + '%' );

		// Accessibility
		const ac = s.accessibility;
		$( 'acc-highContrastHud' ).checked = ac.highContrastHud;
		$( 'acc-largeHud' ).checked = ac.largeHud;
		$( 'acc-screenShake' ).checked = ac.screenShake;
		$( 'acc-colorblindFilter' ).value = ac.colorblindFilter;
	}

	// ---- Wire controls ----
	// Graphics preset buttons
	document.querySelectorAll( '#gfx-preset-row button' ).forEach( ( b ) => {
		b.addEventListener( 'click', () => {
			patchAndApply( { graphics: { preset: b.dataset.preset } } );
			syncUiFromSettings();
		} );
	} );

	// Graphics sliders (null-capable)
	function bindGfxSlider( id, field, valueId, fmt ) {
		const el = $( id );
		const label = $( valueId );
		if ( ! el ) return;
		el.addEventListener( 'input', () => {
			const v = sliderValueOrNull( el );
			if ( label ) label.textContent = v == null ? ( el.dataset.nullText || 'auto' ) : ( fmt ? fmt( v ) : String( v ) );
			patchAndApply( { graphics: { [ field ]: v } } );
		} );
	}
	bindGfxSlider( 'gfx-maxPixelRatio', 'maxPixelRatio', 'val-maxPixelRatio', ( v ) => v.toFixed( 2 ) + 'x' );
	bindGfxSlider( 'gfx-shadowMapSize', 'shadowMapSize', 'val-shadowMapSize', ( v ) => String( v ) );
	bindGfxSlider( 'gfx-smokeParticles', 'smokeParticles', 'val-smokeParticles', ( v ) => String( v ) );
	bindGfxSlider( 'gfx-bloomStrength', 'bloomStrength', 'val-bloomStrength', ( v ) => v.toFixed( 3 ) );
	bindGfxSlider( 'gfx-bloomRadius', 'bloomRadius', 'val-bloomRadius', ( v ) => v.toFixed( 3 ) );

	// Tri-state shadows checkbox: click cycles off -> on -> auto.
	const shadowsBox = $( 'gfx-shadows' );
	if ( shadowsBox ) {
		shadowsBox.addEventListener( 'click', () => {
			const cur = GameSettings.getSettings().graphics.shadows;
			// indeterminate(auto) -> click sets checked=true(on) per browser, but we
			// want cycle: auto -> on -> off -> auto. Handle manually.
			// After the click, .checked reflects the new visual state. Map it:
			let next;
			if ( cur == null ) next = true;       // auto -> on
			else if ( cur === true ) next = false; // on -> off
			else next = null;                      // off -> auto
			// Prevent the browser from also toggling: set explicitly.
			patchAndApply( { graphics: { shadows: next } } );
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
	const countdownBox = $( 'gp-countdown' );
	if ( countdownBox ) {
		countdownBox.addEventListener( 'click', () => {
			const cur = GameSettings.getSettings().gameplay.countdownEnabled;
			let next;
			if ( cur == null ) next = true;
			else if ( cur === true ) next = false;
			else next = null;
			patchAndApply( { gameplay: { countdownEnabled: next } } );
			syncUiFromSettings();
		} );
	}
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

	// Controls
	$( 'ctrl-invertSteer' )?.addEventListener( 'change', ( e ) => patchAndApply( { controls: { invertSteer: e.target.checked } } ) );
	$( 'ctrl-keyboardOnly' )?.addEventListener( 'change', ( e ) => patchAndApply( { controls: { keyboardOnly: e.target.checked } } ) );
	{
		const el = $( 'ctrl-steerSmoothing' ), label = $( 'val-steerSmoothing' );
		el?.addEventListener( 'input', () => {
			label.textContent = Math.round( Number( el.value ) * 100 ) + '%';
			patchAndApply( { controls: { steerSmoothing: Number( el.value ) } } );
		} );
	}

	// Accessibility
	$( 'acc-highContrastHud' )?.addEventListener( 'change', ( e ) => patchAndApply( { accessibility: { highContrastHud: e.target.checked } } ) );
	$( 'acc-largeHud' )?.addEventListener( 'change', ( e ) => patchAndApply( { accessibility: { largeHud: e.target.checked } } ) );
	$( 'acc-screenShake' )?.addEventListener( 'change', ( e ) => patchAndApply( { accessibility: { screenShake: e.target.checked } } ) );
	$( 'acc-colorblindFilter' )?.addEventListener( 'change', ( e ) => patchAndApply( { accessibility: { colorblindFilter: e.target.value } } ) );

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
