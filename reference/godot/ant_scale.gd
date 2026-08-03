class_name AntScale
extends RefCounted

## The world's unit contract, ported from the web build.
##
## One world unit == one voxel == 5 mm. The whole dig prototype is tuned against
## this and nothing else: speeds are in voxels/s, gravity is 12 voxels/s^2, and
## the queen's body is 0.7 x 0.6 voxels so she fits down a one-voxel shaft both
## standing and lying against a wall. Changing VOXEL_MM rescales the world's
## real-world size without touching a single tuned number.
##
## See Thronemound-Colony-Sim/docs/DIG_PROTOTYPE.md "Scale".

const VOXEL_MM := 5.0
const WORLD_SIZE := 128
const SURFACE_Y := 96

## Body box from the web build. Deliberately small: at the original 1.6 x 0.9
## she could not rotate inside a one-voxel tunnel, so gripping silently failed
## in exactly the tunnels the game is made of.
const EYE_HEIGHT := 0.7
const BODY_RADIUS := 0.3

## The imported fire_ant_queen.glb is 1.7 units tall in its own space. Scaling
## it to EYE_HEIGHT puts her at 1.80 units long -> 9.0 mm, which is a real
## Solenopsis invicta queen. The number is derived, not eyeballed.
const MODEL_HEIGHT := 1.7
const MODEL_SCALE := EYE_HEIGHT / MODEL_HEIGHT

## Locomotion bands, anchored to measured ant data rather than feel:
## S. invicta runs at ~1.96 cm/s, and ants cover ~9 body lengths per second,
## which at 5 mm/voxel puts a real run near 4 voxels/s.
const CRAWL_SPEED := 2.0
const WALK_SPEED := 4.5
const RUN_SPEED := 7.5

## Square-cube law: an ant has huge drag relative to its mass, so terminal
## velocity is low and falls are effectively harmless.
const GRAVITY := 12.0
const TERMINAL_VELOCITY := -30.0

## Jump is expressed as a HEIGHT with launch speed derived from it, because the
## two are coupled -- hand-tuning them separately already went wrong once in the
## web build (softening gravity turned a 1.4-voxel hop into a 3.2-voxel leap).
const JUMP_HEIGHT := 1.45

const WALK_ACCEL := 14.0
const WALK_DECEL := 22.0

static func jump_speed() -> float:
	return sqrt(2.0 * GRAVITY * JUMP_HEIGHT)

## Millimetres for a length in world units -- for debug readouts.
static func to_mm(units: float) -> float:
	return units * VOXEL_MM
