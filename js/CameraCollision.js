import { castShape, createClosestCastShapeCollector, createDefaultCastShapeSettings, sphere, MotionType, CastShapeStatus, filter } from 'crashcat';

// Sweep a camera-sized volume, not an infinitely thin ray. The radius also
// protects the near plane when the camera slides along a wall or a roof.
// A world getter lets the editor rebuild its physics without stale queries.
export function createCameraClipProbe( getWorld ) {

	const collector = createClosestCastShapeCollector();
	const settings = createDefaultCastShapeSettings();
	settings.collideWithBackfaces = true;
	const shape = sphere.create( { radius: 0.25 } );
	const position = [ 0, 0, 0 ];
	const displacement = [ 0, 0, 0 ];
	const rotation = [ 0, 0, 0, 1 ];
	const scale = [ 1, 1, 1 ];
	let lastWorld = null, queryFilter = null;
	return ( origin, direction, length ) => {

		const world = getWorld();
		if ( ! world || length <= 1e-6 ) return length;
		if ( world !== lastWorld ) {

			lastWorld = world;
			queryFilter = filter.forWorld( world );
			queryFilter.bodyFilter = ( body ) => body && body.motionType === MotionType.STATIC;

		}
		position[ 0 ] = origin.x; position[ 1 ] = origin.y; position[ 2 ] = origin.z;
		displacement[ 0 ] = direction.x * length;
		displacement[ 1 ] = direction.y * length;
		displacement[ 2 ] = direction.z * length;
		collector.reset();
		castShape( world, collector, settings, shape, position, rotation, scale, displacement, queryFilter );
		if ( collector.hit.status !== CastShapeStatus.COLLIDING ) return length;
		// Never enforce a minimum follow distance through an obstruction.
		return Math.max( 0, Math.min( length, collector.hit.fraction * length - 0.08 ) );

	};

}
