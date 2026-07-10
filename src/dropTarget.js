import {
	Group,
	Mesh,
	SphereGeometry,
	RingGeometry,
	MeshBasicMaterial,
	Raycaster,
	Vector2,
	Vector3,
	Quaternion,
	MathUtils,
	DoubleSide,
} from 'three';

const UP = new Vector3( 0, 1, 0 );
const Z_AXIS = new Vector3( 0, 0, 1 );
const _n = new Vector3();
const _fq = new Quaternion();
const _rolledPt = new Vector3();
const _marchPt = new Vector3();
const _f0 = new Vector3();
const _rayO = new Vector3();
const _rayD = new Vector3();

// Spawn-point picker: while active, a pulsing sphere tracks the terrain under
// the cursor (raycast against the tile mesh). A clean click — not a drag, so
// the orbit controls stay usable while aiming — selects the spot.
export class DropTargeter {

	constructor( { scene, camera, tilesGroup, domElement, roll, validate, onSelect, onCancel } ) {

		this.scene = scene;
		this.camera = camera;
		this.tilesGroup = tilesGroup;
		this.domElement = domElement;
		this.roll = roll || null;
		this.validate = validate || null; // point → can the pending mode spawn here?
		this.onSelect = onSelect;
		this.onCancel = onCancel;

		this.active = false;
		this._valid = true;

		this._raycaster = new Raycaster();
		this._raycaster.firstHitOnly = true;
		this._ndc = new Vector2();
		this._hasPointer = false;
		this._hitPoint = null;
		this._downX = 0;
		this._downY = 0;
		this._downTime = 0;
		this._time = 0;

		this._buildMarker();

		domElement.addEventListener( 'pointermove', ( e ) => this._onPointerMove( e ) );
		domElement.addEventListener( 'pointerdown', ( e ) => this._onPointerDown( e ) );
		domElement.addEventListener( 'pointerup', ( e ) => this._onPointerUp( e ) );
		window.addEventListener( 'keydown', ( e ) => {

			if ( this.active && e.code === 'Escape' ) this.cancel();

		} );

	}

	_buildMarker() {

		const marker = new Group();

		this.sphere = new Mesh(
			new SphereGeometry( 1, 24, 16 ),
			new MeshBasicMaterial( {
				color: 0x4fc3f7,
				transparent: true,
				opacity: 0.4,
				depthWrite: false,
			} )
		);
		marker.add( this.sphere );

		this.ring = new Mesh(
			new RingGeometry( 1.3, 1.55, 40 ),
			new MeshBasicMaterial( {
				color: 0x4fc3f7,
				transparent: true,
				opacity: 0.8,
				depthWrite: false,
				side: DoubleSide,
			} )
		);
		marker.add( this.ring );

		marker.visible = false;
		marker.renderOrder = 10;
		this.marker = marker;

	}

	begin() {

		if ( this.active ) return;
		this.active = true;
		this._hitPoint = null;
		this.marker.visible = false;
		this.scene.add( this.marker );
		this.domElement.style.cursor = 'crosshair';

	}

	cancel() {

		if ( ! this.active ) return;
		this._end();
		if ( this.onCancel ) this.onCancel();

	}

	_end() {

		this.active = false;
		this.scene.remove( this.marker );
		this.domElement.style.cursor = '';

	}

	update( dt ) {

		if ( ! this.active ) return;

		this._time += dt;

		if ( ! this._hasPointer ) {

			this.marker.visible = false;
			return;

		}

		const rolled = this.roll && this.roll.k > 0;
		const hit = this._pick( rolled );

		if ( ! hit ) {

			this.marker.visible = false;
			this._hitPoint = null;
			return;

		}

		// hit.point is always in flat space (what the modes need); the marker
		// renders in rolled space alongside the shader-curled tiles
		this._hitPoint = ( this._hitPoint || new Vector3() ).copy( hit.point );
		const renderPt = rolled ? this.roll.pointToRolled( hit.point, _rolledPt ) : hit.point;

		// unlandable spots (a sailboat over dry land) show red and refuse clicks
		this._valid = ! this.validate || this.validate( this._hitPoint );
		const color = this._valid ? 0x4fc3f7 : 0xff6a5f;
		this.sphere.material.color.setHex( color );
		this.ring.material.color.setHex( color );

		const marker = this.marker;
		marker.visible = true;
		marker.position.copy( renderPt );

		// readable from any altitude, with a soft pulse
		const dist = this.camera.position.distanceTo( renderPt );
		const s = MathUtils.clamp( dist * 0.03, 1.5, 600 ) * ( 1 + 0.08 * Math.sin( this._time * 5 ) );
		marker.scale.setScalar( s );

		// lay the ring onto the surface
		if ( hit.face ) {

			_n.copy( hit.face.normal ).transformDirection( hit.object.matrixWorld );
			if ( _n.y < 0 ) _n.negate();
			if ( rolled ) _n.applyQuaternion( this.roll.frameQuatAt( hit.point, _fq ) );
			this.ring.quaternion.setFromUnitVectors( Z_AXIS, _n );
			this.ring.position.copy( _n ).multiplyScalar( 0.05 );

		} else {

			this.ring.quaternion.setFromUnitVectors( Z_AXIS, UP );
			this.ring.position.set( 0, 0.05, 0 );

		}

	}

