import {
	WebGLRenderer,
	PerspectiveCamera,
	Scene,
	Fog,
	Color,
	Clock,
	Vector3,
	Quaternion,
	Matrix4,
	MathUtils,
	HemisphereLight,
} from 'three';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { TilesRenderer, EnvironmentControls, WGS84_ELLIPSOID } from '3d-tiles-renderer';
import {
	GoogleCloudAuthPlugin,
	GLTFExtensionsPlugin,
	TileCompressionPlugin,
	UpdateOnChangePlugin,
	ReorientationPlugin,
} from '3d-tiles-renderer/plugins';
import { distortionUniforms, patchMaterial, patchRollOnly, EFFECTS, COLOR_MODES } from './effects.js';
import { AREAS, currentArea, selectArea } from './areas.js';
import { LOCATIONS, cameraGeoForLocation } from './locations.js';
import { Minimap } from './minimap.js';
import { SkateMode, ensureBVH, PHYSICS, PHYSICS_CONTROLS } from './skate.js';
import { SkatePark } from './props.js';
import { PedestrianMode } from './walk.js';
import { PigeonMode } from './fly.js';
import { SailboatMode } from './sail.js';
import { SkateAudio } from './sound.js';
import { PlayArea, createPlayRegionPlugin } from './bounds.js';
import { DropTargeter } from './dropTarget.js';
import { DetailOverlay } from './detail.js';
import { Segmentation } from './segment.js';
import { VoxelWorld } from './voxel.js';
import { WaterLayer } from './water.js';
import { CylinderRoll, RollLODPlugin, createHullMesh } from './roll.js';
import { StarField } from './stars.js';

const KEY_STORAGE = 'ring_google_tiles_key';
// Referrer-restricted public key; a key saved via the modal takes precedence.
const DEFAULT_KEY = 'AIzaSyA2l_pwBwS5_Qyw0b4tDsULIKPGhgoAmpA';
const AREA = currentArea(); // which patch of the globe we're playing in
const ORIGIN = AREA.origin; // local frame origin, parked over local water

// TEMPORARY: the water layer reads confused in rolled space (sea level vs the
// sunken basin vs the surface sheet) — keep it off until reworked. Flipping
// this back re-enables the segmented sea: sinking, surface waves, swimming.
const WATER_DISABLED = true;

const state = {
	wireframe: false,
	timeSpeed: 1,
	rootLoaded: false,
	flying: false,
	lookTarget: new Vector3(),
	upscale: localStorage.getItem( 'ring_upscale' ) === '1', // shelved: off unless opted in
};

let renderer, camera, scene, tiles, controls, minimap, skate, walker, pigeon, sail, targeter, detail, park, segments, voxels, water, stars;
const roll = new CylinderRoll();
const rollLOD = new RollLODPlugin( roll );
let dropAs = 'skate'; // which mode the pending drop-in enters
const playArea = new PlayArea();
const clock = new Clock();

// ---------------------------------------------------------------------------
// API key gate
// ---------------------------------------------------------------------------

const keyModal = document.getElementById( 'key-modal' );
const keyInput = document.getElementById( 'key-input' );
const keyError = document.getElementById( 'key-error' );

const storedKey = localStorage.getItem( KEY_STORAGE );
init( storedKey || DEFAULT_KEY );

document.getElementById( 'key-save' ).addEventListener( 'click', submitKey );
keyModal.addEventListener( 'click', ( e ) => {

	if ( e.target === keyModal ) keyModal.classList.add( 'hidden' );

} );
keyInput.addEventListener( 'keydown', ( e ) => {

	if ( e.key === 'Enter' ) submitKey();

} );

function submitKey() {

	const key = keyInput.value.trim();
	if ( ! key ) return;
	localStorage.setItem( KEY_STORAGE, key );
	// full reload keeps init logic single-path
	window.location.reload();

}

function showKeyError( message ) {

	keyModal.classList.remove( 'hidden' );
	keyError.textContent = message;
	keyError.classList.remove( 'hidden' );

}

document.getElementById( 'change-key' ).addEventListener( 'click', () => {

	localStorage.removeItem( KEY_STORAGE );
	keyModal.classList.remove( 'hidden' );

} );

// ---------------------------------------------------------------------------
// Scene setup
// ---------------------------------------------------------------------------

