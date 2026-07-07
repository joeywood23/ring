import { CanvasTexture, LinearFilter, ClampToEdgeWrapping } from 'three';
import { PbfReader } from 'pbf';
import { VectorTile } from '@mapbox/vector-tile';
import { PLAY_BOUNDS } from './bounds.js';
import { distortionUniforms } from './effects.js';

// Semantic segmentation of the whole play area, computed once up front.
// OpenFreeMap vector tiles (OSM data) covering the play bounds are fetched in
// one burst and rasterized as continuous polygons — buildings, roads at their
// real widths, grass, water (the Bay included) — into a single coverage
// canvas. The tile shader samples it by world position (see ringSegment in
// effects.js), so the photogrammetry itself is tinted; no grids, no raycasts,
// no refetching as you move. classify() reads the same canvas for gameplay.

const TILEJSON_URL = 'https://tiles.openfreemap.org/planet';
const ZOOM = 14;
const CANVAS_W = 4096;
const CONCURRENCY = 12;
const TINT = 0.55; // how strongly classes tint the photogrammetry

export const SEGMENT_COLORS = {
	building: '#ff6f61',
	road: '#8b7cf6',
	grass: '#4ecb5f',
	water: '#3aa5ff',
};

export const CLASS_RGB = {
	building: [ 255, 111, 97 ],
	road: [ 139, 124, 246 ],
	grass: [ 78, 203, 95 ],
	water: [ 58, 165, 255 ],
};

// road paint width in metres by OpenMapTiles transportation class
const ROAD_WIDTHS = {
	motorway: 18, trunk: 16, primary: 13, secondary: 11, tertiary: 10,
	minor: 8, service: 5, busway: 8, raceway: 8, track: 4, path: 3,
};

const GRASS_LANDUSE = new Set( [
	'cemetery', 'pitch', 'stadium', 'playground', 'grass', 'garden',
	'allotments', 'village_green', 'recreation_ground',
] );
const GRASS_LANDCOVER = new Set( [ 'grass', 'wood', 'scrub', 'meadow' ] );

export class Segmentation {

	constructor( { playArea } ) {

		this.playArea = playArea;
		this.enabled = false;
		this.ready = false;
		this.status = 'off';
		this._building = false;

		// canvas aspect matches the play area's metric aspect
		const widthM = 111320 * Math.cos( ( PLAY_BOUNDS.minLat + PLAY_BOUNDS.maxLat ) / 2 * Math.PI / 180 )
			* ( PLAY_BOUNDS.maxLon - PLAY_BOUNDS.minLon );
		const heightM = 111320 * ( PLAY_BOUNDS.maxLat - PLAY_BOUNDS.minLat );
		this._mPerPx = widthM / CANVAS_W;

		this.canvas = document.createElement( 'canvas' );
		this.canvas.width = CANVAS_W;
		this.canvas.height = Math.round( CANVAS_W * heightM / widthM );
		this.ctx = this.canvas.getContext( '2d', { willReadFrequently: true } );
		this._pixels = null;

		this.texture = new CanvasTexture( this.canvas );
		this.texture.minFilter = LinearFilter;
		this.texture.magFilter = LinearFilter;
		this.texture.generateMipmaps = false;
		this.texture.wrapS = ClampToEdgeWrapping;
		this.texture.wrapT = ClampToEdgeWrapping;
		distortionUniforms.uSegTex.value = this.texture;

	}

	setActive( value ) {

		this.enabled = value;

		if ( value ) {

			this._syncFrame();
			distortionUniforms.uSegStrength.value = TINT;
			if ( ! this.ready && ! this._building ) this._build();

		} else {

			distortionUniforms.uSegStrength.value = 0;

		}

	}

	// build the coverage data without turning the visual tint on — for
	// consumers like the voxel world that only need classify()
	ensureData() {

		if ( ! this.ready && ! this._building ) this._build();

	}

	// push the play-area frame (world XZ → coverage UV) into the shader
	_syncFrame() {

		const pa = this.playArea;
		if ( ! pa.ready ) return;
		distortionUniforms.uSegCenter.value.set( pa.center.x, pa.center.z );
		distortionUniforms.uSegEast.value.set( pa.eastDir.x, pa.eastDir.z );
		distortionUniforms.uSegNorth.value.set( pa.northDir.x, pa.northDir.z );
		distortionUniforms.uSegHalf.value.set( pa.halfWidth, pa.halfHeight );

	}

