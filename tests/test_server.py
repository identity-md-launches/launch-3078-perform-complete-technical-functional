"""HTTP integration tests using isolated databases and a controllable application clock."""
import http.cookiejar
import io
import json
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import server as app
import squeekchain as chain


class ServerTests(unittest.TestCase):
    def setUp(self):
        Path('test/scratch').mkdir(parents=True, exist_ok=True)
        self.tmp = tempfile.TemporaryDirectory(dir='test/scratch')
        self.at = datetime(2026, 11, 6, 12, tzinfo=timezone.utc)
        self.patches = [patch.object(app, 'DB_PATH', Path(self.tmp.name) / 'test.db'), patch.object(app, 'now', lambda: self.at), patch.object(app.App, 'log_message', lambda *args: None), patch.object(app, 'fetch_chain', lambda: (None, None))]
        for item in self.patches:
            item.start()
        app.init_db()
        self.server = app.ThreadingHTTPServer(('127.0.0.1', 0), app.App)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base = f'http://127.0.0.1:{self.server.server_port}'
        self.alice, self.bob, self.anon = self.client(), self.client(), self.client()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        for item in reversed(self.patches):
            item.stop()
        self.tmp.cleanup()

    def client(self):
        return urllib.request.build_opener(urllib.request.ProxyHandler({}), urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))

    def request(self, path, body=None, client=None, headers=None, raw=None):
        data = raw if raw is not None else json.dumps(body).encode() if body is not None else None
        request = urllib.request.Request(self.base + path, data=data, headers=headers or {'Content-Type': 'application/json'})
        try:
            response = (client or self.alice).open(request)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            payload = json.loads(response.read()) if response.headers.get('Content-Type') == 'application/json' else None
            return response.code, payload, response.headers

    def register(self, client=None, username='alice'):
        code, _, headers = self.request('/api/register', {'username': username, 'password': 'test-password-123'}, client)
        self.assertEqual(code, 200)
        self.assertIn('HttpOnly', headers['Set-Cookie'])
        self.assertIn('SameSite=Lax', headers['Set-Cookie'])

    def start(self, kind='25', minutes=None, room=None):
        code, data, _ = self.request('/api/sessions', {'kind': kind, 'minutes': minutes, 'room': room})
        self.assertEqual(code, 200)
        return data

    def test_registration_login_logout_and_password_failure(self):
        self.register()
        self.assertEqual(self.request('/api/register', {'username': 'alice', 'password': 'test-password-123'})[0], 409)
        self.assertEqual(self.request('/api/me')[1]['user']['username'], 'alice')
        self.request('/api/logout', {})
        self.assertIsNone(self.request('/api/me')[1]['user'])
        self.assertEqual(self.request('/api/login', {'username': 'alice', 'password': 'wrong-password'})[0], 401)
        self.assertEqual(self.request('/api/login', {'username': 'alice', 'password': 'test-password-123'})[0], 200)
        self.assertEqual(self.request('/api/me')[1]['user']['username'], 'alice')

    def test_bad_auth_and_body_validation(self):
        for username, password in [('a', 'long-password'), ('bad name', 'long-password'), ('valid', 'short'), ('valid', 'x'*257)]:
            self.assertEqual(self.request('/api/register', {'username': username, 'password': password})[0], 400)
        for body in [[], 'string', 1, None]:
            self.assertEqual(self.request('/api/register', raw=json.dumps(body).encode())[0], 400)
        self.assertEqual(self.request('/api/register', raw=b'{broken')[0], 400)
        self.assertEqual(self.request('/api/register', raw=b'\xff')[0], 400)
        self.assertEqual(self.request('/api/register', raw=b'{}', headers={'Content-Type': 'text/plain'})[0], 415)
        self.assertEqual(self.request('/api/register', {}, headers={'Content-Type': 'application/json', 'Origin': 'https://other.example'})[0], 403)

    def test_server_enforces_auth_session_expiration(self):
        self.register()
        self.at += timedelta(days=31)
        self.assertIsNone(self.request('/api/me')[1]['user'])
        self.assertEqual(self.request('/api/sessions', {'kind': '25'})[0], 401)

    def test_auth_required_for_mutations(self):
        for path, body in [('/api/sessions', {'kind': '25'}), ('/api/rooms/global-focus/join', {}), ('/api/rooms/global-focus/messages', {'body': 'test'}), ('/api/rooms', {'name': 'test room'}), ('/api/theme', {'theme': 'burrow'})]:
            self.assertEqual(self.request(path, body, self.anon)[0], 401)

    def test_focus_completion_persists_once_and_populates_board(self):
        self.register()
        self.start()
        self.assertEqual(self.request('/api/sessions', {'kind': '50'})[0], 409)
        self.at += timedelta(seconds=1499)
        self.assertEqual(self.request('/api/me')[1]['stats']['xp'], 0)
        self.at += timedelta(seconds=1)
        for _ in range(2):
            payload = self.request('/api/me')[1]
            self.assertEqual(payload['stats']['xp'], 25)
            self.assertIsNone(payload['active'])
        with app.db() as connection:
            self.assertEqual(connection.execute('SELECT status FROM focus_sessions').fetchone()['status'], 'completed')
        self.assertEqual(self.request('/api/leaderboard')[1]['leaders'][0]['xp'], 25)
        facts = self.request('/api/expedition')[1]['community']
        self.assertEqual((facts['sessions'], facts['minutes'], facts['people']), (1, 25, 1))

    def test_completion_without_returning_owner_is_counted_on_board(self):
        self.register(); self.start('50'); self.at += timedelta(minutes=50)
        board = self.request('/api/leaderboard', client=self.anon)[1]['leaders']
        self.assertEqual(board[0]['xp'], 50)

    def test_early_completion_rejected_and_cancel_adds_no_xp(self):
        self.register(); session = self.start()
        self.at += timedelta(seconds=1499)
        self.assertEqual(self.request(f"/api/sessions/{session['id']}/complete", {})[0], 400)
        self.assertEqual(self.request(f"/api/sessions/{session['id']}/cancel", {})[0], 200)
        self.at += timedelta(hours=1)
        self.assertEqual(self.request('/api/me')[1]['stats']['xp'], 0)

    def test_custom_validation_and_xp_threshold(self):
        self.register()
        for value in [None, 0, 121, '5', 1.5, True, {}, []]:
            self.assertEqual(self.request('/api/sessions', {'kind': 'custom', 'minutes': value})[0], 400)
        self.start('custom', 1); self.at += timedelta(minutes=1)
        self.assertEqual(self.request('/api/me')[1]['stats']['xp'], 0)
        self.start('custom', 5); self.at += timedelta(minutes=5)
        stats = self.request('/api/me')[1]['stats']
        self.assertEqual((stats['xp'], stats['minutes'], stats['sessions']), (5, 6, 2))

    def test_completion_retry_and_late_cancel_cannot_remove_earned_xp(self):
        self.register(); session = self.start()
        self.at += timedelta(minutes=25)
        self.assertEqual(self.request(f"/api/sessions/{session['id']}/cancel", {})[0], 409)
        for _ in range(2):
            self.assertEqual(self.request(f"/api/sessions/{session['id']}/complete", {})[1]['xp'], 25)
        self.assertEqual(self.request('/api/me')[1]['stats']['xp'], 25)

    def test_secure_cookie_option_and_database_migration_preserve_accounts(self):
        with patch.object(app, 'SECURE_COOKIES', True):
            _, _, headers = self.request('/api/register', {'username': 'secure_user', 'password': 'test-password-123'})
            self.assertIn('; Secure', headers['Set-Cookie'])
        self.register()
        session = self.start()
        app.init_db()
        self.assertEqual(self.request('/api/me')[1]['active']['id'], session['id'])

    def test_session_ownership(self):
        self.register(); session = self.start()
        self.register(self.bob, 'bob')
        self.assertEqual(self.request(f"/api/sessions/{session['id']}/complete", {}, self.bob)[0], 404)
        self.request(f"/api/sessions/{session['id']}/cancel", {}, self.bob)
        self.assertEqual(self.request('/api/me')[1]['active']['id'], session['id'])

    def test_private_room_read_protected_and_invite_not_leaked(self):
        self.register(); self.register(self.bob, 'bob')
        _, room, _ = self.request('/api/rooms', {'name': 'Private room', 'goal': 'Private goal'})
        self.assertGreaterEqual(len(room['invite']), 24)
        path = '/api/rooms/' + room['slug']
        self.assertEqual(self.request(path, client=self.anon)[0], 403)
        self.assertEqual(self.request(path, client=self.bob)[0], 403)
        self.assertEqual(self.request(path+'/join', {'invite': 'wrong'}, self.bob)[0], 403)
        self.assertEqual(self.request(path+'/messages', {'body': 'intrusion'}, self.bob)[0], 403)
        self.assertEqual(self.request('/api/sessions', {'kind': '25', 'room': room['slug']}, self.bob)[0], 403)
        self.assertEqual(self.request(path+'/join', {'invite': room['invite']}, self.bob)[0], 200)
        self.assertEqual(self.request(path+'/join', {'focus': 'Still working'}, self.bob)[0], 200)
        details = self.request(path, client=self.bob)[1]
        self.assertNotIn('invite', details['room'])
        self.assertNotIn('owner_id', details['room'])
        self.assertNotIn(room['slug'], [r['slug'] for r in self.request('/api/rooms')[1]['rooms']])

    def test_public_participation_messages_expiry_leave_and_logout(self):
        self.register(); self.register(self.bob, 'bob')
        path = '/api/rooms/global-focus'
        self.request(path+'/join', {'focus': 'Coding'})
        self.request(path+'/join', {'focus': 'Reading'}, self.bob)
        self.request(path+'/messages', {'body': '<script>literal text</script>'})
        data = self.request(path)[1]
        self.assertEqual(len(data['people']), 2)
        self.assertEqual(data['messages'][0]['body'], '<script>literal text</script>')
        self.request('/api/rooms/leave', {}, self.bob)
        self.assertEqual(len(self.request(path)[1]['people']), 1)
        self.at += timedelta(seconds=21)
        self.assertEqual(len(self.request(path)[1]['people']), 0)
        self.assertEqual(self.request(path+'/messages', {'body': 'expired presence'})[0], 403)
        self.request(path+'/join', {}); self.request('/api/logout', {})
        self.assertEqual(len(self.request(path, client=self.anon)[1]['people']), 0)

    def test_message_and_room_validation(self):
        self.register()
        self.assertEqual(self.request('/api/rooms', {'name': 'a'})[0], 400)
        self.request('/api/rooms/global-focus/join', {})
        for value in ['', ' '*10, 'a'*141]:
            self.assertEqual(self.request('/api/rooms/global-focus/messages', {'body': value})[0], 400)
        self.assertEqual(self.request('/api/rooms/does-not-exist/join', {})[0], 404)

    def test_themes_and_profile_achievements_are_real(self):
        self.register()
        self.assertEqual(self.request('/api/theme', {'theme': 'lamp'})[0], 400)
        self.request('/api/rooms/global-focus/join', {})
        self.request('/api/rooms/global-focus/messages', {'body': 'Working on tests'})
        self.start('custom',100,room='global-focus'); self.at += timedelta(minutes=100)
        profile = self.request('/api/me')[1]
        self.assertEqual(profile['stats']['xp'], 100)
        self.assertTrue(next(x for x in profile['achievements'] if x['name'] == 'Community Builder')['earned'])
        self.assertEqual(self.request('/api/theme', {'theme': 'lamp'})[0], 200)
        self.assertEqual(self.request('/api/me')[1]['user']['theme'], 'lamp')

    def test_utc_streaks_and_board_ties(self):
        self.register(); self.register(self.bob, 'bob')
        self.start(); self.request('/api/sessions', {'kind': '25'}, self.bob)
        self.at += timedelta(minutes=25)
        self.assertEqual([row['username'] for row in self.request('/api/leaderboard')[1]['leaders']], ['alice','bob'])
        self.at += timedelta(days=1)
        self.start(); self.at += timedelta(minutes=25)
        self.assertEqual(self.request('/api/me')[1]['stats']['streak'],2)
        self.at += timedelta(days=2)
        stats=self.request('/api/me')[1]['stats']; self.assertEqual(stats['streak'],0); self.assertEqual(stats['best'],2)

    def test_static_delivery_runtime_and_not_found(self):
        self.assertEqual(self.request('/runtime.json')[1], {'mode':'server'})
        self.assertEqual(self.request('/api/health')[1]['application'], 'squeek-hours')
        self.assertEqual(self.request('/not-found.js')[0],404)
        self.assertEqual(self.request('/../server.py')[0],404)
        self.assertEqual(self.request('/')[0],200)


