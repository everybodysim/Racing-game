// MovingObstacles.js — animated track obstacles (slide / spin / orbit / custom).
// Extracted verbatim from main.js so the track editor can run the exact same
// obstacle meshes + hitboxes while you edit. Time is a plain clock: the game
// feeds race-clock seconds; the editor feeds its own local clock (sync is
// not required for editing).

import * as THREE from 'three';
import { rigidBody } from 'crashcat';
// NOTE: keep this version param in lockstep with main.js's Track.js import —
// same URL = same module instance = shared constants.
import { CELL_RAW, GRID_SCALE } from './Track.js?v=1000214';

function createMovingObstacleState( scene, extras ) {
	const entries = Array.isArray( extras?.movingObstacles ) ? extras.movingObstacles : [];
	const state = { items: [], startTime: 0 };
	for ( const entry of entries ) {
		const [ gxRaw, gzRaw, typeRaw, orientRaw, speedRaw ] = Array.isArray( entry ) ? entry : [];
		const gx = Number( gxRaw );
		const gz = Number( gzRaw );
		if ( ! Number.isFinite( gx ) || ! Number.isFinite( gz ) ) continue;
		const type = String( typeRaw || '' );
		const orient = Number( orientRaw ) || 0;
		const base = new THREE.Vector3( ( gx + 0.5 ) * CELL_RAW * GRID_SCALE, -0.5 + ( CELL_RAW * GRID_SCALE * 0.08 ), ( gz + 0.5 ) * CELL_RAW * GRID_SCALE );
		const obstacle = { type, orient, speed: THREE.MathUtils.clamp( Number( speedRaw ) || 1, 0.25, 3 ), base, mesh: new THREE.Group(), colliders: [] };
		if ( type === 'moving-slide-block' ) {
			const m = new THREE.Mesh( new THREE.BoxGeometry( 2.1, 1.2, 1.5 ), new THREE.MeshStandardMaterial( { color: 0x8ca0b8 } ) );
			obstacle.mesh.add( m );
			obstacle.colliders.push( { half: new THREE.Vector3( 1.05, 0.6, 0.75 ), offset: new THREE.Vector3() } );
		} else if ( type === 'moving-spin-wall' ) {
			const m = new THREE.Mesh( new THREE.BoxGeometry( 3.8, 0.8, 0.55 ), new THREE.MeshStandardMaterial( { color: 0xb4b8bf } ) );
			obstacle.mesh.add( m );
			obstacle.colliders.push( { half: new THREE.Vector3( 1.9, 0.4, 0.275 ), offset: new THREE.Vector3() } );
		} else if ( type === 'moving-custom' ) {
			const cfg = entry?.[5] && typeof entry[5] === 'object' ? entry[5] : {};
			obstacle.custom = cfg;
			const count = Math.max( 1, Math.min( 8, Math.round( Number( cfg.count ) || 1 ) ) );
			for ( let i = 0; i < count; i ++ ) {
				const sx = Number( cfg.sx ) || 2, sy = Number( cfg.sy ) || 0.8, sz = Number( cfg.sz ) || 0.8;
				const shape = String( cfg.shape || 'square' );
				const geom = shape === 'pole' ? new THREE.CylinderGeometry( sx * 0.18, sx * 0.18, sy, 12 ) : new THREE.BoxGeometry( sx, sy, sz );
				const mesh = new THREE.Mesh( geom, new THREE.MeshStandardMaterial( { color: cfg.color || '#ff8844' } ) );
				obstacle.mesh.add( mesh );
				obstacle.colliders.push( { half: new THREE.Vector3( shape === 'pole' ? sx * 0.18 : sx * 0.5, sy * 0.5, shape === 'pole' ? sx * 0.18 : sz * 0.5 ), offset: new THREE.Vector3(), shape } );
			}
		} else if ( type === 'moving-orbit-poles' ) {
			for ( let i = 0; i < 3; i ++ ) {
				const pole = new THREE.Mesh( new THREE.CylinderGeometry( 0.23, 0.23, 1.0, 12 ), new THREE.MeshStandardMaterial( { color: 0x979ea8 } ) );
				obstacle.mesh.add( pole );
				obstacle.colliders.push( { half: new THREE.Vector3( 0.23, 0.5, 0.23 ), offset: new THREE.Vector3() } );
			}
		} else continue;
		obstacle.mesh.position.copy( base );
		scene.add( obstacle.mesh );
		state.items.push( obstacle );
	}
	return state;
}

