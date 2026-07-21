import {
	Vector3,
	Matrix4,
	Quaternion,
	Raycaster,
	Group,
	Mesh,
	BoxGeometry,
	CylinderGeometry,
	CircleGeometry,
	MeshLambertMaterial,
	MeshBasicMaterial,
	BufferGeometry,
	MathUtils,
} from 'three';
import { computeBoundsTree, disposeBoundsTree, acceleratedRaycast } from 'three-mesh-bvh';
import { SkaterRig } from './skater.js';
import { SkaterRagdoll } from './ragdoll.js';
import { SkateAudio } from './sound.js';

// Accelerated raycasts against the photogrammetry mesh — a street-level tile
// has tens of thousands of triangles, far too many for per-triangle testing.
BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
Mesh.prototype.raycast = acceleratedRaycast;

export function ensureBVH( object ) {

	object.traverse( ( child ) => {

		if ( child.isMesh && child.geometry && child.geometry.attributes.position && ! child.geometry.boundsTree ) {

			child.geometry.computeBoundsTree();

		}

	} );

}

// --- physics tuning (metres, seconds) --------------------------------------
// Every property is live-tunable from the panel's physics sliders.
export const PHYSICS = {
	gravity: 9.8,       // slope pull projected along the ground plane
	airGravity: 15,     // heavier air gravity for snappy, game-like ollies
	push: 7,            // W acceleration
	maxPush: 14,        // pushing can't exceed this; hills can
	brake: 9,           // S deceleration
	rollFriction: 0.05, // constant rolling resistance
	drag: 0.005,        // quadratic, sets downhill terminal velocity
	grip: 7,            // lateral-slip damping rate — how hard the wheels carve
	turnRate: 2.5,      // steering rate at low speed
	manualTurn: 1.8,    // steering multiplier while manualing on the back wheels
	jump: 5.5,          // ollie pop velocity
	maxSpeed: 50,
	grindWobble: 2.5,   // how aggressively grind balance runs away
	ragdollAt: 7,       // landing speed (m/s) above which a bail tumbles
	bailDecel: 6,       // horizontal speed (m/s) lost inside ~0.1 s that rips the rider off
	driftAfter: 0.7,    // seconds of freefall before the board drifts loose from the rider
	recoverRadius: 0.9, // land with your CoG within this of the wheels → back on the board
	// terrain following
	stepUp: 0.5,        // curbs and small ledges roll over
	snapDown: 1.2,      // stay glued to ground over bumps below this drop
	wallSteep: 0.55,    // steeper than this (normal.y below) = wall, not ramp
	// bail feel
	decelWindow: 0.12,  // seconds of speed memory for the sudden-stop detector
	airControl: 4,      // m/s² of drift-phase steering back toward the board
	recoverDy: 1.2,     // max rider↔board height gap that still counts as landing on it
	bailHop: 3.4,       // upward pop when jumping off voluntarily
	// board feel / animation
	maxLean: 0.30,      // rad of deck roll at full carve
	manualPitch: 0.32,  // rad of nose-up pitch while manualing
	pivotAngle: 40,     // truck pivot-axis inclination (deg) — sets steering geometry
	gripK: 900,         // foot spring stiffness (1/s²) — animation hunker response
	gripD: 32,          // foot spring damping — settles feet back onto the bolts
};

// Panel spec: [ key, label, min, max, step ] rows, with bare strings starting
// a labelled section
export const PHYSICS_CONTROLS = [
	'Ride',
	[ 'gravity', 'Gravity', 0, 30, 0.1 ],
	[ 'push', 'Push', 0, 25, 0.1 ],
	[ 'maxPush', 'Push cap', 1, 40, 0.5 ],
	[ 'brake', 'Brake', 0, 30, 0.5 ],
	[ 'rollFriction', 'Roll fric', 0, 1, 0.005 ],
	[ 'drag', 'Drag', 0, 0.03, 0.0005 ],
	[ 'grip', 'Grip', 0.5, 20, 0.1 ],
	[ 'turnRate', 'Turn', 0.5, 6, 0.05 ],
	[ 'manualTurn', 'Manual turn', 1, 4, 0.05 ],
	[ 'maxSpeed', 'Max speed', 5, 100, 1 ],
	'Air',
	[ 'airGravity', 'Air grav', 0, 40, 0.1 ],
	[ 'jump', 'Ollie', 0, 15, 0.1 ],
	'Terrain',
	[ 'stepUp', 'Step up', 0, 2, 0.05 ],
	[ 'snapDown', 'Snap down', 0, 4, 0.05 ],
	[ 'wallSteep', 'Wall steep', 0, 1, 0.01 ],
	'Grind',
	[ 'grindWobble', 'Wobble', 0, 8, 0.1 ],
	'Bail & recover',
	[ 'bailDecel', 'Bail decel', 1, 15, 0.5 ],
	[ 'decelWindow', 'Decel win', 0.03, 0.5, 0.01 ],
	[ 'driftAfter', 'Drift after', 0.2, 3, 0.05 ],
	[ 'airControl', 'Air steer', 0, 15, 0.5 ],
	[ 'recoverRadius', 'Recover rad', 0.2, 2, 0.05 ],
	[ 'recoverDy', 'Recover ht', 0.2, 4, 0.1 ],
	[ 'ragdollAt', 'Ragdoll at', 1, 20, 0.5 ],
	[ 'bailHop', 'Bail hop', 0, 8, 0.1 ],
	'Board feel',
	[ 'maxLean', 'Carve lean', 0, 0.8, 0.01 ],
	[ 'manualPitch', 'Manual pitch', 0, 0.8, 0.01 ],
	[ 'pivotAngle', 'Truck pivot', 10, 70, 1 ],
	[ 'gripK', 'Foot spring', 100, 3000, 25 ],
	[ 'gripD', 'Foot damp', 5, 80, 1 ],
];

// --- foot grip / bail --------------------------------------------------------
// The feet are spring-coupled to two grip points on the deck purely for
// animation — the stretch feeds the rig's hunker, it never ejects the rider.
// Bails come from dynamics instead: a very sudden horizontal deceleration
// (wall, nose-catch into a slope) rips the rider off into a ragdoll, and a
// long freefall lets the board drift loose — land with your centre of gravity
// roughly over the wheels and you ride away, miss and you tumble or run out.
const GRIP_FRONT = new Vector3( 0, 0.05, 0.16 );  // deck-local grip points,
const GRIP_REAR = new Vector3( 0, 0.05, - 0.22 ); // under the rig's stance
const NO_KEYS = new Set();   // a bailed board takes no input

