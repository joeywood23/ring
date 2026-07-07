import {
	Vector3,
	Raycaster,
	BufferGeometry,
	BufferAttribute,
	Mesh,
	MeshBasicMaterial,
} from 'three';

// Semantic segmentation of the photogrammetry. The mesh itself has no labels,
// so polygons come from OpenStreetMap (Overpass) and are rasterized into a
// colored ground grid: building / road / grass / water. SF Bay itself has no
// simple OSM polygon, so sea level is calibrated by sampling the mesh at the
// local origin (mid-bay) and low-lying ground is classified as water.
// classify() is also exposed for gameplay — ask it what's underfoot.

const OVERPASS_URLS = [
	'https://overpass-api.de/api/interpreter',
	'https://overpass.kumi.systems/api/interpreter',
];
const ZONE_RADIUS = 500;         // metres of labels around the focus point
const REFRESH_DIST = 220;
const MIN_FETCH_INTERVAL = 8000; // ms between Overpass requests
const JOB_BUDGET_MS = 5;         // per-frame build budget
const CELL = 16;                 // grid cell size, metres
const LIFT = 0.6;                // drape height above the ground
const SEA_MARGIN = 1.0;          // ground this close to sea level reads as water

export const SEGMENT_COLORS = {
	building: 0xff6f61,
	road: 0x8b7cf6,
	grass: 0x4ecb5f,
	water: 0x3aa5ff,
};

const ROAD_WIDTHS = {
	motorway: 18, trunk: 16, primary: 13, secondary: 11, tertiary: 10,
	residential: 8, unclassified: 8, living_street: 7, service: 5,
	pedestrian: 5, footway: 3, path: 3, cycleway: 3, steps: 3,
};

const GRASS_LEISURE = new Set( [ 'park', 'garden', 'pitch', 'golf_course', 'playground', 'dog_park' ] );
const GRASS_LANDUSE = new Set( [ 'grass', 'meadow', 'recreation_ground', 'village_green', 'forest', 'cemetery' ] );
const GRASS_NATURAL = new Set( [ 'grassland', 'scrub', 'wood', 'heath' ] );
const WATER_LANDUSE = new Set( [ 'basin', 'reservoir', 'salt_pond' ] );

const _v = new Vector3();

export class Segmentation {

	constructor( { scene, tilesGroup, latLonToLocal, localToLatLon } ) {

		this.scene = scene;
		this.tilesGroup = tilesGroup;
		this.latLonToLocal = latLonToLocal;
		this.localToLatLon = localToLatLon;

		this.enabled = false;
		this.status = 'off';

		this._polys = { building: [], water: [], grass: [] };
		this._roads = [];
		this._seaY = null;
		this._haveData = false;

		this.mesh = null;
		this._center = new Vector3();
		this._haveZone = false;
		this._jobs = [];
		this._fetching = false;
		this._lastFetch = - Infinity;
		this._abort = null;

		this._raycaster = new Raycaster();
		this._raycaster.firstHitOnly = true;

	}

	setActive( value ) {

		if ( value === this.enabled ) return;
		this.enabled = value;

		if ( value ) {

			this.status = 'waiting for map data…';
			this._lastFetch = - Infinity;

		} else {

			if ( this._abort ) this._abort.abort();
			this._jobs.length = 0;
			this._disposeMesh();
			this._haveZone = false;
			this._fetching = false;
			this.status = 'off';

		}

	}

	update( focus ) {

		if ( ! this.enabled ) return;

		const now = performance.now();
		const stale = ! this._haveZone || focus.distanceTo( this._center ) > REFRESH_DIST;
		if ( stale && ! this._fetching && now - this._lastFetch > MIN_FETCH_INTERVAL ) {

			this._refresh( focus.clone() );

		}

		const start = performance.now();
		while ( this._jobs.length && performance.now() - start < JOB_BUDGET_MS ) {

			this._jobs.shift()();

		}

	}

	// --- classification ----------------------------------------------------------

	// x/z in local space; groundY (optional) enables the sea-level water rule
	classify( x, z, groundY = null ) {

		if ( ! this._haveData ) return 'other';

		for ( const p of this._polys.building ) {

			if ( inBBox( p, x, z ) && pointInPoly( x, z, p.xs, p.zs ) ) return 'building';

		}

		for ( const r of this._roads ) {

			if ( ! inBBox( r, x, z ) ) continue;
			if ( nearPolyline( x, z, r.pts, r.half ) ) return 'road';

		}

		for ( const p of this._polys.water ) {

			if ( inBBox( p, x, z ) && pointInPoly( x, z, p.xs, p.zs ) ) return 'water';

		}

		for ( const p of this._polys.grass ) {

			if ( inBBox( p, x, z ) && pointInPoly( x, z, p.xs, p.zs ) ) return 'grass';

		}

		if ( groundY !== null && this._seaY !== null && groundY < this._seaY + SEA_MARGIN ) return 'water';

		return 'other';

	}