function init( apiKey ) {

	// Reversed-Z depth: the rolled cylinder puts city geometry ~10 km overhead
	// behind skate mode's 0.4 m near plane; standard depth precision degrades
	// to metres out there and z-fights. Falls back gracefully without
	// EXT_clip_control.
	renderer = new WebGLRenderer( { antialias: true, reversedDepthBuffer: true } );
	renderer.setPixelRatio( Math.min( window.devicePixelRatio, 2 ) );
	renderer.setSize( window.innerWidth, window.innerHeight );
	document.body.appendChild( renderer.domElement );

	camera = new PerspectiveCamera( 55, window.innerWidth / window.innerHeight, 5, 400000 );
	camera.position.set( 0, 4000, 8000 );

	scene = new Scene();
	const space = new Color( 0x030509 ); // the habitat hangs in open space
	scene.background = space;
	scene.fog = new Fog( space, 30000, 220000 );

	// tiles are unlit (baked photogrammetry); this only shades the skateboard
	scene.add( new HemisphereLight( 0xffffff, 0x3a4656, 2.2 ) );

	const dracoLoader = new DRACOLoader();
	dracoLoader.setDecoderPath( 'https://www.gstatic.com/draco/versioned/decoders/1.5.7/' );

	tiles = new TilesRenderer();
	tiles.registerPlugin( new GoogleCloudAuthPlugin( { apiToken: apiKey, autoRefreshToken: true } ) );
	tiles.registerPlugin( new GLTFExtensionsPlugin( { dracoLoader } ) );
	tiles.registerPlugin( new TileCompressionPlugin() );
	tiles.registerPlugin( new UpdateOnChangePlugin() );
	tiles.registerPlugin( new ReorientationPlugin( {
		lat: ORIGIN.lat * MathUtils.DEG2RAD,
		lon: ORIGIN.lon * MathUtils.DEG2RAD,
	} ) );
	tiles.registerPlugin( createPlayRegionPlugin() ); // never load tiles outside the play area
	tiles.registerPlugin( rollLOD ); // rolled-space LOD so the curled wall isn't horizon-grade

	tiles.setCamera( camera );
	tiles.setResolutionFromRenderer( camera, renderer );
	scene.add( tiles.group );

	tiles.addEventListener( 'load-model', ( { scene: tileScene } ) => {

		tileScene.traverse( ( child ) => {

			if ( child.isMesh && child.material ) {

				patchMaterial( child.material );
				child.material.wireframe = state.wireframe;

			}

		} );

		// tiles streamed in while riding, aiming, or fine-voxelizing need
		// raycast acceleration
		if ( groundMode() || ( targeter && targeter.active ) || ( voxels && voxels.needsBVH() ) ) ensureBVH( tileScene );

	} );

	tiles.addEventListener( 'load-root-tileset', () => {

		state.rootLoaded = true;
		keyModal.classList.add( 'hidden' );
		document.getElementById( 'drop-bar' ).classList.remove( 'hidden' );
		playArea.configure( latLonToLocal );
		minimap.configureExtent( playArea );
		roll.configure( playArea );
		roll.scrub( 1 ); // the Bay is an O'Neill cylinder by default
		roll.update( 0 ); // push curvature into the uniforms before framing
		scene.add( createHullMesh( playArea, AREA.groundY ) ); // opaque shell for god view
		stars = new StarField( playArea, roll.radius, AREA.groundY );
		scene.add( stars.group );
		if ( ! WATER_DISABLED ) water.start(); // fetches coverage, then floods the segmented sea

		// ?roll=0..1 overrides the curl amount (handy for comparisons)
		const rollParam = parseFloat( new URLSearchParams( location.search ).get( 'roll' ) );
		if ( ! isNaN( rollParam ) ) {

			roll.scrub( rollParam );
			roll.update( 0 );

		}

		updateRollButton();
		jumpTo( LOCATIONS[ 0 ] ); // rolled-aware: opens on the area's home preset

	} );

	tiles.addEventListener( 'load-error', ( { error } ) => {

		if ( ! state.rootLoaded ) {

			console.error( error );
			showKeyError(
				'Could not load tiles — check that the key is valid and the "Map Tiles API" is enabled for its project.'
			);

		}

	} );

	controls = new EnvironmentControls( scene, camera, renderer.domElement );
	controls.enableDamping = true;
	controls.minDistance = 30;
	controls.maxDistance = 80000;
	controls.cameraRadius = 8;

	minimap = new Minimap( {
		renderer,
		apiKey,
		dracoLoader,
		latRad: ORIGIN.lat * MathUtils.DEG2RAD,
		lonRad: ORIGIN.lon * MathUtils.DEG2RAD,
		container: document.getElementById( 'minimap' ),
		marker: document.getElementById( 'minimap-marker' ),
		onPick: ( point ) => flyToPoint( point ),
	} );

	park = new SkatePark( { scene } );

	const audio = new SkateAudio(); // one engine shared by every ground mode
	const hud = {
		root: document.getElementById( 'hud' ),
		speed: document.getElementById( 'hud-speed' ),
		state: document.getElementById( 'hud-state' ),
		hint: document.getElementById( 'hud-hint' ),
		balanceWrap: document.getElementById( 'balance-wrap' ),
		balanceDot: document.getElementById( 'balance-dot' ),
	};

	// water interface for the modes — inert until the water layer is live
	const sea = {
		level: () => ( water && water.active ? water.seaY : null ),
		surfaceAt: ( x, z ) => water.surfaceAt( x, z ),
		isWater: ( x, z ) => segments && segments.ready && segments.classify( x, z ) === 'water',
	};

	skate = new SkateMode( {
		scene,
		camera,
		playArea,
		park,
		sea,
		audio,
		hud,
		tilesGroup: tiles.group,
		onExit: onModeExit,
	} );

	walker = new PedestrianMode( {
		scene,
		camera,
		playArea,
		park,
		audio,
		hud,
		tilesGroup: tiles.group,
		onExit: onModeExit,
	} );

	pigeon = new PigeonMode( {
		scene,
		camera,
		playArea,
		park,
		sea,
		audio,
		hud,
		tilesGroup: tiles.group,
		onExit: onModeExit,
	} );

	targeter = new DropTargeter( {
		scene,
		camera,
		tilesGroup: tiles.group,
		domElement: renderer.domElement,
		roll,
		// sailboats only drop on water — the marker shows red elsewhere and
		// the aiming hint says why a click would be refused
		validate: ( point ) => {

			const ok = dropAs !== 'sail' || sail.isWaterPoint( point );
			setTargetHint( ok ? null : 'sailboats need open water — aim at the Bay' );
			return ok;

		},
		onSelect: ( point ) => {

			setDropButtonState( false );
			enterModeAt( point );

		},
		onCancel: () => setDropButtonState( false ),
	} );

	detail = new DetailOverlay( {
		scene,
		tilesGroup: tiles.group,
		latLonToLocal,
		localToLatLon,
	} );

	segments = new Segmentation( { playArea } );
	voxels = new VoxelWorld( { scene, tilesGroup: tiles.group, segments, playArea } );
	water = new WaterLayer( { scene, playArea, segments, tilesGroup: tiles.group } );

	sail = new SailboatMode( {
		scene,
		camera,
		playArea,
		sea,
		segments,
		audio,
		hud,
		tilesGroup: tiles.group,
		onExit: onModeExit,
	} );

	// Creature visuals curl with the cylinder in the shader, like the tiles.
	// Their flat-space bounds would be culled wrongly against the rolled
	// camera, so culling is off for these small always-near meshes.
	for ( const root of [ skate.board, skate.shadow, walker.body, walker.shadow, pigeon.body, pigeon.shadow, sail.body, sail.wake.group ] ) {

		root.traverse( ( child ) => {

			child.frustumCulled = false;
			if ( child.isMesh && child.material ) patchRollOnly( child.material );

		} );

	}

	bindUI();
	window.addEventListener( 'resize', onResize );

	renderer.setAnimationLoop( animate );
	setInterval( updateAttributions, 2000 );

}

