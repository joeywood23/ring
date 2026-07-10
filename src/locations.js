import { currentArea } from './areas.js';

// Preset viewpoints for the active area (each area defines its own list).
// target: what the camera looks at (lat/lon degrees, height metres above ellipsoid)
// dist: camera distance in metres, az: compass bearing FROM the target TO the
// camera (deg, 0 = camera due north of target), elev: camera elevation angle (deg).
export const LOCATIONS = currentArea().locations;

const METERS_PER_DEG_LAT = 111320;

// Offset a lat/lon target by distance/bearing/elevation to get the camera's
// own lat/lon/height — avoids any assumptions about local frame axes.
export function cameraGeoForLocation( loc ) {

	const elevRad = ( loc.elev * Math.PI ) / 180;
	const azRad = ( loc.az * Math.PI ) / 180;
	const horiz = loc.dist * Math.cos( elevRad );
	const vert = loc.dist * Math.sin( elevRad );

	const dLat = ( horiz * Math.cos( azRad ) ) / METERS_PER_DEG_LAT;
	const dLon = ( horiz * Math.sin( azRad ) ) /
		( METERS_PER_DEG_LAT * Math.cos( ( loc.lat * Math.PI ) / 180 ) );

	return {
		lat: loc.lat + dLat,
		lon: loc.lon + dLon,
		height: loc.height + vert,
	};

}
