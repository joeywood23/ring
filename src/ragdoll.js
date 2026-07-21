import { Vector3, Quaternion, Matrix4 } from 'three';

// Verlet ragdoll for the skater. Fifteen point masses matching the rig's
// joints, stick constraints for the bones plus cross-braces that keep the
// chunky torso a box, relaxed a few times per substep. The ground is a local
// plane raycast under the body each step — smooth photogrammetry makes that a
// good fit. poseRig() maps the particle skeleton back onto the visual rig by
// swinging each bone from its bind direction toward its particle pair, so the
// same low-poly character that rides the board also tumbles — and because the
// rig's own update keeps damping joint rotations toward the ride pose, simply
// resuming it after a ragdoll plays a free "getting up" blend.

// Live-tunable from the panel's sliders, like PHYSICS in skate.js — every
// property is read fresh each step
export const RAGDOLL = {
	gravity: 9.8,
	iterations: 5,     // constraint relaxation passes per substep — stiffness
	airDamp: 0.995,    // per-step velocity keep; lower = more air drag
	friction: 0.6,     // fraction of tangential motion lost per ground contact
	bounce: 0.25,
	radius: 0.06,      // particle rest height above the ground plane
	settleSpeed: 0.55, // everything slower than this counts as at rest…
	settleTime: 0.5,   // …for this long → settled, get up
	maxTime: 5,        // give up and get up even if still twitching
};

// Panel spec: [ key, label, min, max, step ] rows, bare strings start a section
export const RAGDOLL_CONTROLS = [
	'Ragdoll',
	[ 'gravity', 'Gravity', 0, 30, 0.1 ],
	[ 'iterations', 'Stiffness', 1, 12, 1 ],
	[ 'airDamp', 'Air damp', 0.9, 1, 0.001 ],
	[ 'friction', 'Friction', 0, 1, 0.01 ],
	[ 'bounce', 'Bounce', 0, 1, 0.01 ],
	[ 'radius', 'Body radius', 0.01, 0.2, 0.005 ],
	[ 'settleSpeed', 'Settle spd', 0.1, 2, 0.05 ],
	[ 'settleTime', 'Settle time', 0.1, 2, 0.05 ],
	[ 'maxTime', 'Get up after', 1, 10, 0.5 ],
];

// where each particle sits on the rig: joint name + local offset
const CAPTURE = {
	pelvis: [ 'hips', 0, 0, 0 ],
	chest: [ 'torso', 0, 0.37, 0 ],
	head: [ 'head', 0, 0.10, 0 ],
	shoulderL: [ 'armL', 0, 0, 0 ],
	elbowL: [ 'armLFore', 0, 0, 0 ],
	handL: [ 'armLFore', 0, - 0.26, 0 ],
	shoulderR: [ 'armR', 0, 0, 0 ],
	elbowR: [ 'armRFore', 0, 0, 0 ],
	handR: [ 'armRFore', 0, - 0.26, 0 ],
	hipL: [ 'legL', 0, 0, 0 ],
	kneeL: [ 'legLShin', 0, 0, 0 ],
	footL: [ 'legLFoot', 0, - 0.03, 0.05 ],
	hipR: [ 'legR', 0, 0, 0 ],
	kneeR: [ 'legRShin', 0, 0, 0 ],
	footR: [ 'legRFoot', 0, - 0.03, 0.05 ],
};

// bones first, then the braces that stop the trunk from folding flat
const STICKS = [
	[ 'pelvis', 'chest' ], [ 'chest', 'head' ],
	[ 'chest', 'shoulderL' ], [ 'shoulderL', 'elbowL' ], [ 'elbowL', 'handL' ],
	[ 'chest', 'shoulderR' ], [ 'shoulderR', 'elbowR' ], [ 'elbowR', 'handR' ],
	[ 'pelvis', 'hipL' ], [ 'hipL', 'kneeL' ], [ 'kneeL', 'footL' ],
	[ 'pelvis', 'hipR' ], [ 'hipR', 'kneeR' ], [ 'kneeR', 'footR' ],
	[ 'shoulderL', 'shoulderR' ], [ 'hipL', 'hipR' ],
	[ 'pelvis', 'shoulderL' ], [ 'pelvis', 'shoulderR' ],
	[ 'chest', 'hipL' ], [ 'chest', 'hipR' ],
	[ 'head', 'shoulderL' ], [ 'head', 'shoulderR' ],
];

