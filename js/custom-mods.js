// Custom Mods Lab — block definitions, parser, and runtime template generator.
// Keeps the visual editor compact while exposing a rich, safe modding surface.

// Blockly >=11 no longer ships FieldColour in blockly.min.js. The FX, UI and Game
// Control categories use `new Blockly.FieldColour(...)`. Previously this threw during
// block init() and froze the toolbox flyout on those categories (clicking Lists /
// UI & Storage / Game Control hung the sidebar until reload and leaked half-rendered
// blocks into other categories). The external `@blockly/field-colour` CDN script was
// unreliable (its UMD is built for module loaders and does not always attach to the
// global Blockly in a plain <script> setup), so we ship a self-contained colour field
// here instead — no network dependency, works offline, and renders a native colour
// picker. It is exposed as `Blockly.FieldColour` for the existing `new
// Blockly.FieldColour(...)` calls and registered with the field registry so
// deserialised XML round-trips.
( () => {

    if ( typeof Blockly === 'undefined' ) return;
    // If a real FieldColour is already present (e.g. a future Blockly build bundles it
    // again, or the CDN package did load), keep it — never override a working picker.
    if ( Blockly.FieldColour && ! Blockly.FieldColour._racingSelfHosted ) return;

    const Field = Blockly.Field;
    const FieldTextInput = Blockly.FieldTextInput;
    if ( ! Field || ! FieldTextInput ) return;

    const COLOUR_REGEX = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
    function toHex( value ) {
        const s = String( value || '' ).trim();
        if ( COLOUR_REGEX.test( s ) ) return s.toLowerCase();
        return '#ff4b1f';
    }

    class RacingFieldColour extends FieldTextInput {
        constructor( value, validator, config ) {
            super( toHex( value ), validator, config );
        }
        initView() {
            super.initView();
            try {
                if ( this.fieldGroup_ && ! this.colourSwatch_ ) {
                    const sw = document.createElement( 'span' );
                    sw.style.display = 'inline-block';
                    sw.style.width = '10px';
                    sw.style.height = '10px';
                    sw.style.marginLeft = '4px';
                    sw.style.border = '1px solid rgba(255,255,255,0.5)';
                    sw.style.borderRadius = '2px';
                    sw.style.verticalAlign = 'middle';
                    this.fieldGroup_.appendChild( sw );
                    this.colourSwatch_ = sw;
                }
                if ( this.colourSwatch_ ) this.colourSwatch_.style.background = toHex( this.getValue() );
            } catch { /* ignore */ }
        }
        doValueUpdate_( newValue ) {
            super.doValueUpdate_( newValue );
            try { if ( this.colourSwatch_ ) this.colourSwatch_.style.background = toHex( this.getValue() ); } catch { /* ignore */ }
        }
        // Open a native HTML colour picker instead of a text editor.
        showEditor_( _e ) {
            try {
                const input = document.createElement( 'input' );
                input.type = 'color';
                input.value = toHex( this.getValue() );
                input.style.width = '46px';
                input.style.height = '30px';
                input.style.padding = '0';
                input.style.border = '1px solid rgba(255,255,255,0.4)';
                input.style.borderRadius = '4px';
                input.style.background = 'transparent';
                input.style.cursor = 'pointer';

                const editor = document.createElement( 'div' );
                editor.style.position = 'absolute';
                editor.style.zIndex = '100000';
                editor.appendChild( input );
                document.body.appendChild( editor );
                let placed = false;
                try {
                    const block = this.getSourceBlock ? this.getSourceBlock() : null;
                    const rect = block && block.getBoundingRectangle ? block.getBoundingRectangle() : null;
                    if ( rect ) { editor.style.left = `${ rect.left }px`; editor.style.top = `${ rect.top + 24 }px`; placed = true; }
                } catch { /* ignore */ }
                if ( ! placed ) { editor.style.left = `${ window.innerWidth / 2 - 23 }px`; editor.style.top = `${ window.innerHeight / 2 }px`; }

                let closed = false;
                const close = () => { if ( closed ) return; closed = true; editor.remove(); };
                input.addEventListener( 'input', () => this.setValue( toHex( input.value ) ) );
                input.addEventListener( 'change', () => { this.setValue( toHex( input.value ) ); close(); } );
                input.addEventListener( 'blur', close );
                input.focus();
                try { if ( typeof input.showPicker === 'function' ) input.showPicker(); } catch { /* needs a gesture on some browsers */ }
                return;
            } catch ( error ) {
                return super.showEditor_( _e );
            }
        }
    }

    RacingFieldColour._racingSelfHosted = true;
    Blockly.FieldColour = RacingFieldColour;

    try {
        const registry = Blockly.fieldRegistry || Blockly.registry;
        if ( registry && typeof registry.register === 'function' ) registry.register( 'field_colour', RacingFieldColour );
    } catch { /* prior registration is fine */ }

} )();

const DRAFT_KEY = 'racing-custom-mods-workspace-v3';
const SHARED_KEY = 'racing-shared-custom-mods-v1';
// The same key js/mods-manager.js and js/main.js read to load mods at boot.
// "Save to Mod Manager" writes the generated runtime here so the mod is
// actually installed (survives reload, runs in index.html) — not just listed.
const INSTALLED_MODS_KEY = 'racing-installed-mods-v1';

function setStatus( message ) { const el = document.getElementById( 'status' ); if ( el ) el.textContent = message; }
function safeId( value ) { return String( value || '' ).trim().toLowerCase().replace( /[^a-z0-9-_]/g, '-' ).replace( /-+/g, '-' ); }
function clampNum( v, min, max, d = 0 ) { const n = Number( v ); return Number.isFinite( n ) ? Math.max( min, Math.min( max, n ) ) : d; }

// Palette
const EVT = '#f59e0b', VEH = '#06b6d4', FX = '#0ea5e9', VAR = '#22c55e', FLOW = '#14b8a6', LOGIC = '#3b82f6', TXT = '#a855f7', MATH = '#6366f1', LIST = '#ec4899', WORLD = '#10b981', CAM = '#8b5cf6', AUD = '#f43f5e', HUD = '#eab308';

// Helper to define a simple statement block with optional labelled value input.
function actionDef( name, field, label, color = VEH ) {
	Blockly.Blocks[ name ] = {
		init() {
			if ( field ) { this.appendValueInput( field ).setCheck( 'Number' ).appendField( label ); }
			else { this.appendDummyInput().appendField( label ); }
			this.setPreviousStatement( true );
			this.setNextStatement( true );
			this.setColour( color );
		},
	};
}

// Helper for a dummy-only statement block with a dropdown + optional value input.
function actionDefDropdown( name, label, field, options, valueField, valueLabel, color = VEH ) {
	Blockly.Blocks[ name ] = {
		init() {
			const input = this.appendDummyInput().appendField( label ).appendField( new Blockly.FieldDropdown( options ), field );
			if ( valueField ) input.appendField( valueLabel ).appendField( new Blockly.FieldTextInput( '' ), valueField );
			this.setPreviousStatement( true );
			this.setNextStatement( true );
			this.setColour( color );
		},
	};
}

// ============ EVENTS ============
Blockly.Blocks.event_on_start = { init() { this.appendStatementInput( 'DO' ).appendField( 'when race starts' ); this.setColour( EVT ); } };
Blockly.Blocks.event_on_tick = { init() { this.appendStatementInput( 'DO' ).appendField( 'every tick (per frame)' ); this.setColour( EVT ); } };
Blockly.Blocks.event_on_key = { init() { this.appendDummyInput().appendField( 'when key' ).appendField( new Blockly.FieldDropdown( [ [ 'W', 'KeyW' ], [ 'A', 'KeyA' ], [ 'S', 'KeyS' ], [ 'D', 'KeyD' ], [ 'Space', 'Space' ], [ 'X', 'KeyX' ], [ 'C', 'KeyC' ], [ 'E', 'KeyE' ], [ 'Q', 'KeyQ' ], [ 'R', 'KeyR' ] ] ), 'KEY' ).appendField( 'pressed' ); this.appendStatementInput( 'DO' ).appendField( 'do' ); this.setColour( EVT ); } };
Blockly.Blocks.event_on_key_hold = { init() { this.appendDummyInput().appendField( 'while key held' ).appendField( new Blockly.FieldDropdown( [ [ 'W', 'KeyW' ], [ 'A', 'KeyA' ], [ 'S', 'KeyS' ], [ 'D', 'KeyD' ], [ 'Space', 'Space' ], [ 'X', 'KeyX' ] ] ), 'KEY' ); this.appendStatementInput( 'DO' ).appendField( 'do' ); this.setColour( EVT ); } };
Blockly.Blocks.event_on_checkpoint = { init() { this.appendStatementInput( 'DO' ).appendField( 'on checkpoint reached' ); this.setColour( EVT ); } };
Blockly.Blocks.event_on_crash = { init() { this.appendStatementInput( 'DO' ).appendField( 'on crash' ); this.setColour( EVT ); } };
Blockly.Blocks.event_on_lap_finish = { init() { this.appendStatementInput( 'DO' ).appendField( 'on finish / lap complete' ); this.setColour( EVT ); } };
Blockly.Blocks.event_on_respawn = { init() { this.appendStatementInput( 'DO' ).appendField( 'on respawn / reset' ); this.setColour( EVT ); } };
Blockly.Blocks.event_on_timer_done = { init() { this.appendDummyInput().appendField( 'on timer' ).appendField( new Blockly.FieldTextInput( 'timer1' ), 'ID' ).appendField( 'done' ); this.appendStatementInput( 'DO' ).appendField( 'do' ); this.setColour( EVT ); } };
Blockly.Blocks.event_on_speed_threshold = { init() { this.appendValueInput( 'SPEED' ).setCheck( 'Number' ).appendField( 'when speed exceeds' ); this.appendStatementInput( 'DO' ).appendField( 'do' ); this.setColour( EVT ); } };
Blockly.Blocks.event_on_air = { init() { this.appendStatementInput( 'DO' ).appendField( 'when car is airborne' ); this.setColour( EVT ); } };
Blockly.Blocks.event_on_ground = { init() { this.appendStatementInput( 'DO' ).appendField( 'when car touches ground' ); this.setColour( EVT ); } };
Blockly.Blocks.event_on_drift = { init() { this.appendStatementInput( 'DO' ).appendField( 'when drifting' ); this.setColour( EVT ); } };
Blockly.Blocks.event_on_low_speed = { init() { this.appendValueInput( 'SPEED' ).setCheck( 'Number' ).appendField( 'when speed below' ); this.appendStatementInput( 'DO' ).appendField( 'do' ); this.setColour( EVT ); } };

// ============ VEHICLE PERFORMANCE ============
actionDef( 'action_set_speed', 'SPEED', 'set max speed' );
actionDef( 'action_boost', 'AMOUNT', 'boost (forward impulse) by' );
actionDef( 'action_set_top_speed', 'VALUE', 'set top speed stat' );
actionDef( 'action_set_accel_rate', 'VALUE', 'set accel rate' );
actionDef( 'action_set_brake_rate', 'VALUE', 'set brake rate' );
actionDef( 'action_set_drive_force', 'VALUE', 'set drive force' );
actionDef( 'action_set_drag', 'VALUE', 'set drag multiplier' );
actionDef( 'action_set_reverse_accel', 'VALUE', 'set reverse accel rate' );
actionDef( 'action_set_gravity', 'G', 'set gravity' );
actionDef( 'action_set_time_scale', 'SCALE', 'set time scale' );
actionDef( 'action_set_accel_mult', 'VALUE', 'set acceleration multiplier' );
actionDef( 'action_set_drive_mult', 'VALUE', 'set boost/drive multiplier' );
actionDef( 'action_set_grip_mult', 'VALUE', 'set drift/grip multiplier' );
actionDef( 'action_force_brake', 'TIME', 'force brake for seconds' );
actionDef( 'action_force_throttle', 'TIME', 'force throttle for seconds' );
actionDef( 'action_disable_steering', 'TIME', 'disable steering for seconds' );
actionDef( 'action_jump', 'POWER', 'jump power' );
actionDef( 'action_reset_car', null, 'respawn vehicle' );

// ============ VEHICLE TRANSFORM / PHYSICS ============
Blockly.Blocks.action_teleport = { init() { this.appendValueInput( 'X' ).setCheck( 'Number' ).appendField( 'teleport to X' ); this.appendValueInput( 'Y' ).setCheck( 'Number' ).appendField( 'Y' ); this.appendValueInput( 'Z' ).setCheck( 'Number' ).appendField( 'Z' ); this.setPreviousStatement( true ); this.setNextStatement( true ); this.setColour( VEH ); } };
Blockly.Blocks.action_apply_impulse = { init() { this.appendValueInput( 'X' ).setCheck( 'Number' ).appendField( 'apply impulse X' ); this.appendValueInput( 'Y' ).setCheck( 'Number' ).appendField( 'Y' ); this.appendValueInput( 'Z' ).setCheck( 'Number' ).appendField( 'Z' ); this.setPreviousStatement( true ); this.setNextStatement( true ); this.setColour( VEH ); } };
Blockly.Blocks.action_angular_impulse = { init() { this.appendValueInput( 'X' ).setCheck( 'Number' ).appendField( 'apply spin X' ); this.appendValueInput( 'Y' ).setCheck( 'Number' ).appendField( 'Y' ); this.appendValueInput( 'Z' ).setCheck( 'Number' ).appendField( 'Z' ); this.setPreviousStatement( true ); this.setNextStatement( true ); this.setColour( VEH ); } };
actionDef( 'action_set_vehicle_spin', 'RAD', 'set vehicle Y rotation (rad)' );
actionDef( 'action_set_vehicle_scale', 'VALUE', 'set vehicle size scale' );
actionDefDropdown( 'action_set_vehicle_visible', 'set vehicle visible', 'VIS', [ [ 'visible', '1' ], [ 'hidden', '0' ] ], null, null, VEH );
actionDef( 'action_set_drift', 'VALUE', 'set drift intensity (0-2)' );
actionDefDropdown( 'action_set_vehicle_model', 'set vehicle model', 'MODEL', [ [ 'Yellow', 'vehicle-truck-yellow' ], [ 'Green', 'vehicle-truck-green' ], [ 'Purple', 'vehicle-truck-purple' ], [ 'Red', 'vehicle-truck-red' ] ], null, null, VEH );

// ============ CAMERA ============
actionDef( 'action_camera_shake', 'INT', 'camera shake intensity' );
actionDef( 'action_set_camera_fov', 'VALUE', 'set camera FOV' );
actionDefDropdown( 'action_set_camera_mode', 'set camera mode', 'MODE', [ [ 'chase', 'chase' ], [ 'overview', 'overview' ] ], null, null, CAM );

// ============ FX / VISUALS ============
Blockly.Blocks.action_show_message = { init() { this.appendValueInput( 'TEXT' ).setCheck( [ 'String', 'Number' ] ).appendField( 'display message' ); this.appendValueInput( 'DURATION' ).setCheck( 'Number' ).appendField( 'for ms' ); this.setPreviousStatement( true ); this.setNextStatement( true ); this.setColour( FX ); } };
actionDef( 'action_spawn_particle', null, 'spawn smoke fx', FX );
actionDef( 'action_spawn_particle_burst', 'SECS', 'particle burst for seconds', FX );
actionDef( 'action_set_fog_strength', 'VALUE', 'set fog intensity (0-2)', FX );
actionDef( 'action_set_fog_density', 'VALUE', 'set fog density (0-2)', FX );
Blockly.Blocks.action_set_fog_color = { init() { this.appendDummyInput().appendField( 'set fog color' ).appendField( new Blockly.FieldColour( '#bfe0ff' ), 'COLOR' ); this.setPreviousStatement( true ); this.setNextStatement( true ); this.setColour( FX ); } };
Blockly.Blocks.action_set_background_color = { init() { this.appendDummyInput().appendField( 'set background color' ).appendField( new Blockly.FieldColour( '#bfe0ff' ), 'COLOR' ); this.setPreviousStatement( true ); this.setNextStatement( true ); this.setColour( FX ); } };
Blockly.Blocks.action_set_sky_color = { init() { this.appendDummyInput().appendField( 'set sky top color' ).appendField( new Blockly.FieldColour( '#1c5fd6' ), 'COLOR' ); this.setPreviousStatement( true ); this.setNextStatement( true ); this.setColour( FX ); } };
Blockly.Blocks.action_set_horizon_color = { init() { this.appendDummyInput().appendField( 'set horizon color' ).appendField( new Blockly.FieldColour( '#ffe2aa' ), 'COLOR' ); this.setPreviousStatement( true ); this.setNextStatement( true ); this.setColour( FX ); } };
Blockly.Blocks.action_set_particle_color = { init() { this.appendDummyInput().appendField( 'set particle color' ).appendField( new Blockly.FieldColour( '#ff4b1f' ), 'COLOR' ); this.setPreviousStatement( true ); this.setNextStatement( true ); this.setColour( FX ); } };
Blockly.Blocks.action_flash_screen = { init() { this.appendDummyInput().appendField( 'flash screen' ).appendField( new Blockly.FieldColour( '#ffffff' ), 'COLOR' ); this.setPreviousStatement( true ); this.setNextStatement( true ); this.setColour( FX ); } };
actionDef( 'action_set_sky_vibrance', 'VALUE', 'set sky vibrance (0-1)', FX );
actionDefDropdown( 'action_set_sky_palette', 'set sky/weather palette', 'PRESET', [ [ 'Clear', 'clear' ], [ 'Cloudy', 'cloudy' ], [ 'Sunset', 'sunset' ], [ 'Night', 'night' ], [ 'Dawn Mist', 'dawn-mist' ] ], null, null, FX );
actionDef( 'action_set_sun_intensity', 'VALUE', 'set sun intensity', FX );
actionDef( 'action_set_hemi_intensity', 'VALUE', 'set ambient light', FX );
actionDef( 'action_set_exposure', 'VALUE', 'set exposure', FX );

// ============ AUDIO ============
actionDef( 'action_set_engine_volume', 'VALUE', 'set engine volume (0-1)', AUD );
actionDef( 'action_set_music_volume', 'VALUE', 'set music volume (0-1)', AUD );
actionDef( 'action_play_impact', 'VELOCITY', 'play crash sound (velocity)', AUD );

// ============ HUD ============
Blockly.Blocks.action_set_hud_text = { init() { this.appendValueInput( 'TEXT' ).setCheck( [ 'String', 'Number' ] ).appendField( 'set HUD text' ); this.setPreviousStatement( true ); this.setNextStatement( true ); this.setColour( HUD ); } };
Blockly.Blocks.action_set_effect_message = { init() { this.appendValueInput( 'TEXT' ).setCheck( [ 'String', 'Number' ] ).appendField( 'show effect message' ); this.setPreviousStatement( true ); this.setNextStatement( true ); this.setColour( HUD ); } };
actionDefDropdown( 'action_set_fps_counter', 'FPS counter', 'VIS', [ [ 'show', '1' ], [ 'hide', '0' ] ], null, null, HUD );
actionDef( 'action_add_stunt_points', 'AMOUNT', 'add stunt points', HUD );
Blockly.Blocks.action_add_stunt_points_reason = { init() { this.appendValueInput( 'AMOUNT' ).setCheck( 'Number' ).appendField( 'add stunt points' ); this.appendValueInput( 'REASON' ).setCheck( 'String' ).appendField( 'reason' ); this.setPreviousStatement( true ); this.setNextStatement( true ); this.setColour( HUD ); } };
actionDef( 'action_add_coins', 'AMOUNT', 'add coins', HUD );

// ============ RENDERER / GRAPHICS ============
actionDef( 'action_set_pixel_ratio', 'VALUE', 'set pixel ratio (0.25-2)', WORLD );
actionDefDropdown( 'action_set_shadows', 'shadows', 'VIS', [ [ 'on', '1' ], [ 'off', '0' ] ], null, null, WORLD );

// ============ TIMERS & FLOW ============
actionDef( 'action_start_timer', 'SECS', 'start timer seconds', FLOW );
Blockly.Blocks.action_start_named_timer = { init() { this.appendValueInput( 'SECS' ).setCheck( 'Number' ).appendField( 'start timer' ).appendField( new Blockly.FieldTextInput( 'timer1' ), 'ID' ).appendField( 'for seconds' ); this.setPreviousStatement( true ); this.setNextStatement( true ); this.setColour( FLOW ); } };
actionDef( 'action_wait', 'SECS', 'wait seconds', FLOW );
Blockly.Blocks.action_random_delay = { init() { this.appendValueInput( 'MIN' ).setCheck( 'Number' ).appendField( 'random delay min' ); this.appendValueInput( 'MAX' ).setCheck( 'Number' ).appendField( 'max' ); this.setPreviousStatement( true ); this.setNextStatement( true ); this.setColour( FLOW ); } };
Blockly.Blocks.action_repeat = { init() { this.appendValueInput( 'TIMES' ).setCheck( 'Number' ).appendField( 'repeat' ); this.appendStatementInput( 'DO' ).appendField( 'do' ); this.setPreviousStatement( true ); this.setNextStatement( true ); this.setColour( FLOW ); } };
Blockly.Blocks.action_loop_forever = { init() { this.appendStatementInput( 'DO' ).appendField( 'loop forever' ); this.setPreviousStatement( true ); this.setNextStatement( true ); this.setColour( FLOW ); } };

// ============ VARIABLES ============
Blockly.Blocks.action_var_set = { init() { this.appendDummyInput().appendField( 'set variable' ).appendField( new Blockly.FieldTextInput( 'score' ), 'NAME' ); this.appendValueInput( 'VALUE' ).setCheck( 'Number' ).appendField( 'to' ); this.setPreviousStatement( true ); this.setNextStatement( true ); this.setColour( VAR ); } };
Blockly.Blocks.action_var_add = { init() { this.appendDummyInput().appendField( 'add variable' ).appendField( new Blockly.FieldTextInput( 'score' ), 'NAME' ); this.appendValueInput( 'VALUE' ).setCheck( 'Number' ).appendField( 'by' ); this.setPreviousStatement( true ); this.setNextStatement( true ); this.setColour( VAR ); } };
Blockly.Blocks.action_var_set_text = { init() { this.appendDummyInput().appendField( 'set text variable' ).appendField( new Blockly.FieldTextInput( 'note' ), 'NAME' ); this.appendValueInput( 'VALUE' ).setCheck( 'String' ).appendField( 'to' ); this.setPreviousStatement( true ); this.setNextStatement( true ); this.setColour( VAR ); } };
Blockly.Blocks.value_var_get = { init() { this.appendDummyInput().appendField( 'variable' ).appendField( new Blockly.FieldTextInput( 'score' ), 'NAME' ); this.setOutput( true, 'Number' ); this.setColour( VAR ); } };
Blockly.Blocks.value_text_var_get = { init() { this.appendDummyInput().appendField( 'text variable' ).appendField( new Blockly.FieldTextInput( 'note' ), 'NAME' ); this.setOutput( true, 'String' ); this.setColour( VAR ); } };

