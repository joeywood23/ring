import {
	Vector3,
	Vector2,
	Raycaster,
	Group,
	Mesh,
	BufferGeometry,
	BufferAttribute,
	MeshBasicMaterial,
	MeshLambertMaterial,
	InstancedMesh,
	BoxGeometry,
	Matrix4,
	Color,
	MathUtils,
	DoubleSide,
} from 'three';
import { distortionUniforms } from './effects.js';
import { CLASS_RGB } from './segment.js';
import { TerrainGrid } from './terrain.js';
import { PLAY_BOUNDS } from './bounds.js';

// Whole-play-area voxel map, built once at a voxel size fixed at build time.
// Heights come from data, not the streamed mesh: AWS terrarium elevation for
// the terrain plus per-building render_height rasterized by segment.js, so
// the entire 33×20 km map voxelizes without a single geometry raycast. The
// column grid is meshed in 128²-column chunks with greedy run-merging — only
// exposed top faces and height-step walls are emitted, merged into long
// rectangles (the Bay collapses to a handful of quads) — into static
// vertex-colored buffers, one frustum-culled mesh per chunk. While shown, the
// shader discards all photogrammetry; physics still rides the hidden mesh.

const CHUNK = 128;        // columns per chunk side
const JOB_BUDGET_MS = 7;  // per-frame build budget
const FALLBACK_MSL_Y = - 32.5; // local Y of sea level if calibration fails

// face shading is baked into vertex colors (material is unlit)
const SHADE_TOP = 1.0;
const SHADE_X = 0.78;
const SHADE_Z = 0.62;

const PALETTE = {
	other: [ 186, 178, 158 ],
	building: [ 255, 111, 97 ],
	road: [ 139, 124, 246 ],
	grass: [ 78, 203, 95 ],
	water: [ 58, 165, 255 ],
};
const CLASS_IDX = { other: 0, building: 1, road: 2, grass: 3, water: 4 };
const IDX_RGB = [ PALETTE.other, PALETTE.building, PALETTE.road, PALETTE.grass, PALETTE.water ];

const _m = new Matrix4();
const _up = new Vector3( 0, 1, 0 );
const _c = new Color();

// below this size the whole-map data build can't scale (memory grows with
// 1/size²) — a mesh-sampled fine patch takes over near the player instead
const MIN_BASE_SIZE = 8;

// hole carved in the base voxel map under the fine patch
const fineUniforms = {
	uFineCenter: { value: new Vector2() },
	uFineRadius: { value: 0 },
};

export class VoxelWorld {

	constructor( { scene, tilesGroup, segments, playArea } ) {

		this.scene = scene;
		this.tilesGroup = tilesGroup;
		this.segments = segments;
		this.playArea = playArea;
		this.terrain = new TerrainGrid();
		this.fine = new FinePatch( { scene, tilesGroup, segments } );

		this.enabled = false;
		this._status = 'off';
		this.size = 16;       // requested; applied at build time
		this.builtSize = 0;   // base-layer size actually built

		this.group = null;
		this._jobs = [];
		this._building = false;

		this._raycaster = new Raycaster();
		this._raycaster.firstHitOnly = true;

	}

	get status() {

		return this.fine.active ? `${ this._status } · fine: ${ this.fine.status }` : this._status;

	}

	set status( v ) {

		this._status = v;

	}

	// sizes below the base minimum sample the real mesh — needs BVH raycasts
	needsBVH() {

		return this.enabled && this.size < MIN_BASE_SIZE;

	}

	setActive( value ) {

		this.enabled = value;
		this._applyFine();

		if ( value ) {

			const baseSize = Math.max( this.size, MIN_BASE_SIZE );
			if ( this.group && this.builtSize === baseSize ) {

				this.group.visible = true;
				distortionUniforms.uVoxelRadius.value = 1e7;
				this.status = `voxel map @ ${ this.builtSize }m`;

			} else if ( ! this._building ) {

				this._build();

			}

		} else {

			if ( this.group ) this.group.visible = false;
			distortionUniforms.uVoxelRadius.value = 0;
			this.status = 'off';

		}

	}

