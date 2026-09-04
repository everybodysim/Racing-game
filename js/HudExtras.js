import { CELL_RAW, GRID_SCALE } from './Track.js';

/**
 * HudExtras.js — Speedometer, minimap, and keyboard shortcuts overlay.
 * Imported by main.js during init. All three features are pure HUD overlays
 * with zero impact on gameplay physics or track logic.
 */

export class HudExtras {

	/**
	 * @param {object} opts
	 * @param {THREE.Scene} opts.scene
	 * @param {object} opts.vehicle  – player vehicle (has .linearSpeed, .topSpeed, .spherePos)
	 * @param {Array}    opts.cells  – active track cells (customCells || TRACK_CELLS)
	 * @param {object}   opts.camera  – THREE.Camera for projecting player position
	 */
	constructor( opts = {} ) {

		this.vehicle = opts.vehicle;
		this.cells = opts.cells || [];
		this.camera = opts.camera;

		// Speedometer
		this.speedoEl = null;
		this.speedoNumEl = null;
		this.speedoRingEl = null;
		this.speedoLabelEl = null;
		this._lastSpeedoNum = - 1;
		this._lastSpeedoOffset = '';
		this._lastSpeedoStroke = '';

		// Minimap
		this.minimapCanvas = null;
		this.minimapCtx = null;
		this.minimapBounds = null; // {minX, maxX, minZ, maxZ} in cell grid coords

		// Shortcuts overlay
		this.shortcutsEl = null;
		this.shortcutsOpen = false;

		this._buildSpeedometer();
		this._buildMinimap();
		this._buildShortcuts();

		// Compute minimap bounds once
		this._computeMinimapBounds();

	}

	// ─── Speedometer ───────────────────────────────────────────

	_buildSpeedometer() {

		const el = document.createElement( 'div' );
		el.id = 'speedo-hud';
		el.setAttribute( 'aria-hidden', 'true' );
		el.innerHTML = `
			<div id="speedo-ring">
				<svg viewBox="0 0 100 100" width="64" height="64">
					<circle cx="50" cy="50" r="42" fill="none" stroke="rgba(255,255,255,0.12)" stroke-width="6"/>
					<circle id="speedo-arc" cx="50" cy="50" r="42" fill="none"
						stroke="#77f3b1" stroke-width="6" stroke-linecap="round"
						stroke-dasharray="263.9" stroke-dashoffset="263.9"
						transform="rotate(-90 50 50)"
						style="transition: stroke-dashoffset 0.08s linear, stroke 0.2s ease;"/>
				</svg>
				<div id="speedo-num">0</div>
			</div>
			<div id="speedo-label">MPH</div>
		`;
		document.body.appendChild( el );
		this.speedoEl = el;
		this.speedoNumEl = el.querySelector( '#speedo-num' );
		this.speedoArcEl = el.querySelector( '#speedo-arc' );
		this.speedoLabelEl = el.querySelector( '#speedo-label' );

		// Inject CSS once
		if ( ! document.getElementById( 'speedo-css' ) ) {
			const css = document.createElement( 'style' );
			css.id = 'speedo-css';
			css.textContent = `
				#speedo-hud {
					position: absolute; bottom: 20px; right: 168px; z-index: 10;
					display: none; flex-direction: column; align-items: center; gap: 2px;
					pointer-events: none;
				}
				#speedo-hud.visible { display: flex; }
				#speedo-ring {
					position: relative; width: 64px; height: 64px;
					display: flex; align-items: center; justify-content: center;
				}
				#speedo-ring svg { position: absolute; top: 0; left: 0; }
				#speedo-num {
					font: 800 18px/1 sans-serif; color: #fff;
					text-shadow: 0 1px 4px rgba(0,0,0,0.7);
					z-index: 1;
				}
				#speedo-label {
					font: 700 9px/1 sans-serif; color: #b5c2da;
					letter-spacing: 0.12em; text-transform: uppercase;
					text-shadow: 0 1px 3px rgba(0,0,0,0.7);
				}
				@media (pointer: coarse) {
					#speedo-hud { display: none !important; }
				}
			`;
			document.head.appendChild( css );
		}
	}