// ============ VALUE GETTERS ============
Blockly.Blocks.value_speed = { init() { this.appendDummyInput().appendField( 'current speed' ); this.setOutput( true, 'Number' ); this.setColour( VAR ); } };
Blockly.Blocks.value_lap_time = { init() { this.appendDummyInput().appendField( 'lap time' ); this.setOutput( true, 'Number' ); this.setColour( VAR ); } };
Blockly.Blocks.value_race_time = { init() { this.appendDummyInput().appendField( 'race time' ); this.setOutput( true, 'Number' ); this.setColour( VAR ); } };
Blockly.Blocks.value_checkpoint_number = { init() { this.appendDummyInput().appendField( 'checkpoint number' ); this.setOutput( true, 'Number' ); this.setColour( VAR ); } };
Blockly.Blocks.value_crash_force = { init() { this.appendDummyInput().appendField( 'crash force' ); this.setOutput( true, 'Number' ); this.setColour( VAR ); } };
Blockly.Blocks.value_random = { init() { this.appendDummyInput().appendField( 'random 0 to 1' ); this.setOutput( true, 'Number' ); this.setColour( VAR ); } };
Blockly.Blocks.value_coins = { init() { this.appendDummyInput().appendField( 'coins' ); this.setOutput( true, 'Number' ); this.setColour( VAR ); } };
Blockly.Blocks.value_lap_number = { init() { this.appendDummyInput().appendField( 'lap number' ); this.setOutput( true, 'Number' ); this.setColour( VAR ); } };
Blockly.Blocks.value_best_lap = { init() { this.appendDummyInput().appendField( 'best lap time' ); this.setOutput( true, 'Number' ); this.setColour( VAR ); } };
Blockly.Blocks.value_last_lap = { init() { this.appendDummyInput().appendField( 'last lap time' ); this.setOutput( true, 'Number' ); this.setColour( VAR ); } };
Blockly.Blocks.value_stunt_points = { init() { this.appendDummyInput().appendField( 'stunt points' ); this.setOutput( true, 'Number' ); this.setColour( VAR ); } };
Blockly.Blocks.value_stunt_combo = { init() { this.appendDummyInput().appendField( 'stunt combo' ); this.setOutput( true, 'Number' ); this.setColour( VAR ); } };
Blockly.Blocks.value_drift = { init() { this.appendDummyInput().appendField( 'drift intensity' ); this.setOutput( true, 'Number' ); this.setColour( VAR ); } };
Blockly.Blocks.value_angular_speed = { init() { this.appendDummyInput().appendField( 'angular speed' ); this.setOutput( true, 'Number' ); this.setColour( VAR ); } };
Blockly.Blocks.value_top_speed = { init() { this.appendDummyInput().appendField( 'top speed stat' ); this.setOutput( true, 'Number' ); this.setColour( VAR ); } };
Blockly.Blocks.value_accel_rate = { init() { this.appendDummyInput().appendField( 'accel rate stat' ); this.setOutput( true, 'Number' ); this.setColour( VAR ); } };
Blockly.Blocks.value_drive_force = { init() { this.appendDummyInput().appendField( 'drive force stat' ); this.setOutput( true, 'Number' ); this.setColour( VAR ); } };
Blockly.Blocks.value_grip_mult = { init() { this.appendDummyInput().appendField( 'grip multiplier' ); this.setOutput( true, 'Number' ); this.setColour( VAR ); } };
Blockly.Blocks.value_pos_x = { init() { this.appendDummyInput().appendField( 'position X' ); this.setOutput( true, 'Number' ); this.setColour( VAR ); } };
Blockly.Blocks.value_pos_y = { init() { this.appendDummyInput().appendField( 'position Y' ); this.setOutput( true, 'Number' ); this.setColour( VAR ); } };
Blockly.Blocks.value_pos_z = { init() { this.appendDummyInput().appendField( 'position Z' ); this.setOutput( true, 'Number' ); this.setColour( VAR ); } };
Blockly.Blocks.value_true = { init() { this.appendDummyInput().appendField( 'true' ); this.setOutput( true, 'Boolean' ); this.setColour( LOGIC ); } };
Blockly.Blocks.value_false = { init() { this.appendDummyInput().appendField( 'false' ); this.setOutput( true, 'Boolean' ); this.setColour( LOGIC ); } };
Blockly.Blocks.value_game_mode = { init() { this.appendDummyInput().appendField( 'game mode' ); this.setOutput( true, 'String' ); this.setColour( VAR ); } };

// ============ MATH ============
Blockly.Blocks.math_number = { init() { this.appendDummyInput().appendField( new Blockly.FieldNumber( 0 ), 'NUM' ); this.setOutput( true, 'Number' ); this.setColour( MATH ); } };
Blockly.Blocks.math_arithmetic = { init() { this.appendValueInput( 'A' ).setCheck( 'Number' ).appendField( '' ); this.appendValueInput( 'B' ).setCheck( 'Number' ).appendField( new Blockly.FieldDropdown( [ [ '+', 'ADD' ], [ '−', 'MINUS' ], [ '×', 'MULTIPLY' ], [ '÷', 'DIVIDE' ], [ '%', 'MODULO' ], [ '^', 'POWER' ] ] ), 'OP' ); this.setInputsInline( true ); this.setOutput( true, 'Number' ); this.setColour( MATH ); } };
Blockly.Blocks.math_single = { init() { this.appendValueInput( 'NUM' ).setCheck( 'Number' ).appendField( new Blockly.FieldDropdown( [ [ 'absolute', 'ABS' ], [ 'negate', 'NEG' ], [ 'round', 'ROUND' ], [ 'floor', 'FLOOR' ], [ 'ceiling', 'CEIL' ], [ 'square root', 'SQRT' ], [ 'sine', 'SIN' ], [ 'cosine', 'COS' ], [ 'tangent', 'TAN' ] ] ), 'OP' ); this.setOutput( true, 'Number' ); this.setColour( MATH ); } };
Blockly.Blocks.math_clamp = { init() { this.appendValueInput( 'VALUE' ).setCheck( 'Number' ).appendField( 'clamp' ); this.appendValueInput( 'MIN' ).setCheck( 'Number' ).appendField( 'min' ); this.appendValueInput( 'MAX' ).setCheck( 'Number' ).appendField( 'max' ); this.setInputsInline( true ); this.setOutput( true, 'Number' ); this.setColour( MATH ); } };
Blockly.Blocks.math_min_max = { init() { this.appendValueInput( 'A' ).setCheck( 'Number' ).appendField( new Blockly.FieldDropdown( [ [ 'min of', 'MIN' ], [ 'max of', 'MAX' ] ] ), 'OP' ); this.appendValueInput( 'B' ).setCheck( 'Number' ).appendField( 'and' ); this.setInputsInline( true ); this.setOutput( true, 'Number' ); this.setColour( MATH ); } };
Blockly.Blocks.math_pi = { init() { this.appendDummyInput().appendField( 'π' ); this.setOutput( true, 'Number' ); this.setColour( MATH ); } };
Blockly.Blocks.math_deg_to_rad = { init() { this.appendValueInput( 'DEG' ).setCheck( 'Number' ).appendField( 'degrees' ).appendField( '→ radians' ); this.setInputsInline( true ); this.setOutput( true, 'Number' ); this.setColour( MATH ); } };
Blockly.Blocks.math_rad_to_deg = { init() { this.appendValueInput( 'RAD' ).setCheck( 'Number' ).appendField( 'radians' ).appendField( '→ degrees' ); this.setInputsInline( true ); this.setOutput( true, 'Number' ); this.setColour( MATH ); } };

// ============ LOGIC ============
// NOTE: `controls_if` is intentionally NOT redefined — the official Blockly mutator
// version is kept so the flyout never desyncs. The parser reads IF0/DO0, which the
// official block exposes in its default single-branch state.
Blockly.Blocks.controls_if_else = { init() { this.appendValueInput( 'IF0' ).setCheck( 'Boolean' ).appendField( 'if' ); this.appendStatementInput( 'DO0' ).appendField( 'then' ); this.appendStatementInput( 'ELSE' ).appendField( 'else' ); this.setPreviousStatement( true ); this.setNextStatement( true ); this.setColour( LOGIC ); } };
Blockly.Blocks.logic_compare = { init() { this.appendValueInput( 'A' ).appendField( '' ); this.appendValueInput( 'B' ).appendField( new Blockly.FieldDropdown( [ [ '=', 'EQ' ], [ '≠', 'NEQ' ], [ '<', 'LT' ], [ '≤', 'LTE' ], [ '>', 'GT' ], [ '≥', 'GTE' ] ] ), 'OP' ); this.setInputsInline( true ); this.setOutput( true, 'Boolean' ); this.setColour( LOGIC ); } };
Blockly.Blocks.logic_operation = { init() { this.appendValueInput( 'A' ).setCheck( 'Boolean' ); this.appendValueInput( 'B' ).setCheck( 'Boolean' ).appendField( new Blockly.FieldDropdown( [ [ 'and', 'AND' ], [ 'or', 'OR' ] ] ), 'OP' ); this.setInputsInline( true ); this.setOutput( true, 'Boolean' ); this.setColour( LOGIC ); } };
Blockly.Blocks.logic_negate = { init() { this.appendValueInput( 'BOOL' ).setCheck( 'Boolean' ).appendField( 'not' ); this.setOutput( true, 'Boolean' ); this.setColour( LOGIC ); } };
Blockly.Blocks.logic_is_airborne = { init() { this.appendDummyInput().appendField( 'is airborne' ); this.setOutput( true, 'Boolean' ); this.setColour( LOGIC ); } };
Blockly.Blocks.logic_is_drifting = { init() { this.appendDummyInput().appendField( 'is drifting' ); this.setOutput( true, 'Boolean' ); this.setColour( LOGIC ); } };
Blockly.Blocks.logic_key_down = { init() { this.appendDummyInput().appendField( 'key' ).appendField( new Blockly.FieldDropdown( [ [ 'W', 'KeyW' ], [ 'A', 'KeyA' ], [ 'S', 'KeyS' ], [ 'D', 'KeyD' ], [ 'Space', 'Space' ], [ 'X', 'KeyX' ] ] ), 'KEY' ).appendField( 'is down' ); this.setOutput( true, 'Boolean' ); this.setColour( LOGIC ); } };

// ============ TEXT ============
Blockly.Blocks.text = { init() { this.appendDummyInput().appendField( new Blockly.FieldTextInput( '' ), 'TEXT' ); this.setOutput( true, 'String' ); this.setColour( TXT ); } };
Blockly.Blocks.text_combine = { init() { this.appendValueInput( 'A' ).setCheck( [ 'String', 'Number' ] ).appendField( 'join' ); this.appendValueInput( 'B' ).setCheck( [ 'String', 'Number' ] ).appendField( 'with' ); this.setInputsInline( true ); this.setOutput( true, 'String' ); this.setColour( TXT ); } };
Blockly.Blocks.text_to_string = { init() { this.appendValueInput( 'VALUE' ).appendField( 'to text' ); this.setOutput( true, 'String' ); this.setColour( TXT ); } };
Blockly.Blocks.text_round_num = { init() { this.appendValueInput( 'VALUE' ).setCheck( 'Number' ).appendField( 'round' ).appendField( new Blockly.FieldNumber( 0, 0, 10 ), 'PLACES' ).appendField( 'places' ); this.setInputsInline( true ); this.setOutput( true, 'String' ); this.setColour( TXT ); } };

// ============ LISTS ============
Blockly.Blocks.lists_create = { init() { this.appendDummyInput().appendField( 'create list' ); this.setOutput( true, 'Array' ); this.setColour( LIST ); } };
Blockly.Blocks.lists_length = { init() { this.appendValueInput( 'LIST' ).setCheck( 'Array' ).appendField( 'length of' ); this.setOutput( true, 'Number' ); this.setColour( LIST ); } };

// ============ UI BUILDER (sandboxed overlay) ============
const UI_COLOR = '#f97316';
Blockly.Blocks.ui_create_panel = { init() { this.appendValueInput( 'X' ).setCheck( 'Number' ).appendField( 'create panel at X' ); this.appendValueInput( 'Y' ).setCheck( 'Number' ).appendField( 'Y' ); this.appendValueInput( 'TITLE' ).setCheck( 'String' ).appendField( 'title' ); this.appendDummyInput().appendField( 'store as' ).appendField( new Blockly.FieldTextInput( 'panel' ), 'NAME' ); this.setPreviousStatement( true ); this.setNextStatement( true ); this.setColour( UI_COLOR ); } };
Blockly.Blocks.ui_create_button = { init() { this.appendValueInput( 'LABEL' ).setCheck( 'String' ).appendField( 'create button labelled' ); this.appendDummyInput().appendField( 'store as' ).appendField( new Blockly.FieldTextInput( 'btn' ), 'NAME' ); this.appendStatementInput( 'DO' ).appendField( 'on click' ); this.setPreviousStatement( true ); this.setNextStatement( true ); this.setColour( UI_COLOR ); } };
Blockly.Blocks.ui_create_label = { init() { this.appendValueInput( 'TEXT' ).setCheck( 'String' ).appendField( 'create label' ); this.appendDummyInput().appendField( 'store as' ).appendField( new Blockly.FieldTextInput( 'lbl' ), 'NAME' ); this.setPreviousStatement( true ); this.setNextStatement( true ); this.setColour( UI_COLOR ); } };
Blockly.Blocks.ui_create_slider = { init() { this.appendValueInput( 'LABEL' ).setCheck( 'String' ).appendField( 'create slider labelled' ); this.appendValueInput( 'MIN' ).setCheck( 'Number' ).appendField( 'min' ); this.appendValueInput( 'MAX' ).setCheck( 'Number' ).appendField( 'max' ); this.appendValueInput( 'VALUE' ).setCheck( 'Number' ).appendField( 'start' ); this.appendDummyInput().appendField( 'store value in' ).appendField( new Blockly.FieldTextInput( 'sliderVal' ), 'NAME' ); this.appendStatementInput( 'DO' ).appendField( 'on change' ); this.setPreviousStatement( true ); this.setNextStatement( true ); this.setColour( UI_COLOR ); } };
Blockly.Blocks.ui_set_text = { init() { this.appendDummyInput().appendField( 'set text of' ).appendField( new Blockly.FieldTextInput( 'lbl' ), 'NAME' ); this.appendValueInput( 'TEXT' ).setCheck( 'String' ).appendField( 'to' ); this.setPreviousStatement( true ); this.setNextStatement( true ); this.setColour( UI_COLOR ); } };
Blockly.Blocks.ui_set_style = { init() { this.appendDummyInput().appendField( 'set style of' ).appendField( new Blockly.FieldTextInput( 'lbl' ), 'NAME' ); this.appendValueInput( 'PROP' ).setCheck( 'String' ).appendField( 'property' ); this.appendValueInput( 'VALUE' ).setCheck( 'String' ).appendField( 'to' ); this.setPreviousStatement( true ); this.setNextStatement( true ); this.setColour( UI_COLOR ); } };
Blockly.Blocks.ui_append = { init() { this.appendDummyInput().appendField( 'put' ).appendField( new Blockly.FieldTextInput( 'btn' ), 'CHILD' ).appendField( 'inside' ).appendField( new Blockly.FieldTextInput( 'panel' ), 'PARENT' ); this.setPreviousStatement( true ); this.setNextStatement( true ); this.setColour( UI_COLOR ); } };
Blockly.Blocks.ui_remove = { init() { this.appendDummyInput().appendField( 'remove element' ).appendField( new Blockly.FieldTextInput( 'lbl' ), 'NAME' ); this.setPreviousStatement( true ); this.setNextStatement( true ); this.setColour( UI_COLOR ); } };
Blockly.Blocks.ui_clear = { init() { this.appendDummyInput().appendField( 'clear all mod UI' ); this.setPreviousStatement( true ); this.setNextStatement( true ); this.setColour( UI_COLOR ); } };
Blockly.Blocks.ui_show = { init() { this.appendDummyInput().appendField( 'show element' ).appendField( new Blockly.FieldTextInput( 'panel' ), 'NAME' ); this.setPreviousStatement( true ); this.setNextStatement( true ); this.setColour( UI_COLOR ); } };
Blockly.Blocks.ui_hide = { init() { this.appendDummyInput().appendField( 'hide element' ).appendField( new Blockly.FieldTextInput( 'panel' ), 'NAME' ); this.setPreviousStatement( true ); this.setNextStatement( true ); this.setColour( UI_COLOR ); } };
Blockly.Blocks.value_ui_element_text = { init() { this.appendDummyInput().appendField( 'text of element' ).appendField( new Blockly.FieldTextInput( 'lbl' ), 'NAME' ); this.setOutput( true, 'String' ); this.setColour( UI_COLOR ); } };

// ============ STORAGE (namespaced, capped) ============
const STO_COLOR = '#84cc16';
Blockly.Blocks.storage_set = { init() { this.appendValueInput( 'KEY' ).setCheck( 'String' ).appendField( 'store' ); this.appendValueInput( 'VALUE' ).appendField( 'value under key' ); this.setPreviousStatement( true ); this.setNextStatement( true ); this.setColour( STO_COLOR ); } };
Blockly.Blocks.storage_set_num = { init() { this.appendValueInput( 'KEY' ).setCheck( 'String' ).appendField( 'store number' ); this.appendValueInput( 'VALUE' ).setCheck( 'Number' ).appendField( 'under key' ); this.setPreviousStatement( true ); this.setNextStatement( true ); this.setColour( STO_COLOR ); } };
Blockly.Blocks.storage_get = { init() { this.appendValueInput( 'KEY' ).setCheck( 'String' ).appendField( 'get value under key' ); this.appendValueInput( 'DEFAULT' ).appendField( 'or default' ); this.setOutput( true, null ); this.setColour( STO_COLOR ); } };
Blockly.Blocks.storage_remove = { init() { this.appendValueInput( 'KEY' ).setCheck( 'String' ).appendField( 'delete key' ); this.setPreviousStatement( true ); this.setNextStatement( true ); this.setColour( STO_COLOR ); } };
Blockly.Blocks.storage_clear = { init() { this.appendDummyInput().appendField( 'clear all stored mod data' ); this.setPreviousStatement( true ); this.setNextStatement( true ); this.setColour( STO_COLOR ); } };
Blockly.Blocks.storage_has = { init() { this.appendValueInput( 'KEY' ).setCheck( 'String' ).appendField( 'has key' ); this.setOutput( true, 'Boolean' ); this.setColour( STO_COLOR ); } };

// ============ GAME CONTROL (safe) ============
Blockly.Blocks.action_respawn = { init() { this.appendDummyInput().appendField( 'trigger respawn' ); this.setPreviousStatement( true ); this.setNextStatement( true ); this.setColour( FLOW ); } };
Blockly.Blocks.action_pause = { init() { this.appendDummyInput().appendField( 'pause game' ); this.setPreviousStatement( true ); this.setNextStatement( true ); this.setColour( FLOW ); } };
Blockly.Blocks.action_resume = { init() { this.appendDummyInput().appendField( 'resume game' ); this.setPreviousStatement( true ); this.setNextStatement( true ); this.setColour( FLOW ); } };
Blockly.Blocks.value_is_paused = { init() { this.appendDummyInput().appendField( 'is paused' ); this.setOutput( true, 'Boolean' ); this.setColour( LOGIC ); } };
Blockly.Blocks.value_fps = { init() { this.appendDummyInput().appendField( 'FPS' ); this.setOutput( true, 'Number' ); this.setColour( VAR ); } };
Blockly.Blocks.value_dt = { init() { this.appendDummyInput().appendField( 'frame delta time' ); this.setOutput( true, 'Number' ); this.setColour( VAR ); } };

// ============ STRING / COLOR VALUES ============
Blockly.Blocks.value_color = { init() { this.appendDummyInput().appendField( 'color' ).appendField( new Blockly.FieldColour( '#ff4b1f' ), 'COLOR' ); this.setOutput( true, 'String' ); this.setColour( FX ); } };
Blockly.Blocks.text_length = { init() { this.appendValueInput( 'TEXT' ).setCheck( 'String' ).appendField( 'length of text' ); this.setOutput( true, 'Number' ); this.setColour( TXT ); } };
Blockly.Blocks.text_contains = { init() { this.appendValueInput( 'TEXT' ).setCheck( 'String' ).appendField( 'text' ); this.appendValueInput( 'SUB' ).setCheck( 'String' ).appendField( 'contains' ); this.setInputsInline( true ); this.setOutput( true, 'Boolean' ); this.setColour( TXT ); } };
Blockly.Blocks.text_upper = { init() { this.appendValueInput( 'TEXT' ).setCheck( 'String' ).appendField( 'uppercase' ); this.setOutput( true, 'String' ); this.setColour( TXT ); } };
Blockly.Blocks.text_lower = { init() { this.appendValueInput( 'TEXT' ).setCheck( 'String' ).appendField( 'lowercase' ); this.setOutput( true, 'String' ); this.setColour( TXT ); } };

// Register built-in Blockly blocks that may be missing in the min build.
if ( ! Blockly.Blocks.math_number ) Blockly.Blocks.math_number = { init() { this.appendDummyInput().appendField( new Blockly.FieldNumber( 0 ), 'NUM' ); this.setOutput( true, 'Number' ); this.setColour( MATH ); } };

// ============ EXTENDED BLOCKS ============
// A large, safe set of additional blocks so modders can build genuinely interesting
// features. Pure blocks (math/text/logic/lists/variables) are resolved entirely by the
// generated runtime interpreter, so they always work and cannot exploit the game.
// Action blocks are wired to clamped, capability-checked api methods only.

// Helper: value-output block with one labelled value input.
function valDef( name, label, inputField, inputCheck = 'Number', color = MATH, inputLabel = '' ) {
	Blockly.Blocks[ name ] = {
		init() {
			if ( inputField ) { this.appendValueInput( inputField ).setCheck( inputCheck ).appendField( inputLabel || label ); }
			else { this.appendDummyInput().appendField( label ); }
			this.setOutput( true, null );
			this.setColour( color );
		},
	};
}