// --- board / truck kinematics ------------------------------------------------
// Geometry baked into the meshes at build time — not live-tunable
const REAR_AXLE_Z = 0.31;      // pivot distance for the manual pitch
const WHEEL_R = 0.03;

const _fwd = new Vector3();
const _v3 = new Vector3();
const _bf = new Vector3();
const _lat = new Vector3();
const _acc = new Vector3();
const _delta = new Vector3();
const _horiz = new Vector3();
const _n = new Vector3();
const _desired = new Vector3();
const _look = new Vector3();
const _right = new Vector3();
const _railPt = new Vector3();
const _side = new Vector3();
const _m = new Matrix4();
const _q = new Quaternion();
const UP = new Vector3( 0, 1, 0 );
const DOWN = new Vector3( 0, - 1, 0 );

export class SkateMode {

	constructor( { scene, camera, tilesGroup, playArea, park, sea, hud, audio, onExit, onDismount } ) {

		this.scene = scene;
		this.camera = camera;
		this.tilesGroup = tilesGroup;
		this.playArea = playArea;
		this.park = park;
		this.sea = sea; // { level(), surfaceAt(x,z), isWater(x,z) }
		this.hud = hud; // { root, speed, state, balanceWrap, balanceDot }
		this.onExit = onExit;
		this.onDismount = onDismount || null; // ( point, dir, vel ) → continue on foot

		// ramps count as terrain; rails are handled by the grind state instead
		this._rideables = park ? [ tilesGroup, park.rideable ] : [ tilesGroup ];

		this.active = false;
		this.pos = new Vector3();
		this.vel = new Vector3();
		this.yaw = 0;
		this.onGround = true;
		this.manual = false;
		this.grinding = null; // { rail, s, sign, spd }
		this.balance = 0;
		this.balanceVel = 0;
		this.swimming = false;
		this._strokeTimer = 0;
		this.groundNormal = new Vector3( 0, 1, 0 );
		this.lastGroundY = 0;
		this.spawn = new Vector3();
		this.spawnYaw = 0;

		this.keys = new Set();
		this._jumpHeld = false;
		this._visUp = new Vector3( 0, 1, 0 );
		this._saved = null;

		// bail state: null while riding, else { phase: 'drift' | 'flight' |
		// 'ragdoll', pos, vel, yaw, thud } — the board keeps rolling riderless
		// underneath; from 'drift' the rider can still land back on it
		this.bail = null;
		this._ragdoll = null; // built lazily on first bail

		// sudden-stop detector + freefall clock for the bail triggers
		this._refSpeed = 0;              // recent-max horizontal speed, decays
		this._lastVel = new Vector3();   // last step's velocity, for eject direction
		this._fallTime = 0;              // seconds spent falling this airtime

		// foot grip springs: world-space foot points chasing the deck's grips
		this.gripStrain = 0;
		this._gripInit = false;
		this._gripL = new Vector3();
		this._gripR = new Vector3();
		this._footL = { p: new Vector3(), v: new Vector3() };
		this._footR = { p: new Vector3(), v: new Vector3() };

		this._raycaster = new Raycaster();
		this._raycaster.firstHitOnly = true;

		this.audio = audio || new SkateAudio();

		this._buildBoard();

		window.addEventListener( 'keydown', ( e ) => this._onKeyDown( e ) );
		window.addEventListener( 'keyup', ( e ) => this.keys.delete( e.code ) );
		window.addEventListener( 'blur', () => this.keys.clear() );

	}

	// --- visuals -------------------------------------------------------------

	_buildBoard() {

		// hierarchy: board root (ground contact, heading + terrain alignment)
		//   └ deck group (rolls with lean; carries deck, trucks, and rider)
		//       └ hanger groups (rotate about their inclined pivot axes)
		//           └ wheels (spin with travel)
		const board = new Group();
		const deck = new Group();
		deck.position.y = 0.09;
		board.add( deck );

		const deckMat = new MeshLambertMaterial( { color: 0x2b2f3a } );
		const plate = new Mesh( new BoxGeometry( 0.21, 0.013, 0.56 ), deckMat );
		deck.add( plate );

		// nose / tail kicks
		for ( const sign of [ 1, - 1 ] ) {

			const kick = new Mesh( new BoxGeometry( 0.205, 0.013, 0.16 ), deckMat );
			kick.position.set( 0, 0.026, sign * 0.35 );
			kick.rotation.x = - sign * 0.38;
			deck.add( kick );

		}

		const metalMat = new MeshLambertMaterial( { color: 0xb8bcc4 } );
		const wheelMat = new MeshLambertMaterial( { color: 0xf5edd8 } );
		const wheelGeo = new CylinderGeometry( WHEEL_R, WHEEL_R, 0.034, 12 );
		wheelGeo.rotateZ( Math.PI / 2 );

		this.wheels = [];
		this.hangers = {};

		for ( const [ key, sz ] of [ [ 'front', 0.31 ], [ 'rear', - 0.31 ] ] ) {

			const baseplate = new Mesh( new BoxGeometry( 0.09, 0.012, 0.11 ), metalMat );
			baseplate.position.set( 0, - 0.013, sz );
			deck.add( baseplate );

			const hanger = new Group();
			hanger.position.set( 0, - 0.045, sz );
			deck.add( hanger );
			this.hangers[ key ] = hanger;

			const hangerMesh = new Mesh( new BoxGeometry( 0.17, 0.026, 0.035 ), metalMat );
			hanger.add( hangerMesh );

			const axle = new Mesh( new CylinderGeometry( 0.007, 0.007, 0.26, 6 ), metalMat );
			axle.rotation.z = Math.PI / 2;
			hanger.add( axle );

			for ( const sx of [ - 0.115, 0.115 ] ) {

				const wheel = new Mesh( wheelGeo, wheelMat );
				wheel.position.set( sx, - 0.015, 0 );
				hanger.add( wheel );
				this.wheels.push( wheel );

			}

		}

		this.rig = new SkaterRig();
		this.rig.group.position.y = 0.008; // stand on the deck top
		deck.add( this.rig.group );

		this.board = board;
		this.deck = deck;
		this._lean = 0;
		this._pitch = 0;
		this._spin = 0;

		const shadow = new Mesh(
			new CircleGeometry( 0.55, 20 ),
			new MeshBasicMaterial( { color: 0x000000, transparent: true, opacity: 0.35, depthWrite: false } )
		);
		shadow.rotation.x = - Math.PI / 2;
		this.shadow = shadow;

	}

	// --- raycast helpers -------------------------------------------------------