const _v = new Vector3();
const _w = new Vector3();
const _dir = new Vector3();
const _x = new Vector3();
const _y = new Vector3();
const _z = new Vector3();
const _m = new Matrix4();
const _qA = new Quaternion();
const _qB = new Quaternion();
const _qC = new Quaternion();
const _qD = new Quaternion();
const Y_UP = new Vector3( 0, 1, 0 );
const Y_DOWN = new Vector3( 0, - 1, 0 );

export class SkaterRagdoll {

	// groundHit( x, y, z, above, far ) → raycast hit with .point / .worldNormal
	constructor( groundHit ) {

		this._groundHit = groundHit;

		this.p = {}; // particle positions by name
		this._prev = {};
		for ( const name in CAPTURE ) {

			this.p[ name ] = new Vector3();
			this._prev[ name ] = new Vector3();

		}

		this._sticks = STICKS.map( ( [ a, b ] ) => ( { a, b, rest: 0.1 } ) );

		this._planePt = new Vector3();
		this._planeN = new Vector3( 0, 1, 0 );

		this.settled = false;
		this.impact = 0;   // peak contact speed this update, for thud audio
		this._settleT = 0;
		this._elapsed = 0;

	}

	get pelvis() {

		return this.p.pelvis;

	}

	// Capture the current rig pose as the starting skeleton. velocity is the
	// body's linear velocity; tumble is a world angular velocity so bails at
	// speed somersault instead of falling flat.
	init( rig, velocity, tumble ) {

		rig.group.updateWorldMatrix( true, true );

		for ( const name in CAPTURE ) {

			const [ joint, x, y, z ] = CAPTURE[ name ];
			rig.joint( joint ).localToWorld( this.p[ name ].set( x, y, z ) );

		}

		for ( const s of this._sticks ) {

			s.rest = Math.max( this.p[ s.a ].distanceTo( this.p[ s.b ] ), 0.02 );

		}

		// per-particle velocity = linear + tumble × r, folded into prev
		for ( const name in CAPTURE ) {

			const p = this.p[ name ];
			_v.copy( velocity );
			if ( tumble ) _v.add( _w.crossVectors( tumble, _dir.subVectors( p, this.p.pelvis ) ) );
			this._prev[ name ].copy( p ).addScaledVector( _v, - 1 / 60 );

		}

		this._planePt.copy( this.p.pelvis );
		this._planePt.y -= 0.8;
		this._planeN.set( 0, 1, 0 );

		this.settled = false;
		this._settleT = 0;
		this._elapsed = 0;
		this.impact = 0;

	}

	update( dt ) {

		if ( this.settled ) return;

		this.impact = 0;
		const steps = Math.min( Math.max( Math.ceil( dt / 0.016 ), 1 ), 6 );
		const h = dt / steps;
		for ( let i = 0; i < steps; i ++ ) this._step( h );

	}

	_step( h ) {

		this._elapsed += h;

		// local ground plane under the trunk
		const hit = this._groundHit( this.p.chest.x, this.p.chest.y, this.p.chest.z, 2.5, 30 );
		if ( hit ) {

			this._planePt.copy( hit.point );
			if ( hit.worldNormal ) this._planeN.copy( hit.worldNormal );

		}

		// integrate
		const gh2 = RAGDOLL.gravity * h * h;
		let maxV = 0;
		for ( const name in this.p ) {

			const p = this.p[ name ];
			const prev = this._prev[ name ];
			_v.subVectors( p, prev ).multiplyScalar( RAGDOLL.airDamp );
			maxV = Math.max( maxV, _v.length() / h );
			prev.copy( p );
			p.add( _v );
			p.y -= gh2;

		}

		// relax constraints, colliding as we go so limbs settle onto the plane
		for ( let iter = 0; iter < RAGDOLL.iterations; iter ++ ) {

			for ( const s of this._sticks ) {

				const a = this.p[ s.a ];
				const b = this.p[ s.b ];
				_dir.subVectors( b, a );
				const d = _dir.length();
				if ( d < 1e-6 ) continue;
				const corr = ( d - s.rest ) / d * 0.5;
				a.addScaledVector( _dir, corr );
				b.addScaledVector( _dir, - corr );

			}

			this._collide( h );

		}

		// settled = everything slow for a beat, or we've tumbled long enough
		if ( maxV < RAGDOLL.settleSpeed ) this._settleT += h;
		else this._settleT = 0;
		if ( this._settleT > RAGDOLL.settleTime || this._elapsed > RAGDOLL.maxTime ) this.settled = true;

	}