// ---- MATH (extended) ----
Blockly.Blocks.math_round_int = { init() { this.appendValueInput( 'NUM' ).setCheck( 'Number' ).appendField( 'round to integer' ); this.setOutput( true, 'Number' ); this.setColour( MATH ); } };
Blockly.Blocks.math_random_int = { init() { this.appendValueInput( 'MIN' ).setCheck( 'Number' ).appendField( 'random integer from' ); this.appendValueInput( 'MAX' ).setCheck( 'Number' ).appendField( 'to' ); this.setInputsInline( true ); this.setOutput( true, 'Number' ); this.setColour( MATH ); } };
Blockly.Blocks.math_random_range = { init() { this.appendValueInput( 'MIN' ).setCheck( 'Number' ).appendField( 'random decimal from' ); this.appendValueInput( 'MAX' ).setCheck( 'Number' ).appendField( 'to' ); this.setInputsInline( true ); this.setOutput( true, 'Number' ); this.setColour( MATH ); } };
Blockly.Blocks.math_lerp = { init() { this.appendValueInput( 'A' ).setCheck( 'Number' ).appendField( 'lerp from' ); this.appendValueInput( 'B' ).setCheck( 'Number' ).appendField( 'to' ); this.appendValueInput( 'T' ).setCheck( 'Number' ).appendField( 'by' ); this.setInputsInline( true ); this.setOutput( true, 'Number' ); this.setColour( MATH ); } };
Blockly.Blocks.math_map_range = { init() { this.appendValueInput( 'VALUE' ).setCheck( 'Number' ).appendField( 'map' ); this.appendValueInput( 'INMIN' ).setCheck( 'Number' ).appendField( 'from range' ); this.appendValueInput( 'INMAX' ).setCheck( 'Number' ).appendField( 'to' ); this.appendValueInput( 'OUTMIN' ).setCheck( 'Number' ).appendField( '→ range' ); this.appendValueInput( 'OUTMAX' ).setCheck( 'Number' ).appendField( 'to' ); this.setInputsInline( true ); this.setOutput( true, 'Number' ); this.setColour( MATH ); } };
Blockly.Blocks.math_adv_single = { init() { this.appendValueInput( 'NUM' ).setCheck( 'Number' ).appendField( new Blockly.FieldDropdown( [ [ 'sign', 'SIGN' ], [ 'natural log', 'LOG' ], [ 'log base 10', 'LOG10' ], [ 'e^', 'EXP' ], [ 'truncate', 'TRUNC' ], [ 'arcsine', 'ASIN' ], [ 'arccosine', 'ACOS' ], [ 'arctangent', 'ATAN' ], [ 'tanh', 'TANH' ], [ 'sinh', 'SINH' ], [ 'cosh', 'COSH' ], [ 'reciprocal', 'RECIP' ], [ 'degrees', 'DEG' ], [ 'radians', 'RAD' ] ] ), 'OP' ); this.setOutput( true, 'Number' ); this.setColour( MATH ); } };
Blockly.Blocks.math_pair = { init() { this.appendValueInput( 'A' ).setCheck( 'Number' ).appendField( '' ); this.appendValueInput( 'B' ).setCheck( 'Number' ).appendField( new Blockly.FieldDropdown( [ [ 'arctan2 of', 'ATAN2' ], [ 'distance of', 'DIST' ], [ 'hypotenuse of', 'HYPOT' ], [ 'gcd of', 'GCD' ], [ 'quotient of', 'QUOT' ], [ 'remainder of', 'REM' ], [ 'a is what % of', 'PCT' ] ] ), 'OP' ); this.setInputsInline( true ); this.setOutput( true, 'Number' ); this.setColour( MATH ); } };
Blockly.Blocks.math_constant = { init() { this.appendDummyInput().appendField( new Blockly.FieldDropdown( [ [ 'e', 'E' ], [ 'τ (2π)', 'TAU' ], [ 'φ (golden ratio)', 'PHI' ], [ '√2', 'SQRT2' ] ] ), 'CONST' ); this.setOutput( true, 'Number' ); this.setColour( MATH ); } };
Blockly.Blocks.math_divisible = { init() { this.appendValueInput( 'A' ).setCheck( 'Number' ).appendField( '' ); this.appendValueInput( 'B' ).setCheck( 'Number' ).appendField( 'divisible by' ); this.setInputsInline( true ); this.setOutput( true, 'Boolean' ); this.setColour( MATH ); } };
Blockly.Blocks.math_between = { init() { this.appendValueInput( 'VALUE' ).setCheck( 'Number' ).appendField( 'is' ); this.appendValueInput( 'MIN' ).setCheck( 'Number' ).appendField( 'between' ); this.appendValueInput( 'MAX' ).setCheck( 'Number' ).appendField( 'and' ); this.setInputsInline( true ); this.setOutput( true, 'Boolean' ); this.setColour( MATH ); } };

// ---- LOGIC (extended) ----
Blockly.Blocks.logic_xor = { init() { this.appendValueInput( 'A' ).setCheck( 'Boolean' ).appendField( '' ); this.appendValueInput( 'B' ).setCheck( 'Boolean' ).appendField( 'xor' ); this.setInputsInline( true ); this.setOutput( true, 'Boolean' ); this.setColour( LOGIC ); } };
Blockly.Blocks.logic_is_even = { init() { this.appendValueInput( 'NUM' ).setCheck( 'Number' ).appendField( 'is even' ); this.setOutput( true, 'Boolean' ); this.setColour( LOGIC ); } };
Blockly.Blocks.logic_is_positive = { init() { this.appendValueInput( 'NUM' ).setCheck( 'Number' ).appendField( 'is positive' ); this.setOutput( true, 'Boolean' ); this.setColour( LOGIC ); } };
Blockly.Blocks.logic_is_integer = { init() { this.appendValueInput( 'NUM' ).setCheck( 'Number' ).appendField( 'is integer' ); this.setOutput( true, 'Boolean' ); this.setColour( LOGIC ); } };
Blockly.Blocks.logic_is_zero = { init() { this.appendValueInput( 'NUM' ).setCheck( 'Number' ).appendField( 'is zero' ); this.setOutput( true, 'Boolean' ); this.setColour( LOGIC ); } };
Blockly.Blocks.logic_text_equals = { init() { this.appendValueInput( 'A' ).setCheck( 'String' ).appendField( '' ); this.appendValueInput( 'B' ).setCheck( 'String' ).appendField( new Blockly.FieldDropdown( [ [ 'equals (ignore case)', 'EQIC' ], [ 'starts with', 'STARTS' ], [ 'ends with', 'ENDS' ] ] ), 'OP' ); this.setInputsInline( true ); this.setOutput( true, 'Boolean' ); this.setColour( LOGIC ); } };
Blockly.Blocks.logic_is_empty = { init() { this.appendValueInput( 'VALUE' ).appendField( 'is empty' ); this.setOutput( true, 'Boolean' ); this.setColour( LOGIC ); } };

// ---- TEXT (extended) ----
Blockly.Blocks.text_substring = { init() { this.appendValueInput( 'TEXT' ).setCheck( 'String' ).appendField( 'substring of' ); this.appendValueInput( 'START' ).setCheck( 'Number' ).appendField( 'from' ); this.appendValueInput( 'END' ).setCheck( 'Number' ).appendField( 'to' ); this.setInputsInline( true ); this.setOutput( true, 'String' ); this.setColour( TXT ); } };
Blockly.Blocks.text_char_at = { init() { this.appendValueInput( 'TEXT' ).setCheck( 'String' ).appendField( 'character' ); this.appendValueInput( 'INDEX' ).setCheck( 'Number' ).appendField( 'of' ); this.setInputsInline( true ); this.setOutput( true, 'String' ); this.setColour( TXT ); } };
Blockly.Blocks.text_index_of = { init() { this.appendValueInput( 'TEXT' ).setCheck( 'String' ).appendField( 'first position of' ); this.appendValueInput( 'SUB' ).setCheck( 'String' ).appendField( 'in' ); this.setInputsInline( true ); this.setOutput( true, 'Number' ); this.setColour( TXT ); } };
Blockly.Blocks.text_replace = { init() { this.appendValueInput( 'TEXT' ).setCheck( 'String' ).appendField( 'in' ); this.appendValueInput( 'FROM' ).setCheck( 'String' ).appendField( 'replace' ); this.appendValueInput( 'TO' ).setCheck( 'String' ).appendField( 'with' ); this.setInputsInline( true ); this.setOutput( true, 'String' ); this.setColour( TXT ); } };
Blockly.Blocks.text_replace_all = { init() { this.appendValueInput( 'TEXT' ).setCheck( 'String' ).appendField( 'in' ); this.appendValueInput( 'FROM' ).setCheck( 'String' ).appendField( 'replace all' ); this.appendValueInput( 'TO' ).setCheck( 'String' ).appendField( 'with' ); this.setInputsInline( true ); this.setOutput( true, 'String' ); this.setColour( TXT ); } };
Blockly.Blocks.text_repeat = { init() { this.appendValueInput( 'TEXT' ).setCheck( 'String' ).appendField( 'repeat' ); this.appendValueInput( 'TIMES' ).setCheck( 'Number' ).appendField( 'times' ); this.setInputsInline( true ); this.setOutput( true, 'String' ); this.setColour( TXT ); } };
Blockly.Blocks.text_trim = { init() { this.appendValueInput( 'TEXT' ).setCheck( 'String' ).appendField( 'trim spaces' ); this.setOutput( true, 'String' ); this.setColour( TXT ); } };
Blockly.Blocks.text_pad = { init() { this.appendValueInput( 'TEXT' ).setCheck( 'String' ).appendField( '' ); this.appendValueInput( 'LENGTH' ).setCheck( 'Number' ).appendField( new Blockly.FieldDropdown( [ [ 'pad left to', 'PADL' ], [ 'pad right to', 'PADR' ] ] ), 'OP' ).appendField( 'length' ); this.appendValueInput( 'CHAR' ).setCheck( 'String' ).appendField( 'with' ); this.setInputsInline( true ); this.setOutput( true, 'String' ); this.setColour( TXT ); } };
Blockly.Blocks.text_reverse = { init() { this.appendValueInput( 'TEXT' ).setCheck( 'String' ).appendField( 'reverse' ); this.setOutput( true, 'String' ); this.setColour( TXT ); } };
Blockly.Blocks.text_count = { init() { this.appendValueInput( 'TEXT' ).setCheck( 'String' ).appendField( 'count' ); this.appendValueInput( 'SUB' ).setCheck( 'String' ).appendField( 'in' ); this.setInputsInline( true ); this.setOutput( true, 'Number' ); this.setColour( TXT ); } };
Blockly.Blocks.text_to_number = { init() { this.appendValueInput( 'TEXT' ).setCheck( 'String' ).appendField( 'text to number' ); this.setOutput( true, 'Number' ); this.setColour( TXT ); } };
Blockly.Blocks.text_split = { init() { this.appendValueInput( 'TEXT' ).setCheck( 'String' ).appendField( 'split' ); this.appendValueInput( 'SEP' ).setCheck( 'String' ).appendField( 'by' ); this.setInputsInline( true ); this.setOutput( true, 'Array' ); this.setColour( TXT ); } };
Blockly.Blocks.text_first_char = { init() { this.appendValueInput( 'TEXT' ).setCheck( 'String' ).appendField( 'first character of' ); this.setOutput( true, 'String' ); this.setColour( TXT ); } };
Blockly.Blocks.text_last_char = { init() { this.appendValueInput( 'TEXT' ).setCheck( 'String' ).appendField( 'last character of' ); this.setOutput( true, 'String' ); this.setColour( TXT ); } };
Blockly.Blocks.text_slice = { init() { this.appendValueInput( 'TEXT' ).setCheck( 'String' ).appendField( 'slice' ); this.appendValueInput( 'START' ).setCheck( 'Number' ).appendField( 'from' ); this.appendValueInput( 'LEN' ).setCheck( 'Number' ).appendField( 'length' ); this.setInputsInline( true ); this.setOutput( true, 'String' ); this.setColour( TXT ); } };
Blockly.Blocks.text_char_code = { init() { this.appendValueInput( 'TEXT' ).setCheck( 'String' ).appendField( 'char code of' ); this.setOutput( true, 'Number' ); this.setColour( TXT ); } };
Blockly.Blocks.text_from_char_code = { init() { this.appendValueInput( 'NUM' ).setCheck( 'Number' ).appendField( 'character from code' ); this.setOutput( true, 'String' ); this.setColour( TXT ); } };

// ---- LISTS (fixed + extended) — lists carry value-specs, resolved at eval time ----
// NOTE: lists_create_with is intentionally a fixed-size block. The previous version
// called `new Blockly.Mutator(...)`, but Blockly >=11 no longer exports `Blockly.Mutator`
// from blockly.min.js, so that constructor threw a TypeError during init() and froze the
// entire Lists toolbox flyout. A mutator is not needed for mod use; a 3-item list is plenty.
Blockly.Blocks.lists_create_with = { init() { this.appendDummyInput().appendField( 'create list with' ); this.appendValueInput( 'ADD0' ).setCheck( null ).appendField( 'item' ); this.appendValueInput( 'ADD1' ).setCheck( null ).appendField( 'item' ); this.appendValueInput( 'ADD2' ).setCheck( null ).appendField( 'item' ); this.setOutput( true, 'Array' ); this.setColour( LIST ); } };
// Kept so older saved XML that references lists_item still loads instead of breaking the canvas.
Blockly.Blocks.lists_item = { init() { this.appendDummyInput().appendField( 'item' ); this.setPreviousStatement( true ); this.setNextStatement( true ); this.setColour( LIST ); } };
Blockly.Blocks.lists_get_index = { init() { this.appendValueInput( 'LIST' ).setCheck( 'Array' ).appendField( 'in list' ); this.appendValueInput( 'INDEX' ).setCheck( 'Number' ).appendField( 'get item' ); this.setInputsInline( true ); this.setOutput( true, null ); this.setColour( LIST ); } };
Blockly.Blocks.lists_contains = { init() { this.appendValueInput( 'LIST' ).setCheck( 'Array' ).appendField( 'list' ); this.appendValueInput( 'VALUE' ).appendField( 'has' ); this.setInputsInline( true ); this.setOutput( true, 'Boolean' ); this.setColour( LIST ); } };
Blockly.Blocks.lists_index_of = { init() { this.appendValueInput( 'LIST' ).setCheck( 'Array' ).appendField( 'in list' ); this.appendValueInput( 'VALUE' ).appendField( 'position of' ); this.setInputsInline( true ); this.setOutput( true, 'Number' ); this.setColour( LIST ); } };
Blockly.Blocks.lists_reverse = { init() { this.appendValueInput( 'LIST' ).setCheck( 'Array' ).appendField( 'reverse' ); this.setOutput( true, 'Array' ); this.setColour( LIST ); } };
Blockly.Blocks.lists_sort = { init() { this.appendValueInput( 'LIST' ).setCheck( 'Array' ).appendField( new Blockly.FieldDropdown( [ [ 'sort ascending', 'ASC' ], [ 'sort descending', 'DESC' ] ] ), 'OP' ); this.setOutput( true, 'Array' ); this.setColour( LIST ); } };
Blockly.Blocks.lists_sum = { init() { this.appendValueInput( 'LIST' ).setCheck( 'Array' ).appendField( 'sum of' ); this.setOutput( true, 'Number' ); this.setColour( LIST ); } };
Blockly.Blocks.lists_max = { init() { this.appendValueInput( 'LIST' ).setCheck( 'Array' ).appendField( new Blockly.FieldDropdown( [ [ 'max of', 'MAX' ], [ 'min of', 'MIN' ] ] ), 'OP' ); this.setOutput( true, 'Number' ); this.setColour( LIST ); } };
Blockly.Blocks.lists_average = { init() { this.appendValueInput( 'LIST' ).setCheck( 'Array' ).appendField( 'average of' ); this.setOutput( true, 'Number' ); this.setColour( LIST ); } };
Blockly.Blocks.lists_join = { init() { this.appendValueInput( 'LIST' ).setCheck( 'Array' ).appendField( 'join list' ); this.appendValueInput( 'SEP' ).setCheck( 'String' ).appendField( 'with' ); this.setInputsInline( true ); this.setOutput( true, 'String' ); this.setColour( LIST ); } };
Blockly.Blocks.lists_first = { init() { this.appendValueInput( 'LIST' ).setCheck( 'Array' ).appendField( 'first item of' ); this.setOutput( true, null ); this.setColour( LIST ); } };
Blockly.Blocks.lists_last = { init() { this.appendValueInput( 'LIST' ).setCheck( 'Array' ).appendField( 'last item of' ); this.setOutput( true, null ); this.setColour( LIST ); } };
Blockly.Blocks.action_lists_set = { init() { this.appendValueInput( 'VAR' ).setCheck( 'String' ).appendField( 'in list variable' ); this.appendValueInput( 'INDEX' ).setCheck( 'Number' ).appendField( 'set index' ); this.appendValueInput( 'VALUE' ).appendField( 'to' ); this.setInputsInline( true ); this.setPreviousStatement( true ); this.setNextStatement( true ); this.setColour( LIST ); } };
Blockly.Blocks.action_lists_add = { init() { this.appendValueInput( 'VAR' ).setCheck( 'String' ).appendField( 'to list variable' ); this.appendValueInput( 'VALUE' ).appendField( 'add' ); this.setInputsInline( true ); this.setPreviousStatement( true ); this.setNextStatement( true ); this.setColour( LIST ); } };
Blockly.Blocks.action_lists_remove = { init() { this.appendValueInput( 'VAR' ).setCheck( 'String' ).appendField( 'from list variable' ); this.appendValueInput( 'INDEX' ).setCheck( 'Number' ).appendField( 'remove index' ); this.setInputsInline( true ); this.setPreviousStatement( true ); this.setNextStatement( true ); this.setColour( LIST ); } };
Blockly.Blocks.action_lists_clear = { init() { this.appendValueInput( 'VAR' ).setCheck( 'String' ).appendField( 'clear list variable' ); this.setInputsInline( true ); this.setPreviousStatement( true ); this.setNextStatement( true ); this.setColour( LIST ); } };
Blockly.Blocks.value_list_get = { init() { this.appendDummyInput().appendField( 'list variable' ).appendField( new Blockly.FieldTextInput( 'mylist' ), 'NAME' ); this.setOutput( true, 'Array' ); this.setColour( LIST ); } };

// ---- VARIABLES (extended) ----
Blockly.Blocks.action_var_multiply = { init() { this.appendDummyInput().appendField( 'multiply variable' ).appendField( new Blockly.FieldTextInput( 'score' ), 'NAME' ); this.appendValueInput( 'VALUE' ).setCheck( 'Number' ).appendField( 'by' ); this.setPreviousStatement( true ); this.setNextStatement( true ); this.setColour( VAR ); } };
Blockly.Blocks.action_var_divide = { init() { this.appendDummyInput().appendField( 'divide variable' ).appendField( new Blockly.FieldTextInput( 'score' ), 'NAME' ); this.appendValueInput( 'VALUE' ).setCheck( 'Number' ).appendField( 'by' ); this.setPreviousStatement( true ); this.setNextStatement( true ); this.setColour( VAR ); } };
Blockly.Blocks.action_var_clamp = { init() { this.appendDummyInput().appendField( 'clamp variable' ).appendField( new Blockly.FieldTextInput( 'score' ), 'NAME' ); this.appendValueInput( 'MIN' ).setCheck( 'Number' ).appendField( 'min' ); this.appendValueInput( 'MAX' ).setCheck( 'Number' ).appendField( 'max' ); this.setInputsInline( true ); this.setPreviousStatement( true ); this.setNextStatement( true ); this.setColour( VAR ); } };
Blockly.Blocks.action_var_reset = { init() { this.appendDummyInput().appendField( 'reset variable' ).appendField( new Blockly.FieldTextInput( 'score' ), 'NAME' ); this.setPreviousStatement( true ); this.setNextStatement( true ); this.setColour( VAR ); } };
Blockly.Blocks.action_textvar_append = { init() { this.appendDummyInput().appendField( 'append to text variable' ).appendField( new Blockly.FieldTextInput( 'note' ), 'NAME' ); this.appendValueInput( 'VALUE' ).setCheck( 'String' ).appendField( 'with' ); this.setPreviousStatement( true ); this.setNextStatement( true ); this.setColour( VAR ); } };

// ---- VALUE GETTERS (extended, read-only state) ----
Blockly.Blocks.value_speed_kmh = { init() { this.appendDummyInput().appendField( 'speed (km/h)' ); this.setOutput( true, 'Number' ); this.setColour( VAR ); } };
Blockly.Blocks.value_speed_mph = { init() { this.appendDummyInput().appendField( 'speed (mph)' ); this.setOutput( true, 'Number' ); this.setColour( VAR ); } };
Blockly.Blocks.value_heading = { init() { this.appendDummyInput().appendField( 'heading (degrees)' ); this.setOutput( true, 'Number' ); this.setColour( VAR ); } };
Blockly.Blocks.value_velocity_x = { init() { this.appendDummyInput().appendField( 'velocity X' ); this.setOutput( true, 'Number' ); this.setColour( VAR ); } };
Blockly.Blocks.value_velocity_y = { init() { this.appendDummyInput().appendField( 'velocity Y' ); this.setOutput( true, 'Number' ); this.setColour( VAR ); } };
Blockly.Blocks.value_velocity_z = { init() { this.appendDummyInput().appendField( 'velocity Z' ); this.setOutput( true, 'Number' ); this.setColour( VAR ); } };
Blockly.Blocks.value_split_screen = { init() { this.appendDummyInput().appendField( 'is split-screen' ); this.setOutput( true, 'Boolean' ); this.setColour( LOGIC ); } };
Blockly.Blocks.value_drag_mult = { init() { this.appendDummyInput().appendField( 'drag multiplier' ); this.setOutput( true, 'Number' ); this.setColour( VAR ); } };
Blockly.Blocks.value_accel_mult = { init() { this.appendDummyInput().appendField( 'accel multiplier' ); this.setOutput( true, 'Number' ); this.setColour( VAR ); } };
Blockly.Blocks.value_drive_mult = { init() { this.appendDummyInput().appendField( 'drive multiplier' ); this.setOutput( true, 'Number' ); this.setColour( VAR ); } };
Blockly.Blocks.value_time_scale = { init() { this.appendDummyInput().appendField( 'time scale' ); this.setOutput( true, 'Number' ); this.setColour( VAR ); } };
Blockly.Blocks.value_gravity = { init() { this.appendDummyInput().appendField( 'gravity' ); this.setOutput( true, 'Number' ); this.setColour( VAR ); } };

