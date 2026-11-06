"""Deterministic static export; no network or third-party packages required."""
from pathlib import Path
import shutil

ROOT = Path(__file__).resolve().parents[1]
source, target = ROOT / 'public', ROOT / 'dist'
if target.exists():
    shutil.rmtree(target)
shutil.copytree(source, target)
files = [p for p in target.rglob('*') if p.is_file()]
print(f'Built dist/index.html and {len(files)-1} assets ({sum(p.stat().st_size for p in files):,} bytes).')
