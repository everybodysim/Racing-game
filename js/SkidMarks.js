import * as THREE from 'three';

const _tmpPos = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _rgt = new THREE.Vector3();
const _wa = new THREE.Vector3();
const _wb = new THREE.Vector3();

const SKID_TEX_SIZE = 64;
const SKID_LIFE_MIN = 2.2;
const SKID_LIFE_MAX = 3.6;
const SKID_FADE_TIME = 0.7;
const SKID_ALPHA_MIN = 0.16;
const SKID_ALPHA_MAX = 0.60;
const SETTLE_TIME = 0.05;

function mulberry32( seed ) {
    let t = seed |  0;
    return () => {
        t += 0x6D2B79F5;
        let x = t;
        x = Math.imul( x ^ ( x >>> 15 ), x | 1 );
        x ^= x + Math.imul( x ^ ( x >>> 7 ), x | 61 );
        return ( ( x ^ ( x >>> 14 ) ) >>>  0 ) / 4294967296;
    };
}

function makeSkidTexture() {
    const canvas = document.createElement( 'canvas' );
    canvas.width = SKID_TEX_SIZE;
    canvas.height = Math.max( 4, Math.floor( SKID_TEX_SIZE / 4 ) );
    const ctx = canvas.getContext( '2d' );
    if ( ! ctx ) return null;
    ctx.clearRect( 0, 0, canvas.width, canvas.height );
    const midY = canvas.height / 2;
    const grad = ctx.createLinearGradient( 0, 0, canvas.width, 0 );
    grad.addColorStop( 0, 'rgba(0,0,0,0)' );
    grad.addColorStop( 0.12,'rgba(215,210,205,1)' );
    grad.addColorStop( 0.88,'rgba(215,210,205,1)' );
    grad.addColorStop( 1,'rgba(0,0,0,0)' );
    ctx.fillStyle = grad;
    const bandH = Math.max( 2, Math.floor( canvas.height * 0.38 ) );
    ctx.fillRect( 0, midY - bandH / 2, canvas.width, bandH );
    const tex = new THREE.CanvasTexture( canvas );
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    return tex;
}

export class SkidMarks {
    constructor( scene, options = {} ) {
        this.scene = scene;
        this.marks = [];
        this.maxMarks = THREE.MathUtils.clamp( Math.floor( Number( options.maxMarks ) || 950 ), 200, 1600 );
        this.emitStep = Math.max( 0.012, Number( options.emitStep ) || 0.02 );
        this.emitAccumulator = 0;
        this.emitIndex = 0;
        this.hashSeed = Math.floor( ( Math.random() * 1e9 ) ^ ( Date.now() % 1e9 ) );
        this.texture = makeSkidTexture();
        this.material = new THREE.MeshBasicMaterial( {
            map: this.texture,
            transparent: true,
            depthWrite: false,
            depthTest: true,
            polygonOffset: true,
            polygonOffsetFactor: -2,
            polygonOffsetUnits: -4,
            side: THREE.DoubleSide,
            renderOrder: 10,
        } );
    }

    get activeCount() { return this.marks.length; }

    setQuality( options = {} ) {
		this.maxMarks = THREE.MathUtils.clamp( Math.floor( Number( options.maxMarks ) || this.maxMarks ), 200, 1600 );
    }

    clear() {
        for ( const entry of this.marks ) this._disposeEntry( entry );
        this.marks.length = 0;
        this.emitIndex = 0;
        this.emitAccumulator = 0;
    }

    _disposeEntry( entry ) {
        if ( ! entry ) return;
        if ( entry.group?.parent ) entry.group.parent.remove( entry.group );
        if ( entry.mesh?.geometry ) entry.mesh.geometry.dispose();
        if ( entry.material ) entry.material.dispose();
    }

    _rearMidPoint( vehicle, out ) {
        let hit = 0;
        if ( vehicle.wheelBL && vehicle.wheelBR ) {
            vehicle.wheelBL.getWorldPosition( _wa );
            vehicle.wheelBR.getWorldPosition( _wb );
            out.addVectors( _wa, _wb ).multiplyScalar( 0.5 );
            hit = 1;
        }
        if ( ! hit ) out.set( vehicle.spherePos.x, vehicle.container.position.y, vehicle.spherePos.z );
        out.y = vehicle.container.position.y +  0.06;
        return out;
    }

