import { Vector2, Vector3 } from 'three';

// Shared uniform objects — every patched tile material references these same
// instances, so updating them once per frame drives all shaders.
export const distortionUniforms = {
	uTime: { value: 0 },
	uEffect: { value: 0 },
	uStrength: { value: 0.5 },
	uRadius: { value: 3000 },
	uCenter: { value: new Vector3() },
	uColorMode: { value: 0 },
	// upscale zone: photogrammetry is muted inside so overlay models pop
	uZoneCenter: { value: new Vector3() },
	uZoneRadius: { value: 0 },
	// voxel world: photogrammetry is discarded inside this zone (see voxel.js)
	uVoxelCenter: { value: new Vector2() },
	uVoxelRadius: { value: 0 },
	// segmentation coverage texture spanning the play area (see segment.js)
	uSegTex: { value: null },
	uSegStrength: { value: 0 },
	uSegCenter: { value: new Vector2() },
	uSegEast: { value: new Vector2( 1, 0 ) },
	uSegNorth: { value: new Vector2( 0, 1 ) },
	uSegHalf: { value: new Vector2( 1, 1 ) },
	// water: sea-classified ground sinks to a basin under the surface layer
	uWaterOn: { value: 0 },
	uWaterY: { value: 0 },
	// O'Neill cylinder roll (see roll.js): curvature + play-area frame
	uRollK: { value: 0 },
	uRollCenter: { value: new Vector2() },
	uRollEast: { value: new Vector2( 1, 0 ) },
	uRollGround: { value: 0 },
	// habitat spin: rigid rotation about the hub axis, applied after the roll
	uRollSpin: { value: 0 },
	uRollRadius: { value: 0 },
};

// Bends world space into a cylinder about the north–south axis: an isometric
// sheet-roll with uniform curvature uRollK, so east–west arc length is
// preserved and at full curvature (π / halfWidth) the map edges meet overhead.
// sin(θ)/k and (1−cosθ)/k are written as e·sinc(θ) and e·(1−cosθ)/θ so the
// transform stays finite and float-stable as k → 0. Shared by the tile
// shader, the water layer, and the roll-only patch for voxels/props.
export const ROLL_GLSL = /* glsl */ `
uniform float uRollK;
uniform vec2 uRollCenter;
uniform vec2 uRollEast;
uniform float uRollGround;
uniform float uRollSpin;
uniform float uRollRadius;

vec3 ringRoll( vec3 p ) {

	if ( uRollK <= 0.0 ) return p;

	vec2 northDir = vec2( - uRollEast.y, uRollEast.x );
	vec2 rel = p.xz - uRollCenter;
	float e = dot( rel, uRollEast );
	float n = dot( rel, northDir );
	float h = p.y - uRollGround;
	float th = e * uRollK;

	float s = sin( th );
	float c = cos( th );
	float sinc = abs( th ) < 1e-3 ? 1.0 - th * th / 6.0 : s / th;
	float vers = abs( th ) < 1e-3 ? 0.5 * th : ( 1.0 - c ) / th;

	float eArc = e * sinc - h * s;
	p.y = uRollGround + e * vers + h * c;
	p.xz = uRollCenter + uRollEast * eArc + northDir * n;

	// habitat spin: the whole shell turns rigidly about the hub axis while
	// the starfield stays fixed — in god view the cylinder visibly rotates
	if ( uRollSpin != 0.0 ) {

		float hubY = uRollGround + uRollRadius;
		vec2 relXZ = p.xz - uRollCenter;
		float u = dot( relXZ, uRollEast );
		float a = dot( relXZ, northDir );
		float v = p.y - hubY;
		float cs = cos( uRollSpin );
		float sn = sin( uRollSpin );
		float u2 = u * cs - v * sn;
		float v2 = u * sn + v * cs;
		p.y = hubY + v2;
		p.xz = uRollCenter + uRollEast * u2 + northDir * a;

	}

	return p;

}
`;

export const EFFECTS = [
	{ id: 0, name: 'None' },
	{ id: 1, name: 'Wave' },
	{ id: 2, name: 'Twist' },
	{ id: 3, name: 'Melt' },
	{ id: 4, name: 'Fold' },
	{ id: 5, name: 'Stretch' },
	{ id: 6, name: 'Glitch' },
];

export const COLOR_MODES = [
	{ id: 0, name: 'Natural' },
	{ id: 1, name: 'Acid' },
	{ id: 2, name: 'Matrix' },
	{ id: 3, name: 'Invert' },
	{ id: 4, name: 'Noir' },
];

