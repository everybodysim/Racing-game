// Customizable HUD widget grid.
// Layout = 4 rows of widgets. Players add/remove/reorder widgets and the
// arrangement is persisted to localStorage and to the cloud profile snapshot.

const HUD_LAYOUT_KEY = 'racing-hud-layout-v2';
const HUD_NUM_ROWS = 2;

// A widget "type" knows how to render its innerHTML given live game state.
// `state` is refreshed every frame by updateHudGrid() from main.js globals.
const HUD_WIDGETS = {
	lap:        { label: 'Lap',         cls: 'hw-lap',        render: s => `<span class="hw-label">Lap</span><span class="hw-value">${ s.lapNumber }</span>` },
	time:       { label: 'Time',        cls: 'hw-time',       render: s => `<span class="hw-label">Time</span><span class="hw-value">${ s.lapTime }</span>` },
	last:       { label: 'Last Lap',     cls: 'hw-last',       render: s => `<span class="hw-label">Last</span><span class="hw-value">${ s.lastLap }</span>` },
	best:       { label: 'Best Lap',     cls: 'hw-best',       render: s => `<span class="hw-label">Best</span><span class="hw-value">${ s.bestLap }</span>` },
	checkpoints:{ label: 'Checkpoints',  cls: 'hw-checkpoints',render: s => `<span class="hw-label">Checkpoints</span><span class="hw-value">${ s.checkpoints }</span>` },
	speed:      { label: 'Speed',        cls: 'hw-speed',      render: s => `<span class="hw-label">Speed</span><span class="hw-value">${ s.speed }</span><span class="hw-sub">km/h</span>` },
	fps:        { label: 'FPS',          cls: 'hw-fps',        render: s => `<span class="hw-label">FPS</span><span class="hw-value">${ s.fps }</span>` },
	controls:   { label: 'Controls',     cls: 'hw-controls',   render: s => `<span class="hw-label">Controls</span><span class="hw-sub">${ s.controls || '—' }</span>` },
	p2:         { label: 'Player 2',     cls: 'hw-p2',         render: s => `<span class="hw-label">P2</span><span class="hw-value">${ s.p2Lap }</span><span class="hw-sub">${ s.p2Time }</span>` },
	coins:      { label: 'Coins',        cls: 'hw-coins',      render: s => `<span class="hw-label">Coins</span><span class="hw-value">${ s.coins }</span>` },
	name:       { label: 'Player Name',  cls: 'hw-name',       render: s => `<span class="hw-label">Player</span><span class="hw-value">${ s.name || '—' }</span>` },
	boost:      { label: 'Boost',         cls: 'hw-boost',      render: s => `<span class="hw-label">Boost</span><span class="hw-value">${ s.boost }</span>` },
	stunt:      { label: 'Stunt Points',  cls: 'hw-stunt',      render: s => `<span class="hw-label">Stunt</span><span class="hw-value">${ s.stuntPoints }</span>` },
	stuntCombo: { label: 'Stunt Combo',   cls: 'hw-stunt',      render: s => `<span class="hw-label">Combo</span><span class="hw-value">x${ s.stuntCombo }</span>` },
	stuntBest:  { label: 'Best Stunt',    cls: 'hw-stunt',      render: s => `<span class="hw-label">Best Stunt</span><span class="hw-value">${ s.stuntBest }</span>` },
	posX:       { label: 'Position X',    cls: 'hw-pos',        render: s => `<span class="hw-label">Pos X</span><span class="hw-value">${ s.posX }</span>` },
	posY:       { label: 'Position Y',    cls: 'hw-pos',        render: s => `<span class="hw-label">Pos Y</span><span class="hw-value">${ s.posY }</span>` },
	posZ:       { label: 'Position Z',    cls: 'hw-pos',        render: s => `<span class="hw-label">Pos Z</span><span class="hw-value">${ s.posZ }</span>` },
};

// Default layout: top row of race widgets, second row left empty for the
// player to fill in. Both rows always exist (the .hud-row containers in
// index.html are fixed), so the empty second row can still receive widgets.
const HUD_DEFAULT_LAYOUT = [
	[ 'lap', 'time', 'last', 'best', 'checkpoints' ],
	[],
];

