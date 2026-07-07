import {
	Group,
	Mesh,
	BoxGeometry,
	SphereGeometry,
	MeshLambertMaterial,
	MathUtils,
} from 'three';

// Procedurally animated low-poly rider. The rig is a plain Object3D joint
// hierarchy; every frame a target pose is composed (cruise base + push cycle /
// brake / air overrides + lean overlay) and each joint is exponentially damped
// toward it, so mode changes blend smoothly without an animation system.
//
// Conventions: rig origin sits on the deck top, +Z is the board's nose,
// +Y up. The skater rides regular (left foot forward). Joint rotations are
// Euler XYZ; "pitch" is x, "yaw" is y, "roll" is z.

const SKIN = new MeshLambertMaterial( { color: 0xc9a184 } );
const SHIRT = new MeshLambertMaterial( { color: 0x37474f } );
const PANTS = new MeshLambertMaterial( { color: 0x263238 } );
const SHOE = new MeshLambertMaterial( { color: 0xeceff1 } );
const HAIR = new MeshLambertMaterial( { color: 0x3e2c23 } );

const DAMP_RATE = 12;
const PUSH_RATE = 1.35; // push strokes per second

function box( parent, mat, w, h, d, x, y, z ) {

	const m = new Mesh( new BoxGeometry( w, h, d ), mat );
	m.position.set( x, y, z );
	parent.add( m );
	return m;

}

export class SkaterRig {

	constructor() {

		this.group = new Group();
		this._pushPhase = 0;
		this._joints = {};
		this._targets = {};
		this._hipsTarget = { y: 0.78, z: 0 };
		this._build();

	}

	_joint( parent, name, x, y, z ) {

		const g = new Group();
		g.position.set( x, y, z );
		parent.add( g );
		this._joints[ name ] = g;
		this._targets[ name ] = { x: 0, y: 0, z: 0 };
		return g;

	}

	_build() {

		const J = ( n ) => this._joints[ n ];

		// pelvis root — legs are siblings of the torso chain
		const hips = this._joint( this.group, 'hips', 0, 0.78, 0 );
		box( hips, PANTS, 0.26, 0.15, 0.15, 0, 0.02, 0 );

		const torso = this._joint( hips, 'torso', 0, 0.10, 0 );
		box( torso, SHIRT, 0.30, 0.40, 0.17, 0, 0.21, 0 );

		const head = this._joint( torso, 'head', 0, 0.44, 0 );
		const skull = new Mesh( new SphereGeometry( 0.095, 12, 10 ), SKIN );
		skull.position.y = 0.1;
		head.add( skull );
		box( head, HAIR, 0.16, 0.08, 0.17, 0, 0.16, - 0.01 );

		// arms hang along -Y from the shoulders
		for ( const [ name, sx ] of [ [ 'armL', - 0.19 ], [ 'armR', 0.19 ] ] ) {

			const upper = this._joint( torso, name, sx, 0.37, 0 );
			box( upper, SHIRT, 0.09, 0.30, 0.09, 0, - 0.13, 0 );
			const fore = this._joint( upper, name + 'Fore', 0, - 0.28, 0 );
			box( fore, SKIN, 0.075, 0.26, 0.075, 0, - 0.12, 0 );

		}

		// legs hang along -Y from the hips
		for ( const [ name, sx ] of [ [ 'legL', - 0.09 ], [ 'legR', 0.09 ] ] ) {

			const thigh = this._joint( hips, name, sx, - 0.05, 0 );
			box( thigh, PANTS, 0.115, 0.40, 0.12, 0, - 0.19, 0 );
			const shin = this._joint( thigh, name + 'Shin', 0, - 0.40, 0 );
			box( shin, PANTS, 0.10, 0.36, 0.10, 0, - 0.17, 0 );
			const foot = this._joint( shin, name + 'Foot', 0, - 0.36, 0 );
			box( foot, SHOE, 0.10, 0.06, 0.26, 0, - 0.03, 0.05 );

		}

		// riding stance baked as the neutral: body faces off-axis, front
		// (left) foot over the front bolts, back foot on the tail
		J( 'legL' ).position.z = 0.16;
		J( 'legR' ).position.z = - 0.22;

	}

	// ---------------------------------------------------------------------------

