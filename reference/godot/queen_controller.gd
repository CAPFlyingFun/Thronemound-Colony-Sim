class_name QueenController
extends CharacterBody3D

## Third-person driver for the founding queen.
##
## Scope: this drives the ground-walking terrain lab. It uses move_and_slide
## against the generated density mesh, which is appropriate while gravity is
## always down. Read the note below before porting the web build's six-axis
## wall and ceiling traversal.

@export_group("Camera")
## The web build runs 78 degrees. Wider than ~90 starts to fisheye at ant scale,
## where everything interesting is within a couple of centimetres.
@export_range(40.0, 120.0, 1.0) var fov := 78.0:
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
@export var turn_rate := 9.0

@onready var _model: Node3D = $Model
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
	_pivot.rotation = Vector3(_pitch, _yaw, 0.0)

	# Keyboard has no analogue axis, so it selects the walk band; sprint picks
	# the run band. A gamepad stick will want the continuous curve from
	# locomotion.ts instead -- the bands are landmarks, not gears.
	var target_speed := AntScale.RUN_SPEED if Input.is_action_pressed("sprint") else AntScale.WALK_SPEED

	var input := Input.get_vector("move_left", "move_right", "move_forward", "move_back")
	var wish := Vector3.ZERO
	if input != Vector2.ZERO:
		var basis := Basis(Vector3.UP, _yaw)
		wish = (basis * Vector3(input.x, 0.0, input.y)).normalized()
	else:
		target_speed = 0.0

	# Accelerate rather than snapping to velocity -- this is the only thing that
	# gives her any sense of mass.
	var rate := AntScale.WALK_ACCEL if target_speed > _planar_speed else AntScale.WALK_DECEL
	_planar_speed = move_toward(_planar_speed, target_speed, rate * delta)

	var planar := wish * _planar_speed
	velocity.x = planar.x
	velocity.z = planar.z

	if is_on_floor():
		if Input.is_action_just_pressed("jump"):
			velocity.y = AntScale.jump_speed()
	else:
		velocity.y = maxf(velocity.y - AntScale.GRAVITY * delta, AntScale.TERMINAL_VELOCITY)

	move_and_slide()

	if wish != Vector3.ZERO:
		# model_yaw_offset is the rotation that makes the ART face the node's
		# forward (-Z). Solve for the yaw that instead points the art along
		# `wish`, then ease into it -- the offset is the origin of that angle,
		# not a correction applied on top of it.
		var want := deg_to_rad(model_yaw_offset_deg) + atan2(-wish.x, -wish.z)
		_model_yaw = rotate_toward(_model_yaw, want, turn_rate * delta)
	_apply_model_transform()


## Debug readout, in the same shape as the web HUD's ?debug=1 line.
func debug_line() -> String:
	return "pos %.2f,%.2f,%.2f  speed %.2f vox/s (%.2f cm/s)  %s" % [
		global_position.x, global_position.y, global_position.z,
		_planar_speed, AntScale.to_mm(_planar_speed) * 0.1,
		"air" if not is_on_floor() else "ground",
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