// ---- UI BUILDER (extended) — all created via the sandboxed ui.create api ----
Blockly.Blocks.ui_create_heading = { init() { this.appendValueInput( 'TEXT' ).setCheck( 'String' ).appendField( 'create heading' ); this.appendDummyInput().appendField( new Blockly.FieldDropdown( [ [ 'h1', 'h1' ], [ 'h2', 'h2' ], [ 'h3', 'h3' ] ] ), 'TAG' ).appendField( 'store as' ).appendField( new Blockly.FieldTextInput( 'title' ), 'NAME' ); this.setPreviousStatement( true ); this.setNextStatement( true ); this.setColour( UI_COLOR ); } };
Blockly.Blocks.ui_create_progress = { init() { this.appendValueInput( 'VALUE' ).setCheck( 'Number' ).appendField( 'create progress bar' ); this.appendValueInput( 'MAX' ).setCheck( 'Number' ).appendField( 'max' ); this.appendDummyInput().appendField( 'store as' ).appendField( new Blockly.FieldTextInput( 'prog' ), 'NAME' ); this.setPreviousStatement( true ); this.setNextStatement( true ); this.setColour( UI_COLOR ); } };
Blockly.Blocks.ui_create_checkbox = { init() { this.appendValueInput( 'LABEL' ).setCheck( 'String' ).appendField( 'create checkbox' ); this.appendDummyInput().appendField( 'store as' ).appendField( new Blockly.FieldTextInput( 'chk' ), 'NAME' ).appendField( 'store value in' ).appendField( new Blockly.FieldTextInput( 'chkVal' ), 'VAR' ); this.appendStatementInput( 'DO' ).appendField( 'on change' ); this.setPreviousStatement( true ); this.setNextStatement( true ); this.setColour( UI_COLOR ); } };
Blockly.Blocks.ui_create_dropdown = { init() { this.appendDummyInput().appendField( 'create dropdown' ).appendField( new Blockly.FieldTextInput( 'opt1,opt2,opt3' ), 'OPTIONS' ); this.appendDummyInput().appendField( 'store as' ).appendField( new Blockly.FieldTextInput( 'dd' ), 'NAME' ).appendField( 'store value in' ).appendField( new Blockly.FieldTextInput( 'ddVal' ), 'VAR' ); this.appendStatementInput( 'DO' ).appendField( 'on change' ); this.setPreviousStatement( true ); this.setNextStatement( true ); this.setColour( UI_COLOR ); } };
Blockly.Blocks.ui_create_text_input = { init() { this.appendValueInput( 'LABEL' ).setCheck( 'String' ).appendField( 'create text input' ); this.appendDummyInput().appendField( 'store as' ).appendField( new Blockly.FieldTextInput( 'inp' ), 'NAME' ).appendField( 'store value in' ).appendField( new Blockly.FieldTextInput( 'inpVal' ), 'VAR' ); this.appendStatementInput( 'DO' ).appendField( 'on change' ); this.setPreviousStatement( true ); this.setNextStatement( true ); this.setColour( UI_COLOR ); } };
Blockly.Blocks.ui_create_divider = { init() { this.appendDummyInput().appendField( 'create divider store as' ).appendField( new Blockly.FieldTextInput( 'hr' ), 'NAME' ); this.setPreviousStatement( true ); this.setNextStatement( true ); this.setColour( UI_COLOR ); } };
Blockly.Blocks.ui_set_position = { init() { this.appendDummyInput().appendField( 'move element' ).appendField( new Blockly.FieldTextInput( 'panel' ), 'NAME' ); this.appendValueInput( 'X' ).setCheck( 'Number' ).appendField( 'to X' ); this.appendValueInput( 'Y' ).setCheck( 'Number' ).appendField( 'Y' ); this.setPreviousStatement( true ); this.setNextStatement( true ); this.setColour( UI_COLOR ); } };
Blockly.Blocks.ui_set_size = { init() { this.appendDummyInput().appendField( 'size element' ).appendField( new Blockly.FieldTextInput( 'panel' ), 'NAME' ); this.appendValueInput( 'W' ).setCheck( 'Number' ).appendField( 'width' ); this.appendValueInput( 'H' ).setCheck( 'Number' ).appendField( 'height' ); this.setPreviousStatement( true ); this.setNextStatement( true ); this.setColour( UI_COLOR ); } };
Blockly.Blocks.ui_set_text_color = { init() { this.appendDummyInput().appendField( 'text color of' ).appendField( new Blockly.FieldTextInput( 'lbl' ), 'NAME' ).appendField( new Blockly.FieldColour( '#ffffff' ), 'COLOR' ); this.setPreviousStatement( true ); this.setNextStatement( true ); this.setColour( UI_COLOR ); } };
Blockly.Blocks.ui_set_bg_color = { init() { this.appendDummyInput().appendField( 'background of' ).appendField( new Blockly.FieldTextInput( 'panel' ), 'NAME' ).appendField( new Blockly.FieldColour( '#1b2a40' ), 'COLOR' ); this.setPreviousStatement( true ); this.setNextStatement( true ); this.setColour( UI_COLOR ); } };
Blockly.Blocks.ui_set_font_size = { init() { this.appendDummyInput().appendField( 'font size of' ).appendField( new Blockly.FieldTextInput( 'lbl' ), 'NAME' ).appendField( new Blockly.FieldNumber( 14, 6, 72 ), 'SIZE' ); this.setPreviousStatement( true ); this.setNextStatement( true ); this.setColour( UI_COLOR ); } };
Blockly.Blocks.ui_set_enabled = { init() { this.appendDummyInput().appendField( 'set element' ).appendField( new Blockly.FieldTextInput( 'btn' ), 'NAME' ).appendField( new Blockly.FieldDropdown( [ [ 'enabled', '1' ], [ 'disabled', '0' ] ] ), 'STATE' ); this.setPreviousStatement( true ); this.setNextStatement( true ); this.setColour( UI_COLOR ); } };
Blockly.Blocks.ui_on_click = { init() { this.appendDummyInput().appendField( 'when element' ).appendField( new Blockly.FieldTextInput( 'btn' ), 'NAME' ).appendField( 'clicked' ); this.appendStatementInput( 'DO' ).appendField( 'do' ); this.setPreviousStatement( true ); this.setNextStatement( true ); this.setColour( UI_COLOR ); } };

// ---- STORAGE (extended) ----
Blockly.Blocks.storage_get_num = { init() { this.appendValueInput( 'KEY' ).setCheck( 'String' ).appendField( 'get number' ); this.appendValueInput( 'DEFAULT' ).setCheck( 'Number' ).appendField( 'or default' ); this.setOutput( true, 'Number' ); this.setColour( STO_COLOR ); } };
Blockly.Blocks.storage_get_text = { init() { this.appendValueInput( 'KEY' ).setCheck( 'String' ).appendField( 'get text' ); this.appendValueInput( 'DEFAULT' ).setCheck( 'String' ).appendField( 'or default' ); this.setOutput( true, 'String' ); this.setColour( STO_COLOR ); } };
Blockly.Blocks.storage_get_bool = { init() { this.appendValueInput( 'KEY' ).setCheck( 'String' ).appendField( 'has stored key' ); this.setOutput( true, 'Boolean' ); this.setColour( STO_COLOR ); } };
Blockly.Blocks.storage_set_bool = { init() { this.appendValueInput( 'KEY' ).setCheck( 'String' ).appendField( 'store flag' ); this.appendValueInput( 'VALUE' ).setCheck( 'Boolean' ).appendField( 'under key' ); this.setPreviousStatement( true ); this.setNextStatement( true ); this.setColour( STO_COLOR ); } };
Blockly.Blocks.storage_increment = { init() { this.appendValueInput( 'KEY' ).setCheck( 'String' ).appendField( 'increment stored number' ); this.appendValueInput( 'BY' ).setCheck( 'Number' ).appendField( 'by' ); this.setPreviousStatement( true ); this.setNextStatement( true ); this.setColour( STO_COLOR ); } };
Blockly.Blocks.storage_count = { init() { this.appendDummyInput().appendField( 'count of stored keys' ); this.setOutput( true, 'Number' ); this.setColour( STO_COLOR ); } };
Blockly.Blocks.storage_list_add = { init() { this.appendValueInput( 'KEY' ).setCheck( 'String' ).appendField( 'append to stored list' ); this.appendValueInput( 'VALUE' ).appendField( 'value' ); this.setPreviousStatement( true ); this.setNextStatement( true ); this.setColour( STO_COLOR ); } };
Blockly.Blocks.storage_list_get = { init() { this.appendValueInput( 'KEY' ).setCheck( 'String' ).appendField( 'get stored list' ); this.setOutput( true, 'Array' ); this.setColour( STO_COLOR ); } };

// ---- CAMERA (extended) ----
actionDef( 'action_set_camera_distance', 'VALUE', 'set camera distance', CAM );
actionDef( 'action_set_camera_height', 'VALUE', 'set camera height', CAM );
actionDef( 'action_set_camera_lag', 'VALUE', 'set camera smoothing (0-1)', CAM );
actionDef( 'action_set_camera_pitch', 'VALUE', 'set camera pitch', CAM );
actionDefDropdown( 'action_camera_look_mode', 'camera follow', 'MODE', [ [ 'loose', 'loose' ], [ 'strict', 'strict' ] ], null, null, CAM );
actionDef( 'action_camera_reset', null, 'reset camera', CAM );

// ---- FX (extended) ----
actionDef( 'action_set_screen_brightness', 'VALUE', 'set screen brightness (0-2)', FX );
actionDef( 'action_set_sun_position', 'ANGLE', 'set sun angle (degrees)', FX );
actionDef( 'action_set_snow_intensity', 'VALUE', 'set snow intensity (0-1)', FX );
actionDef( 'action_set_rain_intensity', 'VALUE', 'set rain intensity (0-1)', FX );

// ---- AUDIO (extended) ----
actionDefDropdown( 'action_play_cue', 'play sound', 'CUE', [ [ 'boost', 'boost' ], [ 'checkpoint', 'checkpoint' ], [ 'crash', 'crash' ], [ 'lap', 'lap' ], [ 'coin', 'coin' ], [ 'click', 'click' ] ], null, null, AUD );
actionDef( 'action_set_master_volume', 'VALUE', 'set master volume (0-1)', AUD );

// ---- GAME CONTROL (extended, safe) ----
actionDef( 'action_restart_race', null, 'restart race', FLOW );
actionDef( 'action_teleport_to_spawn', null, 'teleport to spawn', FLOW );
actionDef( 'action_add_lap_time_penalty', 'SECS', 'add time penalty (seconds)', FLOW );
actionDefDropdown( 'action_set_weather', 'set weather', 'W', [ [ 'Clear', 'clear' ], [ 'Cloudy', 'cloudy' ], [ 'Sunset', 'sunset' ], [ 'Night', 'night' ], [ 'Dawn Mist', 'dawn-mist' ] ], null, null, FX );
actionDef( 'action_set_fog_color_rgb', 'VALUE', 'tint world (0-1)', FX );

// ---- EVENTS (extended, derived in the generated runtime) ----
Blockly.Blocks.event_on_key_release = { init() { this.appendDummyInput().appendField( 'when key' ).appendField( new Blockly.FieldDropdown( [ [ 'W', 'KeyW' ], [ 'A', 'KeyA' ], [ 'S', 'KeyS' ], [ 'D', 'KeyD' ], [ 'Space', 'Space' ], [ 'X', 'KeyX' ], [ 'C', 'KeyC' ], [ 'E', 'KeyE' ], [ 'Q', 'KeyQ' ], [ 'R', 'KeyR' ] ] ), 'KEY' ).appendField( 'released' ); this.appendStatementInput( 'DO' ).appendField( 'do' ); this.setColour( EVT ); } };
Blockly.Blocks.event_on_high_speed = { init() { this.appendValueInput( 'SPEED' ).setCheck( 'Number' ).appendField( 'while speed above' ); this.appendStatementInput( 'DO' ).appendField( 'do' ); this.setColour( EVT ); } };
Blockly.Blocks.event_on_low_speed_held = { init() { this.appendValueInput( 'SPEED' ).setCheck( 'Number' ).appendField( 'while speed below' ); this.appendStatementInput( 'DO' ).appendField( 'do' ); this.setColour( EVT ); } };

// ============ WORKSPACE ============
const workspace = Blockly.inject( 'blocklyDiv', { toolbox: document.getElementById( 'toolbox' ), trashcan: true, zoom: { controls: true, wheel: true, startScale: 0.95 } } );
const textToDom = ( text ) => ( Blockly.utils?.xml?.textToDom ? Blockly.utils.xml.textToDom( text ) : Blockly.Xml.textToDom( text ) );
function exportXmlPretty() { return Blockly.Xml.domToPrettyText( Blockly.Xml.workspaceToDom( workspace ) ); }
// Loading XML into the workspace is wrapped so a malformed/partial mod can never leave
// the editor in a half-rendered state where the toolbox flyout refuses to open. The
// flyout is closed before loading (so it isn't re-rendering against a mutating tree) and
// the toolbox is re-synced afterwards; any error is surfaced without breaking the UI.
function loadXmlText( text ) {
	const dom = textToDom( text );
	try {
		if ( workspace.toolbox_ ) workspace.toolbox_.clearSelection();
		Blockly.Xml.clearWorkspaceAndLoadFromXml( dom, workspace );
	} catch ( e ) {
		try { workspace.clear(); } catch {}
		setStatus( 'Could not load that XML — cleared the canvas' );
		throw e;
	}
}

// ============ PARSER ============
function parseValueBlock( block ) {
	if ( ! block ) return null;
	const type = block.type;
	if ( type === 'math_number' ) return Number( block.getFieldValue( 'NUM' ) ) || 0;
	if ( type === 'text' ) return { kind: 'const', value: String( block.getFieldValue( 'TEXT' ) || '' ) };
	if ( type === 'math_arithmetic' ) return { kind: 'math', op: block.getFieldValue( 'OP' ), a: parseValueBlock( block.getInputTargetBlock( 'A' ) ) ?? 0, b: parseValueBlock( block.getInputTargetBlock( 'B' ) ) ?? 0 };
	if ( type === 'math_single' ) return { kind: 'math_single', op: block.getFieldValue( 'OP' ), num: parseValueBlock( block.getInputTargetBlock( 'NUM' ) ) ?? 0 };
	if ( type === 'math_clamp' ) return { kind: 'clamp', value: parseValueBlock( block.getInputTargetBlock( 'VALUE' ) ) ?? 0, min: parseValueBlock( block.getInputTargetBlock( 'MIN' ) ) ?? 0, max: parseValueBlock( block.getInputTargetBlock( 'MAX' ) ) ?? 1 };
	if ( type === 'math_min_max' ) return { kind: 'minmax', op: block.getFieldValue( 'OP' ), a: parseValueBlock( block.getInputTargetBlock( 'A' ) ) ?? 0, b: parseValueBlock( block.getInputTargetBlock( 'B' ) ) ?? 0 };
	if ( type === 'math_pi' ) return Math.PI;
	if ( type === 'math_deg_to_rad' ) return { kind: 'deg2rad', value: parseValueBlock( block.getInputTargetBlock( 'DEG' ) ) ?? 0 };
	if ( type === 'math_rad_to_deg' ) return { kind: 'rad2deg', value: parseValueBlock( block.getInputTargetBlock( 'RAD' ) ) ?? 0 };
	if ( type === 'value_speed' ) return { kind: 'runtime', name: 'speed' };
	if ( type === 'value_lap_time' ) return { kind: 'runtime', name: 'lapTime' };
	if ( type === 'value_race_time' ) return { kind: 'runtime', name: 'raceTime' };
	if ( type === 'value_checkpoint_number' ) return { kind: 'runtime', name: 'checkpointNumber' };
	if ( type === 'value_crash_force' ) return { kind: 'runtime', name: 'crashForce' };
	if ( type === 'value_random' ) return { kind: 'runtime', name: 'random' };
	if ( type === 'value_coins' ) return { kind: 'runtime', name: 'coins' };
	if ( type === 'value_lap_number' ) return { kind: 'runtime', name: 'lapNumber' };
	if ( type === 'value_best_lap' ) return { kind: 'runtime', name: 'bestLap' };
	if ( type === 'value_last_lap' ) return { kind: 'runtime', name: 'lastLap' };
	if ( type === 'value_stunt_points' ) return { kind: 'runtime', name: 'stuntPoints' };
	if ( type === 'value_stunt_combo' ) return { kind: 'runtime', name: 'stuntCombo' };
	if ( type === 'value_drift' ) return { kind: 'runtime', name: 'drift' };
	if ( type === 'value_angular_speed' ) return { kind: 'runtime', name: 'angularSpeed' };
	if ( type === 'value_top_speed' ) return { kind: 'runtime', name: 'topSpeed' };
	if ( type === 'value_accel_rate' ) return { kind: 'runtime', name: 'accelRate' };
	if ( type === 'value_drive_force' ) return { kind: 'runtime', name: 'driveForce' };
	if ( type === 'value_grip_mult' ) return { kind: 'runtime', name: 'gripMult' };
	if ( type === 'value_pos_x' ) return { kind: 'runtime', name: 'posX' };
	if ( type === 'value_pos_y' ) return { kind: 'runtime', name: 'posY' };
	if ( type === 'value_pos_z' ) return { kind: 'runtime', name: 'posZ' };
	if ( type === 'value_game_mode' ) return { kind: 'runtime', name: 'gameMode' };
	if ( type === 'value_var_get' ) return { kind: 'var', name: safeId( block.getFieldValue( 'NAME' ) || 'var' ) };
	if ( type === 'value_text_var_get' ) return { kind: 'textvar', name: safeId( block.getFieldValue( 'NAME' ) || 'var' ) };
	if ( type === 'text_combine' ) return { kind: 'join', a: parseValueBlock( block.getInputTargetBlock( 'A' ) ) ?? '', b: parseValueBlock( block.getInputTargetBlock( 'B' ) ) ?? '' };
	if ( type === 'text_to_string' ) return { kind: 'tostring', value: parseValueBlock( block.getInputTargetBlock( 'VALUE' ) ) ?? '' };
	if ( type === 'text_round_num' ) return { kind: 'roundstr', value: parseValueBlock( block.getInputTargetBlock( 'VALUE' ) ) ?? 0, places: Number( block.getFieldValue( 'PLACES' ) ) || 0 };
	if ( type === 'logic_compare' ) return { kind: 'compare', op: block.getFieldValue( 'OP' ), a: parseValueBlock( block.getInputTargetBlock( 'A' ) ) ?? 0, b: parseValueBlock( block.getInputTargetBlock( 'B' ) ) ?? 0 };
	if ( type === 'logic_operation' ) return { kind: 'boolop', op: block.getFieldValue( 'OP' ), a: parseValueBlock( block.getInputTargetBlock( 'A' ) ), b: parseValueBlock( block.getInputTargetBlock( 'B' ) ) };
	if ( type === 'logic_negate' ) return { kind: 'not', value: parseValueBlock( block.getInputTargetBlock( 'BOOL' ) ) };
	if ( type === 'logic_is_airborne' ) return { kind: 'runtime', name: 'isAirborne' };
	if ( type === 'logic_is_drifting' ) return { kind: 'runtime', name: 'isDrifting' };
	if ( type === 'logic_key_down' ) return { kind: 'keydown', key: block.getFieldValue( 'KEY' ) };
	if ( type === 'value_true' ) return { kind: 'const', value: true };
	if ( type === 'value_false' ) return { kind: 'const', value: false };
	// New value getters
	if ( type === 'value_color' ) return { kind: 'const', value: block.getFieldValue( 'COLOR' ) || '#ff4b1f' };
	if ( type === 'value_ui_element_text' ) return { kind: 'element_text', name: safeId( block.getFieldValue( 'NAME' ) || 'lbl' ) };
	if ( type === 'storage_get' ) return { kind: 'storage_get', key: parseValueBlock( block.getInputTargetBlock( 'KEY' ) ) ?? '', fallback: parseValueBlock( block.getInputTargetBlock( 'DEFAULT' ) ) };
	if ( type === 'storage_has' ) return { kind: 'storage_has', key: parseValueBlock( block.getInputTargetBlock( 'KEY' ) ) ?? '' };
	if ( type === 'value_is_paused' ) return { kind: 'runtime', name: 'isPaused' };
	if ( type === 'value_fps' ) return { kind: 'runtime', name: 'fps' };
	if ( type === 'value_dt' ) return { kind: 'runtime', name: 'dt' };
	if ( type === 'text_length' ) return { kind: 'text_length', value: parseValueBlock( block.getInputTargetBlock( 'TEXT' ) ) ?? '' };
	if ( type === 'text_contains' ) return { kind: 'text_contains', text: parseValueBlock( block.getInputTargetBlock( 'TEXT' ) ) ?? '', sub: parseValueBlock( block.getInputTargetBlock( 'SUB' ) ) ?? '' };
	if ( type === 'text_upper' ) return { kind: 'text_case', value: parseValueBlock( block.getInputTargetBlock( 'TEXT' ) ) ?? '', upper: true };
	if ( type === 'text_lower' ) return { kind: 'text_case', value: parseValueBlock( block.getInputTargetBlock( 'TEXT' ) ) ?? '', upper: false };

	// ---- EXTENDED: MATH ----
	if ( type === 'math_round_int' ) return { kind: 'round_int', num: parseValueBlock( block.getInputTargetBlock( 'NUM' ) ) ?? 0 };
	if ( type === 'math_random_int' ) return { kind: 'randint', min: parseValueBlock( block.getInputTargetBlock( 'MIN' ) ) ?? 0, max: parseValueBlock( block.getInputTargetBlock( 'MAX' ) ) ?? 1 };
	if ( type === 'math_random_range' ) return { kind: 'randrange', min: parseValueBlock( block.getInputTargetBlock( 'MIN' ) ) ?? 0, max: parseValueBlock( block.getInputTargetBlock( 'MAX' ) ) ?? 1 };
	if ( type === 'math_lerp' ) return { kind: 'lerp', a: parseValueBlock( block.getInputTargetBlock( 'A' ) ) ?? 0, b: parseValueBlock( block.getInputTargetBlock( 'B' ) ) ?? 0, t: parseValueBlock( block.getInputTargetBlock( 'T' ) ) ?? 0 };
	if ( type === 'math_map_range' ) return { kind: 'map_range', value: parseValueBlock( block.getInputTargetBlock( 'VALUE' ) ) ?? 0, inMin: parseValueBlock( block.getInputTargetBlock( 'INMIN' ) ) ?? 0, inMax: parseValueBlock( block.getInputTargetBlock( 'INMAX' ) ) ?? 1, outMin: parseValueBlock( block.getInputTargetBlock( 'OUTMIN' ) ) ?? 0, outMax: parseValueBlock( block.getInputTargetBlock( 'OUTMAX' ) ) ?? 1 };
	if ( type === 'math_adv_single' ) return { kind: 'math_adv', op: block.getFieldValue( 'OP' ), num: parseValueBlock( block.getInputTargetBlock( 'NUM' ) ) ?? 0 };
	if ( type === 'math_pair' ) return { kind: 'math_pair', op: block.getFieldValue( 'OP' ), a: parseValueBlock( block.getInputTargetBlock( 'A' ) ) ?? 0, b: parseValueBlock( block.getInputTargetBlock( 'B' ) ) ?? 0 };
	if ( type === 'math_constant' ) return { kind: 'math_const', name: block.getFieldValue( 'CONST' ) };
	if ( type === 'math_divisible' ) return { kind: 'divisible', a: parseValueBlock( block.getInputTargetBlock( 'A' ) ) ?? 0, b: parseValueBlock( block.getInputTargetBlock( 'B' ) ) ?? 1 };
	if ( type === 'math_between' ) return { kind: 'between', value: parseValueBlock( block.getInputTargetBlock( 'VALUE' ) ) ?? 0, min: parseValueBlock( block.getInputTargetBlock( 'MIN' ) ) ?? 0, max: parseValueBlock( block.getInputTargetBlock( 'MAX' ) ) ?? 1 };

	// ---- EXTENDED: LOGIC ----
	if ( type === 'logic_xor' ) return { kind: 'xor', a: parseValueBlock( block.getInputTargetBlock( 'A' ) ), b: parseValueBlock( block.getInputTargetBlock( 'B' ) ) };
	if ( type === 'logic_is_even' ) return { kind: 'is_even', num: parseValueBlock( block.getInputTargetBlock( 'NUM' ) ) ?? 0 };
	if ( type === 'logic_is_positive' ) return { kind: 'is_positive', num: parseValueBlock( block.getInputTargetBlock( 'NUM' ) ) ?? 0 };
	if ( type === 'logic_is_integer' ) return { kind: 'is_integer', num: parseValueBlock( block.getInputTargetBlock( 'NUM' ) ) ?? 0 };
	if ( type === 'logic_is_zero' ) return { kind: 'is_zero', num: parseValueBlock( block.getInputTargetBlock( 'NUM' ) ) ?? 0 };
	if ( type === 'logic_text_equals' ) return { kind: 'text_op', op: block.getFieldValue( 'OP' ), a: parseValueBlock( block.getInputTargetBlock( 'A' ) ) ?? '', b: parseValueBlock( block.getInputTargetBlock( 'B' ) ) ?? '' };
	if ( type === 'logic_is_empty' ) return { kind: 'is_empty', value: parseValueBlock( block.getInputTargetBlock( 'VALUE' ) ) };

	// ---- EXTENDED: TEXT ----
	if ( type === 'text_substring' ) return { kind: 'text_sub', text: parseValueBlock( block.getInputTargetBlock( 'TEXT' ) ) ?? '', start: parseValueBlock( block.getInputTargetBlock( 'START' ) ) ?? 0, end: parseValueBlock( block.getInputTargetBlock( 'END' ) ) ?? 0 };
	if ( type === 'text_char_at' ) return { kind: 'text_charat', text: parseValueBlock( block.getInputTargetBlock( 'TEXT' ) ) ?? '', index: parseValueBlock( block.getInputTargetBlock( 'INDEX' ) ) ?? 0 };
	if ( type === 'text_index_of' ) return { kind: 'text_indexof', text: parseValueBlock( block.getInputTargetBlock( 'TEXT' ) ) ?? '', sub: parseValueBlock( block.getInputTargetBlock( 'SUB' ) ) ?? '' };
	if ( type === 'text_replace' ) return { kind: 'text_replace', text: parseValueBlock( block.getInputTargetBlock( 'TEXT' ) ) ?? '', from: parseValueBlock( block.getInputTargetBlock( 'FROM' ) ) ?? '', to: parseValueBlock( block.getInputTargetBlock( 'TO' ) ) ?? '', all: false };
	if ( type === 'text_replace_all' ) return { kind: 'text_replace', text: parseValueBlock( block.getInputTargetBlock( 'TEXT' ) ) ?? '', from: parseValueBlock( block.getInputTargetBlock( 'FROM' ) ) ?? '', to: parseValueBlock( block.getInputTargetBlock( 'TO' ) ) ?? '', all: true };
	if ( type === 'text_repeat' ) return { kind: 'text_repeat', text: parseValueBlock( block.getInputTargetBlock( 'TEXT' ) ) ?? '', times: parseValueBlock( block.getInputTargetBlock( 'TIMES' ) ) ?? 0 };
	if ( type === 'text_trim' ) return { kind: 'text_trim', text: parseValueBlock( block.getInputTargetBlock( 'TEXT' ) ) ?? '' };
	if ( type === 'text_pad' ) return { kind: 'text_pad', op: block.getFieldValue( 'OP' ), text: parseValueBlock( block.getInputTargetBlock( 'TEXT' ) ) ?? '', length: parseValueBlock( block.getInputTargetBlock( 'LENGTH' ) ) ?? 0, char: parseValueBlock( block.getInputTargetBlock( 'CHAR' ) ) ?? ' ' };
	if ( type === 'text_reverse' ) return { kind: 'text_reverse', text: parseValueBlock( block.getInputTargetBlock( 'TEXT' ) ) ?? '' };
	if ( type === 'text_count' ) return { kind: 'text_count', text: parseValueBlock( block.getInputTargetBlock( 'TEXT' ) ) ?? '', sub: parseValueBlock( block.getInputTargetBlock( 'SUB' ) ) ?? '' };
	if ( type === 'text_to_number' ) return { kind: 'text_tonum', text: parseValueBlock( block.getInputTargetBlock( 'TEXT' ) ) ?? '' };
	if ( type === 'text_split' ) return { kind: 'text_split', text: parseValueBlock( block.getInputTargetBlock( 'TEXT' ) ) ?? '', sep: parseValueBlock( block.getInputTargetBlock( 'SEP' ) ) ?? '' };
	if ( type === 'text_first_char' ) return { kind: 'text_first', text: parseValueBlock( block.getInputTargetBlock( 'TEXT' ) ) ?? '' };
	if ( type === 'text_last_char' ) return { kind: 'text_last', text: parseValueBlock( block.getInputTargetBlock( 'TEXT' ) ) ?? '' };
	if ( type === 'text_slice' ) return { kind: 'text_slice', text: parseValueBlock( block.getInputTargetBlock( 'TEXT' ) ) ?? '', start: parseValueBlock( block.getInputTargetBlock( 'START' ) ) ?? 0, length: parseValueBlock( block.getInputTargetBlock( 'LEN' ) ) ?? 0 };
	if ( type === 'text_char_code' ) return { kind: 'text_charcode', text: parseValueBlock( block.getInputTargetBlock( 'TEXT' ) ) ?? '' };
	if ( type === 'text_from_char_code' ) return { kind: 'text_fromcode', num: parseValueBlock( block.getInputTargetBlock( 'NUM' ) ) ?? 0 };

	// ---- EXTENDED: LISTS ----
	if ( type === 'lists_create' ) return { kind: 'list', items: [] };
	if ( type === 'lists_create_with' ) { const items = []; let i = 0; while ( block.getInput( 'ADD' + i ) ) { items.push( parseValueBlock( block.getInputTargetBlock( 'ADD' + i ) ) ); i ++; } return { kind: 'list', items }; }
	if ( type === 'value_list_get' ) return { kind: 'list_var', name: safeId( block.getFieldValue( 'NAME' ) || 'mylist' ) };
	if ( type === 'lists_length' ) return { kind: 'list_length', list: parseValueBlock( block.getInputTargetBlock( 'LIST' ) ) };
	if ( type === 'lists_get_index' ) return { kind: 'list_get', list: parseValueBlock( block.getInputTargetBlock( 'LIST' ) ), index: parseValueBlock( block.getInputTargetBlock( 'INDEX' ) ) ?? 0 };
	if ( type === 'lists_contains' ) return { kind: 'list_contains', list: parseValueBlock( block.getInputTargetBlock( 'LIST' ) ), value: parseValueBlock( block.getInputTargetBlock( 'VALUE' ) ) };
	if ( type === 'lists_index_of' ) return { kind: 'list_indexof', list: parseValueBlock( block.getInputTargetBlock( 'LIST' ) ), value: parseValueBlock( block.getInputTargetBlock( 'VALUE' ) ) };
	if ( type === 'lists_reverse' ) return { kind: 'list_reverse', list: parseValueBlock( block.getInputTargetBlock( 'LIST' ) ) };
	if ( type === 'lists_sort' ) return { kind: 'list_sort', op: block.getFieldValue( 'OP' ), list: parseValueBlock( block.getInputTargetBlock( 'LIST' ) ) };
	if ( type === 'lists_sum' ) return { kind: 'list_sum', list: parseValueBlock( block.getInputTargetBlock( 'LIST' ) ) };
	if ( type === 'lists_max' ) return { kind: 'list_maxmin', op: block.getFieldValue( 'OP' ), list: parseValueBlock( block.getInputTargetBlock( 'LIST' ) ) };
	if ( type === 'lists_average' ) return { kind: 'list_avg', list: parseValueBlock( block.getInputTargetBlock( 'LIST' ) ) };
	if ( type === 'lists_join' ) return { kind: 'list_join', list: parseValueBlock( block.getInputTargetBlock( 'LIST' ) ), sep: parseValueBlock( block.getInputTargetBlock( 'SEP' ) ) ?? '' };
	if ( type === 'lists_first' ) return { kind: 'list_first', list: parseValueBlock( block.getInputTargetBlock( 'LIST' ) ) };
	if ( type === 'lists_last' ) return { kind: 'list_last', list: parseValueBlock( block.getInputTargetBlock( 'LIST' ) ) };

	// ---- EXTENDED: VALUE GETTERS ----
	if ( type === 'value_speed_kmh' ) return { kind: 'runtime', name: 'speedKmh' };
	if ( type === 'value_speed_mph' ) return { kind: 'runtime', name: 'speedMph' };
	if ( type === 'value_heading' ) return { kind: 'runtime', name: 'heading' };
	if ( type === 'value_velocity_x' ) return { kind: 'runtime', name: 'velocityX' };
	if ( type === 'value_velocity_y' ) return { kind: 'runtime', name: 'velocityY' };
	if ( type === 'value_velocity_z' ) return { kind: 'runtime', name: 'velocityZ' };
	if ( type === 'value_split_screen' ) return { kind: 'runtime', name: 'isSplitScreen' };
	if ( type === 'value_drag_mult' ) return { kind: 'runtime', name: 'dragMult' };
	if ( type === 'value_accel_mult' ) return { kind: 'runtime', name: 'accelMult' };
	if ( type === 'value_drive_mult' ) return { kind: 'runtime', name: 'driveMult' };
	if ( type === 'value_time_scale' ) return { kind: 'runtime', name: 'timeScale' };
	if ( type === 'value_gravity' ) return { kind: 'runtime', name: 'gravity' };

	// ---- EXTENDED: STORAGE ----
	if ( type === 'storage_get_num' ) return { kind: 'storage_get', key: parseValueBlock( block.getInputTargetBlock( 'KEY' ) ) ?? '', fallback: parseValueBlock( block.getInputTargetBlock( 'DEFAULT' ) ) ?? 0 };
	if ( type === 'storage_get_text' ) return { kind: 'storage_get', key: parseValueBlock( block.getInputTargetBlock( 'KEY' ) ) ?? '', fallback: parseValueBlock( block.getInputTargetBlock( 'DEFAULT' ) ) ?? '' };
	if ( type === 'storage_get_bool' ) return { kind: 'storage_has', key: parseValueBlock( block.getInputTargetBlock( 'KEY' ) ) ?? '' };
	if ( type === 'storage_count' ) return { kind: 'storage_count' };
	if ( type === 'storage_list_get' ) return { kind: 'storage_get', key: parseValueBlock( block.getInputTargetBlock( 'KEY' ) ) ?? '', fallback: { kind: 'const', value: [] } };
	return null;
}

