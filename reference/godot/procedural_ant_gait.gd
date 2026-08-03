class_name ProceduralAntGait
extends Node3D

## Six world-anchored feet for the imported queen rig.
##
## The governing idea is that the GLB's bind pose is already a correct standing
## ant -- body carried high, femurs raised, tarsi angled down onto the soil.  So
## every frame resets the skeleton to that pose and then asks IK for the
## smallest correction that puts each claw on the ground under it.  Nothing here
## invents a pose from scratch; it only bends the artist's pose to the terrain.
##
## The target of a planted foot is never moved.  The body advances around it,
## and only an alternating tripod is allowed to swing.

@export_group("Tripod gait")
@export_range(0.1, 0.8, 0.01) var step_trigger := 0.26
@export_range(0.04, 0.3, 0.01) var swing_seconds := 0.14
@export_range(0.03, 0.4, 0.01) var foot_lift := 0.11
## Headroom the claw contact keeps above the soil. Not cosmetic slack: the
## solver lands within a few hundredths of its target, and a claw pinned with
## less headroom than that error simply sinks through the surface. The visible
## claw tip extends below this bone anyway, so it still reads as contact.
@export_range(0.0, 0.12, 0.002) var sole_clearance := 0.04
@export var show_foot_targets := false

@export_group("Grounding")
## How far from its bind-pose home a claw may be planted, horizontally.  Past
## this the leg leaves the shape the artist drew and starts to look dislocated.
@export_range(0.05, 0.9, 0.01) var max_foot_offset := 0.34
## Vertical slack.  A claw may reach this far below its bind height into a
## hollow, or be pushed this far above it by a bump.
@export_range(0.05, 0.9, 0.01) var max_foot_drop := 0.44
@export_range(0.05, 0.9, 0.01) var max_foot_rise := 0.26

## Fractions of a leg's total chain length.  A foot is planted no further out
## than `plant_extension`, and is forced to step once the body has dragged it
## past `max_stance_extension`.  The gap between them is the usable stride.
## The bind pose stands at about 0.79, so these bracket the artist's stance.
@export_range(0.5, 0.98, 0.01) var plant_extension := 0.86
@export_range(0.5, 0.99, 0.01) var max_stance_extension := 0.94
## A chain has a minimum reach as well as a maximum. The rim search in _plant
## walks a foothold in toward the hip, and without this floor it can settle on a
## point folded up underneath the joint -- well inside the chain's length, and
## still one the chain cannot bend tightly enough to touch.
@export_range(0.1, 0.9, 0.01) var min_extension := 0.68

## Height of the lowest body plate above the sole plane, in world units.  The
## model is lifted whenever soil under her footprint would otherwise pass
## through this line.
@export_range(0.0, 0.7, 0.01) var belly_height := 0.15
@export_range(0.0, 0.2, 0.005) var belly_margin := 0.03
@export_range(0.0, 1.0, 0.01) var max_body_lift := 0.55
## Pitch and roll turn about the mesosoma, NOT about the sole plane.  Tilting
## about the feet is what swings the gaster underground on a slope.
@export_range(0.0, 0.7, 0.01) var tilt_pivot_height := 0.30
@export_range(0.0, 0.6, 0.01) var max_tilt := 0.26

## Clearance every bone except the claws must keep above the soil, in world
## units. 0.05 is a quarter of a millimetre at her scale. Set to 0 to switch the
## whole-skeleton check off.
@export_range(0.0, 0.4, 0.005) var bone_clearance := 0.05
## Per-leg headroom cap. Raising the BODY cannot rescue a buried ankle, because
## a planted claw is pinned and the leg just stretches; the only actuator that
## reaches it is that leg's own contact height. This bounds how far a single leg
## may hold its foot off the soil to keep the tarsus above it.
##
## Keep this small. A visibly floating claw is a worse artefact than the
## fraction of a millimetre of ankle it buys back, and at 0.28 a fresh crater
## under her feet saturated it and left a foot 1.4 mm clear of the ground.
@export_range(0.0, 0.5, 0.01) var max_leg_bias := 0.12
## The antennae sweep low and are thin. Holding them to the full body clearance
## would heave her upward every time a feeler brushed the soil.
@export_range(0.0, 0.4, 0.005) var antenna_clearance := 0.015

@export_group("Head tracking")
## How far she can turn her head off-centre, in degrees. A real ant's head
## barely rotates on its neck; this is generous enough to read clearly without
## looking like an owl.
@export_range(0.0, 90.0, 1.0) var max_head_yaw_deg := 22.0
## How far she can nod, in degrees. Down is what matters -- it is what puts her
## mandibles on soil below her rather than straight ahead of her.
@export_range(0.0, 80.0, 1.0) var max_head_pitch_deg := 38.0
## How quickly the head settles onto a new aim, in turns per second.
@export_range(1.0, 40.0, 0.5) var head_rate := 9.0

# Footprint of the body plates, as fractions of body length and width. The
# gait works these into world units once the caste's scale is known.
const BODY_LENGTH_RATIO := 0.46
const BODY_WIDTH_RATIO := 0.40
const STANCE_LENGTH_RATIO := 0.46
const STANCE_WIDTH_RATIO := 0.79

