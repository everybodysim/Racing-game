import * as THREE from 'three';
import { rigidBody, triangleMesh, emptyShape, MotionType, ShapeType, collisionDispatch, setCastShapeFn, setCollideShapeFn, reversedCollideShapeVsShape } from 'crashcat';

// Static box volumes stay exactly where they were authored. Only their
// collision surface changes: buried faces are removed and shared exterior
// edges are welded. Dynamic props, sensors and imported meshes are untouched.
const worlds = new WeakMap();
const repairedShapes = new WeakSet();
let wrappedCast = null, wrappedCollide = null;
function correctSharedEdge( hit, args, cast ) {

	// Crashcat's sphere/mesh cast supplies an inward surface normal, while
	// CCD expects the axis pointing from the sphere INTO the obstacle.
	// Reverse that convention only for our repaired meshes. Without this,
	// converting a genuine wall to triangles can make CCD ignore its face.
	if ( cast ) for ( let axis = 0; axis < 3; axis ++ ) {
		hit.penetrationAxis[ axis ] *= - 1;
		hit.normal[ axis ] *= - 1;
	}
	const shape = args[ cast ? 18 : 15 ], data = shape.data;
	const bits = Math.ceil( Math.log2( data.triangleCount ) );
	const tri = ( hit.subShapeIdB >>> 0 ) & ( 2 ** bits - 1 );
	if ( tri >= data.triangleCount ) return;
	const at = tri * 8, flags = data.triangleBuffer[ at + 6 ];
	if ( flags === 7 ) return;
	const pAt = cast ? 21 : 18, qAt = cast ? 24 : 21;
	const q = new THREE.Quaternion( args[ qAt ], args[ qAt + 1 ], args[ qAt + 2 ], args[ qAt + 3 ] );
	const p = new THREE.Vector3( ...hit.pointB ).sub( new THREE.Vector3( args[ pAt ], args[ pAt + 1 ], args[ pAt + 2 ] ) ).applyQuaternion( q.clone().invert() );
	const vertices = [ 0, 1, 2 ].map( ( i ) => {
		const v = data.triangleBuffer[ at + i ] * 3;
		return new THREE.Vector3( ...data.positions.slice( v, v + 3 ) );
	} );
	let shared = false, exposed = false;
	for ( let i = 0; i < 3; i ++ ) {
		const a = vertices[ i ], b = vertices[ ( i + 1 ) % 3 ];
		const d = b.clone().sub( a ), len2 = d.lengthSq();
		const t = THREE.MathUtils.clamp( p.clone().sub( a ).dot( d ) / len2, 0, 1 );
		if ( p.distanceToSquared( a.clone().addScaledVector( d, t ) ) < 1e-8 ) {
			if ( flags & ( 1 << i ) ) exposed = true;
			else shared = true;
		}
	}
	if ( ! shared || exposed ) return;
	const n = new THREE.Vector3( ...data.triangleBuffer.slice( at + 3, at + 6 ) ).applyQuaternion( q ).normalize();
	// The response is the REAL exterior face, not the buried box end-cap.
	// Correct both the regular solver and CCD. No velocities are restored,
	// no contacts made sensors, and genuine exposed boundaries stay active.
	hit.penetrationAxis[ 0 ] = - n.x; hit.penetrationAxis[ 1 ] = - n.y; hit.penetrationAxis[ 2 ] = - n.z;
	if ( cast ) { hit.normal[ 0 ] = n.x; hit.normal[ 1 ] = n.y; hit.normal[ 2 ] = n.z; }
	const center = new THREE.Vector3( args[ 5 ], args[ 6 ], args[ 7 ] );
	if ( cast ) center.addScaledVector( new THREE.Vector3( args[ 15 ], args[ 16 ], args[ 17 ] ), hit.fraction );
	const distance = center.clone().sub( new THREE.Vector3( ...hit.pointB ) ).dot( n );
	const radius = args[ 2 ].radius;
	const surface = center.clone().addScaledVector( n, - distance );
	const spherePoint = center.clone().addScaledVector( n, - radius );
	for ( let axis = 0; axis < 3; axis ++ ) { hit.pointA[ axis ] = spherePoint.getComponent( axis ); hit.pointB[ axis ] = surface.getComponent( axis ); }
	if ( cast ) hit.penetrationDepth = Math.max( 0, radius - distance );
	else hit.penetration = radius - distance;

}
function edgeCollector( collector, args, cast ) {
	return {
		get bodyIdB() { return collector.bodyIdB; },
		set bodyIdB( value ) { collector.bodyIdB = value; },
		get earlyOutFraction() { return collector.earlyOutFraction; },
		set earlyOutFraction( value ) { collector.earlyOutFraction = value; },
		addHit( hit ) { correctSharedEdge( hit, args, cast ); collector.addHit( hit ); },
		addMiss() { collector.addMiss(); },
		shouldEarlyOut() { return collector.shouldEarlyOut(); }
	};
}
function ensureSeamContactHandlers() {

	const casts = collisionDispatch.castFns.get( ShapeType.SPHERE );
	const collisions = collisionDispatch.collideFns.get( ShapeType.SPHERE );
	const cast = casts?.get( ShapeType.TRIANGLE_MESH ), collide = collisions?.get( ShapeType.TRIANGLE_MESH );
	if ( cast && cast !== wrappedCast ) {
		wrappedCast = ( ...args ) => {
			if ( ! repairedShapes.has( args[ 18 ] ) ) return cast( ...args );
			const collector = args[ 0 ]; args[ 0 ] = edgeCollector( collector, args, true );
			return cast( ...args );
		};
		setCastShapeFn( ShapeType.SPHERE, ShapeType.TRIANGLE_MESH, wrappedCast );
	}
	if ( collide && collide !== wrappedCollide ) {
		wrappedCollide = ( ...args ) => {
			if ( ! repairedShapes.has( args[ 15 ] ) ) return collide( ...args );
			const collector = args[ 0 ]; args[ 0 ] = edgeCollector( collector, args, false );
			return collide( ...args );
		};
		setCollideShapeFn( ShapeType.SPHERE, ShapeType.TRIANGLE_MESH, wrappedCollide );
		setCollideShapeFn( ShapeType.TRIANGLE_MESH, ShapeType.SPHERE, reversedCollideShapeVsShape( wrappedCollide ) );
	}

}
const EPS = 1e-6;
const dot = ( a, b ) => a[ 0 ] * b[ 0 ] + a[ 1 ] * b[ 1 ] + a[ 2 ] * b[ 2 ];
const sub = ( a, b ) => [ a[ 0 ] - b[ 0 ], a[ 1 ] - b[ 1 ], a[ 2 ] - b[ 2 ] ];
const key = ( v ) => v.map( ( x ) => Math.round( x / EPS ) ).join( ',' );
function split( polygon, normal, distance ) {

	const inside = [], outside = [];
	for ( let i = 0; i < polygon.length; i ++ ) {
		const a = polygon[ i ], b = polygon[ ( i + 1 ) % polygon.length ];
		const da = dot( a, normal ) - distance, db = dot( b, normal ) - distance;
		if ( da <= EPS ) inside.push( a );
		if ( da >= - EPS ) outside.push( a );
		if ( ( da > EPS && db < - EPS ) || ( da < - EPS && db > EPS ) ) {
			const t = da / ( da - db );
			const p = a.map( ( x, axis ) => x + ( b[ axis ] - x ) * t );
			inside.push( p ); outside.push( p );
		}
	}
	return [ inside, outside ];

}
function subtractSolid( polygon, planes ) {

	let inside = polygon;
	const outside = [];
	for ( const plane of planes ) {
		// Coplanar polygons belong to the inside half-space. Emitting them
		// on both sides would leave duplicate faces at touching box seams.
		if ( inside.every( ( p ) => dot( p, plane.n ) - plane.d <= EPS ) ) continue;
		const [ next, fragment ] = split( inside, plane.n, plane.d );
		if ( fragment.length >= 3 ) outside.push( fragment );
		inside = next;
		if ( inside.length < 3 ) break;
	}
	return outside;

}
function describe( source ) {

	const body = source.body;
	const q = new THREE.Quaternion( ...body.quaternion );
	const h = source.h;
	const corners = [];
	for ( let i = 0; i < 8; i ++ ) {
		const v = new THREE.Vector3( i & 1 ? h[ 0 ] : - h[ 0 ], i & 2 ? h[ 1 ] : - h[ 1 ], i & 4 ? h[ 2 ] : - h[ 2 ] ).applyQuaternion( q );
		corners.push( v.toArray().map( ( x, axis ) => x + body.position[ axis ] ) );
	}
	const faces = [];
	// Winding points OUT of the solid, including bottoms and ceilings.
	for ( const ids of [ [ 0, 4, 6, 2 ], [ 1, 3, 7, 5 ], [ 0, 1, 5, 4 ], [ 2, 6, 7, 3 ], [ 0, 2, 3, 1 ], [ 4, 5, 7, 6 ] ] ) {
		const points = ids.map( ( id ) => corners[ id ] );
		const a = new THREE.Vector3( ...sub( points[ 1 ], points[ 0 ] ) );
		const b = new THREE.Vector3( ...sub( points[ 2 ], points[ 0 ] ) );
		const n = a.cross( b ).normalize().toArray();
		faces.push( { points, n, d: dot( n, points[ 0 ] ) } );
	}
	const min = [ 0, 1, 2 ].map( ( axis ) => Math.min( ...corners.map( ( c ) => c[ axis ] ) ) );
	const max = [ 0, 1, 2 ].map( ( axis ) => Math.max( ...corners.map( ( c ) => c[ axis ] ) ) );
	return { ...source, faces, min, max, inverse: q.clone().invert() };

}
function overlaps( a, b ) {
	return [ 0, 1, 2 ].every( ( axis ) => a.min[ axis ] <= b.max[ axis ] + EPS && a.max[ axis ] >= b.min[ axis ] - EPS );
}
function lineKey( a, b ) {
	const dir = new THREE.Vector3( ...sub( b, a ) ).normalize();
	if ( dir.x < - EPS || ( Math.abs( dir.x ) <= EPS && ( dir.y < - EPS || ( Math.abs( dir.y ) <= EPS && dir.z < 0 ) ) ) ) dir.negate();
	const offset = new THREE.Vector3( ...a ).addScaledVector( dir, - dir.dot( new THREE.Vector3( ...a ) ) );
	return key( dir.toArray() ) + '/' + key( offset.toArray() );
}

