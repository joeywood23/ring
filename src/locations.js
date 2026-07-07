// Preset viewpoints around the Bay Area.
// target: what the camera looks at (lat/lon degrees, height metres above ellipsoid)
// dist: camera distance in metres, az: compass bearing FROM the target TO the
// camera (deg, 0 = camera due north of target), elev: camera elevation angle (deg).
export const LOCATIONS = [
	{ name: 'Downtown SF', lat: 37.7925, lon: - 122.3970, height: 80, dist: 2200, az: 205, elev: 32 },
	{ name: 'Golden Gate', lat: 37.8199, lon: - 122.4783, height: 60, dist: 1900, az: 150, elev: 18 },
	{ name: 'Alcatraz', lat: 37.8267, lon: - 122.4230, height: 0, dist: 1400, az: 195, elev: 30 },
	{ name: 'Bay Bridge', lat: 37.7983, lon: - 122.3778, height: 60, dist: 2300, az: 250, elev: 22 },
	{ name: 'Coit Tower', lat: 37.8024, lon: - 122.4058, height: 60, dist: 1000, az: 130, elev: 25 },
	{ name: 'Twin Peaks', lat: 37.7544, lon: - 122.4477, height: 250, dist: 1800, az: 75, elev: 22 },
	{ name: 'Marin Headlands', lat: 37.8262, lon: - 122.4997, height: 150, dist: 2800, az: 130, elev: 20 },
	{ name: 'Oakland', lat: 37.8044, lon: - 122.2712, height: 0, dist: 2400, az: 245, elev: 30 },
	// steep overview so the camera itself stays inside the playable bounds
	{ name: 'Whole Bay', lat: 37.7900, lon: - 122.3500, height: 0, dist: 34000, az: 180, elev: 75 },
];

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