	setSize( size ) {

		this.size = size;
		this._applyFine();
		const baseSize = Math.max( size, MIN_BASE_SIZE );
		if ( this.enabled && this.builtSize !== baseSize && ! this._building ) this._build();

	}

	_applyFine() {

		this.fine.setSize( this.enabled && this.size < MIN_BASE_SIZE ? this.size : 0 );

	}

	update( focus ) {

		this.fine.update( focus );

		if ( ! this._jobs.length ) return;

		const start = performance.now();
		while ( this._jobs.length && performance.now() - start < JOB_BUDGET_MS ) {

			this._jobs.shift()();

		}

	}

	// --- build ---------------------------------------------------------------------

	async _build() {

		this._building = true;
		const size = Math.max( this.size, MIN_BASE_SIZE ); // base layer size floor

		try {

			// 1. coverage (classes + building heights) and terrain, in parallel
			this.status = 'loading map data…';
			await Promise.all( [
				this.segments.ensureData(),
				this.terrain.load( ( s ) => ( this.status = s ) ),
			] );
			if ( ! this.segments.ready ) throw new Error( 'segmentation data unavailable' );

			// 2. sea-level calibration: terrain heights are metres above sea
			// level, the local frame is ellipsoidal — one mesh raycast at the
			// mid-bay origin measures the offset
			let mslY = FALLBACK_MSL_Y;
			this._raycaster.ray.origin.set( 0, 1500, 0 );
			this._raycaster.ray.direction.set( 0, - 1, 0 );
			this._raycaster.far = 3000;
			const hit = this._raycaster.intersectObject( this.tilesGroup, true )[ 0 ];
			if ( hit ) mslY = hit.point.y;

			this._queueColumnPass( size, mslY );

		} catch ( err ) {

			console.error( 'VoxelWorld build failed:', err );
			this.status = 'build failed — toggle to retry';
			this._building = false;

		}

	}

	_queueColumnPass( size, mslY ) {

		const pa = this.playArea;
		const nx = Math.ceil( pa.halfWidth * 2 / size );
		const nz = Math.ceil( pa.halfHeight * 2 / size );
		const tops = new Int16Array( nx * nz );
		const cls = new Uint8Array( nx * nz );
		const seaIdx = Math.round( mslY / size );
		const dLon = PLAY_BOUNDS.maxLon - PLAY_BOUNDS.minLon;
		const dLat = PLAY_BOUNDS.maxLat - PLAY_BOUNDS.minLat;

		const jobs = this._jobs;
		jobs.length = 0;

		const ROWS_PER_JOB = Math.max( 1, Math.floor( 60000 / nx ) );
		for ( let start = 0; start < nz; start += ROWS_PER_JOB ) {

			const end = Math.min( start + ROWS_PER_JOB, nz );
			jobs.push( () => {

				for ( let iz = start; iz < end; iz ++ ) {

					const v = ( iz + 0.5 ) / nz;
					const lat = PLAY_BOUNDS.minLat + v * dLat;
					for ( let ix = 0; ix < nx; ix ++ ) {

						const u = ( ix + 0.5 ) / nx;
						const i = iz * nx + ix;

						const c = this.segments.classifyUV( u, v );
						cls[ i ] = CLASS_IDX[ c ];

						if ( c === 'water' ) {

							tops[ i ] = seaIdx; // flat sea, ignore DEM noise

						} else {

							const elev = this.terrain.sample( PLAY_BOUNDS.minLon + u * dLon, lat );
							const bh = c === 'building' ? this.segments.buildingHeightUV( u, v ) : 0;
							tops[ i ] = Math.round( ( mslY + elev + bh ) / size );

						}

					}

				}

				this.status = `sampling columns… ${ Math.round( end / nz * 100 ) }%`;

			} );

		}

		jobs.push( () => this._queueMeshPass( size, nx, nz, tops, cls ) );

	}

	// --- meshing --------------------------------------------------------------------