## How much of the head's yaw the gaster swings back against, as a fraction.
## Matching it outright reads as folding in half rather than counterweighting.
const GASTER_COUNTER_RATIO := 0.30

var stance_feet := 6
var max_foot_error := 0.0
var active_tripod := -1
## The anatomy, read off the skeleton rather than hard-coded per caste.
var rig: AntRig

# Every export is normalised to the same height in its own space, so a worker a
# third of the queen's size needs a third of her stride, foot lift and belly
# clearance. These are the exports above multiplied through by the caste's
# gait_scale, which is exactly 1.0 for the queen.
var _step_trigger := 0.0
var _foot_lift := 0.0
var _sole_clearance := 0.0
var _max_foot_offset := 0.0
var _max_foot_drop := 0.0
var _max_foot_rise := 0.0
var _belly_height := 0.0
var _belly_margin := 0.0
var _max_body_lift := 0.0
var _tilt_pivot := 0.0
var _bone_clearance := 0.0
var _max_leg_bias := 0.0
var _antenna_clearance := 0.0
var _body_half_length := 0.0
var _body_half_width := 0.0
var _stance_half_length := 0.0
var _stance_half_width := 0.0
var _probe_above := 0.0
var _probe_below := 0.0

var _body: CharacterBody3D
var _model: Node3D
var _skeleton: Skeleton3D
var _ik: CCDIK3D
var _legs: Array[Dictionary] = []
var _started := false
var _last_tripod := 1
var _was_on_floor := false
var _clock := 0.0
var _digging := 0.0
var _targets_visible := false
var _foot_error_parts: Array[String] = []
var _was_moving := false
var _settle_tripods := 0
var _lift := 0.0
var _pitch := 0.0
var _roll := 0.0
var _model_scale := 1.0
## Bones exempt from the clearance check because contact is their whole job.
var _claw_bones := {}
var _antenna_bones := {}
## Below the knee: owned by the per-leg contact bias, not by the body lift.
var _lower_leg_bones := {}
## Per-feeler sweep scale, 1.0 free and 0.0 folded back to the bind pose.
var _antenna_damp := [1.0, 1.0]
## Where her head is aimed relative to her body, in radians, eased toward the
## camera. Yaw tracks always; pitch only in the modes that use her mandibles.
var _head_yaw := 0.0
var _head_pitch := 0.0
## How much of the wanted nod there is actually room for, 1.0 free and lower
## once her feelers are in the soil. See _update_antenna_damping.
var _head_aim_allow := 1.0


func _ready() -> void:
	process_priority = 20
	_body = get_parent() as CharacterBody3D
	_model = _body.get_node("Model") as Node3D
	# By TYPE, not by name. Only the queen's import renames her skeleton to
	# GeneralSkeleton; the worker and major worker both call theirs Skeleton3D.
	var skeletons := _model.find_children("*", "Skeleton3D", true, false)
	if skeletons.is_empty():
		push_error("ProceduralAntGait: no Skeleton3D under the model")
		set_physics_process(false)
		return
	_skeleton = skeletons[0] as Skeleton3D

	rig = AntRig.discover(_skeleton)
	if not rig.valid:
		push_error("ProceduralAntGait: could not read the rig -- " + rig.problem)
		set_physics_process(false)
		return

	var declared = _body.get("model_scale")
	_model_scale = float(declared) if declared != null else _model.scale.y
	_apply_caste_scale()
	# Pose first, build second: the IK chains cache their home positions from the
	# skeleton, so the body must already be sitting the way it will sit.
	_write_model_transform()
	_build_ik()
	_targets_visible = show_foot_targets


## Convert the tunables, which are all authored at queen size, into the world
## units this particular caste works in.
func _apply_caste_scale() -> void:
	var factor := 1.0
	var declared = _body.get("gait_scale")
	if declared != null and float(declared) > 0.0:
		factor = float(declared)
	var body_length := AntCaste.ART_HEIGHT * _model_scale / AntCaste.QUEEN_STAND * 1.85

	_step_trigger = step_trigger * factor
	_foot_lift = foot_lift * factor
	_sole_clearance = sole_clearance * factor
	_max_foot_offset = max_foot_offset * factor
	_max_foot_drop = max_foot_drop * factor
	_max_foot_rise = max_foot_rise * factor
	_belly_height = belly_height * factor
	_belly_margin = belly_margin * factor
	_max_body_lift = max_body_lift * factor
	_tilt_pivot = tilt_pivot_height * factor
	# These two fight terrain roughness, and roughness does NOT scale with the
	# ant: the density grid samples every 2.5 mm whatever is walking on it, so a
	# minor worker crosses the same bumps a queen does at a third the size.
	# Scaling their margins down linearly leaves her ploughing through lumps the
	# queen steps over, so they shrink by the square root instead. The queen's
	# factor is 1.0, so this is identity for her either way.
	var roughness := sqrt(factor)
	_bone_clearance = bone_clearance * roughness
	_max_leg_bias = max_leg_bias * roughness
	_antenna_clearance = antenna_clearance * roughness
	_body_half_length = body_length * BODY_LENGTH_RATIO
	_body_half_width = body_length * BODY_WIDTH_RATIO * 0.5
	_stance_half_length = body_length * STANCE_LENGTH_RATIO
	_stance_half_width = body_length * STANCE_WIDTH_RATIO * 0.5
	# Shallow on purpose: a probe must not see over the lip of a wall she is
	# climbing, and "shallow" means shallow relative to HER, not to the queen.
	_probe_above = 1.0 * factor
	_probe_below = 2.5 * factor


