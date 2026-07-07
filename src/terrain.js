import { PLAY_BOUNDS } from './bounds.js';

// Elevation for the whole play area from AWS's public terrarium tiles
// (Mapzen/SRTM). ~20 small PNGs are stitched into one grid, decoded once,
// then sampled bilinearly. Heights are metres above sea level.

const URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';
const ZOOM = 12;
const TILE = 256;

export class TerrainGrid {

	constructor() {

		this.ready = false;
		this._loading = null;

	}

	load( onStatus = () => {} ) {

		if ( ! this._loading ) this._loading = this._load( onStatus );
		return this._loading;

	}

	async _load( onStatus ) {

		const x0 = lonToTileX( PLAY_BOUNDS.minLon );
		const x1 = lonToTileX( PLAY_BOUNDS.maxLon );
		const y0 = latToTileY( PLAY_BOUNDS.maxLat );
		const y1 = latToTileY( PLAY_BOUNDS.minLat );

		const cols = x1 - x0 + 1;
		const rows = y1 - y0 + 1;
		this._w = cols * TILE;
		this._h = rows * TILE;
		this._px0 = x0 * TILE; // global mercator pixel origin
		this._py0 = y0 * TILE;

		const canvas = document.createElement( 'canvas' );
		canvas.width = this._w;
		canvas.height = this._h;
		const ctx = canvas.getContext( '2d', { willReadFrequently: true } );

		let done = 0;
		const total = cols * rows;
		const jobs = [];
		for ( let ty = y0; ty <= y1; ty ++ ) {

			for ( let tx = x0; tx <= x1; tx ++ ) {

				jobs.push( ( async () => {

					const url = URL.replace( '{z}', ZOOM ).replace( '{x}', tx ).replace( '{y}', ty );
					const blob = await ( await fetch( url ) ).blob();
					const img = await createImageBitmap( blob );
					ctx.drawImage( img, ( tx - x0 ) * TILE, ( ty - y0 ) * TILE );
					onStatus( `terrain ${ ++ done } / ${ total }` );

				} )() );

			}

		}

		await Promise.all( jobs );

		// terrarium encoding: (R*256 + G + B/256) − 32768 metres
		const data = ctx.getImageData( 0, 0, this._w, this._h ).data;
		const elev = new Float32Array( this._w * this._h );
		for ( let i = 0; i < elev.length; i ++ ) {

			elev[ i ] = data[ i * 4 ] * 256 + data[ i * 4 + 1 ] + data[ i * 4 + 2 ] / 256 - 32768;

		}

		this._elev = elev;
		this.ready = true;

	}

	// bilinear sample, metres above sea level
	sample( lon, lat ) {

		if ( ! this.ready ) return 0;

		const scale = ( 1 << ZOOM ) * TILE;
		const fx = ( lon + 180 ) / 360 * scale - this._px0 - 0.5;
		const r = lat * Math.PI / 180;
		const fy = ( 1 - Math.log( Math.tan( r ) + 1 / Math.cos( r ) ) / Math.PI ) / 2 * scale - this._py0 - 0.5;

		const x = Math.min( Math.max( fx, 0 ), this._w - 1.001 );
		const y = Math.min( Math.max( fy, 0 ), this._h - 1.001 );
		const ix = Math.floor( x );
		const iy = Math.floor( y );
		const tx = x - ix;
		const ty = y - iy;
		const e = this._elev;
		const i = iy * this._w + ix;

		return e[ i ] * ( 1 - tx ) * ( 1 - ty ) +
			e[ i + 1 ] * tx * ( 1 - ty ) +
			e[ i + this._w ] * ( 1 - tx ) * ty +
			e[ i + this._w + 1 ] * tx * ty;

	}

}

function lonToTileX( lon ) {

	return Math.floor( ( lon + 180 ) / 360 * ( 1 << ZOOM ) );

}

function latToTileY( lat ) {

	const r = lat * Math.PI / 180;
	return Math.floor( ( 1 - Math.log( Math.tan( r ) + 1 / Math.cos( r ) ) / Math.PI ) / 2 * ( 1 << ZOOM ) );

}
