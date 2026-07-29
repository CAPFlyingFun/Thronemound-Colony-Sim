# Dig prototype (Phases A + B)

**Play:** append `?scene=dig` to the game URL —
`https://capflyingfun.github.io/Thronemound-Colony-Sim/?scene=dig`

First-person, at ant scale. Walk, look, dig soil, carry the spoil, drop it back
out. The default route (no `?scene=`) is still the 2D Phaser colony sim; the two
never load each other's bundle.

## Controls

| | Touch | Desktop |
|---|---|---|
| Walk | drag the **left half** of the screen | `WASD` / arrows, `Shift` to sprint |
| Look | drag the **right half** | move the mouse (click once to capture the cursor, `Esc` to release) |
| Dig a cube | **tap it** | click it (crosshair), or `F` |
| Cancel a dig | tap it again, or tap **CANCEL** | click again, or `F` |
| Put the load down | tap **DROP** | `E` or `Tab` |
| Jump | tap **JUMP** | `Space` |
| Stick to a wall | automatic — just walk into it | automatic |
| Let go of a wall | tap **JUMP** | `Space` or `G` |
| Step up | automatic | automatic |

## Scale

One world unit = one voxel = **5 mm**. The volume is 128³ voxels, so:

- the ground patch is **64 cm × 64 cm**, about 128 ant-lengths across
- there are **96 voxels of diggable soil** beneath the surface (~48 cm), which is
  a realistic depth for a founding nest
- the ant stands **0.7 voxels** tall (3.5 mm) and works only the cubes it is
  touching

Everything scales off `VOXEL_MM`, `WORLD_SIZE` and `SURFACE_Y` at the top of
`src/scenes/DigScene.ts`. Growing the world is a constant change, not a rewrite.

## Soil is conserved

The rule that makes this an ant game rather than Minecraft: **you cannot place a
voxel you did not first excavate.** So the mound above ground is exactly the
volume of the tunnels below it, and the HUD's `Dug` and `Mound` counters are two
views of the same soil.

Carry capacity is **one voxel**. An ant carries a grain in its mandibles, not a
wheelbarrow — so the loop is dig one, haul it out, drop it, come back. That makes
the mound something you build rather than dump, and it means a single hold of
ACTION can no longer sink you twelve cubes into a shaft. Dig with a full load and
nothing happens until you drop it.

## Digging

**Tap a cube and she starts working it. Tap again and she stops.** No holding —
a dig takes seconds, and holding a button through that on a phone is a cramp,
not a mechanic.

The tap **locks** the cube. That is the part that matters: the dig runs against
its locked target rather than against whatever a ray currently hits, so you can
look around while she works. It also deleted a bug rather than papering over
one — progress used to reset the instant the targeted cube changed, so a few
pixels of thumb drift silently sent the bar back to zero.

Tap-targeting and the crosshair are **one mechanic with two ray origins** —
screen centre or an unprojected touch point; everything downstream is the same
call. The crosshair path stays for three jobs a world-tap can't do:

- desktop, where pointer lock means there is no cursor to aim with
- **CANCEL**, which needs to live somewhere fixed — once a dig is running the
  camera is free to look away, and "tap the cube again" is no help if you can no
  longer see it
- the cube underfoot, which is mostly hidden behind the HUD

So the action button is context-sensitive: **DIG** while idle, **CANCEL** while
working, the same way it does for any other paired action.

A tap is a press under 250 ms that travels under 10 px. Both thresholds are
generous, because the failure is asymmetric: a stray tap starts a dig that
another tap cancels, whereas a dig that refuses to register reads as the game
being broken.

There is no dig/place mode. Capacity is one cube, so "place" only ever means
"put down the one thing I'm carrying" — a mode toggle for a state you can read
off the load was a button and a failure mode (*I tapped and nothing happened*)
in exchange for nothing. **DROP** replaces it.