	// --- classification (pixel lookup on the same coverage the shader shows) ---

	classify( x, z ) {

		if ( ! this._pixels || ! this.playArea.ready ) return 'other';

		const pa = this.playArea;
		const rx = x - pa.center.x;
		const rz = z - pa.center.z;
		const e = ( rx * pa.eastDir.x + rz * pa.eastDir.z ) / pa.halfWidth;
		const n = ( rx * pa.northDir.x + rz * pa.northDir.z ) / pa.halfHeight;
		if ( e < - 1 || e > 1 || n < - 1 || n > 1 ) return 'other';

		const px = Math.min( this.canvas.width - 1, Math.max( 0, Math.round( ( e * 0.5 + 0.5 ) * this.canvas.width ) ) );
		const py = Math.min( this.canvas.height - 1, Math.max( 0, Math.round( ( 1 - ( n * 0.5 + 0.5 ) ) * this.canvas.height ) ) );
		const i = ( py * this.canvas.width + px ) * 4;
		const d = this._pixels.data;
		if ( d[ i + 3 ] < 100 ) return 'other';

		let best = 'other';
		let bestDist = Infinity;
		for ( const cls in CLASS_RGB ) {

			const c = CLASS_RGB[ cls ];
			const dist = ( d[ i ] - c[ 0 ] ) ** 2 + ( d[ i + 1 ] - c[ 1 ] ) ** 2 + ( d[ i + 2 ] - c[ 2 ] ) ** 2;
			if ( dist < bestDist ) {

				bestDist = dist;
				best = cls;

			}

		}

		return best;

	}

	// --- one-shot build ---------------------------------------------------------

	async _build() {

		this._building = true;
		this.status = 'fetching tile index…';

		try {

			const meta = await ( await fetch( TILEJSON_URL ) ).json();
			const template = meta.tiles[ 0 ];

			const x0 = lonToTile( PLAY_BOUNDS.minLon, ZOOM );
			const x1 = lonToTile( PLAY_BOUNDS.maxLon, ZOOM );
			const y0 = latToTile( PLAY_BOUNDS.maxLat, ZOOM ); // north = smaller y
			const y1 = latToTile( PLAY_BOUNDS.minLat, ZOOM );

			const jobs = [];
			for ( let ty = y0; ty <= y1; ty ++ ) {

				for ( let tx = x0; tx <= x1; tx ++ ) jobs.push( [ tx, ty ] );

			}

			let done = 0;
			const total = jobs.length;
			this.status = `loading 0 / ${ total } tiles…`;

			const worker = async () => {

				while ( jobs.length ) {

					const [ tx, ty ] = jobs.shift();
					try {

						const url = template
							.replace( '{z}', ZOOM ).replace( '{x}', tx ).replace( '{y}', ty );
						const buf = await ( await fetch( url ) ).arrayBuffer();
						this._drawTile( new VectorTile( new PbfReader( buf ) ), tx, ty );

					} catch ( err ) {

						console.warn( `Segmentation: tile ${ tx }/${ ty } failed —`, err.message );

					}

					done ++;
					this.status = `loading ${ done } / ${ total } tiles…`;
					this.texture.needsUpdate = true; // paint progressively

				}

			};

			await Promise.all( Array.from( { length: CONCURRENCY }, worker ) );

			this._pixels = this.ctx.getImageData( 0, 0, this.canvas.width, this.canvas.height );
			this.texture.needsUpdate = true;
			this.ready = true;
			this.status = 'whole play area segmented';

		} catch ( err ) {

			console.error( 'Segmentation build failed:', err );
			this.status = 'load failed — toggle to retry';
			this._building = false;
			return;

		}

		this._building = false;

	}

	// --- rasterization ---------------------------------------------------------------