	// --- data fetch ----------------------------------------------------------------

	async _refresh( center ) {

		this._fetching = true;
		this._lastFetch = performance.now();
		this.status = 'fetching map data…';

		const { lat, lon } = this.localToLatLon( center );
		const dLat = ZONE_RADIUS / 111320;
		const dLon = ZONE_RADIUS / ( 111320 * Math.cos( lat * Math.PI / 180 ) );
		const bbox = `${ lat - dLat },${ lon - dLon },${ lat + dLat },${ lon + dLon }`;

		const query = `[out:json][timeout:25];(
			way["building"](${ bbox });
			way["highway"](${ bbox });
			way["leisure"~"^(park|garden|pitch|golf_course|playground|dog_park)$"](${ bbox });
			way["landuse"~"^(grass|meadow|recreation_ground|village_green|forest|cemetery|basin|reservoir|salt_pond)$"](${ bbox });
			way["natural"~"^(grassland|scrub|wood|heath|water)$"](${ bbox });
			way["waterway"="riverbank"](${ bbox });
		);out geom qt;`;

		this._abort = new AbortController();

		try {

			for ( const url of OVERPASS_URLS ) {

				try {

					const res = await fetch( url, {
						method: 'POST',
						headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
						body: 'data=' + encodeURIComponent( query ),
						signal: this._abort.signal,
					} );
					if ( ! res.ok ) throw new Error( `Overpass ${ res.status }` );
					const json = await res.json();
					if ( this.enabled ) this._ingest( json.elements || [], center );
					return;

				} catch ( err ) {

					if ( err.name === 'AbortError' ) return;
					console.warn( `Segmentation: ${ url } failed —`, err.message );

				}

			}

			this.status = 'fetch failed — retrying soon';

		} finally {

			this._fetching = false;

		}

	}

	_ingest( elements, center ) {

		const polys = { building: [], water: [], grass: [] };
		const roads = [];

		for ( const el of elements ) {

			if ( el.type !== 'way' || ! el.geometry || ! el.tags ) continue;
			const tags = el.tags;

			const pts = el.geometry.map( ( g ) => {

				this.latLonToLocal( g.lat, g.lon, 0, _v );
				return { x: _v.x, z: _v.z };

			} );

			if ( tags.building ) {

				const p = makePoly( pts );
				if ( p ) polys.building.push( p );

			} else if ( tags.highway ) {

				const half = ( ROAD_WIDTHS[ tags.highway ] || 7 ) / 2;
				roads.push( makeRoad( pts, half ) );

			} else if ( tags.natural === 'water' || tags.waterway === 'riverbank' || WATER_LANDUSE.has( tags.landuse ) ) {

				const p = makePoly( pts );
				if ( p ) polys.water.push( p );

			} else if ( GRASS_LEISURE.has( tags.leisure ) || GRASS_LANDUSE.has( tags.landuse ) || GRASS_NATURAL.has( tags.natural ) ) {

				const p = makePoly( pts );
				if ( p ) polys.grass.push( p );

			}

		}

		this._polys = polys;
		this._roads = roads;
		this._haveData = true;
		this._center.copy( center );
		this._haveZone = true;

		// sea level: the local origin sits in the middle of the bay
		if ( this._seaY === null ) {

			const y = this._groundY( 0, 0 );
			if ( y !== null ) this._seaY = y;

		}

		this._queueGridBuild( center );

	}

	// --- grid rasterization -----------------------------------------------------------

	_queueGridBuild( center ) {

		const jobs = this._jobs;
		jobs.length = 0;
		this.status = 'painting segments…';

		const n = Math.floor( ( ZONE_RADIUS * 2 ) / CELL );
		const half = CELL / 2;
		const inset = CELL * 0.47; // slight gap draws the grid lines
		const positions = [];
		const colors = [];
		const indices = [];
		const counts = { building: 0, road: 0, grass: 0, water: 0 };
		const colorRGB = {};
		for ( const key in SEGMENT_COLORS ) {

			const c = SEGMENT_COLORS[ key ];
			colorRGB[ key ] = [ ( c >> 16 & 255 ) / 255, ( c >> 8 & 255 ) / 255, ( c & 255 ) / 255 ];

		}

		for ( let iz = 0; iz < n; iz ++ ) {

			jobs.push( () => {

				const z = center.z - ZONE_RADIUS + iz * CELL + half;
				for ( let ix = 0; ix < n; ix ++ ) {

					const x = center.x - ZONE_RADIUS + ix * CELL + half;
					const y = this._groundY( x, z );
					if ( y === null ) continue;

					const cls = this.classify( x, z, y );
					if ( cls === 'other' ) continue;

					counts[ cls ] ++;
					const [ r, g, b ] = colorRGB[ cls ];
					const base = positions.length / 3;
					positions.push(
						x - inset, y + LIFT, z - inset,
						x + inset, y + LIFT, z - inset,
						x + inset, y + LIFT, z + inset,
						x - inset, y + LIFT, z + inset
					);
					for ( let k = 0; k < 4; k ++ ) colors.push( r, g, b );
					indices.push( base, base + 2, base + 1, base, base + 3, base + 2 );

				}

			} );

		}

		jobs.push( () => this._swapGrid( positions, colors, indices, counts ) );

	}

