// Headless exercise of the bail triggers: sudden-decel ragdoll, braking
// immunity, short-ollie safety, and long-freefall drift with steered,
// unsteered-close, and unrecoverable outcomes. Run: node scripts/test-bail.mjs

globalThis.window = { addEventListener() {} };
globalThis.document = { activeElement: null };

const { Vector3, Group, PerspectiveCamera } = await import( 'three' );
const { SkateMode } = await import( '../src/skate.js' );

const noop = () => {};
const audio = {
	start: noop, stop: noop, jump: noop, land: noop, splash: noop,
	grindStart: noop, stroke: noop, setUnderwater: noop, update: noop,
};
const cls = () => ( { classList: { add: noop, remove: noop, toggle: noop } } );
const hud = {
	root: cls(), hint: { textContent: '' }, speed: { textContent: '' },
	state: { textContent: '' }, balanceWrap: cls(),
	balanceDot: { style: {}, classList: { toggle: noop } },
};
const scene = { add: noop, remove: noop, attach: noop, fog: { near: 0, far: 0 } };

const mode = new SkateMode( {
	scene,
	camera: new PerspectiveCamera(),
	tilesGroup: new Group(),
	playArea: null, park: null, sea: null,
	hud, audio,
	onExit: noop,
} );

// flat ground at y = 0 everywhere
mode._groundHit = ( x, y, z ) => ( {
	point: new Vector3( x, 0, z ),
	worldNormal: new Vector3( 0, 1, 0 ),
} );

mode.enter( new Vector3( 0, 5, 0 ), new Vector3( 0, 0, 1 ) );

const DT = 1 / 60;
const run = ( frames, each ) => {

	for ( let i = 0; i < frames; i ++ ) {

		mode.update( DT );
		if ( each && each( i ) ) return;

	}

};
let pass = 0, fail = 0;
const check = ( label, ok ) => {

	console.log( `${ ok ? 'PASS' : 'FAIL' }  ${ label }` );
	ok ? pass ++ : fail ++;

};
const reset = () => {

	mode.respawn();
	mode.update( DT );

};

// A) cruising steadily never bails
mode.vel.set( 0, 0, 12 );
run( 60 );
check( 'steady cruise stays on', ! mode.bail && Math.hypot( mode.vel.x, mode.vel.z ) > 10 );

// B) instant wall-style stop rips the rider off
mode.vel.set( 0, 0, 0.5 );
run( 3 );
check( 'sudden stop ragdolls', mode.bail && mode.bail.phase === 'ragdoll' );
reset();

// C) hard braking from speed is safe
mode.vel.set( 0, 0, 14 );
mode.keys.add( 'KeyS' );
run( 240 );
mode.keys.delete( 'KeyS' );
check( 'braking to a halt stays on', ! mode.bail && mode.vel.length() < 1 );
reset();

// D) a flat-ground ollie never drifts or bails
mode.vel.set( 0, 0, 8 );
mode.vel.y = 5.5;
mode.onGround = false;
let drifted = false;
run( 120, () => { if ( mode.bail ) drifted = true; } );
check( 'short ollie lands clean', ! drifted && mode.onGround && ! mode.bail );
reset();

// E) a medium drop separates the board but lands back over the wheels
mode.pos.y = 8;
mode.onGround = false;
mode.vel.set( 0, 0, 6 );
let sawDrift = false;
run( 300, () => {

	if ( mode.bail && mode.bail.phase === 'drift' ) sawDrift = true;
	return ! mode.bail && sawDrift; // recovered

} );
check( 'medium drop enters drift', sawDrift );
check( 'lands over the wheels → recovers', sawDrift && ! mode.bail && mode.active );
reset();

// F) a huge drop drifts too far to recover → ragdoll (or run-out), never a silent stick
mode.pos.y = 80;
mode.onGround = false;
mode.vel.set( 0, 0, 6 );
let outcome = '';
run( 1200, () => {

	if ( mode.bail && mode.bail.phase === 'drift' ) outcome = outcome || 'drift';
	if ( mode.bail && mode.bail.phase === 'ragdoll' ) { outcome = 'ragdoll'; return true; }

} );
check( 'huge drop drifts then ragdolls', outcome === 'ragdoll' );
reset();

// G) same huge drop, but steering toward the board all the way down → recover.
// Facing +Z, A accelerates the falling body toward +X and D toward −X.
mode.pos.y = 80;
mode.onGround = false;
mode.vel.set( 0, 0, 6 );
let steered = false;
run( 1200, () => {

	if ( mode.bail && mode.bail.phase === 'drift' ) {

		steered = true;
		mode.keys.delete( 'KeyA' );
		mode.keys.delete( 'KeyD' );
		mode.keys.delete( 'KeyW' );
		mode.keys.delete( 'KeyS' );
		mode.keys.add( mode.pos.x > mode.bail.pos.x ? 'KeyA' : 'KeyD' );
		mode.keys.add( mode.pos.z > mode.bail.pos.z ? 'KeyW' : 'KeyS' );

	}

	return steered && ! mode.bail;

} );
check( 'steering the fall recovers the huge drop', steered && ! mode.bail && mode.active );

console.log( `\n${ pass } passed, ${ fail } failed` );
process.exit( fail ? 1 : 0 );
