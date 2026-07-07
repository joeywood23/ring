import { OrthographicCamera, Scene, Color, Vector3, MathUtils } from 'three';
import { TilesRenderer } from '3d-tiles-renderer';
import {
	GoogleCloudAuthPlugin,
	GLTFExtensionsPlugin,
	TileCompressionPlugin,
	ReorientationPlugin,
} from '3d-tiles-renderer/plugins';
import { createPlayRegionPlugin } from './bounds.js';

const WIDTH_PX = 240;

const _v = new Vector3();
const _dir = new Vector3();

// A second, static TilesRenderer looking straight down over the whole play
// area. It streams a coarse LOD once and then stays cached, giving a real
// satellite view without affecting the main camera's tile budget.
export class Minimap {

	constructor( { renderer, apiKey, dracoLoader, latRad, lonRad, container, marker, onPick } ) {

		this.renderer = renderer;
		this.container = container;
		this.marker = marker;
		this.onPick = onPick;
		this.ready = false;
		this.area = null;

		this.scene = new Scene();
		this.scene.background = new Color( 0x16222e );

		this.camera = new OrthographicCamera( - 1, 1, 1, - 1, 100, 100000 );

		const tiles = new TilesRenderer();
		tiles.registerPlugin( new GoogleCloudAuthPlugin( { apiToken: apiKey, autoRefreshToken: true } ) );
		tiles.registerPlugin( new GLTFExtensionsPlugin( { dracoLoader, autoDispose: false } ) );
		tiles.registerPlugin( new TileCompressionPlugin() );
		tiles.registerPlugin( new ReorientationPlugin( { lat: latRad, lon: lonRad } ) );
		tiles.registerPlugin( createPlayRegionPlugin() );
		tiles.setCamera( this.camera );
		tiles.errorTarget = 6; // after registration so it overrides the plugin's recommended value
		this.scene.add( tiles.group );
		this.tiles = tiles;

		container.addEventListener( 'pointerdown', ( e ) => this._pick( e ) );

	}

	// Crop the view to the shared play area (call once it's configured).
	configureExtent( playArea ) {

		this.area = playArea;

		const cam = this.camera;
		cam.left = - playArea.halfWidth;
		cam.right = playArea.halfWidth;
		cam.top = playArea.halfHeight;
		cam.bottom = - playArea.halfHeight;
		cam.position.copy( playArea.center ).add( new Vector3( 0, 30000, 0 ) );
		cam.up.copy( playArea.northDir );
		cam.lookAt( playArea.center );
		cam.updateProjectionMatrix();
		cam.updateMatrixWorld();

		// size the DOM frame to the geographic aspect ratio
		const heightPx = Math.round( WIDTH_PX * playArea.halfHeight / playArea.halfWidth );
		this.container.style.width = `${ WIDTH_PX }px`;
		this.container.style.height = `${ heightPx }px`;
		this.container.classList.remove( 'hidden' );

		this.tiles.setResolution( this.camera, WIDTH_PX * 2, heightPx * 2 );
		this.ready = true;

	}

	// Move the marker to the main camera's position and point it along the
	// camera's compass heading.
	update( mainCamera ) {

		if ( ! this.ready ) return;

		const area = this.area;
		_v.copy( mainCamera.position ).sub( area.center );
		const u = MathUtils.clamp( 0.5 + _v.dot( area.eastDir ) / ( 2 * area.halfWidth ), 0.03, 0.97 );
		const v = MathUtils.clamp( 0.5 + _v.dot( area.northDir ) / ( 2 * area.halfHeight ), 0.04, 0.96 );

		mainCamera.getWorldDirection( _dir );
		const heading = Math.atan2( _dir.dot( area.eastDir ), _dir.dot( area.northDir ) );

		this.marker.style.left = `${ u * 100 }%`;
		this.marker.style.top = `${ ( 1 - v ) * 100 }%`;
		this.marker.style.transform = `translate(-50%,-50%) rotate(${ heading }rad)`;

	}

	render() {

		if ( ! this.ready ) return;

		this.tiles.update();

		const { renderer } = this;
		const rect = this.container.getBoundingClientRect();
		const x = rect.left;
		const y = window.innerHeight - rect.bottom; // viewport origin is bottom-left

		renderer.setViewport( x, y, rect.width, rect.height );
		renderer.setScissor( x, y, rect.width, rect.height );
		renderer.setScissorTest( true );
		renderer.render( this.scene, this.camera );
		renderer.setScissorTest( false );
		renderer.setViewport( 0, 0, window.innerWidth, window.innerHeight );

	}

	_pick( e ) {

		if ( ! this.ready || ! this.onPick ) return;

		const area = this.area;
		const rect = this.container.getBoundingClientRect();
		const u = ( e.clientX - rect.left ) / rect.width;
		const v = 1 - ( e.clientY - rect.top ) / rect.height;

		const point = area.center.clone()
			.addScaledVector( area.eastDir, ( u - 0.5 ) * 2 * area.halfWidth )
			.addScaledVector( area.northDir, ( v - 0.5 ) * 2 * area.halfHeight );
		point.y = 0;

		this.onPick( point );

	}

}