	updateSpeedometer() {

		if ( ! this.speedoEl || ! this.vehicle ) return;

		// ── Real physical speed ──
		// modelVelocity is the actual world-space velocity vector (world units / sec).
		// We take its magnitude and convert to MPH using the track's world scale:
		//   cellWorld = CELL_RAW * GRID_SCALE = 9.99 * 0.75 = 7.4925 world units per cell
		//   Assuming each cell ≈ 10 meters (a standard road tile width):
		//   meters per world unit = 10 / cellWorld
		//   MPH = (world_units/sec) * (10 / cellWorld) * 2.23694
		const cellWorld = CELL_RAW * GRID_SCALE; // 7.4925
		const METERS_PER_CELL = 10;
		const MS_TO_MPH = 2.23694;
		const MPH_FACTOR = ( METERS_PER_CELL / cellWorld ) * MS_TO_MPH; // ≈ 2.985

		// Use actual measured velocity, fall back to sphereVel if modelVelocity is zero
		let worldSpeed = 0;
		if ( this.vehicle.modelVelocity ) {
			worldSpeed = this.vehicle.modelVelocity.length();
		} else if ( this.vehicle.sphereVel ) {
			worldSpeed = this.vehicle.sphereVel.length();
		}

		const mph = worldSpeed * MPH_FACTOR;

		// Arc max: ~70 MPH covers normal top speed (~42) and boost (~67)
		const MAX_MPH = 70;
		const ratio = Math.min( 1, mph / MAX_MPH );

		// Update number (display as integer MPH) only when it changes — avoids a
		// textContent write + layout every frame at constant speed.
		if ( this.speedoNumEl ) {
			const num = Math.round( mph );
			if ( num !== this._lastSpeedoNum ) {
				this.speedoNumEl.textContent = num;
				this._lastSpeedoNum = num;
			}
		}

		// Update arc (263.9 = 2 * PI * 42)
		if ( this.speedoArcEl ) {
			const circumference = 263.9;
			const offset = circumference * ( 1 - ratio );
			const offsetStr = offset.toFixed( 1 );
			if ( offsetStr !== this._lastSpeedoOffset ) {
				this.speedoArcEl.style.strokeDashoffset = offsetStr;
				this._lastSpeedoOffset = offsetStr;
			}

			// Color shift: green → yellow → orange at high speed
			const stroke = mph > 55 ? '#ff9f1c' : ( mph > 35 ? '#ffd95a' : '#77f3b1' );
			if ( stroke !== this._lastSpeedoStroke ) {
				this.speedoArcEl.style.stroke = stroke;
				this._lastSpeedoStroke = stroke;
			}
		}
	}

	showSpeedometer( show ) {
		if ( this.speedoEl ) {
			this.speedoEl.classList.toggle( 'visible', show );
		}
	}

	// ─── Minimap (player-centered, rotating) ───────────────────

	_buildMinimap() {

		const canvas = document.createElement( 'canvas' );
		canvas.id = 'minimap-hud';
		canvas.width = 140;
		canvas.height = 140;
		canvas.setAttribute( 'aria-hidden', 'true' );
		document.body.appendChild( canvas );
		this.minimapCanvas = canvas;
		this.minimapCtx = canvas.getContext( '2d' );

		// World units per cell — correct constant from Track.js
		this.cellWorld = CELL_RAW * GRID_SCALE;
		// How many cells of radius to show around the player
		this.minimapRadius = 7;

		if ( ! document.getElementById( 'minimap-css' ) ) {
			const css = document.createElement( 'style' );
			css.id = 'minimap-css';
			css.textContent = `
				#minimap-hud {
					position: absolute; bottom: 12px; right: 16px; z-index: 9;
					display: none; border-radius: 12px;
					background: rgba(6,12,22,0.72);
					border: 1px solid rgba(255,255,255,0.18);
					pointer-events: none;
					box-shadow: 0 4px 16px rgba(0,0,0,0.4);
				}
				#minimap-hud.visible { display: block; }
				@media (pointer: coarse) {
					#minimap-hud { display: none !important; }
				}
				@media (max-width: 760px) {
					#minimap-hud { display: none !important; }
				}
			`;
			document.head.appendChild( css );
		}
	}

	_computeMinimapBounds() {
		// No longer used — minimap is player-centered now.
		// Kept as no-op for backwards compat.
		this.minimapBounds = null;
	}

