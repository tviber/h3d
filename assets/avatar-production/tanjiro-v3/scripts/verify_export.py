"""Re-export tangent data, then independently re-import and inspect the final GLB."""
import bpy, json
from pathlib import Path
from mathutils import Vector

ROOT=Path(__file__).resolve().parents[1]
bpy.ops.wm.open_mainfile(filepath=str(ROOT/'tanjiro.blend'))
bpy.ops.export_scene.gltf(filepath=str(ROOT/'tanjiro-rigged.glb'),export_format='GLB',
    use_selection=True,export_skins=True,export_animations=True,export_tangents=True)
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=str(ROOT/'tanjiro-rigged.glb'))
scene=bpy.context.scene
rig=next(o for o in scene.objects if o.type=='ARMATURE')
custom={b.custom_shape for b in rig.pose.bones if b.custom_shape}
meshes=[o for o in scene.objects if o.type=='MESH' and o not in custom]
report={'bones':len(rig.data.bones),'meshes':[o.name for o in meshes],
    'actions':[a.name for a in bpy.data.actions], 'vertices':sum(len(o.data.vertices) for o in meshes)}
assert len([o for o in meshes if o.name=='Body'])==1
assert len(rig.data.bones)==78
errors=[]
for o in meshes:
    for v in o.data.vertices:
        total=sum(g.weight for g in v.groups)
        if abs(total-1)>.002:errors.append([o.name,v.index,total])
report['unnormalizedVertices']=errors
assert not errors
assert bpy.data.actions
scene.render.engine='CYCLES';scene.cycles.samples=24
scene.render.resolution_x=700;scene.render.resolution_y=900;scene.render.resolution_percentage=100
scene.view_settings.view_transform='Standard'
world=bpy.data.worlds.new('Neutral');scene.world=world;world.use_nodes=True
world.node_tree.nodes['Background'].inputs[0].default_value=(.65,.65,.65,1)
world.node_tree.nodes['Background'].inputs[1].default_value=.8
bpy.ops.object.camera_add();camera=bpy.context.object;camera.data.type='ORTHO';camera.data.ortho_scale=2;scene.camera=camera
out=ROOT/'validation'/'reimport';out.mkdir(exist_ok=True)
for label,frame in [('stand',1),('arms-up',121),('knee90',169)]:
    scene.frame_set(frame);bpy.context.view_layer.update()
    for view,pos in [('front',(0,-4,.85)),('side',(4,0,.85))]:
        camera.location=pos;camera.rotation_euler=(Vector((0,0,.85))-camera.location).to_track_quat('-Z','Y').to_euler()
        scene.render.filepath=str(out/f'{label}-{view}.png');bpy.ops.render.render(write_still=True)
scene.frame_set(1)
camera.data.ortho_scale=.48
for view,pos in [('front',(0,-4,1.45)),('side',(4,0,1.45))]:
    camera.location=pos;camera.rotation_euler=(Vector((0,0,1.45))-camera.location).to_track_quat('-Z','Y').to_euler()
    scene.render.filepath=str(out/f'head-{view}.png');bpy.ops.render.render(write_still=True)
(ROOT/'validation'/'reimport-report.json').write_text(json.dumps(report,indent=2))
print(json.dumps(report))
