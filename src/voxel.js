import {
	Vector3,
	Raycaster,
	InstancedMesh,
	BoxGeometry,
	MeshLambertMaterial,
	Matrix4,
	Color,
	MathUtils,
} from 'three';
import { distortionUniforms } from './effects.js';
import { CLASS_RGB } from './segment.js';

// Voxelization of the photogrammetry: the mesh's height field is sampled into
// columns (BVH raycasts), each column is colored by the segmentation class
// underneath, and the zone is rendered as instanced cubes. The shader discards
// the real mesh inside the zone (uVoxelCenter/uVoxelRadius in effects.js), so
// the world genuinely turns to voxels there — while physics raycasts still
// run against the hidden mesh, so every mode keeps working inside it.

const ZONE_RADIUS = 480;    // metres of voxels around the focus
const REFRESH_DIST = 240;   // rebuild when the focus strays this far
const JOB_BUDGET_MS = 6;    // per-frame sampling/build budget
const MAX_COLUMN = 48;      // cap voxels per column (cliffs, towers)
const OTHER_RGB = [ 186, 178, 158 ]; // unclassified ground — dirt / pavement

const _m = new Matrix4();
const _c = new Color();

export class VoxelWorld {

	constructor( { scene, tilesGroup, segments } ) {

		this.scene = scene;
		this.tilesGroup = tilesGroup;
		this.segments = segments;

		this.enabled = false;
		this.status = 'off';
		this.size = 6;

		this.mesh = null;
		this._center = new Vector3();
		this._have = false;
		this._jobs = [];
		this._building = false;

		this._raycaster = new Raycaster();
		this._raycaster.firstHitOnly = true;

	}

	setActive( value ) {

		this.enabled = value;

		if ( value ) {

			this.segments.ensureData(); // voxel colors come from the coverage map
			this._have = false;
			this.status = 'waiting…';

		} else {

			this._jobs.length = 0;
			this._building = false;
			this._dispose();
			distortionUniforms.uVoxelRadius.value = 0;
			this.status = 'off';

		}

	}

	setSize( size ) {

		this.size = size;
		if ( this.enabled ) this._have = false; // rebuild on next update

	}

	update( focus ) {

		if ( ! this.enabled ) return;

		if ( ( ! this._have || focus.distanceTo( this._center ) > REFRESH_DIST ) && ! this._building ) {

			this._queueBuild( focus.clone() );

		}

		const start = performance.now();
		while ( this._jobs.length && performance.now() - start < JOB_BUDGET_MS ) {

			this._jobs.shift()();

		}

	}

	// --- height sampling ---------------------------------------------------------

	_top( x, z ) {

		this._raycaster.ray.origin.set( x, 1500, z );
		this._raycaster.ray.direction.set( 0, - 1, 0 );
		this._raycaster.near = 0;
		this._raycaster.far = 3000;
		const hit = this._raycaster.intersectObject( this.tilesGroup, true )[ 0 ];
		return hit ? hit.point.y : NaN;

	}

	_queueBuild( center ) {

		this._building = true;
		const jobs = this._jobs;
		jobs.length = 0;

		const size = this.size;
		const n = Math.ceil( ( ZONE_RADIUS * 2 ) / size );
		const heights = new Float32Array( n * n ).fill( NaN );
		const x0 = center.x - ZONE_RADIUS + size / 2;
		const z0 = center.z - ZONE_RADIUS + size / 2;

		for ( let iz = 0; iz < n; iz ++ ) {

			jobs.push( () => {

				const z = z0 + iz * size;
				for ( let ix = 0; ix < n; ix ++ ) {

					heights[ iz * n + ix ] = this._top( x0 + ix * size, z );

				}

				this.status = `sampling heights… ${ Math.round( ( iz + 1 ) / n * 100 ) }%`;

			} );

		}

		jobs.push( () => this._buildInstances( center, n, heights, x0, z0 ) );

	}

	// --- instancing -----------------------------------------------------------------

