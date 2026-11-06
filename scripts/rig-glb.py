"""CPU-only experimental GLB auto-rigger for upright human-shaped meshes.

This is a deliberately small offline preprocessor, not a replacement for learned riggers.
It places a VRM-named humanoid skeleton from the mesh bounds, tries Blender bone-heat weights,
then envelope weights, and repairs uncovered vertices with segment-distance weights. The final
skin is normalized and limited to four influences per vertex. The input mesh/materials/UVs are
never rewritten. Output is a separate GLB plus a JSON diagnostic report.
"""
import bpy
import bmesh
import json
import os
import sys
import numpy as np


def cli_args():
    args = sys.argv[sys.argv.index("--") + 1:]
    if len(args) < 2:
        raise SystemExit("usage: blender --background --python scripts/rig-glb.py -- input.glb output.glb [--forward -y] [--weights heat|distance]")
    source, output = args[:2]
    forward = "-y"
    weights = "heat"
    if "--forward" in args:
        forward = args[args.index("--forward") + 1].lower()
    if "--weights" in args:
        weights = args[args.index("--weights") + 1].lower()
    if weights not in {"heat", "envelope", "distance"}:
        raise SystemExit("--weights must be heat, envelope, or distance")
    return os.path.abspath(source), os.path.abspath(output), forward, weights


def clear_scene():
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    for datablocks in (bpy.data.meshes, bpy.data.armatures, bpy.data.cameras, bpy.data.lights):
        for item in list(datablocks):
            if item.users == 0:
                datablocks.remove(item)


def mesh_world_vertices(obj):
    flat = np.empty(len(obj.data.vertices) * 3, dtype=np.float32)
    obj.data.vertices.foreach_get("co", flat)
    coords = flat.reshape((-1, 3))
    matrix = np.array(obj.matrix_world, dtype=np.float32)
    return coords @ matrix[:3, :3].T + matrix[:3, 3]


def mesh_topology(obj):
    bm = bmesh.new()
    try:
        bm.from_mesh(obj.data)
        return {
            "vertices": len(bm.verts),
            "edges": len(bm.edges),
            "faces": len(bm.faces),
            "boundaryEdges": sum(edge.is_boundary for edge in bm.edges),
            "nonManifoldEdges": sum(not edge.is_manifold for edge in bm.edges),
        }
    finally:
        bm.free()


def make_bones(bounds, forward):
    lo, hi = bounds
    width = max(hi[0] - lo[0], 1e-4)
    height = max(hi[2] - lo[2], 1e-4)
    depth = max(hi[1] - lo[1], 1e-4)
    unit = 0.01 if 30.0 < height < 300.0 else (0.001 if 300.0 <= height < 3000.0 else 1.0)
    h, w = height * unit, width * unit
    cx, cy, floor = (lo[0] + hi[0]) * 0.5 * unit, (lo[1] + hi[1]) * 0.5 * unit, lo[2] * unit
    side = min(w * 0.5, h * 0.145)
    upper_leg_x = min(side * 0.52, h * 0.06)
    shoulder_x = min(side * 0.72, h * 0.12)
    elbow_x = min(side * 1.37, h * 0.25)
    wrist_x = min(side * 1.78, h * 0.34)
    hand_x = min(side * 1.96, h * 0.37)
    front = -1.0 if forward.startswith("-") else 1.0
    pose_y = cy
    z = lambda ratio: floor + h * ratio
    point = lambda x, y, ratio: (cx + x, y + pose_y, z(ratio))
    points = {
        "hips": point(0, 0, 0.51),
        "spine": point(0, 0, 0.61),
        "chest": point(0, 0, 0.72),
        "neck": point(0, 0, 0.83),
        "head": point(0, 0, 0.90),
    }
    parents = {"hips": None, "spine": "hips", "chest": "spine", "neck": "chest", "head": "neck"}
    sigma = {"hips": .085, "spine": .09, "chest": .09, "neck": .055, "head": .085}
    for side_name, sign in (("left", 1), ("right", -1)):
        side_roles = [
            (f"{side_name}UpperArm", "chest", point(sign * shoulder_x, 0, .72), .075),
            (f"{side_name}LowerArm", f"{side_name}UpperArm", point(sign * elbow_x, 0, .65), .075),
            (f"{side_name}Hand", f"{side_name}LowerArm", point(sign * wrist_x, 0, .59), .065),
            (f"{side_name}HandTip", f"{side_name}Hand", point(sign * hand_x, front * h * .025, .56), .055),
            (f"{side_name}UpperLeg", "hips", point(sign * upper_leg_x, 0, .51), .095),
            (f"{side_name}LowerLeg", f"{side_name}UpperLeg", point(sign * upper_leg_x * .92, 0, .28), .075),
            (f"{side_name}Foot", f"{side_name}LowerLeg", point(sign * upper_leg_x * .92, 0, .065), .065),
            (f"{side_name}Toes", f"{side_name}Foot", point(sign * upper_leg_x * .92, front * h * .10, .035), .045),
        ]
        for name, parent, tail, radius in side_roles:
            points[name] = tail
            parents[name] = parent
            sigma[name] = radius
    bones = []
    for name, parent in parents.items():
        head = points[name]
        children = [points[child] for child, p in parents.items() if p == name]
        if children:
            tail = max(children, key=lambda p: sum((p[i] - head[i]) ** 2 for i in range(3)))
        else:
            tail = (head[0], head[1], head[2] + h * .02)
        bones.append({"name": name, "parent": parent, "head": head, "tail": tail, "sigma": sigma[name] * h})
    return bones, {"heightMeters": h, "widthMeters": w, "depthMeters": depth * unit, "unitScale": unit,
                   "assumedForward": forward, "hipsHeightRatio": 0.51}