**DROP doesn't require aim.** It prefers the cell the crosshair faces, but falls
back to the best neighbouring one. At one-cube reach the aim window on flat
ground is genuinely narrow — pitch too shallow and the ground you're looking at
is two cubes out, too steep and the placement cell is your own body — so
insisting on the crosshair made DROP silently do nothing at a lot of perfectly
reasonable angles. That's the same silent failure the mode toggle was deleted
for, so it had to go too. An ant putting down a grain doesn't aim; she puts it
down.

The fallback is scored rather than first-match, so spoil lands somewhere that
reads as deliberate: braced against something solid rather than hanging in
mid-air, low rather than overhead, in front of her rather than behind.

## Reach

An ant works the soil it is **touching**. Targeting is a 2.2-voxel ray *plus* a
hard clamp to the 3×3×3 shell of cubes around the ant's own cube — both, because
a radius alone can't express "one cube away": a diagonal at 1.7 voxels is nearer
in distance than a face at 1.9, yet further in cubes.

This replaced a 5.5-voxel reach that let you carve a five-cube corridor without
moving, which read as tunnels appearing out of nowhere. Aim at anything beyond
the neighbouring cubes and the HUD target reads `—`. Walking out of range mid-dig
cancels it — reach is enforced by the scene each frame, not just at the tap.

## Digging gets easier

Seconds per cube of topsoil, falling by 0.2 for every cube actually removed:

```
seconds = max(1.5, 5.0 - 0.2 × cubes dug) × hardness
```

Which is **18 digs to master**, against 14–19 to found the den — so the queen
tops out almost exactly as she finishes. That fit isn't tuned; it falls out of
the endpoints. The whole arc of getting good at it *is* the tutorial: the
opening is heavy, and founding feels earned.

Total chew time across those 18 digs is ~59 s, near-identical to a flat 3 s
would cost. Same time budget, different shape.

Practice is credited on the cube **popping**, never on the tap. Crediting it at
the start would make tap-cancel-tap-cancel a way to reach top speed in four
seconds.

Hardness is a **ratio**, not a number of seconds — absolute time belongs to the
ant, hardness to the dirt, and one field holding both meant neither could be
retuned without silently moving the other:

| | first dig (5.0 s) | mastered (1.5 s) |
|---|---|---|
| Topsoil ×1 | 5.0 | 1.5 |
| Sand ×1.25 | 6.25 | 1.9 |
| Clay ×1.5 | 7.5 | 2.25 |

The ratios were 1 / 1.43 / 2. Clay at 2× costs an unpractised ant ten seconds a
cube, which is where the number stops describing strata and starts describing
waiting — and it matters most for a freshly hatched worker starting her own
curve down in the clay band, not for the queen, who founds almost entirely in
topsoil.

`DIG_START` / `DIG_STEP` / `DIG_FLOOR` are named constants per session, so the
first worker can be given her own curve. She should start clumsy too, but
probably not from as far back as a queen who has never dug at all.

The deepest band is bedrock, which can't be dug at all and forms the floor of
the world. The sides and floor of the volume read as stone, so you can't tunnel
out of bounds.

## How it's built

```
src/voxel/VoxelWorld.ts   sparse chunked storage + world generation
src/voxel/raycast.ts      Amanatides & Woo grid traversal (targeting)
src/voxel/mesher.ts       face-culling mesher with per-vertex ambient occlusion
src/voxel/DigSession.ts   dig timing, carry load, place rules
src/voxel/QueenFounding.ts  depth + chamber requirements, den lock
src/voxel/locomotion.ts     stick speed curve + acceleration
src/voxel/SurfaceFrame.ts   six-axis orientation for wall walking
src/voxel/tileTextures.ts   procedural ant-scale soil tiles
src/voxel/voxelMaterial.ts  texture-array material (the only three.js file here)
src/scenes/DigScene.ts    three.js renderer, camera, touch/desktop input, HUD
```

Everything except `voxelMaterial.ts` and `DigScene.ts` is **plain TypeScript with no three.js import**, the same way
`PheromoneField` and `FoodNode` are engine-free. They're unit tested headlessly
(`npm test`), and a future renderer swap wouldn't touch them.

Two properties keep an ant-scale world cheap:

1. **Untouched chunks cost zero bytes.** A chunk is reproducible from the
   generator until something inside it is modified, at which point it
   materialises its 32 KB array. Boot the scene and the HUD reads `0 KB voxels`.
   (Checking for *uniform* chunks instead would achieve nothing here — soil
   strata don't line up with chunk boundaries, so nearly every chunk holds two
   materials and would allocate immediately.)
2. **Only exposed faces are meshed.** A fully buried chunk emits no geometry at
   all, so render cost tracks how much has been **dug**, not how big the world
   is. A pristine flat world is 16 chunks of surface and nothing else.

## Verifying

```bash
npm test          # 82 tests: voxel rules + the existing colony tests
npm run typecheck
npm run build
npm run preview   # then, in another shell:
npm run smoke:dig   # boots WebGL, digs, places, checks soil conservation
npm run smoke:queen    # pre-carves a den, founds it, checks the colony handoff
npm run smoke:mobility # rotation resize, one-cube-at-a-time carry, auto-stick
```

The smoke test drives the **touch** path, since that's what ships to a phone,
and asserts the things unit tests can't reach: that WebGL initialises, that the
rendered frame changes when the world does, and that carry/mound accounting
survives a real round trip through the UI.

Playwright is a devDependency for that script only. CI sets
`PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` so deploys don't pull browsers they never
launch; run `npx playwright install chromium` locally if you want it.

## Movement feel

Speed comes from **how far the stick is pushed**, not just its direction, so
precise positioning while digging is possible:

| Stick throw | Speed |
|---|---|
| 0 – 8% | dead zone |
| 8 – 35% | crawl, up to 2 voxels/s (1 cm/s) |
| 35 – 75% | walk, up to 4.5 (2.25 cm/s) |
| 75 – 100% | run, up to 7.5 (3.75 cm/s) |

Those aren't picked by feel. *Solenopsis invicta* runs at about 1.96 cm/s, and
ants generally cover ~9 body lengths per second, which at 5 mm per voxel puts a
real ant's run near 4 voxels/s. The old "run" of 16 was roughly four times an
actual ant, which is exactly why it felt like flying.

The bands are landmarks for the thumb, but the response between them is
continuous — a unit test asserts monotonicity and that no single 0.5% step of
the stick changes speed by more than 0.35 voxels/s, so it can never feel like
three discrete gears.

Keyboard has no analogue axis, so it selects the walk band (`Shift` for run).

Two multipliers stack on top: **×0.75 underground** (close work, braced against
tunnel walls in the dark) and **×0.85 while carrying**. Being straight about the
second one: a real ant hauls many times its own body weight, so one grain would
barely slow it. That number is there so the trip out reads as work — it's a feel
choice, not a biology one.

Speed also needs a **direction**, not just a magnitude. `magnitude` comes from
the stick throw, and for keyboard it stays pinned at `KEY_MAGNITUDE` for as long
as `keyboardDriving` is set — which outlives the keypress. So releasing `W` used
to leave the target speed at walking pace indefinitely: the ant stood still (the
wish vector is zero, so the step is zero) while reporting 3.4 voxels/s and
swaying as though mid-stride.

Movement accelerates (14 voxels/s²) and decelerates (22) rather than snapping
to velocity, which is what gives the ant any sense of mass.

The touch stick is **constrained floating**: it appears under your thumb
anywhere in the left 42% of the screen, but its centre is clamped into a
lower-left region so it can't spawn beside the HUD or halfway up the screen.

> **On frame rate:** `dt` is clamped to 50 ms, so below 20 fps the game runs in
> slow motion rather than dropping frames. That's deliberate — large physics
> steps would tunnel the ant through walls — but it means a struggling device
> gets a slow game rather than a janky one. It also means headless smoke tests
> (~8 fps under software rendering) measure ~0.39× real speed; compare ratios
> there, not absolutes.

`?debug=1` appends live position, orientation and speed to the readout, which is
how those numbers get measured rather than eyeballed.

The HUD always shows a **version and build time** (`v0.7.0 · 07-29 03:47`), so
"is this the new code or a cached build?" is answerable at a glance from a
phone.

## Getting out of holes

