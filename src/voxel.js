import {
	Vector3,
	Vector2,
	Raycaster,
	Group,
	Mesh,
	BufferGeometry,
	BufferAttribute,
	MeshBasicMaterial,
	Matrix4,
	MathUtils,
	DoubleSide,
	DataTexture,
	RedFormat,
	UnsignedByteType,
	NearestFilter,
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

// below this size the whole-map data build can't scale (memory grows with
// 1/size²) — persistent mesh-sampled fine chunks take over instead
const MIN_BASE_SIZE = 8;

// coverage mask over the play area: 1 texel per fine chunk. The base voxel
// map discards its fragments wherever the mask is set, so accumulated fine
// chunks seamlessly replace it anywhere on the map.
const fineUniforms = {
	uFineMask: { value: null },
	uMapCenter: { value: new Vector2() },
	uMapEast: { value: new Vector2( 1, 0 ) },
	uMapNorth: { value: new Vector2( 0, 1 ) },
	uMapHalf: { value: new Vector2( 1, 1 ) },
};

export class VoxelWorld {

	constructor( { scene, tilesGroup, segments, playArea } ) {

		this.scene = scene;
		this.tilesGroup = tilesGroup;
		this.segments = segments;
		this.playArea = playArea;
		this.terrain = new TerrainGrid();
		this.fine = new FineChunks( { scene, tilesGroup, segments, playArea } );

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

		// world → play-area UV mapping for the fine coverage mask
		fineUniforms.uMapCenter.value.set( pa.center.x, pa.center.z );
		fineUniforms.uMapEast.value.set( pa.eastDir.x, pa.eastDir.z );
		fineUniforms.uMapNorth.value.set( pa.northDir.x, pa.northDir.z );
		fineUniforms.uMapHalf.value.set( pa.halfWidth, pa.halfHeight );

		const material = new MeshBasicMaterial( { vertexColors: true, side: DoubleSide } );

		// discard base fragments wherever a fine chunk covers the map, so the
		// two layers never interleave
		material.onBeforeCompile = ( shader ) => {

			Object.assign( shader.uniforms, fineUniforms );
			shader.vertexShader = 'varying vec3 vVoxWorld;\n' + shader.vertexShader.replace(
				'#include <begin_vertex>',
				'#include <begin_vertex>\n\tvVoxWorld = ( modelMatrix * vec4( position, 1.0 ) ).xyz;'
			);
			shader.fragmentShader = `
uniform sampler2D uFineMask;
uniform vec2 uMapCenter;
uniform vec2 uMapEast;
uniform vec2 uMapNorth;
uniform vec2 uMapHalf;
varying vec3 vVoxWorld;
` + shader.fragmentShader.replace(
				'#include <color_fragment>',
				`#include <color_fragment>
	{
		vec2 rel = vVoxWorld.xz - uMapCenter;
		vec2 uv = vec2( dot( rel, uMapEast ) / uMapHalf.x, dot( rel, uMapNorth ) / uMapHalf.y ) * 0.5 + 0.5;
		if ( uv.x >= 0.0 && uv.x <= 1.0 && uv.y >= 0.0 && uv.y <= 1.0 &&
			texture2D( uFineMask, uv ).r > 0.5 ) discard;
	}`
			);

		};
		material.customProgramCacheKey = () => 'voxel-base-2';
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

// Persistent fine-detail voxel chunks for sizes below the base minimum.
// Every 64×64-column chunk near the focus is sampled once from the real
// photogrammetry mesh (BVH raycasts — true metre-scale detail: bridges,
// trees, facades), greedy-meshed exactly like the base layer, and KEPT.
// Explore the map and it voxelizes in fine detail behind you, all chunks
// rendered at once; a coverage-mask texture tells the base layer where to
// discard itself. An LRU cap bounds memory by evicting the farthest chunks.

const FINE_CHUNK = 64;       // columns per fine chunk side
const FINE_MAX_CHUNKS = 600; // LRU cap on kept chunks
const FINE_BUDGET_MS = 5;

class FineChunks {

	constructor( { scene, tilesGroup, segments, playArea } ) {

		this.scene = scene;
		this.tilesGroup = tilesGroup;
		this.segments = segments;
		this.playArea = playArea;

		this.active = false;
		this.size = 0;
		this.status = 'off';

		this.group = null;
		this.material = new MeshBasicMaterial( { vertexColors: true, side: DoubleSide } );
		this._chunks = new Map(); // "cx,cz" → Mesh
		this._queue = [];
		this._queued = new Set();
		this._jobs = [];
		this._mask = null;
		this._maskW = 0;
		this._maskH = 0;

		this._raycaster = new Raycaster();
		this._raycaster.firstHitOnly = true;

	}

	get chunkWorld() {

		return this.size * FINE_CHUNK;

	}

	// chunks stream in within this radius of the focus
	get radius() {

		return MathUtils.clamp( this.size * 120, 100, 700 );

	}

	setSize( size ) {

		if ( size === this.size ) return;
		this.size = size;
		this.active = size > 0;
		this._clear();

		if ( this.active ) {

			const pa = this.playArea;
			this._maskW = Math.ceil( pa.halfWidth * 2 / this.chunkWorld );
			this._maskH = Math.ceil( pa.halfHeight * 2 / this.chunkWorld );
			const data = new Uint8Array( this._maskW * this._maskH );
			const tex = new DataTexture( data, this._maskW, this._maskH, RedFormat, UnsignedByteType );
			tex.magFilter = NearestFilter;
			tex.minFilter = NearestFilter;
			tex.needsUpdate = true;
			this._mask = tex;
			fineUniforms.uFineMask.value = tex;

			this.group = new Group();
			_m.makeBasis( pa.eastDir, _up, pa.northDir );
			_m.setPosition( pa.center.x, 0, pa.center.z );
			this.group.applyMatrix4( _m );
			this.scene.add( this.group );
			this.status = 'exploring builds chunks';

		}

	}

	update( focus ) {

		if ( ! this.active || ! focus || ! this.playArea.ready ) return;

		this._enqueueAround( focus );

		const start = performance.now();
		while ( this._jobs.length && performance.now() - start < FINE_BUDGET_MS ) {

			this._jobs.shift()();

		}

		// start the next queued chunk, nearest first
		if ( ! this._jobs.length && this._queue.length ) {

			this._queue.sort( ( a, b ) => a.d - b.d );
			const next = this._queue.shift();
			this._buildChunk( next.cx, next.cz );

		}

	}

	// focus (world) → play-frame coords
	_frameCoords( focus ) {

		const pa = this.playArea;
		const rx = focus.x - pa.center.x;
		const rz = focus.z - pa.center.z;
		return {
			e: rx * pa.eastDir.x + rz * pa.eastDir.z,
			n: rx * pa.northDir.x + rz * pa.northDir.z,
		};

	}

	_enqueueAround( focus ) {

		const { e, n } = this._frameCoords( focus );
		const pa = this.playArea;
		const cw = this.chunkWorld;
		const r = this.radius;

		const c0x = Math.floor( ( e - r + pa.halfWidth ) / cw );
		const c1x = Math.floor( ( e + r + pa.halfWidth ) / cw );
		const c0z = Math.floor( ( n - r + pa.halfHeight ) / cw );
		const c1z = Math.floor( ( n + r + pa.halfHeight ) / cw );

		for ( let cz = Math.max( 0, c0z ); cz <= Math.min( this._maskH - 1, c1z ); cz ++ ) {

			for ( let cx = Math.max( 0, c0x ); cx <= Math.min( this._maskW - 1, c1x ); cx ++ ) {

				const key = `${ cx },${ cz }`;
				if ( this._chunks.has( key ) || this._queued.has( key ) ) continue;

				const dx = ( cx + 0.5 ) * cw - pa.halfWidth - e;
				const dz = ( cz + 0.5 ) * cw - pa.halfHeight - n;
				const d = Math.hypot( dx, dz );
				if ( d > r + cw * 0.5 ) continue;

				this._queued.add( key );
				this._queue.push( { cx, cz, d } );

			}

		}

		// refresh queue distances lazily via re-sort in update; evict if over cap
		if ( this._chunks.size > FINE_MAX_CHUNKS ) this._evict( e, n );

	}

	_evict( e, n ) {

		const cw = this.chunkWorld;
		const pa = this.playArea;
		const entries = [ ...this._chunks.entries() ].map( ( [ key, mesh ] ) => {

			const [ cx, cz ] = key.split( ',' ).map( Number );
			const dx = ( cx + 0.5 ) * cw - pa.halfWidth - e;
			const dz = ( cz + 0.5 ) * cw - pa.halfHeight - n;
			return { key, mesh, cx, cz, d: Math.hypot( dx, dz ) };

		} ).sort( ( a, b ) => b.d - a.d );

		while ( this._chunks.size > FINE_MAX_CHUNKS ) {

			const { key, mesh, cx, cz } = entries.shift();
			this.group.remove( mesh );
			mesh.geometry.dispose();
			this._chunks.delete( key );
			this._setMask( cx, cz, 0 );

		}

	}

	_setMask( cx, cz, v ) {

		this._mask.image.data[ cz * this._maskW + cx ] = v;
		this._mask.needsUpdate = true;

	}

	_topFrame( e, n ) {

		const pa = this.playArea;
		const x = pa.center.x + pa.eastDir.x * e + pa.northDir.x * n;
		const z = pa.center.z + pa.eastDir.z * e + pa.northDir.z * n;
		this._raycaster.ray.origin.set( x, 1500, z );
		this._raycaster.ray.direction.set( 0, - 1, 0 );
		this._raycaster.near = 0;
		this._raycaster.far = 3000;
		const hit = this._raycaster.intersectObject( this.tilesGroup, true )[ 0 ];
		return hit ? hit.point.y : NaN;

	}

	_buildChunk( cx, cz ) {

		const size = this.size;
		const n = FINE_CHUNK;
		const pa = this.playArea;
		const e0 = - pa.halfWidth + cx * this.chunkWorld;  // frame-local chunk origin
		const n0 = - pa.halfHeight + cz * this.chunkWorld;

		// +1 apron on the far sides closes walls at chunk borders
		const side = n + 1;
		const heights = new Float32Array( side * side ).fill( NaN );

		for ( let iz = 0; iz < side; iz ++ ) {

			this._jobs.push( () => {

				const nn = n0 + ( iz + 0.5 ) * size;
				for ( let ix = 0; ix < side; ix ++ ) {

					heights[ iz * side + ix ] = this._topFrame( e0 + ( ix + 0.5 ) * size, nn );

				}

				this.status = `chunk ${ cx },${ cz } — sampling ${ Math.round( ( iz + 1 ) / side * 100 ) }%`;

			} );

		}

		this._jobs.push( () => this._meshFineChunk( cx, cz, heights, e0, n0 ) );

	}

	_meshFineChunk( cx, cz, heights, e0, n0 ) {

		const size = this.size;
		const n = FINE_CHUNK;
		const side = n + 1;

		const tops = new Int32Array( side * side );
		const has = new Uint8Array( side * side );
		const cls = new Uint8Array( side * side );
		for ( let i = 0; i < side * side; i ++ ) {

			if ( Number.isNaN( heights[ i ] ) ) continue;
			has[ i ] = 1;
			tops[ i ] = Math.round( heights[ i ] / size );

		}

		// classify per column (world coords via the frame)
		const pa = this.playArea;
		for ( let iz = 0; iz < side; iz ++ ) {

			for ( let ix = 0; ix < side; ix ++ ) {

				const e = e0 + ( ix + 0.5 ) * size;
				const nn = n0 + ( iz + 0.5 ) * size;
				const x = pa.center.x + pa.eastDir.x * e + pa.northDir.x * nn;
				const z = pa.center.z + pa.eastDir.z * e + pa.northDir.z * nn;
				cls[ iz * side + ix ] = CLASS_IDX[ this.segments.classify( x, z ) ];

			}

		}

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

		// tops, run-merged along x
		for ( let iz = 0; iz < n; iz ++ ) {

			let ix = 0;
			while ( ix < n ) {

				const i = iz * side + ix;
				if ( ! has[ i ] ) {

					ix ++;
					continue;

				}

				const t = tops[ i ];
				const c = cls[ i ];
				let run = ix + 1;
				while ( run < n ) {

					const j = iz * side + run;
					if ( ! has[ j ] || tops[ j ] !== t || cls[ j ] !== c ) break;
					run ++;

				}

				const y = t * size;
				quad(
					e0 + ix * size, y, n0 + iz * size,
					e0 + run * size, y, n0 + iz * size,
					e0 + run * size, y, n0 + ( iz + 1 ) * size,
					e0 + ix * size, y, n0 + ( iz + 1 ) * size,
					IDX_RGB[ c ], SHADE_TOP
				);
				ix = run;

			}

		}

		// x-walls (pair ix / ix+1, apron included), run-merged along z
		for ( let ix = 0; ix < n; ix ++ ) {

			let iz = 0;
			while ( iz < n ) {

				const i = iz * side + ix;
				const j = i + 1;
				if ( ! has[ i ] || ! has[ j ] || tops[ i ] === tops[ j ] ) {

					iz ++;
					continue;

				}

				const a = tops[ i ];
				const b = tops[ j ];
				const lo = Math.min( a, b );
				const hi = Math.max( a, b );
				const c = cls[ a > b ? i : j ];
				let run = iz + 1;
				while ( run < n ) {

					const i2 = run * side + ix;
					if ( ! has[ i2 ] || ! has[ i2 + 1 ] || tops[ i2 ] !== a || tops[ i2 + 1 ] !== b ||
						cls[ a > b ? i2 : i2 + 1 ] !== c ) break;
					run ++;

				}

				const x = e0 + ( ix + 1 ) * size;
				quad(
					x, lo * size, n0 + iz * size,
					x, hi * size, n0 + iz * size,
					x, hi * size, n0 + run * size,
					x, lo * size, n0 + run * size,
					IDX_RGB[ c ], SHADE_X
				);
				iz = run;

			}

		}

		// z-walls (pair iz / iz+1, apron included), run-merged along x
		for ( let iz = 0; iz < n; iz ++ ) {

			let ix = 0;
			while ( ix < n ) {

				const i = iz * side + ix;
				const j = i + side;
				if ( ! has[ i ] || ! has[ j ] || tops[ i ] === tops[ j ] ) {

					ix ++;
					continue;

				}

				const a = tops[ i ];
				const b = tops[ j ];
				const lo = Math.min( a, b );
				const hi = Math.max( a, b );
				const c = cls[ a > b ? i : j ];
				let run = ix + 1;
				while ( run < n ) {

					const i2 = iz * side + run;
					if ( ! has[ i2 ] || ! has[ i2 + side ] || tops[ i2 ] !== a || tops[ i2 + side ] !== b ||
						cls[ a > b ? i2 : i2 + side ] !== c ) break;
					run ++;

				}

				const z = n0 + ( iz + 1 ) * size;
				quad(
					e0 + ix * size, lo * size, z,
					e0 + run * size, lo * size, z,
					e0 + run * size, hi * size, z,
					e0 + ix * size, hi * size, z,
					IDX_RGB[ c ], SHADE_Z
				);
				ix = run;

			}

		}

		const key = `${ cx },${ cz }`;
		this._queued.delete( key );

		if ( indices.length ) {

			const geo = new BufferGeometry();
			geo.setAttribute( 'position', new BufferAttribute( new Float32Array( positions ), 3 ) );
			const colorAttr = new Uint8Array( colors.length );
			for ( let i = 0; i < colors.length; i ++ ) colorAttr[ i ] = colors[ i ];
			geo.setAttribute( 'color', new BufferAttribute( colorAttr, 3, true ) );
			geo.setIndex( indices );
			geo.computeBoundingSphere();

			const mesh = new Mesh( geo, this.material );
			mesh.matrixAutoUpdate = false;
			this.group.add( mesh );
			this._chunks.set( key, mesh );
			this._setMask( cx, cz, 255 );

		}

		const km2 = this._chunks.size * ( this.chunkWorld / 1000 ) ** 2;
		this.status = `${ this._chunks.size } chunks (${ km2.toFixed( 2 ) } km²) @ ${ this.size }m`;

	}

	_clear() {

		this._jobs.length = 0;
		this._queue.length = 0;
		this._queued.clear();

		if ( this.group ) {

			this.scene.remove( this.group );
			for ( const mesh of this._chunks.values() ) mesh.geometry.dispose();
			this.group = null;

		}

		this._chunks.clear();

		if ( this._mask ) {

			this._mask.image.data.fill( 0 );
			this._mask.needsUpdate = true;

		}

		if ( ! this.active ) this.status = 'off';

	}

}