function resetMovingObstacles( state, now = 0 ) {
	if ( ! state ) return;
	state.startTime = now;
}

function updateMovingObstacles( state, now, vehicleList ) {
	if ( ! state ) return;
	const t = now - ( state.startTime || 0 );
	for ( const obstacle of state.items ) {
		const p = obstacle.base.clone();
		obstacle.mesh.rotation.set( 0, 0, 0 );
		if ( obstacle.type === 'moving-slide-block' ) p.x += Math.sin( t * 1.35 * obstacle.speed ) * 1.7;
		if ( obstacle.type === 'moving-spin-wall' ) obstacle.mesh.rotation.y = t * 0.9 * obstacle.speed;
		if ( obstacle.type === 'moving-custom' ) {
			const cfg = obstacle.custom || {};
			const orbitR = Number( cfg.orbit ) || 0;
			for ( let i = 0; i < obstacle.mesh.children.length; i ++ ) {
				const a = ( t * ( Number( cfg.rot ) || 1 ) * obstacle.speed ) + i * ( Math.PI * 2 / obstacle.mesh.children.length );
				const ox = Math.cos( a ) * orbitR, oz = Math.sin( a ) * orbitR;
				obstacle.mesh.children[i].position.set( ox, 0, oz );
				obstacle.mesh.children[i].rotation.y = a;
				obstacle.colliders[i].offset.set( ox, 0, oz );
			}
		} else if ( obstacle.type === 'moving-orbit-poles' ) {
			for ( let i = 0; i < obstacle.mesh.children.length; i ++ ) {
				const a = t * 1.35 * obstacle.speed + i * ( Math.PI * 2 / 3 );
				obstacle.mesh.children[ i ].position.set( Math.cos( a ) * 1.25, 0, Math.sin( a ) * 1.25 );
				obstacle.colliders[ i ].offset.set( Math.cos( a ) * 1.25, 0, Math.sin( a ) * 1.25 );
			}
		}
		obstacle.mesh.position.copy( p );
		for ( const vehicle of vehicleList ) {
			if ( ! vehicle?.rigidBody ) continue;
			const r = 0.5;
			for ( const collider of obstacle.colliders ) {
				const quat = obstacle.mesh.quaternion;
				const world = collider.offset.clone().applyQuaternion( quat ).add( obstacle.mesh.position );
				const local = vehicle.spherePos.clone().sub( world ).applyQuaternion( quat.clone().invert() );
				const clampedLocal = new THREE.Vector3(
					THREE.MathUtils.clamp( local.x, -collider.half.x, collider.half.x ),
					THREE.MathUtils.clamp( local.y, -collider.half.y, collider.half.y ),
					THREE.MathUtils.clamp( local.z, -collider.half.z, collider.half.z )
				);
				const closest = clampedLocal.clone().applyQuaternion( quat ).add( world );
				const delta = vehicle.spherePos.clone().sub( closest );
				const distSq = delta.lengthSq();
				if ( distSq >= r * r || distSq < 1e-8 ) continue;
				const dist = Math.sqrt( distSq );
				const n = delta.multiplyScalar( 1 / dist );
				const push = ( r - dist ) + 1e-3;
				vehicle.spherePos.addScaledVector( n, push );
				rigidBody.setPosition( vehicle.physicsWorld, vehicle.rigidBody, [ vehicle.spherePos.x, vehicle.spherePos.y, vehicle.spherePos.z ], false );
				const vx = vehicle.sphereVel.x, vy = vehicle.sphereVel.y, vz = vehicle.sphereVel.z;
				const dot = vx * n.x + vy * n.y + vz * n.z;
				if ( dot < 0 ) rigidBody.setLinearVelocity( vehicle.physicsWorld, vehicle.rigidBody, [ vx - dot * n.x, vy - dot * n.y, vz - dot * n.z ] );
			}
		}
	}
}

