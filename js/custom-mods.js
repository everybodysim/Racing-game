// Custom Mods Lab — block definitions, parser, and runtime template generator.
// Keeps the visual editor compact while exposing a rich, safe modding surface.

const DRAFT_KEY = 'racing-custom-mods-workspace-v3';
const SHARED_KEY = 'racing-shared-custom-mods-v1';

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
Blockly.Blocks.controls_if = { init() { this.appendValueInput( 'IF0' ).setCheck( 'Boolean' ).appendField( 'if' ); this.appendStatementInput( 'DO0' ).appendField( 'then' ); this.setPreviousStatement( true ); this.setNextStatement( true ); this.setColour( LOGIC ); } };
Blockly.Blocks.controls_if_else = { init() { this.appendValueInput( 'IF0' ).setCheck( 'Boolean' ).appendField( 'if' ); this.appendStatementInput( 'DO0' ).appendField( 'then' ); this.appendStatementInput( 'ELSE' ).appendField( 'else' ); this.setPreviousStatement( true ); this.setNextStatement( true ); this.setColour( LOGIC ); } };
Blockly.Blocks.logic_compare = { init() { this.appendValueInput( 'A' ).appendField( '' ); this.appendValueInput( 'B' ).appendField( new Blockly.FieldDropdown( [ [ '=', 'EQ' ], [ '≠', 'NEQ' ], [ '<', 'LT' ], [ '≤', 'LTE' ], [ '>', 'GT' ], [ '≥', 'GTE' ] ] ), 'OP' ); this.setInputsInline( true ); this.setOutput( true, 'Boolean' ); this.setColour( LOGIC ); } };
Blockly.Blocks.logic_operation = { init() { this.appendValueInput( 'A' ).setCheck( 'Boolean' ); this.appendValueInput( 'B' ).setCheck( 'Boolean' ).appendField( new Blockly.FieldDropdown( [ [ 'and', 'AND' ], [ 'or', 'OR' ] ] ), 'OP' ); this.setInputsInline( true ); this.setOutput( true, 'Boolean' ); this.setColour( LOGIC ); } };
Blockly.Blocks.logic_negate = { init() { this.appendValueInput( 'BOOL' ).setCheck( 'Boolean' ).appendField( 'not' ); this.setOutput( true, 'Boolean' ); this.setColour( LOGIC ); } };
Blockly.Blocks.logic_is_airborne = { init() { this.appendDummyInput().appendField( 'is airborne' ); this.setOutput( true, 'Boolean' ); this.setColour( LOGIC ); } };
Blockly.Blocks.logic_is_drifting = { init() { this.appendDummyInput().appendField( 'is drifting' ); this.setOutput( true, 'Boolean' ); this.setColour( LOGIC ); } };
Blockly.Blocks.logic_key_down = { init() { this.appendDummyInput().appendField( 'key' ).appendField( new Blockly.FieldDropdown( [ [ 'W', 'KeyW' ], [ 'A', 'KeyA' ], [ 'S', 'KeyS' ], [ 'D', 'KeyD' ], [ 'Space', 'Space' ], [ 'X', 'KeyX' ] ] ), 'KEY' ).appendField( 'is down' ); this.setOutput( true, 'Boolean' ); this.setColour( LOGIC ); } };

// ============ TEXT ============
Blockly.Blocks.text = { init() { this.appendDummyInput().appendField( new Blockly.FieldTextInput( '' ), 'TEXT' ); this.setOutput( true, 'String' ); this.setColour( TXT ); } };
Blockly.Blocks.text_join = { init() { this.appendValueInput( 'A' ).setCheck( [ 'String', 'Number' ] ).appendField( 'join' ); this.appendValueInput( 'B' ).setCheck( [ 'String', 'Number' ] ).appendField( 'with' ); this.setInputsInline( true ); this.setOutput( true, 'String' ); this.setColour( TXT ); } };
Blockly.Blocks.text_to_string = { init() { this.appendValueInput( 'VALUE' ).appendField( 'to text' ); this.setOutput( true, 'String' ); this.setColour( TXT ); } };
Blockly.Blocks.text_round_num = { init() { this.appendValueInput( 'VALUE' ).setCheck( 'Number' ).appendField( 'round' ).appendField( new Blockly.FieldNumber( 0, 0, 10 ), 'PLACES' ).appendField( 'places' ); this.setInputsInline( true ); this.setOutput( true, 'String' ); this.setColour( TXT ); } };

