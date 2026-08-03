extends SceneTree

## Walks the queen all over the mound and checks EVERY bone in the rig against
## the soil -- legs, head, thorax, gaster, antennae, mandibles, the lot.
##
##   Godot --headless --path . --script res://scripts/clearance_audit.gd
##
## Reports the offenders ranked by how often they enter the soil. A healthy run
## is a fraction of a percent, all of it sub-millimetre and all of it on ankles
## and tarsi. A body plate appearing in the list is a real regression.
##
## IMPORTANT: every skeleton read happens inside `modification_processed`.
## Reading bone poses after `physics_frame` catches the pose AFTER
## _animate_base_pose has reset it to bind and BEFORE the solver has run, which
## silently reports the bind pose no matter what the gait is doing. Two separate
## investigations were derailed by exactly that before it was noticed.

var _body: CharacterBody3D
var _skel: Skeleton3D
var _gait: ProceduralAntGait

var _per_bone := {}
var _solved := 0
var _peak_lift := 0.0
var _swing_buried := 0
var _stance_buried := 0


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
	(_skel.get_node("SixLegCCD") as CCDIK3D).modification_processed.connect(_sample)

	for _pass in 3:
		for heading in ["move_forward", "move_right", "move_back", "move_left"]:
			Input.action_press(heading)
			for _frame in 45:
				await physics_frame
			Input.action_release(heading)
			for _frame in 15:
				await physics_frame

	var total := 0
	var buried := 0
	var ranked := []
	for name in _per_bone:
		var row: Array = _per_bone[name]
		total += row[0]
		buried += row[1]
		if row[1] > 0:
			ranked.append([name, row[0], row[1], row[2]])
	ranked.sort_custom(func(a, b): return a[2] > b[2])

	print("AUDIT solves        = ", _solved)
	print("AUDIT bone samples  = %d, buried %d (%.3f%%)" % [
		total, buried, 100.0 * buried / maxf(1, total)])
	print("AUDIT buried while swinging %d, while planted %d" % [
		_swing_buried, _stance_buried])
	print("AUDIT peak body lift= %.3f units" % _peak_lift)
	if ranked.is_empty():
		print("AUDIT no bone ever entered the soil")
	for row in ranked:
		print("AUDIT   %-10s buried %5d of %5d (%5.2f%%)  worst %+.3f units (%+.2f mm)" % [
			row[0], row[2], row[1], 100.0 * row[2] / maxf(1, row[1]),
			row[3], row[3] * 5.0])
	quit(1 if buried * 200 > total else 0)


func _sample() -> void:
	_solved += 1
	_peak_lift = maxf(_peak_lift, float(_gait.get("_lift")))

	# Tag each leg bone with whether its own leg is mid-swing this instant, so a
	# foot arcing over a bump is not confused with one planted inside it.
	var swinging := {}
	for leg in _gait.get("_legs"):
		for bone_name in leg["bones"]:
			swinging[bone_name] = bool(leg["swinging"])

	for index in _skel.get_bone_count():
		var name := _skel.get_bone_name(index)
		var world: Vector3 = _skel.global_transform * _skel.get_bone_global_pose(index).origin
		var clearance := _gait.soil_clearance(world)
		if not _per_bone.has(name):
			_per_bone[name] = [0, 0, 0.0]
		_per_bone[name][0] += 1
		if clearance < 0.0:
			_per_bone[name][1] += 1
			_per_bone[name][2] = minf(_per_bone[name][2], clearance)
			if swinging.get(name, false):
				_swing_buried += 1
			else:
				_stance_buried += 1