	_collide( h ) {

		const n = this._planeN;
		const pt = this._planePt;

		for ( const name in this.p ) {

			const p = this.p[ name ];
			const depth = RAGDOLL.radius - _dir.subVectors( p, pt ).dot( n );
			if ( depth <= 0 ) continue;

			const prev = this._prev[ name ];
			_v.subVectors( p, prev ); // motion this step

			p.addScaledVector( n, depth );

			// split motion into normal + tangent, bounce one, rub out the other
			const vn = _v.dot( n );
			_w.copy( n ).multiplyScalar( vn );      // normal part
			_v.sub( _w );                           // tangential part
			prev.copy( p )
				.addScaledVector( _w, RAGDOLL.bounce )
				.addScaledVector( _v, - ( 1 - RAGDOLL.friction ) );

			if ( vn < 0 ) this.impact = Math.max( this.impact, - vn / h );

		}

	}

	// --- mapping the particles back onto the visual rig --------------------------

	// child world orientation = swing(parent's bind direction → bone direction)
	// applied on top of the parent; written to the joint as a local quaternion
	_aim( joint, parentWorldQ, bindDir, from, to, outWorldQ ) {

		_dir.subVectors( this.p[ to ], this.p[ from ] );
		if ( _dir.lengthSq() < 1e-8 ) {

			outWorldQ.copy( parentWorldQ );

		} else {

			_v.copy( bindDir ).applyQuaternion( parentWorldQ );
			_qD.setFromUnitVectors( _v, _dir.normalize() );
			outWorldQ.copy( _qD ).multiply( parentWorldQ );

		}

		joint.quaternion.copy( parentWorldQ ).invert().multiply( outWorldQ );

	}

	// Pose the rig from the particle skeleton. The rig group must be a direct
	// child of the scene with an identity transform — poseRig writes the hips
	// joint in world space and every other joint relative to its parent.
	poseRig( rig ) {

		const J = ( n ) => rig.joint( n );
		const P = this.p;

		rig.group.position.set( 0, 0, 0 );
		rig.group.quaternion.identity();

		// hips frame: spine up, left→right hip across
		_y.subVectors( P.chest, P.pelvis ).normalize();
		_x.subVectors( P.hipR, P.hipL ).normalize();
		_z.crossVectors( _x, _y ).normalize();
		_x.crossVectors( _y, _z );
		_m.makeBasis( _x, _y, _z );
		_qA.setFromRotationMatrix( _m ); // hips world

		const hips = J( 'hips' );
		hips.position.copy( P.pelvis );
		hips.quaternion.copy( _qA );

		// spine + head
		this._aim( J( 'torso' ), _qA, Y_UP, 'chest', 'head', _qB ); // torso world → _qB
		J( 'head' ).quaternion.identity();

		// arms hang from the torso frame along -Y in bind pose
		this._aim( J( 'armL' ), _qB, Y_DOWN, 'shoulderL', 'elbowL', _qC );
		this._aim( J( 'armLFore' ), _qC, Y_DOWN, 'elbowL', 'handL', _qD );
		this._aim( J( 'armR' ), _qB, Y_DOWN, 'shoulderR', 'elbowR', _qC );
		this._aim( J( 'armRFore' ), _qC, Y_DOWN, 'elbowR', 'handR', _qD );

		// legs hang from the hips frame
		this._aim( J( 'legL' ), _qA, Y_DOWN, 'hipL', 'kneeL', _qC );
		this._aim( J( 'legLShin' ), _qC, Y_DOWN, 'kneeL', 'footL', _qD );
		J( 'legLFoot' ).quaternion.identity();
		this._aim( J( 'legR' ), _qA, Y_DOWN, 'hipR', 'kneeR', _qC );
		this._aim( J( 'legRShin' ), _qC, Y_DOWN, 'kneeR', 'footR', _qD );
		J( 'legRFoot' ).quaternion.identity();

	}

}
