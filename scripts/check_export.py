"""Check the deliverable's relative assets and byte-for-byte production export."""
import json
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]
source, dist = ROOT / 'public', ROOT / 'dist'


class Assets(HTMLParser):
    def handle_starttag(self, tag, attrs):
        for name, value in attrs:
            if name not in ('src', 'href') or not value or value.startswith(('#', 'https:', 'http:', 'data:')):
                continue
            assert not value.startswith('/'), f'Absolute asset URL: {value}'
            assert (dist / urlsplit(value).path).is_file(), f'Missing asset: {value}'


source_files = {p.relative_to(source) for p in source.rglob('*') if p.is_file()}
dist_files = {p.relative_to(dist) for p in dist.rglob('*') if p.is_file()}
assert source_files == dist_files, 'Export file set differs from public/'
for path in source_files:
    assert (source / path).read_bytes() == (dist / path).read_bytes(), f'Stale export: {path}'
Assets().feed((dist / 'index.html').read_text())
assert json.loads((dist / 'runtime.json').read_text()) == {'mode': 'device'}
assert not any(part in ('node_modules', '__pycache__', '.git') for p in dist_files for part in p.parts)
print(f'PASS: {len(dist_files)} exported files, relative local assets, no packaged dependencies, exact source/export match.')
