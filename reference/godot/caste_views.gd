extends SceneTree

## Photographs all three castes side by side, at rest and mid-stride.
##
##   Godot --path . --script res://scripts/caste_views.gd
##
## Writes _caste_<name>.png and _caste_<name>_walk.png. The point is the size
## difference: they are drawn at the same camera distance in body-lengths, so a
## worker looks like a worker rather than like a small queen.

func _initialize() -> void:
	var scene := (load("res://scenes/terrain_lab.tscn") as PackedScene).instantiate()
	root.add_child(scene)
	for _frame in 40:
		await physics_frame

	var camera := Camera3D.new()
	camera.fov = 44.0
	camera.near = 0.01
	scene.add_child(camera)

	for caste in AntCaste.ORDER:
		scene.call("_spawn_ant", caste, Vector2.ZERO)
		scene.call("_place_ant")
		for _frame in 50:
			await physics_frame

		var ant := scene.get_node("Ant") as AntController
		var gait := scene.get_node("Ant/ProceduralGait") as ProceduralAntGait
		var reach: float = ant.gait_scale
		camera.current = true

		for mode in ["", "_walk"]:
			if mode == "_walk":
				Input.action_press("move_forward")
				for _frame in 30:
					await physics_frame
			var focus := ant.global_position + Vector3(0.0, 0.30 * reach, 0.0)
			camera.global_position = focus + Vector3(2.6, 0.45, 1.0) * reach
			camera.look_at(focus)
			for _frame in 4:
				await process_frame
			root.get_viewport().get_texture().get_image().save_png(
				"res://_caste_%s%s.png" % [caste, mode])
			if mode == "_walk":
				Input.action_release("move_forward")
				for _frame in 20:
					await physics_frame

		var config := AntCaste.get_caste(caste)
		print("%-8s %-16s body %.2f mm  stands %.2f mm  scale %.4f  feet %d  err %.3f mm" % [
			caste, config["title"], config["body_length_mm"],
			config["stand_height_mm"], config["scale"],
			gait.stance_feet, gait.max_foot_error * 5.0])
		print("         legs=%d antennae=%d mandibles=%d bones=%d" % [
			gait.rig.legs.size(), gait.rig.antenna_tips.size(),
			gait.rig.mandible_roots.size(), gait.rig.skeleton.get_bone_count()])
	quit()