func _build_ik() -> void:
	var targets := Node3D.new()
	targets.name = "FootTargets"
	add_child(targets)

	_ik = CCDIK3D.new()
	_ik.name = "SixLegCCD"
	_ik.setting_count = rig.legs.size()
	# _animate_base_pose resets to the bind pose every frame, so the solver gets
	# no warm start from the previous frame and has to converge from scratch each
	# time. That is what buys the stable, artist-shaped legs, and it is why the
	# iteration budget has to be generous rather than the usual handful.
	_ik.max_iterations = 32
	# A gentle per-iteration cap.  The targets sit close to the bind pose, so the
	# solver only ever needs small corrections; letting it swing hard is how a
	# joint ends up inverted.
	_ik.angular_delta_limit = 0.4
	_ik.min_distance = 0.0008
	_ik.deterministic = true
	_ik.influence = 1.0
	_ik.active = true
	_skeleton.add_child(_ik)

	for index in rig.legs.size():
		var definition: Dictionary = rig.legs[index]
		var bones: Array = definition["bones"]
		var root_index := _skeleton.find_bone(bones[0])
		var claw_index: int = definition["claw"]

		var target := Node3D.new()
		target.name = String(definition["slot"]).to_pascal_case()
		targets.add_child(target)
		target.top_level = true
		target.global_position = _bone_world(claw_index)
		_add_target_marker(target, int(definition["tripod"]))

		_ik.set_root_bone(index, root_index)
		_ik.set_end_bone(index, claw_index)
		_ik.set_extend_end_bone(index, false)
		_ik.set_target_node(index, _ik.get_path_to(target))

		# The claw and the tiny terminal marker bone that hangs off it are the
		# contact; holding them clear of the soil would lift her off the ground.
		_claw_bones[claw_index] = true
		_claw_bones[definition["terminal"]] = true

		# Split the two actuators by what each can actually move. The body lift
		# owns the coxa and femur, which the thorax carries rigidly. Everything
		# below the knee is owned by that leg's own contact height, because once
		# a claw is planted the hips can rise all they like and the lower leg
		# just stretches to follow.
		for below_knee in range(2, bones.size()):
			var joint := _skeleton.find_bone(bones[below_knee])
			if joint >= 0:
				_lower_leg_bones[joint] = true
				for terminal in _skeleton.get_bone_children(joint):
					_lower_leg_bones[terminal] = true

		var reach := 0.0
		for bone_index in range(1, bones.size()):
			var previous := _skeleton.find_bone(bones[bone_index - 1])
			var current := _skeleton.find_bone(bones[bone_index])
			reach += _bone_world(previous).distance_to(_bone_world(current))

		_legs.append({
			"slot": definition["slot"],
			"tripod": definition["tripod"],
			"bones": bones,
			"root_index": root_index,
			"claw_index": claw_index,
			# Home is stored in model space, so it rides along with every lift,
			# tilt and turn the body makes.
			"home_model": _model.to_local(_bone_world(claw_index)),
			"reach": reach,
			"target": target,
			"anchor": target.global_position,
			"from": target.global_position,
			"landing": target.global_position,
			"phase": 1.0,
			"swinging": false,
			"bias": 0.0,
		})

	for slim in rig.slim_bones:
		_antenna_bones[slim] = true

	if _ik.has_signal("modification_processed"):
		_ik.modification_processed.connect(_measure_foot_error)
	set_targets_visible(_targets_visible)


