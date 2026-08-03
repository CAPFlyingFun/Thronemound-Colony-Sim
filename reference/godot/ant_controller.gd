class_name AntController
extends CharacterBody3D

## Third-person driver for any of the three fire ant castes.
##
## The caste is chosen before the node enters the tree; the model, its scale,
## the collision capsule, the camera distance and the walk and run bands are all
## derived from it. ProceduralAntGait then reads the skeleton it finds and works
## out the anatomy for itself, so nothing here is caste-specific in code.
##
## She walks in her OWN frame rather than the world's: the body node is rotated
## so its +Y is whatever surface she is standing on, which is what lets the same
## movement code carry her up a vertical face. See _align_to_surface.

@export_group("Camera")
## The web build runs 90 degrees. Wider than ~90 starts to fisheye at ant scale,
## where everything interesting is within a couple of centimetres.
@export_range(40.0, 120.0, 1.0) var fov := 90.0:
	set(value):
		fov = value
		if is_instance_valid(_camera):
			_camera.fov = value

## Distance from the pivot to the eye, in voxels. 2.0 == 1 cm behind her.
@export_range(0.0, 12.0, 0.1) var camera_distance := 2.2:
	set(value):
		camera_distance = value
		if is_instance_valid(_spring):
			_spring.spring_length = value

@export_range(0.0005, 0.01, 0.0005) var mouse_sensitivity := 0.0022
## Matches MAX_PITCH in the web build: a frame cannot express looking precisely
## along its own up, so pitch clamps just short of the pole.
@export var max_pitch_deg := 86.0

@export_group("Climbing")
## An ant does not care which way is down. The body node is rotated so its own
## +Y is the surface normal, gravity becomes adhesion along -Y, and every other
## system -- camera, model carriage, foot IK -- keeps working unchanged in body
## space. This is the smooth-surface cousin of the browser build's SurfaceFrame:
## same idea, but fitted to a density mesh instead of six discrete cube faces.
@export var climbing := true
## How fast she rolls onto a new surface, in radians per second.
@export_range(1.0, 30.0, 0.5) var align_rate := 9.0
## How far ahead she feels for a wall to mount, in voxels.
@export_range(0.2, 3.0, 0.05) var feeler_length := 0.95
## How much steeper than her current footing a face must be before she treats it
## as a wall to climb rather than ground to walk over.
@export_range(15.0, 80.0, 1.0) var mount_angle_deg := 38.0

@export_group("Caste")
## One of AntCaste.ORDER. Set this before the node enters the tree; the scene
## rebuilds around it rather than trying to hot-swap a live skeleton.
@export var caste := "queen"

@export_group("Model")
## The Meshy/UniRig export faces +Z. Godot's forward is -Z, so the mesh needs a
## half turn to agree with the node it hangs off. If she moonwalks, this is why.
@export_range(-180.0, 180.0, 1.0) var model_yaw_offset_deg := 180.0:
	set(value):
		var previous := model_yaw_offset_deg
		model_yaw_offset_deg = value
		_model_yaw += deg_to_rad(value - previous)
		_apply_model_transform()

@export var model_scale := AntScale.MODEL_SCALE:
	set(value):
		model_scale = value
		_apply_model_transform()

## How fast the body swings around to face where she is walking, in turns/sec.
@export_range(1.0, 40.0, 0.5) var turn_rate := 20.0


@export_group("Feel")
## How quickly the direction she is travelling swings round to the direction the
## stick is asking for, in turns per second. Without this the velocity vector
## snaps from one heading to another the instant a key changes and she skates
## sideways; with it she leans into the turn like something with mass.
@export_range(1.0, 40.0, 0.5) var heading_rate := 7.0
## How quickly the camera rig follows the mouse. High enough to stay responsive,
## low enough to take the stutter out of a body that is also rolling to fit the
## ground under it.
@export_range(5.0, 60.0, 1.0) var camera_rate := 24.0

var _model: Node3D
@onready var _pivot: Node3D = $CameraPivot
@onready var _spring: SpringArm3D = $CameraPivot/SpringArm3D
@onready var _camera: Camera3D = $CameraPivot/SpringArm3D/Camera3D

