"""Render only the new v2 trial asset; never load historical character assets."""
import bpy, json, math
from pathlib import Path
from mathutils import Vector

ROOT = Path(__file__).resolve().parents[1]
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=str(ROOT / 'generated/tripo-1793958580.glb'))
meshes = [o for o in bpy.context.scene.objects if o.type == 'MESH']
points = [o.matrix_world @ Vector(p) for o in meshes for p in o.bound_box]
lo = Vector([min(p[i] for p in points) for i in range(3)])
hi = Vector([max(p[i] for p in points) for i in range(3)])
center = (lo + hi) / 2
height = hi.z - lo.z
scene = bpy.context.scene
scene.render.engine = 'CYCLES'
scene.cycles.samples = 16
scene.render.resolution_x = 800
scene.render.resolution_y = 1000
scene.render.resolution_percentage = 100
scene.world = bpy.data.worlds.new('Neutral studio')
scene.world.use_nodes = True
scene.world.node_tree.nodes['Background'].inputs[0].default_value = (.65,.65,.65,1)
scene.world.node_tree.nodes['Background'].inputs[1].default_value = .8
scene.view_settings.view_transform = 'Standard'
bpy.ops.object.camera_add()
camera = bpy.context.object
camera.data.type = 'ORTHO'
camera.data.ortho_scale = height * 1.15
scene.camera = camera
report = {'blender': bpy.app.version_string, 'status':'unaccepted trial', 'bounds':[list(lo),list(hi)], 'meshes':[]}
for obj in meshes:
    report['meshes'].append({'name':obj.name, 'vertices':len(obj.data.vertices), 'polygons':len(obj.data.polygons), 'vertex_groups':len(obj.vertex_groups)})
for label, direction in [('x_positive',(1,0,0)),('x_negative',(-1,0,0)),('y_positive',(0,1,0)),('y_negative',(0,-1,0))]:
    camera.location = center + Vector(direction) * height * 3
    camera.rotation_euler = (center-camera.location).to_track_quat('-Z','Y').to_euler()
    scene.render.filepath = str(ROOT / 'validation' / ('trial-raw-'+label+'.png'))
    bpy.ops.render.render(write_still=True)
(ROOT/'validation/trial-raw-report.json').write_text(json.dumps(report,indent=2))
