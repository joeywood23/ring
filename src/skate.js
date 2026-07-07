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
const GRAV_SLOPE = 9.8;    // gravity projected along the ground plane
const GRAV_AIR = 15;       // heavier air gravity for snappy, game-like ollies
const PUSH_ACCEL = 5.5;    // W
const MAX_PUSH_SPEED = 12; // pushing can't exceed this; hills can
const BRAKE = 9;           // S
const ROLL_FRICTION = 0.35;
const DRAG = 0.012;        // quadratic, sets downhill terminal velocity
const GRIP = 7;            // lateral-slip damping rate — how hard the wheels carve
const JUMP_SPEED = 5.5;
const MAX_SPEED = 32;
const STEP_UP = 0.5;       // curbs and small ledges roll over
const SNAP_DOWN = 1.2;     // stay glued to ground over bumps below this drop
const WALL_NORMAL_Y = 0.55; // steeper than this (normal.y below) = wall, not ramp

// --- board / truck kinematics ------------------------------------------------
const MAX_LEAN = 0.30;         // rad of deck roll at full carve
const WHEEL_R = 0.03;
// Truck pivot axes are inclined at PIVOT_ANGLE from horizontal, pointing
// toward the board's center (front axis tips back, rear axis tips forward).
// When the deck rolls by φ, each hanger rotates about its pivot axis by
// ρ = atan(tan φ / cos λ) — the unique angle that keeps the axle parallel to
// the ground — which yaws the front axle into the turn and the rear axle out
// of it, exactly like a physical truck.
const PIVOT_ANGLE = MathUtils.degToRad( 40 );
const COS_PIVOT = Math.cos( PIVOT_ANGLE );
const FRONT_PIVOT_AXIS = new Vector3( 0, Math.sin( PIVOT_ANGLE ), - COS_PIVOT );
const REAR_PIVOT_AXIS = new Vector3( 0, Math.sin( PIVOT_ANGLE ), COS_PIVOT );

const _fwd = new Vector3();
const _bf = new Vector3();
const _lat = new Vector3();
const _acc = new Vector3();
const _delta = new Vector3();
const _horiz = new Vector3();
const _n = new Vector3();
const _desired = new Vector3();
const _look = new Vector3();
const _right = new Vector3();
const _m = new Matrix4();
const _q = new Quaternion();
const UP = new Vector3( 0, 1, 0 );
const DOWN = new Vector3( 0, - 1, 0 );

export class SkateMode {

	constructor( { scene, camera, tilesGroup, playArea, hud, onExit } ) {

		this.scene = scene;
		this.camera = camera;
		this.tilesGroup = tilesGroup;
		this.playArea = playArea;
		this.hud = hud; // { root, speed, state }
		this.onExit = onExit;

		this.active = false;
		this.pos = new Vector3();
		this.vel = new Vector3();
		this.yaw = 0;
		this.onGround = true;
		this.groundNormal = new Vector3( 0, 1, 0 );
		this.lastGroundY = 0;
		this.spawn = new Vector3();
		this.spawnYaw = 0;

		this.keys = new Set();
		this._jumpHeld = false;
		this._visUp = new Vector3( 0, 1, 0 );
		this._saved = null;

		this._raycaster = new Raycaster();
		this._raycaster.firstHitOnly = true;

		this.audio = new SkateAudio();

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
		const hit = this._raycaster.intersectObject( this.tilesGroup, true )[ 0 ];
		if ( hit && hit.face ) {

			hit.worldNormal = _n.copy( hit.face.normal )
				.transformDirection( hit.object.matrixWorld );
			if ( hit.worldNormal.y < 0 ) hit.worldNormal.negate();

		}

		return hit;

	}

	// --- mode switching --------------------------------------------------------

	enter( spawnPoint, viewDir ) {

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
		this.audio.start();
		this.hud.root.classList.remove( 'hidden' );
		if ( document.activeElement ) document.activeElement.blur();

		this._updateCamera( 1, true );

	}