var _yaw := 0.0
# Start low enough that the center reticle reaches touchable soil beside the
# queen. Players can still orbit up to the full pitch limit with the mouse.
var _pitch := -0.50
var _planar_speed := 0.0
var _mouse_captured := false
# Which way the art is facing. Kept as a plain angle rather than read back out
# of the model basis, because ProceduralAntGait folds pitch and roll into that
# basis and a three-axis basis has no single unambiguous yaw to read back.
var _model_yaw := PI
## Which way is "up" for her, right now. World up on flat soil, the wall normal
## on a wall. Everything below works in the frame this defines.
var _up := Vector3.UP
var _gripping := true
## The direction she is actually travelling, eased toward the input.
var _heading := Vector3.ZERO
var _look := Vector2.ZERO
var _walk_speed := AntScale.WALK_SPEED
var _run_speed := AntScale.RUN_SPEED
## What she is doing with her mandibles. Drives which buttons do what, and
## whether her head tracks the camera in pitch as well as yaw.
var mode := AntMode.DIGGING
## Passed to ProceduralAntGait so it can size stride, foot lift and clearances
## to this caste rather than to the queen.
var gait_scale := 1.0
var caste_title := ""


## The model has to exist before ProceduralAntGait's _ready runs, and Godot
## readies children before their parent. _enter_tree goes the other way --
## parent first -- so this is the only hook that gets there in time.
func _enter_tree() -> void:
	if _model == null:
		_build_caste()


func _ready() -> void:
	_model_yaw = deg_to_rad(model_yaw_offset_deg)
	_apply_model_transform()
	_camera.fov = fov
	_spring.spring_length = camera_distance
	# The arm must not collide with the queen's own body.
	_spring.add_excluded_object(get_rid())
	_capture_mouse(true)


## The yaw ProceduralAntGait should build its model basis around.
func get_model_yaw() -> float:
	return _model_yaw


## Where her head should be pointing, as -1..1 in each axis: x is yaw off her
## body's own facing, y is pitch (positive nods down). ProceduralAntGait scales
## these by its own anatomical limits, so this stays a pure intent signal.
##
## Yaw is the difference between where the camera looks and where her body is
## facing, which is exactly zero while walking straight ahead and grows as the
## camera swings off her heading. Pitch only reports in the working modes.
func get_head_aim() -> Vector2:
	var yaw_offset := wrapf(
		_look.y - (_model_yaw - deg_to_rad(model_yaw_offset_deg)), -PI, PI)
	var yaw := clampf(yaw_offset / (PI * 0.5), -1.0, 1.0)
	if not AntMode.aims_head(mode):
		return Vector2(yaw, 0.0)
	# Camera pitch is negative looking down; her head nods down on positive
	# pitch, hence the sign flip.
	return Vector2(yaw, clampf(-_look.x / deg_to_rad(max_pitch_deg), -1.0, 1.0))


## Step to the next mode in the ring. Returns the new mode's display title.
func cycle_mode(step := 1) -> String:
	mode = AntMode.cycle(mode, step)
	return mode_title()


func mode_title() -> String:
	return AntMode.title(mode)


## Carry the camera across a caste swap, so switching does not spin the view.
func set_look(yaw: float, pitch: float) -> void:
	_yaw = yaw
	_pitch = pitch
	_look = Vector2(pitch, yaw)
	_model_yaw = deg_to_rad(model_yaw_offset_deg) + yaw
	_apply_model_transform()


func get_look() -> Vector2:
	return Vector2(_yaw, _pitch)


## Build the body from the caste table: model, scale, capsule, camera, speeds.
func _build_caste() -> void:
	var config := AntCaste.get_caste(caste)
	caste = config["key"]
	caste_title = config["title"]
	model_scale = config["scale"]
	gait_scale = config["gait_scale"]
	_walk_speed = config["walk_speed"]
	_run_speed = config["run_speed"]

	var packed := load(config["model"]) as PackedScene
	if packed == null:
		push_error("AntController: could not load %s" % config["model"])
		return
	_model = packed.instantiate() as Node3D
	_model.name = "Model"
	add_child(_model)
	move_child(_model, 0)

	var shape := get_node_or_null("CollisionShape3D") as CollisionShape3D
	if shape:
		var capsule := CapsuleShape3D.new()
		capsule.radius = config["capsule_radius"]
		capsule.height = maxf(config["capsule_height"], capsule.radius * 2.0)
		shape.shape = capsule
		# Capsule origin sits at its middle; the body origin is at the soles.
		shape.position = Vector3(0.0, capsule.height * 0.5, 0.0)

	# The camera rides at the same proportions for every caste, so a worker a
	# third of the queen's size is framed the same way rather than filmed from
	# three body-lengths away.
	var pivot := get_node_or_null("CameraPivot") as Node3D
	if pivot:
		pivot.position.y = config["stand"] * 0.79
	var spring := get_node_or_null("CameraPivot/SpringArm3D") as SpringArm3D
	if spring:
		camera_distance = 2.35 * gait_scale
		spring.spring_length = camera_distance
		spring.margin = 0.05 * gait_scale


