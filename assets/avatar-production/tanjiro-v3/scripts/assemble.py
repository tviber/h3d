"""Assemble ONLY v3 generated Body + Hair and new Blender garment geometry."""
import bpy, math, json
from pathlib import Path
from mathutils import Vector, Matrix
import numpy as np

ROOT=Path(__file__).resolve().parents[1]
bpy.ops.wm.open_mainfile(filepath=str(ROOT/'body-review.blend'))
scene=bpy.context.scene
rig=next(o for o in scene.objects if o.type=='ARMATURE')
for b in rig.pose.bones:b.matrix_basis.identity()
bpy.context.view_layer.update()
custom={b.custom_shape for b in rig.pose.bones if b.custom_shape}
body=next(o for o in scene.objects if o.type=='MESH' and o not in custom)
body.name='Body'
def point(name):return rig.matrix_world@rig.pose.bones[name].head
def bounds(objects):
    points=[o.matrix_world@v.co for o in objects for v in o.data.vertices]
    return Vector([min(p[i] for p in points) for i in range(3)]),Vector([max(p[i] for p in points) for i in range(3)])

def skin_mesh(name,vertices,faces,weights,uvs=None,material=None):
    inv=rig.matrix_world.inverted();mesh=bpy.data.meshes.new(name)
    mesh.from_pydata([inv@Vector(v) for v in vertices],[],faces);mesh.update()
    obj=bpy.data.objects.new(name,mesh);scene.collection.objects.link(obj);obj.parent=rig;obj.matrix_basis.identity()
    groups={key:obj.vertex_groups.new(name=key) for key in sorted({key for row in weights for key in row})}
    for i,row in enumerate(weights):
        total=sum(row.values())
        for key,value in row.items():
            if value>0:groups[key].add([i],value/total,'REPLACE')
    if uvs:
        layer=mesh.uv_layers.new(name='UVMap')
        for poly in mesh.polygons:
            for loop in poly.loop_indices:layer.data[loop].uv=uvs[mesh.loops[loop].vertex_index]
    if material:mesh.materials.append(material)
    for poly in mesh.polygons:poly.use_smooth=True
    arm=obj.modifiers.new('UnifiedHumanoid','ARMATURE');arm.object=rig
    return obj

def image_material(name,pixels,width,height):
    image=bpy.data.images.new(name,width=width,height=height,alpha=True)
    image.pixels.foreach_set(pixels.astype(np.float32).ravel());image.pack()
    mat=bpy.data.materials.new(name);mat.use_nodes=True
    nodes=mat.node_tree.nodes;bsdf=nodes.get('Principled BSDF');bsdf.inputs['Roughness'].default_value=.88
    texture=nodes.new('ShaderNodeTexImage');texture.image=image;texture.extension='REPEAT';texture.interpolation='Closest'
    mat.node_tree.links.new(texture.outputs['Color'],bsdf.inputs['Base Color'])
    return mat

