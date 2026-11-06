"""Optional live verification against the official draft-2020-12 schemas (requires jsonschema)."""
import json
import re
import urllib.request
from datetime import datetime, timezone
from jsonschema import Draft202012Validator, FormatChecker

formats = FormatChecker()


def register_uint(bits):
    @formats.checks(f'uint{bits}-decimal')
    def valid(value):
        return isinstance(value, str) and re.fullmatch(r'0|[1-9][0-9]*', value) is not None and int(value) < 2 ** bits


for bits in (64, 96, 256):
    register_uint(bits)

print('Live API verification at', datetime.now(timezone.utc).isoformat())
for name in ('core', 'status'):
    schema_url = f'https://docs.squeekchain.com/assets/api/{name}.json'
    endpoint = f'https://api.squeekchain.com/v1/{name}'
    with urllib.request.urlopen(urllib.request.Request(schema_url, headers={'User-Agent': 'Squeek-Hours-Audit/1.0'}), timeout=20) as response:
        schema = json.load(response)
    Draft202012Validator.check_schema(schema)
    request = urllib.request.Request(endpoint, headers={'Accept': 'application/json', 'Origin': 'https://squeek-hours.identitymd.eth'})
    with urllib.request.urlopen(request, timeout=20) as response:
        payload = json.load(response)
        etag = response.headers.get('ETag')
        cors = response.headers.get('Access-Control-Allow-Origin')
        caching = response.headers.get('Cache-Control')
    Draft202012Validator(schema, format_checker=formats).validate(payload)
    print(name, 'HTTP 200; full official schema PASS;', 'CORS', cors, '; cache', caching)
    if name == 'core' and payload.get('status') == 'available':
        print('Observed confirmed round:', payload['core']['settledThroughRound'], '; work:', payload['core']['cumulativeWork'], '; block:', payload['core']['blockHeight'], '; safe through:', payload['chain']['safeThroughBlock'])
    if etag:
        request.add_header('If-None-Match', etag)
        try:
            with urllib.request.urlopen(request, timeout=20) as response:
                print(name, 'conditional HTTP', response.status, '(state may have advanced)')
        except urllib.error.HTTPError as error:
            if error.code != 304:
                raise
            print(name, 'conditional HTTP 304 PASS')
