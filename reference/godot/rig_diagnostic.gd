extends SceneTree


# coxa -> claw, matching ProceduralAntGait.LEG_DEFS. The chains end on the claw
# because that is the bone the bind pose already rests on the ground.
const LEG_NAMES := [
	["front_left", "Bone_024", "Bone_020"],
	["front_right", "Bone_030", "Bone_026"],
	["mid_left", "Bone_012", "Bone_008"],
	["mid_right", "Bone_018", "Bone_014"],
	["rear_left", "Bone_037", "Bone_032"],
	["rear_right", "Bone_044", "Bone_039"],
]


func _initialize() -> void:
	var bind_model := (load("res://assets/ant models/Queen/fire_ant_queen.glb") as PackedScene).instantiate()
	bind_model.name = "BindReference"
	root.add_child(bind_model)
	var bind_skeleton := bind_model.find_child("GeneralSkeleton", true, false) as Skeleton3D
	print("RIG bind reference non-identity poses:")
	_print_non_identity_poses(bind_skeleton, "BIND")
	var scene := (load("res://scenes/terrain_lab.tscn") as PackedScene).instantiate()
	root.add_child(scene)
	for _frame in 12:
		await physics_frame
	var model := scene.get_node("Queen/Model") as Node3D
	var gait := scene.get_node("Queen/ProceduralGait") as ProceduralAntGait
	var skeleton := model.find_child("GeneralSkeleton", true, false) as Skeleton3D
	var ik := skeleton.get_node("SixLegCCD") as CCDIK3D
	print("RIG model transform=", model.transform)
	for setting in LEG_NAMES.size():
		var definition = LEG_NAMES[setting]
		var root_index := skeleton.find_bone(definition[1])
		var tip_index := skeleton.find_bone(definition[2])
		var chain: Array[String] = []
		var cursor := tip_index
		while cursor >= 0:
			chain.push_front(skeleton.get_bone_name(cursor))
			if cursor == root_index:
				break
			cursor = skeleton.get_bone_parent(cursor)
		var root_parent := skeleton.get_bone_parent(root_index)
		print("RIG ", definition[0], " chain=", chain,
			" root_parent=", skeleton.get_bone_name(root_parent) if root_parent >= 0 else "NONE")
		var actual_joints: Array[String] = []
		for joint in ik.get_joint_count(setting):
			actual_joints.append(ik.get_joint_bone_name(setting, joint))
		print("RIG ", definition[0], " IK root=", ik.get_root_bone_name(setting),
			" end=", ik.get_end_bone_name(setting), " joints=", actual_joints)
		var children := skeleton.get_bone_children(tip_index)
		if not children.is_empty():
			var terminal: int = children[0]
			var tip_world := skeleton.global_transform * skeleton.get_bone_global_pose(tip_index).origin
			var terminal_world := skeleton.global_transform * skeleton.get_bone_global_pose(terminal).origin
			print("RIG ", definition[0], " omitted_terminal=", skeleton.get_bone_name(terminal),
				" ankle_to_toe=", tip_world.distance_to(terminal_world),
				" ankle_y=", tip_world.y, " toe_y=", terminal_world.y)
	_print_non_identity_poses(skeleton, "POSED")
	for leg in gait.get("_legs"):
		var anchor: Vector3 = leg["anchor"]
		print("RIG contact ", leg["slot"], " anchor=", anchor,
			" live_ground=", gait.call("_ground_y", anchor.x, anchor.z),
			" body_y=", scene.get_node("Queen").global_position.y)
	for player in model.find_children("*", "AnimationPlayer", true, false):
		print("RIG animation player ", player.get_path(), " playing=", player.is_playing(),
			" current=", player.current_animation)
	bind_model.queue_free()
	scene.queue_free()
	for _frame in 3:
		await process_frame
	quit()


func _print_non_identity_poses(skeleton: Skeleton3D, label: String) -> void:
	for index in skeleton.get_bone_count():
		var rotation := skeleton.get_bone_pose_rotation(index)
		if not rotation.is_equal_approx(Quaternion.IDENTITY):
			var parent := skeleton.get_bone_parent(index)
			print("RIG ", label, " ", skeleton.get_bone_name(index), " parent=",
				skeleton.get_bone_name(parent) if parent >= 0 else "NONE", " rotation=", rotation)
