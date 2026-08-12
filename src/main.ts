import './style.css';
import { markLoaded, registerServiceWorker } from './pwa';

/*
 * Offline play and the update prompt. First, so a scene that throws while
 * loading still leaves an installable, updatable app behind it.
 */
registerServiceWorker();

/*
 * Routing.
 *
 * THE ISLAND IS THE GAME MAP NOW. Opening the app with no query string drops
 * straight into Kauai-for-ants; the old rooms stay one query string away as
 * permanent development rigs instead of being deleted.
 *
 * The colony sim keeps every URL it ever had — `?map=densityterrainlab`,
 * `?scene=density`, `?scene=block`, and the rest — so focused testing still
 * has small deterministic rooms when the full island would be noise.
 *
 * Everything is imported lazily so a route only pays for its own scene.
 */
const params = new URLSearchParams(window.location.search);
// Case-blind on purpose: "?scene=Sandbox" typed on a phone should work.
const scene = params.get('scene')?.toLowerCase() ?? null;
const map = params.get('map');
const colonySim = scene === 'density'
  || map === 'densityterrainlab'
  || params.has('densityterrainlab');

const host = document.getElementById('app');

/*
 * WHO SAYS THE APP HAS FINISHED LOADING.
 *
 * A waiting update is not allowed to reload the app out from under a load in
 * progress — see `pwaPolicy.ts` for the bug that rule exists for — so
 * something has to say when the load is over. The island says it itself, from
 * the far side of a height field, a set of biome textures and a megabyte of
 * ant. Every other route here is a development rig: a small deterministic
 * room that is up as soon as its module is, with no curtain to lift and
 * nothing worth protecting from a reload. They are marked loaded at once, so
 * a rig can still take an update immediately and none of them can strand one.
 */
const island = !colonySim && ![
  'queen', 'block', 'terrainbug', 'world', 'hex', 'dig',
  'ant-sandbox', 'rail', 'pipes', 'sandbox', 'carry',
  /*
   * The pose editor is up as soon as its module is — no curtain to lift and
   * nothing worth holding an update back for. The MENU is deliberately NOT
   * here: it is the default route and it boots the island behind itself, so
   * the gate has to stay shut until the island says so. Marking it loaded
   * when the menu paints would hand a waiting service worker the app in the
   * middle of the queen's megabyte, which is the exact bug the gate exists
   * for.
   */
  'poseedit',
].includes(scene ?? '');
if (!island) markLoaded();