	updateMinimap() {

		if ( ! this.minimapCanvas || ! this.minimapCtx || ! this.vehicle ) return;
		if ( ! this.vehicle.spherePos ) return;

		const ctx = this.minimapCtx;
		const W = this.minimapCanvas.width;   // 140
		const H = this.minimapCanvas.height;  // 140
		const cx = W / 2;
		const cy = H / 2;

		// World position of player
		const px = this.vehicle.spherePos.x;
		const pz = this.vehicle.spherePos.z;

		// Player heading: forward vector from container quaternion
		let headingAngle = 0;
		if ( this.vehicle.container ) {
			// Forward = (0, 0, 1) applied to container quaternion, flattened to XZ
			const q = this.vehicle.container.quaternion;
			// Apply quaternion to (0,0,1): forward = (2*(qx*qz + qw*qy), ..., 1 - 2*(qx^2 + qy^2))
			// We only need x and z components for 2D heading
			const fx = 2 * ( q.x * q.z + q.w * q.y );
			const fz = 1 - 2 * ( q.x * q.x + q.y * q.y );
			headingAngle = Math.atan2( fx, fz );
		}

		// Scale: pixels per world unit
		const worldRadius = this.minimapRadius * this.cellWorld;
		const scale = ( Math.min( W, H ) / 2 ) / worldRadius;

		// Clear
		ctx.clearRect( 0, 0, W, H );

		// Save context, translate to center, rotate so player heading is "up"
		ctx.save();
		ctx.translate( cx, cy );
		// Rotate so the player's forward direction points up on the minimap.
		// In canvas, "up" is -Y. The player's heading angle is measured from +Z.
		// We want to rotate by -headingAngle so that heading direction maps to -Y (up).
		ctx.rotate( -headingAngle );

		// Draw track cells relative to player position
		for ( const [ gx, gz, type ] of this.cells ) {
			// Cell center in world coords
			const cellX = ( gx + 0.5 ) * this.cellWorld;
			const cellZ = ( gz + 0.5 ) * this.cellWorld;

			// Relative to player
			const dx = cellX - px;
			const dz = cellZ - pz;

			// Cull cells outside the minimap view radius
			if ( Math.abs( dx ) > worldRadius || Math.abs( dz ) > worldRadius ) continue;

			// Convert to minimap coords (canvas Y is flipped: -Z is up)
			const mx = dx * scale;
			const my = -dz * scale;  // flip Z so north = up
			const ms = this.cellWorld * scale;

			if ( type === 'track-finish' || type === 'track-start-finish' ) {
				ctx.fillStyle = 'rgba(119,243,177,0.85)';
			} else if ( type === 'track-checkpoint' || type === 'track-start' ) {
				ctx.fillStyle = 'rgba(90,200,255,0.6)';
			} else {
				ctx.fillStyle = 'rgba(255,255,255,0.18)';
			}

			ctx.fillRect( mx - ms / 2, my - ms / 2, ms, ms );
		}

		ctx.restore();

		// Draw player arrow at center (always pointing up)
		ctx.save();
		ctx.translate( cx, cy );
		ctx.fillStyle = '#77f3b1';
		ctx.strokeStyle = 'rgba(255,255,255,0.95)';
		ctx.lineWidth = 1.5;
		ctx.beginPath();
		// Triangle pointing up
		ctx.moveTo( 0, -7 );    // tip
		ctx.lineTo( 5, 5 );     // bottom right
		ctx.lineTo( -5, 5 );    // bottom left
		ctx.closePath();
		ctx.fill();
		ctx.stroke();
		ctx.restore();
	}

	showMinimap( show ) {
		if ( this.minimapCanvas ) {
			this.minimapCanvas.classList.toggle( 'visible', show );
		}
	}

	// ─── Keyboard Shortcuts Overlay ────────────────────────────

