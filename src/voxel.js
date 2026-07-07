import {
	Vector3,
	Raycaster,
	Group,
	Mesh,
	BufferGeometry,
	BufferAttribute,
	MeshBasicMaterial,
	Matrix4,
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

export class VoxelWorld {

	constructor( { scene, tilesGroup, segments, playArea } ) {

		this.scene = scene;
		this.tilesGroup = tilesGroup;
		this.segments = segments;
		this.playArea = playArea;
		this.terrain = new TerrainGrid();

		this.enabled = false;
		this.status = 'off';
		this.size = 16;       // requested; applied at build time
		this.builtSize = 0;

		this.group = null;
		this._jobs = [];
		this._building = false;

		this._raycaster = new Raycaster();
		this._raycaster.firstHitOnly = true;

	}

	setActive( value ) {

		this.enabled = value;

		if ( value ) {

			if ( this.group && this.builtSize === this.size ) {

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
		if ( this.enabled && this.builtSize !== size && ! this._building ) this._build();

	}

	update() {

		if ( ! this._jobs.length ) return;

		const start = performance.now();
		while ( this._jobs.length && performance.now() - start < JOB_BUDGET_MS ) {

			this._jobs.shift()();

		}

	}

	// --- build ---------------------------------------------------------------------

	async _build() {

		this._building = true;
		const size = this.size;

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