func _physics_process(delta: float) -> void:
	if _skeleton == null or _legs.is_empty():
		return
	_clock += delta
	var planar_velocity := Vector3(_body.velocity.x, 0.0, _body.velocity.z)
	var speed := planar_velocity.length()
	var moving := speed > 0.05
	if not moving and _was_moving:
		_settle_tripods = 2
	_was_moving = moving
	var on_floor := _body.is_on_floor()

	if on_floor:
		_apply_model_pose(delta)
	# Both of these read the pose the solver produced last frame, so they must
	# run before _animate_base_pose wipes it back to bind.
	_update_antenna_damping(delta)
	_update_leg_clearance(delta)
	_update_head_aim(delta)
	_animate_base_pose(speed)
	if on_floor and not _was_on_floor:
		_started = false
	if not on_floor:
		_started = false
		_was_on_floor = false
		stance_feet = 0
		active_tripod = -1
		# Ride the feet along at their bind positions rather than switching the
		# solver off. Turning it off snaps every leg back to the raw bind pose
		# for a frame, which reads as a twitch each time she clears a bump.
		for leg in _legs:
			var tucked := _home_world(leg)
			leg["anchor"] = tucked
			leg["from"] = tucked
			leg["landing"] = tucked
			leg["phase"] = 1.0
			leg["swinging"] = false
			(leg["target"] as Node3D).global_position = tucked
		return
	_ik.active = true
	_was_on_floor = true

	if not _started:
		_reset_anchors_now()

	var airborne := false
	stance_feet = 0
	active_tripod = -1
	for leg in _legs:
		if bool(leg["swinging"]):
			airborne = true
			active_tripod = int(leg["tripod"])
			var phase := minf(1.0, float(leg["phase"]) + delta / _swing_duration(speed))
			leg["phase"] = phase
			var eased := phase * phase * (3.0 - 2.0 * phase)
			# The arc is struck in her frame, so a foot swung along a wall lifts
			# away from the wall rather than toward the sky.
			var from := _body.to_local(leg["from"])
			var landing := _body.to_local(leg["landing"])
			var point := from.lerp(landing, eased)
			# Clear whatever is between lift-off and touchdown. Interpolating
			# height alone drags the claw straight through any bump on the way.
			point.y = maxf(point.y, _height(point.x, point.z) + _contact_height(leg))
			point.y += sin(phase * PI) * foot_lift
			var world := _body.to_global(point)
			if phase >= 1.0:
				leg["swinging"] = false
				# Re-solve the landing against soil as it is now, not as it was
				# when the step began -- a dig may have moved it mid-swing.
				world = _plant(leg["landing"], leg)
				leg["anchor"] = world
			else:
				_update_marker(leg, true)
			(leg["target"] as Node3D).global_position = world
		else:
			stance_feet += 1
			(leg["target"] as Node3D).global_position = _hold(leg)
			_update_marker(leg, false)

	# Finish the whole tripod before another one is allowed to leave the soil.
	# At least three feet are therefore planted at every instant.
	if not airborne:
		var due := 1 - _last_tripod
		var travelling := moving or _settle_tripods > 0
		# Whichever tripod needs it most goes, preferring the one whose turn it
		# is.  Strict alternation deadlocks: a leg strung out by a turn can be in
		# the tripod that is NOT due, and the due tripod has no reason to move,
		# so nothing steps and the leg stays stretched.
		if _tripod_urgency(due, travelling, moving) >= 1.0:
			_begin_tripod(due, planar_velocity)
		elif _tripod_urgency(_last_tripod, travelling, moving) >= 1.0:
			_begin_tripod(_last_tripod, planar_velocity)
		if not moving and _settle_tripods > 0:
			_settle_tripods -= 1


## How badly one tripod needs to step. Normalised so 1.0 always means "now",
## whichever of the two reasons got it there.
func _tripod_urgency(tripod: int, travelling: bool, moving: bool) -> float:
	var threshold := _step_trigger if moving else _step_trigger * 0.55
	var urgency := 0.0
	for leg in _legs:
		if int(leg["tripod"]) != tripod:
			continue
		var anchor: Vector3 = leg["anchor"]
		# A leg strung out past what it can physically span has to step even if
		# the body has barely moved. Turning on the spot swings the hips a long
		# way while the body's own travel stays near zero.
		var span := _bone_world(int(leg["root_index"])).distance_to(anchor)
		urgency = maxf(urgency, span / maxf(
			0.0001, float(leg["reach"]) * max_stance_extension))
		if travelling:
			var home := _home_world(leg)
			urgency = maxf(urgency, Vector2(
				anchor.x - home.x, anchor.z - home.z).length() / threshold)
	return urgency


## Keep hold of a planted foothold, or skid to one she can still hold.
##
## At speed the body covers more ground per stride cycle than a leg can span,
## and a tripod cannot always step the instant it wants to. Rather than let the
## solver strain at an anchor that is out of range -- which drags the claw
## through the soil or leaves it hanging in the air -- let the claw slip toward
## the hip. A skid is what a real claw does when it loses purchase, and at 5 mm
## per world unit it is invisible; a leg stretched past its own length is not.
func _hold(leg: Dictionary) -> Vector3:
	var anchor := _body.to_local(leg["anchor"])
	var hip := _body.to_local(_bone_world(int(leg["root_index"])))
	var span := anchor.distance_to(hip)
	var longest := float(leg["reach"]) * max_stance_extension
	var shortest := float(leg["reach"]) * min_extension
	if span <= longest and span >= shortest:
		return leg["anchor"]
	if span < 0.0001:
		return leg["anchor"]

	# Two-sided. Over-extension is the obvious failure, but a foot can end up too
	# FOLDED as well -- she settles onto it after a dig drops the soil under her,
	# the hip comes down toward the claw, and the chain cannot bend that tightly.
	# The claw skids outward for the same reason it skids inward.
	var wanted := clampf(span, shortest, longest)
	var flat := Vector2(hip.x, hip.z).lerp(
		Vector2(anchor.x, anchor.z), wanted / span)
	var slid := _body.to_global(
		Vector3(flat.x, _height(flat.x, flat.y) + _contact_height(leg), flat.y))
	leg["anchor"] = slid
	return slid


# ---------------------------------------------------------------------------
# Body carriage
# ---------------------------------------------------------------------------

