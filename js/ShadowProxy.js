// Static shadow proxy: the sun's depth pass draws ONE merged, world-space
// silhouette of every static caster instead of thousands of individual
// meshes. Kept on its own render layer so the main camera never sees it.
//
// MEGA-MAP BUCKETING: the merged silhouette of a huge build can run to
// millions of triangles, and the depth pass rasterizes the WHOLE mesh even
// though only the area around the player is ever on screen. The proxy is
// therefore merged into 64-unit world buckets, and updateCull() hides every
// bucket outside the gameplay cull radius each frame — the depth pass then
// only touches the handful of buckets that can actually cast visible
// shadows, for the same one-draw-per-bucket cost on small maps.
import * as THREE from 'three';

export const SHADOW_CAST_LAYER = 9;
const PROXY_BUCKET_SIZE = 64;

export function createShadowProxyController( scene, rootGroup, dirLight ) {

	let proxy = null;
	let dirty = false;
	let lastBuild = - 1e9;
	let cullCenterX = 0;
	let cullCenterZ = 0;
	let cullRadius = 0;

	// Three.js needs the addon? No — do the merge by hand so this module
	// works everywhere without importmap addon paths: concatenate world-
	// space positions + indices of every static caster under rootGroup,
	// split into PROXY_BUCKET_SIZE world buckets.
	function collect() {

		const buckets = new Map();
		const v = new THREE.Vector3();
		const m4 = new THREE.Matrix4();
		const bucketAt = ( x, z ) => {

			const key = Math.floor( x / PROXY_BUCKET_SIZE ) + ',' + Math.floor( z / PROXY_BUCKET_SIZE );
			let bucket = buckets.get( key );
			if ( ! bucket ) {

				bucket = { positions: [], indices: [] };
				buckets.set( key, bucket );

			}
			return bucket;

		};
		rootGroup.updateMatrixWorld( true );
		rootGroup.traverse( ( obj ) => {

			if ( ! ( obj.isMesh && obj.castShadow ) ) return;
			if ( obj.layers.mask !== 1 ) return; // layer-0-only = static source; skip proxies/dynamics
			if ( obj.isInstancedMesh ) {

				// Alpha-tested instanced casters (forest/bush/grass deco) keep
				// their own draw in the depth pass: a merge would drop their
				// per-instance transforms and turn lacy foliage into solid
				// quads, and alphaTest needs the real material. They're only
				// a handful of InstancedMeshes — cheap either way.
				const iMats = Array.isArray( obj.material ) ? obj.material : [ obj.material ];
				if ( iMats.some( ( m ) => m && ( m.alphaTest ?? 0 ) > 0 ) ) {

					obj.layers.enable( SHADOW_CAST_LAYER );
					return;

				}
				// Track-piece chunks (buildTrack's static batcher) can carry
				// HUNDREDS of InstancedMeshes across a big map. The old
				// cast-layer shortcut drew each one in the depth pass — and
				// the shadow camera sees the ENTIRE map, so nothing ever
				// culled: the depth pass exploded from one merged proxy draw
				// to hundreds of draws per shadow refresh. Bake every
				// instance's transform straight into the merged proxy
				// geometry instead: the depth pass stays at one draw per
				// bucket, and distant buckets hide entirely on mega maps.
				const iPosAttr = obj.geometry?.attributes?.position;
				const iIndex = obj.geometry?.index;
				if ( ! iPosAttr || iPosAttr.itemSize !== 3 ) return;
				for ( let k = 0; k < obj.count; k ++ ) {

					m4.fromArray( obj.instanceMatrix.array, k * 16 ).premultiply( obj.matrixWorld );
					const bucket = bucketAt( m4.elements[ 12 ], m4.elements[ 14 ] );
					const baseVertex = bucket.positions.length / 3;
					for ( let i = 0; i < iPosAttr.count; i ++ ) {

						v.fromBufferAttribute( iPosAttr, i ).applyMatrix4( m4 );
						bucket.positions.push( v.x, v.y, v.z );

					}
					if ( iIndex ) for ( let i = 0; i < iIndex.count; i ++ ) bucket.indices.push( baseVertex + iIndex.getX( i ) );
					else for ( let i = 0; i < iPosAttr.count; i ++ ) bucket.indices.push( baseVertex + i );

				}
				return;

			}
			// Alpha-tested cutouts (leaf planes, grass cards) need their
			// material's map + alphaTest in the depth pass; the merged bulk
			// is solid, so merging them would turn lacy foliage into solid
			// quads. They stay as individual (cheap) casters too.
			const mats = Array.isArray( obj.material ) ? obj.material : [ obj.material ];
			if ( mats.some( ( m ) => m && ( m.alphaTest ?? 0 ) > 0 ) ) {

				obj.layers.enable( SHADOW_CAST_LAYER );
				return;

			}
			const geom = obj.geometry;
			const posAttr = geom?.attributes?.position;
			if ( ! posAttr || posAttr.itemSize !== 3 ) return;
			m4.copy( obj.matrixWorld );
			const bucket = bucketAt( m4.elements[ 12 ], m4.elements[ 14 ] );
			const baseVertex = bucket.positions.length / 3;
			for ( let i = 0; i < posAttr.count; i ++ ) {

				v.fromBufferAttribute( posAttr, i ).applyMatrix4( m4 );
				bucket.positions.push( v.x, v.y, v.z );

			}
			const index = geom.index;
			if ( index ) for ( let i = 0; i < index.count; i ++ ) bucket.indices.push( baseVertex + index.getX( i ) );
			else for ( let i = 0; i < posAttr.count; i ++ ) bucket.indices.push( baseVertex + i );

		} );
		return buckets;

	}

	function rebuild() {

		if ( proxy ) {

			scene.remove( proxy );
			proxy.traverse( ( child ) => {

				if ( child.isMesh ) {

					child.geometry.dispose();
					if ( child.material ) child.material.dispose();

				}

			} );

		}
		proxy = new THREE.Group();
		proxy.name = '__staticShadowProxy';
		const buckets = collect();
		// shadowSide DoubleSide: pieces mutated to DoubleSide at runtime
		// (e.g. cross-corner blocks, viewed from inside their opening)
		// must keep casting from both faces. For closed opaque geometry the
		// back faces lose the depth test, so this changes nothing there.
		const material = new THREE.MeshBasicMaterial( { colorWrite: false, depthWrite: false, shadowSide: THREE.DoubleSide } );
		for ( const bucket of buckets.values() ) {

			if ( ! bucket.positions.length ) continue;
			const geom = new THREE.BufferGeometry();
			geom.setAttribute( 'position', new THREE.Float32BufferAttribute( bucket.positions, 3 ) );
			geom.setIndex( bucket.indices );
			geom.computeBoundingSphere();
			const mesh = new THREE.Mesh( geom, material );
			mesh.castShadow = true;
			mesh.receiveShadow = false;
			mesh.layers.set( SHADOW_CAST_LAYER ); // main camera never sees it
			mesh.frustumCulled = true;
			// World-space geometry: the bucket sphere doubles as its cull
			// center for updateCull().
			const sphere = geom.boundingSphere;
			mesh.userData.cullX = sphere.center.x;
			mesh.userData.cullZ = sphere.center.z;
			mesh.userData.cullRadius = sphere.radius;
			proxy.add( mesh );

		}
		scene.add( proxy );
		dirty = false;
		lastBuild = performance.now();
		applyCull();

	}

	// Distance culling of proxy buckets around the gameplay camera. Buckets
	// outside the fog radius can only cast shadows onto fog-swallowed
	// surfaces, so skipping their depth rasterization changes nothing on
	// screen. Cheap: a few hundred squared-distance checks max.
	function applyCull() {

		if ( ! proxy || cullRadius <= 0 ) return;
		for ( const bucket of proxy.children ) {

			const dx = bucket.userData.cullX - cullCenterX;
			const dz = bucket.userData.cullZ - cullCenterZ;
			const rr = cullRadius + bucket.userData.cullRadius + PROXY_BUCKET_SIZE;
			bucket.visible = dx * dx + dz * dz <= rr * rr;

		}

	}

	// Called every frame from the game's cull pass; radii <= 0 disable
	// bucket culling (small maps keep the full-depth behavior exactly).
	function updateCull( x, z, radius ) {

		cullCenterX = x;
		cullCenterZ = z;
		cullRadius = radius;
		applyCull();

	}

	function markDirty() { dirty = true; }

	// Call every frame: rebuilds shortly after edits (debounced) so the
	// merged geometry never lags the world by more than ~quarter second.
	function tick() {

		if ( ! dirty ) return;
		if ( performance.now() - lastBuild < 250 ) return;
		rebuild();

	}

	// Point the sun's depth pass at the cast layer (proxy + dynamics only).
	if ( dirLight ) {

		dirLight.shadow.camera.layers.set( SHADOW_CAST_LAYER );
		dirLight.castShadow = true;

	}

	// First build now.
	rebuild();

	return { rebuild, markDirty, tick, updateCull, get mesh() { return proxy; } };

}