**Underground the ant is weightless.** An ant in a tunnel is never really
falling — it is inside a tube, touching something at every moment. Below
`UNDERGROUND_Y` (one voxel under the surface) gravity is switched off entirely,
which deletes the whole "trapped at the bottom of the shaft you just dug"
problem class rather than mitigating it. Above that line — the surface and
anything piled on it — gravity behaves normally, so the world above is still
somewhere you can fall off.

Weightless does not mean motionless. She **settles** at a constant 2 voxels/s
(1 cm/s) — constant, not accelerating, so no speed builds up and it stays a
controlled descent rather than a fall.

> **The hover bug, because it is worth not repeating.** This branch used to ask
> `supportBelow()` whether something was underfoot and zero the velocity if so.
> That is a *grid* query — it floors the position to a cube and checks the cube
> below **that** — being used to decide a *continuous* position. Settling from
> y 97.0 into a one-deep pit, the instant she crossed to 96.99 the cube below
> (95) read solid, the velocity was zeroed, and she stopped **0.99 voxels** above
> a floor she is only 0.7 tall.
>
> The gravity branch never had this problem because it never asks: it moves and
> lets `collides()` stop it, which is sub-voxel accurate. Now this one does the
> same. A smoke test measures the actual drop and fails under 0.8 voxels.

The **touching test** is the safety valve: weightlessness requires at least one
solid face in contact. Dig the floor out from under yourself with nothing else in
reach and gravity comes straight back, so you settle onto something instead of
hanging in a void.

Getting back *up* has three mechanics, none of which need sloped geometry:

- **Auto-stick** — walk into a wall underground and it becomes your floor. This
  is the concave case, and it needs its own path because `evaluateEdge` only
  fires when support runs out, which never happens while you stand on a shaft
  floor. Gated on committed movement (`INPUT_COMMIT_THRESHOLD`) and on the
  hysteresis lock, so brushing a wall while lining up a dig can't flip you and a
  corner can't ping-pong between two faces.
- **Jump** — the only way OFF a surface. There is no release button, because
  "am I gripping?" was a mode the player had to track for no benefit.
- **Step-up** — walking into a one-voxel rise lifts you over it, so a dug
  staircase works as a ramp.

An earlier push-into-a-wall auto-climb — a stopgap from before `SurfaceFrame`
existed — was removed rather than patched. It *lifted* you up a wall at a fixed
rate instead of reorienting you onto it, engaged silently when you only meant to
walk into something, and was measurably unreliable: 1–2 voxels out of a 5-voxel
shaft, sometimes zero. Auto-stick is the same intent done through the orientation
state machine, so it inherits commitment and hysteresis for free.

Above ground, movement is still tuned for an ant rather than a person. By the
square-cube law an ant has huge drag relative to its mass, so terminal velocity
is low and falls are effectively harmless — ants drop off things constantly and
walk away.

| | originally | now |
|---|---|---|
| Gravity (above ground) | 400 voxels/s² | **12** (6 cm/s²) |
| Gravity (below ground) | 400 | **0**, with a 2 voxels/s settle |
| Terminal velocity | −1.30 m/s | −0.15 m/s |
| Body size | 1.6 × 0.9 voxels | **0.7 × 0.6** (3.5 × 3 mm) |
| Jump height | 1.45 voxels | 1.45 (derived, not tuned) |

The body size is a **gameplay requirement**, not a detail: at 1.6 × 0.9 the ant
could not rotate inside a one-voxel tunnel — lying against a wall it needed 1.6
of clearance along the wall normal and the tunnel only has 1 — so gripping
silently failed in exactly the tunnels the game is made of. At 0.7 × 0.6 it
fits both standing and lying in a single voxel.

Jump is expressed as a **height** with the launch speed derived from it
(`JUMP_SPEED = √(2·g·h)`), because the two are coupled and hand-tuning them
separately already went wrong once: softening gravity silently turned a
1.4-voxel hop into a 3.2-voxel leap, enough to jump out of shafts and make
climbing pointless. Gravity can now be retuned freely.