function onResize() {

	camera.aspect = window.innerWidth / window.innerHeight;
	camera.updateProjectionMatrix();
	renderer.setSize( window.innerWidth, window.innerHeight );
	tiles.setResolutionFromRenderer( camera, renderer );

}

// ---------------------------------------------------------------------------
// Geo helpers + camera flights
// ---------------------------------------------------------------------------

const _geoPos = new Vector3();

// Valid only after the root tileset loads (ReorientationPlugin sets the frame).
function latLonToLocal( latDeg, lonDeg, height, target ) {

	WGS84_ELLIPSOID.getCartographicToPosition(
		latDeg * MathUtils.DEG2RAD,
		lonDeg * MathUtils.DEG2RAD,
		height,
		target
	);
	tiles.group.updateMatrixWorld();
	return target.applyMatrix4( tiles.group.matrixWorld );

}

const _invGroupMat = new Matrix4();
const _cart = {};

function localToLatLon( pos ) {

	_invGroupMat.copy( tiles.group.matrixWorld ).invert();
	_geoPos.copy( pos ).applyMatrix4( _invGroupMat );
	WGS84_ELLIPSOID.getPositionToCartographic( _geoPos, _cart );
	return { lat: _cart.lat * MathUtils.RAD2DEG, lon: _cart.lon * MathUtils.RAD2DEG };

}