	_swapGrid( positions, colors, indices, counts ) {

		this._disposeMesh();

		const geo = new BufferGeometry();
		geo.setAttribute( 'position', new BufferAttribute( new Float32Array( positions ), 3 ) );
		geo.setAttribute( 'color', new BufferAttribute( new Float32Array( colors ), 3 ) );
		geo.setIndex( indices );
		geo.computeBoundingSphere();

		this.mesh = new Mesh( geo, new MeshBasicMaterial( {
			vertexColors: true,
			transparent: true,
			opacity: 0.5,
			depthWrite: false,
		} ) );
		this.scene.add( this.mesh );

		this.status = `${ counts.building } building · ${ counts.road } road · ${ counts.grass } grass · ${ counts.water } water cells`;

	}

	_disposeMesh() {

		if ( ! this.mesh ) return;
		this.scene.remove( this.mesh );
		this.mesh.geometry.dispose();
		this.mesh.material.dispose();
		this.mesh = null;

	}

	_groundY( x, z ) {

		this._raycaster.ray.origin.set( x, 1200, z );
		this._raycaster.ray.direction.set( 0, - 1, 0 );
		this._raycaster.near = 0;
		this._raycaster.far = 2400;
		const hit = this._raycaster.intersectObject( this.tilesGroup, true )[ 0 ];
		return hit ? hit.point.y : null;

	}

}

// --- geometry helpers -----------------------------------------------------------

function makePoly( pts ) {

	if ( pts.length > 1 ) {

		const a = pts[ 0 ];
		const b = pts[ pts.length - 1 ];
		if ( Math.hypot( a.x - b.x, a.z - b.z ) < 0.01 ) pts.pop();

	}

	if ( pts.length < 3 ) return null;

	const xs = pts.map( ( p ) => p.x );
	const zs = pts.map( ( p ) => p.z );
	return { xs, zs, ...bboxOf( pts, 0 ) };

}

function makeRoad( pts, half ) {

	return { pts, half, ...bboxOf( pts, half + 1 ) };

}

function bboxOf( pts, pad ) {

	let minX = Infinity, maxX = - Infinity, minZ = Infinity, maxZ = - Infinity;
	for ( const p of pts ) {

		if ( p.x < minX ) minX = p.x;
		if ( p.x > maxX ) maxX = p.x;
		if ( p.z < minZ ) minZ = p.z;
		if ( p.z > maxZ ) maxZ = p.z;

	}

	return { minX: minX - pad, maxX: maxX + pad, minZ: minZ - pad, maxZ: maxZ + pad };

}

function inBBox( b, x, z ) {

	return x >= b.minX && x <= b.maxX && z >= b.minZ && z <= b.maxZ;

}

// even-odd rule point-in-polygon
function pointInPoly( x, z, xs, zs ) {

	let inside = false;
	for ( let i = 0, j = xs.length - 1; i < xs.length; j = i ++ ) {

		if ( ( zs[ i ] > z ) !== ( zs[ j ] > z ) &&
			x < ( xs[ j ] - xs[ i ] ) * ( z - zs[ i ] ) / ( zs[ j ] - zs[ i ] ) + xs[ i ] ) {

			inside = ! inside;

		}

	}

	return inside;

}

function nearPolyline( x, z, pts, half ) {

	const r2 = half * half;
	for ( let i = 0; i < pts.length - 1; i ++ ) {

		const ax = pts[ i ].x, az = pts[ i ].z;
		const bx = pts[ i + 1 ].x, bz = pts[ i + 1 ].z;
		const dx = bx - ax, dz = bz - az;
		const len2 = dx * dx + dz * dz;
		let t = len2 > 0 ? ( ( x - ax ) * dx + ( z - az ) * dz ) / len2 : 0;
		t = Math.max( 0, Math.min( 1, t ) );
		const px = ax + dx * t - x;
		const pz = az + dz * t - z;
		if ( px * px + pz * pz <= r2 ) return true;

	}

	return false;

}