	update( dt, state ) {

		const T = this._targets;
		const hips = this._hipsTarget;
		const lean = state.lean; // deck roll, + = leaning left

		// --- cruise base pose ---
		this._zeroTargets();
		hips.y = 0.76;
		hips.z = 0;
		set( T.hips, 0.10, - 0.85, 0 );        // slight forward crouch, side stance
		set( T.torso, 0.12, 0.35, 0 );         // shoulders opened back toward travel
		set( T.head, - 0.08, 0.55, 0 );        // eyes down the road
		set( T.legL, - 0.18, 0.75, 0 );        // front foot angled toward the nose
		set( T.legLShin, 0.35, 0, 0 );
		set( T.legLFoot, - 0.14, - 0.25, 0 );
		set( T.legR, - 0.22, 0.35, 0 );        // back foot across the tail
		set( T.legRShin, 0.42, 0, 0 );
		set( T.legRFoot, - 0.17, - 0.85, 0 );
		set( T.armL, 0.15, 0, - 0.28 );
		set( T.armLFore, - 0.35, 0, 0 );
		set( T.armR, 0.10, 0, 0.30 );
		set( T.armRFore, - 0.30, 0, 0 );

		// --- mode overrides ---
		if ( ! state.grounded ) {

			this._poseAir( T, hips );

		} else if ( state.braking ) {

			this._poseBrake( T, hips );

		} else if ( state.pushing ) {

			this._pushPhase = ( this._pushPhase + dt * PUSH_RATE ) % 1;
			this._posePush( T, hips, this._pushPhase );

		} else {

			this._pushPhase = 0.9; // re-enter the cycle near foot-return

		}

		// --- lean overlay (applies in every mode) ---
		if ( Math.abs( lean ) > 0.001 ) {

			T.hips.z += lean * 0.85;           // whole body banks into the turn
			T.torso.z += lean * 0.35;
			T.head.z -= lean * 0.7;            // head stays near vertical
			T.armL.z += - 0.45 * lean;         // arms flare for balance
			T.armR.z += - 0.45 * lean;
			T.hips.y += lean * 0.15;           // slight twist through the hips

		}

		// --- damped application ---
		const k = 1 - Math.exp( - DAMP_RATE * dt );
		for ( const name in this._joints ) {

			const j = this._joints[ name ];
			const t = T[ name ];
			j.rotation.x += ( t.x - j.rotation.x ) * k;
			j.rotation.y += ( t.y - j.rotation.y ) * k;
			j.rotation.z += ( t.z - j.rotation.z ) * k;

		}

		const hipJoint = this._joints.hips;
		hipJoint.position.y += ( hips.y - hipJoint.position.y ) * k;
		hipJoint.position.z += ( hips.z - hipJoint.position.z ) * k;

	}

	_zeroTargets() {

		for ( const name in this._targets ) set( this._targets[ name ], 0, 0, 0 );

	}

	// deep crouch, board tucked up under the feet
	_poseAir( T, hips ) {

		hips.y = 0.62;
		set( T.hips, 0.30, - 0.85, 0 );
		set( T.torso, 0.25, 0.35, 0 );
		set( T.legL, - 0.95, 0.75, 0 );
		set( T.legLShin, 1.25, 0, 0 );
		set( T.legLFoot, - 0.35, - 0.25, 0 );
		set( T.legR, - 1.0, 0.35, 0 );
		set( T.legRShin, 1.35, 0, 0 );
		set( T.legRFoot, - 0.35, - 0.85, 0 );
		set( T.armL, - 0.4, 0, - 0.9 );
		set( T.armLFore, - 0.5, 0, 0 );
		set( T.armR, - 0.4, 0, 0.9 );
		set( T.armRFore, - 0.5, 0, 0 );

	}

	// weight back, back foot heel dragging beside the tail
	_poseBrake( T, hips ) {

		hips.y = 0.70;
		hips.z = - 0.06;
		set( T.hips, - 0.12, - 0.85, 0 );
		set( T.torso, - 0.15, 0.40, 0 );
		set( T.head, 0.02, 0.55, 0 );
		set( T.legL, - 0.45, 0.75, 0 );        // front knee soaks up the weight
		set( T.legLShin, 0.75, 0, 0 );
		set( T.legLFoot, - 0.28, - 0.25, 0 );
		set( T.legR, 0.35, 0.35, 0 );          // back leg extends off the tail
		set( T.legRShin, 0.15, 0, 0 );
		set( T.legRFoot, 0.55, - 0.85, 0 );    // heel pitched down onto the ground
		set( T.armL, 0.75, 0, - 0.35 );        // arms forward for balance
		set( T.armLFore, - 0.25, 0, 0 );
		set( T.armR, 0.55, 0, 0.45 );
		set( T.armRFore, - 0.30, 0, 0 );

	}

	// cyclic kick: back foot reaches down, sweeps back, recovers
	_posePush( T, hips, p ) {

		const tau = p * Math.PI * 2;

		// stroke envelope: 1 while the foot is on the ground pushing
		const stroke = MathUtils.smoothstep( Math.sin( tau ), - 0.2, 0.5 );
		// swing: +1 reaching forward, -1 swept back
		const swing = Math.cos( tau );

		// front leg carries the body, bobbing with the stroke
		hips.y = 0.76 - 0.10 * stroke;
		set( T.hips, 0.22 + 0.06 * stroke, - 0.85, 0 );
		set( T.torso, 0.18, 0.35, 0 );
		set( T.legL, - 0.30 - 0.25 * stroke, 0.75, 0 );
		set( T.legLShin, 0.55 + 0.35 * stroke, 0, 0 );
		set( T.legLFoot, - 0.22 - 0.12 * stroke, - 0.25, 0 );

		// back leg does the kicking, mostly aligned with travel
		const reach = 0.55 * swing;
		set( T.legR, - 0.15 + reach * stroke + ( 1 - stroke ) * - 0.45, 0.1, 0 );
		set( T.legRShin, ( 1 - stroke ) * 0.9 + stroke * 0.15, 0, 0 );
		set( T.legRFoot, - 0.1, - 0.3, 0 );

		// counter-swing in the arms
		set( T.armL, 0.25 - 0.25 * swing * stroke, 0, - 0.35 );
		set( T.armLFore, - 0.4, 0, 0 );
		set( T.armR, 0.15 + 0.30 * swing * stroke, 0, 0.35 );
		set( T.armRFore, - 0.35, 0, 0 );

	}

}

function set( t, x, y, z ) {

	t.x = x;
	t.y = y;
	t.z = z;

}