function viewForLocation( loc ) {

	const camGeo = cameraGeoForLocation( loc );
	const camPos = latLonToLocal( camGeo.lat, camGeo.lon, camGeo.height, new Vector3() );
	const target = latLonToLocal( loc.lat, loc.lon, loc.height, _geoPos ).clone();
	return { camPos, target };

}

function jumpTo( loc ) {

	const { camPos, target } = viewForLocation( loc );
	distortionUniforms.uCenter.value.set( target.x, 0, target.z ); // flat space
	roll.pointToRolled( camPos ); // frame the curled city, not its flat ghost
	roll.pointToRolled( target );
	camera.position.copy( camPos );
	state.lookTarget.copy( target );
	camera.lookAt( target );

}

// Home: snap straight back to the area's postcard view.
function goHome() {

	if ( ! state.rootLoaded || state.flying || groundMode() ) return;
	jumpTo( LOCATIONS[ 0 ] );

}

// Point on the ground the camera is currently looking at — the stored
// lookTarget goes stale as soon as the user drags the controls.
function currentViewTarget( out ) {

	camera.getWorldDirection( _dir );
	let t = _dir.y < - 0.05 ? - camera.position.y / _dir.y : 3000;
	t = Math.min( t, 30000 );
	return out.copy( camera.position ).addScaledVector( _dir, t );

}

function flyTo( loc ) {

	if ( ! state.rootLoaded ) return;
	const { camPos, target } = viewForLocation( loc );
	flyToView( camPos, target );

}

// Fly to a ground point picked on the minimap, keeping the camera's current
// offset (height and viewing angle) relative to what it was looking at.
function flyToPoint( point ) {

	if ( ! state.rootLoaded ) return;
	const offset = camera.position.clone().sub( currentViewTarget( new Vector3() ) );
	flyToView( point.clone().add( offset ), point.clone() );

}

// ---------------------------------------------------------------------------
// Skate mode
// ---------------------------------------------------------------------------

// the active embodied mode (skate, pedestrian, pigeon, or sailboat), or null
// when flying the free map camera
function groundMode() {

	if ( skate && skate.active ) return skate;
	if ( walker && walker.active ) return walker;
	if ( pigeon && pigeon.active ) return pigeon;
	if ( sail && sail.active ) return sail;
	return null;

}

const DROP_LABELS = { skate: 'Skate', pigeon: 'Pigeon', sail: 'Sail' };

function setDropButtonState( targeting ) {

	for ( const m in DROP_LABELS ) {

		const btn = document.getElementById( `drop-${ m }` );
		const on = targeting && m === dropAs;
		btn.classList.toggle( 'targeting', on );
		btn.textContent = on ? 'Cancel' : DROP_LABELS[ m ];

	}

	document.getElementById( 'target-hint' ).classList.toggle( 'hidden', ! targeting );
	if ( targeting ) setTargetHint( null );

}

const TARGET_HINT_DEFAULT = 'click a spot to drop in  ·  drag to look around  ·  Esc to cancel';

// swaps the aiming hint (e.g. when the sail marker is over dry land)
function setTargetHint( text ) {

	const el = document.getElementById( 'target-hint' );
	const next = text || TARGET_HINT_DEFAULT;
	if ( el.textContent !== next ) el.textContent = next;

}

function toggleDropTargeting( as ) {

	if ( ! state.rootLoaded || groundMode() ) return;

	if ( targeter.active ) {

		if ( dropAs === as ) {

			targeter.cancel(); // resets the buttons via onCancel

		} else {

			dropAs = as; // re-aim the pending drop at the other mode
			if ( as === 'sail' ) segments.ensureData(); // boats need the water map
			setDropButtonState( true );

		}

		return;

	}

	dropAs = as;
	// boats need the water coverage map — start it loading while the user aims
	if ( as === 'sail' ) segments.ensureData();
	ensureBVH( tiles.group ); // one-time raycast prep for the loaded tiles
	targeter.begin();
	setDropButtonState( true );

}