// Distortion happens in world space (Y = up in the reoriented Bay Area frame),
// so we replace the projection chunk rather than displacing in object space —
// every tile mesh carries its own model transform.
const VERTEX_DECLARATIONS = /* glsl */ `
uniform float uTime;
uniform int uEffect;
uniform float uStrength;
uniform float uRadius;
uniform vec3 uCenter;
uniform sampler2D uSegTex;
uniform vec2 uSegCenter;
uniform vec2 uSegEast;
uniform vec2 uSegNorth;
uniform vec2 uSegHalf;
uniform float uWaterOn;
uniform float uWaterY;
varying vec3 vRingWorld;

// how strongly the coverage texture reads "water" at a world position
float ringWaterMask( vec2 xz ) {

	vec2 rel = xz - uSegCenter;
	vec2 uv = vec2( dot( rel, uSegEast ) / uSegHalf.x, dot( rel, uSegNorth ) / uSegHalf.y ) * 0.5 + 0.5;
	if ( uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0 ) return 0.0;
	vec4 seg = texture2D( uSegTex, uv );
	return seg.a * smoothstep( 0.75, 0.9, seg.b ) * ( 1.0 - smoothstep( 0.35, 0.5, seg.r ) );

}

// sea-classified ground sinks into a basin; only near-sea-level geometry
// drops, so bridge decks and masts over water keep their height
vec3 ringWaterDrop( vec3 p ) {

	if ( uWaterOn < 0.5 ) return p;
	float w = ringWaterMask( p.xz );
	if ( w <= 0.0 ) return p;
	w *= 1.0 - smoothstep( uWaterY + 2.5, uWaterY + 7.0, p.y );
	p.y -= 7.0 * w;
	return p;

}

float ringHash( vec2 p ) {

	return fract( sin( dot( p, vec2( 127.1, 311.7 ) ) ) * 43758.5453 );

}

float ringNoise( vec2 p ) {

	vec2 i = floor( p );
	vec2 f = fract( p );
	vec2 u = f * f * ( 3.0 - 2.0 * f );
	return mix(
		mix( ringHash( i ), ringHash( i + vec2( 1.0, 0.0 ) ), u.x ),
		mix( ringHash( i + vec2( 0.0, 1.0 ) ), ringHash( i + vec2( 1.0, 1.0 ) ), u.x ),
		u.y
	);

}

vec3 ringDistort( vec3 p ) {

	if ( uEffect == 0 || uStrength <= 0.0 ) return p;

	vec3 d = p - uCenter;
	float r = length( d.xz );
	float fall = exp( - r / uRadius );
	float s = uStrength;

	if ( uEffect == 1 ) {

		// concentric waves rippling out from the focus point
		p.y += sin( r * ( 14.0 / uRadius ) - uTime * 2.0 ) * uRadius * 0.04 * s * fall;

	} else if ( uEffect == 2 ) {

		// vortex twist around the focus point
		float ang = 6.2831 * s * fall * ( 0.3 + 0.12 * sin( uTime * 0.5 ) );
		float c = cos( ang );
		float sn = sin( ang );
		p.xz = uCenter.xz + mat2( c, - sn, sn, c ) * d.xz;

	} else if ( uEffect == 3 ) {

		// buildings slump and smear like softening wax
		float n = ringNoise( p.xz * ( 3.0 / uRadius ) + uTime * 0.15 );
		p.y = mix( p.y, p.y * ( 0.2 + 0.5 * n ), s * fall );
		p.xz += d.xz * 0.25 * s * fall * ( n - 0.5 );

	} else if ( uEffect == 4 ) {

		// the city folds upward with distance, Inception-style
		float rc = min( r, uRadius * 4.0 );
		p.y += rc * rc * ( 0.4 * s / uRadius );

	} else if ( uEffect == 5 ) {

		// vertical exaggeration — hills and towers stretch skyward
		p.y = uCenter.y + ( p.y - uCenter.y ) * ( 1.0 + 5.0 * s * fall );

	} else if ( uEffect == 6 ) {

		// voxel-style glitch displacement of city blocks
		float cell = uRadius * 0.06;
		vec2 id = floor( p.xz / cell );
		float pick = ringHash( id + floor( uTime * 2.0 ) * 0.013 );
		if ( pick > 0.6 ) {

			vec3 off = vec3(
				ringHash( id + 0.17 ) - 0.5,
				( ringHash( id + 0.29 ) - 0.5 ) * 0.7,
				ringHash( id + 0.41 ) - 0.5
			);
			p += off * cell * 1.2 * s * fall;

		}

	}

	return p;

}
`;

// vRingWorld keeps the pre-roll (flat map) position — the fragment stages
// (segment tint, voxel discard, zone mute) all reason in flat map space.
const VERTEX_PROJECT = /* glsl */ `
vec4 ringWorldPos = modelMatrix * vec4( transformed, 1.0 );
ringWorldPos.xyz = ringWaterDrop( ringDistort( ringWorldPos.xyz ) );
vRingWorld = ringWorldPos.xyz;
ringWorldPos.xyz = ringRoll( ringWorldPos.xyz );
vec4 mvPosition = viewMatrix * ringWorldPos;
gl_Position = projectionMatrix * mvPosition;
`;