function parseActionStatement( block ) {
	if ( ! block ) return null;
	const type = block.type;
	const v = ( n, d = 0 ) => parseValueBlock( block.getInputTargetBlock( n ) ) ?? d;
	const field = ( n, d = '' ) => block.getFieldValue( n ) ?? d;

	// Performance
	if ( type === 'action_set_speed' ) return { type: 'set_speed', value: v( 'SPEED' ) };
	if ( type === 'action_boost' ) return { type: 'boost', value: v( 'AMOUNT' ) };
	if ( type === 'action_set_top_speed' ) return { type: 'set_top_speed', value: v( 'VALUE' ) };
	if ( type === 'action_set_accel_rate' ) return { type: 'set_accel_rate', value: v( 'VALUE' ) };
	if ( type === 'action_set_brake_rate' ) return { type: 'set_brake_rate', value: v( 'VALUE' ) };
	if ( type === 'action_set_drive_force' ) return { type: 'set_drive_force', value: v( 'VALUE' ) };
	if ( type === 'action_set_drag' ) return { type: 'set_drag', value: v( 'VALUE' ) };
	if ( type === 'action_set_reverse_accel' ) return { type: 'set_reverse_accel', value: v( 'VALUE' ) };
	if ( type === 'action_set_gravity' ) return { type: 'set_gravity', value: v( 'G', 9.81 ) };
	if ( type === 'action_set_time_scale' ) return { type: 'set_time_scale', value: v( 'SCALE', 1 ) };
	if ( type === 'action_set_accel_mult' ) return { type: 'set_accel_mult', value: v( 'VALUE', 1 ) };
	if ( type === 'action_set_drive_mult' ) return { type: 'set_drive_mult', value: v( 'VALUE', 1 ) };
	if ( type === 'action_set_grip_mult' ) return { type: 'set_grip_mult', value: v( 'VALUE', 1 ) };
	if ( type === 'action_force_brake' ) return { type: 'force_brake', value: v( 'TIME', 0.4 ) };
	if ( type === 'action_force_throttle' ) return { type: 'force_throttle', value: v( 'TIME', 0.4 ) };
	if ( type === 'action_disable_steering' ) return { type: 'disable_steering', value: v( 'TIME', 0.5 ) };
	if ( type === 'action_jump' ) return { type: 'jump', value: v( 'POWER', 6 ) };
	if ( type === 'action_reset_car' ) return { type: 'reset_car' };
	// Transform
	if ( type === 'action_teleport' ) return { type: 'teleport', x: v( 'X', 0 ), y: v( 'Y', 1 ), z: v( 'Z', 0 ) };
	if ( type === 'action_apply_impulse' ) return { type: 'impulse', x: v( 'X', 0 ), y: v( 'Y', 0 ), z: v( 'Z', 0 ) };
	if ( type === 'action_angular_impulse' ) return { type: 'angular', x: v( 'X', 0 ), y: v( 'Y', 0 ), z: v( 'Z', 0 ) };
	if ( type === 'action_set_vehicle_spin' ) return { type: 'set_spin', value: v( 'RAD', 0 ) };
	if ( type === 'action_set_vehicle_scale' ) return { type: 'set_scale', value: v( 'VALUE', 1 ) };
	if ( type === 'action_set_vehicle_visible' ) return { type: 'set_visible', value: field( 'VIS', '1' ) };
	if ( type === 'action_set_drift' ) return { type: 'set_drift', value: v( 'VALUE', 0 ) };
	if ( type === 'action_set_vehicle_model' ) return { type: 'set_model', value: field( 'MODEL', 'vehicle-truck-yellow' ) };
	// Camera
	if ( type === 'action_camera_shake' ) return { type: 'camera_shake', value: v( 'INT', 1 ) };
	if ( type === 'action_set_camera_fov' ) return { type: 'set_fov', value: v( 'VALUE', 42 ) };
	if ( type === 'action_set_camera_mode' ) return { type: 'set_camera_mode', value: field( 'MODE', 'chase' ) };
	// FX
	if ( type === 'action_show_message' ) return { type: 'show_message', value: v( 'TEXT', '' ), duration: v( 'DURATION', 1600 ) };
	if ( type === 'action_spawn_particle' ) return { type: 'spawn_particle' };
	if ( type === 'action_spawn_particle_burst' ) return { type: 'spawn_particle_burst', value: v( 'SECS', 0.45 ) };
	if ( type === 'action_set_fog_strength' ) return { type: 'set_fog_strength', value: v( 'VALUE', 1 ) };
	if ( type === 'action_set_fog_density' ) return { type: 'set_fog_density', value: v( 'VALUE', 1 ) };
	if ( type === 'action_set_fog_color' ) return { type: 'set_fog_color', value: field( 'COLOR', '#bfe0ff' ) };
	if ( type === 'action_set_background_color' ) return { type: 'set_bg_color', value: field( 'COLOR', '#bfe0ff' ) };
	if ( type === 'action_set_sky_color' ) return { type: 'set_sky_color', value: field( 'COLOR', '#1c5fd6' ) };
	if ( type === 'action_set_horizon_color' ) return { type: 'set_horizon_color', value: field( 'COLOR', '#ffe2aa' ) };
	if ( type === 'action_set_particle_color' ) return { type: 'set_particle_color', value: field( 'COLOR', '#ff4b1f' ) };
	if ( type === 'action_flash_screen' ) return { type: 'flash_screen', value: field( 'COLOR', '#ffffff' ) };
	if ( type === 'action_set_sky_vibrance' ) return { type: 'set_sky_vibrance', value: v( 'VALUE', 0.2 ) };
	if ( type === 'action_set_sky_palette' ) return { type: 'set_sky_palette', value: field( 'PRESET', 'clear' ) };
	if ( type === 'action_set_sun_intensity' ) return { type: 'set_sun', value: v( 'VALUE', 5 ) };
	if ( type === 'action_set_hemi_intensity' ) return { type: 'set_hemi', value: v( 'VALUE', 1.5 ) };
	if ( type === 'action_set_exposure' ) return { type: 'set_exposure', value: v( 'VALUE', 1 ) };
	// Audio
	if ( type === 'action_set_engine_volume' ) return { type: 'set_engine_vol', value: v( 'VALUE', 1 ) };
	if ( type === 'action_set_music_volume' ) return { type: 'set_music_vol', value: v( 'VALUE', 1 ) };
	if ( type === 'action_play_impact' ) return { type: 'play_impact', value: v( 'VELOCITY', 3 ) };
	// HUD
	if ( type === 'action_set_hud_text' ) return { type: 'set_hud_text', value: v( 'TEXT', '' ) };
	if ( type === 'action_set_effect_message' ) return { type: 'set_effect_msg', value: v( 'TEXT', '' ) };
	if ( type === 'action_set_fps_counter' ) return { type: 'set_fps', value: field( 'VIS', '1' ) };
	if ( type === 'action_add_stunt_points' ) return { type: 'add_stunt', value: v( 'AMOUNT', 0 ), reason: '' };
	if ( type === 'action_add_stunt_points_reason' ) return { type: 'add_stunt', value: v( 'AMOUNT', 0 ), reason: v( 'REASON', '' ) };
	if ( type === 'action_add_coins' ) return { type: 'add_coins', value: v( 'AMOUNT', 0 ) };
	// Renderer
	if ( type === 'action_set_pixel_ratio' ) return { type: 'set_pixel_ratio', value: v( 'VALUE', 1 ) };
	if ( type === 'action_set_shadows' ) return { type: 'set_shadows', value: field( 'VIS', '1' ) };
	// Timers / flow
	if ( type === 'action_start_timer' ) return { type: 'start_timer', id: 'timer1', value: v( 'SECS', 1 ) };
	if ( type === 'action_start_named_timer' ) return { type: 'start_timer', id: safeId( field( 'ID', 'timer1' ) ), value: v( 'SECS', 1 ) };
	if ( type === 'action_wait' ) return { type: 'wait', value: v( 'SECS', 0.2 ) };
	if ( type === 'action_random_delay' ) return { type: 'random_delay', min: v( 'MIN', 0 ), max: v( 'MAX', 1 ) };
	if ( type === 'action_repeat' ) return { type: 'repeat', times: v( 'TIMES', 1 ), body: parseStatementChain( block.getInputTargetBlock( 'DO' ) ) };
	if ( type === 'action_loop_forever' ) return { type: 'loop_forever', body: parseStatementChain( block.getInputTargetBlock( 'DO' ) ) };
	// Variables
	if ( type === 'action_var_set' ) return { type: 'var_set', name: safeId( field( 'NAME', 'var' ) ), value: v( 'VALUE', 0 ) };
	if ( type === 'action_var_add' ) return { type: 'var_add', name: safeId( field( 'NAME', 'var' ) ), value: v( 'VALUE', 0 ) };
	if ( type === 'action_var_set_text' ) return { type: 'textvar_set', name: safeId( field( 'NAME', 'var' ) ), value: v( 'VALUE', '' ) };
	// Conditionals (controls_if / controls_if_else)
	if ( type === 'controls_if' ) return { type: 'if', cond: parseValueBlock( block.getInputTargetBlock( 'IF0' ) ), body: parseStatementChain( block.getInputTargetBlock( 'DO0' ) ) };
	if ( type === 'controls_if_else' ) return { type: 'ifelse', cond: parseValueBlock( block.getInputTargetBlock( 'IF0' ) ), body: parseStatementChain( block.getInputTargetBlock( 'DO0' ) ), elseBody: parseStatementChain( block.getInputTargetBlock( 'ELSE' ) ) };
	// UI builder
	if ( type === 'ui_create_panel' ) return { type: 'ui_panel', x: v( 'X', 12 ), y: v( 'Y', 12 ), title: v( 'TITLE', '' ), name: safeId( field( 'NAME', 'panel' ) ) };
	if ( type === 'ui_create_button' ) return { type: 'ui_button', label: v( 'LABEL', 'Button' ), name: safeId( field( 'NAME', 'btn' ) ), body: parseStatementChain( block.getInputTargetBlock( 'DO' ) ) };
	if ( type === 'ui_create_label' ) return { type: 'ui_label', text: v( 'TEXT', '' ), name: safeId( field( 'NAME', 'lbl' ) ) };
	if ( type === 'ui_create_slider' ) return { type: 'ui_slider', label: v( 'LABEL', '' ), min: v( 'MIN', 0 ), max: v( 'MAX', 100 ), value: v( 'VALUE', 50 ), name: safeId( field( 'NAME', 'sliderVal' ) ), body: parseStatementChain( block.getInputTargetBlock( 'DO' ) ) };
	if ( type === 'ui_set_text' ) return { type: 'ui_set_text', name: safeId( field( 'NAME', 'lbl' ) ), text: v( 'TEXT', '' ) };
	if ( type === 'ui_set_style' ) return { type: 'ui_set_style', name: safeId( field( 'NAME', 'lbl' ) ), prop: v( 'PROP', '' ), value: v( 'VALUE', '' ) };
	if ( type === 'ui_append' ) return { type: 'ui_append', child: safeId( field( 'CHILD', 'btn' ) ), parent: safeId( field( 'PARENT', 'panel' ) ) };
	if ( type === 'ui_remove' ) return { type: 'ui_remove', name: safeId( field( 'NAME', 'lbl' ) ) };
	if ( type === 'ui_clear' ) return { type: 'ui_clear' };
	if ( type === 'ui_show' ) return { type: 'ui_show', name: safeId( field( 'NAME', 'panel' ) ) };
	if ( type === 'ui_hide' ) return { type: 'ui_hide', name: safeId( field( 'NAME', 'panel' ) ) };
	// Storage
	if ( type === 'storage_set' ) return { type: 'storage_set', key: v( 'KEY', '' ), value: v( 'VALUE', null ) };
	if ( type === 'storage_set_num' ) return { type: 'storage_set', key: v( 'KEY', '' ), value: v( 'VALUE', 0 ) };
	if ( type === 'storage_remove' ) return { type: 'storage_remove', key: v( 'KEY', '' ) };
	if ( type === 'storage_clear' ) return { type: 'storage_clear' };
	// Game control
	if ( type === 'action_respawn' ) return { type: 'respawn' };
	if ( type === 'action_pause' ) return { type: 'pause' };
	if ( type === 'action_resume' ) return { type: 'resume' };

	// ---- EXTENDED: VARIABLES ----
	if ( type === 'action_var_multiply' ) return { type: 'var_multiply', name: safeId( field( 'NAME', 'var' ) ), value: v( 'VALUE', 1 ) };
	if ( type === 'action_var_divide' ) return { type: 'var_divide', name: safeId( field( 'NAME', 'var' ) ), value: v( 'VALUE', 1 ) };
	if ( type === 'action_var_clamp' ) return { type: 'var_clamp', name: safeId( field( 'NAME', 'var' ) ), min: v( 'MIN', 0 ), max: v( 'MAX', 1 ) };
	if ( type === 'action_var_reset' ) return { type: 'var_set', name: safeId( field( 'NAME', 'var' ) ), value: 0 };
	if ( type === 'action_textvar_append' ) return { type: 'textvar_append', name: safeId( field( 'NAME', 'var' ) ), value: v( 'VALUE', '' ) };

	// ---- EXTENDED: LISTS (statement ops) ----
	if ( type === 'action_lists_set' ) return { type: 'list_set', key: v( 'VAR', '' ), index: v( 'INDEX', 0 ), value: v( 'VALUE', null ) };
	if ( type === 'action_lists_add' ) return { type: 'list_add', key: v( 'VAR', '' ), value: v( 'VALUE', null ) };
	if ( type === 'action_lists_remove' ) return { type: 'list_remove', key: v( 'VAR', '' ), index: v( 'INDEX', 0 ) };
	if ( type === 'action_lists_clear' ) return { type: 'list_clear', key: v( 'VAR', '' ) };

	// ---- EXTENDED: UI BUILDER ----
	if ( type === 'ui_create_heading' ) return { type: 'ui_heading', tag: field( 'TAG', 'h2' ), text: v( 'TEXT', '' ), name: safeId( field( 'NAME', 'title' ) ) };
	if ( type === 'ui_create_progress' ) return { type: 'ui_progress', value: v( 'VALUE', 0 ), max: v( 'MAX', 100 ), name: safeId( field( 'NAME', 'prog' ) ) };
	if ( type === 'ui_create_checkbox' ) return { type: 'ui_checkbox', label: v( 'LABEL', '' ), name: safeId( field( 'NAME', 'chk' ) ), varName: safeId( field( 'VAR', 'chkVal' ) ), body: parseStatementChain( block.getInputTargetBlock( 'DO' ) ) };
	if ( type === 'ui_create_dropdown' ) return { type: 'ui_dropdown', options: String( field( 'OPTIONS', 'opt1,opt2,opt3' ) ).split( ',' ).map( ( s ) => s.trim() ).slice( 0, 24 ), name: safeId( field( 'NAME', 'dd' ) ), varName: safeId( field( 'VAR', 'ddVal' ) ), body: parseStatementChain( block.getInputTargetBlock( 'DO' ) ) };
	if ( type === 'ui_create_text_input' ) return { type: 'ui_text_input', label: v( 'LABEL', '' ), name: safeId( field( 'NAME', 'inp' ) ), varName: safeId( field( 'VAR', 'inpVal' ) ), body: parseStatementChain( block.getInputTargetBlock( 'DO' ) ) };
	if ( type === 'ui_create_divider' ) return { type: 'ui_divider', name: safeId( field( 'NAME', 'hr' ) ) };
	if ( type === 'ui_set_position' ) return { type: 'ui_set_position', name: safeId( field( 'NAME', 'panel' ) ), x: v( 'X', 0 ), y: v( 'Y', 0 ) };
	if ( type === 'ui_set_size' ) return { type: 'ui_set_size', name: safeId( field( 'NAME', 'panel' ) ), w: v( 'W', 100 ), h: v( 'H', 40 ) };
	if ( type === 'ui_set_text_color' ) return { type: 'ui_set_style', name: safeId( field( 'NAME', 'lbl' ) ), prop: { kind: 'const', value: 'color' }, value: { kind: 'const', value: field( 'COLOR', '#ffffff' ) } };
	if ( type === 'ui_set_bg_color' ) return { type: 'ui_set_style', name: safeId( field( 'NAME', 'panel' ) ), prop: { kind: 'const', value: 'background' }, value: { kind: 'const', value: field( 'COLOR', '#1b2a40' ) } };
	if ( type === 'ui_set_font_size' ) return { type: 'ui_set_style', name: safeId( field( 'NAME', 'lbl' ) ), prop: { kind: 'const', value: 'fontSize' }, value: { kind: 'const', value: `${ field( 'SIZE', 14 ) }px` } };
	if ( type === 'ui_set_enabled' ) return { type: 'ui_set_enabled', name: safeId( field( 'NAME', 'btn' ) ), state: field( 'STATE', '1' ) };
	if ( type === 'ui_on_click' ) return { type: 'ui_on_click', name: safeId( field( 'NAME', 'btn' ) ), body: parseStatementChain( block.getInputTargetBlock( 'DO' ) ) };

	// ---- EXTENDED: STORAGE ----
	if ( type === 'storage_set_bool' ) return { type: 'storage_set', key: v( 'KEY', '' ), value: v( 'VALUE', false ) };
	if ( type === 'storage_increment' ) return { type: 'storage_increment', key: v( 'KEY', '' ), by: v( 'BY', 1 ) };
	if ( type === 'storage_list_add' ) return { type: 'storage_list_add', key: v( 'KEY', '' ), value: v( 'VALUE', null ) };

	// ---- EXTENDED: CAMERA ----
	if ( type === 'action_set_camera_distance' ) return { type: 'set_camera_distance', value: v( 'VALUE', 8 ) };
	if ( type === 'action_set_camera_height' ) return { type: 'set_camera_height', value: v( 'VALUE', 3 ) };
	if ( type === 'action_set_camera_lag' ) return { type: 'set_camera_lag', value: v( 'VALUE', 1 ) };
	if ( type === 'action_set_camera_pitch' ) return { type: 'set_camera_pitch', value: v( 'VALUE', 0 ) };
	if ( type === 'action_camera_look_mode' ) return { type: 'set_camera_mode', value: field( 'MODE', 'chase' ) };
	if ( type === 'action_camera_reset' ) return { type: 'set_camera_mode', value: 'chase' };

	// ---- EXTENDED: FX ----
	if ( type === 'action_set_screen_brightness' ) return { type: 'set_exposure', value: v( 'VALUE', 1 ) };
	if ( type === 'action_set_sun_position' ) return { type: 'set_sun_position', value: v( 'ANGLE', 45 ) };
	if ( type === 'action_set_snow_intensity' ) return { type: 'set_snow', value: v( 'VALUE', 0 ) };
	if ( type === 'action_set_rain_intensity' ) return { type: 'set_rain', value: v( 'VALUE', 0 ) };
	if ( type === 'action_set_weather' ) return { type: 'set_sky_palette', value: field( 'W', 'clear' ) };
	if ( type === 'action_set_fog_color_rgb' ) return { type: 'set_fog_strength', value: v( 'VALUE', 1 ) };

	// ---- EXTENDED: AUDIO ----
	if ( type === 'action_play_cue' ) return { type: 'play_cue', value: field( 'CUE', 'click' ) };
	if ( type === 'action_set_master_volume' ) return { type: 'set_engine_vol', value: v( 'VALUE', 1 ) };

	// ---- EXTENDED: GAME CONTROL ----
	if ( type === 'action_restart_race' ) return { type: 'respawn' };
	if ( type === 'action_teleport_to_spawn' ) return { type: 'respawn' };
	if ( type === 'action_add_lap_time_penalty' ) return { type: 'add_stunt', value: 0, reason: String( v( 'SECS', 0 ) ) };
	return null;
}