	_buildShortcuts() {

		const el = document.createElement( 'div' );
		el.id = 'shortcuts-overlay';
		el.setAttribute( 'role', 'dialog' );
		el.setAttribute( 'aria-label', 'Keyboard shortcuts' );
		el.style.display = 'none';
		el.innerHTML = `
			<div id="shortcuts-card" onclick="event.stopPropagation()">
				<div id="shortcuts-header">
					<h2>Keyboard Shortcuts</h2>
					<button id="shortcuts-close" type="button" aria-label="Close">✕</button>
				</div>
				<div id="shortcuts-grid">
					<div class="sc-section">
						<div class="sc-section-title">Driving</div>
						<div class="sc-row"><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd><span>or arrows — drive</span></div>
						<div class="sc-row"><kbd>X</kbd><span>Boost (arcade mode)</span></div>
						<div class="sc-row"><kbd>Space</kbd><span>Honk the horn</span></div>
						<div class="sc-row"><kbd>R</kbd><span>Respawn / reset</span></div>
						<div class="sc-row"><kbd>T</kbd><span>Checkpoint respawn (mod)</span></div>
						<div class="sc-row"><kbd>Y</kbd><span>Save practice state (mod)</span></div>
						<div class="sc-row"><kbd>Shift</kbd><kbd>Y</kbd><span>Restore practice state (mod)</span></div>
					</div>
					<div class="sc-section">
						<div class="sc-section-title">Camera &amp; UI</div>
						<div class="sc-row"><kbd>C</kbd><span>Toggle camera (chase / overview)</span></div>
						<div class="sc-row"><kbd>F</kbd><span>Freecam (mod)</span></div>
						<div class="sc-row"><kbd>H</kbd><span>Hide / show UI</span></div>
						<div class="sc-row"><kbd>?</kbd><span>This help overlay</span></div>
						<div class="sc-row"><kbd>Esc</kbd><span>Pause / close menus</span></div>
					</div>
					<div class="sc-section">
						<div class="sc-section-title">Menus &amp; Modes</div>
						<div class="sc-row"><kbd>E</kbd><span>Game menu (modes, garage, account)</span></div>
						<div class="sc-row"><kbd>P</kbd><span>Split-screen P2 respawn</span></div>
						<div class="sc-row"><kbd>V</kbd><span>Instant stop (hacks)</span></div>
						<div class="sc-row"><kbd>B</kbd><span>Boost anywhere (hacks)</span></div>
						<div class="sc-row"><kbd>Touch</kbd><span>Steer left, gas &amp; brake on mobile</span></div>
					</div>
				</div>
				<div id="shortcuts-footer">Press <kbd>?</kbd> or <kbd>Esc</kbd> to close</div>
			</div>
		`;
		document.body.appendChild( el );
		this.shortcutsEl = el;

		// Close handlers
		el.querySelector( '#shortcuts-close' ).addEventListener( 'click', () => this.toggleShortcuts( false ) );
		el.addEventListener( 'click', () => this.toggleShortcuts( false ) );

		// Inject CSS once
		if ( ! document.getElementById( 'shortcuts-css' ) ) {
			const css = document.createElement( 'style' );
			css.id = 'shortcuts-css';
			css.textContent = `
				#shortcuts-overlay {
					position: fixed; inset: 0; z-index: 200;
					display: none; align-items: center; justify-content: center;
					background: rgba(4,8,16,0.7);
					backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px);
					animation: sc-fade-in 0.15s ease;
				}
				#shortcuts-overlay.visible { display: flex; }
				@keyframes sc-fade-in { from { opacity: 0; } to { opacity: 1; } }
				#shortcuts-card {
					width: min(640px, calc(100vw - 32px));
					max-height: calc(100vh - 48px);
					overflow-y: auto;
					background: rgba(10,16,28,0.95);
					border: 1px solid rgba(255,255,255,0.2);
					border-radius: 18px;
					padding: 22px 24px;
					box-shadow: 0 20px 60px rgba(0,0,0,0.5);
					color: #e6edf7; font: 600 14px/1.5 Inter, system-ui, sans-serif;
					animation: sc-slide-up 0.2s ease;
				}
				@keyframes sc-slide-up { from { transform: translateY(20px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
				#shortcuts-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px; }
				#shortcuts-header h2 { margin: 0; font: 800 22px/1 Inter, system-ui, sans-serif; letter-spacing: 0.02em; }
				#shortcuts-close {
					background: rgba(255,255,255,0.1); border: 1px solid rgba(255,255,255,0.18);
					color: #fff; border-radius: 10px; width: 34px; height: 34px;
					font-size: 16px; cursor: pointer; display: flex; align-items: center; justify-content: center;
					transition: background 0.12s ease;
				}
				#shortcuts-close:hover { background: rgba(255,255,255,0.2); }
				#shortcuts-grid { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 18px; }
				@media (max-width: 600px) { #shortcuts-grid { grid-template-columns: 1fr; gap: 14px; } }
				.sc-section-title {
					font: 800 11px sans-serif; color: #77f3b1;
					text-transform: uppercase; letter-spacing: 0.12em;
					margin-bottom: 8px; padding-bottom: 6px;
					border-bottom: 1px solid rgba(255,255,255,0.1);
				}
				.sc-row { display: flex; align-items: center; gap: 6px; margin-bottom: 7px; flex-wrap: wrap; }
				.sc-row span { color: #b5c2da; font-size: 13px; margin-left: 2px; }
				kbd {
					display: inline-block; min-width: 28px; padding: 3px 7px;
					background: rgba(255,255,255,0.1); border: 1px solid rgba(255,255,255,0.22);
					border-radius: 6px; font: 700 11px/1 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
					color: #e6edf7; text-align: center; white-space: nowrap;
				}
				#shortcuts-footer { margin-top: 16px; text-align: center; color: #6b7a94; font-size: 12px; }
				#shortcuts-footer kbd { font-size: 10px; }
			`;
			document.head.appendChild( css );
		}
	}

	toggleShortcuts( force ) {
		this.shortcutsOpen = ( force === undefined ) ? ! this.shortcutsOpen : force;
		if ( this.shortcutsEl ) {
			this.shortcutsEl.classList.toggle( 'visible', this.shortcutsOpen );
			this.shortcutsEl.style.display = this.shortcutsOpen ? 'flex' : 'none';
		}
	}

	// ─── Combined update (called from game loop) ───────────────

	update() {
		this.updateSpeedometer();
		this.updateMinimap();
	}

	setVisible( visible ) {
		this.showSpeedometer( visible );
		this.showMinimap( visible );
	}

}
