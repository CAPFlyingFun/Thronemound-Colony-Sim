extends SceneTree

## Photographs the queen walking up a vertical face.
##
## The mound's own perimeter cliff faces outward over empty space, so this drops
## a slab in front of her to climb. Run with:
##   Godot --path . --script res://scripts/climb_views.gd
## Writes _climb_00.png .. _climb_05.png plus a trace of her lean at each shot.

func _initialize() -> void:
	var scene := (load("res://scenes/terrain_lab.tscn") as PackedScene).instantiate()
	root.add_child(scene)
	for _f in 30:
		await physics_frame

	var queen := scene.get_node("Ant") as CharacterBody3D
	var gait := scene.get_node("Ant/ProceduralGait") as ProceduralAntGait

	var wall := StaticBody3D.new()
	wall.collision_layer = 1
	wall.collision_mask = 0
	wall.position = Vector3(0.0, queen.global_position.y + 1.6, -5.9)
	scene.add_child(wall)
	var box := BoxShape3D.new()
	box.size = Vector3(7.0, 5.0, 6.2)
	var shape := CollisionShape3D.new()
	shape.shape = box
	wall.add_child(shape)
	var mesh := MeshInstance3D.new()
	var box_mesh := BoxMesh.new()
	box_mesh.size = box.size
	mesh.mesh = box_mesh
	var material := StandardMaterial3D.new()
	material.albedo_color = Color(0.40, 0.31, 0.23)
	material.roughness = 1.0
	mesh.material_override = material
	wall.add_child(mesh)
	for _f in 5:
		await physics_frame

	var follow := queen.get_node("CameraPivot/SpringArm3D/Camera3D") as Camera3D
	follow.current = false
	var camera := Camera3D.new()
	camera.fov = 44.0
	camera.near = 0.02
	scene.add_child(camera)
	camera.current = true

	Input.action_press("move_forward")
	var shot := 0
	for step in 210:
		await physics_frame
		# Side-on, so the angle between her and the face is unambiguous.
		if step % 35 == 34:
			var focus := queen.global_position
			camera.global_position = focus + Vector3(3.6, 0.5, 1.1)
			camera.look_at(focus)
			for _f in 3:
				await process_frame
			root.get_viewport().get_texture().get_image().save_png(
				"res://_climb_%02d.png" % shot)
			print("shot %d: pos=(%.2f, %.2f, %.2f) lean=%.1f deg grip=%s feet=%d err=%.2f mm" % [
				shot, queen.global_position.x, queen.global_position.y,
				queen.global_position.z, queen.surface_angle_deg(),
				queen.is_gripping(), gait.stance_feet, gait.max_foot_error * 5.0])
			shot += 1
	Input.action_release("move_forward")
	quit()
