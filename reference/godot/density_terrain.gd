class_name DensityTerrain
extends StaticBody3D

## Small signed-density terrain laboratory.
##
## Positive samples are packed soil, negative samples are air, and the zero
## crossing is rendered with surface nets.  This is the same representation as
## the browser density-terrain lab, including its 0.5 voxel / 2.5 mm sampling
## interval and its volume-producing spherical subtraction brush.

signal terrain_changed(revision: int)

@export_group("Field")
@export_range(16, 96, 1) var cells_x := 24
@export_range(8, 48, 1) var cells_y := 10
@export_range(16, 96, 1) var cells_z := 24
@export_range(0.1, 1.0, 0.05) var cell_size := 0.5
@export var base_height := 3.0
@export var boundary_margin := 0.38

@export_group("Digging")
@export_range(0.2, 2.0, 0.05) var brush_radius := 0.72

@onready var _mesh_instance: MeshInstance3D = $MeshInstance3D
@onready var _collision_shape: CollisionShape3D = $CollisionShape3D

var revision := 0
var removed_volume := 0.0
var last_build_ms := 0.0
var vertex_count := 0
var triangle_count := 0

var _samples_x := 0
var _samples_y := 0
var _samples_z := 0
var _values := PackedFloat32Array()
var _material: StandardMaterial3D

const CORNERS := [
	Vector3i(0, 0, 0), Vector3i(1, 0, 0),
	Vector3i(0, 1, 0), Vector3i(1, 1, 0),
	Vector3i(0, 0, 1), Vector3i(1, 0, 1),
	Vector3i(0, 1, 1), Vector3i(1, 1, 1),
]

const EDGES := [
	Vector2i(0, 1), Vector2i(2, 3), Vector2i(4, 5), Vector2i(6, 7),
	Vector2i(0, 2), Vector2i(1, 3), Vector2i(4, 6), Vector2i(5, 7),
	Vector2i(0, 4), Vector2i(1, 5), Vector2i(2, 6), Vector2i(3, 7),
]


func _ready() -> void:
	collision_layer = 1
	collision_mask = 0
	_make_material()
	reset_terrain()


func reset_terrain() -> void:
	_samples_x = cells_x + 1
	_samples_y = cells_y + 1
	_samples_z = cells_z + 1
	_values.resize(_samples_x * _samples_y * _samples_z)

	for z in _samples_z:
		var wz := z * cell_size
		for x in _samples_x:
			var wx := x * cell_size
			var height := _height_at_local(wx, wz)
			for y in _samples_y:
				var wy := y * cell_size
				var density := height - wy
				# Close the soil body on all six sides.  This makes the generated
				# surface genuinely watertight instead of an open height sheet.
				density = minf(density, wy - boundary_margin)
				density = minf(density, cells_y * cell_size - boundary_margin - wy)
				density = minf(density, wx - boundary_margin)
				density = minf(density, cells_x * cell_size - boundary_margin - wx)
				density = minf(density, wz - boundary_margin)
				density = minf(density, cells_z * cell_size - boundary_margin - wz)
				_values[_sample_index(x, y, z)] = density

	removed_volume = 0.0
	revision += 1
	_rebuild_mesh()
	terrain_changed.emit(revision)