    _spawnMark( pos, yaw, intensity, speedNorm ) {
        const rnd = mulberry32( ( this.hashSeed + this.emitIndex * 587 ) | 0 );
        const g = ( () => {
            const u = Math.max( 1e-6, rnd() );
            const v = rnd();
            return Math.sqrt( -2 * Math.log( u ) ) * Math.cos( 2 * Math.PI * v );
        } ) ();
        const widthFactor = THREE.MathUtils.clamp( 0.8 + g * 0.18,  0.5,  1.35 );
        const halfW = ( 0.11 + intensity *  0.13 + rnd() * 0.06 ) * widthFactor;
        const halfL = 0.07 + rnd() * 0.05 + speedNorm *  0.03;
        const baseAlpha = SKID_ALPHA_MIN + ( intensity * ( SKID_ALPHA_MAX - SKID_ALPHA_MIN ) ) * ( 0.75 + rnd() * 0.5 );
        const life = SKID_LIFE_MIN + rnd() * ( SKID_LIFE_MAX - SKID_LIFE_MIN );
        const yawJitter = ( rnd() - 0.5 ) * 0.14;

        const group = new THREE.Group();
        group.rotation.order = 'YXZ';
        group.rotation.y = yaw + yawJitter;

        const plane = new THREE.PlaneGeometry( Math.max( 0.08, halfL * 2 ), Math.max( 0.08, halfW * 2 ) );
        plane.rotateX( - Math.PI / 2 );
        const mat = this.material.clone();
        mat.opacity = THREE.MathUtils.clamp( baseAlpha, 0, 1 );
        mat._skidBaseOpacity = baseAlpha;

        const mesh = new THREE.Mesh( plane, mat );
        mesh.scale.setScalar( 0.85 + rnd() * 0.3 );
        group.add( mesh );
        this.scene.add( group );
        return { group, mesh, material: mat, life, maxLife: life };
    }

    _emitAt( pos, yaw, intensity, speedNorm ) {
        const next = this._spawnMark( pos, yaw, intensity, speedNorm );
        let replaced = null;
        if ( this.marks.length >= this.maxMarks ) {

            replaced = this.marks[ this.emitIndex ];
            this.marks[ this.emitIndex ] = next;

        } else {

            this.marks.push( next );
        }
        this.emitIndex = ( this.emitIndex +  1 ) % this.maxMarks;

        if ( replaced ) this._disposeEntry( replaced );
    }
    _computeEmit( veh, deltaYaw ) {
        if ( ! veh?.rigidBody || ! veh?.container ) return;
        if ( veh.container?.visible === false ) return;
        // Teleport interlock: the living interlock on the Vehicle (decremented on
        // their own physics update) covers the two frames of the actual jump. The
        // contact gate is the caller real collision signal (car rigid body contactCount), so
        // marks are only placed while genuinely colliding - never from height or settling.
        if ( veh.teleportInterlock > 0 ) return;

        const drift = veh.driftIntensity || 0;
        // Instantaneous world speed of the colliding sphere (NOT smoothed linearSpeed,
        // which lingers during/after airborne coasting).
        const speed = Math.hypot(
            veh.sphereVel?.x ||  0,
            veh.sphereVel?.y ||  0,
            veh.sphereVel?.z ||  0
        );
        const speedNorm = THREE.MathUtils.clamp( speed / Math.max( 0.01, veh.topSpeed ||  1 ), 0, 1.6 );
        // Drift gate driven by the game own drift intensity (lateral slide of the
        // model computed each physics frame from actual motion) - plus steering
        // load and hard braking while contact. No height / no airborne slip.
        const braking = veh.inputZ < - 0.25 && speedNorm >  0.22 ? Math.min( 1, speedNorm *  1.2 ) :  0;
        const intensity = THREE.MathUtils.clamp(
            drift *  0.9 + Math.abs( veh.inputX ||  0 ) * speedNorm *  0.18 + braking *  0.45,
            0,  1
        );
        if ( intensity <  0.08 || speedNorm <  0.08 ) return;
        // Sprinkle so streaks dont collapse into one solid painted strip..
        if ( Math.random() > (  0.25 + intensity *  0.45 ) ) return;
        _fwd.set( 0, 0, 1 ).applyQuaternion( veh.container.quaternion ).setY( 0 ).normalize();
        this._rearMidPoint( veh, _tmpPos );
        const yaw = Math.atan2( _fwd.x, _fwd.z ) + ( deltaYaw ||  0 );
        this._emitAt( _tmpPos, yaw, intensity, speedNorm );
    }

    _tickCar( veh, contact, deltaYaw, dt ) {
        if ( ! veh?.container ) return;
        if ( veh.container?.visible === false ) return;
        if ( ! contact ) {
            this.emitAccumulator = 0;
            return;
        }
        this.emitAccumulator += dt;
        if ( this.emitAccumulator < this.emitStep ) return;
        this.emitAccumulator = 0;
        this._computeEmit( veh, deltaYaw );
    }

    update( dt, cars ) {
        // Passive fade + expiry: marks slowly fade out instead of lingering forever..
        const fadeStart = Math.max( 0.01, SKID_FADE_TIME );
        let i = this.marks.length;
        while ( i-- ) {
            const entry = this.marks[ i ];
            entry.life -= dt;
            if ( entry.life <= 0 ) {
                this.marks.splice( i, 1 );
                this._disposeEntry( entry );
                continue;
            }
            const fadeT = THREE.MathUtils.clamp( entry.life / entry.maxLife,  0,  1 );
            let lifeOp = 1;
            const fadeL = entry.maxLife * fadeT;
            if ( fadeL < fadeStart ) {
                lifeOp = Math.max(  0, fadeL / fadeStart );
            }
            entry.material.opacity = entry.material._skidBaseOpacity * lifeOp;

        }
        if ( ! cars?.length ) return;
        for ( const spec of cars ) {
            const veh = spec.veh;
            const contact = spec.contact;
            if ( ! veh ) continue;
            this._tickCar( veh, contact, spec.deltaYaw ||  0, spec.dt ||  dt );
        }
    }
};
