import {
	Vector2,
	Vector3,
	Color,
	Mesh,
	PlaneGeometry,
	ShaderMaterial,
	Raycaster,
	DoubleSide,
} from 'three';
import { distortionUniforms, ROLL_GLSL } from './effects.js';
import { currentArea } from './areas.js';

// Transparent water surface over everything the coverage map segments as
// water. The photogrammetry beneath is sunk into a basin by the tile shader
// (ringWaterDrop in effects.js); this layer floats at true sea level with
// animated swells that undulate around the player and fade with distance.
// Two meshes share the shader: a dense patch that follows the focus (carries
// the waves) and a coarse far plane with a hole cut under the patch.

const PATCH_SIZE = 1200;   // metres — the dense, wave-animated region
const PATCH_SEGS = 220;
const WAVE_RADIUS = 260;   // falloff distance of the player swells
const SEA_LIFT = 0.25;     // surface sits just above the (sunken) mesh water

const VERT = /* glsl */ `
${ ROLL_GLSL }
uniform float uTime;
uniform vec2 uFocus;
uniform sampler2D uSegTex;
uniform vec2 uSegCenter;
uniform vec2 uSegEast;
uniform vec2 uSegNorth;
uniform vec2 uSegHalf;
varying vec3 vWorld;
varying vec2 vFlatXZ; // pre-roll position for flat-map tests (far-plane hole)
varying float vWater;

float waterMask( vec2 xz ) {

	vec2 rel = xz - uSegCenter;
	vec2 uv = vec2( dot( rel, uSegEast ) / uSegHalf.x, dot( rel, uSegNorth ) / uSegHalf.y ) * 0.5 + 0.5;
	if ( uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0 ) return 0.0;
	vec4 seg = texture2D( uSegTex, uv );
	return seg.a * smoothstep( 0.75, 0.9, seg.b ) * ( 1.0 - smoothstep( 0.35, 0.5, seg.r ) );

}

float waveHeight( vec2 xz, float t ) {

	return sin( dot( xz, vec2( 0.060, 0.087 ) ) + t * 1.4 ) * 0.50 +
		sin( dot( xz, vec2( - 0.110, 0.045 ) ) + t * 2.1 ) * 0.30 +
		sin( dot( xz, vec2( 0.024, - 0.031 ) ) + t * 0.8 ) * 0.20 +
		sin( dot( xz, vec2( 0.31, 0.23 ) ) + t * 2.8 ) * 0.08;

}

void main() {

	vec4 world = modelMatrix * vec4( position, 1.0 );

	float w = waterMask( world.xz );
	float d = distance( world.xz, uFocus );
	float amp = ( 0.55 * exp( - d / ${ WAVE_RADIUS.toFixed( 1 ) } ) + 0.05 ) * w;
	world.y += waveHeight( world.xz, uTime ) * amp;

	vFlatXZ = world.xz;
	world.xyz = ringRoll( world.xyz );

	vWorld = world.xyz;
	vWater = w;
	gl_Position = projectionMatrix * viewMatrix * world;

}
`;

const FRAG = /* glsl */ `
uniform vec3 uFogColor;
uniform float uFogNear;
uniform float uFogFar;
uniform vec2 uFocus;
uniform float uFarHole; // half-size of the square hole under the near patch
varying vec3 vWorld;
varying vec2 vFlatXZ;
varying float vWater;

void main() {

	if ( vWater < 0.35 ) discard;

	#ifdef FAR_PLANE
	vec2 fd = abs( vFlatXZ - uFocus );
	if ( max( fd.x, fd.y ) < uFarHole ) discard;
	#endif

	vec3 V = normalize( cameraPosition - vWorld );

	// per-pixel normal from the displaced surface
	vec3 N = normalize( vec3( - dFdx( vWorld.y ) * 8.0, 1.0, - dFdy( vWorld.y ) * 8.0 ) );

	float fres = pow( 1.0 - max( V.y, 0.0 ), 2.0 );
	vec3 deep = vec3( 0.04, 0.20, 0.30 );
	vec3 sky = vec3( 0.56, 0.73, 0.86 );
	vec3 col = mix( deep, sky, fres * 0.75 );

	// sun sparkle off the wave normals
	vec3 sun = normalize( vec3( 0.45, 0.7, 0.35 ) );
	float spec = pow( max( dot( N, normalize( V + sun ) ), 0.0 ), 90.0 ) * 0.7;
	col += spec;

	float alpha = 0.55 + fres * 0.3;

	// match the scene fog so the horizon blends with the tiles
	float dist = distance( cameraPosition, vWorld );
	float fog = smoothstep( uFogNear, uFogFar, dist );
	col = mix( col, uFogColor, fog );

	gl_FragColor = vec4( col, alpha * ( 1.0 - fog * 0.6 ) );

}
`;

export class WaterLayer {