Small creatures reach terminal velocity almost instantly, so what you see of an
ant falling is a near-constant slow drift rather than a build-up — the terminal
value matters more to the feel than the acceleration does.

Climbing is gated on headroom. Without that check the ant pins against a
ceiling and *hovers* — the blocked move cancels her velocity but she never
becomes grounded, so she can neither rise nor fall. Refusing to climb lets
gravity drop her back to the floor, where she can walk to the shaft instead.

This is deliberately not literal 45° geometry. Real fire-ant nests are
near-vertical shafts with chambers budding off them, so forcing everything to
a ramp would make the nests look *less* like nests — and cost ~40% more digging
for the same depth. Ants don't need ramps because ants climb.

## Textures

Material choice travels per-vertex as a **texture-array layer**, not as a UV
offset into an atlas — an atlas bleeds neighbouring cells into each other once
mipmaps engage at distance, and that can't be fixed later without re-authoring
the art. The whole world still shares one `MeshStandardMaterial`.

One tile spans `TILE_VOXELS` (8) = **4 cm of real ground**, and UVs are world
space, so the pattern flows across neighbouring voxels of one material instead
of restarting on every cube face.

Placeholder tiles are generated procedurally in `tileTextures.ts`, and that's
deliberate: every feature size is quoted in **millimetres** and converted, so
"clods are 15–25% of tile width" is enforced in code rather than judged by eye.
Photographic tiles drop in against that same target.

> **Scale is the thing that makes or breaks a soil texture here.** A tile shot
> at human scale (a ~30 cm garden bed) compresses every feature 8× too small
> once mapped to a 4 cm tile: pebbles become sand grains and the ground reads
> as flat noise. Tiles must be macro shots of a few centimetres of dirt.

Albedo is sRGB, normal and roughness are linear. Base colours are authored in
sRGB bytes — feeding linear values through an sRGB texture renders everything
about half as bright, which is a mistake worth only making once.

## Phase B — founding the queen's den

You start as the queen. The objective line drives the whole sequence:

1. **Dig down** — 4 voxels (20 mm) below the surface
2. **Hollow a chamber** — 14 air voxels within radius 2, which a bare shaft
   can't satisfy (~5) but a 3×3×3 pocket comfortably can (19)
3. **Found the den** — the button appears *only* while the site qualifies, so
   stepping out withdraws the offer and teaches the requirement without a
   tooltip

Founding is irreversible. The queen sheds her wings, seals the chamber, and
stops being a character — the camera detaches and orbits the den. That's not a
game concession; it's claustral founding, which is what actually happens.

The colony view is a **cutaway**: orbiting from inside a solid volume means
back-face culling shows you through the soil, leaving the burrow readable in
cross-section like an ant farm. The background switches to dark earth so it
reads as intentional rather than as a rendering fault.

The depth was **200 mm** (40 voxels) until carry capacity dropped to one. Forty
voxels of shaft at one cube per round trip is a lot of hauling before the game
has properly begun, and depth is the requirement that scales worst against
capacity — the chamber is a fixed 14 either way. It can grow again as the colony
does.

Threshold numbers were measured, not guessed — see the "den chamber threshold
is achievable by hand" test, which asserts the requirement is satisfiable from
where a player actually *stands* (the chamber floor), not from a theoretical
centre point. Measured from the floor of a **spherical** cavity you only get
11, which is why the debug carve is a box.

## Debug entry point

`?scene=dig&debug=den` pre-carves a qualifying shaft and chamber and drops the
queen into it — otherwise every run of the smoke test would have to hand-dig the
chamber one cube at a time.

## Surface walking

`SurfaceFrame.ts` is the foundation for ant wall-walking. In a voxel world
every surface is an axis-aligned cube face, so "up" is always one of **six**
directions — never an arbitrary angle. That turns general gravity-walking into
a small discrete state machine, and it's the only reason the feature is
affordable here.

The governing rule: **physics is always one of the six discrete frames; only
the camera interpolates.** An axis-aligned collision box at 43° fits nowhere,
and allowing one in-between orientation collapses the whole simplification.

Two rules keep corners from misbehaving:

