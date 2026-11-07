"""Independent Blender inspection. Never imports h3d or historical avatar geometry."""
import bpy, json, sys, math, os
from pathlib import Path
from mathutils import Vector, Matrix, Quaternion

ROOT=Path(__file__).resolve().parents[1]
source=Path(sys.argv[-1]).resolve()
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=str(source))
scene=bpy.context.scene
armatures=[o for o in scene.objects if o.type=='ARMATURE']
custom_shapes={b.custom_shape for a in armatures for b in a.pose.bones if b.custom_shape}
meshes=[o for o in scene.objects if o.type=='MESH' and o not in custom_shapes and not o.hide_render]
report={'input':source.name,'blender':bpy.app.version_string,'meshes':[], 'armatures':[], 'status':'review-required'}
for obj in meshes:
    report['meshes'].append({'name':obj.name,'vertices':len(obj.data.vertices),'faces':len(obj.data.polygons),'vertexGroups':len(obj.vertex_groups)})
for rig in armatures:
    report['armatures'].append({'name':rig.name,'bones':[b.name for b in rig.data.bones]})

def bounds():
    bpy.context.view_layer.update()
    dg=bpy.context.evaluated_depsgraph_get()
    points=[o.matrix_world@Vector(c) for raw in meshes for o in [raw.evaluated_get(dg)] for c in o.bound_box]
    return Vector([min(p[i] for p in points) for i in range(3)]),Vector([max(p[i] for p in points) for i in range(3)])
lo,hi=bounds();report['bounds']=[list(lo),list(hi)]
scene.render.engine='CYCLES';scene.cycles.samples=20
scene.render.resolution_x=700;scene.render.resolution_y=900;scene.render.resolution_percentage=100
scene.view_settings.view_transform='Standard'
world=bpy.data.worlds.new('NeutralReview');scene.world=world;world.use_nodes=True
world.node_tree.nodes['Background'].inputs[0].default_value=(.65,.65,.65,1)
world.node_tree.nodes['Background'].inputs[1].default_value=.8
bpy.ops.object.camera_add();camera=bpy.context.object;camera.data.type='ORTHO';scene.camera=camera
prefix=os.environ.get('REVIEW_PREFIX','rigged' if armatures else 'raw')

def render(label,view):
    lo,hi=bounds();center=(lo+hi)/2;height=max(hi.z-lo.z,hi.x-lo.x,hi.y-lo.y)
    camera.data.ortho_scale=height*1.18
    vectors={'front':(0,-1,0),'side':(1,0,0),'back':(0,1,0),'opposite':(-1,0,0)}
    if not armatures:
        # The current Tripo raw export is X-forward; all four views are retained for audit.
        vectors={'front':(1,0,0),'side':(0,-1,0),'back':(-1,0,0),'opposite':(0,1,0)}
    camera.location=center+Vector(vectors[view])*height*3
    camera.rotation_euler=(center-camera.location).to_track_quat('-Z','Y').to_euler()
    scene.render.filepath=str(ROOT/'validation'/f'{prefix}-{label}-{view}.png')
    bpy.ops.render.render(write_still=True)

if not armatures:
    for view in ['front','side','back','opposite']:render('bind',view)