	_buildInstances( center, n, heights, x0, z0 ) {

		const size = this.size;

		// column top indices, then fill depth down to the lowest neighbor so
		// slopes and building walls have no see-through gaps
		const tops = new Int32Array( n * n );
		const depths = new Int32Array( n * n );
		let count = 0;

		for ( let iz = 0; iz < n; iz ++ ) {

			for ( let ix = 0; ix < n; ix ++ ) {

				const i = iz * n + ix;
				const h = heights[ i ];
				if ( Number.isNaN( h ) ) continue;

				// voxels fill the same disc the shader carves out of the mesh
				const dx = x0 + ix * size - center.x;
				const dz = z0 + iz * size - center.z;
				if ( dx * dx + dz * dz > ( ZONE_RADIUS + size ) * ( ZONE_RADIUS + size ) ) continue;

				const top = Math.round( h / size );
				tops[ i ] = top;

				let low = top;
				for ( const j of [ i - 1, i + 1, i - n, i + n ] ) {

					if ( j < 0 || j >= n * n || Number.isNaN( heights[ j ] ) ) continue;
					const t = Math.round( heights[ j ] / size );
					if ( t < low ) low = t;

				}

				const depth = MathUtils.clamp( top - low + 1, 1, MAX_COLUMN );
				depths[ i ] = depth;
				count += depth;

			}

		}

		const mesh = new InstancedMesh(
			new BoxGeometry( size, size, size ),
			new MeshLambertMaterial(),
			count
		);
		mesh.frustumCulled = false;

		// fill matrices and colors a slab of rows at a time
		let cursor = 0;
		const rowsPerJob = Math.max( 1, Math.floor( 4000 / n ) );
		for ( let start = 0; start < n; start += rowsPerJob ) {

			const rows = [ start, Math.min( start + rowsPerJob, n ) ];
			this._jobs.push( () => {

				for ( let iz = rows[ 0 ]; iz < rows[ 1 ]; iz ++ ) {

					for ( let ix = 0; ix < n; ix ++ ) {

						const i = iz * n + ix;
						const depth = depths[ i ];
						if ( ! depth ) continue;

						const x = x0 + ix * size;
						const z = z0 + iz * size;
						const cls = this.segments.classify( x, z );
						const rgb = CLASS_RGB[ cls ] || OTHER_RGB;

						// per-column brightness jitter sells the voxel look
						const jit = 0.88 + hash01( ix * 92821 + iz ) * 0.2;

						for ( let d = 0; d < depth; d ++ ) {

							const shade = jit * ( d === 0 ? 1 : 0.86 ); // sides darker
							_c.setRGB(
								rgb[ 0 ] / 255 * shade,
								rgb[ 1 ] / 255 * shade,
								rgb[ 2 ] / 255 * shade
							);
							_m.makeTranslation( x, ( tops[ i ] - d - 0.5 ) * size, z );
							mesh.setMatrixAt( cursor, _m );
							mesh.setColorAt( cursor, _c );
							cursor ++;

						}

					}

				}

				this.status = `building voxels… ${ Math.round( cursor / count * 100 ) }%`;

			} );

		}

		this._jobs.push( () => {

			mesh.count = cursor;
			mesh.instanceMatrix.needsUpdate = true;
			if ( mesh.instanceColor ) mesh.instanceColor.needsUpdate = true;

			this._dispose();
			this.scene.add( mesh );
			this.mesh = mesh;

			// only now carve the real mesh away — no hole while sampling
			distortionUniforms.uVoxelCenter.value.set( center.x, center.z );
			distortionUniforms.uVoxelRadius.value = ZONE_RADIUS;

			this._center.copy( center );
			this._have = true;
			this._building = false;
			this.status = `${ cursor.toLocaleString() } voxels @ ${ this.size }m`;

		} );

	}

	_dispose() {

		if ( ! this.mesh ) return;
		this.scene.remove( this.mesh );
		this.mesh.geometry.dispose();
		this.mesh.material.dispose();
		this.mesh.dispose();
		this.mesh = null;

	}

}

function hash01( x ) {

	const s = Math.sin( x * 127.1 ) * 43758.5453;
	return s - Math.floor( s );

}