	// Cursor pick against the tiles. Flat: one straight raycast. Rolled: the
	// screen ray lives in rolled (render) space while the geometry is flat, so
	// treat the map as a heightfield — march the rolled ray, unroll each
	// sample, compare its flat height against the terrain below it, and bisect
	// the first crossing. (Raycasting unrolled chords fails near the cylinder
	// axis, where a short straight rolled segment unrolls into a km-long arc.)
	_pick( rolled ) {

		this._raycaster.setFromCamera( this._ndc, this.camera );
		this._raycaster.near = 0;
		this._raycaster.far = Infinity;

		if ( ! rolled ) return this._raycaster.intersectObject( this.tilesGroup, true )[ 0 ];

		_rayO.copy( this._raycaster.ray.origin );
		_rayD.copy( this._raycaster.ray.direction );

		const MAX_T = 42000;
		const MAX_STEP = 600;
		const MIN_STEP = 2;

		let tAbove = null; // last sample known to be airborne
		let t = 0;

		for ( let i = 0; i < 240 && t <= MAX_T; i ++ ) {

			const h = this._heightAboveGround( t );

			if ( h === null ) {

				// over unloaded / off-map ground — stride forward blindly
				tAbove = null;
				t += MAX_STEP;
				continue;

			}

			if ( h <= 0.5 ) {

				// never been airborne yet — the ray starts below ground in
				// flat space (e.g. aiming from outside the opaque hull), so
				// advance until it emerges into interior air
				if ( tAbove === null ) {

					t += MathUtils.clamp( - h * 0.8, MIN_STEP, MAX_STEP );
					continue;

				}

				// crossed (or grazed) the surface — narrow down the crossing
				let lo = tAbove;
				let hi = t;
				for ( let j = 0; j < 10; j ++ ) {

					const mid = ( lo + hi ) / 2;
					const hm = this._heightAboveGround( mid );
					if ( hm !== null && hm > 0.5 ) lo = mid;
					else hi = mid;

				}

				this._heightAboveGround( hi ); // leave _groundHit at the crossing
				return this._groundHit;

			}

			tAbove = t;
			t += MathUtils.clamp( h * 0.8, MIN_STEP, MAX_STEP );

		}

		return null;

	}

	// Flat-space clearance of the rolled-ray sample at parameter t over the
	// terrain beneath it; the supporting downward hit lands in _groundHit.
	_heightAboveGround( t ) {

		_marchPt.copy( _rayO ).addScaledVector( _rayD, t );
		this.roll.pointToFlat( _marchPt, _f0 );

		this._raycaster.ray.origin.set( _f0.x, 5000, _f0.z );
		this._raycaster.ray.direction.set( 0, - 1, 0 );
		this._raycaster.far = 12000;
		const hit = this._raycaster.intersectObject( this.tilesGroup, true )[ 0 ];
		if ( ! hit ) return null;

		this._groundHit = hit;
		return _f0.y - hit.point.y;

	}

	_onPointerMove( e ) {

		const rect = this.domElement.getBoundingClientRect();
		this._ndc.set(
			( ( e.clientX - rect.left ) / rect.width ) * 2 - 1,
			- ( ( e.clientY - rect.top ) / rect.height ) * 2 + 1
		);
		this._hasPointer = true;

	}

	_onPointerDown( e ) {

		this._downX = e.clientX;
		this._downY = e.clientY;
		this._downTime = performance.now();

	}

	_onPointerUp( e ) {

		if ( ! this.active || e.button !== 0 ) return;

		// a drag is navigation, not a selection
		const moved = Math.hypot( e.clientX - this._downX, e.clientY - this._downY );
		const held = performance.now() - this._downTime;
		if ( moved > 6 || held > 500 ) return;

		if ( this._hitPoint && this._valid ) {

			const point = this._hitPoint.clone();
			this._end();
			this.onSelect( point );

		}

	}

}