func _apply_model_pose(delta: float) -> void:
	# The model's own axes, expressed in the body frame: pitch and roll are
	# applied after yaw, so they turn about these and not about the body's.
	var flat := _body.global_transform.basis.inverse() * _model.global_transform.basis
	var right := flat.x.normalized()
	var forward := flat.z.normalized()

	# Lean to fit the slope the stance spans.  IK can bend a foot to a point, but
	# no finite leg reaches a downhill point if the thorax stays ruler-flat.
	var front_y := _height(
		forward.x * _stance_half_length, forward.z * _stance_half_length)
	var back_y := _height(
		-forward.x * _stance_half_length, -forward.z * _stance_half_length)
	var right_y := _height(
		right.x * _stance_half_width, right.z * _stance_half_width)
	var left_y := _height(
		-right.x * _stance_half_width, -right.z * _stance_half_width)
	var wanted_pitch := clampf(
		-atan2(front_y - back_y, _stance_half_length * 2.0), -max_tilt, max_tilt)
	var wanted_roll := clampf(
		atan2(right_y - left_y, _stance_half_width * 2.0), -max_tilt, max_tilt)

	# Ride high enough that no soil under the body plates pokes through her.  The
	# capsule that carries her is a fraction of her width, so without this the
	# terrain beside the capsule simply intersects the gaster.
	var wanted_lift := 0.0
	for length_step in [-1.0, -0.5, 0.0, 0.5, 1.0]:
		for width_step in [-1.0, 0.0, 1.0]:
			var sample := forward * (_body_half_length * float(length_step)) \
				+ right * (_body_half_width * float(width_step))
			wanted_lift = maxf(
				wanted_lift, _height(sample.x, sample.z) - _belly_height + _belly_margin)
	# ...and high enough that no BONE is inside the soil either. The footprint
	# samples above only cover the columns they happen to land in; this is the
	# check that actually answers "is any part of her buried".
	wanted_lift = maxf(wanted_lift, _deepest_bone_penetration())
	wanted_lift = clampf(wanted_lift, 0.0, _max_body_lift)

	var weight := clampf(delta * 8.0, 0.0, 1.0)
	_pitch = lerp_angle(_pitch, wanted_pitch, weight)
	_roll = lerp_angle(_roll, wanted_roll, weight)
	# Asymmetric on purpose. Getting out of the soil is urgent and settling back
	# down is not, so she rises four times faster than she sinks. A symmetric
	# filter lags through exactly the fast transitions -- mounting a wall, a dig
	# under her feet -- where the correction is needed most.
	_lift = lerpf(_lift, wanted_lift, clampf(
		delta * (32.0 if wanted_lift > _lift else 8.0), 0.0, 1.0))
	_write_model_transform()


## Height this leg holds its claw above the soil: the shared sole clearance plus
## whatever extra that particular leg currently needs to keep the tarsus above
## it on a slope.
func _contact_height(leg: Dictionary) -> float:
	return _sole_clearance + float(leg["bias"])


## Raise a leg that is cutting into a slope.
##
## The claw can sit perfectly on the surface while the tarsus behind it ploughs
## into the rising ground it came from. Body lift is no use here -- the claw is
## pinned, so lifting the hips only stretches the leg -- so each leg carries its
## own contact offset instead.
func _update_leg_clearance(delta: float) -> void:
	if _bone_clearance <= 0.0:
		return
	for leg in _legs:
		var deepest := 0.0
		for bone_name in leg["bones"]:
			var index := _skeleton.find_bone(bone_name)
			if index < 0 or _claw_bones.has(index):
				continue
			var local := _body.to_local(_bone_world(index))
			deepest = maxf(deepest, _height(local.x, local.z) + _bone_clearance - local.y)
		# Integrate with a deadband. Dropping the bias the moment the bone clears
		# makes a bang-bang controller that buries the joint again on the very
		# next frame, so the bias is only given back once there is real slack.
		var bias := float(leg["bias"])
		var wanted := bias
		if deepest > 0.0:
			wanted = clampf(bias + deepest, 0.0, _max_leg_bias)
		elif -deepest > bone_clearance:
			wanted = maxf(0.0, bias + deepest + _bone_clearance)
		# Same asymmetry as everywhere else: out of the soil now, back down slowly.
		leg["bias"] = lerpf(bias, wanted, clampf(
			delta * (30.0 if wanted > bias else 4.0), 0.0, 1.0))