function parseStatementChain( first ) {
	const out = [];
	let c = first;
	while ( c ) {
		const p = parseActionStatement( c );
		if ( p ) out.push( p );
		c = c.getNextBlock();
	}
	return out;
}

function buildRuntimeSpec() {
	const spec = {
		onStart: [], onTick: [], onKey: {}, onKeyHold: {}, onKeyRelease: {}, onCheckpoint: [], onCrash: [], onLapFinish: [], onRespawn: [], onTimerDone: {},
		onSpeedThreshold: [], onLowSpeed: [], onHighSpeed: [], onLowSpeedHeld: [], onAir: [], onGround: [], onDrift: [],
	};
	for ( const block of workspace.getTopBlocks( true ) ) {
		const chain = parseStatementChain( block.getInputTargetBlock( 'DO' ) );
		if ( block.type === 'event_on_start' ) spec.onStart.push( ...chain );
		else if ( block.type === 'event_on_tick' ) spec.onTick.push( ...chain );
		else if ( block.type === 'event_on_checkpoint' ) spec.onCheckpoint.push( ...chain );
		else if ( block.type === 'event_on_crash' ) spec.onCrash.push( ...chain );
		else if ( block.type === 'event_on_lap_finish' ) spec.onLapFinish.push( ...chain );
		else if ( block.type === 'event_on_respawn' ) spec.onRespawn.push( ...chain );
		else if ( block.type === 'event_on_key' ) { const k = block.getFieldValue( 'KEY' ) || 'KeyW'; spec.onKey[ k ] = [ ...( spec.onKey[ k ] || [] ), ...chain ]; }
		else if ( block.type === 'event_on_key_hold' ) { const k = block.getFieldValue( 'KEY' ) || 'KeyW'; spec.onKeyHold[ k ] = [ ...( spec.onKeyHold[ k ] || [] ), ...chain ]; }
		else if ( block.type === 'event_on_key_release' ) { const k = block.getFieldValue( 'KEY' ) || 'KeyW'; spec.onKeyRelease[ k ] = [ ...( spec.onKeyRelease[ k ] || [] ), ...chain ]; }
		else if ( block.type === 'event_on_timer_done' ) { const id = safeId( block.getFieldValue( 'ID' ) || 'timer1' ); spec.onTimerDone[ id ] = [ ...( spec.onTimerDone[ id ] || [] ), ...chain ]; }
		else if ( block.type === 'event_on_speed_threshold' ) spec.onSpeedThreshold.push( { threshold: parseValueBlock( block.getInputTargetBlock( 'SPEED' ) ) ?? 0, body: chain } );
		else if ( block.type === 'event_on_low_speed' ) spec.onLowSpeed.push( { threshold: parseValueBlock( block.getInputTargetBlock( 'SPEED' ) ) ?? 0, body: chain } );
		else if ( block.type === 'event_on_high_speed' ) spec.onHighSpeed.push( { threshold: parseValueBlock( block.getInputTargetBlock( 'SPEED' ) ) ?? 0, body: chain } );
		else if ( block.type === 'event_on_low_speed_held' ) spec.onLowSpeedHeld.push( { threshold: parseValueBlock( block.getInputTargetBlock( 'SPEED' ) ) ?? 0, body: chain } );
		else if ( block.type === 'event_on_air' ) spec.onAir.push( ...chain );
		else if ( block.type === 'event_on_ground' ) spec.onGround.push( ...chain );
		else if ( block.type === 'event_on_drift' ) spec.onDrift.push( ...chain );
	}
	return spec;
}