	_groundHit( x, y, z, above, far ) {

		this._raycaster.ray.origin.set( x, y + above, z );
		this._raycaster.ray.direction.copy( DOWN );
		this._raycaster.near = 0;
		this._raycaster.far = far + above;
		const hit = this._raycaster.intersectObjects( this._rideables, true )[ 0 ];
		if ( hit && hit.face ) {

			hit.worldNormal = _n.copy( hit.face.normal )
				.transformDirection( hit.object.matrixWorld );
			if ( hit.worldNormal.y < 0 ) hit.worldNormal.negate();

		}

		return hit;

	}

	// --- mode switching --------------------------------------------------------

	enter( spawnPoint, viewDir, opts = {} ) {

		ensureBVH( this.tilesGroup );

		const hit = this._groundHit( spawnPoint.x, spawnPoint.y, spawnPoint.z, 500, 4000 );
		if ( hit ) {

			this.pos.copy( hit.point );
			this.groundNormal.copy( hit.worldNormal || UP );

		} else {

			this.pos.copy( spawnPoint );
			this.groundNormal.copy( UP );

		}

		this.lastGroundY = this.pos.y;
		this.vel.set( 0, 0, 0 );
		if ( opts.vel ) this.vel.copy( opts.vel ); // momentum carries across modes
		this._refSpeed = 0;
		this._fallTime = 0;
		this._lastVel.copy( this.vel );
		this.yaw = Math.atan2( viewDir.x, viewDir.z );
		this.onGround = true;
		this.spawn.copy( this.pos );
		this.spawnYaw = this.yaw;
		this._visUp.copy( this.groundNormal );

		this.scene.add( this.board, this.shadow );

		// street-level clip planes and closer fog while skating
		const { camera } = this;
		const fog = this.scene.fog;
		this._saved = { near: camera.near, far: camera.far, fogNear: fog.near, fogFar: fog.far };
		camera.near = 0.4;
		camera.far = 60000;
		camera.updateProjectionMatrix();
		fog.near = 9000;
		fog.far = 50000;

		this.active = true;
		this.swimming = false;
		this.audio.start();
		this.hud.root.classList.remove( 'hidden' );
		this._setRideHint();
		if ( document.activeElement ) document.activeElement.blur();

		this._updateCamera( 1, opts.snapCamera !== false );

	}

	exit( silent = false ) {

		if ( ! this.active ) return;

		this._recoverRig();
		this.active = false;
		this.grinding = null;
		this.swimming = false;
		this.audio.setUnderwater( false );
		this.audio.stop();
		this.keys.clear();
		this.scene.remove( this.board, this.shadow );

		const { camera } = this;
		camera.near = this._saved.near;
		camera.far = this._saved.far;
		camera.updateProjectionMatrix();
		this.scene.fog.near = this._saved.fogNear;
		this.scene.fog.far = this._saved.fogFar;

		this.hud.root.classList.add( 'hidden' );
		this.hud.balanceWrap.classList.add( 'hidden' );

		if ( ! silent ) {

			_fwd.set( Math.sin( this.yaw ), 0, Math.cos( this.yaw ) );
			this.onExit( this.pos.clone(), _fwd.clone() );

		}

	}

	respawn() {

		this._recoverRig();
		this.pos.copy( this.spawn );
		this.vel.set( 0, 0, 0 );
		this._refSpeed = 0;
		this._fallTime = 0;
		this._lastVel.set( 0, 0, 0 );
		this.yaw = this.spawnYaw;
		this.onGround = true;
		this.grinding = null;
		this.swimming = false;
		this.audio.setUnderwater( false );
		this._setRideHint();
		this.lastGroundY = this.pos.y;

	}

	_setRideHint() {

		this.hud.hint.textContent =
			'W push · S brake · A/D carve · Shift manual · Space ollie · B bail · E step off · 1 ramp · 2 rail · R respawn · T tune · Esc exit';

	}

	// ground point `dist` metres ahead of the skater — used to place props
	groundPointAhead( dist, out ) {

		_fwd.set( Math.sin( this.yaw ), 0, Math.cos( this.yaw ) );
		const x = this.pos.x + _fwd.x * dist;
		const z = this.pos.z + _fwd.z * dist;
		const hit = this._groundHit( x, this.pos.y, z, 15, 100 );
		return hit ? out.copy( hit.point ) : null;

	}

	_onKeyDown( e ) {

		if ( ! this.active ) return;
		if ( e.target && e.target.tagName === 'INPUT' ) return;

		if ( e.code === 'Escape' ) {

			this.exit();
			return;

		}

		if ( e.code === 'Space' ) e.preventDefault();

		if ( e.code === 'KeyR' ) {

			this.respawn();
			return;

		}

		if ( e.code === 'KeyB' && ! this.bail && ! this.swimming ) {

			this._bailJump();
			return;

		}

		// no steering a board you're no longer on — but while the board is only
		// drifting loose the keys steer the falling body back toward it
		if ( this.bail && this.bail.phase !== 'drift' ) return;
		this.keys.add( e.code );

	}

	// --- main loop ---------------------------------------------------------------

	update( dt ) {

		if ( ! this.active ) return;

		// the board rolls on riderless while the rider is bailed
		const steps = MathUtils.clamp( Math.ceil( dt / 0.02 ), 1, 5 );
		const h = dt / steps;
		for ( let i = 0; i < steps; i ++ ) this._physicsStep( h );

		if ( this.bail ) {

			this._updateBail( dt );
			if ( ! this.active ) return; // stood up into pedestrian mode

		}

		this._updateBoard( dt );
		this._updateAudio( dt );
		this._updateCamera( dt, false );
		this._updateHUD();

	}

