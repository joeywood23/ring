// Playable areas around the globe. Every area stamps the same metric
// footprint as the original SF Bay box (~33 km east–west, ~40 km
// north–south) onto a new center, so the O'Neill cylinder, tile budget,
// segmentation canvas, and physics behave identically — only the place
// changes. Switching areas stores the id and reloads the page: a full
// reload keeps init logic single-path (the API key modal does the same).
//
// Per area:
//   lat/lon   — map center; the shared footprint extends around it
//   origin    — local frame origin, parked over water so one downward
//               raycast at (0,0) measures the local water line
//   groundY   — resting height of the shell in the local frame (metres,
//               ellipsoidal ≈ geoid offset + terrain); the roll ground,
//               opaque hull, and star field reference it
//   locations — fly-to presets (see locations.js for the camera fields)

const METERS_PER_DEG_LAT = 111320;

// the original SF Bay footprint, kept as THE footprint for every area
const HEIGHT_DEG = 0.36;
const WIDTH_M = METERS_PER_DEG_LAT * Math.cos( 37.88 * Math.PI / 180 ) * 0.38;

export const AREAS = [
	{
		id: 'sf-bay',
		name: 'SF Bay',
		lat: 37.88,
		lon: - 122.38,
		origin: { lat: 37.79, lon: - 122.35 }, // mid-bay
		groundY: - 32,
		locations: [
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
		],
	},
	{
		id: 'manhattan',
		name: 'Manhattan',
		lat: 40.755, // midtown — the island runs the box's long axis
		lon: - 73.975,
		origin: { lat: 40.665, lon: - 74.045 }, // open water in the Upper Bay
		groundY: - 33, // NYC geoid offset, a near-twin of SF's
		locations: [
			// postcard: lower Manhattan skyline from out in the harbor
			{ name: 'Lower Manhattan', lat: 40.7127, lon: - 74.0134, height: 250, dist: 2800, az: 195, elev: 22 },
			{ name: 'Midtown', lat: 40.7484, lon: - 73.9857, height: 200, dist: 2200, az: 200, elev: 30 },
			{ name: 'Statue of Liberty', lat: 40.6892, lon: - 74.0445, height: 60, dist: 1200, az: 150, elev: 20 },
			{ name: 'Central Park', lat: 40.7812, lon: - 73.9665, height: 40, dist: 2600, az: 180, elev: 35 },
			{ name: 'Brooklyn Bridge', lat: 40.7061, lon: - 73.9969, height: 60, dist: 1500, az: 120, elev: 20 },
			{ name: 'Whole Island', lat: 40.7550, lon: - 73.9750, height: 0, dist: 34000, az: 180, elev: 75 },
		],
	},
	{
		id: 'washington-dc',
		name: 'Washington DC',
		lat: 38.8895, // the National Mall at the center of the box
		lon: - 77.0353,
		origin: { lat: 38.8830, lon: - 77.0500 }, // mid-Potomac at Memorial Bridge
		groundY: - 33, // mid-Atlantic geoid offset, same family as NYC
		locations: [
			// postcard: the Mall from above the Washington Monument, Capitol behind
			{ name: 'National Mall', lat: 38.8895, lon: - 77.0353, height: 100, dist: 2600, az: 265, elev: 28 },
			{ name: 'Capitol', lat: 38.8899, lon: - 77.0091, height: 80, dist: 1400, az: 250, elev: 24 },
			{ name: 'White House', lat: 38.8977, lon: - 77.0365, height: 40, dist: 1100, az: 180, elev: 26 },
			{ name: 'Lincoln Memorial', lat: 38.8893, lon: - 77.0502, height: 30, dist: 1000, az: 100, elev: 20 },
			{ name: 'Pentagon', lat: 38.8719, lon: - 77.0563, height: 30, dist: 1800, az: 90, elev: 30 },
			{ name: 'Georgetown', lat: 38.9046, lon: - 77.0631, height: 40, dist: 1600, az: 140, elev: 24 },
			{ name: 'Whole District', lat: 38.8895, lon: - 77.0353, height: 0, dist: 34000, az: 180, elev: 75 },
		],
	},
	{
		id: 'paris',
		name: 'Paris',
		lat: 48.8566, // Île de la Cité — the historic bullseye
		lon: 2.3522,
		origin: { lat: 48.8628, lon: 2.3225 }, // the Seine at Pont de la Concorde
		groundY: 75, // Seine ~27 m up on a ~+45 m geoid; city ground a bit higher
		locations: [
			// postcard: the Eiffel Tower from across the Seine at Trocadéro
			{ name: 'Eiffel Tower', lat: 48.8584, lon: 2.2945, height: 180, dist: 1600, az: 320, elev: 22 },
			{ name: 'Louvre', lat: 48.8606, lon: 2.3376, height: 40, dist: 1200, az: 250, elev: 26 },
			{ name: 'Notre-Dame', lat: 48.8530, lon: 2.3499, height: 50, dist: 900, az: 235, elev: 24 },
			{ name: 'Arc de Triomphe', lat: 48.8738, lon: 2.2950, height: 50, dist: 1100, az: 120, elev: 24 },
			{ name: 'Sacré-Cœur', lat: 48.8867, lon: 2.3431, height: 80, dist: 1400, az: 200, elev: 22 },
			{ name: 'La Défense', lat: 48.8925, lon: 2.2360, height: 150, dist: 2200, az: 110, elev: 26 },
			{ name: 'Whole City', lat: 48.8566, lon: 2.3522, height: 0, dist: 34000, az: 180, elev: 75 },
		],
	},
	{
		id: 'nile-delta',
		name: 'Nile Delta',
		lat: 29.9792, // Great Pyramid of Giza
		lon: 31.1342,
		origin: { lat: 30.005, lon: 31.228 }, // on the Nile off Roda Island
		groundY: 35, // Cairo sits ~20 m above a ~+15 m geoid
		locations: [
			{ name: 'Giza Pyramids', lat: 29.9773, lon: 31.1325, height: 90, dist: 2200, az: 155, elev: 26 },
			{ name: 'Sphinx', lat: 29.9753, lon: 31.1376, height: 25, dist: 700, az: 95, elev: 18 },
			{ name: 'Saqqara', lat: 29.8713, lon: 31.2166, height: 60, dist: 1800, az: 200, elev: 26 },
			{ name: 'Cairo Tower', lat: 30.0459, lon: 31.2243, height: 100, dist: 1500, az: 230, elev: 25 },
			{ name: 'Citadel', lat: 30.0287, lon: 31.2599, height: 80, dist: 1600, az: 245, elev: 24 },
			{ name: 'Whole Delta', lat: 29.9792, lon: 31.1342, height: 0, dist: 34000, az: 180, elev: 75 },
		],
	},
];

const STORAGE = 'ring_area';

export function currentArea() {

	const id = localStorage.getItem( STORAGE );
	return AREAS.find( ( a ) => a.id === id ) || AREAS[ 0 ];

}

// Switch areas and reload into the new frame. No-op if already there.
export function selectArea( id ) {

	if ( id === currentArea().id ) return;
	localStorage.setItem( STORAGE, id );
	window.location.reload();

}

// The shared footprint centered on the area, in degrees. Longitude span
// widens with latitude so the metric width stays identical everywhere.
export function boundsForArea( area ) {

	const dLon = WIDTH_M / ( METERS_PER_DEG_LAT * Math.cos( area.lat * Math.PI / 180 ) );
	return {
		minLat: area.lat - HEIGHT_DEG / 2,
		maxLat: area.lat + HEIGHT_DEG / 2,
		minLon: area.lon - dLon / 2,
		maxLon: area.lon + dLon / 2,
	};

}