	_queueMeshPass( size, nx, nz, tops, cls ) {

		const pa = this.playArea;
		const group = new Group();

		// geometry is built in the play-area frame (x = east, z = north),
		// then the group carries the frame's basis — exact alignment with
		// the samplers regardless of the local frame's slight rotation.
		// DoubleSide sidesteps the basis handedness flipping the winding.
		_m.makeBasis( pa.eastDir, _up, pa.northDir );
		_m.setPosition( pa.center.x, 0, pa.center.z );
		group.applyMatrix4( _m );

		const material = new MeshBasicMaterial( { vertexColors: true, side: DoubleSide } );

		// carve a hole in the base map under the fine patch so the two layers
		// never interleave
		material.onBeforeCompile = ( shader ) => {

			Object.assign( shader.uniforms, fineUniforms );
			shader.vertexShader = 'varying vec3 vVoxWorld;\n' + shader.vertexShader.replace(
				'#include <begin_vertex>',
				'#include <begin_vertex>\n\tvVoxWorld = ( modelMatrix * vec4( position, 1.0 ) ).xyz;'
			);
			shader.fragmentShader = 'uniform vec2 uFineCenter;\nuniform float uFineRadius;\nvarying vec3 vVoxWorld;\n' +
				shader.fragmentShader.replace(
					'#include <color_fragment>',
					'#include <color_fragment>\n\tif ( uFineRadius > 0.0 && length( vVoxWorld.xz - uFineCenter ) < uFineRadius ) discard;'
				);

		};
		material.customProgramCacheKey = () => 'voxel-base-1';
		const chunksX = Math.ceil( nx / CHUNK );
		const chunksZ = Math.ceil( nz / CHUNK );
		let built = 0;
		let totalQuads = 0;

		for ( let cz = 0; cz < chunksZ; cz ++ ) {

			for ( let cx = 0; cx < chunksX; cx ++ ) {

				this._jobs.push( () => {

					const quads = this._meshChunk( group, material, size, nx, nz, tops, cls, cx, cz );
					totalQuads += quads;
					built ++;
					this.status = `meshing chunks… ${ built } / ${ chunksX * chunksZ }`;

				} );

			}

		}

		this._jobs.push( () => {

			this._dispose();
			this.scene.add( group );
			this.group = group;
			this.builtSize = size;
			this._building = false;

			if ( this.enabled ) {

				distortionUniforms.uVoxelRadius.value = 1e7;
				this.status = `${ totalQuads.toLocaleString() } faces @ ${ size }m — whole play area`;

			} else {

				group.visible = false;
				this.status = 'off';

			}

		} );

	}

