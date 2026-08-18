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
      import('./ui/PauseMenu'),
      import('./ui/SettingsPanel'),
    ]).then(([
      { MainMenu }, { IslandScene }, { LoadingOverlay, QuietCurtain }, { PauseMenu },
      { SettingsPanel },
    ]) => {
      /*
       * TWO MENUS, ONE ISLAND. The front menu answers "what would you like
       * to do?"; the pause menu answers "you are in the middle of
       * something, what now?" — and the front menu's START is a loaded gun
       * in the second question, which is why they are separate components
       * rather than two faces of one. What they SHARE is the save, and both
       * of them drive it through the same `IslandScene` methods.
       *
       * Because the island is never torn down, going in and out of either
       * costs nothing at all.
       */
      let menu: InstanceType<typeof MainMenu>;
      let island: InstanceType<typeof IslandScene> | null = null;
      let pause: InstanceType<typeof PauseMenu> | null = null;
      let curtain: InstanceType<typeof LoadingOverlay> | null = null;
      let said = 'Preparing the island…';
      /*
       * STANDING, not merely `ready`. `IslandScene.ready` means the world is
       * built; the queen, her drive and the soil stream arrive after it, and
       * `onReady` is the signal that all of them have. Gating on the earlier
       * one let RESUME fire before there was a stream to restore into, which
       * returned false and looked like a broken save.
       */
      let standing = false;
      /** What to do the moment she is standing, if someone is waiting. */
      let waiting: (() => void) | null = null;

      /*
       * PRESSABLE STRAIGHT AWAY, and the wait moved behind the button.
       *
       * START used to sit greyed until the island had finished, which reads
       * as broken: the one thing on the screen you came to press refuses,
       * for no reason you can see. So it is live from the first frame, and
       * pressing it puts up the ORIGINAL loading curtain — the one this
       * route replaced — which lifts by itself the moment she is standing.
       *
       * The wait is the same length either way; what changes is that it now
       * starts when you ask for it and is spent on a screen that says so.
       * And because the island has been building behind the menu the whole
       * time, most of it is already gone: press it late and the curtain
       * never appears at all.
       */
      /**
       * Put the front door back, carrying one thing to say. Used when a
       * press got as far as the curtain and then could not be honoured.
       */
      const reopen = (why: string): void => {
        if (curtain) { void curtain.finish(); curtain = null; }
        build();
        /* AFTER `build`, which calls `setLoaded` and wipes the line. */
        menu.setStatus(why);
      };

      /**
       * Leave the menu for the island, with an optional thing to do the
       * moment she is standing. `then` may return false to mean "that did
       * not work" — the door goes back up with a reason rather than the
       * curtain lifting on a world the player did not ask for.
       */
      const enter = (then?: () => boolean | void | Promise<boolean>): void => {
        menu.dispose();
        /* Awaited, because restoring reads the saved world out of IndexedDB
         * — see `islandStore`. A synchronous check would have taken the
         * pending promise for a truthy answer and never reported a bad
         * save at all. */
        const run = (): void => {
          void Promise.resolve(then?.()).then((ok) => {
            if (ok === false) reopen('That save could not be read');
          });
        };
        if (standing) { run(); return; }
        curtain = new LoadingOverlay(host);
        curtain.setStatus(said);
        waiting = run;
      };

      /*
       * ONE SETTINGS PANEL FOR BOTH DOORS — the Foundation Pass rule, "one
       * component, no duplicate settings logic." Constructed fresh on each
       * open like the pause menu, and every change is handed live to the
       * island so the world answers while the slider is still moving. The
       * island also loads the same store at boot, so a player who never
       * opens the panel still gets what they set last session.
       */
      let settings: InstanceType<typeof SettingsPanel> | null = null;
      const openSettings = (): void => {
        /* Guarded by the DOM, not the instance: RESET rebuilds the panel
         * inside its own click handler, so the tracked instance can be a
         * disposed shell while a live panel stands. The document cannot
         * be stale about whether one is up. */
        if (settings?.isUp || document.querySelector('.tm-settings')) return;
        settings = new SettingsPanel(host, {
          onChange: (p) => island?.applyPrefs(p),
          onClose: () => { settings = null; },
        });
      };

      const build = (): void => {
        menu = new MainMenu(host, {
          onStart: () => enter(),
          /*
           * RESUME GOES BEHIND THE CURTAIN NOW, like START.
           *
           * It used to sit greyed until the island had finished, and the
           * reason was real: a resume has to restore INTO something, and an
           * earlier attempt that deferred it was measured never firing —
           * the menu closed, the curtain lifted, and the nest was not
           * there. So it was made to wait for what it needs.
           *
           * What changed is that there is now a place to wait that ISN'T
           * the title screen. `onReady` runs whoever is waiting BEFORE it
           * lifts the curtain, so the restore still happens against a
           * finished island — it just happens behind a screen that says so
           * instead of behind a dead button. That is the whole of the
           * card's rule: preload in silence, and only show a loading state
           * once someone has asked to go in.
           *
           * `hasSave` is a localStorage read and needs no island, so the
           * button can be live from the first frame. And a save that will
           * not parse now has somewhere to report it — see `reopen`.
           */
          /* A promise now: the saved world lives in IndexedDB, which is
           * asynchronous. `enter` already awaits what it is given. */
          onResume: () => enter(async () => (await island?.resumeFromStorage()) ?? false),
          /* The entry MainMenu has drawn greyed since it was written —
           * live the moment an opener exists. */
          onSettings: openSettings,
          onDev: () => { window.location.search = '?scene=poseedit'; },
        });
        /*
         * START and RESUME need no island to be PRESSED, only to finish;
         * the curtain covers the difference, and RESUME only needs to know
         * a save EXISTS, which is a localStorage read.
         *
         * SAVE used to be here too, enabled once a session was standing.
         * It is gone from the front door entirely — "what are you going to
         * save in the main menu?" — and lives in the PAUSE menu, which is
         * the only place there is a run to write down.
         */
        menu.setEnabled('onStart', true);
        menu.setEnabled('onResume', IslandScene.hasSave());
        /*
         * THE PRELOAD IS SILENT, and this line is where that is decided.
         *
         * The menu used to narrate the boot at you — "Preparing the
         * island…", "Waking the queen…" — while you sat on the title
         * screen with nothing to do about it. That is a progress bar for a
         * wait the player never asked to start, and it makes a front door
         * look like a loading screen. The island still builds behind the
         * menu exactly as before; it just does it QUIETLY, and the words
         * only appear on the curtain, after START or RESUME, and only if
         * there is anything left to wait for.
         *
         * `setLoaded` is still called, because it does more than clear a
         * line — it is the signal the boot is done. A boot FAILURE is a
         * different thing entirely and still shows here: that is not
         * progress chatter, it is a state the player has to know about.
         */
        menu.setLoaded();
        (window as unknown as { mainMenu?: unknown }).mainMenu = menu;
      };

      /*
       * PAUSING, which is the only thing here that touches the sim.
       *
       * It refuses when the island is not standing or the front menu is
       * already up — pausing a world that has not finished arriving would
       * freeze the boot, and pausing behind the title screen would leave
       * START handing the player a stopped island.
       */
      const openPause = (): void => {
        if (pause?.isUp || !standing) return;
        if (document.querySelector('.main-menu')) return;
        island?.setPaused(true);
        pause = new PauseMenu(host, {
          onResume: () => { pause = null; island?.setPaused(false); },
          onSave: async () => (await island?.saveToStorage()) ?? false,
          onSettings: openSettings,
          onDev: () => island?.toggleDev() ?? false,
          /*
           * LEAVING IS A SCENE SWAP NOW, not a reload. The island keeps
           * running underneath — unpaused, because the front menu's RESUME
           * and START both hand back a live world and neither of them
           * should have to remember to start the clock again.
           */
          onMainMenu: () => {
            pause?.dispose();
            pause = null;
            island?.setPaused(false);
            build();
          },
        });
      };

      build();
      island = new IslandScene(host, {
        onMenu: openPause,
        curtain: new QuietCurtain(
          (text) => {
            /* REMEMBERED, NOT ANNOUNCED. `said` is the latest word from the
             * boot and it goes on the curtain — which only exists once
             * somebody has pressed START or RESUME. Nothing reaches the
             * title screen: see the note on `setLoaded` in `build`. */
            said = text;
            curtain?.setStatus(text);
          },
          (why) => {
            if (curtain) curtain.fail(why);
            else menu.setFailed(why);
          },
        ),
        onReady: () => {
          standing = true;
          /* WAS THE DOOR OPEN BEFORE we ran whoever is waiting? A failed
           * resume puts the menu BACK, with something to say — and the
           * refresh below would wipe that line the instant it appeared.
           * The question has to be asked before `then`, not after. */
          const menuWasUp = !!document.querySelector('.main-menu');
          /* Whoever is waiting gets what they asked for FIRST — a resume
           * must put the nest back before the curtain lifts on it. */
          const then = waiting;
          waiting = null;
          then?.();
          if (curtain) { void curtain.finish(); curtain = null; }
          if (menuWasUp && document.querySelector('.main-menu')) {
            menu.setLoaded();
            menu.setEnabled('onSave', true);
            menu.setEnabled('onResume', IslandScene.hasSave());
          }
        },
      });

      /*
       * ESCAPE PAUSES. It used to rebuild the FRONT menu over the running
       * island, which put START and RESUME in front of a player who only
       * wanted to stop for a second — the same category error the MENU
       * plate made, one step less destructive. The pause menu closes itself
       * on Escape, so this only ever has to open it.
       */
      window.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape' || pause?.isUp) return;
        openPause();
      });
    });
  }
}