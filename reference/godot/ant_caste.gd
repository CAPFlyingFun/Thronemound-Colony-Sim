class_name AntCaste
extends RefCounted

## The three playable fire ants, and how big each one really is.
##
## All three Meshy exports are normalised to 1.7 units tall in their own space,
## so the GLB says nothing about how big the animal is. Real Solenopsis invicta
## castes differ by roughly 3x from a minor worker to a queen, and at 5 mm per
## world unit that difference is the whole point of switching between them.
## So each caste declares a body length in millimetres and the scale is derived
## from it -- never the other way round.
##
## `gait_scale` then carries that size through to every length-dimensioned
## tunable in ProceduralAntGait: stride, foot lift, belly clearance, probe
## reach. A worker a third of the queen's size takes a third of her stride. The
## queen's factor is exactly 1.0, so her behaviour is untouched by any of this.

const VOXEL_MM := AntScale.VOXEL_MM

## Height of every export in its own space, before scaling.
const ART_HEIGHT := 1.7
## The queen stands this many world units tall. The reference for gait_scale.
const QUEEN_STAND := 0.7

const ORDER := ["queen", "major", "worker"]

const CASTES := {
	"queen": {
		"title": "Founding Queen",
		"model": "res://assets/ant models/Queen/fire_ant_queen.glb",
		# Measured from the export: the AABB depth along its own +Z.
		"art_length": 4.492,
		"body_length_mm": 9.25,
		"walk_speed": 4.5,
		"run_speed": 7.5,
		"has_mandibles": false,
	},
	"major": {
		"title": "Major Worker",
		"model": "res://assets/ant models/Major Worker/Fire Ant Major Worker.glb",
		"art_length": 3.592,
		"body_length_mm": 5.5,
		# Smaller ants are quicker over the ground relative to their size, and a
		# soldier that cannot keep up with the queen is no use as an escort.
		"walk_speed": 5.2,
		"run_speed": 8.8,
		"has_mandibles": true,
	},
	"worker": {
		"title": "Minor Worker",
		"model": "res://assets/ant models/Worker/Fire Ant Worker.glb",
		"art_length": 4.826,
		"body_length_mm": 3.2,
		"walk_speed": 6.0,
		"run_speed": 10.4,
		"has_mandibles": true,
	},
}


## Everything the ant scene needs to build itself, with the derived numbers
## already worked out.
static func get_caste(name: String) -> Dictionary:
	var key := name if CASTES.has(name) else ORDER[0]
	var config: Dictionary = CASTES[key].duplicate()
	var scale: float = float(config["body_length_mm"]) / (
		float(config["art_length"]) * VOXEL_MM)
	var stand: float = ART_HEIGHT * scale
	config["key"] = key
	config["scale"] = scale
	config["stand"] = stand
	config["stand_height_mm"] = stand * VOXEL_MM
	config["gait_scale"] = stand / QUEEN_STAND
	# The capsule is a movement proxy, not a silhouette: it keeps the queen's
	# proportions relative to her own height so every caste is carried the same
	# way. Her real width is three times this, which is why the gait raises the
	# body separately rather than trusting the capsule to hold her clear.
	config["capsule_radius"] = 0.3 * config["gait_scale"]
	config["capsule_height"] = stand
	return config


static func next(name: String, step := 1) -> String:
	var index := ORDER.find(name)
	if index < 0:
		index = 0
	return ORDER[posmod(index + step, ORDER.size())]
