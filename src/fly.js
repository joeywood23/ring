import {
	Vector3,
	Raycaster,
	Group,
	Mesh,
	BoxGeometry,
	SphereGeometry,
	ConeGeometry,
	CircleGeometry,
	MeshLambertMaterial,
	MeshBasicMaterial,
	MathUtils,
	Quaternion,
} from 'three';
import { PHYSICS } from './skate.js';

// Pigeon flight. Airspeed and vertical speed are tracked as scalars and
// recombined along the heading each step: hold W to flap for thrust, Space to
// climb (costs speed), Shift to dive (gains speed), S to brake, A/D to bank.
// Lift scales with airspeed, so slowing down means sinking. Touch down gently
// to perch; from a perch W waddles and Space takes off again.

const CRUISE = 13;       // airspeed giving exactly level glide
const MAX_AIR = 30;
const FLAP_THRUST = 9;   // W
const CLIMB = 10;        // Space vertical acceleration
const CLIMB_COST = 2.2;  // climbing bleeds airspeed
const DIVE_PITCH = 14;   // Shift vertical acceleration downward
const DIVE_GAIN = 7;     // diving builds airspeed
const BRAKE_AIR = 8;     // S
const TURN_AIR = 2.2;
const WALL_NORMAL_Y = 0.55;

const HINT = 'W flap · Space climb · Shift dive · S brake · A/D bank · R respawn · Esc exit';

const BODY = new MeshLambertMaterial( { color: 0x8a92a3 } );
const HEAD = new MeshLambertMaterial( { color: 0x5c6472 } );
const NECK = new MeshLambertMaterial( { color: 0x4b7a63 } );
const WING = new MeshLambertMaterial( { color: 0x767e8f } );
const BEAK = new MeshLambertMaterial( { color: 0x3c3f46 } );
const FEET = new MeshLambertMaterial( { color: 0xc26a3a } );

const UP = new Vector3( 0, 1, 0 );
const DOWN = new Vector3( 0, - 1, 0 );
const _fwd = new Vector3();
const _delta = new Vector3();
const _horiz = new Vector3();
const _n = new Vector3();
const _desired = new Vector3();
const _look = new Vector3();
const _q = new Quaternion();

class PigeonRig {

	constructor() {

		this.group = new Group();
		this._flapPhase = 0;
		this._walkPhase = 0;
		this._bank = 0;
		this._pitch = 0;
		this._fold = 1; // 1 = wings folded (perched), 0 = spread
		this._build();

	}

	_build() {

		const body = new Group();
		body.position.y = 0.1;
		this.group.add( body );
		this.body = body;

		const torso = new Mesh( new BoxGeometry( 0.11, 0.1, 0.24 ), BODY );
		body.add( torso );

		const head = new Group();
		head.position.set( 0, 0.07, 0.13 );
		body.add( head );
		this.head = head;

		const skull = new Mesh( new SphereGeometry( 0.045, 10, 8 ), HEAD );
		skull.position.y = 0.02;
		head.add( skull );

		const neck = new Mesh( new BoxGeometry( 0.06, 0.05, 0.05 ), NECK );
		neck.position.set( 0, - 0.02, - 0.01 );
		head.add( neck );

		const beak = new Mesh( new ConeGeometry( 0.012, 0.04, 6 ), BEAK );
		beak.rotation.x = Math.PI / 2;
		beak.position.set( 0, 0.02, 0.06 );
		head.add( beak );

		const tail = new Mesh( new BoxGeometry( 0.08, 0.012, 0.14 ), WING );
		tail.position.set( 0, 0.02, - 0.17 );
		tail.rotation.x = - 0.15;
		body.add( tail );

		this.wings = [];
		for ( const side of [ - 1, 1 ] ) {

			const wing = new Group();
			wing.position.set( side * 0.05, 0.05, 0.02 );
			body.add( wing );

			const feathers = new Mesh( new BoxGeometry( 0.24, 0.012, 0.15 ), WING );
			feathers.position.x = side * 0.12;
			wing.add( feathers );

			this.wings.push( { group: wing, side } );

		}

		for ( const sx of [ - 0.03, 0.03 ] ) {

			const leg = new Mesh( new BoxGeometry( 0.015, 0.06, 0.015 ), FEET );
			leg.position.set( sx, - 0.07, 0.02 );
			body.add( leg );

		}

	}