else:
    rig=armatures[0]
    def norm(s):return ''.join(c for c in s.lower().replace('mixamorig:','') if c.isalnum())
    def find(*aliases):
        wanted={norm(x) for x in aliases}
        return next((b for b in rig.pose.bones if norm(b.name) in wanted),None)
    chains={}
    for side,prefixName in [('left','L'),('right','R')]:
        chains[side+'Arm']=[find(prefixName+'_Upperarm',side+'Arm',side+'UpperArm'),find(prefixName+'_Forearm',side+'ForeArm',side+'LowerArm'),find(prefixName+'_Hand',side+'Hand')]
        chains[side+'Leg']=[find(prefixName+'_Thigh',side+'UpLeg',side+'UpperLeg'),find(prefixName+'_Calf',side+'Leg',side+'LowerLeg'),find(prefixName+'_Foot',side+'Foot')]
    if any(b is None for chain in chains.values() for b in chain):
        report['error']='Unknown rig bone convention; inspect report before posing'
        for view in ['front','side','back']:render('bind',view)
    else:
        left=rig.matrix_world@chains['leftLeg'][0].head;right=rig.matrix_world@chains['rightLeg'][0].head
        lateral=left-right
        angle=math.atan2(lateral.y,lateral.x)
        # Normalize whole imported asset through an ancestor, preserving rest/bind transforms.
        roots=[o for o in scene.objects if o.parent is None and o.type!='CAMERA' and o not in custom_shapes]
        normal=bpy.data.objects.new('ReviewCoordinates',None);scene.collection.objects.link(normal)
        for obj in roots:obj.parent=normal
        normal.rotation_euler.z=-angle
        bpy.context.view_layer.update()
        lo,hi=bounds();normal.location.z-=lo.z
        height=hi.z-lo.z
        if height>0:normal.scale=(1.65/height,)*3
        bpy.context.view_layer.update()
        def reset():
            for b in rig.pose.bones:b.matrix_basis.identity()
            bpy.context.view_layer.update()
        def aim(bone,child,direction):
            bpy.context.view_layer.update()
            p=rig.matrix_world@bone.head;c=rig.matrix_world@child.head
            q=(c-p).normalized().rotation_difference(Vector(direction).normalized())
            delta=Matrix.Translation(p)@q.to_matrix().to_4x4()@Matrix.Translation(-p)
            bone.matrix=rig.matrix_world.inverted()@delta@rig.matrix_world@bone.matrix
            bpy.context.view_layer.update()
        def stand():
            reset()
            for side,sign in [('left',1),('right',-1)]:
                a,b,c=chains[side+'Arm'];aim(a,b,(sign*.08,0,-1));aim(b,c,(sign*.05,-.08,-1))
        def pose(label):
            if label=='bind':reset();return
            stand()
            if label=='arm90':
                a,b,c=chains['leftArm'];aim(a,b,(1,0,0));aim(b,c,(1,0,0))
            if label=='elbow90':
                a,b,c=chains['leftArm'];aim(b,c,(0,-1,0))
            if label=='arms-up':
                for side,sign in [('left',1),('right',-1)]:
                    a,b,c=chains[side+'Arm'];aim(a,b,(sign*.1,0,1));aim(b,c,(sign*.08,0,1))
            if label=='knee90':
                a,b,c=chains['leftLeg'];aim(a,b,(0,-.7,-.7));aim(b,c,(0,.7,-.7))
            if label=='trunk-turn':
                b=find('Spine01','Spine','Waist')
                if b:
                    p=rig.matrix_world@b.head;q=Quaternion((0,0,1),math.radians(30));delta=Matrix.Translation(p)@q.to_matrix().to_4x4()@Matrix.Translation(-p)
                    b.matrix=rig.matrix_world.inverted()@delta@rig.matrix_world@b.matrix
        labels=['bind','stand','arm90','elbow90','arms-up','knee90','trunk-turn']
        for label in labels:
            pose(label)
            for view in ['front','side']:render(label,view)
        if os.environ.get('BAKE_VALIDATION')=='1':
            reset()
            names={'Hip':'Hips','Waist':'Spine','Spine01':'Spine1','Spine02':'Spine2','NeckTwist01':'Neck','NeckTwist02':'Neck1'}
            for side,full in [('L','Left'),('R','Right')]:
                for old,new in [('Clavicle','Shoulder'),('Upperarm','Arm'),('Forearm','ForeArm'),('Hand','Hand'),('Thigh','UpLeg'),('Calf','Leg'),('Foot','Foot'),('ToeBase','ToeBase')]:names[side+'_'+old]=full+new
                for finger,target in [('Thumb','Thumb'),('Index','Index'),('Mid','Middle'),('Ring','Ring'),('Pinky','Pinky')]:
                    for i in range(1,4):names[f'{side}_{finger}{i}']=f'{full}Hand{target}{i}'
            for old,new in names.items():
                bone=rig.data.bones.get(old)
                if bone:bone.name=new
                for obj in meshes:
                    group=obj.vertex_groups.get(old)
                    if group:group.name=new
            rig.animation_data_clear()
            sequence=['stand','arm90','stand','elbow90','stand','arms-up','stand','knee90','stand','trunk-turn','stand']
            scene.render.fps=24;scene.frame_start=1;scene.frame_end=1+24*(len(sequence)-1)
            for i,label in enumerate(sequence):
                scene.frame_set(i*24+1);pose(label)
                for bone in rig.pose.bones:
                    bone.rotation_mode='QUATERNION'
                    bone.keyframe_insert(data_path='rotation_quaternion',frame=i*24+1,group=bone.name)
                    bone.keyframe_insert(data_path='location',frame=i*24+1,group=bone.name)
            if rig.animation_data and rig.animation_data.action:rig.animation_data.action.name='HumanoidValidation'
            scene.frame_set(1)
            for obj in scene.objects:obj.select_set(False)
            rig.select_set(True)
            for obj in meshes:obj.select_set(True)
            normal.select_set(True)
            bpy.context.view_layer.objects.active=rig
            bpy.ops.wm.save_as_mainfile(filepath=str(ROOT/'tanjiro.blend'))
            bpy.ops.export_scene.gltf(filepath=str(ROOT/'tanjiro-rigged.glb'),export_format='GLB',use_selection=True,export_skins=True,export_animations=True)
            report['animation']='HumanoidValidation'
            report['boneNames']='Mixamo-compatible anatomical roles; Tripo optional helper bones retained'
        reset();bpy.ops.wm.save_as_mainfile(filepath=str(ROOT/('body-review.blend' if prefix=='rigged' else prefix+'-review.blend')))
        report['posed']=labels
(ROOT/'validation'/f'{prefix}-report.json').write_text(json.dumps(report,indent=2))
print(json.dumps(report))
