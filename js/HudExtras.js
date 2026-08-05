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
			<div id="speedo-label">SPD</div>
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
					position: absolute; bottom: 16px; right: 148px; z-index: 10;
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

		const speed = Math.abs( this.vehicle.linearSpeed || 0 );
		const topSpeed = Math.max( 0.01, this.vehicle.topSpeed || 1 );
		const ratio = Math.min( 1.8, speed / topSpeed );
		const ratioClamped = Math.min( 1, ratio );

		// Update number (display as integer "speed units")
		if ( this.speedoNumEl ) {
			this.speedoNumEl.textContent = Math.round( speed * 100 );
		}

		// Update arc (263.9 = 2 * PI * 42)
		if ( this.speedoArcEl ) {
			const circumference = 263.9;
			const offset = circumference * ( 1 - ratioClamped );
			this.speedoArcEl.style.strokeDashoffset = offset.toFixed( 1 );

			// Color shift: green → yellow → orange at high speed
			if ( ratio > 1.2 ) {
				this.speedoArcEl.style.stroke = '#ff9f1c';
			} else if ( ratio > 0.85 ) {
				this.speedoArcEl.style.stroke = '#ffd95a';
			} else {
				this.speedoArcEl.style.stroke = '#77f3b1';
			}
		}
	}

	showSpeedometer( show ) {
		if ( this.speedoEl ) {
			this.speedoEl.classList.toggle( 'visible', show );
		}
	}

	// ─── Minimap ───────────────────────────────────────────────

	_buildMinimap() {

		const canvas = document.createElement( 'canvas' );
		canvas.id = 'minimap-hud';
		canvas.width = 120;
		canvas.height = 120;
		canvas.setAttribute( 'aria-hidden', 'true' );
		document.body.appendChild( canvas );
		this.minimapCanvas = canvas;
		this.minimapCtx = canvas.getContext( '2d' );

		if ( ! document.getElementById( 'minimap-css' ) ) {
			const css = document.createElement( 'style' );
			css.id = 'minimap-css';
			css.textContent = `
				#minimap-hud {
					position: absolute; bottom: 12px; right: 16px; z-index: 9;
					display: none; border-radius: 10px;
					background: rgba(6,12,22,0.62);
					border: 1px solid rgba(255,255,255,0.14);
					pointer-events: none;
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

		if ( ! this.cells || this.cells.length === 0 ) {
			this.minimapBounds = { minX: -5, maxX: 5, minZ: -5, maxZ: 5 };
			return;
		}

		let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
		for ( const [ gx, gz ] of this.cells ) {
			minX = Math.min( minX, gx );
			maxX = Math.max( maxX, gx );
			minZ = Math.min( minZ, gz );
			maxZ = Math.max( maxZ, gz );
		}
		// Add 1 cell of padding
		minX -= 1; maxX += 1; minZ -= 1; maxZ += 1;
		this.minimapBounds = { minX, maxX, minZ, maxZ };
	}

	updateMinimap() {

		if ( ! this.minimapCanvas || ! this.minimapCtx || ! this.vehicle ) return;

		const ctx = this.minimapCtx;
		const W = 120, H = 120;
		const b = this.minimapBounds;
		const gridW = b.maxX - b.minX;
		const gridH = b.maxZ - b.minZ;
		const scale = Math.min( W, H ) / Math.max( gridW, gridH );

		ctx.clearRect( 0, 0, W, H );

		// Draw cells
		for ( const [ gx, gz, type ] of this.cells ) {
			const x = ( gx - b.minX ) * scale;
			const y = ( gz - b.minZ ) * scale;
			const s = scale;

			if ( type === 'track-finish' || type === 'track-start-finish' ) {
				ctx.fillStyle = 'rgba(119,243,177,0.85)';
			} else if ( type === 'track-checkpoint' || type === 'track-start' ) {
				ctx.fillStyle = 'rgba(90,200,255,0.6)';
			} else {
				ctx.fillStyle = 'rgba(255,255,255,0.18)';
			}

			ctx.fillRect( x, y, s, s );
		}

		// Draw player position
		if ( this.vehicle.spherePos ) {
			const pos = this.vehicle.spherePos;
			// Convert world position to grid coords (inverse of cell → world transform)
			// World: x = (gx + 0.5) * CELL_RAW * GRID_SCALE, z = (gz + 0.5) * CELL_RAW * GRID_SCALE
			// So: gx = x / (CELL_RAW * GRID_SCALE) - 0.5
			const CELL_WORLD = 6 * 0.75; // CELL_RAW * GRID_SCALE = 6 * 0.75 = 4.5
			const playerGx = pos.x / CELL_WORLD - 0.5;
			const playerGz = pos.z / CELL_WORLD - 0.5;

			const px = ( playerGx - b.minX ) * scale + scale * 0.5;
			const py = ( playerGz - b.minZ ) * scale + scale * 0.5;

			// Player dot
			ctx.beginPath();
			ctx.arc( px, py, 3.5, 0, Math.PI * 2 );
			ctx.fillStyle = '#77f3b1';
			ctx.fill();
			ctx.strokeStyle = 'rgba(255,255,255,0.9)';
			ctx.lineWidth = 1.5;
			ctx.stroke();
		}
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