	_physicsStep( h ) {

		if ( this.swimming ) {

			this._swimStep( h );
			return;

		}

		if ( this.grinding ) {

			this._grindStep( h );
			return;

		}

		// while bailed the keys steer the drifting rider, never the board
		const keys = this.bail ? NO_KEYS : this.keys;
		const vel = this.vel;
		const speed = vel.length();
		_fwd.set( Math.sin( this.yaw ), 0, Math.cos( this.yaw ) );

		// manual: shift pops the board onto its back wheels while rolling
		const shift = keys.has( 'ShiftLeft' ) || keys.has( 'ShiftRight' );
		this.manual = this.onGround && shift && speed > 0.5;

		// steering — tighter at low speed, looser at high speed, reduced in air;
		// pivoting on the rear wheels turns much tighter
		const turn = ( keys.has( 'KeyA' ) ? 1 : 0 ) - ( keys.has( 'KeyD' ) ? 1 : 0 );
		let turnRate = this.onGround
			? PHYSICS.turnRate / ( 1 + speed / 14 )
			: PHYSICS.turnRate * 0.8;
		if ( this.manual ) turnRate *= PHYSICS.manualTurn;
		this.yaw += turn * turnRate * h;

		if ( this.onGround ) {

			this._applyGroundForces( h, _fwd, speed );

			if ( keys.has( 'Space' ) && ! this._jumpHeld ) {

				vel.y += PHYSICS.jump;
				this.onGround = false;
				this._jumpHeld = true;
				this.audio.jump();

			}

		} else {

			vel.y -= PHYSICS.airGravity * h;

		}

		if ( ! keys.has( 'Space' ) ) this._jumpHeld = false;

		// integrate, blocking horizontal motion into steep faces
		_delta.copy( vel ).multiplyScalar( h );
		_horiz.set( _delta.x, 0, _delta.z );
		const horizDist = _horiz.length();
		if ( horizDist > 1e-6 ) {

			this._raycaster.ray.origin.set( this.pos.x, this.pos.y + 0.4, this.pos.z );
			this._raycaster.ray.direction.copy( _horiz ).divideScalar( horizDist );
			this._raycaster.near = 0;
			this._raycaster.far = horizDist + 0.35;
			const wall = this._raycaster.intersectObjects( this._rideables, true )[ 0 ];
			if ( wall && wall.face ) {

				_n.copy( wall.face.normal ).transformDirection( wall.object.matrixWorld );
				if ( _n.dot( this._raycaster.ray.direction ) > 0 ) _n.negate();
				if ( _n.y < PHYSICS.wallSteep ) {

					// slide along the wall: remove the velocity component into it
					_n.y = 0;
					_n.normalize();
					const into = vel.dot( _n );
					if ( into < 0 ) vel.addScaledVector( _n, - into );
					_delta.copy( vel ).multiplyScalar( h );

				}

			}

		}

		this.pos.add( _delta );

		// stay inside the play area — slide along its edge like a wall
		if ( this.playArea ) this.playArea.constrain( this.pos, vel, 10 );

		// resolve against the ground beneath the new position
		const hit = this._groundHit( this.pos.x, this.pos.y, this.pos.z, this.onGround ? 1.0 : 2.5, 60 );
		if ( hit ) {

			this.lastGroundY = hit.point.y;
			const groundY = hit.point.y;

			// the segmented sea is not rigid: rolling or falling onto it swims
			// (unless the rider has bailed — a riderless board just stops)
			if ( ! this.bail && this._isSeaSurface( groundY ) ) {

				if ( this.onGround || this.pos.y <= groundY + 0.3 ) {

					this._enterSwim( Math.max( - vel.y, 0 ) );
					return;

				}

			} else if ( this.onGround ) {

				const dy = groundY - this.pos.y;
				if ( dy >= - PHYSICS.snapDown && dy <= PHYSICS.stepUp ) {

					this.pos.y = groundY; // glued: bumps, curbs, rolling terrain
					if ( hit.worldNormal ) this.groundNormal.lerp( hit.worldNormal, 0.35 ).normalize();

				} else if ( dy < - PHYSICS.snapDown ) {

					this.onGround = false; // rolled off a drop

				}

			} else if ( this.pos.y <= groundY ) {

				// touchdown: kill the velocity component into the surface
				this.pos.y = groundY;
				const n = hit.worldNormal || UP;
				const vn = vel.dot( n );
				if ( vn < 0 ) vel.addScaledVector( n, - vn );
				this.groundNormal.copy( n );
				this.onGround = true;
				this.audio.land( - vn );

			}

		}

		// airborne over a rail? lock onto it (not without a rider aboard)
		if ( ! this.onGround && this.park && ! this.bail ) this._tryGrind();

		// --- bail triggers, only while the board is actually ridden ---
		if ( ! this.bail && ! this.grinding && ! this.swimming ) {

			// sudden-stop detector: a reference speed that rises instantly but
			// decays over decelWindow — a gap means speed vanished abruptly.
			// Braking (~9 m/s²) leaves a gap of ~1; a wall or nose-catch spikes it.
			const hs = Math.hypot( vel.x, vel.z );
			if ( hs >= this._refSpeed ) this._refSpeed = hs;
			else this._refSpeed += ( hs - this._refSpeed ) * Math.min( 1, h / PHYSICS.decelWindow );

			if ( this._refSpeed - hs > PHYSICS.bailDecel ) {

				// the body keeps a slice of the speed the board just lost
				_v3.set(
					vel.x + ( this._lastVel.x - vel.x ) * 0.35,
					Math.max( vel.y, 0 ) + 2.5,
					vel.z + ( this._lastVel.z - vel.z ) * 0.35
				);
				this._bailRagdoll( _v3 );

			} else if ( this.onGround ) {

				this._fallTime = 0;

			} else {

				// long freefall: past the threshold the board drifts loose and
				// the rider has to chase it back down
				if ( vel.y < 0 ) this._fallTime += h;
				if ( this._fallTime > PHYSICS.driftAfter ) this._startDrift();

			}

			this._lastVel.copy( vel );

		}

		// fell off the mesh entirely
		if ( this.pos.y < this.lastGroundY - 400 ) this.respawn();

	}

	// --- swimming ----------------------------------------------------------------

	// is this ground height actually the sea surface here?
	_isSeaSurface( groundY ) {

		if ( ! this.sea ) return false;
		const sl = this.sea.level();
		if ( sl === null ) return false;
		return Math.abs( groundY - sl ) < 1.2 && this.sea.isWater( this.pos.x, this.pos.z );

	}

	_enterSwim( impact ) {

		this.swimming = true;
		this.grinding = null;
		this.manual = false;
		this.onGround = false;
		this._strokeTimer = 0;
		this.audio.splash( impact );
		this.hud.hint.textContent =
			'W swim · Space rise / leap out · Shift dive · A/D turn · S brake · R respawn · Esc bail';

	}

	_leaveSwim() {

		this.swimming = false;
		this.audio.setUnderwater( false );
		this._refSpeed = 0;
		this._fallTime = 0;
		this._setRideHint();

	}