// Widgets that only make sense (and are only offered in the add menu) while
// the Stunt Mode mod is installed.
const STUNT_GATED_TYPES = new Set( [ 'boost', 'stunt', 'stuntCombo', 'stuntBest' ] );

function isStuntModeEnabled() {
	try {
		const parsed = JSON.parse( localStorage.getItem( 'racing-installed-mods-v1' ) || '[]' );
		return Array.isArray( parsed ) && parsed.some( ( m ) => m?.id === 'stunt-mode' );
	} catch {
		return false;
	}
}

function isHudWidgetAllowed( type ) {
	return ! STUNT_GATED_TYPES.has( type ) || isStuntModeEnabled();
}

let hudLayout = loadHudLayout();
let hudEditing = false;
let hudState = {
	lapNumber: 1, lapTime: '00:00.000', lastLap: '--:--.---', bestLap: '--:--.---',
	checkpoints: '0 / 0', speed: '0', fps: '--', controls: '', p2Lap: 'Lap 1', p2Time: '00:00.000',
	coins: '0', name: '', boost: '0%', stuntPoints: '0', stuntCombo: '1.00', stuntBest: '0',
	posX: '0', posY: '0', posZ: '0',
};

// kept in sync so main.js's existing references still work
const lapHud = document.getElementById( 'lap-hud' );
const lapHud2 = document.getElementById( 'lap-hud-2' );

const hudGrid = document.getElementById( 'hud-grid' );
const hudAddBtn = document.getElementById( 'hud-add-btn' );
const hudEditToggle = document.getElementById( 'hud-edit-toggle' );
const hudAddMenu = document.getElementById( 'hud-add-menu' );

function loadHudLayout() {
	try {
		const raw = localStorage.getItem( HUD_LAYOUT_KEY );
		if ( ! raw ) return JSON.parse( JSON.stringify( HUD_DEFAULT_LAYOUT ) );
		const parsed = JSON.parse( raw );
		if ( ! Array.isArray( parsed ) ) return JSON.parse( JSON.stringify( HUD_DEFAULT_LAYOUT ) );
		const rows = [];
		for ( let i = 0; i < HUD_NUM_ROWS; i++ ) {
			const r = Array.isArray( parsed[ i ] )
				? parsed[ i ].filter( t => HUD_WIDGETS[ t ] && isHudWidgetAllowed( t ) )
				: [];
			rows.push( r );
		}
		return rows;
	} catch {
		return JSON.parse( JSON.stringify( HUD_DEFAULT_LAYOUT ) );
	}
}

function saveHudLayout() {
	localStorage.setItem( HUD_LAYOUT_KEY, JSON.stringify( hudLayout ) );
	if ( typeof onHudLayoutChange === 'function' ) onHudLayoutChange();
}

function getHudLayoutSnapshot() {
	return JSON.parse( JSON.stringify( hudLayout ) );
}

function applyHudLayoutSnapshot( snap ) {
	if ( ! Array.isArray( snap ) ) return;
	const rows = [];
	for ( let i = 0; i < HUD_NUM_ROWS; i++ ) {
		const r = Array.isArray( snap[ i ] )
			? snap[ i ].filter( t => HUD_WIDGETS[ t ] && isHudWidgetAllowed( t ) )
			: [];
		rows.push( r );
	}
	hudLayout = rows;
	saveHudLayout();
	renderHudGrid();
}

function renderHudGrid() {
	for ( let i = 0; i < HUD_NUM_ROWS; i++ ) {
		const row = hudGrid.querySelector( `.hud-row[data-row="${ i }"]` );
		if ( ! row ) continue;
		row.innerHTML = '';
		for ( const type of hudLayout[ i ] ) {
			row.appendChild( buildHudWidget( type ) );
		}
	}
}

function buildHudWidget( type ) {
	const cfg = HUD_WIDGETS[ type ];
	const el = document.createElement( 'div' );
	el.className = `hud-widget ${ cfg.cls }`;
	el.dataset.type = type;
	el.innerHTML = cfg.render( hudState );
	const rm = document.createElement( 'button' );
	rm.className = 'hw-remove';
	rm.type = 'button';
	rm.textContent = '×';
	rm.title = `Remove ${ cfg.label }`;
	rm.addEventListener( 'click', e => { e.stopPropagation(); removeHudWidget( el ); } );
	el.appendChild( rm );
	attachHudDrag( el );
	return el;
}