function enterModeAt( point ) {

	if ( ! state.rootLoaded || state.flying || groundMode() ) return;

	controls.enabled = false;
	document.getElementById( 'drop-bar' ).classList.add( 'hidden' );

	playArea.constrain( point, null, 30 );
	camera.getWorldDirection( _dir ); // face the way the camera was looking
	if ( dropAs === 'pigeon' ) pigeon.enter( point, _dir );
	else if ( dropAs === 'sail' ) sail.enter( point, _dir );
	else skate.enter( point, _dir ); // the modes never mix — Esc to switch
	detail.setActive( state.upscale );
	updateUpscaleStatus();

}

// E: hop off the board / back on, in place — momentum and camera carry over.
// Pigeons don't skateboard; the bird only exits via Esc.
function toggleBoard() {

	const cur = groundMode();
	if ( ! cur || cur === pigeon || ! cur.onGround || cur.grinding ) return;

	const point = cur.pos.clone();
	const vel = cur.vel.clone();
	_dir.set( Math.sin( cur.yaw ), 0, Math.cos( cur.yaw ) );
	cur.exit( true ); // silent: no camera flyout, controls stay disabled

	const next = cur === skate ? walker : skate;
	next.enter( point, _dir, { vel, snapCamera: false } );
	next.audio.step( true ); // the hop on / off

}

function setUpscale( on ) {

	state.upscale = on;
	localStorage.setItem( 'ring_upscale', on ? '1' : '0' );
	document.getElementById( 'upscale' ).checked = on;
	if ( groundMode() ) detail.setActive( on );
	updateUpscaleStatus();

}

function updateUpscaleStatus() {

	const el = document.getElementById( 'upscale-status' );
	if ( ! groundMode() ) el.textContent = state.upscale ? 'active on the ground' : '';
	else el.textContent = state.upscale ? detail.status : 'off';

}

const _spawnPt = new Vector3();

// Drop a prop on the ground ahead of the rider, aligned with their heading.
function spawnProp( type ) {

	const mode = groundMode();
	if ( ! mode || ! mode.groundPointAhead ) return; // not from the air

	const dist = type === 'ramp' ? 14 : 8;
	const point = mode.groundPointAhead( dist, _spawnPt );
	if ( ! point ) return;

	if ( type === 'ramp' ) park.spawnRamp( point, mode.yaw );
	else park.spawnRail( point, mode.yaw );

}

function onModeExit( finalPos, forward ) {

	detail.setActive( false );
	updateUpscaleStatus();
	controls.enabled = true;
	document.getElementById( 'drop-bar' ).classList.remove( 'hidden' );

	camera.position.copy( finalPos ).addScaledVector( forward, - 320 ).add( new Vector3( 0, 260, 0 ) );
	state.lookTarget.copy( finalPos );
	camera.lookAt( finalPos );

}

function flyToView( camPos, target ) {

	if ( state.flying || groundMode() ) return;

	const startPos = camera.position.clone();
	const startTarget = currentViewTarget( new Vector3() );
	const travel = startPos.distanceTo( camPos );
	const arc = Math.min( travel * 0.3, 12000 );
	const duration = MathUtils.clamp( 0.8 + travel / 20000, 1.2, 3.5 );

	state.flying = true;
	controls.enabled = false;
	const start = performance.now();

	function step() {

		const t = Math.min( ( performance.now() - start ) / ( duration * 1000 ), 1 );
		const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow( - 2 * t + 2, 3 ) / 2; // easeInOutCubic

		camera.position.lerpVectors( startPos, camPos, e );
		camera.position.y += Math.sin( Math.PI * e ) * arc;
		state.lookTarget.lerpVectors( startTarget, target, e );
		camera.lookAt( state.lookTarget );

		if ( t < 1 ) {

			requestAnimationFrame( step );

		} else {

			state.flying = false;
			controls.enabled = true;

		}

	}

	step();

}

// ---------------------------------------------------------------------------
// Render loop
// ---------------------------------------------------------------------------

const _dir = new Vector3();
const _center = new Vector3();
const _voxFocus = new Vector3();

function updateSurfaceHUD( mode ) {

	const el = document.getElementById( 'hud-surface' );
	if ( ! mode ) {

		el.textContent = '';
		return;

	}

	const cls = segments.classify( mode.pos.x, mode.pos.z );
	el.textContent = cls === 'other' ? '' : cls;
	el.dataset.cls = cls;

}

function updateDistortionCenter() {

	camera.getWorldDirection( _dir );
	let t = _dir.y < - 0.05 ? - camera.position.y / _dir.y : 4000;
	t = Math.min( t, 30000 );
	_center.copy( camera.position ).addScaledVector( _dir, t );
	_center.y = 0;
	distortionUniforms.uCenter.value.lerp( _center, 0.06 );

}

