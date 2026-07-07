import { defineConfig } from 'vite';

export default defineConfig( {

	// Relative base so the build works when served from a subpath
	// (e.g. GitHub Pages at username.github.io/ring/).
	base: './',

} );
