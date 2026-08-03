extends SceneTree

## Drives the queen into a vertical face and checks she gets up it.
##
##   Godot --headless --path . --script res://scripts/climb_test.gd
##
## The mound has no wall of its own to climb -- its perimeter cliff faces
## outward over empty space -- so this drops a slab in front of her on layer 1,
## where her feelers and foot probes see it exactly like soil. She should mount
## it, climb, crest the lip and stand on top.
##
## Bone clearance is tracked per phase, because the concave crease where floor
## meets wall is much the hardest case and deserves to be reported separately
## rather than averaged into the total. Note that `soil_clearance` measures
## along HER up axis: in that crease the axis points along the wall, so a claw
## resting correctly on the floor can read as buried. Treat the transition
## figure as an upper bound, not a literal count of visible intersections.

const MIN_LEAN := 80.0
const MIN_GAIN := 2.0

var _body: CharacterBody3D
var _skel: Skeleton3D
var _gait: ProceduralAntGait

var _phase := "flat"
var _peak_lean := 0.0
var _peak_height := -INF
var _min_stance := 6
var _by_phase := {}
var _crested := false


func _initialize() -> void:
	var scene := (load("res://scenes/terrain_lab.tscn") as PackedScene).instantiate()
	root.add_child(scene)
	# Any caste, not just the queen: pass "worker" or "major" after a bare --.
	var wanted := "queen"
	for argument in OS.get_cmdline_user_args():
		if AntCaste.CASTES.has(argument):
			wanted = argument
	if wanted != "queen":
		await physics_frame
		scene.call("_spawn_ant", wanted, Vector2.ZERO)
		scene.call("_place_ant")
	for _frame in 30:
		await physics_frame

	_body = scene.get_node("Ant") as CharacterBody3D
	_gait = scene.get_node("Ant/ProceduralGait") as ProceduralAntGait
	_skel = (_body.get_node("Model") as Node3D).find_children(
		"*", "Skeleton3D", true, false)[0] as Skeleton3D

	var wall := StaticBody3D.new()
	wall.collision_layer = 1
	wall.collision_mask = 0
	wall.position = Vector3(0.0, _body.global_position.y + 1.6, -5.9)
	scene.add_child(wall)
	var box := BoxShape3D.new()
	box.size = Vector3(7.0, 5.0, 6.2)
	var shape := CollisionShape3D.new()
	shape.shape = box
	wall.add_child(shape)
	for _frame in 5:
		await physics_frame

	var start_height := _body.global_position.y
	(_skel.get_node("SixLegCCD") as CCDIK3D).modification_processed.connect(_sample)

	Input.action_press("move_forward")
	for step in 150:
		await physics_frame
		var lean: float = _body.surface_angle_deg()
		_phase = "flat" if lean < 15.0 else ("transition" if lean < 75.0 else "wall")
		# Cresting: back on the level, well above where she started, still held.
		if lean < 15.0 and _body.global_position.y > start_height + MIN_GAIN \
				and _body.is_gripping():
			_crested = true
	Input.action_release("move_forward")
	for _frame in 20:
		await physics_frame

	var gain := _peak_height - start_height
	print("CLIMB peak lean     = %.1f deg" % _peak_lean)
	print("CLIMB height gained = %.3f units (%.1f mm)" % [gain, gain * 5.0])
	print("CLIMB crested       = ", _crested)
	print("CLIMB min stance    = ", _min_stance)
	for key in _by_phase:
		var row: Array = _by_phase[key]
		print("CLIMB   %-10s %6d bone samples, buried %5d (%.2f%%), worst %+.3f units" % [
			key, row[0], row[1], 100.0 * row[1] / maxf(1, row[0]), row[2]])

	var failures: Array[String] = []
	if _peak_lean < MIN_LEAN:
		failures.append("never got vertical: peaked at %.1f deg" % _peak_lean)
	if gain < MIN_GAIN:
		failures.append("gained only %.2f units of height" % gain)
	if not _crested:
		failures.append("never crested onto the top surface")
	var wall_row: Array = _by_phase.get("wall", [0, 0, 0.0])
	if wall_row[0] > 0 and wall_row[1] * 50 > wall_row[0]:
		failures.append("clipped the wall on %.1f%% of samples" % [
			100.0 * wall_row[1] / wall_row[0]])
	if failures.is_empty():
		print("CLIMB PASS")
		quit(0)
	for failure in failures:
		push_error(failure)
	quit(1)


func _sample() -> void:
	_peak_lean = maxf(_peak_lean, _body.surface_angle_deg())
	_peak_height = maxf(_peak_height, _body.global_position.y)
	_min_stance = mini(_min_stance, _gait.stance_feet)
	if not _by_phase.has(_phase):
		_by_phase[_phase] = [0, 0, 0.0]
	var row: Array = _by_phase[_phase]
	for index in _skel.get_bone_count():
		var world: Vector3 = _skel.global_transform * _skel.get_bone_global_pose(index).origin
		var clearance := _gait.soil_clearance(world)
		row[0] += 1
		if clearance < 0.0:
			row[1] += 1
			row[2] = minf(row[2], clearance)
