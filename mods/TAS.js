import { DeterministicPlaybackController, decodeStepsFromQuery, parseInputLines } from '../js/tas-core.js';

const STORAGE_KEY = 'racing-tas-steps-v1';

function decodeStoredSteps() {

	try {

		return parseInputLines( localStorage.getItem( STORAGE_KEY ) || '' );

	} catch {

		return [];

	}

}

function saveSteps( steps ) {

	try {

		localStorage.setItem( STORAGE_KEY, JSON.stringify( { steps } ) );

	} catch {

		// ignore

	}

}

function readStoredSteps() {

	try {

		const parsed = JSON.parse( localStorage.getItem( STORAGE_KEY ) || '{}' );
		if ( Array.isArray( parsed?.steps ) ) return parsed.steps;

	} catch {

		// ignore

	}

	return decodeStoredSteps();

}

function buildButton( label ) {

	const btn = document.createElement( 'button' );
	btn.type = 'button';
	btn.textContent = label;
	btn.style.padding = '6px 8px';
	btn.style.borderRadius = '6px';
	btn.style.border = '1px solid rgba(255,255,255,0.25)';
	btn.style.background = 'rgba(0,0,0,0.35)';
	btn.style.color = '#fff';
	btn.style.cursor = 'pointer';
	return btn;

}

export const TAS_MOD = {
	id: 'tas',
	name: 'TAS',
	description: 'Deterministic tool-assisted speedrun viewer and editor.',
	controller: new DeterministicPlaybackController(),
	rootEl: null,
	statusEl: null,
	init( gameContext ) {

		const searchParams = new URLSearchParams( window.location.search );
		const querySteps = decodeStepsFromQuery( searchParams, 'tas' );
		const storedSteps = readStoredSteps();
		const steps = querySteps || storedSteps;
		this.controller.loadSteps( steps );
		if ( searchParams.get( 'tasRun' ) === '1' ) this.controller.start();
		this.rootEl = document.createElement( 'div' );
		this.rootEl.style.position = 'fixed';
		this.rootEl.style.right = '12px';
		this.rootEl.style.bottom = '12px';
		this.rootEl.style.zIndex = '30';
		this.rootEl.style.background = 'rgba(0,0,0,0.55)';
		this.rootEl.style.border = '1px solid rgba(255,255,255,0.18)';
		this.rootEl.style.borderRadius = '10px';
		this.rootEl.style.padding = '8px';
		this.rootEl.style.display = 'grid';
		this.rootEl.style.gridTemplateColumns = 'repeat(4, minmax(0, 1fr))';
		this.rootEl.style.gap = '6px';
		this.rootEl.style.minWidth = '260px';
		this.rootEl.style.font = '12px system-ui, sans-serif';

		const loadBtn = buildButton( 'Load' );
		const runBtn = buildButton( 'Run' );
		const stopBtn = buildButton( 'Stop' );
		const resetBtn = buildButton( 'Reset' );
		this.statusEl = document.createElement( 'div' );
		this.statusEl.style.gridColumn = '1 / -1';
		this.statusEl.style.opacity = '0.9';

		loadBtn.addEventListener( 'click', () => {

			const seeded = JSON.stringify( { steps: this.controller.steps }, null, 2 );
			const raw = window.prompt( 'Paste TAS JSON or line inputs', seeded ) || '';
			const next = raw.trim().startsWith( '{' ) || raw.trim().startsWith( '[' )
				? parseInputLines( raw )
				: parseInputLines( raw );
			this.controller.loadSteps( next );
			saveSteps( next );
			this.updateStatus();

		} );

		runBtn.addEventListener( 'click', () => {

			this.controller.start();
			this.updateStatus();

		} );

		stopBtn.addEventListener( 'click', () => {

			this.controller.stop();
			this.updateStatus();

		} );

		resetBtn.addEventListener( 'click', () => {

			this.controller.resetFrame();
			this.controller.stop();
			if ( typeof gameContext?.resetPlayerVehicle === 'function' ) gameContext.resetPlayerVehicle();
			this.updateStatus();

		} );

		this.rootEl.append( loadBtn, runBtn, stopBtn, resetBtn, this.statusEl );
		document.body.appendChild( this.rootEl );
		this.updateStatus();

	},
	applyFrame( frameContext ) {

		const nextInput = this.controller.nextAxes( frameContext?.input || { x: 0, z: 0 } );
		if ( this.statusEl ) this.updateStatus();
		return { input: nextInput };

	},
	updateStatus() {

		if ( ! this.statusEl ) return;
		const mode = this.controller.running ? 'RUN' : 'IDLE';
		this.statusEl.textContent = `TAS ${ mode } • frame ${ this.controller.frameIndex }/${ this.controller.steps.length }`;

	},
	dispose() {

		this.controller.stop();
		if ( this.rootEl?.parentNode ) this.rootEl.parentNode.removeChild( this.rootEl );
		this.rootEl = null;
		this.statusEl = null;

	}
};

export default TAS_MOD;
