import {
	MathUtils,
	Vector3,
	Quaternion,
	Matrix4,
	Frustum,
	Sphere,
	Mesh,
	Group,
	PlaneGeometry,
	CylinderGeometry,
	MeshBasicMaterial,
	AdditiveBlending,
} from 'three';
import { distortionUniforms, patchRollOnly } from './effects.js';

// O'Neill cylinder solver: rolls the flat Bay Area into a space-habitat
// cylinder. The map is treated as an inextensible sheet bent with uniform
// curvature k about the north–south axis (the GLSL lives in effects.js —
// ringRoll). Arc length is preserved, so at k = π / halfWidth the east and
// west edges meet overhead and the map closes end-to-end into a cylinder of
// radius halfWidth / π (≈ 5.3 km for the play bounds) whose interior surface
// is the city. The solver owns the animation state and pushes curvature into
// the shared shader uniforms.

const FULL_ROLL_TIME = 10; // seconds for a complete flat ↔ cylinder transit
const G = 9.81;
// True 1g spin (ω = √(g/R), ~2.4 min/rev) reads frantic from god view — run
// the show at a tenth of physical speed (~24 min/rev).
const SPIN_SLOWDOWN = 10;

const _axis = new Vector3();
const _q = new Quaternion();
const _one = new Vector3( 1, 1, 1 );
const _viewPos = new Vector3();
const _viewQuat = new Quaternion();
const _mat = new Matrix4();
const _sphere = new Sphere();

export class CylinderRoll {

	constructor() {

		this.ready = false;
		this.u = 0;      // linear animation phase 0..1 (eased before display)
		this.target = 0;
		this.radius = 0; // metres, once configured
		this._k1 = 0;    // curvature when fully rolled
		this.spinAngle = 0;
		this.spinOmega = 0;
		this.spinPaused = false;
		this.closure = 0; // how "closed" the cylinder is — gates spin gravity

	}

	// Needs the play-area frame, so call after PlayArea.configure().
	configure( playArea ) {

		this._k1 = Math.PI / playArea.halfWidth;
		this.radius = playArea.halfWidth / Math.PI;
		this.spinOmega = Math.sqrt( G / this.radius ) / SPIN_SLOWDOWN;
		distortionUniforms.uRollCenter.value.set( playArea.center.x, playArea.center.z );
		distortionUniforms.uRollEast.value
			.set( playArea.eastDir.x, playArea.eastDir.z )
			.normalize();
		distortionUniforms.uRollRadius.value = this.radius;
		this.ready = true;

	}

	// Ground reference: geometry at this height lands exactly on the shell.
	setGround( y ) {

		distortionUniforms.uRollGround.value = y;

	}

	setTarget( t ) {

		this.target = MathUtils.clamp( t, 0, 1 );

	}

	// Jump phase and target together — manual slider scrub, no easing fight.
	scrub( t ) {

		this.u = this.target = MathUtils.clamp( t, 0, 1 );

	}

	toggle() {

		this.setTarget( this.target > 0.5 ? 0 : 1 );

	}

	get animating() {

		return this.u !== this.target;

	}

	// current curvature (0 = flat) — the JS mirror of the shader's uRollK
	get k() {

		return distortionUniforms.uRollK.value;

	}

	// flat-space height of the hub axis
	get hubY() {

		return distortionUniforms.uRollGround.value + distortionUniforms.uRollRadius.value;

	}

	// ------------------------------------------------------------------
	// Spin gravity. Rotational gravity is ω²r — linear in the distance to
	// the axis — and the roll maps flat height straight onto that distance,
	// so one signed factor covers the whole habitat: 1 g at the shell, zero
	// on the hub axis, negative past it (outward toward the far side).
	// Blends back to uniform 1 g while the sheet is open.
	// ------------------------------------------------------------------

	gravityAt( y ) {

		if ( ! this.ready || this.closure <= 0 ) return 1;
		const f = ( this.hubY - y ) / distortionUniforms.uRollRadius.value;
		return MathUtils.lerp( 1, f, this.closure );

	}

	// has a flat-space point risen past the hub axis? (only once closed)
	pastAxis( y ) {

		return this.ready && this.closure > 0.999 && y > this.hubY;

	}