func _apply_model_transform() -> void:
	if not is_instance_valid(_model):
		return
	# Yaw only. When a gait node is present it overwrites this later in the same
	# frame with the full lift/pitch/roll carriage; this is the fallback pose for
	# a queen with no gait attached.
	_model.transform = Transform3D(
		Basis(Vector3.UP, _model_yaw).scaled(Vector3.ONE * model_scale), Vector3.ZERO)


func _capture_mouse(on: bool) -> void:
	_mouse_captured = on
	Input.mouse_mode = Input.MOUSE_MODE_CAPTURED if on else Input.MOUSE_MODE_VISIBLE


func _unhandled_input(event: InputEvent) -> void:
	if event is InputEventMouseMotion and _mouse_captured:
		_yaw -= event.relative.x * mouse_sensitivity
		_pitch -= event.relative.y * mouse_sensitivity
		_pitch = clampf(_pitch, -deg_to_rad(max_pitch_deg), deg_to_rad(max_pitch_deg))
	elif event is InputEventMouseButton and event.pressed and not _mouse_captured:
		_capture_mouse(true)
	elif event.is_action_pressed("ui_cancel"):
		_capture_mouse(false)


func _physics_process(delta: float) -> void:
	var input := Input.get_vector("move_left", "move_right", "move_forward", "move_back")
	# She only commits to a wall she is walking into. Standing next to one, or
	# backing away from it, leaves her on the floor where she belongs.
	_align_to_surface(delta, input.y < -0.1)
	# Ease the rig toward where the mouse points rather than pinning it there.
	# The body is simultaneously rolling to fit the ground under it, and a camera
	# bolted rigidly to a rolling body reads as jitter.
	_look = _look.lerp(Vector2(_pitch, _yaw), clampf(delta * camera_rate, 0.0, 1.0))
	_pivot.rotation = Vector3(_look.x, _look.y, 0.0)

	# Keyboard has no analogue axis, so it selects the walk band; sprint picks
	# the run band. A gamepad stick will want the continuous curve from
	# locomotion.ts instead -- the bands are landmarks, not gears.
	var target_speed := _run_speed if Input.is_action_pressed("sprint") else _walk_speed
	# Steering happens in her own frame, so the same code walks her across the
	# floor and up a wall. On flat soil local +Y is world up and this is exactly
	# the old planar movement.
	var wish_local := Vector3.ZERO
	if input != Vector2.ZERO:
		wish_local = (Basis(Vector3.UP, _yaw) * Vector3(input.x, 0.0, input.y)).normalized()
	else:
		target_speed = 0.0

	# Accelerate rather than snapping to velocity -- this is the only thing that
	# gives her any sense of mass.
	var rate := AntScale.WALK_ACCEL if target_speed > _planar_speed else AntScale.WALK_DECEL
	_planar_speed = move_toward(_planar_speed, target_speed, rate * delta)

	# Turn the HEADING as well as the speed. Ramping speed alone still snaps the
	# direction: tap A while holding W and the velocity vector jumps 45 degrees
	# in one frame, which at ant scale looks like she teleports sideways. Easing
	# the heading makes her carve the corner, and it is what the six planted feet
	# want too -- they are anchored to soil that is no longer where she is going.
	if wish_local != Vector3.ZERO:
		if _heading == Vector3.ZERO:
			_heading = wish_local
		else:
			var turn := clampf(delta * heading_rate, 0.0, 1.0)
			_heading = _heading.lerp(wish_local, turn)
			if _heading.length_squared() > 0.000001:
				_heading = _heading.normalized()
			else:
				_heading = wish_local
	elif _planar_speed <= 0.001:
		_heading = Vector3.ZERO

	var up := global_basis.y
	var along_up := velocity.dot(up)
	var planar := (global_basis * _heading) * _planar_speed

	if is_on_floor():
		if Input.is_action_just_pressed("jump"):
			along_up = AntScale.jump_speed()
		else:
			# Adhesion, not gravity: it pulls toward whatever she is standing on,
			# so on a wall it holds her against the wall rather than dragging her
			# off it. An ant's tarsal claws do the same job.
			along_up = -AntScale.GRAVITY * delta
		velocity = planar + up * along_up
	elif _gripping:
		velocity = planar + up * maxf(
			along_up - AntScale.GRAVITY * delta, AntScale.TERMINAL_VELOCITY)
	else:
		# Nothing within reach of her feet. She is falling, and falling is the
		# one thing that happens in world space rather than in hers.
		velocity += Vector3.DOWN * AntScale.GRAVITY * delta
		velocity.y = maxf(velocity.y, AntScale.TERMINAL_VELOCITY)

	up_direction = up
	move_and_slide()

	if Input.is_action_pressed("strafe_lock"):
		# Turn-in-place: pin her facing to the camera instead of her travel
		# direction, so WASD sidesteps and backpedals without spinning her to
		# face it. This is the same target the normal branch below reaches for
		# a player walking straight forward (heading angle == _yaw exactly, see
		# the derivation there) -- holding the key just also asks for it when
		# strafing or standing still. Releasing lets her facing catch up to
		# wherever she is actually travelling, through the same turn below.
		var want := deg_to_rad(model_yaw_offset_deg) + _yaw
		_model_yaw = lerp_angle(_model_yaw, want, clampf(delta * turn_rate, 0.0, 1.0))
	elif _heading != Vector3.ZERO and _planar_speed > 0.01:
		# model_yaw_offset is the rotation that makes the ART face the node's
		# forward (-Z). Solve for the yaw that instead points the art along her
		# actual heading -- the offset is the origin of that angle, not a
		# correction applied on top of it. Following the heading rather than the
		# raw input means the body and the travel direction turn together.
		var want := deg_to_rad(model_yaw_offset_deg) + atan2(-_heading.x, -_heading.z)
		_model_yaw = lerp_angle(_model_yaw, want, clampf(delta * turn_rate, 0.0, 1.0))
	_apply_model_transform()


