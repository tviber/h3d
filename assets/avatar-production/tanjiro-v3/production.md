# Tanjiro v3 — independent production

Status: final GLB exported, independently re-imported and animated in Blender/Three.js, then registered in h3d through the generic v2 Profile. Reviewed pose range passes the checks below; clothing is skinned, not simulated cloth.

## Scope correction (2026-11-07)

The previous assistant mistakenly recovered and displayed a rejected historical character. At the user's explicit request its local GLBs, profile, viewer registration and review screenshots have been deleted. Do not retrieve or restore that historical rig. No historical GLB, textures, weights, skeletons, screenshots or geometry fixes may be inputs to this production.

The failed v2 full-outfit trial GLB and its failed render screenshots have also been deleted. Only the newly generated v2 design references are used as identity references; no GLB is used to infer images. These references have been copied into this directory to make the new production self-contained. Historical cloud tasks have not been deleted; no cloud delete capability was used. This directory is the fresh production run.

## Verified workflow

Official guide: https://www.tripo3d.ai/blog/gpt-6-astra-3d-character-workflow (read 2026-11-07). Use one design identity, isolate references, generate Body, Head and Hair separately, assemble in Blender, reuse the Body armature and weights, remove duplicate head/body geometry, review deformation before rendering. Haori will be a separately modeled garment rather than merged into arms.

Blender Python runtime: bpy 5.0.1 (actually imported). Tripo CLI: `tripo dev (darwin/arm64)`; current help inspected for multiview generation, pre-rig check, rigging, remesh and export. MCP rig schema still lists old versions; CLI accepts an explicit model string. Official Auto Rig documentation recommends `v3.0-20260909` for humanoids; verify backend acceptance rather than silently accepting v2.5 defaults.

## Budget

Studio balance before this run: 4310 credits (110 expiring 2026-12-04). Fetch account prices before submission. Start with one Body generation (approximately 25–55 credits according to current tool guidance); pre-rig check, then one humanoid rig if the raw Body passes structural inspection. No automatic batch retries. Record actual task, project, operator IDs and charges in tasks.json.

## References

ImageGen built-in mode, local imagegen Skill fully read. `body-front-master.png` is an actual identity-preserving edit using only newly generated reference images: remove earrings/hair/haori; readable A-pose; fitted charcoal uniform; readable knees, fingers and feet. Uniform color remains slightly warm under cel shading and will be compared with the final full design.

The accepted full-design identity is `references/design-master.png`, originally the independently generated v2 reference `master-v1.png`. `design-turnaround.png` preserves its visual identity; `hair-front.png` is the subsequent actual ImageGen hair isolation. `references/prompts.json` records the actual prompts. Official design images are retained for comparison; original character reference: https://kimetsu.com/anime/character/ . The new bald Body reference is intentionally not the final character appearance. Body turnaround consistency was reviewed before multiview submission, and the generated 3D was subsequently rejected when its actual geometry disagreed.

## Acceptance gates

1. References: same height, pose, limb proportions and clothing across front/back/left/right; no mirrored-front back.
2. Raw Body: no outer sleeves/hair/earrings; one head; separate fingers and legs; coherent joints. Do not rig a merely attractive but structurally invalid body.
3. Rigged Body: independent Blender front/side renders for bind, stand, 90° arm raise, 90° elbow flexion, arms overhead, knee bend and trunk turn. No h3d adapter involved.
4. Assembly: one head, fitted separate hair, continuous neck join and separate open haori sleeves with distributed weights. No entire sleeve assigned to one arm bone as a workaround.
5. Export: editable .blend, self-contained GLB with one usable humanoid skeleton and materials. Re-import in Blender and validate animations, then integrate via generic h3d profile.

No final tanjiro-rigged.glb should be published unless these gates actually pass.

## Body submission record