## Fold a feeler back toward its bind pose when its tip is in the soil.
##
## An ant touches the ground with her antennae constantly -- that is what they
## are for -- so heaving the entire body upward every time one grazes is the
## wrong correction. Damping the sweep toward bind is the right one, and it
## needs no knowledge of which way a given feeler would have to bend.
func _update_antenna_damping(delta: float) -> void:
	var worst := INF
	for side in rig.antenna_tips.size():
		var index: int = rig.antenna_tips[side]
		if index < 0 or side >= _antenna_damp.size():
			continue
		var local := _body.to_local(_bone_world(index))
		var clearance := local.y - _height(local.x, local.z) - antenna_clearance
		worst = minf(worst, clearance)
		var wanted := 1.0 if clearance > 0.0 else clampf(1.0 + clearance * 6.0, 0.0, 1.0)
		# Retract fast, extend slowly -- the same asymmetry as the body lift.
		_antenna_damp[side] = lerpf(_antenna_damp[side], wanted, clampf(
			delta * (24.0 if wanted < _antenna_damp[side] else 4.0), 0.0, 1.0))

	# A buried feeler means the head is turned further than there is room for.
	#
	# Damping alone cannot fix this: it folds a feeler toward its BIND pose,
	# and once the head has moved the bind pose is already underground. The
	# antennae hang off the head, so the only actuator that reaches them is
	# the head's own aim -- and countering it on the antenna bone does not
	# work either, because their rotation axes do not line up with the head's.
	#
	# This gates BOTH axes. Measured on flat ground, yaw is what actually
	# buries a feeler: swinging the head sideways sweeps an antenna down into
	# the soil beside her, where nodding mostly moves them fore-and-aft.
	#
	# Backing the head off is also what a real ant does. The feelers lead;
	# they find the ground before her face does, and she stops there.
	# Integrate, the same way the per-leg clearance bias does, with the same
	# deadband. A proportional term cannot win here: less nod lifts the feeler,
	# which restores the nod, which buries it again -- it settles at a steady
	# fraction of the burial instead of clearing it. Accumulating drives the
	# error to zero and holds there.
	if worst == INF:
		return
	var wanted_allow := _head_aim_allow
	if worst < 0.0:
		wanted_allow = clampf(_head_aim_allow + worst * 14.0, 0.0, 1.0)
	elif worst > antenna_clearance:
		wanted_allow = minf(1.0, _head_aim_allow + worst * 2.0)
	_head_aim_allow = lerpf(_head_aim_allow, wanted_allow, clampf(
		delta * (24.0 if wanted_allow < _head_aim_allow else 3.0), 0.0, 1.0))


## Aim her head where the camera is looking.
##
## Yaw tracks in every mode: an ant looks where she is going, and turning the
## head is how she does it without swinging her whole body. Pitch is gated on
## the mode, because a head permanently tipped toward whatever the camera
## points at reads as a bull charging with its head down during plain walking.
## In the working modes it is the whole point -- it is what puts her mandibles
## on soil below her instead of on air straight ahead.
func _update_head_aim(delta: float) -> void:
	var wanted_yaw := 0.0
	var wanted_pitch := 0.0
	if _body.has_method("get_head_aim"):
		var aim: Vector2 = _body.get_head_aim()
		wanted_yaw = clampf(aim.x, -1.0, 1.0) * deg_to_rad(max_head_yaw_deg) \
			* _head_aim_allow
		wanted_pitch = clampf(aim.y, -1.0, 1.0) * deg_to_rad(max_head_pitch_deg)
		# Only nodding DOWN can bury a feeler; looking up is always free.
		if wanted_pitch > 0.0:
			wanted_pitch *= _head_aim_allow
	var weight := clampf(delta * head_rate, 0.0, 1.0)
	_head_yaw = lerp_angle(_head_yaw, wanted_yaw, weight)
	_head_pitch = lerp_angle(_head_pitch, wanted_pitch, weight)


## How far the worst-buried bone would have to rise to clear the soil.
##
## This runs BEFORE _animate_base_pose resets the skeleton, so it reads the pose
## the solver actually produced last frame, and feeds the correction into this
## frame's lift. It is a one-frame-late proportional controller, which is fine
## because she moves a fraction of a voxel per frame.
##
## Claws are exempt -- they are supposed to be touching. Everything else gets
## _bone_clearance, and the antennae get a slimmer margin so a grazing feeler
## does not heave the entire body upward.
func _deepest_bone_penetration() -> float:
	if _bone_clearance <= 0.0:
		return 0.0
	var deepest := 0.0
	for index in _skeleton.get_bone_count():
		if _claw_bones.has(index) or _lower_leg_bones.has(index):
			continue
		var local := _body.to_local(_bone_world(index))
		var margin := _antenna_clearance if _antenna_bones.has(index) else bone_clearance
		deepest = maxf(deepest, _height(local.x, local.z) + margin - local.y)
	return deepest


func _write_model_transform() -> void:
	var yaw := 0.0
	if _body.has_method("get_model_yaw"):
		yaw = _body.get_model_yaw()
	var basis := Basis.from_euler(Vector3(_pitch, yaw, _roll))
	_model.basis = basis.scaled(Vector3.ONE * _model_scale)
	# Rotate about the mesosoma instead of the sole plane: put the pivot back
	# where it started after the basis has moved it.
	var pivot := Vector3(0.0, _tilt_pivot, 0.0)
	_model.position = Vector3(0.0, _tilt_pivot + _lift, 0.0) - basis * pivot


# ---------------------------------------------------------------------------
# Feet
# ---------------------------------------------------------------------------

func _begin_tripod(tripod: int, planar_velocity: Vector3) -> void:
	var duration := _swing_duration(planar_velocity.length())
	for leg in _legs:
		if int(leg["tripod"]) != tripod:
			continue
		var home := _home_world(leg)
		leg["from"] = leg["anchor"]
		leg["landing"] = _plant(home + planar_velocity * duration * 0.40, leg)
		leg["phase"] = 0.0
		leg["swinging"] = true
	_last_tripod = tripod
	active_tripod = tripod
	stance_feet = 3


