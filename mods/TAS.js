import { DeterministicPlaybackController, decodeStepsFromQuery, parseInputLines } from '../js/tas-core.js';

// In-game TAS playback runtime.
//
// The interactive editor lives on the standalone tas-viewer.html page (opened
// via the "TAS Editor" nav link, which is only shown when this mod is
// installed). There the user records/edits input steps and copies them into
// storage; this runtime simply replays those stored steps deterministically
// inside a normal race, with no on-screen UI of its own.
const STORAGE_KEY = 'racing-tas-steps-v1';

function readStoredSteps() {

	try {

		const parsed = JSON.parse( localStorage.getItem( STORAGE_KEY ) || '{}' );
		if ( Array.isArray( parsed?.steps ) ) return parsed.steps;

	} catch {

		// fall through to plain-text parsing

	}

	try {

		return parseInputLines( localStorage.getItem( STORAGE_KEY ) || '' );

	} catch {

		return [];

	}

}

export const TAS_MOD = {
	id: 'tas',
	name: 'TAS',
	description: 'Deterministic tool-assisted speedrun editor & playback runtime.',
	controller: new DeterministicPlaybackController(),
	init() {

		const searchParams = new URLSearchParams( window.location.search );
		const querySteps = decodeStepsFromQuery( searchParams, 'tas' );
		const steps = querySteps || readStoredSteps();
		this.controller.loadSteps( steps );
		if ( searchParams.get( 'tasRun' ) === '1' ) this.controller.start();

	},
	applyFrame( frameContext ) {

		const nextInput = this.controller.nextAxes( frameContext?.input || { x: 0, z: 0 } );
		return { input: nextInput };

	},
	onRaceStart() {

		// A fresh run is starting: rewind the playback cursor to the beginning
		// so the TAS replays from step 0 against the freshly reset sim state.
		this.controller.resetFrame();

	},
	dispose() {

		this.controller.stop();

	}
};

export default TAS_MOD;
