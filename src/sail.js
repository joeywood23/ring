import {
	Vector3,
	Raycaster,
	Group,
	Mesh,
	BoxGeometry,
	ConeGeometry,
	CylinderGeometry,
	RingGeometry,
	BufferGeometry,
	BufferAttribute,
	MeshLambertMaterial,
	MeshBasicMaterial,
	MathUtils,
	Quaternion,
	DoubleSide,
} from 'three';
import { currentArea } from './areas.js';

// Sailboat. Water-only: the hull rides the Google-mesh water line (the baked
// photogrammetry sea is flat), drafting slightly through it so the tiles clip
// the keel like a real waterline. A steady westerly blows across the Bay:
// W sheets in for thrust (dead upwind luffs — tack through it), S lets out and
// brakes, A/D work the helm. Shores, piers and anything that rises off the
// waterline are walls; a white foam collar and a spreading stern wake trail
// the hull.

const MAX_SPEED = 12;        // m/s on the best point of sail
const NO_GO = 0.55;          // rad off the wind where the sail just luffs
const SHEET_RATE = 0.75;     // how quickly trimmed sails pull to target speed
const WATER_DRAG = 0.12;
const BRAKE_DRAG = 1.3;
const TURN_RATE = 1.15;
const HULL_TOLERANCE = 0.8;  // mesh within this of the waterline counts as sea
const BOW_LOOKAHEAD = 2.4;   // probe this far past the hull centre when moving

const HINT = 'W sheet in · S let out / brake · A/D helm · wind from the west · R respawn · Esc exit';

const HULL = new MeshLambertMaterial( { color: 0xf2f4f6 } );
const TRIM = new MeshLambertMaterial( { color: 0x24344d } );
const DECK = new MeshLambertMaterial( { color: 0xcdb98f } );
const MAST = new MeshLambertMaterial( { color: 0xb9bec6 } );
const SAIL = new MeshLambertMaterial( { color: 0xfbfaf2, side: DoubleSide } );

const UP = new Vector3( 0, 1, 0 );
const DOWN = new Vector3( 0, - 1, 0 );
const _fwd = new Vector3();
const _desired = new Vector3();
const _look = new Vector3();
const _q = new Quaternion();

function triangleGeometry( a, b, c ) {

	const geo = new BufferGeometry();
	geo.setAttribute( 'position', new BufferAttribute( new Float32Array( [ ...a, ...b, ...c ] ), 3 ) );
	geo.computeVertexNormals();
	return geo;

}

// ---------------------------------------------------------------------------
// Wake: a ribbon of stern positions that widens and fades as it ages, drawn
// with RGBA vertex colors so each slice carries its own alpha.
// ---------------------------------------------------------------------------

const WAKE_POINTS = 80;
const WAKE_LIFE = 4.5;      // seconds a slice survives
const WAKE_MIN_STEP = 0.9;  // metres of travel between recorded slices

class WakeTrail {

	constructor() {

		this.points = []; // oldest first: { x, y, z, age, s }

		this.positions = new Float32Array( WAKE_POINTS * 2 * 3 );
		this.colors = new Float32Array( WAKE_POINTS * 2 * 4 );

		const geo = new BufferGeometry();
		geo.setAttribute( 'position', new BufferAttribute( this.positions, 3 ) );
		geo.setAttribute( 'color', new BufferAttribute( this.colors, 4 ) );

		const index = [];
		for ( let i = 0; i < WAKE_POINTS - 1; i ++ ) {

			const a = i * 2;
			index.push( a, a + 1, a + 2, a + 1, a + 3, a + 2 );

		}

		geo.setIndex( index );
		geo.setDrawRange( 0, 0 );

		this.mesh = new Mesh( geo, new MeshBasicMaterial( {
			vertexColors: true,
			transparent: true,
			depthWrite: false,
			side: DoubleSide,
		} ) );
		this.mesh.frustumCulled = false;
		this.mesh.renderOrder = 3;

		this.group = new Group();
		this.group.add( this.mesh );

	}

	reset() {

		this.points.length = 0;
		this.mesh.geometry.setDrawRange( 0, 0 );

	}

	update( dt, stern, speed, waterY ) {

		const pts = this.points;

		for ( const p of pts ) p.age += dt;
		while ( pts.length && pts[ 0 ].age > WAKE_LIFE ) pts.shift();

		if ( speed > 1.2 ) {

			const last = pts[ pts.length - 1 ];
			if ( ! last || Math.hypot( stern.x - last.x, stern.z - last.z ) > WAKE_MIN_STEP ) {

				pts.push( {
					x: stern.x,
					y: waterY + 0.06,
					z: stern.z,
					age: 0,
					s: MathUtils.clamp( speed / 7, 0.25, 1 ),
				} );
				if ( pts.length > WAKE_POINTS ) pts.shift();

			}

		}

		this._rebuild();

	}