- Body turnaround was reviewed against the new bald front master: consistent head height, uniform construction, wrist/knee/ankle levels; left/right forehead scar placement agrees. The four inputs are unscaled pixel crops placed on equal 660×920 white canvases, not independently invented designs. Side views hide the far limb as expected; this does not prove invisible anatomy.
- First request using P2-20260801 was rejected before task creation with code 1004. Balance remained 4310; no task was generated.
- Verified fallback submitted on H3.1 v3.1-20260211, 50,000 face limit, standard geometry and texture, private visibility. Task 17a16582-096c-4a78-9521-49f41e94e3e5; project 5dabac4f-41f8-405c-a2d4-dc01b29f2c40. Actual generation charge 25 credits; remaining 4285.
- Account pricing lookup succeeded on retry but exposes plan prices, not an exact per-operation quote. Tool guidance and the confirmed actual charge are recorded rather than misrepresenting plan price as generation cost.

## Rejected Body: multiview

The generated raw Body has supernumerary arm/hand geometry visible in a side render. Its rig-check returned riggable=true (operator 0dcb7a38-9d86-4556-890e-f62822a63bf3), but the visual anatomy gate failed. It was not rigged. Its rejected original and decompressed GLBs were deleted after diagnosis, so they cannot accidentally become a usable avatar. Failure evidence is under validation/rejected-multiview. A single-front-image Body retry uses the accepted body-front-master.png, avoiding ambiguity from the orthographic side-arm projections and potential Studio multiview slot behavior. This is a local Body retry, not a new whole-character batch.

Blender 5.0 importer does not support EXT_meshopt_compression in this runtime. decompress-glb.mjs losslessly decodes only compressed buffer views, retaining all accessor values and material/skin definitions, for Blender inspection. This is container compatibility, not an anatomy correction.

## Single-image Body retry

Task abae682d-fd55-4da9-b15f-c16a674584e8; project d4f82954-860c-41eb-b814-c55ce3fb5204. H3.1 standard, face limit 50,000, private. Charge 25 credits, balance 4260. Original body-single-raw.glb and losslessly decompressed body-single-blender.glb retained. Blender reports 27,979 vertices and 49,522 triangles. Front, side and back renders show exactly two arms, two legs and one head, with visible fingers; no generated haori or extra loose sleeve geometry. Geometry provisionally accepted for rigging.

Texture caveats: single-image reconstruction guessed scar-like coloring on rear scalp, which must be covered/corrected when fitting the separate hair. The back-of-uniform glyph was not reconstructed. These are pending material details, not excuses to accept a broken joint rig. The source model is X-forward; raw review cameras are labeled after checking all four directions.

## Rigged Body review

Precheck operator 85d934d7-ba2d-4060-b6ef-1feda55384fb passed. Rig operator 90345140-ddfd-46e9-bdb1-df04e838c107 used explicit v3.0-20260909 through the Studio CLI. Rig charge 20 credits; balance 4240. Native exported hierarchy has 78 named body/face/finger/twist groups and one armature. Original and decompressed GLBs retained. Blender imports a non-exported Icosphere bone custom-shape helper; it is excluded from bounds and character mesh inspection.

Fourteen independent Blender renders cover bind, stand, arm90, elbow90, arms-up, knee90, trunk-turn from front/side. Body geometry and deformation provisionally pass: no extra limbs or loose outer sleeves, no gross shoulder collapse or elbow/knee disconnect. Hands remain connected. These are anatomy checks, not approval of final costume or hair. body-review.blend is an editable inspection scene, not the final character.

Keep the complete Body head/neck as the single authoritative head because its visible face agrees with the new identity and retaining it avoids a duplicate head and neck join. Front and side head renders are retained for detail QA. A second generated Head was therefore unnecessary. Hair is generated independently; haori is modeled as an independent open garment and weighted across the arm chain.

## Assembly iterations

Hair task a2c27a51-523b-4d0e-a283-56a70ffead9e / project 6ed91fef-ce84-46b9-9572-4da760a009e9, H3.1 with 16,000 face limit, cost 25 credits; balance 4215 (95 total this run). Actual hair geometry is generated independently and fitted to the Body scalp. An unwanted filled face-opening region is trimmed in Blender, preserving hair UVs; there is no second head. Hair is rigidly bound to Head, appropriate for the rigid main hair mass.

Haori is new Blender-authored geometry: open front coat body and two open tubes, continuous longitudinal sleeve weighting over clavicle/upperarm/forearm. This is real scene geometry and skin weights exported into GLB, not runtime adapter deformation. Checker image and hanafuda texture are local authored material assets, embedded in the .blend/GLB.

