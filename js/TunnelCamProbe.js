// Tunnel camera containment — analytic, NO hitboxes.
//
// While the car is inside a tunnel, the chase offset (2.3 up / 6.6 behind —
// and camera mods can push it much further) can put the camera inside the
// trench dirt at corners and short tunnels, or poke it above a closed roof:
// the classic "camera clips out of the tunnel" view of grass instead of the
// road. This probe walks the car→camera segment against the tunnel cell
// grid and stops it at the last free spot.
//
// When the car is NOT in a tunnel the probe returns the full length
// untouched, so camera behavior is identical everywhere else — the probe
// is the only thing between "full length" and "pulled in".
//
// Solid model (world units):
//   · Ground dirt: everything below SURFACE_TOP that is not over a tunnel cell.
//   · Closed roof: over a closed tunnel cell, everything above ROOF_CLEARANCE
//     (the roof band and the air above it — the camera must stay under the roof).
//   · Open trench: over an open tunnel cell, always free (the camera may rise
//     out of an open trench and look down into it).

const SURFACE_TOP = 0.45;      // top of the ground / roof solid band
const ROOF_CLEARANCE = - 0.15; // camera must sit below a closed roof
const STEP = 0.35;             // walk resolution along the segment
const PULL_MARGIN = 0.4;       // keep this much clear of the solid
const MIN_FREE = 1.4;          // never glue the camera into the car

export function makeTunnelClipProbe( tunnelEntries, cellSize ) {

	const cell = Number( cellSize ) || 7.4925;
	const cells = new Map();
	for ( const entry of ( Array.isArray( tunnelEntries ) ? tunnelEntries : [] ) ) {

		if ( ! Array.isArray( entry ) ) continue;
		const gx = Number( entry[ 0 ] );
		const gz = Number( entry[ 1 ] );
		if ( ! Number.isFinite( gx ) || ! Number.isFinite( gz ) ) continue;
		cells.set( `${ Math.floor( gx ) },${ Math.floor( gz ) }`, entry[ 2 ] === 1 );

	}
	const cellKey = ( x, z ) => `${ Math.floor( x / cell ) },${ Math.floor( z / cell ) }`;
	if ( cells.size === 0 ) return null;

	return ( from, dir, len ) => {

		// Only a car that is itself underground inside a tunnel activates the
		// probe. Anywhere else: full length, byte-identical camera math.
		if ( from.y > - 0.55 ) return len;
		if ( ! cells.has( cellKey( from.x, from.z ) ) ) return len;

		let free = len;
		for ( let d = STEP; d < len; d += STEP ) {

			const x = from.x + dir.x * d;
			const y = from.y + dir.y * d;
			const z = from.z + dir.z * d;
			const closed = cells.get( cellKey( x, z ) );
			if ( closed === undefined ) {

				if ( y < SURFACE_TOP ) { // inside the dirt
					free = d - PULL_MARGIN;
					break;
				}

			} else if ( closed && y > ROOF_CLEARANCE ) { // at / above a closed roof
				free = d - PULL_MARGIN;
				break;

			}

		}
		return Math.max( MIN_FREE, free );

	};

}
