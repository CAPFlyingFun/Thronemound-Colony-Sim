extends Node3D

## Playable bridge between the browser experiment and Godot.
## Keeps the scope deliberately narrow: walk the real queen over editable
## signed-density soil, inspect six grounded feet, and cut volume-conserving
## scoops with the center reticle.

const WORLD_UNIT_MM := 5.0
const DIG_REACH := 2.25
const BITE_STEP_MM := 0.25
const MIN_BITE_MM := 0.25
const MAX_BITE_MM := 8.0

const ANT_SCENE := preload("res://scenes/ant.tscn")

@onready var _terrain: DensityTerrain = $DensityTerrain
var _ant: AntController
var _gait: ProceduralAntGait
var _camera: Camera3D
@onready var _status: Label = $HUD/InfoPanel/Margin/VBox/Status
@onready var _message: Label = $HUD/InfoPanel/Margin/VBox/Message
@onready var _clods: Node3D = $Clods

var _last_message := "Walk across the mound, then dig within touching distance."
var _message_until := 0
var _dig_sequence := 0

## Provisional per-caste jaw radius, in mm -- feel these out live with +/- and
## report back whatever reads right so they can move into AntCaste as the
## real defaults. The terrain's own flat brush_radius (7.2 mm across) was
## tuned for nothing in particular and bit nearly as wide as the queen.
var _bite_mm := {
	"queen": 1.5,
	"worker": 0.75,
	"major": 3.0,
}


func _ready() -> void:
	_terrain.terrain_changed.connect(_on_terrain_changed)
	_spawn_ant("queen", Vector2.ZERO)


func _process(_delta: float) -> void:
	if _message_until > 0 and Time.get_ticks_msec() > _message_until:
		_last_message = "Planted feet stay fixed; only one tripod swings at a time."
		_message_until = 0
	_message.text = _last_message
	var bite_mm := float(_bite_mm.get(_ant.caste, 1.5))
	_status.text = (
		"%d feet planted  |  worst IK error %.2f mm\n" % [
			_gait.stance_feet,
			_gait.max_foot_error * WORLD_UNIT_MM,
		]
		+ "Terrain %d vertices / %d triangles  |  rebuild %.1f ms\n" % [
			_terrain.vertex_count,
			_terrain.triangle_count,
			_terrain.last_build_ms,
		]
		+ "Removed %.1f voxel^3 / %.0f mm^3  |  %d fps
" % [
			_terrain.removed_volume,
			_terrain.removed_volume * pow(WORLD_UNIT_MM, 3.0),
			Engine.get_frames_per_second(),
		]
		+ "%s  |  %.2f mm long, stands %.2f mm  |  lean %.0f deg\n" % [
			_ant.caste_title, AntCaste.get_caste(_ant.caste)["body_length_mm"],
			AntCaste.get_caste(_ant.caste)["stand_height_mm"],
			_ant.surface_angle_deg(),
		]
		+ "Mode: %s  |  wheel or * / to switch\n" % _ant.mode_title()
		+ "Bite radius %.2f mm (%.2f mm across)  |  +/- to adjust" % [
			bite_mm, bite_mm * 2.0,
		]
	)


func _unhandled_input(event: InputEvent) -> void:
	if event.is_action_pressed("dig"):
		# The first click only captures the mouse.  Once captured, click and F are
		# the same center-reticle dig action.
		if event is InputEventMouseButton and Input.mouse_mode != Input.MOUSE_MODE_CAPTURED:
			return
		_dig_at_reticle()
		get_viewport().set_input_as_handled()
	elif event.is_action_pressed("reset_lab"):
		_reset_lab()
		get_viewport().set_input_as_handled()
	elif event.is_action_pressed("toggle_foot_debug"):
		_gait.toggle_targets()
		_flash("Foot targets toggled. Green and blue are the two tripods.")
		get_viewport().set_input_as_handled()
	elif event.is_action_pressed("cycle_caste"):
		_cycle_caste()
		get_viewport().set_input_as_handled()
	elif event.is_action_pressed("dig_size_increase"):
		_adjust_bite(BITE_STEP_MM)
		get_viewport().set_input_as_handled()
	elif event.is_action_pressed("dig_size_decrease"):
		_adjust_bite(-BITE_STEP_MM)
		get_viewport().set_input_as_handled()
	elif event.is_action_pressed("mode_next"):
		_cycle_mode(1)
		get_viewport().set_input_as_handled()
	elif event.is_action_pressed("mode_previous"):
		_cycle_mode(-1)
		get_viewport().set_input_as_handled()