First candidate failed: a group-creation bug produced duplicate suffixed vertex groups on garment surfaces; fixed by creating exactly one group per bone. This was not accepted or registered. The corrected candidate passed sleeve motion but revealed front-panel intersections and overlong cuffs. Coat clearance is increased using measured Body chest depth and cuffs shortened; repeat all poses before approval. Independent Blender custom-shape spheres are excluded from camera bounds.

The next review found an exposed sleeve root at the shoulder. Sleeve roots now overlap beneath the shoulder panels, whose weights blend across spine, clavicle and upper arm. This is an asset geometry/weight correction in Blender, not an AvatarAdapter patch. Lower front panels receive gradual thigh influence to clear the raised knee. The final garment has independent open-front body and open sleeve meshes, with normalized distributed weights.

## Final deliverables and checks

- `tanjiro.blend`: editable assembled character, one complete Body head/neck, separate Hair, two earrings, coat body and two sleeves; one unified 78-bone armature. Main roles/fingers use Mixamo-compatible naming; optional Tripo helper bones retained.
- `tanjiro-rigged.glb`: self-contained glTF 2.0 binary, embedded materials/textures, 7 skinned meshes, approximately 9.2 MiB. Contains `HumanoidValidation`, a 10.04-second animation with 234 tracks, including stand, arm raise, elbow flexion, overhead reach, knee bend and trunk rotation. It plays using only a normal GLTFLoader and AnimationMixer.
- `avatar-profile.json`: generic `h3d.avatar-profile.v2`, Mixamo preset, no bone overrides, no character-specific code or mesh deformation policy. SHA-256 binds it to this exact GLB.
- `validation/assembled-*-front/side.png`: seven pose pairs including bind/A-pose. `validation/reimport/`: final exported GLB re-imported into Blender, animated front/side screenshots and face close-ups. All vertices have normalized weights (tolerance .002), 78 bones, one Body, one action.
- `validation/standalone/`: front/side screenshots from the final GLB in plain Three.js, without h3d adapters. `standalone-animation.mp4`: front/side animation preview of that exact file.
- `validation/h3d/`: all nine motions from front/side, additional opposite-direction weight shift/turning views and back views. Deep squat, shoulder raise, elbow bend, overhead reach and knee flexion were visually reviewed. No extra arms, detached hands, severe shoulder collapse, garment-as-arm solid block, or obvious scale jumps were observed in these reviewed poses.
- `validation/generic-check.json`: new Tanjiro and differently proportioned KayKit Knight each played all 1,809 samples across the same nine clips. Maximum bone-length drift was below 2e-7 m, bone scales unchanged, geometry unchanged, source motion JSON unchanged. This numeric test supplements the renders.
- Khronos glTF Validator 2.0.0-dev.3.10: **0 errors, 7 warnings, 5 informational messages**. Seven warnings describe skinned meshes under the shared armature hierarchy (`NODE_SKINNED_MESH_NON_ROOT`); both Blender and Three.js animated that hierarchy successfully. Five informational messages are tangents on cloth/earring materials without normal textures. The Body/Hair tangent-space warnings were resolved by exporting explicit tangents. Full report: `validation/gltf-validator.json`.
- h3d page identity, nonblank page, absence of error overlay, model dropdown registration, motion switching, timeline scrubbing, camera switching and browser error checks passed. Environment: http://127.0.0.1:4173, Chrome headless via Playwright, 1440×1000. Browser plugin not available; existing Chrome/Playwright used without project dependency changes. Mobile/other-browser behavior was not part of this asset review.
- `npm test`: 84 passed, 0 failed. `npm run typecheck`: passed. `git diff --check`: passed.

Known limits: coat is deterministic skinning, with no cloth dynamics or collision solver; arbitrary poses outside the reviewed range may still intersect clothing. Hair and earrings follow Head rigidly. Facial expressions and finger articulation were not animation-tested. Appearance is the generated interpretation shown in the close-ups, not a claim of an official production model. No new character-specific h3d retargeting code was introduced.

