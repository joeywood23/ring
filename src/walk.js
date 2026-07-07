import {
	Vector3,
	Raycaster,
	Group,
	Mesh,
	CircleGeometry,
	MeshBasicMaterial,
	Quaternion,
	MathUtils,
} from 'three';
import { WalkerRig } from './skater.js';
import { PHYSICS } from './skate.js';

// On-foot exploration. Mirrors SkateMode's raycast integration (walls,
// step-up, ground snap) but with direct velocity control instead of rolling
// physics — people stop when they stop. One class covers both gaits.

const GAITS = {
	walk: { maxSpeed: 2.2, accel: 10, turn: 3.0, jump: 3.4, back: 0.5, label: 'WALK' },
	run: { maxSpeed: 7.5, accel: 14, turn: 2.4, jump: 4.8, back: 0.35, label: 'RUN' },
};

const HINT = 'W move · S back · A/D turn · Space jump · 1 ramp · 2 rail · R respawn · Esc exit';

const STEP_UP = 0.4;
const SNAP_DOWN = 1.0;
const WALL_NORMAL_Y = 0.55;

const UP = new Vector3( 0, 1, 0 );
const DOWN = new Vector3( 0, - 1, 0 );
const _fwd = new Vector3();
const _lat = new Vector3();
const _delta = new Vector3();
const _horiz = new Vector3();
const _n = new Vector3();
const _desired = new Vector3();
const _look = new Vector3();
const _q = new Quaternion();

export class PedestrianMode {

	constructor( { scene, camera, tilesGroup, playArea, park, hud, audio, onExit } ) {

		this.scene = scene;
		this.camera = camera;
		this.tilesGroup = tilesGroup;
		this.playArea = playArea;
		this.hud = hud;
		this.audio = audio;
		this.onExit = onExit;
		this._rideables = park ? [ tilesGroup, park.rideable ] : [ tilesGroup ];

		this.active = false;
		this.gait = GAITS.walk;
		this.pos = new Vector3();
		this.vel = new Vector3();
		this.yaw = 0;
		this.onGround = true;
		this.lastGroundY = 0;
		this.spawn = new Vector3();
		this.spawnYaw = 0;

		this.keys = new Set();
		this._jumpHeld = false;
		this._saved = null;

		this._raycaster = new Raycaster();
		this._raycaster.firstHitOnly = true;

		this.body = new Group();
		this.rig = new WalkerRig();
		this.body.add( this.rig.group );

		const shadow = new Mesh(
			new CircleGeometry( 0.32, 16 ),
			new MeshBasicMaterial( { color: 0x000000, transparent: true, opacity: 0.35, depthWrite: false } )
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

	enter( spawnPoint, viewDir, gaitName = 'walk' ) {

		this.gaitName = GAITS[ gaitName ] ? gaitName : 'walk';
		this.gait = GAITS[ this.gaitName ];

		const hit = this._groundHit( spawnPoint.x, spawnPoint.y, spawnPoint.z, 500, 4000 );
		this.pos.copy( hit ? hit.point : spawnPoint );
		this.lastGroundY = this.pos.y;
		this.vel.set( 0, 0, 0 );
		this.yaw = Math.atan2( viewDir.x, viewDir.z );
		this.onGround = true;
		this.spawn.copy( this.pos );
		this.spawnYaw = this.yaw;

		this.scene.add( this.body, this.shadow );

		const { camera } = this;
		const fog = this.scene.fog;
		this._saved = { near: camera.near, far: camera.far, fogNear: fog.near, fogFar: fog.far };
		camera.near = 0.3;
		camera.far = 60000;
		camera.updateProjectionMatrix();
		fog.near = 9000;
		fog.far = 50000;

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
		this.vel.set( 0, 0, 0 );
		this.yaw = this.spawnYaw;
		this.onGround = true;
		this.lastGroundY = this.pos.y;

	}

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
		if ( e.code === 'KeyR' ) this.respawn();
		this.keys.add( e.code );

	}

	update( dt ) {

		if ( ! this.active ) return;

		const steps = MathUtils.clamp( Math.ceil( dt / 0.02 ), 1, 5 );
		const h = dt / steps;
		for ( let i = 0; i < steps; i ++ ) this._physicsStep( h );

		this._updateBody( dt );
		this._updateCamera( dt, false );
		this._updateHUD();

	}

	_physicsStep( h ) {

		const { keys, vel, gait } = this;

		const turn = ( keys.has( 'KeyA' ) ? 1 : 0 ) - ( keys.has( 'KeyD' ) ? 1 : 0 );
		this.yaw += turn * gait.turn * ( this.onGround ? 1 : 0.5 ) * h;
		_fwd.set( Math.sin( this.yaw ), 0, Math.cos( this.yaw ) );

		// direct locomotion: forward speed chases the input target, lateral
		// velocity dies fast — feet aren't wheels
		const target = keys.has( 'KeyW' ) ? gait.maxSpeed
			: keys.has( 'KeyS' ) ? - gait.maxSpeed * gait.back : 0;
		const control = this.onGround ? 1 : 0.25;

		let vF = vel.x * _fwd.x + vel.z * _fwd.z;
		vF += MathUtils.clamp( target - vF, - gait.accel * control * h, gait.accel * control * h );
		_lat.set( vel.x - _fwd.x * vF, 0, vel.z - _fwd.z * vF )
			.multiplyScalar( Math.exp( - 12 * control * h ) );
		vel.x = _fwd.x * vF + _lat.x;
		vel.z = _fwd.z * vF + _lat.z;

		if ( this.onGround ) {

			if ( keys.has( 'Space' ) && ! this._jumpHeld ) {

				vel.y += gait.jump;
				this.onGround = false;
				this._jumpHeld = true;
				this.audio.step( true );

			}

		} else {

			vel.y -= PHYSICS.airGravity * h;

		}

		if ( ! keys.has( 'Space' ) ) this._jumpHeld = false;

		// integrate, blocking motion into steep faces (mirrors SkateMode)
		_delta.copy( vel ).multiplyScalar( h );
		_horiz.set( _delta.x, 0, _delta.z );
		const horizDist = _horiz.length();
		if ( horizDist > 1e-6 ) {

			this._raycaster.ray.origin.set( this.pos.x, this.pos.y + 0.4, this.pos.z );
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
					const into = vel.dot( _n );
					if ( into < 0 ) vel.addScaledVector( _n, - into );
					_delta.copy( vel ).multiplyScalar( h );

				}

			}

		}