def build_armature(bones):
    data = bpy.data.armatures.new("h3dCanonicalHumanoid")
    armature = bpy.data.objects.new("h3dCanonicalHumanoid", data)
    bpy.context.collection.objects.link(armature)
    bpy.context.view_layer.objects.active = armature
    armature.select_set(True)
    bpy.ops.object.mode_set(mode="EDIT")
    edit_bones = {}
    for spec in bones:
        bone = data.edit_bones.new(spec["name"])
        bone.head, bone.tail = spec["head"], spec["tail"]
        bone.use_deform = True
        bone.head_radius = spec["sigma"] * 0.7
        bone.tail_radius = spec["sigma"] * 0.7
        bone.envelope_distance = spec["sigma"] * 2.0
        bone.envelope_weight = 1.0
        edit_bones[spec["name"]] = bone
    for spec in bones:
        if spec["parent"]:
            edit_bones[spec["name"]].parent = edit_bones[spec["parent"]]
            edit_bones[spec["name"]].use_connect = False
    bpy.ops.object.mode_set(mode="OBJECT")
    armature.show_in_front = True
    return armature


def clear_skinning(obj, original_parent, original_matrix):
    for modifier in list(obj.modifiers):
        if modifier.type == "ARMATURE":
            obj.modifiers.remove(modifier)
    for group in list(obj.vertex_groups):
        obj.vertex_groups.remove(group)
    obj.parent = original_parent
    obj.matrix_world = original_matrix


def skin_weight_counts(obj, allow_unweighted=False):
    group_names = {group.index: group.name for group in obj.vertex_groups}
    assigned = {name: 0 for name in group_names.values()}
    unweighted = []
    unnormalized = 0
    for vertex in obj.data.vertices:
        influences = [entry for entry in vertex.groups if entry.weight > 1e-6]
        total = sum(entry.weight for entry in influences)
        if not influences:
            unweighted.append(vertex.index)
            continue
        if abs(total - 1.0) > 0.02:
            unnormalized += 1
        for entry in influences:
            name = group_names.get(entry.group)
            if name in assigned:
                assigned[name] += 1
    if unweighted and not allow_unweighted:
        raise RuntimeError(f"{len(unweighted)} vertices have no bone weights")
    if unnormalized:
        raise RuntimeError(f"{unnormalized} vertices have non-normalized weights")
    return assigned, unweighted


def skin_mesh_heat(obj, armature):
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    armature.select_set(True)
    bpy.context.view_layer.objects.active = armature
    result = bpy.ops.object.parent_set(type="ARMATURE_AUTO")
    if "FINISHED" not in result:
        raise RuntimeError(f"Blender automatic weights returned {result}")
    bpy.context.view_layer.update()
    if not any(modifier.type == "ARMATURE" and modifier.object == armature for modifier in obj.modifiers):
        raise RuntimeError("Blender automatic weights did not add an armature modifier")
    counts, unweighted = skin_weight_counts(obj, allow_unweighted=True)
    if unweighted:
        raise RuntimeError(f"{len(unweighted)} vertices have no bone weights")
    return counts


