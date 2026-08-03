extends SceneTree

## Runs AntRig's anatomy discovery over every caste and prints what it found.
##
##   Godot --headless --path . --script res://scripts/rig_report.gd
##
## For the queen it also checks the result against the bone table that was
## hand-written before discovery existed. That table was verified frame by frame
## against the rendered model, so it is the reference: if discovery ever stops
## reproducing it, discovery is what broke.

const QUEEN_REFERENCE := {
	"front_left": ["Bone_024", "Bone_023", "Bone_022", "Bone_021", "Bone_020"],
	"front_right": ["Bone_030", "Bone_029", "Bone_028", "Bone_027", "Bone_026"],
	"mid_left": ["Bone_012", "Bone_011", "Bone_010", "Bone_009", "Bone_008"],
	"mid_right": ["Bone_018", "Bone_017", "Bone_016", "Bone_015", "Bone_014"],
	"rear_left": ["Bone_037", "Bone_036", "Bone_035", "Bone_034", "Bone_033", "Bone_032"],
	"rear_right": ["Bone_044", "Bone_043", "Bone_042", "Bone_041", "Bone_040", "Bone_039"],
}


func _initialize() -> void:
	var failures: Array[String] = []
	for caste in AntCaste.ORDER:
		var config := AntCaste.get_caste(caste)
		var packed := load(config["model"]) as PackedScene
		if packed == null:
			failures.append("%s: could not load %s" % [caste, config["model"]])
			continue
		var model := packed.instantiate()
		root.add_child(model)
		await process_frame

		var found := model.find_children("*", "Skeleton3D", true, false)
		if found.is_empty():
			failures.append("%s: no Skeleton3D" % caste)
			model.queue_free()
			continue
		var rig := AntRig.discover(found[0] as Skeleton3D)
		print("=== %s (%s) ===" % [caste, config["title"]])
		print(rig.describe())
		print("  art length=%.3f  scale=%.4f  ->  body %.2f mm, stands %.2f mm" % [
			config["art_length"], config["scale"],
			config["body_length_mm"], config["stand_height_mm"]])

		if not rig.valid:
			failures.append("%s: %s" % [caste, rig.problem])
		elif caste == "queen":
			for leg in rig.legs:
				var expected: Array = QUEEN_REFERENCE[leg["slot"]]
				var actual: Array = leg["bones"]
				if actual != expected:
					failures.append("queen %s discovered %s, reference says %s" % [
						leg["slot"], actual, expected])
		model.queue_free()
		await process_frame

	if failures.is_empty():
		print("RIG REPORT PASS")
		quit(0)
	for failure in failures:
		push_error(failure)
	quit(1)