	_swimStep( h ) {

		const { keys, vel } = this;
		const seaLevel = this.sea.level();
		if ( seaLevel === null ) {

			this._leaveSwim();
			return;

		}

		const speed = vel.length();
		const turn = ( keys.has( 'KeyA' ) ? 1 : 0 ) - ( keys.has( 'KeyD' ) ? 1 : 0 );
		this.yaw += turn * 2.2 / ( 1 + speed / 8 ) * h;
		_fwd.set( Math.sin( this.yaw ), 0, Math.cos( this.yaw ) );

		if ( keys.has( 'KeyW' ) ) vel.addScaledVector( _fwd, 6 * h );
		if ( keys.has( 'KeyS' ) && speed > 0.01 ) vel.multiplyScalar( Math.max( 0, 1 - 6 * h / speed ) );
		if ( keys.has( 'Space' ) ) vel.y += 8 * h;
		if ( keys.has( 'ShiftLeft' ) || keys.has( 'ShiftRight' ) ) vel.y -= 8 * h;

		vel.y += 2.2 * h;                            // buoyancy
		vel.multiplyScalar( Math.exp( - 1.1 * h ) ); // water drag

		this.pos.addScaledVector( vel, h );
		if ( this.playArea ) this.playArea.constrain( this.pos, vel, 10 );

		// seabed matches the visual basin depth
		const floor = seaLevel - 6.0;
		if ( this.pos.y < floor ) {

			this.pos.y = floor;
			if ( vel.y < 0 ) vel.y = 0;

		}

		// surface: float and bob on the waves, or breach with enough speed
		const surface = this.sea.surfaceAt( this.pos.x, this.pos.z ) - 0.15;
		if ( this.pos.y >= surface ) {

			if ( vel.y > 3.2 ) {

				this._leaveSwim();
				vel.y = Math.max( vel.y, 4.2 ); // leap clear of the water
				this.audio.splash( 2.5 );
				return;

			}

			this.pos.y = surface;
			if ( vel.y > 0 ) vel.y = 0;

		}

		// shore rises above sea level → climb out and ride
		const hit = this._groundHit( this.pos.x, this.pos.y, this.pos.z, 3, 12 );
		if ( hit && hit.point.y > seaLevel + 0.15 && hit.point.y > this.pos.y - 0.5 &&
			! this.sea.isWater( this.pos.x, this.pos.z ) ) {

			this.pos.y = hit.point.y;
			this.groundNormal.copy( hit.worldNormal || UP );
			this._leaveSwim();
			this.onGround = true;
			this.audio.splash( 1 );
			return;

		}

		this.lastGroundY = floor;
		this.audio.setUnderwater( this.pos.y < seaLevel - 0.6 );

		// paddle strokes while pushing forward
		if ( keys.has( 'KeyW' ) ) {

			this._strokeTimer -= h;
			if ( this._strokeTimer <= 0 ) {

				this.audio.stroke();
				this._strokeTimer = 0.85;

			}

		}

	}

	// --- grinding ----------------------------------------------------------------

	_tryGrind() {

		if ( this.vel.y > 2.5 ) return; // still rising from the ollie

		for ( const rail of this.park.rails ) {

			const s = MathUtils.clamp(
				_railPt.subVectors( this.pos, rail.p0 ).dot( rail.dir ), 0, rail.len );
			_railPt.copy( rail.p0 ).addScaledVector( rail.dir, s );

			const horiz = Math.hypot( this.pos.x - _railPt.x, this.pos.z - _railPt.z );
			const dy = this.pos.y - _railPt.y;
			if ( horiz > 0.45 || dy < - 0.15 || dy > 0.6 ) continue;

			const along = this.vel.dot( rail.dir );
			if ( Math.abs( along ) < 1.2 ) continue; // crossing, not riding

			const sign = Math.sign( along );
			this.grinding = { rail, s, sign, spd: Math.abs( along ) };
			this._refSpeed = 0; // locking on sheds speed by design, not by crash
			this._fallTime = 0;
			this.balance = ( Math.random() - 0.5 ) * 0.4; // land slightly off-center
			this.balanceVel = 0;
			this.yaw = Math.atan2( rail.dir.x * sign, rail.dir.z * sign );
			this.audio.grindStart();
			return;

		}

	}

	_grindStep( h ) {

		const g = this.grinding;
		const { keys, vel } = this;

		// balance is an inverted pendulum: it runs away on its own and gets
		// kicked by noise — A/D push it back
		const turn = ( keys.has( 'KeyA' ) ? 1 : 0 ) - ( keys.has( 'KeyD' ) ? 1 : 0 );
		const wobble = PHYSICS.grindWobble;
		this.balanceVel += (
			this.balance * wobble * 1.6 +
			( Math.random() - 0.5 ) * wobble * 1.4 +
			turn * 5
		) * h;
		this.balanceVel *= Math.exp( - 1.2 * h );
		this.balance += this.balanceVel * h;

		// grind friction + gravity along a (possibly sloped) rail
		g.spd -= ( 0.4 + PHYSICS.gravity * g.rail.dir.y * g.sign ) * h;
		g.s += g.sign * g.spd * h;

		_railPt.copy( g.rail.p0 ).addScaledVector( g.rail.dir, MathUtils.clamp( g.s, 0, g.rail.len ) );
		this.pos.copy( _railPt );
		this.pos.y += 0.07; // wheels perched on the bar
		this.lastGroundY = this.pos.y - 0.55;
		vel.copy( g.rail.dir ).multiplyScalar( g.sign * g.spd );

		// ollie off
		if ( keys.has( 'Space' ) && ! this._jumpHeld ) {

			this._jumpHeld = true;
			this._endGrind();
			vel.y += PHYSICS.jump;
			this.audio.jump();
			return;

		}
		if ( ! keys.has( 'Space' ) ) this._jumpHeld = false;

		// lost it: bucked off sideways — the rider goes flying
		if ( Math.abs( this.balance ) > 1 ) {

			_side.crossVectors( vel, UP ).normalize();
			this._endGrind();
			_v3.copy( vel ).addScaledVector( _side, - Math.sign( this.balance ) * 3 );
			_v3.y += 1.5;
			vel.multiplyScalar( 0.4 ); // the board clatters on without you
			this._bailRagdoll( _v3 );
			return;

		}

		// rolled off either end, or stalled out
		if ( g.s < 0 || g.s > g.rail.len || g.spd < 0.8 ) this._endGrind();

	}

	_endGrind() {

		this.grinding = null;
		this.balance = 0;
		this.balanceVel = 0;
		this.onGround = false;
		this._refSpeed = 0;
		this._fallTime = 0;

	}

	// --- foot grip + bail ---------------------------------------------------------

