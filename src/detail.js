import {
	Group,
	Mesh,
	InstancedMesh,
	BufferGeometry,
	BufferAttribute,
	Shape,
	ExtrudeGeometry,
	CylinderGeometry,
	IcosahedronGeometry,
	MeshLambertMaterial,
	MeshBasicMaterial,
	Object3D,
	Vector2,
	Vector3,
	Raycaster,
	MathUtils,
} from 'three';

// Clean-model overlay ("upscaler") for skate mode. The photogrammetry mesh has
// no semantics, so road/building/vegetation shapes come from OpenStreetMap's
// Overpass API and are draped onto the tile mesh with BVH ground raycasts.
// Only a small zone around the skater is fetched and built, geometry
// construction is amortized across frames, and each mesh is frustum-culled by
// three.js so only objects in view are drawn.

const OVERPASS_URLS = [
	'https://overpass-api.de/api/interpreter',
	'https://overpass.kumi.systems/api/interpreter',
];
const ZONE_RADIUS = 320;          // metres of clean detail around the skater
const REFRESH_DIST = 140;         // rebuild when the skater strays this far from zone center
const MIN_FETCH_INTERVAL = 6000;  // ms between Overpass requests
const JOB_BUDGET_MS = 6;          // per-frame geometry build budget
const ROAD_LIFT = 0.45;           // drape height above the photogrammetry ground
const ROAD_STEP = 8;              // ground-sample spacing along roads
const BUILDING_INFLATE = 0.7;     // metres outward so walls clear the photogrammetry facade

const ROAD_WIDTHS = {
	motorway: 14, trunk: 13, primary: 11, secondary: 9, tertiary: 8,
	residential: 6.5, unclassified: 6.5, living_street: 6, service: 4,
	pedestrian: 4.5, footway: 2.2, path: 2, cycleway: 2.4, steps: 2.2,
};
const FOOT_CLASSES = new Set( [ 'footway', 'path', 'cycleway', 'steps', 'pedestrian' ] );

// shared materials / geometries
const ROAD_MAT = new MeshBasicMaterial( { color: 0x363a42, polygonOffset: true, polygonOffsetFactor: - 2 } );
const FOOT_MAT = new MeshBasicMaterial( { color: 0x9aa0a8, polygonOffset: true, polygonOffsetFactor: - 2 } );
const LINE_MAT = new MeshBasicMaterial( { color: 0xe8c96b, polygonOffset: true, polygonOffsetFactor: - 4 } );
const BUILDING_MATS = [ 0xe8e2d5, 0xd9d4c8, 0xcfd6de, 0xe3d9cf, 0xdccfc4 ]
	.map( ( color ) => new MeshLambertMaterial( { color, transparent: true, opacity: 0.92 } ) );
const TRUNK_MAT = new MeshLambertMaterial( { color: 0x6b4a33 } );
const CANOPY_MAT = new MeshLambertMaterial( { color: 0x4e8f4a } );
const BUSH_MAT = new MeshLambertMaterial( { color: 0x3f7a3d } );

const TRUNK_GEO = new CylinderGeometry( 0.12, 0.18, 1, 6 );
TRUNK_GEO.translate( 0, 0.5, 0 ); // pivot at base
const CANOPY_GEO = new IcosahedronGeometry( 1, 1 );
const BUSH_GEO = new IcosahedronGeometry( 1, 1 );
BUSH_GEO.scale( 1, 0.7, 1 );

const _dummy = new Object3D();
const _v = new Vector3();
const _a = new Vector3();
const _b = new Vector3();

export class DetailOverlay {