export function rebuildStaticSeams( world ) {

	ensureSeamContactHandlers();
	let sources = worlds.get( world );
	let changed = ! sources;
	if ( ! sources ) { sources = new Map(); worlds.set( world, sources ); }
	for ( const body of world.bodies.pool ) {
		if ( ! body || body._pooled || body.motionType !== MotionType.STATIC || body.sensor || body.shape?.type !== ShapeType.BOX ) continue;
		// Also captures a changed wall box after the mega-pad height boost.
		sources.set( body, { body, id: body.id, h: [ ...body.shape.halfExtents ] } );
		changed = true;
	}
	if ( ! changed ) return sources.stats;
	const boxes = [ ...sources.values() ].filter( ( s ) => ! s.body._pooled && s.body.id === s.id && s.body.motionType === MotionType.STATIC && ! s.body.sensor ).map( describe );
	const buckets = new Map(), large = [];
	const bucketSize = 16;
	for ( let i = 0; i < boxes.length; i ++ ) {
		const b = boxes[ i ];
		const x0 = Math.floor( b.min[ 0 ] / bucketSize ), x1 = Math.floor( b.max[ 0 ] / bucketSize );
		const z0 = Math.floor( b.min[ 2 ] / bucketSize ), z1 = Math.floor( b.max[ 2 ] / bucketSize );
		b.range = [ x0, x1, z0, z1 ];
		if ( ( x1 - x0 + 1 ) * ( z1 - z0 + 1 ) > 256 ) { large.push( i ); continue; }
		for ( let x = x0; x <= x1; x ++ ) for ( let z = z0; z <= z1; z ++ ) {
			const k = x + ',' + z;
			if ( ! buckets.has( k ) ) buckets.set( k, [] );
			buckets.get( k ).push( i );
		}
	}
	const polygons = [];
	for ( let i = 0; i < boxes.length; i ++ ) {
		const b = boxes[ i ], candidates = new Set( large );
		const [ x0, x1, z0, z1 ] = b.range;
		if ( large.includes( i ) ) boxes.forEach( ( _, j ) => candidates.add( j ) );
		else for ( let x = x0; x <= x1; x ++ ) for ( let z = z0; z <= z1; z ++ ) for ( const j of buckets.get( x + ',' + z ) || [] ) candidates.add( j );
		candidates.delete( i );
		const neighbours = [ ...candidates ].filter( ( j ) => overlaps( b, boxes[ j ] ) );
		for ( const face of b.faces ) {
			let fragments = [ face.points ];
			for ( const j of neighbours ) {
				const other = boxes[ j ];
				// Coincident exterior faces have one deterministic owner, so
				// overlap is not deleted from BOTH boxes (which would make a hole).
				const coplanar = other.faces.some( ( f ) => dot( face.n, f.n ) > 1 - EPS && Math.abs( face.d - f.d ) < EPS );
				if ( coplanar && b.body.id < other.body.id ) continue;
				fragments = fragments.flatMap( ( p ) => subtractSolid( p, other.faces ) );
				if ( ! fragments.length ) break;
			}
			for ( const points of fragments ) if ( points.length >= 3 ) polygons.push( { box: b, points } );
		}
	}
	// Split T-junctions too: a small floor tile can touch only part of a
	// long ground slab edge. Both sides need identical welded edge endpoints.
	const lines = new Map();
	for ( const poly of polygons ) for ( let i = 0; i < poly.points.length; i ++ ) {
		const a = poly.points[ i ], b = poly.points[ ( i + 1 ) % poly.points.length ];
		if ( dot( sub( b, a ), sub( b, a ) ) < EPS * EPS ) continue;
		const k = lineKey( a, b );
		if ( ! lines.has( k ) ) lines.set( k, new Map() );
		lines.get( k ).set( key( a ), a ); lines.get( k ).set( key( b ), b );
	}
	const meshes = new Map();
	for ( const b of boxes ) meshes.set( b.body, { positions: [], indices: [] } );
	for ( const poly of polygons ) {
		const boundary = [];
		for ( let i = 0; i < poly.points.length; i ++ ) {
			const a = poly.points[ i ], b = poly.points[ ( i + 1 ) % poly.points.length ], d = sub( b, a );
			const len2 = dot( d, d );
			if ( len2 < EPS * EPS ) continue;
			const candidates = lines.get( lineKey( a, b ) );
			const points = [ ...candidates.values() ].map( ( p ) => ( { p, t: dot( sub( p, a ), d ) / len2 } ) )
				.filter( ( v ) => v.t >= - EPS && v.t < 1 - EPS && dot( sub( v.p, a.map( ( x, axis ) => x + d[ axis ] * v.t ) ), sub( v.p, a.map( ( x, axis ) => x + d[ axis ] * v.t ) ) ) < EPS * EPS * 4 )
				.sort( ( a, b ) => a.t - b.t );
			boundary.push( ...points.map( ( v ) => v.p ) );
		}
		if ( boundary.length < 3 ) continue;
		const center = [ 0, 1, 2 ].map( ( axis ) => boundary.reduce( ( sum, v ) => sum + v[ axis ], 0 ) / boundary.length );
		const mesh = meshes.get( poly.box.body );
		const local = ( p ) => new THREE.Vector3( ...sub( p, poly.box.body.position ) ).applyQuaternion( poly.box.inverse ).toArray();
		for ( let i = 0; i < boundary.length; i ++ ) {
			const offset = mesh.positions.length / 3;
			mesh.positions.push( ...local( center ), ...local( boundary[ i ] ), ...local( boundary[ ( i + 1 ) % boundary.length ] ) );
			mesh.indices.push( offset, offset + 1, offset + 2 );
		}
	}
	const edges = new Map();
	for ( const b of boxes ) {
		const mesh = meshes.get( b.body );
		b.body.shape = mesh.indices.length ? triangleMesh.create( mesh ) : emptyShape.create();
		repairedShapes.add( b.body.shape );
		b.body.enhancedInternalEdgeRemoval = true;
		if ( b.body.shape.type !== ShapeType.TRIANGLE_MESH ) continue;
		const data = b.body.shape.data;
		const q = new THREE.Quaternion( ...b.body.quaternion );
		for ( let tri = 0; tri < data.triangleCount; tri ++ ) {
			// Crashcat exposes interleaved triangle data (8 values per tri).
			const offset = tri * 8;
			const vertices = [ 0, 1, 2 ].map( ( axis ) => {
				const at = data.triangleBuffer[ offset + axis ] * 3;
				return new THREE.Vector3( ...data.positions.slice( at, at + 3 ) ).applyQuaternion( q ).add( new THREE.Vector3( ...b.body.position ) ).toArray();
			} );
			const normal = new THREE.Vector3( ...data.triangleBuffer.slice( offset + 3, offset + 6 ) ).applyQuaternion( q ).normalize().toArray();
			for ( let edge = 0; edge < 3; edge ++ ) {
				const endpoints = [ key( vertices[ edge ] ), key( vertices[ ( edge + 1 ) % 3 ] ) ].sort();
				const k = endpoints.join( '/' );
				if ( ! edges.has( k ) ) edges.set( k, [] );
				edges.get( k ).push( { data, offset, edge, normal } );
			}
		}
	}
	let welded = 0;
	for ( const shared of edges.values() ) {
		if ( shared.length !== 2 || dot( shared[ 0 ].normal, shared[ 1 ].normal ) < Math.cos( Math.PI / 36 ) ) continue;
		for ( const e of shared ) e.data.triangleBuffer[ e.offset + 6 ] &= ~ ( 1 << e.edge );
		welded ++;
	}
	for ( const b of boxes ) rigidBody.updateShape( world, b.body );
	sources.stats = { boxes: boxes.length, polygons: polygons.length, welded };
	return sources.stats;

}