	_rebuild() {

		const pts = this.points;
		const n = pts.length;
		const pos = this.positions;
		const col = this.colors;

		for ( let i = 0; i < n; i ++ ) {

			const p = pts[ i ];
			const prev = pts[ Math.max( i - 1, 0 ) ];
			const next = pts[ Math.min( i + 1, n - 1 ) ];

			let dx = next.x - prev.x;
			let dz = next.z - prev.z;
			const len = Math.hypot( dx, dz );
			if ( len > 1e-4 ) {

				dx /= len;
				dz /= len;

			} else {

				dx = 1;
				dz = 0;

			}

			// spread outward and thin out as the slice ages
			const half = 0.55 + p.age * 1.15;
			const alpha = Math.pow( 1 - p.age / WAKE_LIFE, 1.7 ) * 0.55 * p.s;

			// perp = (-dz, dx)
			const v = i * 6;
			pos[ v ] = p.x - dz * half;
			pos[ v + 1 ] = p.y;
			pos[ v + 2 ] = p.z + dx * half;
			pos[ v + 3 ] = p.x + dz * half;
			pos[ v + 4 ] = p.y;
			pos[ v + 5 ] = p.z - dx * half;

			const c = i * 8;
			col[ c ] = col[ c + 1 ] = col[ c + 2 ] = 1;
			col[ c + 3 ] = alpha;
			col[ c + 4 ] = col[ c + 5 ] = col[ c + 6 ] = 1;
			col[ c + 7 ] = alpha;

		}

		const geo = this.mesh.geometry;
		geo.attributes.position.needsUpdate = true;
		geo.attributes.color.needsUpdate = true;
		geo.setDrawRange( 0, n >= 2 ? ( n - 1 ) * 6 : 0 );

	}

}

// ---------------------------------------------------------------------------
// Rig: hull with a real draft, mast, swinging boom + main, jib on the bow.
// The heel group tips everything but the foam stays flat on the water.
// ---------------------------------------------------------------------------

class SailboatRig {

	constructor() {

		this.group = new Group();
		this._heel = 0;
		this._pitch = 0;
		this._boom = 0;
		this._flutter = 0;
		this._build();

	}

	_build() {

		const heel = new Group();
		this.group.add( heel );
		this.heelGroup = heel;

		// hull spans y -0.5 (keel, under the tile water line) to +0.55 (deck)
		const hull = new Mesh( new BoxGeometry( 1.55, 1.05, 4.4 ), HULL );
		hull.position.y = 0.02;
		heel.add( hull );

		const bowGeo = new ConeGeometry( 0.9, 1.5, 4 );
		bowGeo.rotateX( Math.PI / 2 );
		bowGeo.scale( 0.86, 0.66, 1 );
		bowGeo.translate( 0, 0.02, 2.9 );
		heel.add( new Mesh( bowGeo, HULL ) );

		const stripe = new Mesh( new BoxGeometry( 1.62, 0.14, 4.44 ), TRIM );
		stripe.position.y = 0.46;
		heel.add( stripe );

		const cabin = new Mesh( new BoxGeometry( 0.95, 0.34, 1.35 ), DECK );
		cabin.position.set( 0, 0.72, - 0.25 );
		heel.add( cabin );

		const mast = new Mesh( new CylinderGeometry( 0.045, 0.065, 7 ), MAST );
		mast.position.set( 0, 4.05, 0.6 );
		heel.add( mast );

		// boom + mainsail pivot together at the mast
		const boom = new Group();
		boom.position.set( 0, 1.15, 0.6 );
		heel.add( boom );
		this.boom = boom;

		const boomGeo = new CylinderGeometry( 0.035, 0.035, 2.5 );
		boomGeo.rotateX( Math.PI / 2 );
		boomGeo.translate( 0, 0, - 1.25 );
		boom.add( new Mesh( boomGeo, MAST ) );

		this.main = new Mesh( triangleGeometry(
			[ 0, 0.1, - 0.08 ],   // tack, at the gooseneck
			[ 0, 6.0, - 0.08 ],   // head, up the mast
			[ 0, 0.1, - 2.4 ]     // clew, out the boom
		), SAIL );
		boom.add( this.main );

		// jib pivots at the bow
		const jib = new Group();
		jib.position.set( 0, 0, 3.3 );
		heel.add( jib );
		this.jib = jib;

		jib.add( new Mesh( triangleGeometry(
			[ 0, 0.75, 0 ],       // tack, at the stem
			[ 0, 5.6, - 2.55 ],   // head, near the masthead
			[ 0, 0.75, - 2.35 ]   // clew
		), SAIL ) );

	}