def skin_mesh_envelope(obj, armature, bone_specs):
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    armature.select_set(True)
    bpy.context.view_layer.objects.active = armature
    result = bpy.ops.object.parent_set(type="ARMATURE_ENVELOPE")
    if "FINISHED" not in result:
        raise RuntimeError(f"Blender envelope weights returned {result}")
    bpy.context.view_layer.update()
    if not any(modifier.type == "ARMATURE" and modifier.object == armature for modifier in obj.modifiers):
        raise RuntimeError("Blender envelope weights did not add an armature modifier")
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.vertex_group_normalize_all(lock_active=False)
    bpy.context.view_layer.update()
    counts, unweighted = skin_weight_counts(obj, allow_unweighted=True)
    repaired = len(unweighted)
    if unweighted:
        assign_distance_weights(obj, bone_specs, unweighted)
        counts, unweighted = skin_weight_counts(obj, allow_unweighted=True)
    if unweighted:
        raise RuntimeError(f"distance repair left {len(unweighted)} vertices unweighted")
    return counts, repaired


def distance_weight_arrays(points, bone_specs):
    n, count = len(points), len(bone_specs)
    scores = np.empty((n, count), dtype=np.float32)
    starts, vectors, lengths = [], [], []
    for spec in bone_specs:
        start = np.asarray(spec["head"], dtype=np.float32)
        vector = np.asarray(spec["tail"], dtype=np.float32) - start
        starts.append(start)
        vectors.append(vector)
        lengths.append(float(vector @ vector))
    for index, spec in enumerate(bone_specs):
        start, vector = starts[index], vectors[index]
        amount = np.clip(((points - start) @ vector) / max(lengths[index], 1e-12), 0.0, 1.0)
        delta = points - (start + amount[:, None] * vector)
        distance2 = np.einsum("ij,ij->i", delta, delta)
        radius = max(float(spec["sigma"]), 0.012)
        scores[:, index] = np.exp(-distance2 / (2.0 * radius * radius))
    top = np.argpartition(scores, -4, axis=1)[:, -4:]
    weights = np.take_along_axis(scores, top, axis=1)
    weights /= np.maximum(weights.sum(axis=1, keepdims=True), 1e-12)
    return top, weights


def assign_distance_weights(obj, bone_specs, vertex_indices=None):
    indices = np.arange(len(obj.data.vertices)) if vertex_indices is None else np.asarray(vertex_indices, dtype=np.int64)
    points = mesh_world_vertices(obj)[indices].astype(np.float32, copy=False)
    top, weights = distance_weight_arrays(points, bone_specs)
    groups = {}
    for spec in bone_specs:
        groups[spec["name"]] = obj.vertex_groups.get(spec["name"]) or obj.vertex_groups.new(name=spec["name"])
    assigned = {}
    for index, spec in enumerate(bone_specs):
        rows, slots = np.where(top == index)
        values = np.round(weights[rows, slots], 4)
        active = values > 0.00005
        for weight in np.unique(values[active]):
            selected = indices[rows[active & (values == weight)]]
            groups[spec["name"]].add(selected.tolist(), float(weight), "REPLACE")
        assigned[spec["name"]] = int(np.count_nonzero(active))
    return assigned


def skin_mesh_distance(obj, armature, bone_specs):
    assigned = assign_distance_weights(obj, bone_specs)
    modifier = obj.modifiers.new("h3d humanoid skin", "ARMATURE")
    modifier.object = armature
    modifier.use_deform_preserve_volume = True
    obj.parent = armature
    obj.matrix_parent_inverse = armature.matrix_world.inverted()
    return assigned


def skin_mesh(obj, armature, bone_specs, requested_method):
    if requested_method == "distance":
        return skin_mesh_distance(obj, armature, bone_specs), "segment-distance", None
    original_parent = obj.parent
    original_matrix = obj.matrix_world.copy()
    attempts = ["heat", "envelope"] if requested_method == "heat" else ["envelope", "heat"]
    errors = []
    for method in attempts:
        try:
            if method == "heat":
                counts, repaired = skin_mesh_heat(obj, armature), 0
            else:
                counts, repaired = skin_mesh_envelope(obj, armature, bone_specs)
            label = f"blender-bone-{method}" if method == requested_method else f"blender-bone-{method}-fallback"
            if repaired:
                label += "+distance-repair"
                errors.append(f"envelope filled {repaired} unweighted vertices with distance weights")
            return counts, label, "; ".join(errors) or None
        except Exception as error:
            errors.append(f"{method}: {error}")
            clear_skinning(obj, original_parent, original_matrix)
    counts = skin_mesh_distance(obj, armature, bone_specs)
    return counts, "segment-distance-fallback", "; ".join(errors)


