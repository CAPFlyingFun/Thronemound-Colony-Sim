extends SceneTree

## Renders the live terrain lab from fixed angles so the queen's carriage and
## footing can be inspected without driving her by hand.
## Pass "walk" as the last CLI argument to photograph her mid-stride instead of
## at rest.

func _initialize() -> void:
	var walking := "walk" in OS.get_cmdline_user_args()
	var scene := (load("res://scenes/terrain_lab.tscn") as PackedScene).instantiate()
	root.add_child(scene)
	for _frame in 36:
		await physics_frame

	var queen := scene.get_node("Ant") as CharacterBody3D
	var gait := scene.get_node("Ant/ProceduralGait") as ProceduralAntGait

	if walking:
		Input.action_press("move_forward")
		for _frame in 40:
			await physics_frame

	# The follow camera the player actually looks through.
	for _frame in 4:
		await process_frame
	root.get_viewport().get_texture().get_image().save_png(
		"res://_view_game%s.png" % ("_walk" if walking else ""))

	var follow := queen.get_node("CameraPivot/SpringArm3D/Camera3D") as Camera3D
	follow.current = false
	var camera := Camera3D.new()
	camera.fov = 42.0
	camera.near = 0.02
	scene.add_child(camera)
	camera.current = true

	var shots := {
		"side": Vector3(3.4, 0.32, 0.0),
		"front": Vector3(0.0, 0.32, -3.4),
		"top": Vector3(0.0, 3.6, 0.02),
		"low": Vector3(1.8, 0.12, -1.8),
	}
	for key in shots:
		# Re-aim every shot: she keeps walking between them.
		var focus := queen.global_position + Vector3(0.0, 0.30, 0.0)
		camera.global_position = focus + (shots[key] as Vector3)
		camera.look_at(focus, Vector3.FORWARD if key == "top" else Vector3.UP)
		for _frame in 4:
			await process_frame
		root.get_viewport().get_texture().get_image().save_png(
			"res://_view_%s%s.png" % [key, "_walk" if walking else ""])

	if walking:
		Input.action_release("move_forward")
	print("VIEWS stance_feet=", gait.stance_feet,
		" max_foot_error_mm=", snappedf(gait.max_foot_error * 5.0, 0.001))
	scene.queue_free()
	for _frame in 3:
		await process_frame
	quit()