# New checker fabric, shared across physically separate garment surfaces.
y,x=np.mgrid[0:512,0:512];mask=((x//64+y//64)%2)==0
pixels=np.ones((512,512,4));pixels[:,:,:3]=np.where(mask[:,:,None],np.array([.035,.43,.25]),np.array([.018,.022,.022]))
fabric=image_material('Haori_GreenBlack',pixels,512,512)

def torso_weights(z,x,y):
    levels=[(.67,'Hip'),(.96,'Waist'),(1.07,'Spine01'),(1.2,'Spine02'),(1.36,'Spine02')]
    if z<=levels[0][0]:return {'Hip':1}
    for (a,an),(b,bn) in zip(levels,levels[1:]):
        if a<=z<=b:
            t=(z-a)/(b-a);row={an:1-t};row[bn]=row.get(bn,0)+t
            if z<.95:
                blend=max(0,min(.65,(.95-z)/.31*.65))*max(0,-y/.15)
                row={name:w*(1-blend) for name,w in row.items()}
                row['L_Thigh' if x>=0 else 'R_Thigh']=blend
            if z>1.23:
                blend=min(.65,max(0,(abs(x)-.09)/.09)*.65)
                row={name:w*(1-blend) for name,w in row.items()}
                side='L' if x>=0 else 'R'
                row[side+'_Clavicle']=blend*.45
                row[side+'_Upperarm']=blend*.55
            return row
    return {'Spine02':1}

# Open front, gentle flare, neck-to-thigh coat. It is never fused to Body.
rings=[(1.365,.105,.083),(1.325,.178,.142),(1.25,.185,.16),(1.15,.18,.145),(1.04,.167,.15),(.94,.175,.15),(.84,.20,.16),(.73,.226,.15),(.64,.24,.15)]
vertices=[];uvs=[];weights=[];faces=[];N=40
for i,(z,rx,ry) in enumerate(rings):
    for j in range(N+1):
        theta=.37+(2*math.pi-.74)*j/N
        px=rx*math.sin(theta);py=-ry*math.cos(theta)+.012
        # Slightly longer front panels and a readable open front edge.
        vertices.append((px,py,z));weights.append(torso_weights(z,px,py));uvs.append((j/N*1.2,(1.365-z)/.76))
        if i and j:
            k=i*(N+1)+j;faces.append((k-N-2,k-N-1,k,k-1))
coat=skin_mesh('Haori_Body',vertices,faces,weights,uvs,fabric)

for side in ['L','R']:
    shoulder=point(side+'_Upperarm');elbow=point(side+'_Forearm');wrist=point(side+'_Hand')
    # Bury the open sleeve root under the shoulder panel, with shared arm-chain
    # weights at the overlap. An exposed root would leave a visible shoulder gap.
    sign=1 if side=='L' else -1
    start=shoulder-Vector((sign*.045,0,.012));end=wrist.lerp(elbow,.40);axis=(end-start).normalized()
    u=Vector((0,1,0));v=axis.cross(u).normalized()
    vertices=[];weights=[];faces=[];uvs=[];M=24;steps=12
    for i in range(steps+1):
        t=i/steps;center=start.lerp(end,t)
        depth=.082+.025*math.sin(t*math.pi/2)
        drop=.075+.055*min(1,t*2.5)
        for j in range(M+1):
            a=j/M*2*math.pi
            pos=center+u*(depth*math.cos(a))+v*(drop*math.sin(a))
            vertices.append(pos);uvs.append((j/M*.9,t*.55))
            fore=max(0,min(1,(t-.3)/.6));clav=.35*(1-t)**3
            row={side+'_Clavicle':clav,side+'_Upperarm':(1-fore)*(1-clav),side+'_Forearm':fore*(1-clav)}
            weights.append(row)
            if i and j:
                k=i*(M+1)+j;faces.append((k-M-2,k-M-1,k,k-1))
    sleeve=skin_mesh('Haori_Sleeve_'+side,vertices,faces,weights,uvs,fabric)
    # One sleeve spans clavicle, upper arm and forearm with continuous blend zones.

# Hair remains a separate new generated part, fitted in the same bind coordinates.
before=set(scene.objects)
bpy.ops.import_scene.gltf(filepath=str(ROOT/'generated/hair-blender.glb'))
hair_parts=[o for o in scene.objects if o not in before and o.type=='MESH']
if not hair_parts:raise RuntimeError('Hair contains no mesh')
rot=Matrix.Rotation(-math.pi/2,4,'Z')
world_points=[rot@(o.matrix_world@v.co) for o in hair_parts for v in o.data.vertices]
lo=Vector([min(v[i] for v in world_points) for i in range(3)]);hi=Vector([max(v[i] for v in world_points) for i in range(3)])
center=(lo+hi)/2
# Slightly larger than the scalp, leave eyes and the upper-left scar exposed.
target_lo=Vector((-.152,-.125,1.405));target_hi=Vector((.152,.15,1.745));target_center=(target_lo+target_hi)/2
scale=Vector([(target_hi[i]-target_lo[i])/(hi[i]-lo[i]) for i in range(3)])
for index,obj in enumerate(hair_parts):
    vertices=[]
    for vertex in obj.data.vertices:
        p=rot@(obj.matrix_world@vertex.co);p=(p-center)*scale+target_center;vertices.append(p)
    faces=[]
    for poly in obj.data.polygons:
        c=sum((vertices[i] for i in poly.vertices),Vector())/len(poly.vertices)
        # Remove generated cavity fill where the real face occupies the opening.
        if abs(c.x)<.104 and c.y<-.012 and c.z<1.595:continue
        faces.append(tuple(poly.vertices))
    mesh=obj.data.copy();mesh.clear_geometry();mesh.from_pydata(vertices,[],faces);mesh.update()
    # Preserve texture UVs through an index-stable geometry copy, then skin rigidly to Head.
    kept=[p for p in obj.data.polygons if not(abs(sum(vertices[i].x for i in p.vertices)/len(p.vertices))<.104 and sum(vertices[i].y for i in p.vertices)/len(p.vertices)<-.012 and sum(vertices[i].z for i in p.vertices)/len(p.vertices)<1.595)]
    if obj.data.uv_layers.active:
        layer=mesh.uv_layers.new(name='UVMap')
        for newpoly,oldpoly in zip(mesh.polygons,kept):
            for nl,ol in zip(newpoly.loop_indices,oldpoly.loop_indices):layer.data[nl].uv=obj.data.uv_layers.active.data[ol].uv
    material_slots=list(obj.data.materials)
    obj.data=mesh
    inv=rig.matrix_world.inverted()
    for vertex in mesh.vertices:vertex.co=inv@vertex.co
    obj.parent=rig;obj.matrix_basis.identity();obj.name='Hair' if index==0 else f'Hair_{index}'
    for group in list(obj.vertex_groups):obj.vertex_groups.remove(group)
    group=obj.vertex_groups.new(name='Head');group.add(list(range(len(mesh.vertices))),1,'REPLACE')
    for mod in list(obj.modifiers):obj.modifiers.remove(mod)
    arm=obj.modifiers.new('UnifiedHumanoid','ARMATURE');arm.object=rig

# Lightweight hanafuda cards: independent surfaces attached to Head.
y,x=np.mgrid[0:256,0:128];tex=np.ones((256,128,4));tex[:,:,:3]=(.87,.87,.8)
cx,cy=64,193
sun=(x-cx)**2+(y-cy)**2<20**2;tex[sun,:3]=(.65,.025,.03)
for slope in np.linspace(-2.4,2.4,13):
    ray=(abs(x-(cx+slope*(cy-y)))<1)&(y<cy-17)&(y>35);tex[ray,:3]=(.16,.17,.17)
tex[:30,:,:3]=(.2,.23,.24);tex[250:,:,:3]=(.1,.1,.1)
earmat=image_material('Hanafuda',tex,128,256)
for sign in [-1,1]:
    x=sign*.099;y=-.016;top=1.492;bottom=top-.077;w=.013
    skin_mesh('Hanafuda_L' if sign>0 else 'Hanafuda_R',[(x-w,y,top),(x+w,y,top),(x+w,y,bottom),(x-w,y,bottom)],[(0,1,2,3)],[{'Head':1}]*4,[(0,1),(1,1),(1,0),(0,0)],earmat)

for obj in scene.objects:obj.select_set(False)
rig.select_set(True)
for obj in scene.objects:
    if obj.type=='MESH' and obj not in custom:obj.select_set(True)
bpy.context.view_layer.objects.active=rig
bpy.context.view_layer.update()
bpy.ops.wm.save_as_mainfile(filepath=str(ROOT/'tanjiro.blend'))
bpy.ops.export_scene.gltf(filepath=str(ROOT/'tanjiro-candidate.glb'),export_format='GLB',use_selection=True,export_skins=True,export_animations=False)
print('Saved candidate: requires full front/side deformation review before acceptance')
