import { Box3, Matrix4, Vector3, MathUtils } from 'three';
import { WGS84_ELLIPSOID, OBJECT_FRAME, OBB } from '3d-tiles-renderer';
import { LoadRegionPlugin, OBBRegion } from '3d-tiles-renderer/plugins';
import { currentArea, boundsForArea } from './areas.js';

// The playable box — single source of truth for tile loading, camera/skate
// limits, and the minimap crop. Every area shares one metric footprint
// (~33 × 40 km, sized so the habitat cylinder is ~40 km end to end); the
// area menu picks which patch of the globe it stamps onto.
export const PLAY_BOUNDS = boundsForArea( currentArea() );

const MID_LAT = ( PLAY_BOUNDS.minLat + PLAY_BOUNDS.maxLat ) / 2;
const MID_LON = ( PLAY_BOUNDS.minLon + PLAY_BOUNDS.maxLon ) / 2;

function ecef( latDeg, lonDeg ) {

	return WGS84_ELLIPSOID.getCartographicToPosition(
		latDeg * MathUtils.DEG2RAD,
		lonDeg * MathUtils.DEG2RAD,
		0,
		new Vector3()
	);

}

// Suppresses loading of any tile outside the play bounds. The region shape is
// an OBB in the tileset's native ECEF frame (regions are tested against raw
// tile bounding volumes, before the group's reorientation transform). The huge
// errorTarget means the region only masks — it never forces refinement itself.
export function createPlayRegionPlugin() {

	const halfEW = ecef( MID_LAT, PLAY_BOUNDS.minLon ).distanceTo( ecef( MID_LAT, PLAY_BOUNDS.maxLon ) ) / 2;
	const halfNS = ecef( PLAY_BOUNDS.minLat, MID_LON ).distanceTo( ecef( PLAY_BOUNDS.maxLat, MID_LON ) ) / 2;

	// +Y up, +X east-west, +Z north-south at the region center
	const frame = WGS84_ELLIPSOID.getObjectFrame(
		MID_LAT * MathUtils.DEG2RAD,
		MID_LON * MathUtils.DEG2RAD,
		0, 0, 0, 0,
		new Matrix4(),
		OBJECT_FRAME
	);

	const box = new Box3(
		new Vector3( - halfEW, - 800, - halfNS ),
		new Vector3( halfEW, 4000, halfNS )
	);

	const plugin = new LoadRegionPlugin();
	plugin.addRegion( new OBBRegion( {
		obb: new OBB( box, frame ),
		mask: true,
		errorTarget: 1e10,
	} ) );
	return plugin;

}

const _rel = new Vector3();

// The same bounds expressed in the reoriented local frame (valid once the
// root tileset has loaded), for clamping positions at runtime.
export class PlayArea {

	constructor() {

		this.ready = false;
		this.center = new Vector3();
		this.eastDir = new Vector3( 1, 0, 0 );
		this.northDir = new Vector3( 0, 0, 1 );
		this.halfWidth = 1;
		this.halfHeight = 1;

	}

	configure( latLonToLocal ) {

		const b = PLAY_BOUNDS;
		this.center = latLonToLocal( MID_LAT, MID_LON, 0, new Vector3() );
		const east = latLonToLocal( MID_LAT, b.maxLon, 0, new Vector3() ).sub( this.center );
		const north = latLonToLocal( b.maxLat, MID_LON, 0, new Vector3() ).sub( this.center );

		this.halfWidth = east.length();
		this.halfHeight = north.length();
		this.eastDir = east.normalize();
		this.northDir = north.normalize();
		this.ready = true;

	}

	// Clamp a position horizontally to the play area. If `vel` is given, its
	// outward component is removed on contact (slide along the boundary).
	// Returns whether the position was clamped.
	constrain( pos, vel = null, margin = 0 ) {

		if ( ! this.ready ) return false;

		_rel.copy( pos ).sub( this.center );
		let e = _rel.dot( this.eastDir );
		let n = _rel.dot( this.northDir );
		const eMax = Math.max( this.halfWidth - margin, 1 );
		const nMax = Math.max( this.halfHeight - margin, 1 );

		let clamped = false;

		if ( Math.abs( e ) > eMax ) {

			if ( vel ) {

				const ve = vel.dot( this.eastDir );
				if ( Math.sign( ve ) === Math.sign( e ) ) vel.addScaledVector( this.eastDir, - ve );

			}

			e = MathUtils.clamp( e, - eMax, eMax );
			clamped = true;

		}

		if ( Math.abs( n ) > nMax ) {

			if ( vel ) {

				const vn = vel.dot( this.northDir );
				if ( Math.sign( vn ) === Math.sign( n ) ) vel.addScaledVector( this.northDir, - vn );

			}

			n = MathUtils.clamp( n, - nMax, nMax );
			clamped = true;

		}

		if ( clamped ) {

			const y = pos.y;
			pos.copy( this.center )
				.addScaledVector( this.eastDir, e )
				.addScaledVector( this.northDir, n )
				.setY( y );

		}

		return clamped;

	}

}