// ============ LISTS ============
Blockly.Blocks.lists_create = { init() { this.appendDummyInput().appendField( 'create list' ); this.setOutput( true, 'Array' ); this.setColour( LIST ); } };
Blockly.Blocks.lists_length = { init() { this.appendValueInput( 'LIST' ).setCheck( 'Array' ).appendField( 'length of' ); this.setOutput( true, 'Number' ); this.setColour( LIST ); } };

// Register built-in Blockly blocks that may be missing in the min build.
if ( ! Blockly.Blocks.math_number ) Blockly.Blocks.math_number = { init() { this.appendDummyInput().appendField( new Blockly.FieldNumber( 0 ), 'NUM' ); this.setOutput( true, 'Number' ); this.setColour( MATH ); } };

// ============ WORKSPACE ============
const workspace = Blockly.inject( 'blocklyDiv', { toolbox: document.getElementById( 'toolbox' ), trashcan: true, zoom: { controls: true, wheel: true, startScale: 0.95 } } );
const textToDom = ( text ) => ( Blockly.utils?.xml?.textToDom ? Blockly.utils.xml.textToDom( text ) : Blockly.Xml.textToDom( text ) );
function exportXmlPretty() { return Blockly.Xml.domToPrettyText( Blockly.Xml.workspaceToDom( workspace ) ); }
function loadXmlText( text ) { Blockly.Xml.clearWorkspaceAndLoadFromXml( textToDom( text ), workspace ); }

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
	if ( type === 'text_join' ) return { kind: 'join', a: parseValueBlock( block.getInputTargetBlock( 'A' ) ) ?? '', b: parseValueBlock( block.getInputTargetBlock( 'B' ) ) ?? '' };
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
		onStart: [], onTick: [], onKey: {}, onKeyHold: {}, onCheckpoint: [], onCrash: [], onLapFinish: [], onRespawn: [], onTimerDone: {},
		onSpeedThreshold: [], onLowSpeed: [], onAir: [], onGround: [], onDrift: [],
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
		else if ( block.type === 'event_on_timer_done' ) { const id = safeId( block.getFieldValue( 'ID' ) || 'timer1' ); spec.onTimerDone[ id ] = [ ...( spec.onTimerDone[ id ] || [] ), ...chain ]; }
		else if ( block.type === 'event_on_speed_threshold' ) spec.onSpeedThreshold.push( { threshold: parseValueBlock( block.getInputTargetBlock( 'SPEED' ) ) ?? 0, body: chain } );
		else if ( block.type === 'event_on_low_speed' ) spec.onLowSpeed.push( { threshold: parseValueBlock( block.getInputTargetBlock( 'SPEED' ) ) ?? 0, body: chain } );
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
      }
    }
    if ( k === 'var' ) return Number( ctx.state.vars[ value.name ] ) || 0;
    if ( k === 'textvar' ) return String( ctx.state.textvars[ value.name ] ?? '' );
    if ( k === 'const' ) return value.value;
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
  }
  return value;
}
function runActions( actions, ctx, event ) {
  event = event || {};
  const api = ( ctx && ctx.api ) || {};
  if ( ! ctx.state ) ctx.state = { vars: {}, textvars: {}, timers: [], waits: [] };
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
    }
  }
}
`;
}

function generateTemplate() {
	const id = safeId( document.getElementById( 'mod-id' )?.value ) || `custom-${ Date.now() }`;
	const name = ( document.getElementById( 'mod-name' )?.value || 'Custom Mod' ).trim();
	const spec = buildRuntimeSpec();
	return `// ${ name }\nconst SPEC = ${ JSON.stringify( spec, null, 2 ) };\n${ renderActionsRuntimeCode() }\nexport default {\n  id: ${ JSON.stringify( id ) },\n  init( context ) { this.ctx = context; this.state = { vars: {}, textvars: {}, timers: [], waits: [] }; this.keyLatch = Object.create( null ); this.wasAirborne = false; this.wasDrifting = false; runActions( SPEC.onStart, this.ctx, { type: 'start' } ); },\n  applyFrame( { controls, vehicle, world, dt, now } ) { const ctx = this.ctx || { vehicle, world, controls }; ctx.state = this.state; const st = ( typeof ctx.getState === 'function' ) ? ctx.getState() : {}; const ev = { type: 'tick', dt, now, airborne: Boolean( st.airborne ), lapTime: st.lapTime, raceTime: st.raceTime };\n    runActions( SPEC.onTick, ctx, ev );\n    for ( const [ key, actions ] of Object.entries( SPEC.onKey || {} ) ) { const down = Boolean( controls && controls.keys && controls.keys[ key ] ); if ( down && ! this.keyLatch[ key ] ) runActions( actions, ctx, { type: 'key', key, dt, now } ); this.keyLatch[ key ] = down; }\n    for ( const [ key, actions ] of Object.entries( SPEC.onKeyHold || {} ) ) { if ( controls && controls.keys && controls.keys[ key ] ) runActions( actions, ctx, { type: 'keyhold', key, dt, now } ); }\n    const speed = Math.abs( Number( st.linearSpeed ) || 0 ); for ( const t of ( SPEC.onSpeedThreshold || [] ) ) { const th = Number( resolveValue( t.threshold, ctx, ev ) ) || 0; if ( speed > th ) runActions( t.body, ctx, { type: 'speed_threshold', speed, threshold: th, dt, now } ); } for ( const t of ( SPEC.onLowSpeed || [] ) ) { const th = Number( resolveValue( t.threshold, ctx, ev ) ) || 0; if ( speed < th ) runActions( t.body, ctx, { type: 'low_speed', speed, threshold: th, dt, now } ); }\n    const airborne = Boolean( ev.airborne ); if ( airborne && ! this.wasAirborne ) runActions( SPEC.onAir, ctx, { type: 'air', dt, now } ); if ( ! airborne && this.wasAirborne ) runActions( SPEC.onGround, ctx, { type: 'ground', dt, now } ); this.wasAirborne = airborne;\n    const drifting = Boolean( st.driftIntensity && st.driftIntensity > 0.6 ); if ( drifting && ! this.wasDrifting ) runActions( SPEC.onDrift, ctx, { type: 'drift', dt, now } ); this.wasDrifting = drifting;\n    if ( Array.isArray( this.state.timers ) ) { for ( const t of this.state.timers ) t.remaining -= dt; const done = this.state.timers.filter( ( t ) => t.remaining <= 0 ); this.state.timers = this.state.timers.filter( ( t ) => t.remaining > 0 ); for ( const t of done ) runActions( ( SPEC.onTimerDone && SPEC.onTimerDone[ t.id ] ) || [], ctx, { type: 'timer_done', id: t.id, now } ); }\n    return null;\n  },\n  onCheckpoint( event ) { runActions( SPEC.onCheckpoint, this.ctx, { type: 'checkpoint', ...( event || {} ) } ); },\n  onCrash( event ) { runActions( SPEC.onCrash, this.ctx, { type: 'crash', ...( event || {} ) } ); },\n  onRespawn( event ) { runActions( SPEC.onRespawn, this.ctx, { type: 'respawn', ...( event || {} ) } ); },\n  onLapFinish( event ) { runActions( SPEC.onLapFinish, this.ctx, { type: 'lapFinish', ...( event || {} ) } ); },\n  dispose() { this.ctx = null; this.state = null; this.keyLatch = Object.create( null ); }\n};\n`;
}

// ============ SHARING ============
function toBase64Url( str ) { const bytes = new TextEncoder().encode( str ); let bin = ''; bytes.forEach( ( b ) => { bin += String.fromCharCode( b ); } ); return btoa( bin ).replace( /\+/g, '-' ).replace( /\//g, '_' ).replace( /=+$/g, '' ); }
function fromBase64Url( raw ) { const norm = String( raw || '' ).replace( /-/g, '+' ).replace( /_/g, '/' ); const padded = norm + '==='.slice( ( norm.length + 3 ) % 4 ); const bin = atob( padded ); const bytes = Uint8Array.from( bin, ( c ) => c.charCodeAt( 0 ) ); return new TextDecoder().decode( bytes ); }

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
	const payload = getSharePayload();
	const arr = JSON.parse( localStorage.getItem( SHARED_KEY ) || '[]' ).filter( ( x ) => x.modId !== payload.modId );
	arr.push( payload );
	localStorage.setItem( SHARED_KEY, JSON.stringify( arr ) );
	setStatus( `Saved "${ payload.modName }" to Mod Manager — install it from the Mods page` );
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
