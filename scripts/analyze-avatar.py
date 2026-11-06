import bpy
import bmesh
import json
import sys
import numpy as np

args = sys.argv[sys.argv.index("--") + 1:]
if not args:
    raise SystemExit("usage: blender -b --python scripts/analyze-avatar.py -- input.glb")
source = args[0]
bpy.ops.object.select_all(action="SELECT")
bpy.ops.object.delete(use_global=False)
bpy.ops.import_scene.gltf(filepath=source)
scene_meshes = [o for o in bpy.context.scene.objects if o.type == "MESH"]
coords = []
for obj in scene_meshes:
    local = np.empty(len(obj.data.vertices) * 3, dtype=np.float32)
    obj.data.vertices.foreach_get("co", local)
    local = local.reshape((-1, 3))
    matrix = np.array(obj.matrix_world, dtype=np.float32)
    world = local @ matrix[:3, :3].T + matrix[:3, 3]
    coords.append(world)
if not coords:
    raise SystemExit("GLB has no mesh vertices")
coords = np.concatenate(coords)
mins = coords.min(axis=0)
maxs = coords.max(axis=0)
height = float(maxs[2] - mins[2])
bands = []
for i in range(12):
    lo = float(mins[2] + height * i / 12)
    hi = float(mins[2] + height * (i + 1) / 12)
    points = coords[(coords[:, 2] >= lo) & (coords[:, 2] < hi)]
    bands.append({"z": [round(lo, 4), round(hi, 4)],
                  "count": int(len(points)),
                  "x": [round(float(points[:, 0].min()), 4), round(float(points[:, 0].max()), 4)] if len(points) else None,
                  "y": [round(float(points[:, 1].min()), 4), round(float(points[:, 1].max()), 4)] if len(points) else None})
topology = []
for obj in scene_meshes:
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    topology.append({"mesh": obj.name, "vertices": len(bm.verts), "edges": len(bm.edges), "faces": len(bm.faces),
                     "boundaryEdges": sum(edge.is_boundary for edge in bm.edges),
                     "nonManifoldEdges": sum(not edge.is_manifold for edge in bm.edges)})
    bm.free()
print(json.dumps({
    "meshes": [{"name": o.name, "vertices": len(o.data.vertices), "polygons": len(o.data.polygons),
                "materials": [m.name if m else None for m in o.data.materials], "location": list(o.location),
                "scale": list(o.scale)} for o in scene_meshes],
    "bounds": {"min": mins.tolist(), "max": maxs.tolist(), "size": (maxs - mins).tolist(), "height": height},
    "topology": topology,
    "bands": bands,
}, ensure_ascii=False, indent=2))