func _plant(wanted_world: Vector3, leg: Dictionary) -> Vector3:
	## Resolve a claw contact.  Everything here is a clamp toward the bind pose
	## rather than a search away from it: a foot that wanders far from where the
	## artist drew it reads as a dislocation no matter how well it is grounded.
	var home := _body.to_local(_home_world(leg))
	var hip := _body.to_local(_bone_world(int(leg["root_index"])))
	var wanted := _body.to_local(wanted_world)
	var reach := float(leg["reach"]) * plant_extension

	var offset := Vector2(wanted.x - home.x, wanted.z - home.z)
	if offset.length() > max_foot_offset:
		offset = offset.normalized() * max_foot_offset
	var ideal := Vector2(home.x + offset.x, home.z + offset.y)
	var hip_flat := Vector2(hip.x, hip.z)

	# A vertical probe through a fresh scoop lands on a pit floor no leg can
	# reach, and the claw is left hanging in mid-air over the hole.  Walk the
	# contact back toward the hip until it finds soil the chain can actually
	# stand on -- the behaviour of a real foot feeling for the rim.  The retreat
	# stops at 75% of the way in, so she never plants underneath herself.
	#
	# Every candidate sits ON the soil.  max_foot_rise/drop steer which candidate
	# gets chosen; they never move the claw off the ground, because a claw
	# clamped to a height the terrain does not have is a claw either buried in a
	# rise or hovering over a dip.
	var best := Vector3.ZERO
	var best_score := INF
	for step in 7:
		var flat := ideal.lerp(hip_flat, float(step) / 6.0 * 0.75)
		var candidate := Vector3(
			flat.x, _height(flat.x, flat.y) + _contact_height(leg), flat.y)
		var span_length := hip.distance_to(candidate)
		var overreach := maxf(0.0, span_length - reach)
		var underreach := maxf(0.0, float(leg["reach"]) * min_extension - span_length)
		var strain := maxf(0.0, candidate.y - home.y - _max_foot_rise) \
			+ maxf(0.0, home.y - _max_foot_drop - candidate.y)
		if overreach <= 0.0 and underreach <= 0.0 and strain <= 0.0:
			return _body.to_global(candidate)
		# Retreating is mildly unwanted; a leg reaching past its own length,
		# folded up under itself, or standing at an absurd height are strongly
		# unwanted.
		var score := float(step) * 0.01 \
			+ (overreach + underreach) * 12.0 + strain * 4.0
		if score < best_score:
			best_score = score
			best = candidate

	# Nothing underfoot is both reachable and at a sane height.  Take the best
	# compromise and pull it back inside the chain's working range: better a
	# short leg than one straightened into a spike or crumpled under the hip.
	var span := best - hip
	var shortest := float(leg["reach"]) * min_extension
	if span.length() > reach:
		best = hip + span.normalized() * reach
	elif span.length() < shortest and span.length() > 0.0001:
		best = hip + span.normalized() * shortest
	return _body.to_global(best)


func _swing_duration(speed: float) -> float:
	# Fast travel shortens swing time; it does not leave the other tripod waiting
	# in the air.  The 45% ceiling guarantees a visible six-feet-down handoff.
	if speed <= 0.05:
		return swing_seconds
	return maxf(0.055, minf(swing_seconds, (_step_trigger * 2.0 / speed) * 0.45))


func _home_world(leg: Dictionary) -> Vector3:
	return _model.to_global(leg["home_model"])


func _reset_anchors_now() -> void:
	for leg in _legs:
		var home := _plant(_home_world(leg), leg)
		leg["anchor"] = home
		leg["from"] = home
		leg["landing"] = home
		leg["phase"] = 1.0
		leg["swinging"] = false
		(leg["target"] as Node3D).global_position = home
	_last_tripod = 1
	stance_feet = 6
	active_tripod = -1
	_started = true


func reset_anchors() -> void:
	_started = false


func set_digging(strength: float) -> void:
	_digging = clampf(strength, 0.0, 1.0)


func set_targets_visible(visible: bool) -> void:
	_targets_visible = visible
	for leg in _legs:
		var marker := (leg["target"] as Node3D).get_node_or_null("Marker") as MeshInstance3D
		if marker:
			marker.visible = visible


func toggle_targets() -> void:
	set_targets_visible(not _targets_visible)


func foot_error_report() -> String:
	return " mm, ".join(_foot_error_parts) + " mm"


func _animate_base_pose(speed: float) -> void:
	# Back to the artist's pose every frame.  IK then bends away from it by as
	# little as the terrain allows, which is why the legs keep their drawn shape.
	#
	# Every bone here comes from AntRig, not from a name. These were hard-coded
	# queen bone names, which silently animated the WRONG bones on the major
	# worker -- her head is Bone_037 and her petiole Bone_008, where the queen's
	# are Bone_002 and Bone_006. Same reason the legs are discovered.
	_skeleton.reset_bone_poses()
	var moving := clampf(speed / 2.4, 0.0, 1.0)
	var sway := sin(_clock * (5.0 + speed * 1.8)) * 0.025 * moving
	_rotate_bone(0, Vector3(_digging * 0.11, 0.0, sway))
	# The gaster counter-rotates against the head: an ant turning to look at
	# something swings her abdomen the other way to balance it. Held to a
	# fraction of the head's yaw, because matching it looks like she is folding
	# in half rather than counterweighting.
	_rotate_bone(rig.gaster_root, Vector3(
		-_digging * 0.05,
		-sway * 0.6 - _head_yaw * GASTER_COUNTER_RATIO,
		-sway * 1.7))
	# Digging tips her whole head down; look tracking aims it. They add, so she
	# can still nose further down into a hole she is already looking into.
	_rotate_bone(rig.head_bone, Vector3(
		_digging * 0.34 + _head_pitch, _head_yaw, 0.0))
	# Damping folds an antenna back toward its bind pose, which is clear of the
	# soil by construction. That is the whole trick: it needs no knowledge of
	# which way is "up" for a given feeler, and it never fights the body lift.
	for side in rig.antenna_roots.size():
		if side >= _antenna_damp.size():
			break
		var damp: float = _antenna_damp[side] * (1.0 + _digging)
		var phase := 1.9 if side == 1 else 0.0
		var yaw_phase := 2.4 if side == 1 else 0.0
		_rotate_bone(rig.antenna_roots[side], Vector3(
			sin(_clock * 3.1 + phase) * 0.15 * damp,
			sin(_clock * 2.3 + yaw_phase) * 0.26 * damp, 0.0))