class ChainCacheTests(unittest.TestCase):
    def test_304_revalidates_existing_body(self):
        cache=chain.ReadCache('core'); cache.body={'chain':{'safeThroughBlock':'1'}}; cache.etag='"test"'
        error=urllib.error.HTTPError('https://api.squeekchain.com/v1/core',304,'Not Modified',{},None)
        with patch.object(chain.urllib.request,'urlopen',side_effect=error), patch.object(chain.time,'time',return_value=100):
            body,warning=cache.read()
        self.assertIs(body,cache.body); self.assertIsNone(warning); self.assertEqual(cache.checked_at,100)

    def test_retry_after_even_without_any_saved_body(self):
        cache=chain.ReadCache('core')
        error=urllib.error.HTTPError('https://api.squeekchain.com/v1/core',503,'Unavailable',{'Retry-After':'60'},None)
        with patch.object(chain.urllib.request,'urlopen',side_effect=error) as fetch, patch.object(chain.time,'time',return_value=100):
            self.assertIsNone(cache.read()[0]); cache.read(); self.assertEqual(fetch.call_count,1)
        self.assertEqual(cache.next_at,160)

    def test_malformed_retry_after_does_not_crash(self):
        cache=chain.ReadCache('status')
        error=urllib.error.HTTPError('https://api.squeekchain.com/v1/status',429,'Limited',{'Retry-After':'nonsense'},None)
        with patch.object(chain.urllib.request,'urlopen',side_effect=error), patch.object(chain.time,'time',return_value=100):
            self.assertIn('429',cache.read()[1])
        self.assertEqual(cache.next_at,115)

    def test_confirmed_round_zero_and_unknown_world(self):
        self.assertEqual(chain.world_from({'round':'0','stale':False})['stage'],1)
        self.assertIsNone(chain.world_from(None)['stage'])

if __name__ == '__main__': unittest.main()