function refreshHudValues() {
	for ( const el of hudGrid.querySelectorAll( '.hud-widget' ) ) {
		const cfg = HUD_WIDGETS[ el.dataset.type ];
		if ( cfg ) {
			const html = cfg.render( hudState );
			// Skip the DOM rewrite when nothing changed since last refresh — most
			// HUD values (lap number, best lap, etc.) stay constant for long
			// stretches, so reassigning innerHTML every refresh forces needless
			// parse/layout work each time.
			if ( html === el.dataset.lastHud ) continue;
			el.dataset.lastHud = html;
			// preserve the remove button
			const rm = el.querySelector( '.hw-remove' );
			el.innerHTML = html;
			if ( rm ) el.appendChild( rm );
		}
	}
}

function updateHudGrid() {
	refreshHudValues();
}

function removeHudWidget( el ) {
	const row = el.parentNode;
	if ( ! row || ! row.dataset ) return;
	const ri = Number( row.dataset.row );
	if ( ! Number.isFinite( ri ) ) return;
	const idx = Array.from( row.children ).indexOf( el );
	if ( idx === -1 ) return;
	hudLayout[ ri ].splice( idx, 1 );
	saveHudLayout();
	renderHudGrid();
}

function addHudWidget( type ) {
	if ( ! isHudWidgetAllowed( type ) ) return;
	// prefer the first empty row (e.g. the default-empty second row), then the
	// first non-full row (cap 6 per row); fall back to the first row
	for ( let i = 0; i < HUD_NUM_ROWS; i++ ) {
		if ( hudLayout[ i ].length === 0 ) {
			hudLayout[ i ].push( type );
			saveHudLayout();
			renderHudGrid();
			return;
		}
	}
	for ( let i = 0; i < HUD_NUM_ROWS; i++ ) {
		if ( hudLayout[ i ].length < 6 ) {
			hudLayout[ i ].push( type );
			saveHudLayout();
			renderHudGrid();
			return;
		}
	}
	hudLayout[ 0 ].push( type );
	saveHudLayout();
	renderHudGrid();
}

function setHudEditMode( on ) {
	hudEditing = on;
	hudGrid.classList.toggle( 'editing', on );
	hudEditToggle.classList.toggle( 'active', on );
	hudEditToggle.textContent = on ? '✓' : '✎';
	hudEditToggle.title = on ? 'Done customizing' : 'Customize HUD';
	if ( ! on ) hudAddMenu.classList.remove( 'visible' );
}

function toggleHudEditMode() {
	setHudEditMode( ! hudEditing );
}

function buildHudAddMenu() {
	hudAddMenu.innerHTML = '';
	for ( const type of Object.keys( HUD_WIDGETS ) ) {
		if ( ! isHudWidgetAllowed( type ) ) continue;
		const cfg = HUD_WIDGETS[ type ];
		const count = hudLayout.reduce( ( n, r ) => n + r.filter( t => t === type ).length, 0 );
		const btn = document.createElement( 'button' );
		btn.type = 'button';
		btn.innerHTML = `<span>${ cfg.label }</span><span class="amt">${ count } added</span>`;
		btn.addEventListener( 'click', () => {
			addHudWidget( type );
			buildHudAddMenu();
			hudAddMenu.classList.add( 'visible' );
		} );
		hudAddMenu.appendChild( btn );
	}
}