func _cycle_mode(step: int) -> void:
	var title := _ant.cycle_mode(step)
	match _ant.mode:
		AntMode.WALKING:
			_flash("%s. She looks where she is going; no pitch tracking." % title)
		AntMode.DIGGING:
			_flash("%s. Click or F to bite soil at her mandibles." % title)
		_:
			_flash("%s. Nothing bound to it yet -- the mode exists, the verb does not." % title)


func _dig_at_reticle() -> void:
	# The same button means different things per mode. Only Digging cuts soil;
	# the other modes are placeholders so the binding is already in the right
	# shape when combat and carrying arrive.
	if _ant.mode != AntMode.DIGGING:
		_flash("Not in Digging mode -- scroll the wheel to switch.")
		return
	var center := get_viewport().get_visible_rect().size * 0.5
	var origin := _camera.project_ray_origin(center)
	var direction := _camera.project_ray_normal(center)
	var query := PhysicsRayQueryParameters3D.create(
		origin, origin + direction * 20.0, 1, [_ant.get_rid()])
	query.hit_back_faces = true
	var hit := get_world_3d().direct_space_state.intersect_ray(query)
	if hit.is_empty() or hit["collider"] != _terrain:
		_flash("No soil under the reticle.")
		return

	var hit_position: Vector3 = hit["position"]
	var normal: Vector3 = hit["normal"]
	var mouth := _gait.mouth_position()
	# From her mouth, not her thorax -- a target can sit well within reach of
	# the body origin and still be nowhere near where she would actually bite.
	if hit_position.distance_to(mouth) > DIG_REACH * _ant.gait_scale:
		_flash("Too far away -- an ant digs soil she can touch.")
		return

	# The reticle only picks which nearby surface she means -- floor, wall,
	# whatever it is aimed at. The bite itself always happens at her jaw:
	# treat the aimed surface as flat this close in (fair at mandible scale)
	# and project her mouth onto that plane instead of carving wherever the
	# camera ray happened to land, which could be body-lengths from her face.
	var clearance := (mouth - hit_position).dot(normal)
	var bite_position := mouth - normal * clearance

	var radius := _bite_radius_units()
	# Width is the tunable bite radius; depth is anatomy, not a fraction of
	# width. Her mandibles cannot gouge a hole deeper than they physically
	# reach, so the brush sinks in by twice her mandible length regardless of
	# how wide the current bite radius happens to be set.
	var depth := 2.0 * _gait.mandible_reach()
	var brush_center := bite_position - normal * (depth - radius)
	_gait.set_digging(1.0)
	_dig_sequence += 1
	var sequence := _dig_sequence
	var result := _terrain.subtract_sphere(brush_center, radius)
	var removed := float(result["removed_volume"])
	if removed <= 0.0001:
		_gait.set_digging(0.0)
		_flash("That bite did not reach packed soil.")
		return

	_spawn_clod(bite_position, normal, removed)
	_play_dig_sound(bite_position)
	_flash("Scoop removed %.2f voxel^3; the clod uses that same volume." % removed)
	var timer := Timer.new()
	timer.one_shot = true
	timer.wait_time = 0.42
	add_child(timer)
	timer.timeout.connect(func() -> void:
		if sequence == _dig_sequence and is_instance_valid(_gait):
			_gait.set_digging(0.0)
		timer.queue_free()
	)
	timer.start()