	// s = { heel, boomAngle, luffing, speed }
	update( dt, s ) {

		const k = 1 - Math.exp( - 6 * dt );
		const t = performance.now() / 1000;

		this._heel += ( s.heel - this._heel ) * k;
		this._boom += ( s.boomAngle - this._boom ) * k;

		// luffing sails shake instead of drawing
		this._flutter += ( ( s.luffing ? 1 : 0 ) - this._flutter ) * k;
		const shake = Math.sin( t * 17 ) * 0.14 * this._flutter;

		this.boom.rotation.y = this._boom + shake;
		this.jib.rotation.y = this._boom * 0.8 + shake * 1.3;

		// gentle seaway bob; the bow lifts a little with speed
		const pitchTarget = Math.sin( t * 0.9 ) * 0.015 - Math.min( s.speed / MAX_SPEED, 1 ) * 0.035;
		this._pitch += ( pitchTarget - this._pitch ) * k;

		this.heelGroup.rotation.z = this._heel;
		this.heelGroup.rotation.x = this._pitch;
		this.heelGroup.position.y = Math.sin( t * 1.3 ) * 0.05 + Math.sin( t * 2.1 + 1.7 ) * 0.03;

	}

}

// ---------------------------------------------------------------------------
// Mode
// ---------------------------------------------------------------------------

export class SailboatMode {

	constructor( { scene, camera, tilesGroup, playArea, sea, segments, hud, audio, onExit } ) {

		this.scene = scene;
		this.camera = camera;
		this.tilesGroup = tilesGroup;
		this.playArea = playArea;
		this.sea = sea; // { level(), surfaceAt(x,z), isWater(x,z) }
		this.segments = segments;
		this.hud = hud;
		this.audio = audio;
		this.onExit = onExit;

		this.active = false;
		this.pos = new Vector3();
		this.vel = new Vector3();
		this.yaw = 0;
		this.speed = 0;
		this.waterY = 0;
		this.windTo = new Vector3( 1, 0, 0 ); // set from the play frame on enter
		this.windAngle = Math.PI;             // heading off the wind, 0 = dead upwind
		this.side = 1;
		this.aground = false;
		this.spawn = new Vector3();
		this.spawnYaw = 0;
		this._seaEst = null;

		this.keys = new Set();
		this._saved = null;

		this._raycaster = new Raycaster();
		this._raycaster.firstHitOnly = true;

		this.body = new Group();
		this.rig = new SailboatRig();
		this.body.add( this.rig.group );

		// foam collar at the waterline — flat, so it never heels with the hull
		const foamGeo = new RingGeometry( 0.95, 1.5, 28 );
		foamGeo.rotateX( - Math.PI / 2 );
		foamGeo.scale( 1.15, 1, 2.6 );
		this.foam = new Mesh( foamGeo, new MeshBasicMaterial( {
			color: 0xffffff,
			transparent: true,
			opacity: 0,
			depthWrite: false,
		} ) );
		this.foam.position.y = 0.09;
		this.foam.renderOrder = 3;
		this.body.add( this.foam );

		this.wake = new WakeTrail();

		window.addEventListener( 'keydown', ( e ) => this._onKeyDown( e ) );
		window.addEventListener( 'keyup', ( e ) => this.keys.delete( e.code ) );
		window.addEventListener( 'blur', () => this.keys.clear() );

	}

	_rayDown( x, y, z, far ) {

		this._raycaster.ray.origin.set( x, y, z );
		this._raycaster.ray.direction.copy( DOWN );
		this._raycaster.near = 0;
		this._raycaster.far = far;
		return this._raycaster.intersectObject( this.tilesGroup, true )[ 0 ];

	}

	// One raycast mid-bay measures the baked sea level (the WaterLayer does the
	// same); used to validate drop points before the coverage map has loaded.
	_seaEstimate() {

		if ( this._seaEst !== null ) return this._seaEst;
		const hit = this._rayDown( 0, 1500, 0, 3000 );
		if ( hit ) this._seaEst = hit.point.y;
		return hit ? hit.point.y : currentArea().groundY;

	}