		this.pos.add( _delta );
		if ( this.playArea ) this.playArea.constrain( this.pos, vel, 10 );

		const hit = this._groundHit( this.pos.x, this.pos.y, this.pos.z, this.onGround ? 1.0 : 2.5, 60 );
		if ( hit ) {

			this.lastGroundY = hit.point.y;
			const groundY = hit.point.y;

			if ( this.onGround ) {

				const dy = groundY - this.pos.y;
				if ( dy >= - SNAP_DOWN && dy <= STEP_UP ) {

					this.pos.y = groundY;

				} else if ( dy < - SNAP_DOWN ) {

					this.onGround = false;

				}

			} else if ( this.pos.y <= groundY ) {

				this.pos.y = groundY;
				const n = hit.worldNormal || UP;
				const vn = vel.dot( n );
				if ( vn < 0 ) vel.addScaledVector( n, - vn );
				this.onGround = true;
				this.audio.land( - vn * 0.7 );

			}

		}

		if ( this.pos.y < this.lastGroundY - 400 ) this.respawn();

	}

	_updateBody( dt ) {

		this.body.position.copy( this.pos );
		_q.setFromAxisAngle( UP, this.yaw );
		this.body.quaternion.slerp( _q, 1 - Math.exp( - 12 * dt ) );

		const speed = Math.hypot( this.vel.x, this.vel.z );
		const running = this.gait === GAITS.run;
		const footstrike = this.rig.update( dt, { grounded: this.onGround, speed, running } );
		if ( footstrike && this.onGround ) this.audio.step( running );

		const height = Math.max( 0, this.pos.y - this.lastGroundY );
		this.shadow.position.set( this.pos.x, this.lastGroundY + 0.05, this.pos.z );
		this.shadow.material.opacity = 0.35 / ( 1 + height * 0.6 );

	}

	_updateCamera( dt, snap ) {

		const speed = this.vel.length();
		_fwd.set( Math.sin( this.yaw ), 0, Math.cos( this.yaw ) );

		const dist = 3.0 + speed * 0.12;
		_desired.copy( this.pos )
			.addScaledVector( _fwd, - dist )
			.setY( this.pos.y + 1.7 + speed * 0.03 );

		const g = this._groundHit( _desired.x, _desired.y, _desired.z, 6, 30 );
		if ( g && _desired.y < g.point.y + 0.55 ) _desired.y = g.point.y + 0.55;

		if ( snap ) this.camera.position.copy( _desired );
		else this.camera.position.lerp( _desired, 1 - Math.exp( - 6 * dt ) );

		_look.copy( this.pos ).addScaledVector( _fwd, 1.2 );
		_look.y += 1.25;
		this.camera.lookAt( _look );

	}

	_updateHUD() {

		const mph = Math.round( this.vel.length() * 2.237 );
		this.hud.speed.textContent = mph;
		this.hud.state.textContent = ! this.onGround ? 'AIR' : this.gait.label;

	}

}