## Roll the body so its own +Y is the surface normal, and remember whether she
## has anything to hold on to at all.
func _align_to_surface(delta: float, advancing: bool) -> void:
	var wanted := Vector3.UP
	if climbing:
		var felt := _feel_for_surface(advancing)
		_gripping = bool(felt["hit"])
		wanted = felt["normal"] if _gripping else Vector3.UP
	else:
		_gripping = true

	# Slerp rather than snap. A normal that jumps -- over a lip, across a dug
	# rim -- would otherwise whip the body and the camera with it.
	#
	# Guard the degenerate ends: slerp builds a rotation axis from the cross
	# product, and when the two normals are nearly parallel that cross product is
	# tiny and cannot be normalised reliably. Walking flat ground is exactly that
	# case, every frame.
	var blend := clampf(delta * align_rate, 0.0, 1.0)
	var alignment := clampf(_up.dot(wanted), -1.0, 1.0)
	if alignment > 0.99995:
		_up = wanted
	elif alignment < -0.99995:
		# Facing exactly opposite: no unique shortest path, so pick her own side
		# axis and roll through that.
		_up = _up.rotated(global_basis.x.normalized(), PI * blend).normalized()
	else:
		_up = _up.slerp(wanted, blend).normalized()

	# Rebuild the frame around the new up, keeping her heading. Orthogonalising
	# the old forward preserves which way she is pointing across the transition;
	# rebuilding from scratch would spin her on every wall she touched.
	var back := global_basis.z
	back -= _up * back.dot(_up)
	if back.length_squared() < 0.000001:
		back = global_basis.y
		back -= _up * back.dot(_up)
	back = back.normalized()
	global_basis = Basis(_up.cross(back), _up, back)