	// Can a sailboat be dropped here? Segmentation when it's ready, otherwise
	// "the baked bay is flat at sea level" — piers and shores rise off it. The
	// fallback tolerance is generous: distant coarse tiles sit metres off true
	// sea level, and a boat wrongly dropped ashore just sits aground (Esc out).
	isWaterPoint( point ) {

		const sl = this.sea.level();
		if ( sl !== null ) return this.sea.isWater( point.x, point.z ) && Math.abs( point.y - sl ) < 3;
		if ( this.segments && this.segments.ready ) return this.segments.classify( point.x, point.z ) === 'water';
		return Math.abs( point.y - this._seaEstimate() ) < 8;

	}

	// Water at (x, z)? Returns the surface height there, or null for land,
	// piers, hulls of container ships — anything off the waterline.
	_probeWater( x, z ) {

		const sl = this.sea.level();
		if ( sl !== null ) {

			return this.sea.isWater( x, z ) ? this.sea.surfaceAt( x, z ) : null;

		}

		if ( this.segments && this.segments.ready && this.segments.classify( x, z ) !== 'water' ) return null;

		// probe from just over the deck so bridges overhead don't block the ray
		const hit = this._rayDown( x, this.waterY + 3, z, 12 );
		if ( ! hit ) return this.waterY; // unloaded tile — assume open water
		if ( Math.abs( hit.point.y - this.waterY ) > HULL_TOLERANCE ) return null;
		return hit.point.y;

	}

	enter( spawnPoint, viewDir ) {

		const sl = this.sea.level();
		this.waterY = sl !== null ? this.sea.surfaceAt( spawnPoint.x, spawnPoint.z ) : spawnPoint.y;
		this.pos.set( spawnPoint.x, this.waterY, spawnPoint.z );

		this.yaw = Math.atan2( viewDir.x, viewDir.z );
		this.speed = 0;
		this.vel.set( 0, 0, 0 );
		this.aground = false;
		this.spawn.copy( this.pos );
		this.spawnYaw = this.yaw;

		// a steady westerly across the Bay
		if ( this.playArea && this.playArea.ready ) this.windTo.copy( this.playArea.eastDir );
		else this.windTo.set( 1, 0, 0 );

		this.wake.reset();
		this.scene.add( this.body, this.wake.group );

		const { camera } = this;
		const fog = this.scene.fog;
		this._saved = { near: camera.near, far: camera.far, fogNear: fog.near, fogFar: fog.far };
		camera.near = 0.3;
		camera.far = 80000;
		camera.updateProjectionMatrix();
		fog.near = 12000;
		fog.far = 60000;

		this.active = true;
		this.audio.start();
		this.audio.splash( 0.6 );
		this.hud.root.classList.remove( 'hidden' );
		this.hud.hint.textContent = HINT;
		this.hud.balanceWrap.classList.add( 'hidden' );
		if ( document.activeElement ) document.activeElement.blur();

		this._updateBody( 0.016 );
		this._updateCamera( 1, true );

	}

	exit( silent = false ) {

		if ( ! this.active ) return;

		this.active = false;
		this.keys.clear();
		this.scene.remove( this.body, this.wake.group );
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
		this.speed = 0;
		this.vel.set( 0, 0, 0 );
		this.wake.reset();

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

		this._physicsStep( dt );
		this._updateBody( dt );

		// stern wake trails the hull
		_fwd.set( Math.sin( this.yaw ), 0, Math.cos( this.yaw ) );
		_look.copy( this.pos ).addScaledVector( _fwd, - 2.3 );
		this.wake.update( dt, _look, this.speed, this.waterY );

		this.audio.update( dt, { grounded: false, speed: 0, slip: 0, wind: 4 + this.speed * 1.6 } );
		this._updateCamera( dt, false );
		this._updateHUD();

	}