## Radius in world units of the current caste's jaw bite.
func _bite_radius_units() -> float:
	return float(_bite_mm.get(_ant.caste, 1.5)) / WORLD_UNIT_MM


func _adjust_bite(delta_mm: float) -> void:
	var caste := _ant.caste
	var mm := clampf(float(_bite_mm.get(caste, 1.5)) + delta_mm, MIN_BITE_MM, MAX_BITE_MM)
	_bite_mm[caste] = mm
	_flash("%s bite radius %.2f mm (%.2f mm across)" % [_ant.caste_title, mm, mm * 2.0])


func _spawn_clod(at: Vector3, normal: Vector3, volume: float) -> void:
	# Volume of a sphere solved for radius.  Displayed at 72% linear scale so a
	# loose scoop is readable without pretending every bit is one solid boulder.
	var radius := clampf(pow(volume * 3.0 / (4.0 * PI), 1.0 / 3.0) * 0.72, 0.08, 0.32)
	var clod := RigidBody3D.new()
	clod.name = "ExcavatedClod"
	clod.collision_layer = 2
	clod.collision_mask = 1
	clod.mass = maxf(0.02, volume * 0.08)
	clod.position = at + normal * (radius + 0.06)
	_clods.add_child(clod)

	var mesh_instance := MeshInstance3D.new()
	var mesh := SphereMesh.new()
	mesh.radius = radius
	mesh.height = radius * 2.0
	mesh.radial_segments = 9
	mesh.rings = 5
	mesh_instance.mesh = mesh
	mesh_instance.scale = Vector3(1.0, 0.76, 0.9)
	mesh_instance.rotation = Vector3(randf(), randf(), randf())
	var material := StandardMaterial3D.new()
	material.albedo_color = Color(0.48, 0.30, 0.16)
	material.roughness = 1.0
	mesh_instance.material_override = material
	clod.add_child(mesh_instance)

	var collision := CollisionShape3D.new()
	var shape := SphereShape3D.new()
	shape.radius = radius * 0.82
	collision.shape = shape
	clod.add_child(collision)
	# A velocity, not a flat impulse -- impulse = velocity * mass, so the kick
	# stays a gentle, consistent pop regardless of how big the clod is. A flat
	# impulse divided by the 0.02 mass floor (which small mandible-depth bites
	# hit far more often now than a full-radius dig ever did) is what sent
	# clods off like rockets: the same shove into a much lighter body.
	var kick := normal * 2.4 + Vector3.UP * 1.8 + Vector3(
		randf_range(-0.8, 0.8), 0.0, randf_range(-0.8, 0.8))
	clod.apply_central_impulse(kick * clod.mass)

	var lifetime := Timer.new()
	lifetime.one_shot = true
	lifetime.wait_time = 12.0
	clod.add_child(lifetime)
	lifetime.timeout.connect(func() -> void:
		if is_instance_valid(clod):
			clod.queue_free()
	)
	lifetime.start()


func _play_dig_sound(at: Vector3) -> void:
	var player := AudioStreamPlayer3D.new()
	player.stream = load("res://assets/SFX/ant-sfx/dig_release.mp3")
	player.position = at
	player.unit_size = 2.0
	add_child(player)
	player.play()

	# A single timer owns her cleanup rather than racing `finished` against a
	# length-based fallback. `finished` intermittently never fires at all
	# under --headless (dummy audio driver), which is why a fallback exists;
	# but having both fire independently means whichever wins frees the
	# player out from under the other's lambda, and Godot refuses to invoke a
	# lambda whose captured reference has already been freed -- an
	# is_instance_valid() guard inside the lambda body never gets the chance
	# to help, because the call is rejected before the body runs at all.
	var cleanup := Timer.new()
	cleanup.one_shot = true
	cleanup.wait_time = player.stream.get_length() + 0.2
	add_child(cleanup)
	cleanup.timeout.connect(func() -> void:
		if is_instance_valid(player):
			player.queue_free()
		cleanup.queue_free()
	)
	cleanup.start()