if (host) {
  host.classList.add('dig-host');
  if (colonySim) {
    void import('./scenes/DensityTerrainLabScene').then(
      ({ DensityTerrainLabScene }) => new DensityTerrainLabScene(host),
    );
  } else if (scene === 'queen') {
    // Model and gait preview. Nothing in the game imports it — see QueenScene.
    void import('./scenes/QueenScene').then(({ QueenScene }) => new QueenScene(host));
  } else if (scene === 'block' || scene === 'terrainbug') {
    /*
     * The compact dirt-block laboratory: six-face walk, digging, shafts,
     * cliff and nest designer rigs. Kept because bugs are easier to pin down
     * here than halfway across a fifty-six-metre island.
     */
    void import('./scenes/BlockScene').then(({ BlockScene }) => new BlockScene(host));
  } else if (scene === 'world') {
    /*
     * The hybrid streamed-world prototype: a macro surface everywhere, a
     * fine diggable window under the ant, a nest plan carved into the world
     * function. See docs/HYBRID_WORLD_PLAN.md.
     */
    void import('./scenes/WorldScene').then(({ WorldScene }) => new WorldScene(host));
  } else if (scene === 'hex') {
    // The hex-grid experiment, kept only as the reference the rounded sockets
    // were taken from. See src/voxel/HexGrid.ts for why it could never be the
    // real grid.
    void import('./scenes/HexScene').then(({ HexScene }) => new HexScene(host));
  } else if (scene === 'dig') {
    // The original dig room remains available explicitly as a reference rig.
    void import('./scenes/DigScene').then(({ DigScene }) => new DigScene(host));
  } else if (scene === 'ant-sandbox') {
  void import('./scenes/sandbox/AntMechanicsSandbox').then(
    ({ AntMechanicsSandbox }) => new AntMechanicsSandbox(host),
  );
  } else if (scene === 'rail') {
    /*
     * The monorail room: the coaster-style tunnel builder on its own, with a
     * cart riding the track. Pieces compile to a NestPlan, so what this room
     * proves carries into the carved, jaws-executed version unchanged.
     */
    void import('./scenes/RailScene').then(({ RailScene }) => new RailScene(host));
  } else if (scene === 'pipes') {
    /*
     * The pipes room: tunnels as plumbing. Arm a pipe piece, rotate it in
     * 45° racks, tap again to place — it snaps to the open end, carves
     * instantly, and the network's centerlines are where ants can travel.
     */
    void import('./scenes/PipesScene').then(({ PipesScene }) => new PipesScene(host));
  } else if (scene === 'sandbox') {
    /*
     * The ant mechanics sandbox: worker and major, and the head-and-jaws
     * interaction grammar — approach, aim, clamp, carry or drag or bite —
     * proved on a bare field before it meets the island.
     */
    void import('./scenes/SandboxScene').then(({ SandboxScene }) => new SandboxScene(host));
  } else if (scene === 'poseedit') {
    /*
     * The pose editor: a turntable, one handle per body group, and named
     * poses saved as bone rotations. Behind the menu's PIN in ordinary use.
     */
    void import('./scenes/PoseEditorScene').then(
      ({ PoseEditorScene }) => new PoseEditorScene(host),
    );
  } else if (scene === 'carry') {
    /*
     * The carry room: soil as a lattice of 2 mm blocks, and digging as
     * picking one up. Crosshair on a block, CARRY takes it, DROP places it —
     * a tunnel is exactly the blocks somebody carried out of it.
     */
    void import('./scenes/CarryScene').then(({ CarryScene }) => new CarryScene(host));
  } else if (scene === 'island') {
    /*
     * `?scene=island` — straight in, no menu, its own curtain. This is what
     * forty probes navigate to and what they have always got, so it is kept
     * exactly as it was rather than routed through the front door.
     */
    void import('./scenes/IslandScene').then(({ IslandScene }) => new IslandScene(host));
  } else {
    /*
     * THE DEFAULT: the menu IS the loading screen.
     *
     * The island's boot is long and front-loaded, and it used to be spent
     * watching a black overlay count off "Raising the island…". Now the menu
     * paints instantly and the island builds BEHIND it, reporting the same
     * words onto the menu's own status line — so the wait buys a screen you
     * can read, open settings on and reach the dev tools from, and by the
     * time START is pressed there is usually nothing left to wait for.
     *
     * The island keeps `markLoaded` on its own schedule, untouched: the gate
     * that stops a waiting service worker reloading the app mid-download
     * still fires from the far side of the queen's megabyte, not from the
     * menu appearing. See `pwa.ts` for the bug that rule exists for.
     */
    void Promise.all([
      import('./ui/MainMenu'),
      import('./scenes/IslandScene'),
      import('./scenes/LoadingOverlay'),
    ]).then(([{ MainMenu }, { IslandScene }, { QuietCurtain }]) => {
      const menu = new MainMenu(host, {
        onStart: () => {
          /* The island is already standing behind this; taking the menu down
           * IS the transition. Nothing loads, nothing navigates. */
          menu.dispose();
        },
        onDev: () => { window.location.search = '?scene=poseedit'; },
      });
      /* Disabled until she is standing — a START that drops you into a
       * half-built island is worse than one you wait a moment for. */
      menu.setEnabled('onStart', false);
      menu.setStatus('Preparing the island…');
      const island = new IslandScene(host, {
        curtain: new QuietCurtain(
          (text) => menu.setStatus(text),
          (why) => menu.setFailed(why),
        ),
        onReady: () => menu.setLoaded(),
      });
      (window as unknown as { mainMenu?: unknown }).mainMenu = menu;
      void island;
    });
  }
}