function animate() {

	const dt = Math.min( clock.getDelta(), 0.1 );
	distortionUniforms.uTime.value += dt * state.timeSpeed;

	// sea level is the cylinder shell radius reference once it's calibrated
	roll.setGround( water && water.seaY !== null ? water.seaY : AREA.groundY );
	roll.update( dt ); // also advances the habitat spin; the stars stay fixed
	syncRollUI();

	const mode = groundMode();
	if ( mode ) {

		mode.update( dt );
		if ( state.upscale ) detail.update( mode.pos );

	} else if ( controls.enabled ) {

		controls.update();
		playArea.constrain( camera.position ); // no free-flying outside the play area

	}

	camera.updateMatrixWorld();
	rollLOD.setView( camera, !! mode ); // rolled render pose drives tile detail

	// UpdateOnChangePlugin only reacts to camera motion — while the roll
	// animates or the habitat spins, the effective view changes with the
	// camera still, so poke it (spin throttled to ~0.5° steps)
	if ( roll.k !== _lastRollK || Math.abs( roll.spinAngle - _lastSpin ) > 0.0087 ) {

		_lastRollK = roll.k;
		_lastSpin = roll.spinAngle;
		tiles.dispatchEvent( { type: 'needs-update' } );

	}

	tiles.update();

	if ( ! state.flying ) updateDistortionCenter();

	// mute the photogrammetry inside the active upscale zone
	if ( mode && state.upscale && detail.hasZone ) {

		distortionUniforms.uZoneCenter.value.copy( detail.zoneCenter );
		distortionUniforms.uZoneRadius.value = detail.zoneRadius;

	} else {

		distortionUniforms.uZoneRadius.value = 0;

	}

	if ( segments.enabled ) updateSurfaceHUD( mode );

	// voxel builds and water waves both track the player or map view target
	const focus = mode ? mode.pos : currentViewTarget( _voxFocus );
	voxels.update( focus );
	water.update( focus );

	targeter.update( dt );
	updateProgress();
	updateRolledCulling();

	// Embodied modes simulate in flat space; rendering their camera through
	// the roll turns flat -Y gravity into the habitat's outward spin gravity.
	const camRolled = mode && roll.k > 0;
	if ( camRolled ) {

		_camFlatPos.copy( camera.position );
		_camFlatQuat.copy( camera.quaternion );
		roll.poseToRolled( camera.position, camera.quaternion );
		camera.updateMatrixWorld();

	}

	renderer.render( scene, camera );

	if ( camRolled ) {

		camera.position.copy( _camFlatPos );
		camera.quaternion.copy( _camFlatQuat );
		camera.updateMatrixWorld();

	}

	// minimap is hidden with the rest of the UI — skip its render work

}

const _camFlatPos = new Vector3();
const _camFlatQuat = new Quaternion();
let _cullingOff = false;
let _lastRollK = 0;
let _lastSpin = 0;

// Frustum culling tests flat-space bounds, which lie about where rolled
// meshes render. Re-checked every frame while curled so tiles and voxel
// chunks that stream in stay uncullable; restored once when flat again.
function updateRolledCulling() {

	const rolled = roll.u > 0;
	if ( ! rolled && ! _cullingOff ) return;

	const groups = [ tiles.group, park.rideable, park.group ];
	if ( voxels.group ) groups.push( voxels.group );
	if ( voxels.fine && voxels.fine.group ) groups.push( voxels.fine.group );

	for ( const g of groups ) {

		g.traverse( ( child ) => {

			if ( child.isMesh ) child.frustumCulled = ! rolled;

		} );

	}

	_cullingOff = rolled;

}

// ---------------------------------------------------------------------------
// O'Neill cylinder controls
// ---------------------------------------------------------------------------

function updateRollButton() {

	const btn = document.getElementById( 'drop-roll' );
	const on = roll.target > 0.5;
	btn.textContent = on ? '🌐 Flatten' : '🛰 O’Neill';
	btn.classList.toggle( 'rolled', on );

}

let _rollShown = - 1;

// reflect the animated phase into the slider without touching the DOM idly
function syncRollUI() {

	if ( roll.u === _rollShown ) return;
	_rollShown = roll.u;
	document.getElementById( 'roll-slider' ).value = roll.u;

}

// ---------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------