	// ------------------------------------------------------------------
	// Axis crossing. Every rolled point has two flat preimages — (e, h) and
	// the antipodal (e ± halfWidth, 2·hubY − y) — and both render to the
	// same place, so swapping branches mid-flight is invisible. Cross when
	// a faller passes the hub: on the new branch the terrain they're
	// heading for is genuinely beneath them, gravity reads positive again,
	// and the ordinary flat-space machinery (raycasts, camera, physics)
	// just keeps working. seamPoint remaps a position, seamDir applies the
	// matching π rotation about the north axis to a direction.
	// ------------------------------------------------------------------

	seamPoint( p ) {

		const c = distortionUniforms.uRollCenter.value;
		const E = distortionUniforms.uRollEast.value;
		const halfW = Math.PI / this._k1;

		const rx = p.x - c.x, rz = p.z - c.y;
		let e = rx * E.x + rz * E.y;
		const n = rx * ( - E.y ) + rz * E.x;
		e += e < 0 ? halfW : - halfW; // antipodal east coordinate, wrapped in-bounds

		return p.set(
			c.x + E.x * e - E.y * n,
			2 * this.hubY - p.y,
			c.y + E.y * e + E.x * n
		);

	}

	seamDir( v ) {

		const E = distortionUniforms.uRollEast.value;
		const ve = v.x * E.x + v.z * E.y;
		v.x -= 2 * ve * E.x;
		v.z -= 2 * ve * E.y;
		v.y = - v.y;
		return v;

	}

	// ------------------------------------------------------------------
	// JS mirrors of the ringRoll GLSL. Physics always runs in flat space;
	// these map between flat space and the rolled (rendered) space for the
	// chase camera and for picking points on the curved surface. Because
	// the roll is an isometry, flat -Y gravity maps exactly to "radially
	// outward from the cylinder axis" — O'Neill spin gravity for free.
	// ------------------------------------------------------------------

	// flat → rolled (out may alias p)
	pointToRolled( p, out = p ) {

		const k = this.k;
		if ( k <= 0 ) return out.copy( p );

		const c = distortionUniforms.uRollCenter.value;
		const E = distortionUniforms.uRollEast.value;
		const nx = - E.y, nz = E.x; // in-plane north, same convention as GLSL
		const y0 = distortionUniforms.uRollGround.value;

		const rx = p.x - c.x, rz = p.z - c.y;
		const e = rx * E.x + rz * E.y;
		const n = rx * nx + rz * nz;
		const h = p.y - y0;
		const th = e * k;

		const s = Math.sin( th );
		const co = Math.cos( th );
		const sinc = Math.abs( th ) < 1e-6 ? 1 : s / th;
		const vers = Math.abs( th ) < 1e-6 ? th * 0.5 : ( 1 - co ) / th;

		const eArc = e * sinc - h * s;
		out.set(
			c.x + E.x * eArc + nx * n,
			y0 + e * vers + h * co,
			c.y + E.y * eArc + nz * n
		);
		return this._spin( out, distortionUniforms.uRollSpin.value );

	}

	// rigid rotation about the hub axis (mirror of the GLSL spin block)
	_spin( p, angle ) {

		if ( angle === 0 ) return p;

		const c = distortionUniforms.uRollCenter.value;
		const E = distortionUniforms.uRollEast.value;
		const nx = - E.y, nz = E.x;
		const hubY = distortionUniforms.uRollGround.value + distortionUniforms.uRollRadius.value;

		const rx = p.x - c.x, rz = p.z - c.y;
		const u = rx * E.x + rz * E.y;
		const a = rx * nx + rz * nz;
		const v = p.y - hubY;

		const cs = Math.cos( angle ), sn = Math.sin( angle );
		const u2 = u * cs - v * sn;
		const v2 = u * sn + v * cs;

		return p.set(
			c.x + E.x * u2 + nx * a,
			hubY + v2,
			c.y + E.y * u2 + nz * a
		);

	}

	// rolled → flat, closed form (out may alias q)
	pointToFlat( q, out = q ) {

		const k = this.k;
		if ( k <= 0 ) return out.copy( q );

		const c = distortionUniforms.uRollCenter.value;
		const E = distortionUniforms.uRollEast.value;
		const nx = - E.y, nz = E.x;
		const y0 = distortionUniforms.uRollGround.value;

		// undo the habitat spin before unrolling
		this._spin( out.copy( q ), - distortionUniforms.uRollSpin.value );

		const rx = out.x - c.x, rz = out.z - c.y;
		const u = rx * E.x + rz * E.y;
		const n = rx * nx + rz * nz;
		const v = out.y - y0;

		// the shell point (u, v) sits at radius r about the bend centre 1/k
		const R0 = 1 / k;
		const th = Math.atan2( u, R0 - v );
		const r = Math.hypot( u, R0 - v );
		const e = th / k;
		const h = R0 - r;

		return out.set(
			c.x + E.x * e + nx * n,
			y0 + h,
			c.y + E.y * e + nz * n
		);

	}

