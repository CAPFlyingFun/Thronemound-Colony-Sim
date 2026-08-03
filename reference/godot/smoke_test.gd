extends SceneTree

## Headless confidence check for the terrain/animation lab.  Run with:
## Godot --headless --path . --script res://scripts/smoke_test.gd


func _initialize() -> void:
	var bind_reference := (load(
		"res://assets/ant models/Queen/fire_ant_queen.glb") as PackedScene).instantiate()
	root.add_child(bind_reference)
	var bind_skeleton := bind_reference.find_child(
		"GeneralSkeleton", true, false) as Skeleton3D
	var packed := load("res://scenes/terrain_lab.tscn") as PackedScene
	var scene := packed.instantiate()
	root.add_child(scene)
	for _frame in 12:
		await physics_frame
	print("SMOKE stage ready")

	var terrain := scene.get_node("DensityTerrain") as DensityTerrain
	var queen := scene.get_node("Ant") as AntController
	var gait := scene.get_node("Ant/ProceduralGait") as ProceduralAntGait
	var animated_skeleton := scene.get_node("Ant/Model").find_children(
		"*", "Skeleton3D", true, false)[0] as Skeleton3D
	# The claw is the contact.  The ankle above it is NOT: demanding that both
	# touch soil forces the tarsus flat, which is what tore the foot off the leg.
	var claw_bones := [
		"Bone_020", "Bone_026", "Bone_008", "Bone_014", "Bone_032", "Bone_039",
	]
	var leg_joint_names := [
		"Bone_024", "Bone_023", "Bone_022", "Bone_021", "Bone_020",
		"Bone_030", "Bone_029", "Bone_028", "Bone_027", "Bone_026",
		"Bone_012", "Bone_011", "Bone_010", "Bone_009", "Bone_008",
		"Bone_018", "Bone_017", "Bone_016", "Bone_015", "Bone_014",
		"Bone_037", "Bone_036", "Bone_035", "Bone_034", "Bone_033", "Bone_032",
		"Bone_044", "Bone_043", "Bone_042", "Bone_041", "Bone_040", "Bone_039",
	]
	var contact_offsets := {}
	var leg_report: Array[String] = []
	var joint_clearances := {}
	var ik := animated_skeleton.get_node("SixLegCCD") as CCDIK3D
	ik.modification_processed.connect(func() -> void:
		# soil_clearance measures along HER up axis, not world Y, so these checks
		# mean the same thing on a wall as they do on the floor.
		for joint_name in claw_bones:
			var joint_index := animated_skeleton.find_bone(joint_name)
			var joint_position := animated_skeleton.global_transform * (
				animated_skeleton.get_bone_global_pose(joint_index).origin)
			contact_offsets[joint_name] = float(gait.call(
				"soil_clearance", joint_position)) - gait.sole_clearance
		for joint_name in leg_joint_names:
			var joint_index := animated_skeleton.find_bone(joint_name)
			var joint_position := animated_skeleton.global_transform * (
				animated_skeleton.get_bone_global_pose(joint_index).origin)
			joint_clearances[joint_name] = float(gait.call(
				"soil_clearance", joint_position))
		leg_report.clear()
		for leg in gait.get("_legs"):
			var hip: Vector3 = animated_skeleton.global_transform * (
				animated_skeleton.get_bone_global_pose(int(leg["root_index"])).origin)
			var claw: Vector3 = animated_skeleton.global_transform * (
				animated_skeleton.get_bone_global_pose(int(leg["claw_index"])).origin)
			var target: Vector3 = (leg["target"] as Node3D).global_position
			leg_report.append("%-12s extension=%.3f err=%.3f mm bias=%.3f swing=%s" % [
				leg["slot"], hip.distance_to(target) / float(leg["reach"]),
				claw.distance_to(target) * 5.0, leg["bias"], leg["swinging"]])
	)
	await physics_frame
	var failures: Array[String] = []

	# Walking is the one mode with no head aim at all, so it is the only state
	# where the procedural delta is genuinely zero. The lab starts in Digging,
	# whose whole point is that her head tracks the camera -- and the camera
	# starts pitched down, so her head is legitimately nodded and the check
	# below would fire on a working feature.
	var resting_mode: String = queen.mode
	queen.mode = AntMode.WALKING
	# Long enough for the head to actually settle. The aim eases exponentially,
	# so it approaches centre asymptotically rather than snapping there -- a
	# dozen frames still leaves a degree or so on the clock, which reads as a
	# replaced base rotation to the check below.
	for _frame in 45:
		await physics_frame

	# A zero procedural delta must preserve the GLB's authored base rotations.
	# Replacing these rotations collapses the queen into the pole-like pose.
	var head_name := animated_skeleton.get_bone_name(gait.rig.head_bone)
	for bone_name in ["Bone_000", head_name, "Bone_006"]:
		var bind_index := bind_skeleton.find_bone(bone_name)
		var animated_index := animated_skeleton.find_bone(bone_name)
		var angle := bind_skeleton.get_bone_pose_rotation(bind_index).angle_to(
			animated_skeleton.get_bone_pose_rotation(animated_index))
		if angle > 0.001:
			failures.append("authored base rotation was replaced on %s (%.1f degrees)" % [
				bone_name, rad_to_deg(angle)])

	# ...and the head must actually MOVE once a mode that aims it is selected,
	# or the tracking silently does nothing and the check above passes for the
	# wrong reason.
	var head_index := gait.rig.head_bone
	var head_at_rest := animated_skeleton.get_bone_pose_rotation(head_index)
	queen.mode = AntMode.DIGGING
	queen.set_look(0.0, -0.7)
	for _frame in 20:
		await physics_frame
	var head_aimed := animated_skeleton.get_bone_pose_rotation(head_index)
	var head_travel := rad_to_deg(head_at_rest.angle_to(head_aimed))
	print("SMOKE head aim travel = %.1f deg (%s -> Digging)" % [head_travel, head_name])
	if head_travel < 5.0:
		failures.append("head did not track the camera in Digging mode (%.1f deg)" %
			head_travel)
	queen.mode = resting_mode
	# A claw may ride ABOVE the soil by up to the per-leg clearance bias, which is
	# how a leg keeps its tarsus out of a slope. It may never sink INTO the soil.
	var claw_ceiling := gait.max_leg_bias + 0.03
	for joint_name in claw_bones:
		var contact_offset := float(contact_offsets.get(joint_name, INF))
		if contact_offset < -0.02 or contact_offset > claw_ceiling:
			failures.append("claw %s sits %.3f units off soil contact" % [
				joint_name, contact_offset])
	for joint_name in leg_joint_names:
		var clearance := float(joint_clearances.get(joint_name, -INF))
		if clearance < -0.04:
			failures.append("leg joint %s is %.3f units below the soil" % [
				joint_name, -clearance])
	if terrain.vertex_count < 100:
		failures.append("terrain mesh did not build")
	if terrain.triangle_count < 100:
		failures.append("terrain has too few triangles")
	if gait.stance_feet < 3:
		failures.append("fewer than three feet are planted")

	var minimum_stance := 6
	Input.action_press("move_forward")
	for _frame in 48:
		await physics_frame
		minimum_stance = mini(minimum_stance, gait.stance_feet)
	print("SMOKE stage walked")
	Input.action_release("move_forward")
	for _frame in 36:
		await physics_frame
	print("SMOKE stage settled")
	print("SMOKE feet before dig: ", gait.foot_error_report())
	if minimum_stance < 3:
		failures.append("tripod gait lifted more than three feet")
	if gait.stance_feet != 6:
		failures.append("queen did not finish with all six feet planted")
	if gait.max_foot_error * 5.0 > 0.25:
		failures.append("planted foot error exceeded 0.25 mm")
	if queen.global_position.distance_to(Vector3.ZERO) < 0.25:
		failures.append("queen did not move")

	var surface := terrain.surface_height_world(queen.global_position.x, queen.global_position.z)
	var before_revision := terrain.revision
	var result := terrain.subtract_sphere(
		Vector3(queen.global_position.x, surface - terrain.brush_radius * 0.45, queen.global_position.z - 0.8))
	for _frame in 12:
		await physics_frame
	print("SMOKE feet after dig: ", gait.foot_error_report())
	if int(result["changed_samples"]) <= 0 or float(result["removed_volume"]) <= 0.0:
		failures.append("density brush removed no soil")
	if terrain.revision <= before_revision:
		failures.append("terrain revision did not advance")
	if terrain.vertex_count < 100 or terrain.triangle_count < 100:
		failures.append("terrain mesh was lost after digging")
	if terrain.last_build_ms > 300.0:
		failures.append("terrain rebuild exceeded the 300 ms smoke-test budget")
	if gait.stance_feet != 6:
		failures.append("terrain rebuild did not restore six planted feet")

	# Exercise the player-facing route too: the camera ray, reach limit, density
	# edit, volume-scaled clod and deferred foot-anchor refresh.
	scene.call("_reset_lab")
	for _frame in 12:
		await physics_frame
	# Aim the reticle at the ground under her mouth. The follow camera's default
	# framing was never guaranteed to land there, and now that a bite lands at
	# her jaw rather than under the crosshair, that is what it takes for the
	# reticle dig to find something to reach instead of empty air.
	var mouth: Vector3 = gait.call("mouth_position")
	var reticle_camera := scene.get("_camera") as Camera3D
	reticle_camera.look_at(Vector3(
		mouth.x, terrain.surface_height_world(mouth.x, mouth.z), mouth.z), Vector3.UP)
	var reticle_revision := terrain.revision
	scene.call("_dig_at_reticle")
	for _frame in 18:
		await physics_frame
	print("SMOKE reticle message: ", scene.get("_last_message"))
	print("SMOKE feet after reticle dig: ", gait.foot_error_report())
	for line in leg_report:
		print("SMOKE ", line)
	if terrain.revision <= reticle_revision or terrain.removed_volume <= 0.0:
		failures.append("center-reticle dig did not edit the terrain")
	if scene.get_node("Clods").get_child_count() != 1:
		failures.append("center-reticle dig did not create one volume clod")
	if gait.stance_feet != 6:
		failures.append("reticle dig did not restore six planted feet")
	if gait.max_foot_error * 5.0 > 0.25:
		failures.append("reticle dig left a planted foot more than 0.25 mm from its target")
	for joint_name in claw_bones:
		var contact_offset := float(contact_offsets.get(joint_name, INF))
		if contact_offset < -0.02 or contact_offset > claw_ceiling:
			failures.append("reticle dig left claw %s %.3f units off soil contact" % [
				joint_name, contact_offset])
	for joint_name in leg_joint_names:
		var clearance := float(joint_clearances.get(joint_name, -INF))
		if clearance < -0.04:
			failures.append("reticle dig left leg joint %s %.3f units below soil" % [
				joint_name, -clearance])

	print("SMOKE terrain=", terrain.vertex_count, " verts / ", terrain.triangle_count,
		" tris, build=", snappedf(terrain.last_build_ms, 0.1), " ms")
	print("SMOKE gait minimum_stance=", minimum_stance,
		" max_error=", snappedf(gait.max_foot_error * 5.0, 0.001), " mm")
	print("SMOKE dig removed=", snappedf(float(result["removed_volume"]), 0.001), " voxel^3")
	print("SMOKE reticle dig removed=", snappedf(terrain.removed_volume, 0.001), " voxel^3")
	if failures.is_empty():
		print("SMOKE PASS")
		bind_reference.queue_free()
		scene.queue_free()
		for _frame in 3:
			await process_frame
		quit(0)
	else:
		for failure in failures:
			push_error(failure)
		bind_reference.queue_free()
		scene.queue_free()
		for _frame in 3:
			await process_frame
		quit(1)
