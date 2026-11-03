# MakeHuman Default Avatar Asset Provenance & License

## Asset Files

- `human.glb`: Continuous skinned human mesh (53,514 welded vertices, 107,024 triangles, 163 bones, 4 skin influences per vertex).
- `rig.json`: Skeleton bone hierarchy, bind-space head/tail coordinates, and metadata.

## Source & Generation

Derived from the MakeHuman Community upstream assets (`https://github.com/makehumancommunity/makehuman`, tree `a8bc2d54ff0ac92e78ff71431b1023eda42bf482`):

- Base mesh: `base.obj` (`hm08`)
- Morph targets: `caucasian-male-young.target` (1.0), `universal-male-young-averagemuscle-averageweight.target` (0.35), `universal-male-young-maxmuscle-averageweight.target` (0.65)
- Skeleton & skin weights: `default.mhskel`, `default_weights.mhw`
- Surface refinement: 1-level Catmull-Clark subdivision and UV restoration (`human3d/scripts/build-human.py` & `human3d/scripts/build-anatomy-surface.py`)

## License

- **License**: Creative Commons CC0 1.0 Universal (`CC0-1.0.txt`)
- **Attribution**: Copyright (C) 2001-2020 MakeHuman Team (`www.makehumancommunity.org`). Under MakeHuman's asset license (Section C & D of `MAKEHUMAN-LICENSE.md`), all bundled graphical assets and exported meshes/weights are released under CC0 1.0 Universal without restriction.