	// returns true at the start of each downstroke so the caller can whoosh
	update( dt, s ) {

		let beat = false;
		const k = 1 - Math.exp( - 8 * dt );

		// wings: fold when perched or swimming, sweep back in a dive, beat
		// when flapping
		const foldTarget = s.perched || s.swimming ? 1 : s.diving ? 0.75 : 0;
		this._fold += ( foldTarget - this._fold ) * k;

		if ( s.flapping && ! s.perched ) {

			const prev = this._flapPhase;
			this._flapPhase += dt * Math.PI * 2 * 4.2; // ~4 beats a second
			if ( Math.floor( prev / ( Math.PI * 2 ) ) !== Math.floor( this._flapPhase / ( Math.PI * 2 ) ) ) beat = true;

		} else {

			this._flapPhase = 0;

		}

		const flap = Math.sin( this._flapPhase ) * 0.85 * ( s.flapping && ! s.perched ? 1 : 0 );
		for ( const { group, side } of this.wings ) {

			group.rotation.z = side * ( - flap - 0.12 * ( 1 - this._fold ) );
			group.rotation.y = side * this._fold * - 1.25; // sweep along the body

		}

		// body pitch follows the flight path, bank follows the turn
		this._pitch += ( ( s.pitch || 0 ) - this._pitch ) * k;
		this._bank += ( ( s.bank || 0 ) - this._bank ) * k;
		this.body.rotation.x = this._pitch;
		this.body.rotation.z = this._bank;

		// perched waddle: head bobs the way pigeons insist on
		if ( s.perched && s.speed > 0.05 ) {

			this._walkPhase += dt * 14;
			this.head.position.z = 0.13 + Math.sin( this._walkPhase ) * 0.025;

		} else {

			this.head.position.z += ( 0.13 - this.head.position.z ) * k;

		}

		return beat;

	}

}

export class PigeonMode {

	constructor( { scene, camera, tilesGroup, playArea, park, sea, hud, audio, onExit } ) {

		this.scene = scene;
		this.camera = camera;
		this.tilesGroup = tilesGroup;
		this.playArea = playArea;
		this.sea = sea; // { level(), surfaceAt(x,z), isWater(x,z) }
		this.hud = hud;
		this.audio = audio;
		this.onExit = onExit;
		this._rideables = park ? [ tilesGroup, park.rideable ] : [ tilesGroup ];

		this.active = false;
		this.pos = new Vector3();
		this.vel = new Vector3();
		this.yaw = 0;
		this.airspeed = 0;
		this.vy = 0;
		this.perched = false;
		this.swimming = false;
		this.lastGroundY = 0;
		this.spawn = new Vector3();
		this.spawnYaw = 0;

		this.keys = new Set();
		this._saved = null;

		this._raycaster = new Raycaster();
		this._raycaster.firstHitOnly = true;

		this.body = new Group();
		this.rig = new PigeonRig();
		this.body.add( this.rig.group );

		const shadow = new Mesh(
			new CircleGeometry( 0.2, 12 ),
			new MeshBasicMaterial( { color: 0x000000, transparent: true, opacity: 0.3, depthWrite: false } )
		);
		shadow.rotation.x = - Math.PI / 2;
		this.shadow = shadow;

		window.addEventListener( 'keydown', ( e ) => this._onKeyDown( e ) );
		window.addEventListener( 'keyup', ( e ) => this.keys.delete( e.code ) );
		window.addEventListener( 'blur', () => this.keys.clear() );

	}

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

	enter( spawnPoint, viewDir ) {

		// take wing 25m above the picked spot, already at cruise
		const hit = this._groundHit( spawnPoint.x, spawnPoint.y, spawnPoint.z, 500, 4000 );
		this.pos.copy( hit ? hit.point : spawnPoint );
		this.lastGroundY = this.pos.y;
		this.pos.y += 25;

		this.yaw = Math.atan2( viewDir.x, viewDir.z );
		this.airspeed = CRUISE;
		this.vy = 0;
		this.perched = false;
		this.swimming = false;
		this.vel.set( 0, 0, 0 );
		this.spawn.copy( this.pos );
		this.spawnYaw = this.yaw;

		this.scene.add( this.body, this.shadow );

		const { camera } = this;
		const fog = this.scene.fog;
		this._saved = { near: camera.near, far: camera.far, fogNear: fog.near, fogFar: fog.far };
		camera.near = 0.2;
		camera.far = 80000;
		camera.updateProjectionMatrix();
		fog.near = 12000;
		fog.far = 60000;

		this.active = true;
		this.audio.start();
		this.hud.root.classList.remove( 'hidden' );
		this.hud.hint.textContent = HINT;
		this.hud.balanceWrap.classList.add( 'hidden' );
		if ( document.activeElement ) document.activeElement.blur();

		this._updateCamera( 1, true );

	}

