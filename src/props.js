import {
	Group,
	Mesh,
	Shape,
	ExtrudeGeometry,
	CylinderGeometry,
	MeshLambertMaterial,
	Vector3,
	Quaternion,
} from 'three';

// Spawnable skate props. Ramps live in `rideable`, which SkateMode includes in
// its ground/wall raycasts, so the regular rolling physics carries the skater
// up the curved face and launches them off the lip. Rails are not raycast
// terrain — grinding is handled as its own state in SkateMode using the
// segment records kept in `rails`.

const RAMP_HEIGHT = 1.8;
const RAMP_EXIT_ANGLE = 0.96; // rad (~55°) — face is a circular arc up to this
const RAMP_WIDTH = 4;
const RAIL_LENGTH = 12;
const RAIL_HEIGHT = 0.55;
const RAIL_RADIUS = 0.05;

const WOOD = new MeshLambertMaterial( { color: 0x9a7b4f } );
const METAL = new MeshLambertMaterial( { color: 0xc4c9d4 } );

const UP = new Vector3( 0, 1, 0 );
const _dir = new Vector3();
const _q = new Quaternion();

export class SkatePark {

	constructor( { scene } ) {

		this.rideable = new Group(); // ramps — part of the skate physics ground
		this.group = new Group();    // everything else (rails)
		scene.add( this.rideable, this.group );
		this.rails = [];             // { p0, p1, dir, len } along the rail top

	}

	// Curved kicker: circular-arc face tangent to the ground at the entry,
	// leaving at RAMP_EXIT_ANGLE. Extruded profile gives a solid wedge.
	spawnRamp( point, yaw ) {

		const R = RAMP_HEIGHT / ( 1 - Math.cos( RAMP_EXIT_ANGLE ) );
		const shape = new Shape();
		shape.moveTo( 0, 0 );

		const N = 16;
		for ( let i = 1; i <= N; i ++ ) {

			const th = RAMP_EXIT_ANGLE * ( i / N );
			shape.lineTo( R * Math.sin( th ), R * ( 1 - Math.cos( th ) ) );

		}

		shape.lineTo( R * Math.sin( RAMP_EXIT_ANGLE ), 0 ); // vertical back wall

		const geo = new ExtrudeGeometry( shape, { depth: RAMP_WIDTH, bevelEnabled: false } );
		geo.translate( 0, 0, - RAMP_WIDTH / 2 ); // center across the width
		if ( geo.computeBoundsTree ) geo.computeBoundsTree();

		const mesh = new Mesh( geo, WOOD );
		// profile X = up-slope direction; rotate it onto the skater's heading
		mesh.rotation.y = yaw - Math.PI / 2;
		mesh.position.copy( point );
		mesh.position.y -= 0.04; // sink slightly so there's no seam at the entry

		this.rideable.add( mesh );

	}

	// Straight grind rail on two posts, running along the given heading.
	spawnRail( point, yaw ) {

		_dir.set( Math.sin( yaw ), 0, Math.cos( yaw ) );

		const rail = new Group();
		const railY = point.y + RAIL_HEIGHT;

		const p0 = new Vector3( point.x, railY, point.z );
		const p1 = p0.clone().addScaledVector( _dir, RAIL_LENGTH );

		const bar = new Mesh( new CylinderGeometry( RAIL_RADIUS, RAIL_RADIUS, RAIL_LENGTH, 10 ), METAL );
		bar.position.lerpVectors( p0, p1, 0.5 );
		bar.quaternion.copy( _q.setFromUnitVectors( UP, _dir ) );
		rail.add( bar );

		for ( const t of [ 1.2, RAIL_LENGTH - 1.2 ] ) {

			const post = new Mesh( new CylinderGeometry( 0.04, 0.04, RAIL_HEIGHT, 8 ), METAL );
			post.position.copy( p0 ).addScaledVector( _dir, t );
			post.position.y = point.y + RAIL_HEIGHT / 2;
			rail.add( post );

		}

		this.group.add( rail );
		this.rails.push( { p0, p1, dir: _dir.clone(), len: RAIL_LENGTH } );

	}

	clear() {

		for ( const g of [ this.rideable, this.group ] ) {

			while ( g.children.length ) g.remove( g.children[ 0 ] );

		}

		this.rails.length = 0;

	}

}