	_meshChunk( group, material, size, nx, nz, tops, cls, cx, cz ) {

		const x0 = cx * CHUNK;
		const z0 = cz * CHUNK;
		const x1 = Math.min( x0 + CHUNK, nx );
		const z1 = Math.min( z0 + CHUNK, nz );

		const pa = this.playArea;
		const ox = - pa.halfWidth;  // frame-local origin of column (0,0)
		const oz = - pa.halfHeight;

		const positions = [];
		const colors = [];
		const indices = [];

		const quad = ( ax, ay, az, bx, by, bz, cx2, cy, cz2, dx, dy, dz, rgb, shade ) => {

			const base = positions.length / 3;
			positions.push( ax, ay, az, bx, by, bz, cx2, cy, cz2, dx, dy, dz );
			const r = rgb[ 0 ] * shade, g = rgb[ 1 ] * shade, b = rgb[ 2 ] * shade;
			for ( let k = 0; k < 4; k ++ ) colors.push( r, g, b );
			indices.push( base, base + 2, base + 1, base, base + 3, base + 2 );

		};

		// top faces: run-merge along x while height and class match
		for ( let iz = z0; iz < z1; iz ++ ) {

			let ix = x0;
			while ( ix < x1 ) {

				const i = iz * nx + ix;
				const t = tops[ i ];
				const c = cls[ i ];
				let run = ix + 1;
				while ( run < x1 && tops[ iz * nx + run ] === t && cls[ iz * nx + run ] === c ) run ++;

				const y = t * size;
				const xa = ox + ix * size;
				const xb = ox + run * size;
				const za = oz + iz * size;
				const zb = za + size;
				quad( xa, y, za, xb, y, za, xb, y, zb, xa, y, zb, IDX_RGB[ c ], SHADE_TOP );

				ix = run;

			}

		}

		// walls between column ix and ix+1 (plane x = right edge), run-merged
		// along z while the step and class match
		for ( let ix = x0; ix < x1; ix ++ ) {

			if ( ix + 1 >= nx ) continue;
			let iz = z0;
			while ( iz < z1 ) {

				const a = tops[ iz * nx + ix ];
				const b = tops[ iz * nx + ix + 1 ];
				if ( a === b ) {

					iz ++;
					continue;

				}

				const lo = Math.min( a, b );
				const hi = Math.max( a, b );
				const c = cls[ iz * nx + ( a > b ? ix : ix + 1 ) ];
				let run = iz + 1;
				while ( run < z1 ) {

					const a2 = tops[ run * nx + ix ];
					const b2 = tops[ run * nx + ix + 1 ];
					if ( a2 !== a || b2 !== b || cls[ run * nx + ( a > b ? ix : ix + 1 ) ] !== c ) break;
					run ++;

				}

				const x = ox + ( ix + 1 ) * size;
				const za = oz + iz * size;
				const zb = oz + run * size;
				quad( x, lo * size, za, x, hi * size, za, x, hi * size, zb, x, lo * size, zb, IDX_RGB[ c ], SHADE_X );

				iz = run;

			}

		}

		// walls between column iz and iz+1 (plane z = far edge), run-merged
		// along x while the step and class match
		for ( let iz = z0; iz < z1; iz ++ ) {

			if ( iz + 1 >= nz ) continue;
			let ix = x0;
			while ( ix < x1 ) {

				const a = tops[ iz * nx + ix ];
				const b = tops[ ( iz + 1 ) * nx + ix ];
				if ( a === b ) {

					ix ++;
					continue;

				}

				const lo = Math.min( a, b );
				const hi = Math.max( a, b );
				const c = cls[ ( a > b ? iz : iz + 1 ) * nx + ix ];
				let run = ix + 1;
				while ( run < x1 ) {

					const a2 = tops[ iz * nx + run ];
					const b2 = tops[ ( iz + 1 ) * nx + run ];
					if ( a2 !== a || b2 !== b || cls[ ( a > b ? iz : iz + 1 ) * nx + run ] !== c ) break;
					run ++;

				}

				const z = oz + ( iz + 1 ) * size;
				const xa = ox + ix * size;
				const xb = ox + run * size;
				quad( xa, lo * size, z, xb, lo * size, z, xb, hi * size, z, xa, hi * size, z, IDX_RGB[ c ], SHADE_Z );

				ix = run;

			}

		}

		if ( ! indices.length ) return 0;

		const geo = new BufferGeometry();
		geo.setAttribute( 'position', new BufferAttribute( new Float32Array( positions ), 3 ) );
		const colorAttr = new Uint8Array( colors.length );
		for ( let i = 0; i < colors.length; i ++ ) colorAttr[ i ] = colors[ i ];
		geo.setAttribute( 'color', new BufferAttribute( colorAttr, 3, true ) );
		geo.setIndex( indices );
		geo.computeBoundingSphere();

		const mesh = new Mesh( geo, material );
		mesh.matrixAutoUpdate = false;
		group.add( mesh );

		return indices.length / 6;

	}

	_dispose() {

		if ( ! this.group ) return;
		this.scene.remove( this.group );
		this.group.traverse( ( child ) => {

			if ( child.geometry ) child.geometry.dispose();
			if ( child.material ) child.material.dispose();

		} );
		this.group = null;

	}

}

// Fine-detail voxel patch for sizes below the base minimum: samples the real
// photogrammetry mesh with BVH raycasts (true 1m detail — bridges, trees,
// facades), rendered as instanced cubes in a disc that follows the player.
// The base map is shader-discarded underneath (fineUniforms).

const FINE_COLUMNS = 200;  // grid resolution — radius scales with voxel size
const FINE_MAX_COLUMN = 24;
const FINE_BUDGET_MS = 5;

class FinePatch {

	constructor( { scene, tilesGroup, segments } ) {

		this.scene = scene;
		this.tilesGroup = tilesGroup;
		this.segments = segments;

		this.active = false;
		this.size = 0;
		this.status = 'off';

		this.mesh = null;
		this._center = new Vector3();
		this._have = false;
		this._jobs = [];
		this._building = false;

		this._raycaster = new Raycaster();
		this._raycaster.firstHitOnly = true;

	}

