# Ring — SF Bay Area in 3D

Explore, distort, and restyle photorealistic 3D maps of the San Francisco Bay Area,
streamed live from **Google Photorealistic 3D Tiles** and rendered with three.js.

## Run it

```sh
npm install
npm run dev
```

Open http://localhost:5173.

## Getting an API key (free, ~2 minutes)

1. Go to the [Google Cloud Console → Maps Platform](https://console.cloud.google.com/google/maps-apis)
   and create (or pick) a project.
2. Enable the **Map Tiles API** for that project.
3. Under **Keys & Credentials**, create an API key and paste it into the app's launch screen.

The key is stored only in your browser's localStorage and is sent only to Google's
tile servers. The free monthly quota is generous for personal exploration; you can
watch usage in the same console. Use the ⚙ button in the panel to change the key.

## What you can do

- **Fly to** presets: Downtown SF, Golden Gate, Alcatraz, Bay Bridge, Coit Tower,
  Twin Peaks, Marin Headlands, Oakland, or a whole-bay overview — with smooth
  arcing camera flights.
- **Distort** the city in real time with GPU vertex shaders (applied in world space
  around wherever you're looking):
  - **Wave** — concentric ripples roll through the terrain
  - **Twist** — a slow vortex swirls the city around your focus point
  - **Melt** — buildings slump and smear like softening wax
  - **Fold** — the world bends upward with distance, Inception-style
  - **Stretch** — vertical exaggeration; towers and hills shoot skyward
  - **Glitch** — city blocks displace in voxel-like jitters
- **Recolor** with fragment shaders: Acid (altitude/time hue sweep), Matrix,
  Invert, Noir — plus a wireframe toggle.
- **Sliders** for effect strength, reach (falloff radius), and animation speed.
- **Minimap** (top-right): a live satellite overview cropped to the full
  covered region (Marin Headlands to Oakland), with an arrow showing your
  position and compass heading. Click anywhere on it to fly there.
- **Playable area**: the world is limited to the SF Bay box shown on the
  minimap (Marin Headlands ↔ Oakland, Twin Peaks ↔ Angel Island, ~33 × 20 km).
  No tiles are ever requested outside it (a mask region prunes them during
  tileset traversal), the free-flight camera clamps to its edges, and the
  skateboard slides along the boundary like an invisible wall. One box in
  `src/bounds.js` (`PLAY_BOUNDS`) drives all of it — widen it there if you
  want more world.
- **Skate mode** — press **Drop In**, then aim from bird's eye view: a pulsing
  sphere projects onto the terrain under your cursor (you can still orbit and
  zoom while aiming — a clean click selects, a drag navigates). Click a spot
  to spawn a skateboard there at street level; Esc cancels. Real physics
  against the actual photogrammetry mesh: gravity projected along the terrain
  slope (bomb the hills), carving grip, ollies, wall collisions, curb
  step-ups, and a chase camera. Starting the aim mode pauses briefly while
  collision BVHs build for the loaded tiles.
- **Rider & board animation** — a close-framed chase camera watches a
  procedurally animated skater: a push cycle while W is held, a heel-drag
  brake stance on S, banking into carves with A/D, and an air tuck off drops.
  The board itself uses real truck kinematics: leaning rolls the deck, and
  each hanger rotates about its inclined pivot axis by exactly the angle that
  keeps the axle level — steering the front truck into the turn and the rear
  truck out of it, with spinning wheels driven by travel.
- **Detail upscaling (skate mode only)** — clean models of roads, buildings,
  trees, and bushes stream in around the skater, sourced from OpenStreetMap
  (Overpass API, no key needed) and draped onto the photogrammetry with ground
  raycasts. Roads render as asphalt ribbons with center lines that follow the
  hills, buildings as crisp extrusions using OSM height tags (inflated
  slightly so they wrap the photogrammetry facades), vegetation as instanced
  low-poly models. The raw photogrammetry inside the zone is desaturated so
  the clean models read clearly. Toggle it with the **Upscale detail**
  checkbox in the panel or the **U** key while skating — a status line under
  the checkbox shows fetch/build progress and object counts. Only a ~320 m
  zone around the skater is fetched (rebuilt as you roam), geometry builds
  are spread across frames, and meshes are frustum-culled — so only nearby,
  in-view objects cost anything.

## Controls

| Input | Action |
| --- | --- |
| Left-drag | Move across the terrain |
| Right-drag | Rotate / look around |
| Scroll | Zoom (toward the cursor) |
| Click minimap | Fly to that spot |

**Skate mode**

| Key | Action |
| --- | --- |
| Click (while aiming) | Choose drop-in spot |
| Esc (while aiming) | Cancel aiming |
| W / S | Push / brake |
| A / D | Carve left / right |
| Space | Ollie |
| U | Toggle upscale detail overlay |
| R | Respawn at drop-in point |
| Esc | Bail back to orbit view |

## How it works

- [`3d-tiles-renderer`](https://github.com/NASA-AMMOS/3DTilesRendererJS) streams the
  OGC 3D Tiles photogrammetry mesh, with `GoogleCloudAuthPlugin` handling session
  auth and `ReorientationPlugin` rotating the globe so the Bay sits at the origin
  with +Y up.
- Every loaded tile material gets patched via `onBeforeCompile`
  (`src/effects.js`): the vertex `project_vertex` chunk is replaced so distortion
  happens in world space regardless of each tile's own transform, and a color
  post-step is appended to the fragment shader. All materials share one set of
  uniforms, so the whole city animates from a single per-frame update.
- Draco-compressed tile geometry is decoded with the decoder hosted on
  `gstatic.com`.
- Skate mode (`src/skate.js`) raycasts against the streamed tile meshes using
  [`three-mesh-bvh`](https://github.com/gkjohnson/three-mesh-bvh) (bounds trees
  are built per tile on load while skating). The board is a velocity-based
  character controller: slope acceleration comes from projecting gravity onto
  the raycast ground normal, lateral velocity is damped hard (carving) while
  longitudinal velocity rolls freely, walls (surface normal too steep to ride)
  deflect the velocity, and airborne motion is ballistic with reduced steering.
