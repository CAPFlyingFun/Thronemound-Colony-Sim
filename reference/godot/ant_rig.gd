class_name AntRig
extends RefCounted

## Works out an ant's anatomy from the shape of its skeleton.
##
## The three Meshy exports do NOT share a bone table. The queen and the worker
## hang all six legs off one hub bone; the major worker hangs each pair off its
## own thoracic segment, has 64 bones to the queen's 53, and numbers everything
## differently. Hard-coding three tables would mean hand-mapping every future
## export too, and getting one index wrong shows up as a leg that bends the
## wrong way rather than as an error.
##
## So nothing here is named. The rig is read from its own geometry:
##
##   legs      the six chains whose tips sit lowest AND furthest out to the
##             side. Six is the strongest constraint available -- every ant has
##             exactly six, so the six best candidates are the six legs.
##   gaster    of the remaining chains, the one reaching furthest BACKWARD.
##   antennae  of the rest, the two reaching furthest out to the SIDE.
##   mandibles whatever appendages are left, near the midline of the head.
##
## Verified against the queen's previously hand-written table: discovery
## reproduces it exactly, chain for chain.

## Ant models from Meshy end each limb in a marker bone a hair's breadth from
## its parent. It is not a joint and must not be an IK target.
const TERMINAL_LENGTH_RATIO := 0.25

var skeleton: Skeleton3D
## One dictionary per leg: slot, tripod, bones (coxa..claw), claw, terminal.
var legs: Array[Dictionary] = []
## Bone indices of the antennae and mandibles -- thin, mobile, swept low.
var slim_bones := {}
## The far tip of each antenna, for the ground-clearance damping.
var antenna_tips: Array[int] = []
## Where each antenna joins the head -- the bone the idle sweep rotates.
var antenna_roots: Array[int] = []
## Root bone of each mandible, for combat and carrying later on.
var mandible_roots: Array[int] = []
## Tip of each mandible -- where it actually meets whatever she is biting.
var mandible_tips: Array[int] = []
var gaster_tip := -1
## Where the gaster attaches to the thorax -- the petiole joint.
var gaster_root := -1
## Neck joint: the lowest bone that is an ancestor of both the antennae and
## the mandibles, i.e. where the whole head assembly attaches to the thorax.
var head_bone := -1
var valid := false
var problem := ""

const SLOTS := [
	["front_left", 0], ["front_right", 1],
	["mid_left", 1], ["mid_right", 0],
	["rear_left", 0], ["rear_right", 1],
]


static func discover(from_skeleton: Skeleton3D) -> AntRig:
	var rig := AntRig.new()
	rig.skeleton = from_skeleton
	rig._build()
	return rig


