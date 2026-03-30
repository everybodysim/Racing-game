import { Client, Callbacks } from 'colyseus';
import * as THREE from 'three';
import { rigidBody } from 'crashcat';
import { createRemoteBody } from './Physics.js';

const _targetQuat = new THREE.Quaternion();

export class Multiplayer {

	constructor( scene, models, physicsWorld ) {

		this.scene = scene;
		this.models = models;
		this.physicsWorld = physicsWorld;
		this.room = null;
		this.sessionId = null;
		this.remotePlayers = new Map();
		this.localModelKey = 'vehicle-truck-yellow';
		this.localPlayer = null;
		this.sendTimer = 0;

	}

	async connect( mapCode ) {

		const isLocal = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
		const endpoint = isLocal
			? `ws://${ location.hostname }:${ location.port }`
			: 'https://us-sjc-e902b997.colyseus.cloud';
		const client = new Client( endpoint );

		const options = { mapCode: mapCode || 'default' };

		this.room = await client.joinOrCreate( 'racing', options );
		this.sessionId = this.room.sessionId;

		const callbacks = Callbacks.get( this.room );

		// Wait for local player's onAdd to fire (may be async)
		await new Promise( ( resolve ) => {

			callbacks.onAdd( 'players', ( player, sessionId ) => {

				if ( sessionId === this.sessionId ) {

					this.localModelKey = player.modelKey;
					this.localPlayer = player;
					resolve();
					return;

				}

				this.addRemotePlayer( sessionId, player );

			} );

		} );

		callbacks.onRemove( 'players', ( player, sessionId ) => {

			this.removeRemotePlayer( sessionId );

		} );

		this.room.onLeave( () => {

			this.room = null;

		} );

	}

	addRemotePlayer( sessionId, player ) {

		const modelKey = player.modelKey || 'vehicle-truck-yellow';
		const model = this.models[ modelKey ]?.clone();
		if ( ! model ) return;

		const container = new THREE.Group();
		container.add( model );

		let bodyNode = null;
		const wheels = [];
		let wheelBL = null;
		let wheelBR = null;

		model.traverse( ( child ) => {

			const name = child.name.toLowerCase();

			if ( name === 'body' ) {

				child.rotation.order = 'YXZ';
				bodyNode = child;

			} else if ( name.includes( 'wheel' ) ) {

				child.rotation.order = 'YXZ';
				wheels.push( child );

				if ( name.includes( 'back' ) && name.includes( 'left' ) ) wheelBL = child;
				if ( name.includes( 'back' ) && name.includes( 'right' ) ) wheelBR = child;

			}

			if ( child.isMesh ) {

				child.castShadow = true;
				child.receiveShadow = true;

			}

		} );

		// Initialize at player's current position
		container.position.set( player.x, player.y - 0.5, player.z );
		container.quaternion.set( player.qx, player.qy, player.qz, player.qw );

		this.scene.add( container );

		const body = createRemoteBody( this.physicsWorld, [ player.x, player.y, player.z ] );

		this.remotePlayers.set( sessionId, {
			container,
			bodyNode,
			wheels,
			wheelBL,
			wheelBR,
			body,
			player,
			// Drift tracking for smoke
			driftIntensity: 0,
			prevSpeed: 0,
		} );

	}

	removeRemotePlayer( sessionId ) {

		const remote = this.remotePlayers.get( sessionId );
		if ( ! remote ) return;

		this.scene.remove( remote.container );
		// Move body out of play (crashcat has no destroy API)
		rigidBody.setPosition( this.physicsWorld, remote.body, [ 0, -100, 0 ], false );
		rigidBody.setLinearVelocity( this.physicsWorld, remote.body, [ 0, 0, 0 ] );
		this.remotePlayers.delete( sessionId );

	}

	sendUpdate( vehicle ) {

		if ( ! this.room ) return;

		const q = vehicle.container.quaternion;

		this.room.send( 'update', {
			x: vehicle.spherePos.x,
			y: vehicle.spherePos.y,
			z: vehicle.spherePos.z,
			qx: q.x,
			qy: q.y,
			qz: q.z,
			qw: q.w,
			linearSpeed: vehicle.linearSpeed,
			inputX: vehicle.inputX,
			inputZ: vehicle.inputZ,
			bodyPitch: vehicle.bodyNode ? vehicle.bodyNode.rotation.x : 0,
			bodyRoll: vehicle.bodyNode ? vehicle.bodyNode.rotation.z : 0,
		} );

	}

	tick( dt, vehicle ) {

		// Send state at ~20 Hz
		this.sendTimer += dt;

		if ( this.sendTimer >= 1 / 20 ) {

			this.sendTimer = 0;
			this.sendUpdate( vehicle );

		}

		// Interpolate remote players
		for ( const [ , remote ] of this.remotePlayers ) {

			const p = remote.player;
			const t = Math.min( 1, dt * 12 );

			// Steer physics body toward network position
			const bpos = remote.body.position;
			const steer = 20;

			rigidBody.setLinearVelocity( this.physicsWorld, remote.body, [
				( p.x - bpos[ 0 ] ) * steer,
				( p.y - bpos[ 1 ] ) * steer,
				( p.z - bpos[ 2 ] ) * steer,
			] );

			// Visual follows physics body (respects collision separation)
			remote.container.position.set( bpos[ 0 ], bpos[ 1 ] - 0.5, bpos[ 2 ] );

			_targetQuat.set( p.qx, p.qy, p.qz, p.qw );
			remote.container.quaternion.slerp( _targetQuat, t );

			if ( remote.bodyNode ) {

				remote.bodyNode.rotation.x += ( p.bodyPitch - remote.bodyNode.rotation.x ) * t;
				remote.bodyNode.rotation.z += ( p.bodyRoll - remote.bodyNode.rotation.z ) * t;
				remote.bodyNode.position.y = THREE.MathUtils.lerp( remote.bodyNode.position.y, 0.2, dt * 5 );

			}

			for ( const wheel of remote.wheels ) {

				wheel.rotation.x += p.linearSpeed * 0.5;

			}

			// Compute drift intensity for smoke particles
			remote.driftIntensity = Math.abs( p.linearSpeed - remote.prevSpeed ) +
				( remote.bodyNode ? Math.abs( remote.bodyNode.rotation.z ) * 2 : 0 );
			remote.prevSpeed = THREE.MathUtils.lerp( remote.prevSpeed,
				p.linearSpeed + ( 0.25 * p.linearSpeed * Math.abs( p.linearSpeed ) ),
				dt * 1 );

		}

	}

}