	// Spring-integrate the two foot points toward the deck's grip targets and
	// measure the stretch. Run after the board transform is posed for the frame.
	_updateGrip( dt ) {

		if ( this.bail || this.swimming ) {

			this.gripStrain = 0;
			this._gripInit = false;
			return;

		}

		this.deck.updateWorldMatrix( true, false );
		this._gripL.copy( GRIP_FRONT );
		this._gripR.copy( GRIP_REAR );
		this.deck.localToWorld( this._gripL );
		this.deck.localToWorld( this._gripR );

		if ( ! this._gripInit ) {

			this._footL.p.copy( this._gripL );
			this._footR.p.copy( this._gripR );
			this._footL.v.copy( this.vel );
			this._footR.v.copy( this.vel );
			this._gripInit = true;

		}

		// gravity matches the phase of motion so the feet only lag under real
		// shocks, not from the game's heavier-than-life air gravity
		const g = this.onGround ? PHYSICS.gravity : PHYSICS.airGravity;

		const steps = MathUtils.clamp( Math.ceil( dt / 0.02 ), 1, 5 );
		const h = dt / steps;
		for ( let i = 0; i < steps; i ++ ) {

			for ( const [ foot, grip ] of [ [ this._footL, this._gripL ], [ this._footR, this._gripR ] ] ) {

				_v3.subVectors( grip, foot.p ).multiplyScalar( PHYSICS.gripK );
				_v3.addScaledVector( foot.v, - PHYSICS.gripD );
				_v3.y -= g;
				foot.v.addScaledVector( _v3, h );
				foot.p.addScaledVector( foot.v, h );

			}

		}

		this.gripStrain = Math.max(
			this._footL.p.distanceTo( this._gripL ),
			this._footR.p.distanceTo( this._gripR )
		);

	}

	// hand the rig to the scene in place, so the body leaves the board.
	// keys survive on purpose — the drift phase steers with them; hard bails
	// clear them at their own call sites.
	_detachRig() {

		this.scene.attach( this.rig.group );
		this.grinding = null;
		this.manual = false;
		this.gripStrain = 0;
		this._gripInit = false;

	}

	// put the rig back on the deck in its riding attachment
	_recoverRig() {

		if ( ! this.bail ) return;

		this.deck.add( this.rig.group );
		this.rig.group.position.set( 0, 0.008, 0 );
		this.rig.group.quaternion.identity();
		this.rig.joint( 'hips' ).position.set( 0, 0.78, 0 );
		this.bail = null;
		this._refSpeed = 0; // fresh detector state for the new ride
		this._fallTime = 0;

	}

	// B: leap off the board feet-first. Land slow and you run it out; land
	// fast and you ragdoll — the board rolls on without you either way.
	_bailJump() {

		this._detachRig();
		this.keys.clear();

		const speed = Math.hypot( this.vel.x, this.vel.z );
		this.bail = {
			phase: 'flight',
			pos: _v3.copy( this.pos ).addScaledVector( this._visUp, 0.1 ).clone(),
			vel: this.vel.clone().setY( this.vel.y + PHYSICS.bailHop ),
			yaw: this.yaw,
			thud: 0,
		};
		this.bail.vel.addScaledVector( _fwd.set( Math.sin( this.yaw ), 0, Math.cos( this.yaw ) ), speed > 1 ? 0.5 : 0 );
		this.audio.jump();
		this.hud.hint.textContent = 'airborne — land slow to run it out · R respawn';

	}

	// a long freefall: rider and board part ways mid-air. Not a bail yet —
	// steer the body over the wheels before touchdown and you ride away.
	_startDrift() {

		this._detachRig();

		this.bail = {
			phase: 'drift',
			pos: _v3.copy( this.pos ).addScaledVector( this._visUp, 0.1 ).clone(),
			vel: this.vel.clone(),
			yaw: this.yaw,
			thud: 0,
		};

		// the board wanders sideways, harder the faster you were going
		const speed = Math.hypot( this.vel.x, this.vel.z );
		_fwd.set( Math.sin( this.yaw ), 0, Math.cos( this.yaw ) );
		_side.crossVectors( _fwd, UP );
		this.vel.addScaledVector( _side, ( Math.random() < 0.5 ? - 1 : 1 ) * ( 0.5 + speed * 0.06 ) );

		this.hud.hint.textContent = 'board’s loose — W/A/S/D steer over the wheels to ride it out · R respawn';

	}

	// involuntary: straight to ragdoll with the given ejection velocity
	_bailRagdoll( ejectVel ) {

		if ( this.bail && this.bail.phase === 'ragdoll' ) return;

		const wasAirborne = !! this.bail;
		if ( ! wasAirborne ) this._detachRig();
		this.keys.clear();

		if ( ! this._ragdoll ) {

			this._ragdoll = new SkaterRagdoll( ( x, y, z, above, far ) => this._groundHit( x, y, z, above, far ) );

		}

		// tumble about the lateral axis so speed reads as a somersault
		const speed = ejectVel.length();
		_fwd.set( Math.sin( this.yaw ), 0, Math.cos( this.yaw ) );
		_side.crossVectors( UP, _fwd );
		_side.multiplyScalar( MathUtils.clamp( speed * 0.45, 1.5, 9 ) );

		this._ragdoll.init( this.rig, ejectVel, _side );
		this.bail = { phase: 'ragdoll', pos: null, vel: null, yaw: this.yaw, thud: 0 };
		this.audio.land( Math.min( speed * 0.4, 4 ) );
		this.hud.hint.textContent = 'ragdolling — R respawn';

	}