	_drawTile( vt, tx, ty ) {

		const ctx = this.ctx;
		this._tx = tx; // current tile coords for feature.toGeoJSON
		this._ty = ty;

		// clip to the tile's own rect so buffer geometry doesn't double-paint
		const left = this._px( tileToLon( tx, ZOOM ) );
		const right = this._px( tileToLon( tx + 1, ZOOM ) );
		const top = this._py( tileToLat( ty, ZOOM ) );
		const bottom = this._py( tileToLat( ty + 1, ZOOM ) );

		ctx.save();
		ctx.beginPath();
		ctx.rect( left, top, right - left, bottom - top );
		ctx.clip();

		// paint order: grass under water under roads under buildings
		this._layer( vt, 'park', () => true, SEGMENT_COLORS.grass );
		this._layer( vt, 'landcover', ( p ) => GRASS_LANDCOVER.has( p.class ), SEGMENT_COLORS.grass );
		this._layer( vt, 'landuse', ( p ) => GRASS_LANDUSE.has( p.class ), SEGMENT_COLORS.grass );
		this._layer( vt, 'water', () => true, SEGMENT_COLORS.water );
		this._roadLayer( vt );
		this._layer( vt, 'building', () => true, SEGMENT_COLORS.building );

		ctx.restore();

	}

	_layer( vt, name, accept, color ) {

		const layer = vt.layers[ name ];
		if ( ! layer ) return;

		const ctx = this.ctx;
		ctx.fillStyle = color;

		for ( let i = 0; i < layer.length; i ++ ) {

			const feature = layer.feature( i );
			if ( feature.type !== 3 || ! accept( feature.properties ) ) continue; // polygons only

			const geom = feature.toGeoJSON( this._tx, this._ty, ZOOM ).geometry;
			ctx.beginPath();
			const polys = geom.type === 'Polygon' ? [ geom.coordinates ] : geom.coordinates;
			for ( const rings of polys ) {

				for ( const ring of rings ) this._ring( ring );

			}

			ctx.fill( 'evenodd' );

		}

	}

	_roadLayer( vt ) {

		const layer = vt.layers.transportation;
		if ( ! layer ) return;

		const ctx = this.ctx;
		ctx.strokeStyle = SEGMENT_COLORS.road;
		ctx.lineCap = 'round';
		ctx.lineJoin = 'round';

		for ( let i = 0; i < layer.length; i ++ ) {

			const feature = layer.feature( i );
			const p = feature.properties;
			const width = ROAD_WIDTHS[ p.class ];
			if ( feature.type !== 2 || ! width ) continue;   // lines only, road classes only
			if ( p.brunnel === 'tunnel' ) continue;          // BART under the Bay is not a road

			const geom = feature.toGeoJSON( this._tx, this._ty, ZOOM ).geometry;
			const lines = geom.type === 'LineString' ? [ geom.coordinates ] : geom.coordinates;

			ctx.lineWidth = Math.max( width / this._mPerPx, 1.2 );
			ctx.beginPath();
			for ( const line of lines ) {

				for ( let j = 0; j < line.length; j ++ ) {

					const px = this._px( line[ j ][ 0 ] );
					const py = this._py( line[ j ][ 1 ] );
					if ( j === 0 ) ctx.moveTo( px, py );
					else ctx.lineTo( px, py );

				}

			}

			ctx.stroke();

		}

	}

	_ring( ring ) {

		const ctx = this.ctx;
		for ( let j = 0; j < ring.length; j ++ ) {

			const px = this._px( ring[ j ][ 0 ] );
			const py = this._py( ring[ j ][ 1 ] );
			if ( j === 0 ) ctx.moveTo( px, py );
			else ctx.lineTo( px, py );

		}

		ctx.closePath();

	}

	_px( lon ) {

		return ( lon - PLAY_BOUNDS.minLon ) / ( PLAY_BOUNDS.maxLon - PLAY_BOUNDS.minLon ) * this.canvas.width;

	}

	_py( lat ) {

		return ( PLAY_BOUNDS.maxLat - lat ) / ( PLAY_BOUNDS.maxLat - PLAY_BOUNDS.minLat ) * this.canvas.height;

	}

}

// slippy-map tile math
function lonToTile( lon, z ) {

	return Math.floor( ( lon + 180 ) / 360 * ( 1 << z ) );

}

function latToTile( lat, z ) {

	const r = lat * Math.PI / 180;
	return Math.floor( ( 1 - Math.log( Math.tan( r ) + 1 / Math.cos( r ) ) / Math.PI ) / 2 * ( 1 << z ) );

}

function tileToLon( x, z ) {

	return x / ( 1 << z ) * 360 - 180;

}

function tileToLat( y, z ) {

	const n = Math.PI - 2 * Math.PI * y / ( 1 << z );
	return 180 / Math.PI * Math.atan( 0.5 * ( Math.exp( n ) - Math.exp( - n ) ) );

}