	exit() {

		if ( ! this.active ) return;

		this.active = false;
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

		_fwd.set( Math.sin( this.yaw ), 0, Math.cos( this.yaw ) );
		this.onExit( this.pos.clone(), _fwd.clone() );

	}

	respawn() {

		this.pos.copy( this.spawn );
		this.vel.set( 0, 0, 0 );
		this.yaw = this.spawnYaw;
		this.onGround = true;
		this.lastGroundY = this.pos.y;

	}

	_onKeyDown( e ) {

		if ( ! this.active ) return;
		if ( e.target && e.target.tagName === 'INPUT' ) return;

		if ( e.code === 'Escape' ) {

			this.exit();
			return;

		}

		if ( e.code === 'Space' ) e.preventDefault();
		if ( e.code === 'KeyR' ) this.respawn();
		this.keys.add( e.code );

	}

	// --- main loop ---------------------------------------------------------------

	update( dt ) {

		if ( ! this.active ) return;

		const steps = MathUtils.clamp( Math.ceil( dt / 0.02 ), 1, 5 );
		const h = dt / steps;
		for ( let i = 0; i < steps; i ++ ) this._physicsStep( h );

		this._updateBoard( dt );
		this._updateAudio( dt );
		this._updateCamera( dt, false );
		this._updateHUD();

	}

