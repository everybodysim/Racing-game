import * as THREE from 'three';

// Static shadow proxy: merges every castShadow mesh under a root group into
// ONE invisible mesh that still casts real shadows in the sun's depth pass.
// The depth pass uses an override material, so per-mesh materials don't
// matter — only geometry. This collapses thousands of shadow draw calls into
// one, letting the sun's shadow map re-render EVERY frame (fully dynamic
// real shadows for cars/movers) at a fraction of the old cost.
//
// Layer contract (SHADOW_CAST_LAYER = 9):
//   - proxy lives ONLY on layer 9 → never rendered by the main camera.
//   - dynamic casters (cars, moving obstacles) enable layer 9 in addition
//     to layer 0 → visible normally AND present in the depth pass.
//   - the sun's shadow camera enables layer 9 only → individual static
//     meshes are skipped in the depth pass (the proxy carries them);
//     sources keep castShadow=true so rebuilds stay idempotent.

export const SHADOW_CAST_LAYER = 9;

export function createShadowProxyController( scene, rootGroup, dirLight ) {

	let proxy = null;
	let dirty = false;
	let lastBuild = - 1e9;

	// Three.js needs the addon? No — do the merge by hand so this module
	// works everywhere without importmap addon paths: concatenate world-
	// space positions + indices of every static caster under rootGroup.
	function collect() {

		const positions = [];
		const indices = [];
		const v = new THREE.Vector3();
		const m4 = new THREE.Matrix4();
		rootGroup.updateMatrixWorld( true );
		rootGroup.traverse( ( obj ) => {

			if ( ! ( obj.isMesh && obj.castShadow ) ) return;
			if ( obj.layers.mask !== 1 ) return; // layer-0-only = static source; skip proxies/dynamics
			// Instanced casters (forest/bush/grass decoration) keep their own
			// draw in the depth pass: their per-instance transforms live in
			// instanceMatrix, which a merge would drop (one un-instanced copy
			// instead of every tree). An InstancedMesh is already ONE draw,
			// so this costs nothing — it just renders with its real material
			// (alpha-tested leaves etc.) like the original pipeline.
			if ( obj.isInstancedMesh ) {

				obj.layers.enable( SHADOW_CAST_LAYER );
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
			const baseVertex = positions.length / 3;
			for ( let i = 0; i < posAttr.count; i ++ ) {

				v.fromBufferAttribute( posAttr, i ).applyMatrix4( m4 );
				positions.push( v.x, v.y, v.z );

			}
			const index = geom.index;
			if ( index ) for ( let i = 0; i < index.count; i ++ ) indices.push( baseVertex + index.getX( i ) );
			else for ( let i = 0; i < posAttr.count; i ++ ) indices.push( baseVertex + i );

		} );
		return { positions, indices };

	}

	function rebuild() {

		if ( proxy ) {

			scene.remove( proxy );
			proxy.geometry.dispose();
			proxy.material.dispose();
			proxy = null;

		}
		const { positions, indices } = collect();
		if ( ! positions.length ) { dirty = false; lastBuild = performance.now(); return; }
		const geom = new THREE.BufferGeometry();
		geom.setAttribute( 'position', new THREE.Float32BufferAttribute( positions, 3 ) );
		geom.setIndex( indices );
		geom.computeBoundingSphere();
		// shadowSide DoubleSide: pieces mutated to DoubleSide at runtime
		// (e.g. cross-corner blocks, viewed from inside their opening)
		// must keep casting from both faces. For closed opaque geometry the
		// back faces lose the depth test, so this changes nothing there.
		proxy = new THREE.Mesh( geom, new THREE.MeshBasicMaterial( { colorWrite: false, depthWrite: false, shadowSide: THREE.DoubleSide } ) );
		proxy.castShadow = true;
		proxy.receiveShadow = false;
		proxy.layers.set( SHADOW_CAST_LAYER ); // main camera never sees it
		proxy.frustumCulled = true;
		proxy.name = '__staticShadowProxy';
		scene.add( proxy );
		dirty = false;
		lastBuild = performance.now();

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

	return { rebuild, markDirty, tick, get mesh() { return proxy; } };

}