function buildButtonGroup( containerId, items, onSelect, activeIndex = 0 ) {

	const container = document.getElementById( containerId );
	const buttons = items.map( ( item, i ) => {

		const btn = document.createElement( 'button' );
		btn.textContent = item.name;
		btn.addEventListener( 'click', () => {

			buttons.forEach( ( b ) => b.classList.remove( 'active' ) );
			btn.classList.add( 'active' );
			onSelect( item, i );

		} );
		container.appendChild( btn );
		return btn;

	} );

	if ( activeIndex >= 0 ) buttons[ activeIndex ].classList.add( 'active' );
	return buttons;

}

// One slider per PHYSICS property, live-updating the simulation while riding.
function buildPhysicsControls() {

	const container = document.getElementById( 'physics-controls' );
	const defaults = { ...PHYSICS };
	const rows = [];

	for ( const [ key, label, min, max, step ] of PHYSICS_CONTROLS ) {

		const row = document.createElement( 'label' );
		row.className = 'slider-row';

		const name = document.createElement( 'span' );
		name.textContent = label;

		const input = document.createElement( 'input' );
		input.type = 'range';
		input.min = min;
		input.max = max;
		input.step = step;
		input.value = PHYSICS[ key ];

		const val = document.createElement( 'span' );
		val.className = 'slider-val';
		const decimals = ( String( step ).split( '.' )[ 1 ] || '' ).length;
		const show = () => ( val.textContent = PHYSICS[ key ].toFixed( decimals ) );
		show();

		input.addEventListener( 'input', () => {

			PHYSICS[ key ] = parseFloat( input.value );
			show();

		} );
		// release focus so WASD isn't swallowed by the slider while skating
		input.addEventListener( 'change', () => input.blur() );

		row.append( name, input, val );
		container.appendChild( row );
		rows.push( { key, input, show } );

	}

	document.getElementById( 'physics-reset' ).addEventListener( 'click', ( e ) => {

		for ( const { key, input, show } of rows ) {

			PHYSICS[ key ] = defaults[ key ];
			input.value = defaults[ key ];
			show();

		}
		e.target.blur();

	} );

}