## Cut a smooth sphere from the soil and return the removed volume in world
## units cubed.  The loose clod visual is scaled from this same number.
func subtract_sphere(world_center: Vector3, radius := -1.0) -> Dictionary:
	if radius <= 0.0:
		radius = brush_radius
	var center := to_local(world_center)
	var padding := cell_size
	var min_x := clampi(floori((center.x - radius - padding) / cell_size), 0, _samples_x - 1)
	var min_y := clampi(floori((center.y - radius - padding) / cell_size), 0, _samples_y - 1)
	var min_z := clampi(floori((center.z - radius - padding) / cell_size), 0, _samples_z - 1)
	var max_x := clampi(ceili((center.x + radius + padding) / cell_size), 0, _samples_x - 1)
	var max_y := clampi(ceili((center.y + radius + padding) / cell_size), 0, _samples_y - 1)
	var max_z := clampi(ceili((center.z + radius + padding) / cell_size), 0, _samples_z - 1)

	var changed := 0
	var removed := 0.0
	var sample_volume := cell_size * cell_size * cell_size
	for z in range(min_z, max_z + 1):
		var wz := z * cell_size
		for y in range(min_y, max_y + 1):
			var wy := y * cell_size
			for x in range(min_x, max_x + 1):
				var wx := x * cell_size
				var brush_distance := Vector3(wx, wy, wz).distance_to(center) - radius
				var index := _sample_index(x, y, z)
				var old_density := _values[index]
				var new_density := minf(old_density, brush_distance)
				if new_density >= old_density - 0.0000001:
					continue
				_values[index] = new_density
				changed += 1
				removed += maxf(0.0, _occupancy(old_density) - _occupancy(new_density)) * sample_volume

	if changed > 0:
		removed_volume += removed
		revision += 1
		_rebuild_mesh()
		terrain_changed.emit(revision)
	return {"removed_volume": removed, "changed_samples": changed}


## Analytic untouched surface height, useful for placing the queen before the
## first physics frame.  Foot placement itself always raycasts the live mesh.
func surface_height_world(world_x: float, world_z: float) -> float:
	var local := to_local(Vector3(world_x, 0.0, world_z))
	return to_global(Vector3(local.x, _height_at_local(local.x, local.z), local.z)).y


func _height_at_local(x: float, z: float) -> float:
	# Broad mound, medium undulation, and ant-scale grit.  Every octave is
	# deterministic so reset produces exactly the same test surface.
	var cx := cells_x * cell_size * 0.5
	var cz := cells_z * cell_size * 0.5
	var dx := (x - cx) / maxf(0.001, cx)
	var dz := (z - cz) / maxf(0.001, cz)
	var mound := maxf(0.0, 1.0 - (dx * dx + dz * dz)) * 0.38
	return base_height + mound \
		+ 0.28 * sin(x * 0.72) * cos(z * 0.61) \
		+ 0.11 * sin(x * 2.07 + 0.8) * cos(z * 1.83 - 0.4) \
		+ 0.035 * sin(x * 7.2) * cos(z * 6.6)


func _occupancy(density: float) -> float:
	return clampf(0.5 + density / (2.0 * cell_size), 0.0, 1.0)


func _sample_index(x: int, y: int, z: int) -> int:
	return x + _samples_x * (y + _samples_y * z)


func _cell_index(x: int, y: int, z: int) -> int:
	return x + cells_x * (y + cells_y * z)


func _density(x: int, y: int, z: int) -> float:
	if x < 0 or x >= _samples_x or y < 0 or y >= _samples_y or z < 0 or z >= _samples_z:
		return -1.0e20
	return _values[_sample_index(x, y, z)]