const FRAGMENT_DECLARATIONS = /* glsl */ `
uniform float uTime;
uniform int uColorMode;
uniform vec3 uZoneCenter;
uniform float uZoneRadius;
uniform vec2 uVoxelCenter;
uniform float uVoxelRadius;
uniform sampler2D uSegTex;
uniform float uSegStrength;
uniform vec2 uSegCenter;
uniform vec2 uSegEast;
uniform vec2 uSegNorth;
uniform vec2 uSegHalf;
varying vec3 vRingWorld;

// tint by the segmentation coverage texture (world XZ → play-area UV)
vec3 ringSegment( vec3 col ) {

	if ( uSegStrength <= 0.0 ) return col;
	vec2 rel = vRingWorld.xz - uSegCenter;
	vec2 uv = vec2( dot( rel, uSegEast ) / uSegHalf.x, dot( rel, uSegNorth ) / uSegHalf.y ) * 0.5 + 0.5;
	if ( uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0 ) return col;
	vec4 seg = texture2D( uSegTex, uv );
	return mix( col, seg.rgb, seg.a * uSegStrength );

}

// mute the raw photogrammetry inside the upscale zone (blueprint base coat)
vec3 ringZone( vec3 col ) {

	if ( uZoneRadius <= 0.0 ) return col;
	float d = length( vRingWorld.xz - uZoneCenter.xz );
	float f = 1.0 - smoothstep( uZoneRadius * 0.8, uZoneRadius, d );
	float l = dot( col, vec3( 0.299, 0.587, 0.114 ) );
	vec3 muted = vec3( l * 0.45 ) + vec3( 0.03, 0.05, 0.08 );
	return mix( col, muted, f * 0.85 );

}

vec3 ringHueShift( vec3 col, float a ) {

	const vec3 k = vec3( 0.57735 );
	float c = cos( a );
	float s = sin( a );
	return col * c + cross( k, col ) * s + k * dot( k, col ) * ( 1.0 - c );

}

vec3 ringColor( vec3 col ) {

	if ( uColorMode == 1 ) {

		// hue sweeps with altitude and time
		return ringHueShift( col * 1.15, vRingWorld.y * 0.012 + uTime * 0.6 );

	} else if ( uColorMode == 2 ) {

		float l = dot( col, vec3( 0.299, 0.587, 0.114 ) );
		return vec3( 0.05 * l, 1.35 * l, 0.25 * l );

	} else if ( uColorMode == 3 ) {

		return 1.0 - col;

	} else if ( uColorMode == 4 ) {

		float l = dot( col, vec3( 0.299, 0.587, 0.114 ) );
		return vec3( pow( l, 1.5 ) * 1.1 );

	}

	return col;

}
`;

export function patchMaterial( material ) {

	if ( material.userData.ringPatched ) return;
	material.userData.ringPatched = true;

	material.onBeforeCompile = ( shader ) => {

		Object.assign( shader.uniforms, distortionUniforms );

		shader.vertexShader = ROLL_GLSL + VERTEX_DECLARATIONS + shader.vertexShader
			.replace( '#include <project_vertex>', VERTEX_PROJECT );

		shader.fragmentShader = FRAGMENT_DECLARATIONS + shader.fragmentShader
			.replace(
				'#include <opaque_fragment>',
				'if ( uVoxelRadius > 0.0 && length( vRingWorld.xz - uVoxelCenter ) < uVoxelRadius ) discard;\n\t#include <opaque_fragment>\n\tgl_FragColor.rgb = ringZone( ringSegment( ringColor( gl_FragColor.rgb ) ) );'
			);

	};

	// Constant suffix lets three.js share one compiled program across all tiles.
	material.customProgramCacheKey = () => 'ring-distort-7';
	material.needsUpdate = true;

}

const ROLL_PROJECT = /* glsl */ `
vec4 ringLocalPos = vec4( transformed, 1.0 );
#ifdef USE_INSTANCING
ringLocalPos = instanceMatrix * ringLocalPos;
#endif
vec4 ringWorldPos = modelMatrix * ringLocalPos;
ringWorldPos.xyz = ringRoll( ringWorldPos.xyz );
vec4 mvPosition = viewMatrix * ringWorldPos;
gl_Position = projectionMatrix * mvPosition;
`;

// Splices the cylinder roll into an existing shader (for materials that
// already have their own onBeforeCompile customisation).
export function applyRollToShader( shader ) {

	shader.uniforms.uRollK = distortionUniforms.uRollK;
	shader.uniforms.uRollCenter = distortionUniforms.uRollCenter;
	shader.uniforms.uRollEast = distortionUniforms.uRollEast;
	shader.uniforms.uRollGround = distortionUniforms.uRollGround;
	shader.uniforms.uRollSpin = distortionUniforms.uRollSpin;
	shader.uniforms.uRollRadius = distortionUniforms.uRollRadius;
	shader.vertexShader = ROLL_GLSL + shader.vertexShader
		.replace( '#include <project_vertex>', ROLL_PROJECT );

}

// Roll-only patch for auxiliary world geometry (voxel meshes, park props):
// it follows the cylinder but skips the tile-only distortion/color pipeline.
export function patchRollOnly( material ) {

	if ( material.userData.ringPatched ) return;
	material.userData.ringPatched = true;

	material.onBeforeCompile = ( shader ) => applyRollToShader( shader );
	material.customProgramCacheKey = () => 'ring-roll-2';
	material.needsUpdate = true;

}