	constructor( { scene, playArea, segments, tilesGroup } ) {

		this.scene = scene;
		this.playArea = playArea;
		this.segments = segments;
		this.tilesGroup = tilesGroup;

		this.active = false;
		this.seaY = null;
		this._focus = new Vector2();

		this._raycaster = new Raycaster();
		this._raycaster.firstHitOnly = true;

		this._shared = {
			uTime: distortionUniforms.uTime,
			uSegTex: distortionUniforms.uSegTex,
			uSegCenter: distortionUniforms.uSegCenter,
			uSegEast: distortionUniforms.uSegEast,
			uSegNorth: distortionUniforms.uSegNorth,
			uSegHalf: distortionUniforms.uSegHalf,
			uFocus: { value: this._focus },
			uFarHole: { value: PATCH_SIZE / 2 - 4 },
			uRollK: distortionUniforms.uRollK,
			uRollCenter: distortionUniforms.uRollCenter,
			uRollEast: distortionUniforms.uRollEast,
			uRollGround: distortionUniforms.uRollGround,
			uRollSpin: distortionUniforms.uRollSpin,
			uRollRadius: distortionUniforms.uRollRadius,
			uFogColor: { value: new Color() },
			uFogNear: { value: 1 },
			uFogFar: { value: 2 },
		};

	}

	// fetch coverage data, calibrate sea level, then show the surface
	async start() {

		await this.segments.ensureData();
		if ( ! this.segments.ready || this.active ) return;

		this._calibrate();
		this._buildMeshes();
		this.active = true;
		distortionUniforms.uWaterOn.value = 1;

	}

	_calibrate( attempt = 0 ) {

		// the local origin sits mid-bay: one raycast measures sea level
		this._raycaster.ray.origin.set( 0, 1500, 0 );
		this._raycaster.ray.direction.set( 0, - 1, 0 );
		this._raycaster.far = 3000;
		const hit = this._raycaster.intersectObject( this.tilesGroup, true )[ 0 ];

		if ( hit ) {

			this.seaY = hit.point.y;

		} else {

			this.seaY = this.seaY === null ? currentArea().groundY : this.seaY;
			// mid-bay tile not streamed in yet — refine once it is
			if ( attempt < 8 ) setTimeout( () => this._calibrate( attempt + 1 ), 3000 );

		}

		distortionUniforms.uWaterY.value = this.seaY;
		const y = this.seaY + SEA_LIFT;
		if ( this.patch ) this.patch.position.y = y;
		if ( this.far ) this.far.position.y = y;

	}

	_material( farPlane ) {

		return new ShaderMaterial( {
			uniforms: this._shared,
			vertexShader: VERT,
			fragmentShader: FRAG,
			defines: farPlane ? { FAR_PLANE: 1 } : {},
			transparent: true,
			depthWrite: false,
			side: DoubleSide,
		} );

	}

	_buildMeshes() {

		const pa = this.playArea;
		const y = this.seaY + SEA_LIFT;

		// dense wave patch that follows the focus
		const patchGeo = new PlaneGeometry( PATCH_SIZE, PATCH_SIZE, PATCH_SEGS, PATCH_SEGS );
		patchGeo.rotateX( - Math.PI / 2 );
		this.patch = new Mesh( patchGeo, this._material( false ) );
		this.patch.position.y = y;
		this.patch.frustumCulled = false;

		// coarse plane for the rest of the bay — dense enough east–west that
		// the cylinder roll bends it smoothly (192-gon at full curl)
		const farGeo = new PlaneGeometry( pa.halfWidth * 2, pa.halfHeight * 2, 192, 64 );
		farGeo.rotateX( - Math.PI / 2 );
		this.far = new Mesh( farGeo, this._material( true ) );
		this.far.position.set( pa.center.x, y, pa.center.z );
		this.far.frustumCulled = false;

		this.scene.add( this.patch, this.far );

	}

	// JS mirror of the shader's waveHeight — floaters ride the same swells
	surfaceAt( x, z ) {

		const y = this.seaY + SEA_LIFT;
		if ( ! this.active ) return y;

		const t = distortionUniforms.uTime.value;
		const d = Math.hypot( x - this._focus.x, z - this._focus.y );
		const amp = 0.55 * Math.exp( - d / WAVE_RADIUS ) + 0.05;
		const h =
			Math.sin( x * 0.060 + z * 0.087 + t * 1.4 ) * 0.50 +
			Math.sin( x * - 0.110 + z * 0.045 + t * 2.1 ) * 0.30 +
			Math.sin( x * 0.024 + z * - 0.031 + t * 0.8 ) * 0.20 +
			Math.sin( x * 0.31 + z * 0.23 + t * 2.8 ) * 0.08;

		return y + h * amp;

	}

	update( focus ) {

		if ( ! this.active ) return;

		// snap the patch to its own grid so vertices never swim
		const step = PATCH_SIZE / PATCH_SEGS;
		this.patch.position.x = Math.round( focus.x / step ) * step;
		this.patch.position.z = Math.round( focus.z / step ) * step;
		this._focus.set( focus.x, focus.z );

		// track the active fog settings (modes swap them on enter/exit)
		const fog = this.scene.fog;
		this._shared.uFogColor.value.copy( fog.color );
		this._shared.uFogNear.value = fog.near;
		this._shared.uFogFar.value = fog.far;

	}

}