	// local frame rotation of the roll at a flat-space position: a rotation
	// by θ = k·e about the north axis (up → inward radial, east → tangent).
	// The habitat spin turns about the same axis direction, so it just adds.
	frameQuatAt( p, outQuat ) {

		const k = this.k;
		if ( k <= 0 ) return outQuat.identity();

		const c = distortionUniforms.uRollCenter.value;
		const E = distortionUniforms.uRollEast.value;
		const e = ( p.x - c.x ) * E.x + ( p.z - c.y ) * E.y;
		_axis.set( - E.y, 0, E.x );
		return outQuat.setFromAxisAngle( _axis, e * k + distortionUniforms.uRollSpin.value );

	}

	// move a flat-space camera pose into rolled space (mutates both)
	poseToRolled( position, quaternion ) {

		if ( this.k <= 0 ) return;
		this.frameQuatAt( position, _q );
		this.pointToRolled( position );
		quaternion.premultiply( _q );

	}

	// roll angle θ = k·e of a flat-space position
	angleAt( p ) {

		const c = distortionUniforms.uRollCenter.value;
		const E = distortionUniforms.uRollEast.value;
		return ( ( p.x - c.x ) * E.x + ( p.z - c.y ) * E.y ) * this.k;

	}

	update( dt ) {

		if ( ! this.ready ) return;

		if ( this.u !== this.target ) {

			const step = dt / FULL_ROLL_TIME;
			this.u += MathUtils.clamp( this.target - this.u, - step, step );

		}

		// smoothstep easing keeps lift-off and the final closing gentle
		const t = this.u * this.u * ( 3 - 2 * this.u );
		distortionUniforms.uRollK.value = t * this._k1;
		this.closure = MathUtils.smoothstep( this.u, 0.85, 1 );

		// the habitat only spins once fully closed (a partially rolled sheet
		// cartwheeling about the hub would just look broken); pause freezes
		// the angle in place, everything else keeps working
		if ( this.u >= 1 && ! this.spinPaused ) {

			this.spinAngle = ( this.spinAngle + this.spinOmega * dt ) % ( Math.PI * 2 );

		}
		distortionUniforms.uRollSpin.value = this.u >= 1 ? this.spinAngle : 0;

	}

}

// Opaque outer hull for god view: a flat plane sitting below the whole map
// that the roll shader curls into the cylinder's outside skin. Its faces
// point down in flat space — outward once rolled — so from outside the
// habitat reads as a solid shell while from inside it is backface-culled
// away. raycast is a no-op so controls, picking, and physics never see it.
const HULL_DEPTH = 150; // metres below sea level — outside all terrain

export function createHullMesh( playArea, groundY ) {

	const geo = new PlaneGeometry( playArea.halfWidth * 2, playArea.halfHeight * 2, 256, 8 );
	geo.rotateX( Math.PI / 2 ); // face down → outward when rolled

	const mat = new MeshBasicMaterial( { color: 0x6d7681 } );
	patchRollOnly( mat );

	const mesh = new Mesh( geo, mat );
	mesh.position.set( playArea.center.x, groundY - HULL_DEPTH, playArea.center.z );
	mesh.frustumCulled = false; // flat bounds lie about the rolled shell
	mesh.raycast = () => {};
	return mesh;

}

// Sun rod: a light-emitting solid down the habitat's central axis — the
// classic O'Neill light source, and a landmark that shows the player the hub
// from anywhere on the shell. A bright core cylinder plus a wider additive
// halo sleeve, spanning the full habitat length along the north–south axis
// through the map center. It sits at uRollGround + radius, the same hub the
// spin math uses, and only fades in as the cylinder closes — a sun rod
// floating over a half-rolled sheet would read as a glitch. Rotationally
// symmetric about the spin axis, so the habitat spin needs no handling.
const ROD_RADIUS_FRAC = 0.022; // core radius as a fraction of the tube radius

export class AxisLight {