### Follow-up: runtime contact prototype (2026-11-07)

The viewer now optionally adds bone-driven body capsules and quasi-static compliant garment contact for the three independent Haori meshes. Both copies of the generic profile include the garment/pin configuration; the GLB and its hash remain unchanged. This is an additional runtime display layer, not a new cloth simulation baked into the exported asset. It reports remaining vertex/face/seam contacts and bounds deformation rather than claiming that all garment intersections are solved. See `docs/avatar-collision.md` for configuration, exclusions, validation scope and current limits.

### Follow-up: apparent threads above raised arm (2026-11-07)

Reproduced the user's screenshot in the shoulder/elbow motion at 50%, side view. The apparent thin threads are the viewer's source-space `THREE.Line` muscle/tendon paths, not Tripo geometry or stretched skin. Switching off “肌腱作用路径” removes them completely; all seven GLB mesh primitives are triangles, with no line primitives. The source paths are drawn directly from MuJoCo coordinates while the generic avatar's bone motion is retargeted to its own proportions, so those paths float above the arm.

Fixed the viewer's generic overlay policy: v2 retargeted profiles without tendon attachment calibration cannot display source muscle paths. The toggle is disabled/unchecked with an explanatory hint, while the user's preference is preserved when returning to the original simulation avatar or simplified preview. No character ID condition, GLB edits, rig changes or new Tripo task was needed. GLB SHA-256 remains `71ea8d13d707052b67c579b484f61a5efb95006f82e76db52c1061f0c179a1b6`.

Chrome/Playwright checks at 1440×1000 and 390×844 passed: page identity/content, correct disabled state, time scrubbing, a second generic model, source-avatar toggle behavior and preference restoration. The corrected viewport is pixel-identical to the diagnostic “tendons off” control image; the original/control difference was confined to the line region. No application errors or warnings; one pre-existing missing `/favicon.ico` request returns 404. `node --check web/app.js` and `git diff --check` passed. Browser plugin not available; existing Chrome/Playwright was used. Evidence is in the current task's `/tmp/h3d-threads-{before,after}.png` and `/tmp/h3d-threads-check.json` (temporary QA outputs, not committed).

Actual cost: **95 Studio credits**, confirmed remaining **4215** (15 expire 2026-12-04). Body multiview failed once, single-view Body succeeded, one rig and one separate Hair succeeded. No repeated whole-character generation batch.

## Reproduce the assembly from retained new source assets

Use the repository's Three.js dependency and the cached/available Blender Python 5.0.1 runtime. Blender's importer here needs decoded meshopt buffers; this does not modify geometry or weights.

```sh
node assets/avatar-production/tanjiro-v3/scripts/decompress-glb.mjs assets/avatar-production/tanjiro-v3/generated/body-rigged.glb assets/avatar-production/tanjiro-v3/generated/body-rigged-blender.glb
node assets/avatar-production/tanjiro-v3/scripts/decompress-glb.mjs assets/avatar-production/tanjiro-v3/generated/hair-raw.glb assets/avatar-production/tanjiro-v3/generated/hair-blender.glb
uv run --with bpy --python 3.11 python assets/avatar-production/tanjiro-v3/scripts/review_body.py assets/avatar-production/tanjiro-v3/generated/body-rigged-blender.glb
uv run --with bpy --python 3.11 python assets/avatar-production/tanjiro-v3/scripts/assemble.py
REVIEW_PREFIX=assembled BAKE_VALIDATION=1 uv run --with bpy --python 3.11 python assets/avatar-production/tanjiro-v3/scripts/review_body.py assets/avatar-production/tanjiro-v3/tanjiro-candidate.glb
uv run --with bpy --python 3.11 python assets/avatar-production/tanjiro-v3/scripts/verify_export.py
python3 assets/avatar-production/tanjiro-v3/scripts/publish-local.py
npm run web
```

Choose **炭治郎 · 全新制作 v3**. Redundant decoded GLBs, intermediate .blend scenes, candidate exports and Blender backups are ignored by Git; original generated parts, final deliverables, references, scripts and useful validation evidence are retained. No assets have been staged or committed automatically.