// ============ RUNTIME TEMPLATE ============
function renderActionsRuntimeCode() {
	return `
function resolveValue( value, ctx, event ) {
  event = event || {};
  if ( value && typeof value === 'object' ) {
    const k = value.kind;
    if ( k === 'runtime' ) {
      const s = ( ctx && typeof ctx.getState === 'function' ) ? ctx.getState() : {};
      switch ( value.name ) {
        case 'speed': return Math.abs( Number( s.linearSpeed ) || 0 );
        case 'lapTime': return Number( s.lapTime ?? event.lapTime ?? 0 ) || 0;
        case 'raceTime': return Number( s.raceTime ?? 0 ) || 0;
        case 'checkpointNumber': return Number( event.checkpointNumber ?? s.checkpointNumber ?? 0 ) || 0;
        case 'crashForce': return Number( event.impactVelocity ?? 0 ) || 0;
        case 'random': return Math.random();
        case 'coins': return Number( s.coins ?? 0 ) || 0;
        case 'lapNumber': return Number( s.lapNumber ?? event.lapNumber ?? 0 ) || 0;
        case 'bestLap': return Number( s.bestLapSeconds ?? 0 ) || 0;
        case 'lastLap': return Number( s.lastLapSeconds ?? 0 ) || 0;
        case 'stuntPoints': return Number( s.stuntPoints ?? 0 ) || 0;
        case 'stuntCombo': return Number( s.stuntCombo ?? 0 ) || 0;
        case 'drift': return Number( s.driftIntensity ?? 0 ) || 0;
        case 'angularSpeed': return Number( s.angularSpeed ?? 0 ) || 0;
        case 'topSpeed': return Number( s.topSpeed ?? 0 ) || 0;
        case 'accelRate': return Number( s.accelRate ?? 0 ) || 0;
        case 'driveForce': return Number( s.driveForce ?? 0 ) || 0;
        case 'gripMult': return Number( s.gripMultiplier ?? 0 ) || 0;
        case 'posX': return Number( s.x ?? 0 ) || 0;
        case 'posY': return Number( s.y ?? 0 ) || 0;
        case 'posZ': return Number( s.z ?? 0 ) || 0;
        case 'gameMode': return String( s.gameMode ?? 'race' );
        case 'isAirborne': return Boolean( event.airborne ?? false );
        case 'isDrifting': return Boolean( s.driftIntensity && s.driftIntensity > 0.6 );
        case 'isPaused': return Boolean( s.paused );
        case 'fps': return Number( s.fps ?? 0 ) || 0;
        case 'dt': return Number( event.dt ?? 0 ) || 0;
        case 'speedKmh': return Math.abs( Number( s.linearSpeed ) || 0 ) * 3.6;
        case 'speedMph': return Math.abs( Number( s.linearSpeed ) || 0 ) * 2.23694;
        case 'heading': return ( ( Number( s.heading ) || 0 ) );
        case 'velocityX': return Number( s.velocityX ?? 0 ) || 0;
        case 'velocityY': return Number( s.velocityY ?? 0 ) || 0;
        case 'velocityZ': return Number( s.velocityZ ?? 0 ) || 0;
        case 'isSplitScreen': return Boolean( s.isSplitScreen ?? false );
        case 'dragMult': return Number( s.dragMultiplier ?? 0 ) || 0;
        case 'accelMult': return Number( s.accelMultiplier ?? 0 ) || 0;
        case 'driveMult': return Number( s.driveMultiplier ?? 0 ) || 0;
        case 'timeScale': return Number( s.timeScale ?? 1 ) || 1;
        case 'gravity': return Number( s.gravity ?? 9.81 ) || 9.81;
      }
    }
    if ( k === 'var' ) return Number( ctx.state.vars[ value.name ] ) || 0;
    if ( k === 'textvar' ) return String( ctx.state.textvars[ value.name ] ?? '' );
    if ( k === 'const' ) return value.value;
    if ( k === 'element_text' ) { const el = ctx.state.elements && ctx.state.elements[ value.name ]; return el ? String( el.textContent ?? '' ) : ''; }
    if ( k === 'storage_get' ) { const store = ctx.storage; if ( ! store ) return resolveValue( value.fallback, ctx, event ); const key = String( resolveValue( value.key, ctx, event ) ?? '' ); const v = store.get( key ); return v == null ? resolveValue( value.fallback, ctx, event ) : v; }
    if ( k === 'storage_has' ) { const store = ctx.storage; if ( ! store ) return false; const key = String( resolveValue( value.key, ctx, event ) ?? '' ); return store.get( key ) != null; }
    if ( k === 'text_length' ) { const t = String( resolveValue( value.value, ctx, event ) ?? '' ); return t.length; }
    if ( k === 'text_contains' ) { const t = String( resolveValue( value.text, ctx, event ) ?? '' ); const sub = String( resolveValue( value.sub, ctx, event ) ?? '' ); return t.includes( sub ); }
    if ( k === 'text_case' ) { const t = String( resolveValue( value.value, ctx, event ) ?? '' ); return value.upper ? t.toUpperCase() : t.toLowerCase(); }
    if ( k === 'math' ) {
      const a = Number( resolveValue( value.a, ctx, event ) ) || 0;
      const b = Number( resolveValue( value.b, ctx, event ) ) || 0;
      if ( value.op === 'ADD' ) return a + b;
      if ( value.op === 'MINUS' ) return a - b;
      if ( value.op === 'MULTIPLY' ) return a * b;
      if ( value.op === 'DIVIDE' ) return b === 0 ? 0 : a / b;
      if ( value.op === 'MODULO' ) return b === 0 ? 0 : a % b;
      if ( value.op === 'POWER' ) return Math.pow( a, b );
    }
    if ( k === 'math_single' ) {
      const n = Number( resolveValue( value.num, ctx, event ) ) || 0;
      if ( value.op === 'ABS' ) return Math.abs( n );
      if ( value.op === 'NEG' ) return -n;
      if ( value.op === 'ROUND' ) return Math.round( n );
      if ( value.op === 'FLOOR' ) return Math.floor( n );
      if ( value.op === 'CEIL' ) return Math.ceil( n );
      if ( value.op === 'SQRT' ) return n < 0 ? 0 : Math.sqrt( n );
      if ( value.op === 'SIN' ) return Math.sin( n );
      if ( value.op === 'COS' ) return Math.cos( n );
      if ( value.op === 'TAN' ) return Math.tan( n );
    }
    if ( k === 'clamp' ) { const val = Number( resolveValue( value.value, ctx, event ) ) || 0; const mn = Number( resolveValue( value.min, ctx, event ) ) || 0; const mx = Number( resolveValue( value.max, ctx, event ) ) || 0; return Math.max( mn, Math.min( mx, val ) ); }
    if ( k === 'minmax' ) { const a = Number( resolveValue( value.a, ctx, event ) ) || 0; const b = Number( resolveValue( value.b, ctx, event ) ) || 0; return value.op === 'MIN' ? Math.min( a, b ) : Math.max( a, b ); }
    if ( k === 'deg2rad' ) return ( Number( resolveValue( value.value, ctx, event ) ) || 0 ) * Math.PI / 180;
    if ( k === 'rad2deg' ) return ( Number( resolveValue( value.value, ctx, event ) ) || 0 ) * 180 / Math.PI;
    if ( k === 'join' ) return String( resolveValue( value.a, ctx, event ) ?? '' ) + String( resolveValue( value.b, ctx, event ) ?? '' );
    if ( k === 'tostring' ) return String( resolveValue( value.value, ctx, event ) ?? '' );
    if ( k === 'roundstr' ) { const val = Number( resolveValue( value.value, ctx, event ) ) || 0; const p = Math.max( 0, Math.min( 10, Number( value.places ) || 0 ) ); return val.toFixed( p ); }
    if ( k === 'compare' ) { const a = resolveValue( value.a, ctx, event ); const b = resolveValue( value.b, ctx, event ); if ( value.op === 'EQ' ) return a === b; if ( value.op === 'NEQ' ) return a !== b; if ( value.op === 'LT' ) return a < b; if ( value.op === 'LTE' ) return a <= b; if ( value.op === 'GT' ) return a > b; if ( value.op === 'GTE' ) return a >= b; }
    if ( k === 'boolop' ) { const a = Boolean( resolveValue( value.a, ctx, event ) ); const b = Boolean( resolveValue( value.b, ctx, event ) ); return value.op === 'AND' ? ( a && b ) : ( a || b ); }
    if ( k === 'not' ) return ! resolveValue( value.value, ctx, event );
    if ( k === 'keydown' ) { return Boolean( ctx && ctx.controls && ctx.controls.keys && ctx.controls.keys[ value.key ] ); }
    // ---- EXTENDED VALUE KINDS ----
    if ( k === 'round_int' ) return Math.round( Number( resolveValue( value.num, ctx, event ) ) || 0 );
    if ( k === 'randint' ) { const mn = Math.ceil( Number( resolveValue( value.min, ctx, event ) ) || 0 ); const mx = Math.floor( Number( resolveValue( value.max, ctx, event ) ) || 0 ); if ( mx < mn ) return mn; return Math.floor( Math.random() * ( mx - mn + 1 ) ) + mn; }
    if ( k === 'randrange' ) { const mn = Number( resolveValue( value.min, ctx, event ) ) || 0; const mx = Number( resolveValue( value.max, ctx, event ) ) || mn; return Math.random() * ( mx - mn ) + mn; }
    if ( k === 'lerp' ) { const a = Number( resolveValue( value.a, ctx, event ) ) || 0; const b = Number( resolveValue( value.b, ctx, event ) ) || 0; const t = Math.max( 0, Math.min( 1, Number( resolveValue( value.t, ctx, event ) ) || 0 ) ); return a + ( b - a ) * t; }
    if ( k === 'map_range' ) { const v = Number( resolveValue( value.value, ctx, event ) ) || 0; const inMin = Number( resolveValue( value.inMin, ctx, event ) ) || 0; const inMax = Number( resolveValue( value.inMax, ctx, event ) ) || 1; const outMin = Number( resolveValue( value.outMin, ctx, event ) ) || 0; const outMax = Number( resolveValue( value.outMax, ctx, event ) ) || 1; if ( inMax === inMin ) return outMin; const t = ( v - inMin ) / ( inMax - inMin ); return outMin + ( outMax - outMin ) * t; }
    if ( k === 'math_adv' ) { const n = Number( resolveValue( value.num, ctx, event ) ) || 0; switch ( value.op ) { case 'SIGN': return Math.sign( n ); case 'LOG': return n > 0 ? Math.log( n ) : 0; case 'LOG10': return n > 0 ? Math.log10( n ) : 0; case 'EXP': return Math.exp( n ); case 'TRUNC': return Math.trunc( n ); case 'ASIN': return Math.asin( Math.max( -1, Math.min( 1, n ) ) ); case 'ACOS': return Math.acos( Math.max( -1, Math.min( 1, n ) ) ); case 'ATAN': return Math.atan( n ); case 'TANH': return Math.tanh( n ); case 'SINH': return Math.sinh( n ); case 'COSH': return Math.cosh( n ); case 'RECIP': return n === 0 ? 0 : 1 / n; case 'DEG': return n * Math.PI / 180; case 'RAD': return n * 180 / Math.PI; } return 0; }
    if ( k === 'math_pair' ) { const a = Number( resolveValue( value.a, ctx, event ) ) || 0; const b = Number( resolveValue( value.b, ctx, event ) ) || 0; switch ( value.op ) { case 'ATAN2': return Math.atan2( a, b ); case 'DIST': return Math.sqrt( a * a + b * b ); case 'HYPOT': return Math.hypot( a, b ); case 'GCD': { let x = Math.abs( Math.trunc( a ) ), y = Math.abs( Math.trunc( b ) ); while ( y ) { [ x, y ] = [ y, x % y ]; } return x || 0; } case 'QUOT': return b === 0 ? 0 : Math.trunc( a / b ); case 'REM': return b === 0 ? 0 : a % b; case 'PCT': return b === 0 ? 0 : ( a / b ) * 100; } return 0; }
    if ( k === 'math_const' ) { return { E: Math.E, TAU: Math.PI * 2, PHI: 1.6180339887, SQRT2: Math.SQRT2 }[ value.name ] || 0; }
    if ( k === 'divisible' ) { const b = Number( resolveValue( value.b, ctx, event ) ) || 0; return b !== 0 && ( Number( resolveValue( value.a, ctx, event ) ) || 0 ) % b === 0; }
    if ( k === 'between' ) { const v = Number( resolveValue( value.value, ctx, event ) ) || 0; const mn = Number( resolveValue( value.min, ctx, event ) ) || 0; const mx = Number( resolveValue( value.max, ctx, event ) ) || 0; return v >= Math.min( mn, mx ) && v <= Math.max( mn, mx ); }
    if ( k === 'xor' ) return Boolean( resolveValue( value.a, ctx, event ) ) !== Boolean( resolveValue( value.b, ctx, event ) );
    if ( k === 'is_even' ) { const n = Number( resolveValue( value.num, ctx, event ) ) || 0; return Math.abs( Math.trunc( n ) ) % 2 === 0; }
    if ( k === 'is_positive' ) return Number( resolveValue( value.num, ctx, event ) ) > 0;
    if ( k === 'is_integer' ) { const n = Number( resolveValue( value.num, ctx, event ) ) || 0; return Number.isFinite( n ) && Math.trunc( n ) === n; }
    if ( k === 'is_zero' ) return ( Number( resolveValue( value.num, ctx, event ) ) || 0 ) === 0;
    if ( k === 'text_op' ) { const a = String( resolveValue( value.a, ctx, event ) ?? '' ); const b = String( resolveValue( value.b, ctx, event ) ?? '' ); if ( value.op === 'EQIC' ) return a.toLowerCase() === b.toLowerCase(); if ( value.op === 'STARTS' ) return a.startsWith( b ); if ( value.op === 'ENDS' ) return a.endsWith( b ); return false; }
    if ( k === 'is_empty' ) { const v = resolveValue( value.value, ctx, event ); if ( Array.isArray( v ) ) return v.length === 0; return String( v ?? '' ).length === 0; }
    if ( k === 'text_sub' ) { const t = String( resolveValue( value.text, ctx, event ) ?? '' ); const st = Math.max( 0, Math.floor( Number( resolveValue( value.start, ctx, event ) ) || 0 ) ); const en = Math.max( st, Math.floor( Number( resolveValue( value.end, ctx, event ) ) || t.length ) ); return t.slice( st, en ); }
    if ( k === 'text_charat' ) { const t = String( resolveValue( value.text, ctx, event ) ?? '' ); let i = Math.floor( Number( resolveValue( value.index, ctx, event ) ) || 0 ); if ( i < 0 ) i = t.length + i; return t.charAt( Math.max( 0, Math.min( t.length - 1, i ) ) ); }
    if ( k === 'text_indexof' ) { const t = String( resolveValue( value.text, ctx, event ) ?? '' ); return t.indexOf( String( resolveValue( value.sub, ctx, event ) ?? '' ) ); }
    if ( k === 'text_replace' ) { const t = String( resolveValue( value.text, ctx, event ) ?? '' ); const f = String( resolveValue( value.from, ctx, event ) ?? '' ); const o = String( resolveValue( value.to, ctx, event ) ?? '' ); if ( ! f ) return t; return value.all ? t.split( f ).join( o ) : t.replace( f, o ); }
    if ( k === 'text_repeat' ) { const n = Math.max( 0, Math.min( 500, Math.floor( Number( resolveValue( value.times, ctx, event ) ) || 0 ) ) ); return String( resolveValue( value.text, ctx, event ) ?? '' ).repeat( n ); }
    if ( k === 'text_trim' ) return String( resolveValue( value.text, ctx, event ) ?? '' ).trim();
    if ( k === 'text_pad' ) { let t = String( resolveValue( value.text, ctx, event ) ?? '' ); const len = Math.max( 0, Math.min( 500, Math.floor( Number( resolveValue( value.length, ctx, event ) ) || 0 ) ) ); let ch = String( resolveValue( value.char, ctx, event ) ?? ' ' ).slice( 0, 1 ) || ' '; while ( t.length < len ) t = ( value.op === 'PADL' ? ch + t : t + ch ); return t; }
    if ( k === 'text_reverse' ) return String( resolveValue( value.text, ctx, event ) ?? '' ).split( '' ).reverse().join( '' );
    if ( k === 'text_count' ) { const t = String( resolveValue( value.text, ctx, event ) ?? '' ); const s = String( resolveValue( value.sub, ctx, event ) ?? '' ); if ( ! s ) return 0; let n = 0, i = 0; while ( ( i = t.indexOf( s, i ) ) !== -1 ) { n ++; i += s.length; } return n; }
    if ( k === 'text_tonum' ) { const n = parseFloat( String( resolveValue( value.text, ctx, event ) ?? '' ) ); return Number.isFinite( n ) ? n : 0; }
    if ( k === 'text_split' ) { const t = String( resolveValue( value.text, ctx, event ) ?? '' ); const sep = String( resolveValue( value.sep, ctx, event ) ?? '' ); return sep ? t.split( sep ) : t.split( '' ); }
    if ( k === 'text_first' ) return String( resolveValue( value.text, ctx, event ) ?? '' ).charAt( 0 );
    if ( k === 'text_last' ) { const t = String( resolveValue( value.text, ctx, event ) ?? '' ); return t.charAt( Math.max( 0, t.length - 1 ) ); }
    if ( k === 'text_slice' ) { const t = String( resolveValue( value.text, ctx, event ) ?? '' ); const st = Math.max( 0, Math.floor( Number( resolveValue( value.start, ctx, event ) ) || 0 ) ); const ln = Math.max( 0, Math.floor( Number( resolveValue( value.length, ctx, event ) ) || 0 ) ); return t.slice( st, st + ln ); }
    if ( k === 'text_charcode' ) return String( resolveValue( value.text, ctx, event ) ?? '' ).charCodeAt( 0 ) || 0;
    if ( k === 'text_fromcode' ) { const c = Math.floor( Number( resolveValue( value.num, ctx, event ) ) || 0 ); return String.fromCharCode( Math.max( 0, Math.min( 0x10ffff, c ) ) ); }
    if ( k === 'list' ) { return ( value.items || [] ).map( ( it ) => resolveValue( it, ctx, event ) ); }
    if ( k === 'list_var' ) { const arr = ctx.state.vars[ value.name ]; return Array.isArray( arr ) ? arr.slice() : []; }
    if ( k === 'list_length' ) { const a = resolveValue( value.list, ctx, event ); return Array.isArray( a ) ? a.length : 0; }
    if ( k === 'list_get' ) { const a = resolveValue( value.list, ctx, event ); if ( ! Array.isArray( a ) ) return null; let i = Math.floor( Number( resolveValue( value.index, ctx, event ) ) || 0 ); if ( i < 0 ) i = a.length + i; return a[ Math.max( 0, Math.min( a.length - 1, i ) ) ]; }
    if ( k === 'list_contains' ) { const a = resolveValue( value.list, ctx, event ); const val = resolveValue( value.value, ctx, event ); return Array.isArray( a ) && a.includes( val ); }
    if ( k === 'list_indexof' ) { const a = resolveValue( value.list, ctx, event ); const val = resolveValue( value.value, ctx, event ); return Array.isArray( a ) ? a.indexOf( val ) : -1; }
    if ( k === 'list_reverse' ) { const a = resolveValue( value.list, ctx, event ); return Array.isArray( a ) ? a.slice().reverse() : []; }
    if ( k === 'list_sort' ) { const a = resolveValue( value.list, ctx, event ); if ( ! Array.isArray( a ) ) return []; const n = a.slice().sort( ( x, y ) => ( Number( x ) || 0 ) - ( Number( y ) || 0 ) ); return value.op === 'DESC' ? n.reverse() : n; }
    if ( k === 'list_sum' ) { const a = resolveValue( value.list, ctx, event ); return Array.isArray( a ) ? a.reduce( ( s, x ) => s + ( Number( x ) || 0 ), 0 ) : 0; }
    if ( k === 'list_maxmin' ) { const a = resolveValue( value.list, ctx, event ); if ( ! Array.isArray( a ) || ! a.length ) return 0; const nums = a.map( ( x ) => Number( x ) || 0 ); return value.op === 'MAX' ? Math.max( ...nums ) : Math.min( ...nums ); }
    if ( k === 'list_avg' ) { const a = resolveValue( value.list, ctx, event ); return Array.isArray( a ) && a.length ? a.reduce( ( s, x ) => s + ( Number( x ) || 0 ), 0 ) / a.length : 0; }
    if ( k === 'list_join' ) { const a = resolveValue( value.list, ctx, event ); const sep = String( resolveValue( value.sep, ctx, event ) ?? '' ); return Array.isArray( a ) ? a.join( sep ) : ''; }
    if ( k === 'list_first' ) { const a = resolveValue( value.list, ctx, event ); return Array.isArray( a ) && a.length ? a[ 0 ] : null; }
    if ( k === 'list_last' ) { const a = resolveValue( value.list, ctx, event ); return Array.isArray( a ) && a.length ? a[ a.length - 1 ] : null; }
    if ( k === 'storage_count' ) { const store = ctx.storage; if ( ! store || typeof store.count !== 'function' ) return 0; try { return store.count(); } catch { return 0; } }
  }
  return value;
}
function runActions( actions, ctx, event ) {
  event = event || {};
  const api = ( ctx && ctx.api ) || {};
  if ( ! ctx.state ) ctx.state = { vars: {}, textvars: {}, timers: [], waits: [], elements: {} };
  for ( const action of actions || [] ) {
    if ( ! action || ! action.type ) continue;
    const value = resolveValue( action.value, ctx, event );
    switch ( action.type ) {
      case 'set_speed': if ( typeof api.setSpeed === 'function' ) api.setSpeed( Number( value ) || 0, event ); break;
      case 'boost': if ( typeof api.boost === 'function' ) api.boost( Number( value ) || 0, event ); break;
      case 'set_top_speed': if ( typeof api.setTopSpeed === 'function' ) api.setTopSpeed( Number( value ) || 1 ); break;
      case 'set_accel_rate': if ( typeof api.setAccelRate === 'function' ) api.setAccelRate( Number( value ) || 6 ); break;
      case 'set_brake_rate': if ( typeof api.setBrakeRate === 'function' ) api.setBrakeRate( Number( value ) || 8 ); break;
      case 'set_drive_force': if ( typeof api.setDriveForce === 'function' ) api.setDriveForce( Number( value ) || 100 ); break;
      case 'set_drag': if ( typeof api.setDragMultiplier === 'function' ) api.setDragMultiplier( Number( value ) || 1 ); break;
      case 'set_reverse_accel': if ( typeof api.setReverseAccelRate === 'function' ) api.setReverseAccelRate( Number( value ) || 2 ); break;
      case 'set_gravity': if ( typeof api.setGravity === 'function' ) api.setGravity( Number( value ) || 9.81, event ); break;
      case 'set_time_scale': if ( typeof api.setTimeScale === 'function' ) api.setTimeScale( Number( value ) || 1, event ); break;
      case 'set_accel_mult': if ( typeof api.setAccelMultiplier === 'function' ) api.setAccelMultiplier( Number( value ) || 1, event ); break;
      case 'set_drive_mult': if ( typeof api.setDriveMultiplier === 'function' ) api.setDriveMultiplier( Number( value ) || 1, event ); break;
      case 'set_grip_mult': if ( typeof api.setGripMultiplier === 'function' ) api.setGripMultiplier( Number( value ) || 1, event ); break;
      case 'force_brake': if ( typeof api.forceBrake === 'function' ) api.forceBrake( Number( value ) || 0.4, event ); break;
      case 'force_throttle': if ( typeof api.forceThrottle === 'function' ) api.forceThrottle( Number( value ) || 0.4, event ); break;
      case 'disable_steering': if ( typeof api.disableSteering === 'function' ) api.disableSteering( Number( value ) || 0.5, event ); break;
      case 'jump': if ( typeof api.jump === 'function' ) api.jump( Number( value ) || 6, event ); break;
      case 'reset_car': if ( typeof api.resetCar === 'function' ) api.resetCar( event ); break;
      case 'teleport': if ( typeof api.teleport === 'function' ) api.teleport( Number( resolveValue( action.x, ctx, event ) ) || 0, Number( resolveValue( action.y, ctx, event ) ) || 1, Number( resolveValue( action.z, ctx, event ) ) || 0 ); break;
      case 'impulse': if ( typeof api.applyImpulse === 'function' ) api.applyImpulse( Number( resolveValue( action.x, ctx, event ) ) || 0, Number( resolveValue( action.y, ctx, event ) ) || 0, Number( resolveValue( action.z, ctx, event ) ) || 0 ); break;
      case 'angular': if ( typeof api.setAngularImpulse === 'function' ) api.setAngularImpulse( Number( resolveValue( action.x, ctx, event ) ) || 0, Number( resolveValue( action.y, ctx, event ) ) || 0, Number( resolveValue( action.z, ctx, event ) ) || 0 ); break;
      case 'set_spin': if ( typeof api.setVehicleSpin === 'function' ) api.setVehicleSpin( Number( value ) || 0 ); break;
      case 'set_scale': if ( typeof api.setVehicleScale === 'function' ) api.setVehicleScale( Number( value ) || 1 ); break;
      case 'set_visible': if ( typeof api.setVehicleVisible === 'function' ) api.setVehicleVisible( Number( value ) || 0 ); break;
      case 'set_drift': if ( typeof api.setDriftIntensity === 'function' ) api.setDriftIntensity( Number( value ) || 0 ); break;
      case 'set_model': if ( typeof api.setVehicleModel === 'function' ) api.setVehicleModel( String( value ) ); break;
      case 'camera_shake': if ( typeof api.cameraShake === 'function' ) api.cameraShake( Number( value ) || 1, event ); break;
      case 'set_fov': if ( typeof api.setCameraFov === 'function' ) api.setCameraFov( Number( value ) || 42 ); break;
      case 'set_camera_mode': if ( typeof api.setCameraMode === 'function' ) api.setCameraMode( String( value ) ); break;
      case 'show_message': if ( typeof api.showMessage === 'function' ) api.showMessage( String( value ?? '' ), { durationMs: Number( resolveValue( action.duration, ctx, event ) ) || 1600 } ); break;
      case 'spawn_particle': if ( typeof api.spawnParticle === 'function' ) api.spawnParticle( event ); break;
      case 'spawn_particle_burst': if ( typeof api.spawnParticleBurst === 'function' ) api.spawnParticleBurst( Number( value ) || 0.45 ); break;
      case 'set_fog_strength': if ( typeof api.setFogStrength === 'function' ) api.setFogStrength( Number( value ) || 1, event ); break;
      case 'set_fog_density': if ( typeof api.setFogDensity === 'function' ) api.setFogDensity( Number( value ) || 1 ); break;
      case 'set_fog_color': if ( typeof api.setFogColor === 'function' ) api.setFogColor( String( value ) ); break;
      case 'set_bg_color': if ( typeof api.setBackgroundColor === 'function' ) api.setBackgroundColor( String( value ) ); break;
      case 'set_sky_color': if ( typeof api.setSkyColor === 'function' ) api.setSkyColor( String( value ) ); break;
      case 'set_horizon_color': if ( typeof api.setHorizonColor === 'function' ) api.setHorizonColor( String( value ) ); break;
      case 'set_particle_color': if ( typeof api.setParticleColor === 'function' ) api.setParticleColor( String( value ) ); break;
      case 'flash_screen': if ( typeof api.flashScreen === 'function' ) api.flashScreen( String( value ) ); break;
      case 'set_sky_vibrance': if ( typeof api.setSkyVibrance === 'function' ) api.setSkyVibrance( Number( value ) || 0 ); break;
      case 'set_sky_palette': if ( typeof api.setSkyPalette === 'function' ) api.setSkyPalette( String( value ) ); break;
      case 'set_sun': if ( typeof api.setSunIntensity === 'function' ) api.setSunIntensity( Number( value ) || 5 ); break;
      case 'set_hemi': if ( typeof api.setHemiIntensity === 'function' ) api.setHemiIntensity( Number( value ) || 1.5 ); break;
      case 'set_exposure': if ( typeof api.setExposure === 'function' ) api.setExposure( Number( value ) || 1 ); break;
      case 'set_engine_vol': if ( typeof api.setEngineVolume === 'function' ) api.setEngineVolume( Number( value ) || 1 ); break;
      case 'set_music_vol': if ( typeof api.setMusicVolume === 'function' ) api.setMusicVolume( Number( value ) || 1 ); break;
      case 'play_impact': if ( typeof api.playImpactSound === 'function' ) api.playImpactSound( Number( value ) || 3 ); break;
      case 'set_hud_text': if ( typeof api.setHudText === 'function' ) api.setHudText( String( value ?? '' ) ); break;
      case 'set_effect_msg': if ( typeof api.setEffectMessage === 'function' ) api.setEffectMessage( String( value ?? '' ) ); break;
      case 'set_fps': if ( typeof api.setFpsCounter === 'function' ) api.setFpsCounter( Number( value ) || 0 ); break;
      case 'add_stunt': if ( typeof api.addStuntPoints === 'function' ) api.addStuntPoints( Number( value ) || 0, String( resolveValue( action.reason, ctx, event ) ?? '' ) ); break;
      case 'add_coins': if ( typeof api.addCoins === 'function' ) api.addCoins( Number( value ) || 0 ); break;
      case 'set_pixel_ratio': if ( typeof api.setRendererPixelRatio === 'function' ) api.setRendererPixelRatio( Number( value ) || 1 ); break;
      case 'set_shadows': if ( typeof api.setShadowEnabled === 'function' ) api.setShadowEnabled( Number( value ) || 0 ); break;
      case 'start_timer': ctx.state.timers.push( { remaining: Math.max( 0, Number( value ) || 0 ), id: action.id || 'timer1' } ); break;
      case 'wait': ctx.state.waits.push( { remaining: Math.max( 0, Number( value ) || 0 ), paused: true, actions: null } ); break;
      case 'random_delay': { const mn = Number( resolveValue( action.min, ctx, event ) ) || 0; const mx = Number( resolveValue( action.max, ctx, event ) ) || mn; ctx.state.waits.push( { remaining: Math.random() * Math.abs( mx - mn ) + Math.min( mn, mx ), paused: true, actions: null } ); break; }
      case 'repeat': { const times = Math.max( 0, Math.min( 100, Math.floor( Number( resolveValue( action.times, ctx, event ) ) || 0 ) ) ); for ( let i = 0; i < times; i++ ) runActions( action.body || [], ctx, event ); break; }
      case 'loop_forever': { for ( let i = 0; i < 60; i++ ) runActions( action.body || [], ctx, event ); break; }
      case 'var_set': ctx.state.vars[ action.name ] = Number( value ) || 0; break;
      case 'var_add': ctx.state.vars[ action.name ] = ( Number( ctx.state.vars[ action.name ] ) || 0 ) + ( Number( value ) || 0 ); break;
      case 'textvar_set': ctx.state.textvars[ action.name ] = String( value ?? '' ); break;
      case 'if': if ( resolveValue( action.cond, ctx, event ) ) runActions( action.body || [], ctx, event ); break;
      case 'ifelse': if ( resolveValue( action.cond, ctx, event ) ) runActions( action.body || [], ctx, event ); else runActions( action.elseBody || [], ctx, event ); break;
      // UI builder
      case 'ui_panel': { const ui = ctx.ui; if ( ui ) { const p = ui.panel( { title: String( resolveValue( action.title, ctx, event ) ?? '' ), x: Number( resolveValue( action.x, ctx, event ) ) || 12, y: Number( resolveValue( action.y, ctx, event ) ) || 12 } ); ctx.state.elements[ action.name ] = p; } break; }
      case 'ui_button': { const ui = ctx.ui; if ( ui ) { const el = ui.button( String( resolveValue( action.label, ctx, event ) ?? 'Button' ), () => runActions( action.body || [], ctx, { type: 'click' } ) ); ctx.state.elements[ action.name ] = el; } break; }
      case 'ui_label': { const ui = ctx.ui; if ( ui ) ctx.state.elements[ action.name ] = ui.label( String( resolveValue( action.text, ctx, event ) ?? '' ) ); break; }
      case 'ui_slider': { const ui = ctx.ui; if ( ui ) { const el = ui.slider( String( resolveValue( action.label, ctx, event ) ?? '' ), Number( resolveValue( action.min, ctx, event ) ) || 0, Number( resolveValue( action.max, ctx, event ) ) || 100, Number( resolveValue( action.value, ctx, event ) ) || 0, ( val ) => { ctx.state.vars[ action.name ] = Number( val ) || 0; runActions( action.body || [], ctx, { type: 'slider', value: Number( val ) || 0 } ); } ); ctx.state.elements[ action.name ] = el; } break; }
      case 'ui_set_text': { const el = ctx.state.elements && ctx.state.elements[ action.name ]; if ( el && ctx.ui ) ctx.ui.setText( el, String( resolveValue( action.text, ctx, event ) ?? '' ) ); break; }
      case 'ui_set_style': { const el = ctx.state.elements && ctx.state.elements[ action.name ]; if ( el && ctx.ui ) { const prop = String( resolveValue( action.prop, ctx, event ) ?? '' ); const val = String( resolveValue( action.value, ctx, event ) ?? '' ); ctx.ui.setStyle( el, { [ prop ]: val } ); } break; }
      case 'ui_append': { const parent = ctx.state.elements && ctx.state.elements[ action.parent ]; const child = ctx.state.elements && ctx.state.elements[ action.child ]; if ( parent && child && ctx.ui ) ctx.ui.append( parent, child ); break; }
      case 'ui_remove': { const el = ctx.state.elements && ctx.state.elements[ action.name ]; if ( el && ctx.ui ) { ctx.ui.remove( el ); delete ctx.state.elements[ action.name ]; } break; }
      case 'ui_clear': { if ( ctx.ui ) ctx.ui.clear(); ctx.state.elements = {}; break; }
      case 'ui_show': { const el = ctx.state.elements && ctx.state.elements[ action.name ]; if ( el ) el.style.display = ''; break; }
      case 'ui_hide': { const el = ctx.state.elements && ctx.state.elements[ action.name ]; if ( el ) el.style.display = 'none'; break; }
      // Storage
      case 'storage_set': { const store = ctx.storage; if ( store ) { const key = String( resolveValue( action.key, ctx, event ) ?? '' ); store.set( key, resolveValue( action.value, ctx, event ) ); } break; }
      case 'storage_remove': { const store = ctx.storage; if ( store ) store.remove( String( resolveValue( action.key, ctx, event ) ?? '' ) ); break; }
      case 'storage_clear': { const store = ctx.storage; if ( store ) store.clear(); break; }
      // Game control
      case 'respawn': { const api = ctx.api; if ( api && typeof api.respawn === 'function' ) api.respawn(); break; }
      case 'pause': { const api = ctx.api; if ( api && typeof api.setPaused === 'function' ) api.setPaused( true ); break; }
      case 'resume': { const api = ctx.api; if ( api && typeof api.setPaused === 'function' ) api.setPaused( false ); break; }
      // ---- EXTENDED ACTIONS ----
      case 'var_multiply': ctx.state.vars[ action.name ] = ( Number( ctx.state.vars[ action.name ] ) || 0 ) * ( Number( value ) || 1 ); break;
      case 'var_divide': { const d = Number( value ) || 0; ctx.state.vars[ action.name ] = d === 0 ? 0 : ( Number( ctx.state.vars[ action.name ] ) || 0 ) / d; break; }
      case 'var_clamp': { const cur = Number( ctx.state.vars[ action.name ] ) || 0; const mn = Number( resolveValue( action.min, ctx, event ) ) || 0; const mx = Number( resolveValue( action.max, ctx, event ) ) || 0; ctx.state.vars[ action.name ] = Math.max( Math.min( mn, mx ), Math.min( Math.max( mn, mx ), cur ) ); break; }
      case 'textvar_append': ctx.state.textvars[ action.name ] = String( ctx.state.textvars[ action.name ] ?? '' ) + String( value ?? '' ); break;
      case 'list_set': { const key = String( resolveValue( action.key, ctx, event ) ?? '' ); let arr = ctx.state.vars[ key ]; if ( ! Array.isArray( arr ) ) { arr = []; ctx.state.vars[ key ] = arr; } let i = Math.floor( Number( resolveValue( action.index, ctx, event ) ) || 0 ); if ( i < 0 ) i = 0; if ( i > arr.length ) i = arr.length; arr[ i ] = resolveValue( action.value, ctx, event ); break; }
      case 'list_add': { const key = String( resolveValue( action.key, ctx, event ) ?? '' ); if ( ! Array.isArray( ctx.state.vars[ key ] ) ) ctx.state.vars[ key ] = []; ctx.state.vars[ key ].push( resolveValue( action.value, ctx, event ) ); break; }
      case 'list_remove': { const key = String( resolveValue( action.key, ctx, event ) ?? '' ); if ( Array.isArray( ctx.state.vars[ key ] ) ) { let i = Math.floor( Number( resolveValue( action.index, ctx, event ) ) || 0 ); if ( i < 0 ) i = 0; if ( i < ctx.state.vars[ key ].length ) ctx.state.vars[ key ].splice( i, 1 ); } break; }
      case 'list_clear': { const key = String( resolveValue( action.key, ctx, event ) ?? '' ); ctx.state.vars[ key ] = []; break; }
      case 'ui_heading': { const ui = ctx.ui; if ( ui ) { const el = ui.create( action.tag, { text: String( resolveValue( action.text, ctx, event ) ?? '' ), style: { color: '#fff', fontWeight: '700', margin: '4px 0' } } ); ctx.state.elements[ action.name ] = el; } break; }
      case 'ui_progress': { const ui = ctx.ui; if ( ui ) { const el = ui.create( 'progress', { attrs: { max: String( Math.max( 1, Number( resolveValue( action.max, ctx, event ) ) || 100 ) ), value: String( Math.max( 0, Number( resolveValue( action.value, ctx, event ) ) || 0 ) ) }, style: { width: '100%' } } ); ctx.state.elements[ action.name ] = el; } break; }
      case 'ui_checkbox': { const ui = ctx.ui; if ( ui ) { const wrap = ui.create( 'div', { style: { display: 'flex', gap: '4px', alignItems: 'center' } } ); const el = ui.create( 'input', { attrs: { type: 'checkbox' } } ); el.checked = Boolean( ctx.state.vars[ action.varName ] ); const lab = ui.create( 'label', { text: String( resolveValue( action.label, ctx, event ) ?? '' ) } ); if ( ctx.ui && typeof ctx.ui.on === 'function' ) ctx.ui.on( el, 'change', () => { ctx.state.vars[ action.varName ] = el.checked ? 1 : 0; runActions( action.body || [], ctx, { type: 'change', value: el.checked ? 1 : 0 } ); } ); ui.append( wrap, el ); ui.append( wrap, lab ); ctx.state.elements[ action.name ] = wrap; } break; }
      case 'ui_dropdown': { const ui = ctx.ui; if ( ui ) { const sel = ui.create( 'select', {} ); const opts = Array.isArray( action.options ) ? action.options : []; for ( const o of opts.slice( 0, 24 ) ) { const opt = ui.create( 'option', { text: String( o ) } ); ui.append( sel, opt ); } if ( ctx.ui && typeof ctx.ui.on === 'function' ) ctx.ui.on( sel, 'change', () => { ctx.state.vars[ action.varName ] = sel.value; runActions( action.body || [], ctx, { type: 'change', value: sel.value } ); } ); ctx.state.elements[ action.name ] = sel; } break; }
      case 'ui_text_input': { const ui = ctx.ui; if ( ui ) { const el = ui.create( 'input', { attrs: { type: 'text' } } ); if ( ctx.ui && typeof ctx.ui.on === 'function' ) ctx.ui.on( el, 'input', () => { ctx.state.textvars[ action.varName ] = el.value; runActions( action.body || [], ctx, { type: 'input', value: el.value } ); } ); ctx.state.elements[ action.name ] = el; } break; }
      case 'ui_divider': { const ui = ctx.ui; if ( ui ) { const el = ui.create( 'div', { style: { borderTop: '1px solid rgba(255,255,255,0.25)', margin: '6px 0' } } ); ctx.state.elements[ action.name ] = el; } break; }
      case 'ui_set_position': { const el = ctx.state.elements && ctx.state.elements[ action.name ]; if ( el ) { el.style.position = 'absolute'; el.style.left = ( Math.max( -50, Math.min( 95, Number( resolveValue( action.x, ctx, event ) ) || 0 ) ) ) + 'px'; el.style.top = ( Math.max( -50, Math.min( 95, Number( resolveValue( action.y, ctx, event ) ) || 0 ) ) ) + 'px'; } break; }
      case 'ui_set_size': { const el = ctx.state.elements && ctx.state.elements[ action.name ]; if ( el ) { el.style.width = ( Math.max( 8, Math.min( 800, Number( resolveValue( action.w, ctx, event ) ) || 100 ) ) ) + 'px'; el.style.height = ( Math.max( 8, Math.min( 600, Number( resolveValue( action.h, ctx, event ) ) || 40 ) ) ) + 'px'; } break; }
      case 'ui_set_enabled': { const el = ctx.state.elements && ctx.state.elements[ action.name ]; if ( el ) el.disabled = action.state !== '1'; break; }
      case 'ui_on_click': { const el = ctx.state.elements && ctx.state.elements[ action.name ]; if ( el && ctx.ui && typeof ctx.ui.on === 'function' ) ctx.ui.on( el, 'click', () => runActions( action.body || [], ctx, { type: 'click' } ) ); break; }
      case 'storage_increment': { const store = ctx.storage; if ( store ) { const key = String( resolveValue( action.key, ctx, event ) ?? '' ); const cur = Number( store.get( key ) ) || 0; store.set( key, cur + ( Number( resolveValue( action.by, ctx, event ) ) || 1 ) ); } break; }
      case 'storage_list_add': { const store = ctx.storage; if ( store ) { const key = String( resolveValue( action.key, ctx, event ) ?? '' ); let arr = store.get( key ); if ( ! Array.isArray( arr ) ) arr = []; arr.push( resolveValue( action.value, ctx, event ) ); store.set( key, arr ); } break; }
      case 'set_camera_distance': if ( typeof api.setCameraDistance === 'function' ) api.setCameraDistance( Math.max( 2, Math.min( 30, Number( value ) || 8 ) ) ); break;
      case 'set_camera_height': if ( typeof api.setCameraHeight === 'function' ) api.setCameraHeight( Math.max( 0, Math.min( 20, Number( value ) || 3 ) ) ); break;
      case 'set_camera_lag': if ( typeof api.setCameraLag === 'function' ) api.setCameraLag( Math.max( 0, Math.min( 1, Number( value ) || 1 ) ) ); break;
      case 'set_camera_pitch': if ( typeof api.setCameraPitch === 'function' ) api.setCameraPitch( Math.max( -45, Math.min( 45, Number( value ) || 0 ) ) ); break;
      case 'set_sun_position': if ( typeof api.setSunPosition === 'function' ) api.setSunPosition( Math.max( 0, Math.min( 360, Number( value ) || 45 ) ) ); break;
      case 'set_snow': if ( typeof api.setSnowIntensity === 'function' ) api.setSnowIntensity( Math.max( 0, Math.min( 1, Number( value ) || 0 ) ) ); break;
      case 'set_rain': if ( typeof api.setRainIntensity === 'function' ) api.setRainIntensity( Math.max( 0, Math.min( 1, Number( value ) || 0 ) ) ); break;
      case 'play_cue': if ( typeof api.playCue === 'function' ) api.playCue( String( value ) ); break;
    }
  }
}
`;
}