func _on_terrain_changed(_revision: int) -> void:
	# The collision changes in the same operation as the mesh.  Re-sampling all
	# anchors prevents a stance foot from remaining attached to removed soil.
	_gait.reset_anchors.call_deferred()


func _reset_lab() -> void:
	for clod in _clods.get_children():
		clod.queue_free()
	_terrain.reset_terrain()
	_place_ant()
	_flash("Terrain and soil accounting reset.")


## Swap castes by rebuilding the ant rather than restocking a live one. The gait
## caches the skeleton, the discovered anatomy and six IK chains at _ready, and
## unpicking all of that in place is far more fragile than starting clean.
func _cycle_caste() -> void:
	var look := _ant.get_look()
	# Drop the newcomer in from where the old one stood, not from her feet: the
	# castes are different heights and the ground under them is not flat.
	var at := Vector3(_ant.global_position.x, 0.0, _ant.global_position.z)
	at.y = _terrain.surface_height_world(at.x, at.z)
	var next := AntCaste.next(_ant.caste)
	var carried_mode := _ant.mode
	_spawn_ant(next, look, at)
	# Carry the mode across the rebuild. Switching castes to compare them
	# should not silently drop her out of Digging.
	_ant.mode = carried_mode
	_flash("%s. Press O again to switch." % _ant.caste_title)


func _spawn_ant(caste: String, look: Vector2, at := Vector3.INF) -> void:
	if is_instance_valid(_ant):
		# remove_child, not just queue_free. Freeing is deferred, so the outgoing
		# ant is still in the tree AND still in the physics world when the new one
		# is added -- she keeps the name "Ant" (the newcomer would silently become
		# "Ant2") and her collider is still standing exactly where the newcomer is
		# about to spawn, which shoves a minor worker straight down into the soil.
		remove_child(_ant)
		_ant.queue_free()
	var ant := ANT_SCENE.instantiate() as AntController
	# Place her BEFORE she enters the tree. A CharacterBody3D added at the
	# parent's origin spends a frame roughly half a centimetre inside the mound,
	# and a concave collision shape has no interior to push out of -- the queen
	# is wide enough that her capsule still overlaps the surface and survives it,
	# but a minor worker is entirely buried and simply falls through the world.
	var scale: float = AntCaste.get_caste(caste)["gait_scale"]
	if not at.is_finite():
		at = Vector3(0.0, _terrain.surface_height_world(0.0, 0.0), 0.0)
	ant.position = at + Vector3.UP * (0.08 * scale)
	# Before add_child: the caste is read in _enter_tree, which is the only
	# moment early enough for the gait to find a model under the node.
	ant.caste = caste
	add_child(ant)
	_ant = ant
	_gait = ant.get_node("ProceduralGait") as ProceduralAntGait
	_camera = ant.get_node("CameraPivot/SpringArm3D/Camera3D") as Camera3D

	ant.set_look(look.x, look.y if look.y != 0.0 else -0.5)
	# Snap distance is a length, so it belongs to the caste like every other one.
	ant.floor_snap_length = 0.3 * ant.gait_scale
	# Generous, because up_direction tracks the surface she is on: mid-transition
	# onto a wall, her up sits between the floor normal and the wall normal and
	# both contacts have to keep counting as floor.
	ant.floor_max_angle = deg_to_rad(62.0)


func _place_ant() -> void:
	_ant.velocity = Vector3.ZERO
	# The drop-in height is a length too: 0.08 is a tenth of the queen's height
	# and a third of a minor worker's.
	_ant.global_position = Vector3(
		0.0, _terrain.surface_height_world(0.0, 0.0) + 0.08 * _ant.gait_scale, 0.0)
	_gait.reset_anchors.call_deferred()


func _flash(text: String, seconds := 3.2) -> void:
	_last_message = text
	_message_until = Time.get_ticks_msec() + int(seconds * 1000.0)