def finalize_skin_weights(obj):
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.vertex_group_limit_total(limit=4)
    bpy.ops.object.vertex_group_normalize_all(lock_active=False)
    counts, unweighted = skin_weight_counts(obj, allow_unweighted=True)
    if unweighted:
        raise RuntimeError(f"weight cleanup left {len(unweighted)} vertices unweighted")
    return counts


def main():
    source, output, forward, requested_weights = cli_args()
    if not os.path.isfile(source):
        raise SystemExit(f"input file not found: {source}")
    if not output.lower().endswith(".glb"):
        raise SystemExit("output must end in .glb")
    os.makedirs(os.path.dirname(output), exist_ok=True)
    clear_scene()
    bpy.ops.import_scene.gltf(filepath=source)
    meshes = [obj for obj in bpy.context.scene.objects if obj.type == "MESH" and len(obj.data.vertices)]
    if not meshes:
        raise SystemExit("input GLB has no mesh")
    topology_by_mesh = {obj.name: mesh_topology(obj) for obj in meshes}
    if any(obj.parent and obj.parent.type == "ARMATURE" for obj in meshes):
        raise SystemExit("input GLB already has an armature; import it directly in h3d instead")
    all_points = np.concatenate([mesh_world_vertices(obj) for obj in meshes])
    lo, hi = all_points.min(axis=0), all_points.max(axis=0)
    if hi[2] - lo[2] < max(hi[0] - lo[0], hi[1] - lo[1]) * 0.9:
        raise SystemExit("mesh does not look upright in Blender Z-up coordinates; convert the source axes first")
    bone_specs, proportions = make_bones((lo, hi), forward)
    armature = build_armature(bone_specs)
    weight_counts = {}
    methods = set()
    weight_warnings = []
    for obj in meshes:
        _, method, warning = skin_mesh(obj, armature, bone_specs, requested_weights)
        weight_counts[obj.name] = finalize_skin_weights(obj)
        methods.add(method)
        if warning:
            weight_warnings.append(f"{obj.name}: preferred weighting method failed; used fallback ({warning})")
        obj.select_set(False)
    armature.select_set(True)
    bpy.context.view_layer.objects.active = armature
    bpy.ops.export_scene.gltf(
        filepath=output,
        export_format="GLB",
        export_image_format="AUTO",
        export_materials="EXPORT",
        export_skins=True,
        export_influence_nb=4,
        export_all_influences=False,
        export_animations=False,
        export_cameras=False,
        export_lights=False,
        export_yup=True,
        export_apply=False,
    )
    report = {
        "schemaVersion": "h3d.avatar-rig-report.v1",
        "method": "bounds-humanoid-plus-" + "+".join(sorted(methods)),
        "weightMethodRequested": requested_weights,
        "weightMethods": sorted(methods),
        "experimental": True,
        "input": source,
        "output": output,
        "meshCount": len(meshes),
        "topologyByMesh": topology_by_mesh,
        "vertexCount": int(sum(len(mesh.data.vertices) for mesh in meshes)),
        "triangleCount": int(sum(sum(max(0, len(poly.vertices) - 2) for poly in mesh.data.polygons) for mesh in meshes)),
        "boneCount": len(bone_specs),
        "bones": [spec["name"] for spec in bone_specs],
        "weightAssignmentsByMeshAndBone": weight_counts,
        "boundsBlenderZUp": {"min": lo.tolist(), "max": hi.tolist()},
        "proportions": proportions,
        "preserved": ["mesh geometry", "UV coordinates", "source PBR materials and embedded images"],
        "warnings": [
            "The generated skeleton uses generic humanoid proportions estimated from the mesh bounds.",
            "Inspect elbows, knees, hands and clothing deformation before treating the rig as production quality.",
        ] + weight_warnings,
    }
    with open(os.path.splitext(output)[0] + ".avatar-report.json", "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=2)
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
