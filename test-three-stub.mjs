// Minimal THREE stub — just enough surface for SkidMarks.js unit tests.
// Not used by the game; only imported by Node tests through the loader hook
// in test-three-resolve.mjs. If SkidMarks.js starts using more THREE APIs,
// extend the stub here (and add a regression test that fails on gaps).

export const DynamicDrawUsage = 1;

export const MathUtils = {
	clamp: ( value, min, max ) => Math.min( max, Math.max( min, value ) ),
};

export class Color {

	constructor( value ) { this.value = value; }

}

export class Vector3 {

	constructor( x = 0, y = 0, z = 0 ) { this.x = x; this.y = y; this.z = z; }
	set( x, y, z ) { this.x = x; this.y = y; this.z = z; return this; }
	copy( v ) { this.x = v.x; this.y = v.y; this.z = v.z; return this; }
	clone() { return new Vector3( this.x, this.y, this.z ); }
	addScaledVector( v, s ) { this.x += v.x * s; this.y += v.y * s; this.z += v.z * s; return this; }
	addVectors( a, b ) { this.x = a.x + b.x; this.y = a.y + b.y; this.z = a.z + b.z; return this; }
	subVectors( a, b ) { this.x = a.x - b.x; this.y = a.y - b.y; this.z = a.z - b.z; return this; }
	multiplyScalar( s ) { this.x *= s; this.y *= s; this.z *= s; return this; }
	divideScalar( s ) { this.x /= s; this.y /= s; this.z /= s; return this; }
	lengthSq() { return this.x * this.x + this.y * this.y + this.z * this.z; }
	length() { return Math.sqrt( this.lengthSq() ); }
	normalize() { const l = this.length() || 1; return this.divideScalar( l ); }
	cross( v ) {

		const x = this.y * v.z - this.z * v.y;
		const y = this.z * v.x - this.x * v.z;
		const z = this.x * v.y - this.y * v.x;
		this.x = x; this.y = y; this.z = z;
		return this;

	}
	crossVectors( a, b ) {

		this.x = a.y * b.z - a.z * b.y;
		this.y = a.z * b.x - a.x * b.z;
		this.z = a.x * b.y - a.y * b.x;
		return this;

	}
	applyQuaternion() { return this; } // identity in tests

}

export class Quaternion {}

export class Matrix4 {

	constructor() { this.elements = new Float32Array( 16 ); this._positionSet = null; }
	makeScale( x, y, z ) { this._scale = [ x, y, z ]; return this; }
	makeBasis( x, y, z ) { this._basis = [ x, y, z ]; return this; }
	setPosition( v ) { this._positionSet = new Vector3( v.x, v.y, v.z ); return this; }

}

export class Box3 {

	setFromObject() { return this; }
	getSize( target ) { target.set( 0.4, 0.4, 0.4 ); return target; }

}

export class PlaneGeometry {

	constructor( w = 1, h = 1 ) { this.w = w; this.h = h; }
	rotateX() { return this; }

}

export class MeshBasicMaterial {

	constructor( opts = {} ) { this.opts = opts; }

}

export class InstancedMesh {

	constructor( geometry, material, count ) {

		this.geometry = geometry;
		this.material = material;
		this.count = count;
		this.frustumCulled = true;
		this.renderOrder = 0;
		this.matrices = [];
		this.instanceMatrix = { setUsage() {}, needsUpdate: false };

	}
	setMatrixAt( i, m ) {

		this.matrices[ i ] = m;

	}

}
