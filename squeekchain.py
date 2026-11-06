"""Read-only compatibility proxy for the existing /api/chain route."""
import json
import math
import re
import threading
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime

API = 'https://api.squeekchain.com'
STAGES = [(0, 'The First Burrow'), (800, 'The Growing Village'), (2000, 'The Hamster City'), (5000, 'The Crystal Kingdom'), (10000, 'The Infinite World')]


def uint(value):
    return isinstance(value, str) and re.fullmatch(r'0|[1-9][0-9]*', value) is not None


def validate(kind, payload):
    if not isinstance(payload, dict) or payload.get('schemaVersion') != 1:
        raise ValueError('Unsupported API schema')
    if kind == 'core':
        core, chain, source = payload.get('core') or {}, payload.get('chain') or {}, payload.get('source') or {}
        if payload.get('status') != 'available':
            raise ValueError('Confirmed state unavailable: ' + str(payload.get('reason', 'unknown')))
        if chain.get('chainId') != '11155111' or not uint(chain.get('safeThroughBlock')) or not all(uint(core.get(key)) for key in ('settledThroughRound', 'cumulativeWork', 'blockHeight', 'blockProgress')):
            raise ValueError('Invalid confirmed state or network')
        if not re.fullmatch(r'0x[0-9a-fA-F]{64}', str(source.get('transactionHash'))) or not uint(source.get('blockNumber')) or not uint(source.get('blockTimestamp')) or int(source['blockNumber']) > int(chain['safeThroughBlock']) or int(core['blockProgress']) >= 1000000000:
            raise ValueError('Invalid confirmed source')
    else:
        builder = payload.get('builder')
        if not isinstance(builder, dict) or builder.get('status') not in ('available', 'unavailable'):
            raise ValueError('Invalid pipeline status')
        measurement = payload.get('measurement')
        if measurement is not None:
            if not isinstance(measurement, dict) or measurement.get('freshness') not in ('online', 'stale') or measurement.get('coreStatus') not in ('IDLE', 'ACTIVE', 'COUNTER_FAULT') or measurement.get('staleAfterSeconds') != 120 or not isinstance(measurement.get('rpmMilli'), int) or isinstance(measurement.get('rpmMilli'), bool) or measurement['rpmMilli'] < 0:
                raise ValueError('Invalid measurement')
            observed = datetime.fromisoformat(str(measurement.get('observedAt')).replace('Z', '+00:00'))
            if observed.tzinfo is None:
                raise ValueError('Measurement time must have timezone')
        queue = payload.get('settlementQueue')
        if not isinstance(queue, dict) or queue.get('status') not in ('available', 'unavailable'):
            raise ValueError('Invalid settlement queue')
        if queue.get('latestSubmission') is not None and not isinstance(queue.get('latestSubmission'), dict):
            raise ValueError('Invalid latest submission')
    return payload


class ReadCache:
    def __init__(self, kind):
        self.kind = kind
        self.lock = threading.Lock()
        self.body = None
        self.etag = None
        self.checked_at = 0
        self.advanced_at = 0
        self.next_at = 0
        self.error = None

    def read(self):
        with self.lock:
            moment = time.time()
            if moment < self.next_at:
                return self.body, self.error
            request = urllib.request.Request(API + '/v1/' + self.kind, headers={'Accept': 'application/json'})
            if self.etag:
                request.add_header('If-None-Match', self.etag)
            try:
                try:
                    with urllib.request.urlopen(request, timeout=8) as response:
                        payload = validate(self.kind, json.loads(response.read(2000000).decode()))
                        if not self.body or (self.kind == 'core' and self.body['chain']['safeThroughBlock'] != payload['chain']['safeThroughBlock']):
                            self.advanced_at = moment
                        self.body = payload
                        self.etag = response.headers.get('ETag')
                except urllib.error.HTTPError as error:
                    if error.code != 304 or self.body is None:
                        raise
                self.checked_at = moment
                self.error = None
                self.next_at = moment + 8
            except Exception as error:
                self.error = 'API HTTP ' + str(error.code) if isinstance(error, urllib.error.HTTPError) else 'API unavailable or invalid response'
                delay = 15
                if isinstance(error, urllib.error.HTTPError) and error.code in (429, 503):
                    raw = error.headers.get('Retry-After')
                    try:
                        delay = float(raw)
                        if not math.isfinite(delay):
                            delay = 15
                    except (TypeError, ValueError):
                        try:
                            delay = parsedate_to_datetime(raw).timestamp() - moment
                        except (TypeError, ValueError, AttributeError):
                            delay = 15
                self.next_at = moment + max(1, delay)
            return self.body, self.error

    def stale(self):
        return bool(self.error) or time.time() - self.checked_at > 45 or (self.kind == 'core' and time.time() - self.advanced_at > 300)


core_cache, status_cache = ReadCache('core'), ReadCache('status')


def interpret(payload, core=None):
    result = {'visual': 'UNAVAILABLE', 'settlement': 'UNAVAILABLE', 'round': None, 'work': None, 'blockHeight': None, 'blockProgress': None, 'rpm': None, 'pendingRound': None, 'chainId': '11155111', 'installationId': None, 'reason': 'Confirmed settlement is unavailable.', 'stale': core_cache.stale()}
    if core:
        result.update(round=core['core']['settledThroughRound'], work=core['core']['cumulativeWork'], blockHeight=core['core']['blockHeight'], blockProgress=core['core']['blockProgress'], settlement='CONFIRMED', reason=None, installationId=core['installationId'], safeThroughBlock=core['chain']['safeThroughBlock'])
    if not payload:
        return result
    measurement = payload.get('measurement') or {}
    try:
        observed = datetime.fromisoformat(measurement['observedAt'].replace('Z', '+00:00'))
        age = (datetime.now(timezone.utc) - observed).total_seconds()
        fresh = not status_cache.stale() and measurement.get('freshness') == 'online' and -5 <= age < 120
        if fresh and measurement.get('coreStatus') in ('IDLE', 'ACTIVE'):
            result['visual'] = 'RESTING' if measurement['coreStatus'] == 'IDLE' else 'LIVE'
            rpm = measurement.get('rpmMilli')
            result['rpm'] = rpm / 1000 if isinstance(rpm, (int, float)) and rpm >= 0 else None
    except (KeyError, ValueError, TypeError):
        pass
    submission = (payload.get('settlementQueue') or {}).get('latestSubmission') or {}
    if submission.get('lifecycle') in ('preparing', 'submitted', 'retrying') and uint(submission.get('settledThroughRound')):
        if result['round'] is None or int(submission['settledThroughRound']) > int(result['round']):
            result['pendingRound'] = submission['settledThroughRound']
    return result


def world_from(chain):
    if not chain or chain.get('round') is None:
        return {'stage': None, 'name': None, 'nextRound': None, 'reason': 'Confirmed settlement is unavailable.'}
    index = max(i for i, (floor, _) in enumerate(STAGES) if int(chain['round']) >= floor)
    return {'stage': index + 1, 'name': STAGES[index][1], 'settledRounds': chain['round'], 'nextRound': STAGES[index + 1][0] if index + 1 < len(STAGES) else None, 'stale': chain.get('stale', True)}


def fetch_chain():
    with ThreadPoolExecutor(max_workers=2) as pool:
        core_job = pool.submit(core_cache.read)
        status_job = pool.submit(status_cache.read)
        core, core_error = core_job.result()
        status, status_error = status_job.result()
    return interpret(status, core), core_error or status_error