	_physicsStep( h ) {

		const { keys } = this;

		// helm — a boat with no way on barely answers it
		const turn = ( keys.has( 'KeyA' ) ? 1 : 0 ) - ( keys.has( 'KeyD' ) ? 1 : 0 );
		this.yaw += turn * TURN_RATE * MathUtils.clamp( this.speed / 2.5, 0.15, 1 ) / ( 1 + this.speed / 9 ) * h;
		_fwd.set( Math.sin( this.yaw ), 0, Math.cos( this.yaw ) );

		// point of sail: 0 = dead upwind
		this.windAngle = Math.acos( MathUtils.clamp( - _fwd.dot( this.windTo ), - 1, 1 ) );
		_look.set( - _fwd.z, 0, _fwd.x ); // boat's port side — which rail the wind is on
		this.side = Math.sign( this.windTo.dot( _look ) ) || 1;

		const eff = this.windAngle < NO_GO
			? 0
			: MathUtils.smoothstep( this.windAngle, NO_GO, 1.0 ) * ( 0.55 + 0.45 * Math.sin( this.windAngle ) );
		this.eff = eff;
		this.trimmed = keys.has( 'KeyW' );

		if ( this.trimmed && eff > 0 ) {

			const target = MAX_SPEED * eff;
			if ( target > this.speed ) this.speed += ( target - this.speed ) * ( 1 - Math.exp( - SHEET_RATE * h ) );

		}

		this.speed *= Math.exp( - ( keys.has( 'KeyS' ) ? BRAKE_DRAG : WATER_DRAG ) * h );
		if ( this.speed < 0.02 ) this.speed = 0;

		// move axis by axis so the hull slides along a shore instead of sticking
		const dx = _fwd.x * this.speed * h;
		const dz = _fwd.z * this.speed * h;
		this.aground = false;

		if ( dx !== 0 || dz !== 0 ) {

			const sx = Math.sign( dx ) * BOW_LOOKAHEAD;
			const wx = this._probeWater( this.pos.x + dx + sx, this.pos.z );
			if ( wx !== null ) this.pos.x += dx;
			else this.aground = true;

			const sz = Math.sign( dz ) * BOW_LOOKAHEAD;
			const wz = this._probeWater( this.pos.x, this.pos.z + dz + sz );
			if ( wz !== null ) this.pos.z += dz;
			else this.aground = true;

			// scraping the shore kills way fast
			if ( this.aground ) this.speed *= Math.exp( - 3.5 * h );

			// ride the water line as the baked sea drifts a few cm across the bay
			const w = this._probeWater( this.pos.x, this.pos.z );
			if ( w !== null ) this.waterY += ( w - this.waterY ) * Math.min( 1, 4 * h );

		}

		if ( this.playArea ) this.playArea.constrain( this.pos, null, 30 );
		this.pos.y = this.waterY;
		this.vel.copy( _fwd ).multiplyScalar( this.speed );

	}

	_updateBody( dt ) {

		this.body.position.copy( this.pos );
		_q.setFromAxisAngle( UP, this.yaw );
		this.body.quaternion.slerp( _q, 1 - Math.exp( - 8 * dt ) );

		const eff = this.eff || 0;
		const drawing = this.trimmed && eff > 0;
		const speedF = Math.min( this.speed / MAX_SPEED, 1 );

		this.rig.update( dt, {
			speed: this.speed,
			heel: drawing ? this.side * ( 0.08 + 0.28 * eff * speedF ) : this.side * 0.03,
			boomAngle: this.side * MathUtils.clamp( 0.18 + ( this.windAngle - NO_GO ) * 0.42, 0.18, 1.15 ),
			luffing: ! drawing,
		} );

		// foam blooms with speed and breathes a little
		const t = performance.now() / 1000;
		this.foam.material.opacity = speedF * 0.45 + ( this.speed > 0.3 ? 0.08 : 0 );
		const pulse = 1 + Math.sin( t * 3.1 ) * 0.04;
		this.foam.scale.set( ( 1 + speedF * 0.25 ) * pulse, 1, ( 1 + speedF * 0.35 ) * pulse );

	}

	_updateCamera( dt, snap ) {

		_fwd.set( Math.sin( this.yaw ), 0, Math.cos( this.yaw ) );

		const dist = 10.5 + this.speed * 0.35;
		_desired.copy( this.pos )
			.addScaledVector( _fwd, - dist )
			.setY( this.waterY + 3.4 );

		if ( snap ) this.camera.position.copy( _desired );
		else this.camera.position.lerp( _desired, 1 - Math.exp( - 5 * dt ) );
		if ( this.camera.position.y < this.waterY + 1.2 ) this.camera.position.y = this.waterY + 1.2;

		_look.copy( this.pos ).addScaledVector( _fwd, 4 );
		_look.y += 1.4;
		this.camera.lookAt( _look );

	}

	_updateHUD() {

		this.hud.speed.textContent = Math.round( this.speed * 2.237 );

		const deg = this.windAngle * MathUtils.RAD2DEG;
		this.hud.state.textContent =
			this.aground ? 'AGROUND'
				: deg < NO_GO * MathUtils.RAD2DEG ? 'IN IRONS'
					: ! this.trimmed ? 'DRIFT'
						: deg < 60 ? 'CLOSE HAUL'
							: deg < 115 ? 'BEAM REACH'
								: deg < 155 ? 'BROAD REACH' : 'RUN';

	}

}