function bindUI() {

	bindAreaMenu();

	for ( const m of [ 'skate', 'pigeon', 'sail' ] ) {

		document.getElementById( `drop-${ m }` ).addEventListener( 'click', ( e ) => {

			toggleDropTargeting( m );
			e.target.blur();

		} );

	}

	document.getElementById( 'drop-home' ).addEventListener( 'click', ( e ) => {

		goHome();
		e.target.blur();

	} );

	const pauseBtn = document.getElementById( 'drop-pause' );
	pauseBtn.addEventListener( 'click', ( e ) => {

		roll.spinPaused = ! roll.spinPaused;
		// ︎ keeps the play glyph text-styled instead of emoji-styled
		pauseBtn.textContent = roll.spinPaused ? '▶︎' : '❚❚';
		pauseBtn.title = roll.spinPaused ? 'Resume rotation' : 'Pause rotation';
		e.target.blur();

	} );

	document.getElementById( 'drop-roll' ).addEventListener( 'click', ( e ) => {

		if ( ! state.rootLoaded || groundMode() ) return;
		roll.toggle();
		updateRollButton();
		e.target.blur();

	} );

	const rollSlider = document.getElementById( 'roll-slider' );
	rollSlider.addEventListener( 'input', ( e ) => {

		if ( ! state.rootLoaded ) return;
		roll.scrub( parseFloat( e.target.value ) );
		updateRollButton();

	} );
	rollSlider.addEventListener( 'change', ( e ) => e.target.blur() );

	const upscaleBox = document.getElementById( 'upscale' );
	upscaleBox.checked = state.upscale;
	upscaleBox.addEventListener( 'change', ( e ) => setUpscale( e.target.checked ) );
	window.addEventListener( 'keydown', ( e ) => {

		if ( ! groundMode() || ( e.target && e.target.tagName === 'INPUT' ) ) return;

		if ( e.code === 'KeyU' ) setUpscale( ! state.upscale );
		if ( e.code === 'KeyE' ) toggleBoard();
		if ( e.code === 'Digit1' ) spawnProp( 'ramp' );
		if ( e.code === 'Digit2' ) spawnProp( 'rail' );

	} );

	for ( const [ id, fn ] of [
		[ 'spawn-ramp', () => spawnProp( 'ramp' ) ],
		[ 'spawn-rail', () => spawnProp( 'rail' ) ],
		[ 'clear-park', () => park.clear() ],
	] ) {

		document.getElementById( id ).addEventListener( 'click', ( e ) => {

			fn();
			e.target.blur();

		} );

	}
	updateUpscaleStatus();
	setInterval( updateUpscaleStatus, 1000 );

	const segBox = document.getElementById( 'segment' );
	segBox.addEventListener( 'change', ( e ) => {

		segments.setActive( e.target.checked );
		if ( ! e.target.checked ) document.getElementById( 'hud-surface' ).textContent = '';

	} );
	setInterval( () => {

		document.getElementById( 'segment-status' ).textContent =
			segments.enabled ? segments.status : '';
		document.getElementById( 'voxel-status' ).textContent =
			voxels.enabled ? voxels.status : '';

	}, 1000 );

	document.getElementById( 'voxel' ).addEventListener( 'change', ( e ) => {

		if ( e.target.checked ) ensureBVH( tiles.group ); // height sampling needs it
		voxels.setActive( e.target.checked );

	} );

	const voxelSize = document.getElementById( 'voxel-size' );
	voxelSize.addEventListener( 'input', ( e ) => {

		document.getElementById( 'voxel-size-val' ).textContent = e.target.value;

	} );
	voxelSize.addEventListener( 'change', ( e ) => {

		const size = parseInt( e.target.value, 10 );
		if ( size < 8 && voxels.enabled ) ensureBVH( tiles.group ); // fine patch raycasts
		voxels.setSize( size ); // rebuild on release
		e.target.blur();

	} );

	buildPhysicsControls();

	buildButtonGroup( 'locations', LOCATIONS, ( loc ) => flyTo( loc ) );
	buildButtonGroup( 'effects', EFFECTS, ( fx ) => {

		distortionUniforms.uEffect.value = fx.id;

	} );
	buildButtonGroup( 'colors', COLOR_MODES, ( mode ) => {

		distortionUniforms.uColorMode.value = mode.id;

	} );

	document.getElementById( 'strength' ).addEventListener( 'input', ( e ) => {

		distortionUniforms.uStrength.value = parseFloat( e.target.value );

	} );

	document.getElementById( 'radius' ).addEventListener( 'input', ( e ) => {

		distortionUniforms.uRadius.value = parseFloat( e.target.value );

	} );

	document.getElementById( 'speed' ).addEventListener( 'input', ( e ) => {

		state.timeSpeed = parseFloat( e.target.value );

	} );

	document.getElementById( 'wireframe' ).addEventListener( 'change', ( e ) => {

		state.wireframe = e.target.checked;
		tiles.group.traverse( ( child ) => {

			if ( child.isMesh && child.material ) child.material.wireframe = state.wireframe;

		} );

	} );

}

// Area menu: stamp the shared play footprint onto another patch of the globe.
// Selecting stores the area id and reloads — init stays single-path.
function bindAreaMenu() {

	const btn = document.getElementById( 'drop-area' );
	const menu = document.getElementById( 'area-menu' );
	btn.textContent = `${ AREA.name } ▾`;

	for ( const area of AREAS ) {

		const item = document.createElement( 'button' );
		item.textContent = area.name;
		item.classList.toggle( 'active', area.id === AREA.id );
		item.addEventListener( 'click', () => selectArea( area.id ) );
		menu.appendChild( item );

	}

	btn.addEventListener( 'click', ( e ) => {

		menu.classList.toggle( 'hidden' );
		e.target.blur();

	} );

	// clicking anywhere else closes the menu
	window.addEventListener( 'pointerdown', ( e ) => {

		if ( e.target !== btn && ! menu.contains( e.target ) ) menu.classList.add( 'hidden' );

	} );

}

// ---------------------------------------------------------------------------
// Chrome: progress bar + Google attribution (required by TOS)
// ---------------------------------------------------------------------------

const progressBar = document.getElementById( 'progress' );

function updateProgress() {

	const p = tiles.loadProgress;
	if ( typeof p === 'number' ) {

		progressBar.style.width = `${ p * 100 }%`;
		progressBar.style.opacity = p >= 1 ? '0' : '1';

	}

}

function updateAttributions() {

	if ( ! tiles || ! tiles.getAttributions ) return;
	const parts = tiles.getAttributions( [] ).map( ( a ) => a.value );
	if ( detail && detail.enabled ) parts.push( detail.attribution );
	if ( segments && ( segments.enabled || segments.ready ) ) parts.push( 'OpenFreeMap © OpenMapTiles · Data © OpenStreetMap contributors' );
	document.getElementById( 'attributions' ).textContent = parts.join( ' · ' );

}