// --- drag & drop reordering (HTML5 DnD) ---
function attachHudDrag( el ) {
	el.setAttribute( 'draggable', 'true' );
	el.addEventListener( 'dragstart', e => {
		if ( ! hudEditing ) { e.preventDefault(); return; }
		e.dataTransfer.setData( 'text/plain', el.dataset.type );
		e.dataTransfer.effectAllowed = 'move';
		el.classList.add( 'dragging' );
	} );
	el.addEventListener( 'dragend', () => {
		el.classList.remove( 'dragging' );
		hudGrid.querySelectorAll( '.drag-over' ).forEach( n => n.classList.remove( 'drag-over' ) );
	} );
	el.addEventListener( 'dragover', e => {
		if ( ! hudEditing ) return;
		e.preventDefault();
		e.dataTransfer.dropEffect = 'move';
		el.classList.add( 'drag-over' );
	} );
	el.addEventListener( 'dragleave', () => el.classList.remove( 'drag-over' ) );
	el.addEventListener( 'drop', e => {
		if ( ! hudEditing ) return;
		e.preventDefault();
		e.stopPropagation();
		el.classList.remove( 'drag-over' );
		const srcType = e.dataTransfer.getData( 'text/plain' );
		if ( ! srcType || srcType === el.dataset.type ) return;
		moveHudWidgetBefore( srcType, el );
	} );
}

function attachHudRowDnd() {
	hudGrid.querySelectorAll( '.hud-row' ).forEach( row => {
		row.addEventListener( 'dragover', e => {
			if ( ! hudEditing ) return;
			e.preventDefault();
			e.dataTransfer.dropEffect = 'move';
		} );
		row.addEventListener( 'drop', e => {
			if ( ! hudEditing ) return;
			e.preventDefault();
			const srcType = e.dataTransfer.getData( 'text/plain' );
			if ( ! srcType ) return;
			const ri = Number( row.dataset.row );
			// if dropped on empty row or row end, append
			const target = e.target.closest( '.hud-widget' );
			if ( target ) return; // handled by widget drop
			if ( Number.isFinite( ri ) ) moveHudWidgetToRow( srcType, ri );
		} );
	} );
}

function findHudWidgetLocation( type ) {
	for ( let i = 0; i < HUD_NUM_ROWS; i++ ) {
		const idx = hudLayout[ i ].indexOf( type );
		if ( idx !== -1 ) return { row: i, idx };
	}
	return null;
}

function moveHudWidgetBefore( srcType, beforeEl ) {
	const src = findHudWidgetLocation( srcType );
	if ( ! src ) return;
	const dstRow = Number( beforeEl.parentNode.dataset.row );
	const dstIdx = Array.from( beforeEl.parentNode.children ).indexOf( beforeEl );
	// remove from source
	hudLayout[ src.row ].splice( src.idx, 1 );
	// recompute dst idx in case it was the same row
	const realIdx = src.row === dstRow && src.idx < dstIdx ? dstIdx - 1 : dstIdx;
	hudLayout[ dstRow ].splice( realIdx, 0, srcType );
	saveHudLayout();
	renderHudGrid();
}

function moveHudWidgetToRow( type, ri ) {
	const src = findHudWidgetLocation( type );
	if ( ! src ) return;
	hudLayout[ src.row ].splice( src.idx, 1 );
	hudLayout[ ri ].push( type );
	saveHudLayout();
	renderHudGrid();
}

// --- wire up controls ---
if ( hudEditToggle ) {
	hudEditToggle.addEventListener( 'click', e => {
		e.stopPropagation();
		toggleHudEditMode();
		if ( hudEditing ) { buildHudAddMenu(); hudAddMenu.classList.add( 'visible' ); }
	} );
}
if ( hudAddBtn ) {
	hudAddBtn.addEventListener( 'click', e => {
		e.stopPropagation();
		buildHudAddMenu();
		hudAddMenu.classList.toggle( 'visible' );
	} );
}
document.addEventListener( 'click', e => {
	if ( ! hudAddMenu ) return;
	if ( ! hudAddMenu.contains( e.target ) && e.target !== hudAddBtn && e.target !== hudEditToggle ) {
		hudAddMenu.classList.remove( 'visible' );
	}
} );

attachHudRowDnd();
renderHudGrid();

// expose for main.js
let onHudLayoutChange = null;
window.__hudGrid = {
	update: updateHudGrid,
	setState: ( s ) => { hudState = { ...hudState, ...s }; },
	getLayoutSnapshot: getHudLayoutSnapshot,
	applyLayoutSnapshot: applyHudLayoutSnapshot,
	setOnLayoutChange: ( fn ) => { onHudLayoutChange = typeof fn === 'function' ? fn : null; },
};
