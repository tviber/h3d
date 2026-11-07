"""Publish the independently reviewed asset and its generic profile into the local viewer."""
from pathlib import Path
import hashlib, json, shutil

ROOT=Path(__file__).resolve().parents[1]
REPO=ROOT.parents[2]
asset=ROOT/'tanjiro-rigged.glb'
profile=json.loads((ROOT/'avatar-profile.json').read_text())
profile['asset']['sha256']=hashlib.sha256(asset.read_bytes()).hexdigest()
(ROOT/'avatar-profile.json').write_text(json.dumps(profile,ensure_ascii=False,indent=2)+'\n')
target=REPO/'web/models/local';target.mkdir(parents=True,exist_ok=True)
shutil.copyfile(asset,target/'tanjiro-v3.glb')
shutil.copyfile(ROOT/'avatar-profile.json',target/'tanjiro-v3.profile.json')
print('Published tanjiro-v3 via the unchanged generic Humanoid loader.')
