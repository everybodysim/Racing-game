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