	constructor( { scene, tilesGroup, latLonToLocal, localToLatLon } ) {

		this.scene = scene;
		this.tilesGroup = tilesGroup;
		this.latLonToLocal = latLonToLocal;
		this.localToLatLon = localToLatLon;

		this.enabled = false;
		this.attribution = 'Map data © OpenStreetMap contributors';
		this.status = 'off';
		this.zoneRadius = ZONE_RADIUS;
		this.zoneCenter = new Vector3();
		this.hasZone = false;
		this._counts = { roads: 0, buildings: 0, plants: 0 };

		this.group = null;
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
			this._lastFetch = - Infinity; // allow an immediate fetch

		} else {

			if ( this._abort ) this._abort.abort();
			this._jobs.length = 0;
			this._disposeGroup( this.group );
			this.group = null;
			this._haveZone = false;
			this.hasZone = false;
			this._fetching = false;
			this.status = 'off';

		}

	}

	update( playerPos ) {

		if ( ! this.enabled ) return;

		const now = performance.now();
		const stale = ! this._haveZone || playerPos.distanceTo( this._center ) > REFRESH_DIST;
		if ( stale && ! this._fetching && now - this._lastFetch > MIN_FETCH_INTERVAL ) {

			this._refresh( playerPos.clone() );

		}

		// build queued geometry within a per-frame time budget
		const start = performance.now();
		while ( this._jobs.length && performance.now() - start < JOB_BUDGET_MS ) {

			this._jobs.shift()();

		}

	}

	// --- data fetch ------------------------------------------------------------

	async _refresh( center ) {

		this._fetching = true;
		this._lastFetch = performance.now();
		this.status = 'fetching map data…';

		const { lat, lon } = this.localToLatLon( center );
		const dLat = ZONE_RADIUS / 111320;
		const dLon = ZONE_RADIUS / ( 111320 * Math.cos( lat * MathUtils.DEG2RAD ) );
		const bbox = `${ lat - dLat },${ lon - dLon },${ lat + dLat },${ lon + dLon }`;

		const query = `[out:json][timeout:25];(
			way["highway"](${ bbox });
			way["building"](${ bbox });
			node["natural"="tree"](${ bbox });
			node["natural"="shrub"](${ bbox });
			way["natural"="tree_row"](${ bbox });
			way["barrier"="hedge"](${ bbox });
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
					if ( this.enabled ) this._queueZoneBuild( json.elements || [], center );
					return;

				} catch ( err ) {

					if ( err.name === 'AbortError' ) return;
					console.warn( `DetailOverlay: ${ url } failed —`, err.message );

				}

			}

			this.status = 'fetch failed — retrying soon';

		} finally {

			this._fetching = false;

		}

	}

	// --- zone building -----------------------------------------------------------

	_queueZoneBuild( elements, center ) {

		const group = new Group();
		const trees = [];
		const bushes = [];
		const jobs = this._jobs;
		jobs.length = 0; // discard any stale work
		this.status = 'building models…';
		this._counts = { roads: 0, buildings: 0, plants: 0 };

		let roadCount = 0;
		let buildingCount = 0;

		for ( const el of elements ) {

			const tags = el.tags;
			if ( ! tags ) continue;

			if ( el.type === 'way' && el.geometry ) {

				if ( tags.highway && ROAD_WIDTHS[ tags.highway ] && roadCount ++ < 400 ) {

					jobs.push( () => this._buildRoad( el, group ) );

				} else if ( tags.building && buildingCount ++ < 600 ) {

					jobs.push( () => this._buildBuilding( el, group ) );

				} else if ( tags.natural === 'tree_row' ) {

					jobs.push( () => this._collectAlongWay( el, 8, trees ) );

				} else if ( tags.barrier === 'hedge' ) {

					jobs.push( () => this._collectAlongWay( el, 3, bushes ) );

				}

			} else if ( el.type === 'node' ) {

				if ( tags.natural === 'tree' ) {

					jobs.push( () => this._collectPoint( el.lat, el.lon, trees ) );

				} else if ( tags.natural === 'shrub' ) {

					jobs.push( () => this._collectPoint( el.lat, el.lon, bushes ) );

				}

			}

		}

		jobs.push( () => this._buildVegetation( trees, bushes, group ) );
		jobs.push( () => this._swapZone( group, center ) );

	}

	_swapZone( group, center ) {

		this._disposeGroup( this.group );
		this.scene.add( group );
		this.group = group;
		this._center.copy( center );
		this.zoneCenter.copy( center );
		this._haveZone = true;
		this.hasZone = true;

		const c = this._counts;
		this.status = `${ c.roads } roads · ${ c.buildings } buildings · ${ c.plants } plants`;

	}

	_disposeGroup( group ) {

		if ( ! group ) return;
		this.scene.remove( group );
		group.traverse( ( child ) => {

			if ( child.geometry ) child.geometry.dispose();

		} );

	}

	// --- ground sampling -----------------------------------------------------------

	_groundY( x, z ) {

		this._raycaster.ray.origin.set( x, 800, z );
		this._raycaster.ray.direction.set( 0, - 1, 0 );
		this._raycaster.near = 0;
		this._raycaster.far = 1600;
		const hit = this._raycaster.intersectObject( this.tilesGroup, true )[ 0 ];
		return hit ? hit.point.y : null;

	}

	// --- roads -----------------------------------------------------------------------

	_buildRoad( el, group ) {

		const width = ROAD_WIDTHS[ el.tags.highway ];
		const pts = this._sampledPath( el.geometry, ROAD_STEP );
		if ( pts.length < 2 ) return;

		const isFoot = FOOT_CLASSES.has( el.tags.highway );
		const mesh = this._ribbon( pts, width, isFoot ? FOOT_MAT : ROAD_MAT, ROAD_LIFT );
		if ( mesh ) {

			group.add( mesh );
			this._counts.roads ++;

		}

		// center line on proper streets
		if ( ! isFoot && width >= 6 ) {

			const line = this._ribbon( pts, 0.25, LINE_MAT, ROAD_LIFT + 0.05 );
			if ( line ) group.add( line );

		}

	}

	// resample the way's polyline to a regular step and drape onto the ground
	_sampledPath( geometry, step ) {

		const raw = geometry.map( ( g ) => this.latLonToLocal( g.lat, g.lon, 0, new Vector3() ) );
		const out = [];
		let lastY = null;

		for ( let i = 0; i < raw.length - 1; i ++ ) {

			_a.copy( raw[ i ] );
			_b.copy( raw[ i + 1 ] );
			const segLen = _a.distanceTo( _b );
			const n = Math.max( 1, Math.round( segLen / step ) );

			for ( let j = 0; j < n; j ++ ) {

				_v.lerpVectors( _a, _b, j / n );
				const y = this._groundY( _v.x, _v.z );
				if ( y !== null ) lastY = y;
				if ( lastY === null ) continue;
				out.push( new Vector3( _v.x, lastY, _v.z ) );

			}

		}

		const tail = raw[ raw.length - 1 ];
		const y = this._groundY( tail.x, tail.z );
		if ( y !== null || lastY !== null ) out.push( new Vector3( tail.x, y !== null ? y : lastY, tail.z ) );

		return out;

	}

	_ribbon( pts, width, material, lift ) {

		const count = pts.length;
		if ( count < 2 ) return null;

		const positions = new Float32Array( count * 2 * 3 );
		const half = width / 2;

		for ( let i = 0; i < count; i ++ ) {

			// direction averaged over neighbors, perpendicular in the ground plane
			const prev = pts[ Math.max( i - 1, 0 ) ];
			const next = pts[ Math.min( i + 1, count - 1 ) ];
			let dx = next.x - prev.x;
			let dz = next.z - prev.z;
			const len = Math.hypot( dx, dz ) || 1;
			dx /= len;
			dz /= len;

			const p = pts[ i ];
			const y = p.y + lift;
			positions[ i * 6 + 0 ] = p.x - dz * half;
			positions[ i * 6 + 1 ] = y;
			positions[ i * 6 + 2 ] = p.z + dx * half;
			positions[ i * 6 + 3 ] = p.x + dz * half;
			positions[ i * 6 + 4 ] = y;
			positions[ i * 6 + 5 ] = p.z - dx * half;

		}

		const indices = [];
		for ( let i = 0; i < count - 1; i ++ ) {

			const k = i * 2;
			indices.push( k, k + 1, k + 2, k + 1, k + 3, k + 2 );

		}

		const geo = new BufferGeometry();
		geo.setAttribute( 'position', new BufferAttribute( positions, 3 ) );
		geo.setIndex( indices );
		geo.computeBoundingSphere();

		return new Mesh( geo, material );

	}

	// --- buildings ----------------------------------------------------------------------

	_buildBuilding( el, group ) {

		const outline = el.geometry.map( ( g ) => this.latLonToLocal( g.lat, g.lon, 0, new Vector3() ) );
		// OSM closes the ring by repeating the first node
		if ( outline.length > 1 && outline[ 0 ].distanceTo( outline[ outline.length - 1 ] ) < 0.01 ) outline.pop();
		if ( outline.length < 3 ) return;

		// lowest sampled corner ≈ street level (higher samples land on the
		// photogrammetry roof of the building itself)
		let base = Infinity;
		const sampleStep = Math.max( 1, Math.floor( outline.length / 6 ) );
		for ( let i = 0; i < outline.length; i += sampleStep ) {

			const y = this._groundY( outline[ i ].x, outline[ i ].z );
			if ( y !== null && y < base ) base = y;

		}

		if ( base === Infinity ) return;

		// inflate the footprint outward so the clean shell sits outside the
		// photogrammetry facade instead of hiding inside it
		let cx = 0;
		let cz = 0;
		for ( const p of outline ) {

			cx += p.x;
			cz += p.z;

		}

		cx /= outline.length;
		cz /= outline.length;
		let avgR = 0;
		for ( const p of outline ) avgR += Math.hypot( p.x - cx, p.z - cz );
		avgR /= outline.length;
		const inflate = MathUtils.clamp( ( avgR + BUILDING_INFLATE ) / Math.max( avgR, 0.1 ), 1, 1.25 );

		const height = parseBuildingHeight( el.tags );
		const shape = new Shape();
		const sx = ( p ) => cx + ( p.x - cx ) * inflate;
		const sz = ( p ) => cz + ( p.z - cz ) * inflate;
		shape.moveTo( sx( outline[ 0 ] ), - sz( outline[ 0 ] ) );
		for ( let i = 1; i < outline.length; i ++ ) shape.lineTo( sx( outline[ i ] ), - sz( outline[ i ] ) );
		shape.closePath();

		const geo = new ExtrudeGeometry( shape, { depth: height, bevelEnabled: false } );
		geo.rotateX( - Math.PI / 2 ); // shape XY → footprint XZ, extrusion up +Y
		geo.translate( 0, base - 0.5, 0 );
		geo.computeBoundingSphere();

		const mesh = new Mesh( geo, BUILDING_MATS[ el.id % BUILDING_MATS.length ] );
		group.add( mesh );
		this._counts.buildings ++;

	}

	// --- vegetation ------------------------------------------------------------------------

	_collectPoint( lat, lon, arr ) {

		if ( arr.length > 3000 ) return;
		const p = this.latLonToLocal( lat, lon, 0, new Vector3() );
		const y = this._groundY( p.x, p.z );
		if ( y !== null ) arr.push( p.setY( y ) );

	}

	_collectAlongWay( el, step, arr ) {

		const raw = el.geometry.map( ( g ) => this.latLonToLocal( g.lat, g.lon, 0, new Vector3() ) );
		for ( let i = 0; i < raw.length - 1 && arr.length <= 3000; i ++ ) {

			const segLen = raw[ i ].distanceTo( raw[ i + 1 ] );
			const n = Math.max( 1, Math.round( segLen / step ) );
			for ( let j = 0; j < n; j ++ ) {

				_v.lerpVectors( raw[ i ], raw[ i + 1 ], j / n );
				const y = this._groundY( _v.x, _v.z );
				if ( y !== null ) arr.push( new Vector3( _v.x, y, _v.z ) );

			}

		}

	}

	_buildVegetation( trees, bushes, group ) {

		this._counts.plants = trees.length + bushes.length;

		if ( trees.length ) {

			const trunks = new InstancedMesh( TRUNK_GEO, TRUNK_MAT, trees.length );
			const canopies = new InstancedMesh( CANOPY_GEO, CANOPY_MAT, trees.length );

			trees.forEach( ( p, i ) => {

				const s = 0.8 + hash01( i * 7.13 ) * 0.5;

				_dummy.position.copy( p );
				_dummy.scale.set( 1, 2.6 * s, 1 );
				_dummy.rotation.set( 0, 0, 0 );
				_dummy.updateMatrix();
				trunks.setMatrixAt( i, _dummy.matrix );

				_dummy.position.set( p.x, p.y + 3.1 * s, p.z );
				_dummy.scale.setScalar( 1.7 * s );
				_dummy.rotation.y = hash01( i * 3.7 ) * Math.PI;
				_dummy.updateMatrix();
				canopies.setMatrixAt( i, _dummy.matrix );

			} );

			// instances span the zone, so skip whole-mesh culling
			trunks.frustumCulled = false;
			canopies.frustumCulled = false;
			group.add( trunks, canopies );

		}

		if ( bushes.length ) {

			const mesh = new InstancedMesh( BUSH_GEO, BUSH_MAT, bushes.length );
			bushes.forEach( ( p, i ) => {

				const s = 0.55 + hash01( i * 5.31 ) * 0.5;
				_dummy.position.set( p.x, p.y + 0.35 * s, p.z );
				_dummy.scale.setScalar( s );
				_dummy.rotation.set( 0, hash01( i * 9.2 ) * Math.PI, 0 );
				_dummy.updateMatrix();
				mesh.setMatrixAt( i, _dummy.matrix );

			} );
			mesh.frustumCulled = false;
			group.add( mesh );

		}

	}

}

function parseBuildingHeight( tags ) {

	const h = parseFloat( tags.height );
	if ( ! isNaN( h ) && h > 0 ) return Math.min( h, 400 );

	const levels = parseFloat( tags[ 'building:levels' ] );
	if ( ! isNaN( levels ) && levels > 0 ) return Math.min( levels * 3.2 + 1.5, 400 );

	return 6.5;

}

function hash01( x ) {

	const s = Math.sin( x * 127.1 ) * 43758.5453;
	return s - Math.floor( s );

}