func _build() -> void:
	if skeleton == null or skeleton.get_bone_count() == 0:
		problem = "no skeleton"
		return

	# Rest positions in the skeleton's own space. Scale and orientation of the
	# instance are irrelevant here; only the anatomy matters.
	var rest := []
	rest.resize(skeleton.get_bone_count())
	for index in skeleton.get_bone_count():
		rest[index] = skeleton.get_bone_global_rest(index).origin

	var extent := AABB(rest[0], Vector3.ZERO)
	for point in rest:
		extent = extent.expand(point)
	var half_width := maxf(0.001, extent.size.x * 0.5)

	# Every chain: a leaf, and the path back up to the bone whose parent branches.
	var chains: Array[Dictionary] = []
	for index in skeleton.get_bone_count():
		if not skeleton.get_bone_children(index).is_empty():
			continue
		var path: Array[int] = [index]
		var cursor := index
		while true:
			var parent := skeleton.get_bone_parent(cursor)
			if parent < 0 or skeleton.get_bone_children(parent).size() > 1:
				break
			path.push_front(parent)
			cursor = parent
		var tip: Vector3 = rest[index]
		chains.append({
			"leaf": index, "path": path, "tip": tip,
			"root": path[0], "root_at": rest[path[0]],
		})

	# Legs: lateral and low. The sideways test is what separates a leg tip from
	# the gaster -- on the major worker the gaster tip actually hangs LOWER than
	# the feet, so height alone picks the wrong chain.
	var candidates: Array[Dictionary] = []
	for chain in chains:
		if absf((chain["tip"] as Vector3).x - extent.get_center().x) > half_width * 0.12:
			candidates.append(chain)
	candidates.sort_custom(func(a, b): return (a["tip"] as Vector3).y < (b["tip"] as Vector3).y)
	if candidates.size() < 6:
		problem = "found only %d limb chains that could be legs" % candidates.size()
		return
	var leg_chains := candidates.slice(0, 6)

	# Front to back by where the leg JOINS the body, not by where it lands: a
	# foot can be planted anywhere, but a coxa is bolted to its segment.
	leg_chains.sort_custom(func(a, b):
		return (a["root_at"] as Vector3).z > (b["root_at"] as Vector3).z)
	var ordered: Array[Dictionary] = []
	for pair_index in 3:
		var pair := [leg_chains[pair_index * 2], leg_chains[pair_index * 2 + 1]]
		pair.sort_custom(func(a, b):
			return (a["root_at"] as Vector3).x < (b["root_at"] as Vector3).x)
		ordered.append(pair[0])
		ordered.append(pair[1])

	for slot_index in SLOTS.size():
		var chain: Dictionary = ordered[slot_index]
		var path: Array = chain["path"]
		if path.size() < 3:
			problem = "%s chain has only %d bones" % [SLOTS[slot_index][0], path.size()]
			return
		# Drop the terminal marker; the claw is the bone it hangs off.
		var bones: Array[String] = []
		for step in range(0, path.size() - 1):
			bones.append(skeleton.get_bone_name(path[step]))
		legs.append({
			"slot": SLOTS[slot_index][0],
			"tripod": SLOTS[slot_index][1],
			"bones": bones,
			"claw": path[path.size() - 2],
			"terminal": path[path.size() - 1],
		})

	# What is left over: the gaster reaches backward, the antennae sideways.
	var leftovers: Array[Dictionary] = []
	for chain in chains:
		var is_leg := false
		for leg_chain in leg_chains:
			if leg_chain["leaf"] == chain["leaf"]:
				is_leg = true
				break
		if not is_leg:
			leftovers.append(chain)

	if not leftovers.is_empty():
		leftovers.sort_custom(func(a, b): return (a["tip"] as Vector3).z < (b["tip"] as Vector3).z)
		gaster_tip = leftovers[0]["leaf"]
		# The petiole: where the gaster's own chain starts, one step past the
		# waist joint it shares with every leg. Rotating THIS bone swings just
		# the gaster; rotating the shared waist joint would swing the legs too.
		gaster_root = leftovers[0]["root"]
		leftovers.remove_at(0)

	leftovers.sort_custom(func(a, b):
		return absf((a["tip"] as Vector3).x) > absf((b["tip"] as Vector3).x))
	for appendage_index in leftovers.size():
		var chain: Dictionary = leftovers[appendage_index]
		for bone in chain["path"]:
			slim_bones[bone] = true
		if appendage_index < 2:
			antenna_tips.append(chain["leaf"])
			antenna_roots.append(chain["root"])
		else:
			mandible_roots.append(chain["root"])
			mandible_tips.append(chain["leaf"])

	# Head/neck: the deepest bone that is an ancestor of both an antenna and a
	# mandible. Appendages can branch off the thorax at different depths -- the
	# major worker's antennae and mandibles do not share an immediate parent --
	# so this walks each one's full ancestry back to the skeleton root and
	# takes the last bone still common to both, rather than assuming a single
	# shared parent bone.
	if not antenna_tips.is_empty() and not mandible_roots.is_empty():
		var antenna_ancestry := _ancestry(antenna_tips[0])
		var mandible_ancestry := _ancestry(mandible_roots[0])
		for depth in range(mini(antenna_ancestry.size(), mandible_ancestry.size())):
			if antenna_ancestry[depth] != mandible_ancestry[depth]:
				break
			head_bone = antenna_ancestry[depth]

	valid = true


## The bone itself, then every ancestor up to the skeleton root, nearest last.
func _ancestry(index: int) -> Array[int]:
	var chain: Array[int] = [index]
	var cursor := index
	while skeleton.get_bone_parent(cursor) >= 0:
		cursor = skeleton.get_bone_parent(cursor)
		chain.push_front(cursor)
	return chain


## Human-readable dump, for the rig report and for eyeballing a new export.
func describe() -> String:
	if not valid:
		return "AntRig INVALID: " + problem
	var lines: Array[String] = []
	lines.append("bones=%d legs=%d antennae=%d mandibles=%d" % [
		skeleton.get_bone_count(), legs.size(),
		antenna_tips.size(), mandible_roots.size()])
	for leg in legs:
		lines.append("  %-12s tripod %d  %s -> claw %s" % [
			leg["slot"], leg["tripod"], " ".join(leg["bones"]),
			skeleton.get_bone_name(leg["claw"])])
	var antenna_names: Array[String] = []
	for tip in antenna_tips:
		antenna_names.append(skeleton.get_bone_name(tip))
	var mandible_names: Array[String] = []
	for root in mandible_roots:
		mandible_names.append(skeleton.get_bone_name(root))
	var mandible_tip_names: Array[String] = []
	for tip in mandible_tips:
		mandible_tip_names.append(skeleton.get_bone_name(tip))
	lines.append("  antenna tips: %s" % " ".join(antenna_names))
	lines.append("  mandible roots: %s  tips: %s" % [
		" ".join(mandible_names), " ".join(mandible_tip_names)])
	lines.append("  gaster tip: %s  root: %s" % [
		skeleton.get_bone_name(gaster_tip) if gaster_tip >= 0 else "none",
		skeleton.get_bone_name(gaster_root) if gaster_root >= 0 else "none"])
	lines.append("  head bone: %s" % (
		skeleton.get_bone_name(head_bone) if head_bone >= 0 else "none"))
	return "\n".join(lines)