func _rebuild_mesh() -> void:
	var started := Time.get_ticks_usec()
	var vertex_by_cell := PackedInt32Array()
	vertex_by_cell.resize(cells_x * cells_y * cells_z)
	vertex_by_cell.fill(-1)
	var positions: Array[Vector3] = []
	var indices: Array[int] = []
	var densities := PackedFloat32Array()
	densities.resize(8)

	# One representative vertex in each cell crossed by the zero surface.
	for z in cells_z:
		for y in cells_y:
			for x in cells_x:
				var inside_count := 0
				for corner in 8:
					var offset: Vector3i = CORNERS[corner]
					var value := _density(x + offset.x, y + offset.y, z + offset.z)
					densities[corner] = value
					if value > 0.0:
						inside_count += 1
				if inside_count == 0 or inside_count == 8:
					continue

				var crossing_sum := Vector3.ZERO
				var crossings := 0
				for edge in EDGES:
					var a: int = edge.x
					var b: int = edge.y
					var da := densities[a]
					var db := densities[b]
					if (da > 0.0) == (db > 0.0):
						continue
					var ca: Vector3i = CORNERS[a]
					var cb: Vector3i = CORNERS[b]
					var t := da / (da - db)
					crossing_sum += Vector3(ca) + (Vector3(cb) - Vector3(ca)) * t
					crossings += 1
				if crossings == 0:
					continue

				var vertex := positions.size()
				positions.append((Vector3(x, y, z) + crossing_sum / crossings) * cell_size)
				vertex_by_cell[_cell_index(x, y, z)] = vertex

	# Each sign-changing grid edge owns one quad.  All three axes use the same
	# cyclic vertex order, which keeps the closed mesh consistently oriented.
	for z in cells_z:
		for y in cells_y:
			for x in cells_x:
				var start := _density(x, y, z)
				if (start > 0.0) != (_density(x + 1, y, z) > 0.0):
					_add_quad(indices,
						_vertex_at(vertex_by_cell, x, y, z),
						_vertex_at(vertex_by_cell, x, y - 1, z),
						_vertex_at(vertex_by_cell, x, y - 1, z - 1),
						_vertex_at(vertex_by_cell, x, y, z - 1), start < 0.0)
				if (start > 0.0) != (_density(x, y + 1, z) > 0.0):
					_add_quad(indices,
						_vertex_at(vertex_by_cell, x, y, z),
						_vertex_at(vertex_by_cell, x, y, z - 1),
						_vertex_at(vertex_by_cell, x - 1, y, z - 1),
						_vertex_at(vertex_by_cell, x - 1, y, z), start < 0.0)
				if (start > 0.0) != (_density(x, y, z + 1) > 0.0):
					_add_quad(indices,
						_vertex_at(vertex_by_cell, x, y, z),
						_vertex_at(vertex_by_cell, x - 1, y, z),
						_vertex_at(vertex_by_cell, x - 1, y - 1, z),
						_vertex_at(vertex_by_cell, x, y - 1, z), start < 0.0)

	var surface := SurfaceTool.new()
	surface.begin(Mesh.PRIMITIVE_TRIANGLES)
	for point in positions:
		surface.set_uv(Vector2(point.x, point.z) * 0.35)
		surface.add_vertex(point)
	for index in indices:
		surface.add_index(index)
	surface.generate_normals()
	var mesh := surface.commit()
	if mesh != null and mesh.get_surface_count() > 0:
		mesh.surface_set_material(0, _material)
	_mesh_instance.mesh = mesh
	_collision_shape.shape = mesh.create_trimesh_shape() if mesh != null else null
	vertex_count = positions.size()
	triangle_count = indices.size() / 3
	last_build_ms = (Time.get_ticks_usec() - started) / 1000.0


func _vertex_at(map: PackedInt32Array, x: int, y: int, z: int) -> int:
	if x < 0 or x >= cells_x or y < 0 or y >= cells_y or z < 0 or z >= cells_z:
		return -1
	return map[_cell_index(x, y, z)]


func _add_quad(indices: Array[int], a: int, b: int, c: int, d: int, flip: bool) -> void:
	if a < 0 or b < 0 or c < 0 or d < 0:
		return
	if flip:
		indices.append_array([a, b, c, a, c, d])
	else:
		indices.append_array([a, d, c, a, c, b])


func _make_material() -> void:
	_material = StandardMaterial3D.new()
	_material.albedo_color = Color(0.62, 0.49, 0.34)
	_material.albedo_texture = load("res://assets/texures/brown_dirt_7/brown_dirt_7_diffuse.png")
	_material.normal_enabled = true
	_material.normal_texture = load("res://assets/texures/brown_dirt_7/brown_dirt_7_normal.png")
	_material.normal_scale = 0.42
	_material.roughness = 0.93
	_material.uv1_triplanar = true
	_material.uv1_world_triplanar = true
	_material.uv1_scale = Vector3.ONE * 0.14
	_material.texture_filter = BaseMaterial3D.TEXTURE_FILTER_LINEAR_WITH_MIPMAPS_ANISOTROPIC