func _rotate_bone(index: int, euler: Vector3) -> void:
	if index < 0 or index >= _skeleton.get_bone_count():
		return
	var authored_pose := _skeleton.get_bone_pose_rotation(index)
	_skeleton.set_bone_pose_rotation(
		index, (authored_pose * Quaternion.from_euler(euler)).normalized())


# ---------------------------------------------------------------------------
# The body frame
#
# Everything below works in the queen's own space, where +Y is whatever she is
# standing on -- world up on soil, the wall normal on a wall. QueenController
# rotates the body node into that frame, so the arithmetic here is the same
# arithmetic that worked when up was always world Y. It is only the frame that
# moved.
# ---------------------------------------------------------------------------

## Height of the soil above the body plane in a body-local column, measured
## along her own up axis. The direct replacement for the old world-Y raycast.
func _height(x: float, z: float) -> float:
	# Start the probe just above her own back, not high overhead. A ray dropped
	# from far above finds the TOP of a cliff she is standing at the foot of,
	# and reports the soil as metres above her head.
	var from := _body.to_global(Vector3(x, _probe_above, z))
	var to := _body.to_global(Vector3(x, -_probe_below, z))
	var query := PhysicsRayQueryParameters3D.create(from, to, 1, [_body.get_rid()])
	query.collide_with_areas = false
	query.hit_back_faces = true
	var hit := _body.get_world_3d().direct_space_state.intersect_ray(query)
	if not hit.is_empty():
		return _body.to_local(hit["position"]).y
	return -0.08


## Signed distance from a world point to the soil along her up axis. Positive
## is clear of the soil, negative is buried in it.
func soil_clearance(point: Vector3) -> float:
	var local := _body.to_local(point)
	return local.y - _height(local.x, local.z)


## Where her mandibles actually meet the world: the average tip position of
## whatever she has, one fused pair for the queen or two hinged ones for the
## workers. Reach checks should measure from here, not from the body origin --
## a dig target can be well within touching distance of her thorax and still
## be nowhere near her mouth.
func mouth_position() -> Vector3:
	if rig.mandible_tips.is_empty():
		return _body.global_position
	var sum := Vector3.ZERO
	for tip in rig.mandible_tips:
		sum += _bone_world(tip)
	return sum / rig.mandible_tips.size()


## Average root-to-tip length of her mandibles, in world units. She cannot
## physically gouge a bite deeper than her own jaws reach.
func mandible_reach() -> float:
	if rig.mandible_roots.is_empty():
		return 0.0
	var total := 0.0
	for index in rig.mandible_roots.size():
		total += _bone_world(rig.mandible_roots[index]).distance_to(
			_bone_world(rig.mandible_tips[index]))
	return total / rig.mandible_roots.size()


func _bone_world(index: int) -> Vector3:
	return _skeleton.global_transform * _skeleton.get_bone_global_pose(index).origin


func _measure_foot_error() -> void:
	max_foot_error = 0.0
	_foot_error_parts.clear()
	for leg in _legs:
		var claw := _bone_world(int(leg["claw_index"]))
		var error := claw.distance_to((leg["target"] as Node3D).global_position)
		max_foot_error = maxf(max_foot_error, error)
		_foot_error_parts.append("%s=%.3f" % [leg["slot"], error * 5.0])


func _add_target_marker(target: Node3D, tripod: int) -> void:
	var marker := MeshInstance3D.new()
	marker.name = "Marker"
	var sphere := SphereMesh.new()
	sphere.radius = 0.04
	sphere.height = 0.08
	sphere.radial_segments = 10
	sphere.rings = 6
	marker.mesh = sphere
	var material := StandardMaterial3D.new()
	material.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED
	material.albedo_color = Color(0.25, 0.95, 0.55) if tripod == 0 else Color(0.35, 0.68, 1.0)
	material.emission_enabled = true
	material.emission = material.albedo_color
	marker.material_override = material
	marker.visible = false
	target.add_child(marker)


func _update_marker(leg: Dictionary, swinging: bool) -> void:
	if not _targets_visible:
		return
	var marker := (leg["target"] as Node3D).get_node_or_null("Marker") as MeshInstance3D
	if marker:
		marker.scale = Vector3.ONE * (1.45 if swinging else 1.0)