	_updateBail( dt ) {

		const b = this.bail;

		if ( b.phase === 'flight' || b.phase === 'drift' ) {

			// drift only: nudge the falling body back toward the runaway board
			if ( b.phase === 'drift' ) {

				const { keys } = this;
				const along = ( keys.has( 'KeyW' ) ? 1 : 0 ) - ( keys.has( 'KeyS' ) ? 1 : 0 );
				const strafe = ( keys.has( 'KeyD' ) ? 1 : 0 ) - ( keys.has( 'KeyA' ) ? 1 : 0 );
				_fwd.set( Math.sin( b.yaw ), 0, Math.cos( b.yaw ) );
				_side.crossVectors( _fwd, UP );
				b.vel.addScaledVector( _fwd, along * PHYSICS.airControl * dt );
				b.vel.addScaledVector( _side, strafe * PHYSICS.airControl * dt );

			}

			// ballistic body, feet-first, arms windmilling
			b.vel.y -= PHYSICS.airGravity * dt;
			b.pos.addScaledVector( b.vel, dt );
			if ( this.playArea ) this.playArea.constrain( b.pos, b.vel, 10 );

			const rig = this.rig;
			rig.group.position.copy( b.pos );
			rig.group.quaternion.setFromAxisAngle( UP, b.yaw );
			rig.update( dt, { bailing: true, grounded: false, speed: b.vel.length(), lean: 0 } );

			const hit = this._groundHit( b.pos.x, b.pos.y, b.pos.z, 2, 20 );
			if ( hit && b.pos.y <= hit.point.y ) {

				b.pos.y = hit.point.y;
				const impact = b.vel.length();

				// came down over the wheels? back on the board, ride away
				if ( b.phase === 'drift' && this._recoverLanding( b, impact ) ) return;

				if ( impact > PHYSICS.ragdollAt ) {

					this._bailRagdoll( b.vel ); // came in too hot

				} else {

					this.audio.land( Math.min( impact * 0.5, 3 ) );
					this._standUp( hit.point, b.vel );

				}

			}

			return;

		}

		// ragdoll phase
		const rd = this._ragdoll;
		rd.update( dt );
		rd.poseRig( this.rig );

		// bounce thuds, throttled so a slide doesn't machine-gun the audio
		b.thud -= dt;
		if ( rd.impact > 3 && b.thud <= 0 ) {

			this.audio.land( Math.min( rd.impact * 0.4, 3.5 ) );
			b.thud = 0.25;

		}

		if ( rd.settled ) {

			const p = rd.pelvis;
			const hit = this._groundHit( p.x, p.y + 1, p.z, 2, 20 );
			this._standUp( hit ? hit.point : _v3.set( p.x, p.y - 0.5, p.z ), null );

		}

	}

	// drift touchdown: the body's CoG came down — if it's roughly over the
	// wheels, snap back onto the deck and keep the ride, sketchier the further
	// off-centre the landing was
	_recoverLanding( b, impact ) {

		const dx = b.pos.x - this.pos.x;
		const dz = b.pos.z - this.pos.z;
		const d = Math.hypot( dx, dz );
		if ( d > PHYSICS.recoverRadius ) return false;
		if ( Math.abs( b.pos.y - this.pos.y ) > PHYSICS.recoverDy ) return false; // board's still falling / already gone

		// the ride continues at the faster of body / board pace
		const boardH = Math.hypot( this.vel.x, this.vel.z );
		const bodyH = Math.hypot( b.vel.x, b.vel.z );
		if ( bodyH > boardH ) {

			if ( boardH > 0.5 ) {

				const k = bodyH / boardH;
				this.vel.x *= k;
				this.vel.z *= k;

			} else {

				this.vel.x = b.vel.x;
				this.vel.z = b.vel.z;

			}

		}

		// sell the near-miss: scrub speed and dip the deck toward the side you hit
		const sketch = d / PHYSICS.recoverRadius;
		const pen = 1 - 0.25 * sketch;
		this.vel.x *= pen;
		this.vel.z *= pen;
		if ( d > 1e-3 ) {

			_fwd.set( Math.sin( this.yaw ), 0, Math.cos( this.yaw ) );
			_side.crossVectors( _fwd, UP );
			this._lean += ( ( dx * _side.x + dz * _side.z ) / d ) * 0.4 * sketch;

		}

		this._recoverRig();
		this.audio.land( Math.min( impact * 0.5, 3 ) );
		this._setRideHint();
		return true;

	}

	// back on your feet: hand off to pedestrian mode with whatever momentum
	// survived, or — with no handoff wired — remount the board where you stand
	_standUp( point, vel ) {

		// clone up front — point may arrive in a shared scratch vector
		const at = point.clone();
		const carry = vel ? new Vector3( vel.x, 0, vel.z ) : new Vector3();

		_fwd.set( Math.sin( this.yaw ), 0, Math.cos( this.yaw ) );
		if ( vel && Math.hypot( vel.x, vel.z ) > 0.5 ) _fwd.set( vel.x, 0, vel.z ).normalize();

		this._recoverRig();

		if ( this.onDismount ) {

			const dir = _fwd.clone();
			this.exit( true );
			this.onDismount( at, dir, carry );

		} else {

			this.pos.copy( at );
			this.vel.set( 0, 0, 0 );
			this.onGround = true;
			this._setRideHint();

		}

	}

	_applyGroundForces( h, fwd, speed ) {

		const vel = this.vel;
		const keys = this.bail ? NO_KEYS : this.keys; // drift keys steer the body only
		const n = this.groundNormal;

		// gravity projected onto the ground plane — hills accelerate you
		_acc.copy( DOWN ).addScaledVector( n, n.y );
		vel.addScaledVector( _acc, PHYSICS.gravity * h );

		// board forward projected onto the ground plane
		_bf.copy( fwd ).addScaledVector( n, - fwd.dot( n ) ).normalize();

		// carve: wheels grip sideways, roll freely forward
		const vF = vel.dot( _bf );
		_lat.copy( vel ).addScaledVector( _bf, - vF );
		_lat.multiplyScalar( Math.exp( - PHYSICS.grip * h ) );
		vel.copy( _lat ).addScaledVector( _bf, vF );

		if ( keys.has( 'KeyW' ) && vF < PHYSICS.maxPush ) {

			vel.addScaledVector( _bf, PHYSICS.push * h );

		}

		if ( keys.has( 'KeyS' ) && speed > 0.01 ) {

			vel.multiplyScalar( Math.max( 0, 1 - ( PHYSICS.brake * h ) / speed ) );

		}

		// rolling resistance + aero drag
		const sp = vel.length();
		if ( sp > 0.001 ) {

			const decel = ( PHYSICS.rollFriction + PHYSICS.drag * sp * sp ) * h;
			vel.multiplyScalar( Math.max( 0, 1 - decel / sp ) );

		}

		if ( sp > PHYSICS.maxSpeed ) vel.multiplyScalar( PHYSICS.maxSpeed / sp );

	}

	// --- presentation ------------------------------------------------------------