	get radius() {

		return this.size * FINE_COLUMNS / 2;

	}

	setSize( size ) {

		if ( size === this.size ) return;
		this.size = size;
		this.active = size > 0;
		this._have = false;
		this._jobs.length = 0;
		this._building = false;

		if ( ! this.active ) {

			this._dispose();
			fineUniforms.uFineRadius.value = 0;
			this.status = 'off';

		}

	}

	update( focus ) {

		if ( ! this.active || ! focus ) return;

		if ( ( ! this._have || focus.distanceTo( this._center ) > this.radius * 0.45 ) && ! this._building ) {

			this._queueBuild( focus.clone() );

		}

		const start = performance.now();
		while ( this._jobs.length && performance.now() - start < FINE_BUDGET_MS ) {

			this._jobs.shift()();

		}

	}

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
		const radius = this.radius;
		const n = FINE_COLUMNS;
		const heights = new Float32Array( n * n ).fill( NaN );
		const x0 = center.x - radius + size / 2;
		const z0 = center.z - radius + size / 2;

		for ( let iz = 0; iz < n; iz ++ ) {

			jobs.push( () => {

				const z = z0 + iz * size;
				for ( let ix = 0; ix < n; ix ++ ) {

					const x = x0 + ix * size;
					const dx = x - center.x;
					const dz = z - center.z;
					if ( dx * dx + dz * dz > radius * radius ) continue; // disc
					heights[ iz * n + ix ] = this._top( x, z );

				}

				this.status = `sampling ${ Math.round( ( iz + 1 ) / n * 100 ) }%`;

			} );

		}

		jobs.push( () => this._buildInstances( center, n, heights, x0, z0 ) );

	}

	_buildInstances( center, n, heights, x0, z0 ) {

		const size = this.size;

		const tops = new Int32Array( n * n );
		const depths = new Int32Array( n * n );
		let count = 0;

		for ( let iz = 0; iz < n; iz ++ ) {

			for ( let ix = 0; ix < n; ix ++ ) {

				const i = iz * n + ix;
				const h = heights[ i ];
				if ( Number.isNaN( h ) ) continue;

				const top = Math.round( h / size );
				tops[ i ] = top;

				let low = top;
				for ( const j of [ i - 1, i + 1, i - n, i + n ] ) {

					if ( j < 0 || j >= n * n || Number.isNaN( heights[ j ] ) ) continue;
					const t = Math.round( heights[ j ] / size );
					if ( t < low ) low = t;

				}

				const depth = MathUtils.clamp( top - low + 1, 1, FINE_MAX_COLUMN );
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

		let cursor = 0;
		const rowsPerJob = Math.max( 1, Math.floor( 5000 / n ) );
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
						const rgb = PALETTE[ cls ] || PALETTE.other;
						const jit = 0.88 + hash01( ix * 92821 + iz ) * 0.2;

						for ( let d = 0; d < depth; d ++ ) {

							const shade = jit * ( d === 0 ? 1 : 0.86 );
							_c.setRGB( rgb[ 0 ] / 255 * shade, rgb[ 1 ] / 255 * shade, rgb[ 2 ] / 255 * shade );
							_m.makeTranslation( x, ( tops[ i ] - d - 0.5 ) * size, z );
							mesh.setMatrixAt( cursor, _m );
							mesh.setColorAt( cursor, _c );
							cursor ++;

						}

					}

				}

				this.status = `building ${ Math.round( cursor / count * 100 ) }%`;

			} );

		}

		this._jobs.push( () => {

			mesh.count = cursor;
			mesh.instanceMatrix.needsUpdate = true;
			if ( mesh.instanceColor ) mesh.instanceColor.needsUpdate = true;

			this._dispose();
			this.scene.add( mesh );
			this.mesh = mesh;

			fineUniforms.uFineCenter.value.set( center.x, center.z );
			fineUniforms.uFineRadius.value = this.radius - this.size;

			this._center.copy( center );
			this._have = true;
			this._building = false;
			this.status = `${ cursor.toLocaleString() } voxels @ ${ size }m`;

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