- **Commitment.** Proximity to an edge is never enough to cross it — movement
  must also point across, above `INPUT_COMMIT_THRESHOLD`. This is what lets you
  stand still low on a wall without being yanked onto the floor.
- **Hysteresis.** Once a transition starts, competing surface normals are
  ignored for `ORIENTATION_LOCK_MS`. In a corner two faces are legitimately
  "nearest" within a fraction of a voxel, and picking by distance alone is how
  orientation ping-pong starts. Candidates rank by current-support → direction
  of travel → alignment with current up, never by distance.

Fully unit tested, including that no code path can produce a non-axis
orientation.

**She always clings.** Walking into a wall mounts it; walking across an edge
makes the new face your floor. Either way gravity, the collision box, the
movement plane and the camera all rotate into that face's frame. There is no
grip button and no release button — "am I gripping?" was a mode the player had
to track for no benefit. **Jumping is the only way off**, which makes letting go
a deliberate act with a cost, and is also how an ant behaves.

Sticking used to be gated on being underground. It isn't any more: a wall
behaving differently depending on which side of an invisible line it stood on
was arbitrary. Mounting still needs *committed* movement into the wall
(`INPUT_COMMIT_THRESHOLD`) and still respects the hysteresis lock, and step-up
runs first — so `blocked` only means a rise she genuinely cannot walk over, and
brushing a wall while lining up a dig can't flip you.

Underground, jumping has to suspend weightlessness too, or the leap would be
cancelled by the very rule it exists to escape. An `airborne` flag holds gravity
on until she lands.

### The camera must not move

This was the thing that made surface walking feel wrong, and it took a while to
name. `yaw` and `pitch` are measured **inside** a frame, so the same numbers
mean a different world direction once `up` changes. Nothing re-solved them — so
you could be looking straight down a shaft, mount its wall, and end up facing
sideways. The slerp smoothed the *journey* while the *destination* was
arbitrary. Mounting was a teleport of your head.

`lookVector` and `reframeLook` in `SurfaceFrame.ts` fix it: capture the
world-space look direction before reorienting, then solve for the yaw and pitch
that reproduce it in the new frame. Only "which way is down" changes.

A unit test round-trips every one of the 36 frame pairs at several yaw/pitch
values and asserts the direction survives. It isn't asserted as *exact*, because
it can't be: a frame cannot express looking precisely along its own up — yaw
stops meaning anything at the pole — so pitch clamps at `MAX_PITCH` and the
error is bounded by exactly that clipped wedge (about 4°). The test asserts that
bound, and separately that the result is exact everywhere the clamp doesn't bite.

The camera still **slerps** into the new frame and swings slightly outward
mid-turn, so it reads as the body crawling around the edge rather than the world
spinning about a stationary head. Physics still snaps between the six frames.

**All six directions are live, ceilings included.** They were locked behind a
`CEILING_UP` guard while walls were being tuned; with the underground frame now
weightless, "up" carries no special meaning down there, and excluding one of the
six was the thing making a tunnel roof behave differently from its walls.

`?debug=1` also reports the current dig speed (`4.8s/cube after 1`). That is
debug-only on purpose: she should just get better and you should feel it, not
watch a stat bar fill.

`?debug=1` shows the live `up` alongside position and speed. The HUD also flags
🪵 `weightless` or 🧗 `gripping` whenever either is in effect, so it is never a
guess which frame the ant is in.

## Not yet

Phase C wires in the existing colony sim (`GameState`, `FoodNode`,
`PheromoneField`) and makes a hatched worker playable.

Known gaps: no ant model (you're a floating camera), no surface world beyond
the soil block, no save, no eggs or brood in the den yet, and spoil can't be
dropped into the cell you're standing in — which is correct, but means a
one-voxel-wide shaft has nowhere to backfill from the inside.

Open questions from the last tuning pass: concave wall-to-wall corners still
aren't special-cased; there are no comfort settings for the camera turn
(smooth / fast / snap, roll off, horizon assistance); and nothing cues the grip
affordance except the button label — a contact indicator, a scraping sound, or a
reticle icon would each carry it better.