	constructor( playArea, radius ) {

		const len = playArea.halfHeight * 2;
		const core = radius * ROD_RADIUS_FRAC;

		this._coreMat = new MeshBasicMaterial( { color: 0xfff3cf, fog: false, transparent: true } );
		const coreMesh = new Mesh( new CylinderGeometry( core, core, len, 24, 1 ), this._coreMat );

		this._haloMat = new MeshBasicMaterial( {
			color: 0xffe9a8,
			fog: false,
			transparent: true,
			blending: AdditiveBlending,
			depthWrite: false,
		} );
		const halo = new Mesh( new CylinderGeometry( core * 3.2, core * 3.2, len, 24, 1, true ), this._haloMat );

		this.group = new Group();
		this.group.add( coreMesh, halo );

		// lie along the cylinder axis: north–south through the map center
		this.group.quaternion.setFromUnitVectors( new Vector3( 0, 1, 0 ), playArea.northDir );
		this.group.position.set( playArea.center.x, 0, playArea.center.z ); // y tracks the hub per frame

		// pure light: picking, physics, and grounding rays pass through it
		coreMesh.raycast = () => {};
		halo.raycast = () => {};

	}

	// fade with the roll phase; hub height follows the calibrated ground
	update( u ) {

		const a = MathUtils.smoothstep( u, 0.85, 1 );
		this.group.visible = a > 0.001;
		if ( ! this.group.visible ) return;

		this.group.position.y =
			distortionUniforms.uRollGround.value + distortionUniforms.uRollRadius.value;
		this._coreMat.opacity = a;
		this._haloMat.opacity = 0.16 * a;

	}

}

// Tile LOD is computed by 3d-tiles-renderer with flat-space camera distance,
// so the far side of the cylinder — ~10 km overhead but 16-30 km away flat,
// and face-on instead of horizon-grazing — selects horizon-grade tiles: a
// wall of low detail. This plugin re-reports each tile's screen-space error
// using the rolled distance from the actual render pose, plus a boost that
// ramps in with the tile's roll angle away from the viewer (the "wall-ness"),
// since SSE assumes grazing viewing that the curled shell violates. The lib
// combines plugin errors with Math.max, so this only ever raises detail, and
// the play-region mask plugin still suppresses out-of-bounds tiles. The roll
// is a chord contraction, so a tile's flat bounding sphere rolled about its
// centre still conservatively contains the tile.
const WALL_BOOST = 2.0; // extra error factor fully up the wall (~1 LOD level)

export class RollLODPlugin {

	constructor( roll ) {

		this.name = 'ROLL_LOD_PLUGIN';
		this.roll = roll;
		this.tiles = null;
		this.enabled = false;
		this.camPos = new Vector3();
		this.frustum = new Frustum();
		this.sseDenominator = 0;
		this.thetaCam = 0;

	}

	init( tiles ) {

		this.tiles = tiles;

	}

	// Call each frame before tiles.update() with the flat camera; `embodied`
	// says whether the render pose will be rolled (ground modes) or not (map).
	setView( camera, embodied ) {

		this.enabled = this.roll.k > 0 && !! this.tiles;
		if ( ! this.enabled ) return;

		this.thetaCam = this.roll.angleAt( camera.position );

		_viewPos.copy( camera.position );
		_viewQuat.copy( camera.quaternion );
		if ( embodied ) this.roll.poseToRolled( _viewPos, _viewQuat );
		this.camPos.copy( _viewPos );

		_mat.compose( _viewPos, _viewQuat, _one ).invert().premultiply( camera.projectionMatrix );
		this.frustum.setFromProjectionMatrix( _mat, camera.coordinateSystem, camera.reversedDepth );

		const info = this.tiles.cameraInfo && this.tiles.cameraInfo[ 0 ];
		this.sseDenominator = info && ! info.isOrthographic ? info.sseDenominator : 0;

	}

	calculateTileViewError( tile, target ) {

		if ( ! this.enabled || this.sseDenominator <= 0 ) return false;

		const bv = tile.engineData && tile.engineData.boundingVolume;
		if ( ! bv ) return false;

		bv.getSphere( _sphere );
		_sphere.applyMatrix4( this.tiles.group.matrixWorld ); // → flat world

		const dTheta = Math.abs( this.roll.angleAt( _sphere.center ) - this.thetaCam );
		this.roll.pointToRolled( _sphere.center );
		if ( ! this.frustum.intersectsSphere( _sphere ) ) return false; // flat behavior

		const dist = Math.max( _sphere.center.distanceTo( this.camPos ) - _sphere.radius, 0 );
		const boost = 1 + ( WALL_BOOST - 1 ) * MathUtils.smoothstep( dTheta, 0.25, 1.0 );

		target.inView = true;
		target.distance = dist;
		target.error = dist === 0
			? Infinity
			: boost * tile.geometricError / ( dist * this.sseDenominator );
		return true;

	}

}
