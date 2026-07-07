import {
	Group,
	Mesh,
	SphereGeometry,
	RingGeometry,
	MeshBasicMaterial,
	Raycaster,
	Vector2,
	Vector3,
	MathUtils,
	DoubleSide,
} from 'three';

const UP = new Vector3( 0, 1, 0 );
const Z_AXIS = new Vector3( 0, 0, 1 );
const _n = new Vector3();

// Spawn-point picker: while active, a pulsing sphere tracks the terrain under
// the cursor (raycast against the tile mesh). A clean click — not a drag, so
// the orbit controls stay usable while aiming — selects the spot.
export class DropTargeter {

	constructor( { scene, camera, tilesGroup, domElement, onSelect, onCancel } ) {

		this.scene = scene;
		this.camera = camera;
		this.tilesGroup = tilesGroup;
		this.domElement = domElement;
		this.onSelect = onSelect;
		this.onCancel = onCancel;

		this.active = false;

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

		this._raycaster.setFromCamera( this._ndc, this.camera );
		this._raycaster.near = 0;
		this._raycaster.far = Infinity;
		const hit = this._raycaster.intersectObject( this.tilesGroup, true )[ 0 ];

		if ( ! hit ) {

			this.marker.visible = false;
			this._hitPoint = null;
			return;

		}

		this._hitPoint = ( this._hitPoint || new Vector3() ).copy( hit.point );

		const marker = this.marker;
		marker.visible = true;
		marker.position.copy( hit.point );

		// readable from any altitude, with a soft pulse
		const dist = this.camera.position.distanceTo( hit.point );
		const s = MathUtils.clamp( dist * 0.03, 1.5, 600 ) * ( 1 + 0.08 * Math.sin( this._time * 5 ) );
		marker.scale.setScalar( s );

		// lay the ring onto the surface
		if ( hit.face ) {

			_n.copy( hit.face.normal ).transformDirection( hit.object.matrixWorld );
			if ( _n.y < 0 ) _n.negate();
			this.ring.quaternion.setFromUnitVectors( Z_AXIS, _n );
			this.ring.position.copy( _n ).multiplyScalar( 0.05 );

		} else {

			this.ring.quaternion.setFromUnitVectors( Z_AXIS, UP );
			this.ring.position.set( 0, 0.05, 0 );

		}

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

		if ( this._hitPoint ) {

			const point = this._hitPoint.clone();
			this._end();
			this.onSelect( point );

		}

	}

}