	_physicsStep( h ) {

		const { keys, vel } = this;
		const speed = vel.length();
		_fwd.set( Math.sin( this.yaw ), 0, Math.cos( this.yaw ) );

		// steering — tighter at low speed, looser at high speed, reduced in air
		const turn = ( keys.has( 'KeyA' ) ? 1 : 0 ) - ( keys.has( 'KeyD' ) ? 1 : 0 );
		const turnRate = this.onGround ? 2.5 / ( 1 + speed / 14 ) : 2.0;
		this.yaw += turn * turnRate * h;

		if ( this.onGround ) {

			this._applyGroundForces( h, _fwd, speed );

			if ( keys.has( 'Space' ) && ! this._jumpHeld ) {

				vel.y += JUMP_SPEED;
				this.onGround = false;
				this._jumpHeld = true;
				this.audio.jump();

			}

		} else {

			vel.y -= GRAV_AIR * h;

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
			const wall = this._raycaster.intersectObject( this.tilesGroup, true )[ 0 ];
			if ( wall && wall.face ) {

				_n.copy( wall.face.normal ).transformDirection( wall.object.matrixWorld );
				if ( _n.dot( this._raycaster.ray.direction ) > 0 ) _n.negate();
				if ( _n.y < WALL_NORMAL_Y ) {

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

			if ( this.onGround ) {

				const dy = groundY - this.pos.y;
				if ( dy >= - SNAP_DOWN && dy <= STEP_UP ) {

					this.pos.y = groundY; // glued: bumps, curbs, rolling terrain
					if ( hit.worldNormal ) this.groundNormal.lerp( hit.worldNormal, 0.35 ).normalize();

				} else if ( dy < - SNAP_DOWN ) {

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

		// fell off the mesh entirely
		if ( this.pos.y < this.lastGroundY - 400 ) this.respawn();

	}

	_applyGroundForces( h, fwd, speed ) {

		const { vel, keys } = this;
		const n = this.groundNormal;

		// gravity projected onto the ground plane — hills accelerate you
		_acc.copy( DOWN ).addScaledVector( n, n.y );
		vel.addScaledVector( _acc, GRAV_SLOPE * h );

		// board forward projected onto the ground plane
		_bf.copy( fwd ).addScaledVector( n, - fwd.dot( n ) ).normalize();

		// carve: wheels grip sideways, roll freely forward
		const vF = vel.dot( _bf );
		_lat.copy( vel ).addScaledVector( _bf, - vF );
		_lat.multiplyScalar( Math.exp( - GRIP * h ) );
		vel.copy( _lat ).addScaledVector( _bf, vF );

		if ( keys.has( 'KeyW' ) && vF < MAX_PUSH_SPEED ) {

			vel.addScaledVector( _bf, PUSH_ACCEL * h );

		}

		if ( keys.has( 'KeyS' ) && speed > 0.01 ) {

			vel.multiplyScalar( Math.max( 0, 1 - ( BRAKE * h ) / speed ) );

		}

		// rolling resistance + aero drag
		const sp = vel.length();
		if ( sp > 0.001 ) {

			const decel = ( ROLL_FRICTION + DRAG * sp * sp ) * h;
			vel.multiplyScalar( Math.max( 0, 1 - decel / sp ) );

		}

		if ( sp > MAX_SPEED ) vel.multiplyScalar( MAX_SPEED / sp );

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

		// deck roll from steering input, scaled up with speed
		const turn = ( this.keys.has( 'KeyA' ) ? 1 : 0 ) - ( this.keys.has( 'KeyD' ) ? 1 : 0 );
		const speed = this.vel.length();
		const leanTarget = this.onGround
			? turn * Math.min( speed / 9, 1 ) * MAX_LEAN
			: turn * MAX_LEAN * 0.4;
		this._lean += ( leanTarget - this._lean ) * ( 1 - Math.exp( - 7 * dt ) );
		this.deck.rotation.z = this._lean;

		// truck kinematics: hangers rotate about their pivot axes by the angle
		// that keeps the axles level under the rolled deck
		const rho = Math.atan( Math.tan( this._lean ) / COS_PIVOT );
		this.hangers.front.quaternion.setFromAxisAngle( FRONT_PIVOT_AXIS, rho );
		this.hangers.rear.quaternion.setFromAxisAngle( REAR_PIVOT_AXIS, - rho );

		// wheel spin from signed forward travel
		if ( this.onGround ) {

			const vF = this.vel.dot( _bf );
			this._spin += ( vF / WHEEL_R ) * dt;
			for ( const w of this.wheels ) w.rotation.x = this._spin;

		}

		// rider animation
		this.rig.update( dt, {
			grounded: this.onGround,
			speed,
			pushing: this.onGround && this.keys.has( 'KeyW' ),
			braking: this.onGround && this.keys.has( 'KeyS' ) && speed > 0.3,
			lean: this._lean,
		} );

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
			speed,
			slip,
			pushing: this.onGround && this.keys.has( 'KeyW' ),
			braking: this.onGround && this.keys.has( 'KeyS' ) && speed > 0.3,
		} );

	}

	_updateCamera( dt, snap ) {

		const speed = this.vel.length();
		_fwd.set( Math.sin( this.yaw ), 0, Math.cos( this.yaw ) );

		// tight framing on the board and rider, easing back with speed
		const dist = 3.3 + speed * 0.10;
		_desired.copy( this.pos )
			.addScaledVector( _fwd, - dist )
			.setY( this.pos.y + 1.6 + speed * 0.03 );

		// keep the camera above the terrain behind the skater
		const g = this._groundHit( _desired.x, _desired.y, _desired.z, 6, 30 );
		if ( g && _desired.y < g.point.y + 0.55 ) _desired.y = g.point.y + 0.55;

		if ( snap ) {

			this.camera.position.copy( _desired );

		} else {

			this.camera.position.lerp( _desired, 1 - Math.exp( - 5.5 * dt ) );

		}

		_look.copy( this.pos ).addScaledVector( _fwd, 1.4 );
		_look.y += 1.05;
		this.camera.lookAt( _look );

	}

	_updateHUD() {

		const mph = Math.round( this.vel.length() * 2.237 );
		this.hud.speed.textContent = mph;
		this.hud.state.textContent = this.onGround ? '' : 'AIR';

	}

}
