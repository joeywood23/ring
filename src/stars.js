import {
	BufferGeometry,
	BufferAttribute,
	Points,
	PointsMaterial,
	Group,
} from 'three';

// Decorative starfield fixed in inertial space. The habitat itself spins
// (the roll shader's uRollSpin stage, at the true 1g rate ω = √(g/R)), so in
// god view the cylinder visibly turns against a still sky, and from inside —
// where the camera co-rotates with the ground — the stars appear to wheel
// past the open ends.

const STAR_RADIUS = 45000; // m — safely inside skate mode's 60 km far plane

export class StarField {

	constructor( playArea, cylRadius, groundY ) {

		this.group = new Group();
		// centred on the hub so both end holes read the same sky
		this.group.position.set( playArea.center.x, groundY + cylRadius, playArea.center.z );

		this.group.add(
			this._layer( 3600, 1.6, 0.75 ), // faint background dust
			this._layer( 900, 2.6, 1.0 )    // brighter foreground stars
		);

	}

	_layer( count, size, opacity ) {

		const pos = new Float32Array( count * 3 );
		const col = new Float32Array( count * 3 );

		for ( let i = 0; i < count; i ++ ) {

			// uniform direction on the sphere
			const z = Math.random() * 2 - 1;
			const a = Math.random() * Math.PI * 2;
			const r = Math.sqrt( 1 - z * z );
			pos[ i * 3 + 0 ] = Math.cos( a ) * r * STAR_RADIUS;
			pos[ i * 3 + 1 ] = z * STAR_RADIUS;
			pos[ i * 3 + 2 ] = Math.sin( a ) * r * STAR_RADIUS;

			// mostly white, a scatter of cool blues and warm ambers
			const t = Math.random();
			const b = 0.55 + 0.45 * Math.random(); // brightness
			let rC = 1, gC = 1, bC = 1;
			if ( t < 0.18 ) { rC = 0.72; gC = 0.83; }      // blue
			else if ( t < 0.32 ) { gC = 0.9; bC = 0.72; }  // amber
			col[ i * 3 + 0 ] = rC * b;
			col[ i * 3 + 1 ] = gC * b;
			col[ i * 3 + 2 ] = bC * b;

		}

		const geo = new BufferGeometry();
		geo.setAttribute( 'position', new BufferAttribute( pos, 3 ) );
		geo.setAttribute( 'color', new BufferAttribute( col, 3 ) );

		const mat = new PointsMaterial( {
			size,
			sizeAttenuation: false,
			vertexColors: true,
			transparent: true,
			opacity,
			depthWrite: false,
			fog: false, // skate-mode fog would swallow the sky entirely
		} );

		const points = new Points( geo, mat );
		points.frustumCulled = false;
		return points;

	}

}