	exit( silent = false ) {

		if ( ! this.active ) return;

		this.active = false;
		this.keys.clear();
		this.swimming = false;
		this.audio.setUnderwater( false );
		this.scene.remove( this.body, this.shadow );
		this.audio.stop();

		const { camera } = this;
		camera.near = this._saved.near;
		camera.far = this._saved.far;
		camera.updateProjectionMatrix();
		this.scene.fog.near = this._saved.fogNear;
		this.scene.fog.far = this._saved.fogFar;

		this.hud.root.classList.add( 'hidden' );

		if ( ! silent ) {

			_fwd.set( Math.sin( this.yaw ), 0, Math.cos( this.yaw ) );
			this.onExit( this.pos.clone(), _fwd.clone() );

		}

	}

	respawn() {

		this.pos.copy( this.spawn );
		this.yaw = this.spawnYaw;
		this.airspeed = CRUISE;
		this.vy = 0;
		this.perched = false;
		this.swimming = false;
		this.audio.setUnderwater( false );
		this.vel.set( 0, 0, 0 );

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

	update( dt ) {

		if ( ! this.active ) return;

		const steps = MathUtils.clamp( Math.ceil( dt / 0.02 ), 1, 5 );
		const h = dt / steps;
		for ( let i = 0; i < steps; i ++ ) this._physicsStep( h );

		this._updateBody( dt );
		this.audio.update( dt, { grounded: false, speed: 0, slip: 0, wind: this.windSpeed() } );
		this._updateCamera( dt, false );
		this._updateHUD();

	}

	_physicsStep( h ) {

		const { keys } = this;
		const g = PHYSICS.gravity * 0.65; // birds run light

		if ( this.swimming ) {

			this._swimStep( h );
			return;

		}

		if ( this.perched ) {

			const turn = ( keys.has( 'KeyA' ) ? 1 : 0 ) - ( keys.has( 'KeyD' ) ? 1 : 0 );
			this.yaw += turn * 3.5 * h;
			_fwd.set( Math.sin( this.yaw ), 0, Math.cos( this.yaw ) );

			const walk = keys.has( 'KeyW' ) ? 0.6 : 0;
			this.pos.addScaledVector( _fwd, walk * h );
			this.vel.copy( _fwd ).multiplyScalar( walk );

			const hit = this._groundHit( this.pos.x, this.pos.y, this.pos.z, 1.0, 10 );
			if ( hit ) {

				// waddled off a pier onto the sea → float, don't stand
				if ( this._isSeaSurface( hit.point.y ) ) {

					this._enterSwim( 0 );
					return;

				}

				this.pos.y = hit.point.y;
				this.lastGroundY = hit.point.y;

			}

			if ( keys.has( 'Space' ) ) {

				this.perched = false;
				this.vy = 3.2;
				this.airspeed = 4;
				this.audio.flap();

			}

			if ( this.playArea ) this.playArea.constrain( this.pos, null, 10 );
			return;

		}

		// --- airborne ---
		const turn = ( keys.has( 'KeyA' ) ? 1 : 0 ) - ( keys.has( 'KeyD' ) ? 1 : 0 );
		this.yaw += turn * TURN_AIR / ( 1 + this.airspeed / 25 ) * h;
		_fwd.set( Math.sin( this.yaw ), 0, Math.cos( this.yaw ) );

		if ( keys.has( 'KeyW' ) ) this.airspeed += FLAP_THRUST * h;
		if ( keys.has( 'KeyS' ) ) this.airspeed = Math.max( 2.5, this.airspeed - BRAKE_AIR * h );
		this.airspeed -= 0.008 * this.airspeed * this.airspeed * h; // aero drag
		this.airspeed = Math.min( this.airspeed, MAX_AIR );

		// lift grows with airspeed: level at cruise, sinking below it
		const lift = g * MathUtils.clamp( this.airspeed / CRUISE, 0, 1 );
		this.vy += ( lift - g ) * h;

		if ( keys.has( 'Space' ) ) {

			this.vy += CLIMB * h;
			this.airspeed = Math.max( 4, this.airspeed - CLIMB_COST * h );

		}

		if ( keys.has( 'ShiftLeft' ) || keys.has( 'ShiftRight' ) ) {

			this.vy -= DIVE_PITCH * h;
			this.airspeed += DIVE_GAIN * h;

		}

		this.vy *= Math.exp( - 0.8 * h ); // vertical air resistance

		this.vel.copy( _fwd ).multiplyScalar( this.airspeed );
		this.vel.y = this.vy;

		// integrate with wall slide (mirrors the ground modes)
		_delta.copy( this.vel ).multiplyScalar( h );
		_horiz.set( _delta.x, 0, _delta.z );
		const horizDist = _horiz.length();
		if ( horizDist > 1e-6 ) {

			this._raycaster.ray.origin.copy( this.pos );
			this._raycaster.ray.direction.copy( _horiz ).divideScalar( horizDist );
			this._raycaster.near = 0;
			this._raycaster.far = horizDist + 0.3;
			const wall = this._raycaster.intersectObjects( this._rideables, true )[ 0 ];
			if ( wall && wall.face ) {

				_n.copy( wall.face.normal ).transformDirection( wall.object.matrixWorld );
				if ( _n.dot( this._raycaster.ray.direction ) > 0 ) _n.negate();
				if ( _n.y < WALL_NORMAL_Y ) {

					_n.y = 0;
					_n.normalize();
					const into = this.vel.dot( _n );
					if ( into < 0 ) this.vel.addScaledVector( _n, - into );
					// scrubbing along a wall costs airspeed
					this.airspeed = Math.max( 0, this.vel.dot( _fwd ) );
					_delta.copy( this.vel ).multiplyScalar( h );

				}

			}

		}

		this.pos.add( _delta );
		if ( this.playArea ) this.playArea.constrain( this.pos, this.vel, 10 );

		const hit = this._groundHit( this.pos.x, this.pos.y, this.pos.z, 2.5, 60 );
		if ( hit ) {

			this.lastGroundY = hit.point.y;
			if ( this.pos.y <= hit.point.y ) {

				// the sea is not rigid: splash in — fast dives plunge deep
				if ( this._isSeaSurface( hit.point.y ) ) {

					this._enterSwim( Math.abs( this.vy ) );
					return;

				}

				// touchdown: perch wherever you land
				this.pos.y = hit.point.y;
				this.audio.land( Math.min( Math.abs( this.vy ) * 0.5, 3 ) );
				this.perched = true;
				this.airspeed = 0;
				this.vy = 0;
				this.vel.set( 0, 0, 0 );

			}

		}

		if ( this.pos.y < this.lastGroundY - 600 ) this.respawn();

	}

	// --- swimming ------------------------------------------------------------------

	_isSeaSurface( groundY ) {

		if ( ! this.sea ) return false;
		const sl = this.sea.level();
		if ( sl === null ) return false;
		return Math.abs( groundY - sl ) < 1.2 && this.sea.isWater( this.pos.x, this.pos.z );

	}

	_enterSwim( impact ) {

		this.swimming = true;
		this.perched = false;
		this.airspeed = 0;
		this.audio.splash( impact );
		this.hud.hint.textContent =
			'W paddle · Shift dive · Space rise / take off · A/D turn · S brake · R respawn · Esc exit';

	}

	_leaveSwim() {

		this.swimming = false;
		this.audio.setUnderwater( false );
		this.hud.hint.textContent = HINT;

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
		this.yaw += turn * 2.5 / ( 1 + speed / 6 ) * h;
		_fwd.set( Math.sin( this.yaw ), 0, Math.cos( this.yaw ) );

		const surface = this.sea.surfaceAt( this.pos.x, this.pos.z ) - 0.06;
		const atSurface = this.pos.y >= surface - 0.3;

		if ( keys.has( 'KeyW' ) ) vel.addScaledVector( _fwd, ( atSurface ? 3 : 6 ) * h );
		if ( keys.has( 'KeyS' ) && speed > 0.01 ) vel.multiplyScalar( Math.max( 0, 1 - 6 * h / speed ) );
		if ( keys.has( 'ShiftLeft' ) || keys.has( 'ShiftRight' ) ) vel.y -= 7.5 * h;

		if ( keys.has( 'Space' ) ) {

			if ( atSurface ) {

				// burst off the water into flight
				this._leaveSwim();
				this.vy = 3.6;
				this.airspeed = Math.max( 5, Math.hypot( vel.x, vel.z ) );
				this.audio.flap();
				this.audio.splash( 1.5 );
				return;

			}

			vel.y += 7.5 * h;

		}

		vel.y += 2.8 * h;                            // pigeons are corks
		vel.multiplyScalar( Math.exp( - 1.0 * h ) ); // water drag

		this.pos.addScaledVector( vel, h );
		if ( this.playArea ) this.playArea.constrain( this.pos, vel, 10 );

		const floor = seaLevel - 6.0;
		if ( this.pos.y < floor ) {

			this.pos.y = floor;
			if ( vel.y < 0 ) vel.y = 0;

		}

		if ( this.pos.y >= surface ) {

			this.pos.y = surface;
			if ( vel.y > 0 ) vel.y = 0;

		}

		// shore rises above the sea → hop out and perch
		const hit = this._groundHit( this.pos.x, this.pos.y, this.pos.z, 3, 12 );
		if ( hit && hit.point.y > seaLevel + 0.15 && hit.point.y > this.pos.y - 0.5 &&
			! this.sea.isWater( this.pos.x, this.pos.z ) ) {

			this.pos.y = hit.point.y;
			this.lastGroundY = hit.point.y;
			this._leaveSwim();
			this.perched = true;
			this.vel.set( 0, 0, 0 );
			this.audio.splash( 0.8 );
			return;

		}

		this.lastGroundY = floor;
		this.audio.setUnderwater( this.pos.y < seaLevel - 0.5 );

	}

	_updateBody( dt ) {

		this.body.position.copy( this.pos );
		_q.setFromAxisAngle( UP, this.yaw );
		this.body.quaternion.slerp( _q, 1 - Math.exp( - 10 * dt ) );

		const { keys } = this;
		const flapping = ! this.perched && ( keys.has( 'KeyW' ) || keys.has( 'Space' ) );
		const diving = ! this.perched && ( keys.has( 'ShiftLeft' ) || keys.has( 'ShiftRight' ) );
		const turn = ( keys.has( 'KeyA' ) ? 1 : 0 ) - ( keys.has( 'KeyD' ) ? 1 : 0 );

		const beat = this.rig.update( dt, {
			perched: this.perched,
			swimming: this.swimming,
			flapping: flapping && ! this.swimming,
			diving,
			speed: this.vel.length(),
			pitch: this.perched ? 0
				: this.swimming ? MathUtils.clamp( - this.vel.y * 0.12, - 0.5, 0.5 )
					: MathUtils.clamp( Math.atan2( - this.vy, Math.max( this.airspeed, 3 ) ), - 0.6, 0.6 ),
			bank: this.perched || this.swimming ? 0 : turn * - 0.5,
		} );
		if ( beat ) this.audio.flap();

		const height = Math.max( 0, this.pos.y - this.lastGroundY );
		this.shadow.position.set( this.pos.x, this.lastGroundY + 0.05, this.pos.z );
		this.shadow.material.opacity = 0.3 / ( 1 + height * 0.15 );
		const sc = 1 + height * 0.02;
		this.shadow.scale.set( sc, sc, sc );

	}

	_updateCamera( dt, snap ) {

		_fwd.set( Math.sin( this.yaw ), 0, Math.cos( this.yaw ) );

		const dist = this.perched ? 2.0 : 3.6 + this.airspeed * 0.08;
		_desired.copy( this.pos )
			.addScaledVector( _fwd, - dist )
			.setY( this.pos.y + ( this.perched ? 0.7 : 1.1 ) );

		const gHit = this._groundHit( _desired.x, _desired.y, _desired.z, 4, 20 );
		if ( gHit && _desired.y < gHit.point.y + 0.4 ) _desired.y = gHit.point.y + 0.4;

		if ( snap ) this.camera.position.copy( _desired );
		else this.camera.position.lerp( _desired, 1 - Math.exp( - 6 * dt ) );

		_look.copy( this.pos ).addScaledVector( _fwd, 1.0 );
		_look.y += this.perched ? 0.2 : this.vy * 0.05;
		this.camera.lookAt( _look );

	}

	_updateHUD() {

		this.hud.speed.textContent = Math.round( this.vel.length() * 2.237 );
		const { keys } = this;
		this.hud.state.textContent = this.swimming
			? ( this.sea && this.pos.y < this.sea.level() - 0.5 ? 'DIVE' : 'FLOAT' )
			: this.perched ? 'PERCH'
				: ( keys.has( 'ShiftLeft' ) || keys.has( 'ShiftRight' ) ) ? 'DIVE'
					: ( keys.has( 'KeyW' ) || keys.has( 'Space' ) ) ? 'FLAP' : 'GLIDE';

	}

	// audio hook: wind rises with airspeed
	windSpeed() {

		return this.perched || this.swimming ? 0 : this.airspeed;

	}

}