function generateTemplate() {
	const id = safeId( document.getElementById( 'mod-id' )?.value ) || `custom-${ Date.now() }`;
	const name = ( document.getElementById( 'mod-name' )?.value || 'Custom Mod' ).trim();
	const spec = buildRuntimeSpec();
	return `// ${ name }\nconst SPEC = ${ JSON.stringify( spec, null, 2 ) };\n${ renderActionsRuntimeCode() }\nexport default {\n  id: ${ JSON.stringify( id ) },\n  init( context ) { this.ctx = context; this.state = { vars: {}, textvars: {}, timers: [], waits: [], elements: {} }; this.ctx.state = this.state; this.keyLatch = Object.create( null ); this.wasAirborne = false; this.wasDrifting = false; runActions( SPEC.onStart, this.ctx, { type: 'start' } ); },\n  applyFrame( { controls, vehicle, world, dt, now } ) { const ctx = this.ctx || { vehicle, world, controls }; ctx.state = this.state; const st = ( typeof ctx.getState === 'function' ) ? ctx.getState() : {}; const ev = { type: 'tick', dt, now, airborne: Boolean( st.airborne ), lapTime: st.lapTime, raceTime: st.raceTime };\n    runActions( SPEC.onTick, ctx, ev );\n    for ( const [ key, actions ] of Object.entries( SPEC.onKey || {} ) ) { const down = Boolean( controls && controls.keys && controls.keys[ key ] ); if ( down && ! this.keyLatch[ key ] ) runActions( actions, ctx, { type: 'key', key, dt, now } ); this.keyLatch[ key ] = down; }\n    for ( const [ key, actions ] of Object.entries( SPEC.onKeyHold || {} ) ) { if ( controls && controls.keys && controls.keys[ key ] ) runActions( actions, ctx, { type: 'keyhold', key, dt, now } ); }\n    for ( const [ key, actions ] of Object.entries( SPEC.onKeyRelease || {} ) ) { const down = Boolean( controls && controls.keys && controls.keys[ key ] ); if ( ! down && this.keyLatch[ key ] ) runActions( actions, ctx, { type: 'keyrelease', key, dt, now } ); this.keyLatch[ key ] = down; }\n    const speed = Math.abs( Number( st.linearSpeed ) || 0 ); for ( const t of ( SPEC.onSpeedThreshold || [] ) ) { const th = Number( resolveValue( t.threshold, ctx, ev ) ) || 0; if ( speed > th ) runActions( t.body, ctx, { type: 'speed_threshold', speed, threshold: th, dt, now } ); } for ( const t of ( SPEC.onLowSpeed || [] ) ) { const th = Number( resolveValue( t.threshold, ctx, ev ) ) || 0; if ( speed < th ) runActions( t.body, ctx, { type: 'low_speed', speed, threshold: th, dt, now } ); } for ( const t of ( SPEC.onHighSpeed || [] ) ) { const th = Number( resolveValue( t.threshold, ctx, ev ) ) || 0; if ( speed > th ) runActions( t.body, ctx, { type: 'high_speed', speed, threshold: th, dt, now } ); } for ( const t of ( SPEC.onLowSpeedHeld || [] ) ) { const th = Number( resolveValue( t.threshold, ctx, ev ) ) || 0; if ( speed < th ) runActions( t.body, ctx, { type: 'low_speed_held', speed, threshold: th, dt, now } ); }\n    const airborne = Boolean( ev.airborne ); if ( airborne && ! this.wasAirborne ) runActions( SPEC.onAir, ctx, { type: 'air', dt, now } ); if ( ! airborne && this.wasAirborne ) runActions( SPEC.onGround, ctx, { type: 'ground', dt, now } ); this.wasAirborne = airborne;\n    const drifting = Boolean( st.driftIntensity && st.driftIntensity > 0.6 ); if ( drifting && ! this.wasDrifting ) runActions( SPEC.onDrift, ctx, { type: 'drift', dt, now } ); this.wasDrifting = drifting;\n    if ( Array.isArray( this.state.timers ) ) { for ( const t of this.state.timers ) t.remaining -= dt; const done = this.state.timers.filter( ( t ) => t.remaining <= 0 ); this.state.timers = this.state.timers.filter( ( t ) => t.remaining > 0 ); for ( const t of done ) runActions( ( SPEC.onTimerDone && SPEC.onTimerDone[ t.id ] ) || [], ctx, { type: 'timer_done', id: t.id, now } ); }\n    return null;\n  },\n  onCheckpoint( event ) { runActions( SPEC.onCheckpoint, this.ctx, { type: 'checkpoint', ...( event || {} ) } ); },\n  onCrash( event ) { runActions( SPEC.onCrash, this.ctx, { type: 'crash', ...( event || {} ) } ); },\n  onRespawn( event ) { runActions( SPEC.onRespawn, this.ctx, { type: 'respawn', ...( event || {} ) } ); },\n  onLapFinish( event ) { runActions( SPEC.onLapFinish, this.ctx, { type: 'lapFinish', ...( event || {} ) } ); },\n  dispose() { try { this.ctx?.ui?.clear?.(); } catch {} this.ctx = null; this.state = null; this.keyLatch = Object.create( null ); }\n};\n`;
}

// ============ SHARING ============
function toBase64Url( str ) { const bytes = new TextEncoder().encode( str ); let bin = ''; bytes.forEach( ( b ) => { bin += String.fromCharCode( b ); } ); return btoa( bin ).replace( /\+/g, '-' ).replace( /\//g, '_' ).replace( /=+$/g, '' ); }
function fromBase64Url( raw ) { const norm = String( raw || '' ).replace( /-/g, '+' ).replace( /_/g, '/' ); const padded = norm + '==='.slice( ( norm.length + 3 ) % 4 ); const bin = atob( padded ); const bytes = Uint8Array.from( bin, ( c ) => c.charCodeAt( 0 ) ); return new TextDecoder().decode( bytes ); }
// Build a `data:text/javascript;base64,...` URL for the generated runtime so the
// mod can be imported via dynamic import() at boot. Mirrors the helper in
// js/mods-manager.js used by the shared-mod Install button.
function toJsDataUrl( code ) { const bytes = new TextEncoder().encode( String( code || '' ) ); let bin = ''; bytes.forEach( ( b ) => { bin += String.fromCharCode( b ); } ); return `data:text/javascript;base64,${ btoa( bin ) }`; }

function getSharePayload() {
	return {
		type: 'racing-custom-mod-share-v1',
		modId: safeId( document.getElementById( 'mod-id' )?.value ) || `custom-${ Date.now() }`,
		modName: ( document.getElementById( 'mod-name' )?.value || '' ).trim() || 'Custom Mod',
		xml: exportXmlPretty(),
		template: generateTemplate(),
		createdAt: new Date().toISOString(),
	};
}

function applySharePayload( payload ) {
	if ( ! payload || payload.type !== 'racing-custom-mod-share-v1' ) throw new Error( 'Unsupported share payload' );
	document.getElementById( 'mod-id' ).value = payload.modId || '';
	document.getElementById( 'mod-name' ).value = payload.modName || '';
	if ( payload.xml ) { loadXmlText( payload.xml ); document.getElementById( 'xmlBox' ).value = payload.xml; }
}

// ============ BUTTON HANDLERS ============
// The editor shows the Blockly XML in the textarea for transparency and round-trips it
// back into the canvas on import, so sharing actually preserves the blocks.
document.getElementById( 'export-xml' )?.addEventListener( 'click', () => {
	document.getElementById( 'xmlBox' ).value = exportXmlPretty();
	setStatus( 'XML exported — paste into the box on another device to import' );
} );

document.getElementById( 'import-xml' )?.addEventListener( 'click', () => {
	const text = document.getElementById( 'xmlBox' ).value.trim();
	if ( ! text ) return setStatus( 'Nothing to import — paste XML first' );
	try {
		// Accept either raw Blockly XML or a full share URL.
		let payload = null;
		if ( /share=/.test( text ) ) {
			const share = new URL( text ).searchParams.get( 'share' );
			payload = JSON.parse( fromBase64Url( share ) );
		} else if ( text.startsWith( '{' ) ) {
			payload = JSON.parse( text );
		}
		if ( payload && payload.type === 'racing-custom-mod-share-v1' ) {
			applySharePayload( payload );
			setStatus( `Imported shared mod: ${ payload.modName || payload.modId }` );
			return;
		}
		loadXmlText( text );
		setStatus( 'XML imported into canvas' );
	} catch ( e ) {
		setStatus( 'Invalid XML or share data' );
	}
} );

document.getElementById( 'export-template' )?.addEventListener( 'click', () => {
	document.getElementById( 'xmlBox' ).value = generateTemplate();
	setStatus( 'JS runtime template generated (for advanced users)' );
} );

document.getElementById( 'save-draft' )?.addEventListener( 'click', () => {
	localStorage.setItem( DRAFT_KEY, JSON.stringify( {
		modId: document.getElementById( 'mod-id' ).value,
		modName: document.getElementById( 'mod-name' ).value,
		xml: exportXmlPretty(),
		savedAt: Date.now(),
	} ) );
	setStatus( 'Draft saved to this browser' );
} );

document.getElementById( 'load-draft' )?.addEventListener( 'click', () => {
	const raw = localStorage.getItem( DRAFT_KEY );
	if ( ! raw ) return setStatus( 'No draft found' );
	try {
		const p = JSON.parse( raw );
		document.getElementById( 'mod-id' ).value = p.modId || '';
		document.getElementById( 'mod-name' ).value = p.modName || '';
		if ( p.xml ) { loadXmlText( p.xml ); document.getElementById( 'xmlBox' ).value = p.xml; }
		setStatus( 'Draft loaded into canvas' );
	} catch ( e ) {
		setStatus( 'Could not load draft' );
	}
} );

document.getElementById( 'export-share' )?.addEventListener( 'click', async () => {
	const payload = getSharePayload();
	// The share URL carries the full payload (XML + generated runtime template) so
	// receivers can both load the blocks into the canvas AND install a working mod
	// from the Mods page without needing Blockly to re-parse anything.
	const packed = toBase64Url( JSON.stringify( payload ) );
	const url = `${ location.origin }${ location.pathname }?share=${ encodeURIComponent( packed ) }`;
	document.getElementById( 'xmlBox' ).value = url;
	try { await navigator.clipboard.writeText( url ); setStatus( 'Share URL copied to clipboard' ); }
	catch { setStatus( 'Share URL generated (copy it manually)' ); }
} );

document.getElementById( 'save-to-manager' )?.addEventListener( 'click', () => {
	try {
		const payload = getSharePayload();
		// 1) Keep the mod in the shared-mods list so it shows up in the Mods page
		//    (Import Shared / Install / Copy JSON) for re-installation or sharing.
		let arr = JSON.parse( localStorage.getItem( SHARED_KEY ) || '[]' );
		if ( ! Array.isArray( arr ) ) arr = [];
		arr = arr.filter( ( x ) => x.modId !== payload.modId );
		arr.push( payload );
		// Quota-safe: evict oldest shared payloads on overflow so the save never throws.
		while ( arr.length ) {
			try { localStorage.setItem( SHARED_KEY, JSON.stringify( arr ) ); break; }
			catch ( e ) { arr.shift(); }
		}
		// 2) ACTUALLY INSTALL the generated runtime so the mod runs in index.html on
		//    the next load and survives reload. This writes the same shape
		//    ({id,name,entry}) js/main.js loadRuntimeMods() imports at boot. Replace
		//    any previously-installed custom-* mod so installing a new one swaps it
		//    in instead of stacking (matches the shared-mod Install button).
		const installedRaw = JSON.parse( localStorage.getItem( INSTALLED_MODS_KEY ) || '[]' );
		const installedList = Array.isArray( installedRaw ) ? installedRaw : [];
		const installId = `custom-${ payload.modId }`;
		const code = String( payload.template || '' ).trim() || `const SPEC = {};\nexport default { id: ${ JSON.stringify( installId ) }, init(){}, applyFrame(){ return null; } };\n`;
		const next = installedList.filter( ( m ) => ! ( typeof m?.id === 'string' && m.id.startsWith( 'custom-' ) ) );
		next.push( { id: installId, name: payload.modName || payload.modId || 'Custom Mod', entry: toJsDataUrl( code ) } );
		// Quota-safe: if the data URL blows localStorage, drop older custom-* entries.
		for ( let attempt = next.length - 1; attempt >= 0; attempt -- ) {
			try { localStorage.setItem( INSTALLED_MODS_KEY, JSON.stringify( next ) ); break; }
			catch ( e ) {
				const idx = next.findIndex( ( m ) => typeof m?.id === 'string' && m.id.startsWith( 'custom-' ) && m.id !== installId );
				if ( idx < 0 ) throw e;
				next.splice( idx, 1 );
			}
		}
		setStatus( `Installed "${ payload.modName }" — it will run next time you load the game (reload index.html).` );
	} catch ( e ) {
		setStatus( `Could not save to Mod Manager: ${ e.message || e }` );
	}
} );

// A ready-made demo mod that shows off the new UI / storage / game-control blocks.
// Loads straight into the canvas so modders can study and remix it.
const SAMPLE_MOD = {
	modId: 'custom-demo-hud',
	modName: 'Demo: HUD + Save + Nitro',
	xml: `<xml xmlns="https://developers.google.com/blockly/xml">
  <block type="event_on_start" id="s1" x="20" y="20">
    <statement name="DO">
      <block type="ui_create_panel" id="p1">
        <value name="X"><block type="math_number"><field name="NUM">12</field></block></value>
        <value name="Y"><block type="math_number"><field name="NUM">12</field></block></value>
        <value name="TITLE"><block type="text"><field name="TEXT">Nitro Mod</field></block></value>
        <field name="NAME">panel</field>
        <next>
          <block type="ui_create_label" id="l1">
            <value name="TEXT"><block type="text"><field name="TEXT">Press R for nitro</field></block></value>
            <field name="NAME">hint</field>
            <next>
              <block type="ui_create_button" id="b1">
                <value name="LABEL"><block type="text"><field name="TEXT">Reset save</field></block></value>
                <field name="NAME">resetBtn</field>
                <statement name="DO">
                  <block type="storage_clear" id="sc1"></block>
                </statement>
              </block>
            </next>
          </block>
        </next>
      </block>
    </statement>
  </block>
  <block type="event_on_key" id="k1" x="20" y="260">
    <field name="KEY">KeyR</field>
    <statement name="DO">
      <block type="action_boost" id="bs1">
        <value name="AMOUNT"><block type="math_number"><field name="NUM">12</field></block></value>
        <next>
          <block type="action_spawn_particle_burst" id="pb1">
            <value name="SECS"><block type="math_number"><field name="NUM">0.6</field></block></value>
            <next>
              <block type="storage_set_num" id="ss1">
                <value name="KEY"><block type="text"><field name="TEXT">nitroUses</field></block></value>
                <value name="VALUE"><block type="math_arithmetic"><field name="OP">ADD</field><value name="A"><block type="storage_get"><value name="KEY"><block type="text"><field name="TEXT">nitroUses</field></block></value><value name="DEFAULT"><block type="math_number"><field name="NUM">0</field></block></value></block></value><value name="B"><block type="math_number"><field name="NUM">1</field></block></value></block></value>
              </block>
            </next>
          </block>
        </next>
      </block>
    </statement>
  </block>
  <block type="event_on_tick" id="t1" x="20" y="440">
    <statement name="DO">
      <block type="ui_set_text" id="ut1">
        <field name="NAME">hint</field>
        <value name="TEXT"><block type="text_combine"><value name="A"><block type="text"><field name="TEXT">Nitro uses: </field></block></value><value name="B"><block type="storage_get"><value name="KEY"><block type="text"><field name="TEXT">nitroUses</field></block></value><value name="DEFAULT"><block type="math_number"><field name="NUM">0</field></block></value></block></value></block></value>
      </block>
    </statement>
  </block>
</xml>`,
};

document.getElementById( 'load-sample' )?.addEventListener( 'click', () => {
	try {
		document.getElementById( 'mod-id' ).value = SAMPLE_MOD.modId;
		document.getElementById( 'mod-name' ).value = SAMPLE_MOD.modName;
		loadXmlText( SAMPLE_MOD.xml );
		document.getElementById( 'xmlBox' ).value = SAMPLE_MOD.xml;
		setStatus( `Loaded sample "${ SAMPLE_MOD.modName }" — tweak it, then Save to Mod Manager` );
	} catch ( e ) {
		setStatus( 'Could not load sample mod' );
	}
} );


// Auto-load shared mod from URL, or restore last draft.
const shareParam = new URLSearchParams( location.search ).get( 'share' );
if ( shareParam ) {
	try { applySharePayload( JSON.parse( fromBase64Url( shareParam ) ) ); setStatus( 'Loaded shared mod from URL' ); }
	catch { setStatus( 'Invalid shared URL payload' ); }
} else {
	const raw = localStorage.getItem( DRAFT_KEY );
	if ( raw ) {
		try {
			const p = JSON.parse( raw );
			document.getElementById( 'mod-id' ).value = p.modId || document.getElementById( 'mod-id' ).value;
			document.getElementById( 'mod-name' ).value = p.modName || document.getElementById( 'mod-name' ).value;
			if ( p.xml ) loadXmlText( p.xml );
			setStatus( 'Restored last draft' );
		} catch { setStatus( 'Workspace loaded' ); }
	} else setStatus( 'Workspace loaded' );
}