	_updateBoard( dt ) {

		const targetUp = this.onGround ? this.groundNormal : UP;
		this._visUp.lerp( targetUp, 1 - Math.exp( - 8 * dt ) ).normalize();

		_fwd.set( Math.sin( this.yaw ), 0, Math.cos( this.yaw ) );
		_bf.copy( _fwd ).addScaledVector( this._visUp, - _fwd.dot( this._visUp ) ).normalize();
		_right.crossVectors( this._visUp, _bf );
		_m.makeBasis( _right, this._visUp, _bf );
		_q.setFromRotationMatrix( _m );

		this.board.quaternion.slerp( _q, 1 - Math.exp( - 14 * dt ) );
		this.board.position.copy( this.pos );

		// deck roll from steering input, scaled up with speed; while grinding
		// the roll is the balance wobble itself; a bailed board takes no input
		const turn = this.bail ? 0
			: ( this.keys.has( 'KeyA' ) ? 1 : 0 ) - ( this.keys.has( 'KeyD' ) ? 1 : 0 );
		const speed = this.vel.length();
		const leanTarget = this.grinding
			? this.balance * PHYSICS.maxLean * 1.3
			: this.onGround
				? turn * Math.min( speed / 9, 1 ) * PHYSICS.maxLean
				: turn * PHYSICS.maxLean * 0.4;
		this._lean += ( leanTarget - this._lean ) * ( 1 - Math.exp( - 7 * dt ) );
		this.deck.rotation.z = this._lean;

		// manual: pitch the deck nose-up, pivoting on the rear axle — the root
		// rises so the back wheels stay planted while the front ones lift.
		// swimming: the nose follows the dive/climb direction instead
		const pitchTarget = this.swimming
			? MathUtils.clamp( this.vel.y * 0.12, - 0.5, 0.5 )
			: this.manual ? PHYSICS.manualPitch : 0;
		this._pitch += ( pitchTarget - this._pitch ) * ( 1 - Math.exp( - 10 * dt ) );
		this.deck.rotation.x = - this._pitch;
		this.board.position.addScaledVector( this._visUp, Math.sin( this._pitch ) * REAR_AXLE_Z );

		// Truck kinematics. The pivot axes are inclined at pivotAngle from
		// horizontal, pointing toward the board's center (front tips back, rear
		// tips forward). When the deck rolls by φ each hanger rotates about its
		// axis by ρ = atan(tan φ / cos λ) — the unique angle that keeps the
		// axle parallel to the ground — yawing the front axle into the turn and
		// the rear out of it. Rebuilt each frame so the panel angle applies live.
		const lam = MathUtils.degToRad( PHYSICS.pivotAngle );
		const sinP = Math.sin( lam );
		const cosP = Math.cos( lam );
		const rho = Math.atan( Math.tan( this._lean ) / cosP );
		this.hangers.front.quaternion.setFromAxisAngle( _v3.set( 0, sinP, - cosP ), rho );
		this.hangers.rear.quaternion.setFromAxisAngle( _v3.set( 0, sinP, cosP ), - rho );

		// wheel spin from signed forward travel
		if ( this.onGround ) {

			const vF = this.vel.dot( _bf );
			this._spin += ( vF / WHEEL_R ) * dt;
			for ( const w of this.wheels ) w.rotation.x = this._spin;

		}

		// foot grip springs chase the freshly posed deck — animation only,
		// the stretch feeds the rig's hunker
		this._updateGrip( dt );

		// rider animation — while bailed the rig is posed by drift / flight / ragdoll
		if ( ! this.bail ) {

			this.rig.update( dt, {
				grounded: this.onGround,
				speed,
				swimming: this.swimming,
				grinding: !! this.grinding,
				manual: this.manual,
				pushing: this.onGround && this.keys.has( 'KeyW' ),
				braking: this.onGround && this.keys.has( 'KeyS' ) && speed > 0.3,
				lean: this._lean,
				gripStrain: this.gripStrain,
			} );

		}

		// contact shadow fades with height
		const height = Math.max( 0, this.pos.y - this.lastGroundY );
		this.shadow.position.set( this.pos.x, this.lastGroundY + 0.05, this.pos.z );
		this.shadow.material.opacity = 0.35 / ( 1 + height * 0.6 );
		const s = 1 / ( 1 + height * 0.25 );
		this.shadow.scale.set( s, s, s );

	}

	_updateAudio( dt ) {

		const speed = this.vel.length();

		// lateral slip: horizontal velocity not aligned with the board heading —
		// the grip force that makes a carve is also what makes it heard
		_fwd.set( Math.sin( this.yaw ), 0, Math.cos( this.yaw ) );
		_horiz.set( this.vel.x, 0, this.vel.z );
		const slip = _horiz.addScaledVector( _fwd, - _horiz.dot( _fwd ) ).length();

		this.audio.update( dt, {
			grounded: this.onGround,
			grinding: !! this.grinding,
			speed,
			slip,
			pushing: ! this.bail && this.onGround && this.keys.has( 'KeyW' ),
			braking: ! this.bail && this.onGround && this.keys.has( 'KeyS' ) && speed > 0.3,
		} );

	}

	_updateCamera( dt, snap ) {

		// while bailed the camera stays with the body, not the runaway board
		const focus = ! this.bail ? this.pos
			: this.bail.phase === 'ragdoll' ? this._ragdoll.pelvis : this.bail.pos;

		const speed = this.vel.length();
		_fwd.set( Math.sin( this.yaw ), 0, Math.cos( this.yaw ) );

		// tight framing on the board and rider, easing back with speed
		const dist = 3.3 + speed * 0.10;
		_desired.copy( focus )
			.addScaledVector( _fwd, - dist )
			.setY( focus.y + 1.6 + speed * 0.03 );

		// keep the camera above the terrain behind the skater
		const g = this._groundHit( _desired.x, _desired.y, _desired.z, 6, 30 );
		if ( g && _desired.y < g.point.y + 0.55 ) _desired.y = g.point.y + 0.55;

		if ( snap ) {

			this.camera.position.copy( _desired );

		} else {

			this.camera.position.lerp( _desired, 1 - Math.exp( - 5.5 * dt ) );

		}

		_look.copy( focus ).addScaledVector( _fwd, this.bail ? 0.3 : 1.4 );
		_look.y += this.bail ? 0.5 : 1.05;
		this.camera.lookAt( _look );

	}

	_updateHUD() {

		const mph = Math.round( this.vel.length() * 2.237 );
		this.hud.speed.textContent = mph;
		this.hud.state.textContent = this.bail
			? ( this.bail.phase === 'drift' ? 'DRIFT'
				: this.bail.phase === 'flight' ? 'BAIL' : 'RAGDOLL' )
			: this.swimming
				? ( this.sea && this.pos.y < this.sea.level() - 0.6 ? 'DIVE' : 'SWIM' )
				: this.grinding ? 'GRIND'
					: ! this.onGround ? 'AIR'
						: this.manual ? 'MANUAL' : '';

		this.hud.balanceWrap.classList.toggle( 'hidden', ! this.grinding );
		if ( this.grinding ) {

			this.hud.balanceDot.style.left = `${ 50 - this.balance * 45 }%`;
			this.hud.balanceDot.classList.toggle( 'danger', Math.abs( this.balance ) > 0.65 );

		}

	}

}