## Feel around for something to stand on.
##
## Mounting a wall is a DECISION, not a blend. An earlier version averaged the
## forward feeler in with the five ground probes; the ground always outvoted it,
## she leaned 12 degrees against the wall and stood there pushing. So a steep
## face ahead, that she is actually walking into, wins outright. Everything else
## averages, which is what keeps her smooth over ordinary lumpy soil.
func _feel_for_surface(advancing: bool) -> Dictionary:
	var space := get_world_3d().direct_space_state
	var basis := global_basis
	var up := basis.y
	var forward := -basis.z
	var side := basis.x
	# Every reach here is a length, so it belongs to the caste. A 0.95-unit
	# feeler is four body-heights ahead of a minor worker: unscaled, she reads
	# every bump on the mound as a wall to mount and throws herself off it.
	var reach := gait_scale
	var eye := global_position + up * (0.30 * reach)

	if advancing:
		# Two feelers: level, and angled down for the foot of a wall she is
		# already leaning into.
		for feeler in [forward, (forward - up * 0.30).normalized()]:
			var found := _cast(space, eye, feeler, feeler_length * reach)
			if found.is_empty():
				continue
			var face: Vector3 = found["normal"]
			# Steep relative to what she is on NOW, so this triggers on the wall
			# at the end of a slope as readily as on one rising off the flat.
			if face.angle_to(up) > deg_to_rad(mount_angle_deg):
				return {"hit": true, "normal": face}

		# Cresting a convex lip is the mirror problem, and nothing that casts
		# along -up can see it: past the edge there is simply no wall left, so
		# she runs off the top still pointing skyward. Reach PAST the edge and
		# cast back along her own forward, which after the corner is "down" onto
		# whatever she is about to stand on.
		if up.angle_to(Vector3.UP) > deg_to_rad(40.0):
			# Inset toward the wall, not out from it. `eye` stands 0.30 clear of
			# the face she is on, and at a square edge the top surface begins
			# exactly at that face -- so a ray dropped from eye height falls past
			# the lip and touches nothing.
			var brow := global_position - up * (0.25 * reach) 				+ forward * (feeler_length * reach)
			var over := _cast(space, brow, -forward, feeler_length * 1.4 * reach)
			if not over.is_empty():
				var top: Vector3 = over["normal"]
				if top.angle_to(up) > deg_to_rad(mount_angle_deg):
					return {"hit": true, "normal": top}

	var probes := [
		[eye, -up, 1.30, 1.7],
		[eye + forward * (0.80 * reach), -up, 1.60, 1.0],
		[eye - forward * (0.80 * reach), -up, 1.60, 0.7],
		[eye + side * (0.62 * reach), -up, 1.60, 0.7],
		[eye - side * (0.62 * reach), -up, 1.60, 0.7],
	]
	var sum := Vector3.ZERO
	for probe in probes:
		var from: Vector3 = probe[0]
		var hit := _cast(space, from, probe[1], float(probe[2]) * reach)
		if hit.is_empty():
			continue
		sum += (hit["normal"] as Vector3) * float(probe[3])

	if sum.length_squared() < 0.000001:
		return {"hit": false, "normal": Vector3.UP}
	return {"hit": true, "normal": sum.normalized()}


func _cast(space: PhysicsDirectSpaceState3D, from: Vector3,
		direction: Vector3, length: float) -> Dictionary:
	var query := PhysicsRayQueryParameters3D.create(
		from, from + direction * length, 1, [get_rid()])
	query.collide_with_areas = false
	return space.intersect_ray(query)


## How far her own up has tipped from world up, in degrees. 0 on flat soil,
## 90 on a wall, 180 on a ceiling.
func surface_angle_deg() -> float:
	return rad_to_deg(global_basis.y.angle_to(Vector3.UP))


func is_gripping() -> bool:
	return _gripping


## Debug readout, in the same shape as the web HUD's ?debug=1 line.
func debug_line() -> String:
	return "%s  pos %.2f,%.2f,%.2f  speed %.2f vox/s (%.2f cm/s)  %s  lean %.0f deg" % [
		caste_title, global_position.x, global_position.y, global_position.z,
		_planar_speed, AntScale.to_mm(_planar_speed) * 0.1,
		"air" if not is_on_floor() else "ground",
		surface_angle_deg(),
	]

# ---------------------------------------------------------------------------
# BEFORE PORTING SIX-AXIS WALL WALKING, READ THIS.
#
# move_and_slide() and Godot's collision solver are the wrong tool for the dig
# prototype, and swapping them in was not an oversight. The web build's
# movement is an axis-separated sweep of an axis-aligned box against the voxel
# grid (collides() / tryAxis() / moveOnSurface() in DigScene.ts), and the
# six-axis wall-walking in SurfaceFrame.ts rests on the invariant that the body
# box is ALWAYS in one of six discrete orientations and never interpolates
# through an in-between angle. A solver that resolves contacts continuously
# breaks that invariant, and with it the whole grip/edge/mount state machine.
#
# So the port order is:
#   1. VoxelWorld + mesher + raycast   -> ground to stand on
#   2. port collides()/tryAxis()/moveOnSurface() and drive the body directly,
#      replacing move_and_slide entirely
#   3. SurfaceFrame + locomotion       -> six-axis wall walking
#
# Likewise LooseSoil is a custom particle sim with a sleep model sized for 768
# grains. Do not replace it with RigidBody3D.
# ---------------------------------------------------------------------------
