"""SQUEEK HOURS. Stdlib server: accounts, focus sessions, live rooms, chain proxy."""

import argparse
import hashlib
import hmac
import math
import json
import mimetypes
import secrets
import sqlite3
import threading
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse
from squeekchain import fetch_chain, world_from

ROOT = Path(__file__).resolve().parent
STATIC = ROOT / "public"
DB_PATH = ROOT / "data" / "app.db"
API = "https://api.squeekchain.com"
CHAIN_ID = "11155111"
PORT = 4183
SECURE_COOKIES = False

STAGES = [
    (0, "The First Burrow"),
    (800, "The Growing Village"),
    (2000, "The Hamster City"),
    (5000, "The Crystal Kingdom"),
    (10000, "The Infinite World"),
]
MISSION = {
    "id": "001",
    "name": "Build the First City",
    "sessions": 1000,
    "people": 500,
    "minutes": 10000,
    "days": 7,
}
PUBLIC_ROOMS = [
    ("global-focus", "Global Focus"),
    ("deep-work", "Deep Work"),
    ("coding-room", "Coding Room"),
    ("crypto-builders", "Crypto Builders"),
    ("creative-studio", "Creative Studio"),
    ("silent-study", "Silent Study"),
]
THEMES = [("burrow", 0), ("lamp", 100), ("studio", 300), ("crystal", 800)]

lock = threading.Lock()


def now():
    return datetime.now(timezone.utc)


def iso(moment):
    return moment.astimezone(timezone.utc).isoformat()


def parse_time(value):
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except (ValueError, TypeError, AttributeError):
        return None


def db():
    connection = sqlite3.connect(DB_PATH)
    connection.row_factory = sqlite3.Row
    return connection


def init_db():
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    with db() as connection:
        connection.executescript(
            """
            CREATE TABLE IF NOT EXISTS users (
              id INTEGER PRIMARY KEY,
              username TEXT UNIQUE NOT NULL,
              password_hash TEXT NOT NULL,
              salt TEXT NOT NULL,
              theme TEXT NOT NULL DEFAULT 'burrow',
              created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS auth_sessions (
              token_hash TEXT PRIMARY KEY,
              user_id INTEGER NOT NULL,
              created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS rooms (
              id INTEGER PRIMARY KEY,
              slug TEXT UNIQUE NOT NULL,
              name TEXT NOT NULL,
              kind TEXT NOT NULL,
              invite TEXT,
              goal TEXT NOT NULL DEFAULT '',
              owner_id INTEGER,
              created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS presence (
              user_id INTEGER PRIMARY KEY,
              room_id INTEGER NOT NULL,
              focus TEXT NOT NULL DEFAULT '',
              seen_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS room_members (
              user_id INTEGER NOT NULL,
              room_id INTEGER NOT NULL,
              PRIMARY KEY (user_id, room_id)
            );
            CREATE TABLE IF NOT EXISTS messages (
              id INTEGER PRIMARY KEY,
              room_id INTEGER NOT NULL,
              user_id INTEGER NOT NULL,
              body TEXT NOT NULL,
              created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS focus_sessions (
              id INTEGER PRIMARY KEY,
              user_id INTEGER NOT NULL,
              room_id INTEGER,
              kind TEXT NOT NULL,
              planned_seconds INTEGER NOT NULL,
              started_at TEXT NOT NULL,
              ended_at TEXT,
              status TEXT NOT NULL,
              created_at TEXT NOT NULL
            );
            """
        )
        created = iso(now())
        for slug, name in PUBLIC_ROOMS:
            connection.execute(
                "INSERT OR IGNORE INTO rooms (slug, name, kind, goal, created_at) VALUES (?, ?, 'public', '', ?)",
                (slug, name, created),
            )


def hash_password(password, salt=None):
    salt = salt or secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), salt.encode(), 200_000).hex()
    return salt, digest


def token_hash(token):
    return hashlib.sha256(token.encode()).hexdigest()


def user_from_request(connection, headers):
    cookie = headers.get("Cookie", "")
    token = ""
    for part in cookie.split(";"):
        name, _, value = part.strip().partition("=")
        if name == "sqh_session":
            token = value
    if not token:
        return None
    row = connection.execute(
        """
        SELECT users.* FROM auth_sessions
        JOIN users ON users.id = auth_sessions.user_id
        WHERE auth_sessions.token_hash = ? AND auth_sessions.created_at >= ?
        """,
        (token_hash(token), iso(now() - timedelta(days=30))),
    ).fetchone()
    return row


def xp_for(kind, seconds):
    if kind == "25" and seconds >= 25 * 60:
        return 25
    if kind == "50" and seconds >= 50 * 60:
        return 50
    if kind == "custom" and seconds >= 5 * 60:
        return max(5, min(120, seconds // 60))
    return 0


def completed_rows(connection, user_id=None):
    query = "SELECT * FROM focus_sessions WHERE status = 'completed'"
    args = []
    if user_id is not None:
        query += " AND user_id = ?"
        args.append(user_id)
    return connection.execute(query, args).fetchall()


def stats_for(rows):
    minutes = 0
    days = []
    for row in rows:
        minutes += row["planned_seconds"] // 60
        ended = parse_time(row["ended_at"])
        if ended:
            days.append(ended.date())
    unique_days = sorted(set(days))
    streak = best = 0
    previous = None
    for day in unique_days:
        if previous and day == previous + timedelta(days=1):
            streak += 1
        else:
            streak = 1
        best = max(best, streak)
        previous = day
    today = now().date()
    if not unique_days or unique_days[-1] < today - timedelta(days=1):
        streak = 0
    total_xp = 0
    for row in rows:
        total_xp += xp_for(row["kind"], row["planned_seconds"])
    level = "Bronze"
    for name, floor in (("Silver", 100), ("Gold", 300), ("Diamond", 800), ("Legendary", 2000)):
        if total_xp >= floor:
            level = name
    return {
        "minutes": minutes,
        "sessions": len(rows),
        "streak": streak,
        "best": best,
        "xp": total_xp,
        "level": level,
        "days": len(unique_days),
    }


def achievements(connection, user):
    rows = completed_rows(connection, user["id"])
    info = stats_for(rows)
    early = night = False
    for row in rows:
        started = parse_time(row["started_at"])
        if not started:
            continue
        early = early or started.hour < 8
        night = night or started.hour >= 22
    messages = connection.execute(
        "SELECT COUNT(*) AS n FROM messages WHERE user_id = ?", (user["id"],)
    ).fetchone()["n"]
    in_room = any(row["room_id"] for row in rows)
    earned = {
        "Early Bird": early,
        "Night Owl": night,
        "100 Sessions": info["sessions"] >= 100,
        "Focus Master": info["minutes"] >= 1000,
        "Community Builder": messages > 0 and in_room,
        "Expedition Pioneer": info["sessions"] > 0,
    }
    return [{"name": name, "earned": on} for name, on in earned.items()], info


def settle_active(connection, user_id):
    row = connection.execute(
        "SELECT * FROM focus_sessions WHERE user_id = ? AND status = 'active' ORDER BY id DESC LIMIT 1",
        (user_id,),
    ).fetchone()
    if not row:
        return None
    started = parse_time(row["started_at"])
    end = started + timedelta(seconds=row["planned_seconds"])
    if now() >= end:
        connection.execute(
            "UPDATE focus_sessions SET status = 'completed', ended_at = ? WHERE id = ?",
            (iso(end), row["id"]),
        )
        return None
    remaining = max(0, math.ceil((end - now()).total_seconds()))
    return {
        "id": row["id"],
        "kind": row["kind"],
        "plannedSeconds": row["planned_seconds"],
        "remaining": max(0, remaining),
        "roomId": row["room_id"],
        "startedAt": row["started_at"],
    }


def settle_due(connection):
    users = connection.execute("SELECT DISTINCT user_id FROM focus_sessions WHERE status = 'active'").fetchall()
    for row in users:
        settle_active(connection, row['user_id'])


def can_read_room(connection, user, room):
    return room['kind'] == 'public' or bool(user and (room['owner_id'] == user['id'] or connection.execute(
        'SELECT 1 FROM room_members WHERE user_id = ? AND room_id = ?', (user['id'], room['id'])
    ).fetchone()))


def community(connection):
    rows = connection.execute(
        "SELECT user_id, planned_seconds, ended_at FROM focus_sessions WHERE status = 'completed'"
    ).fetchall()
    today = now().date()
    today_minutes = 0
    people = set()
    days = set()
    for row in rows:
        ended = parse_time(row["ended_at"])
        if not ended:
            continue
        people.add(row["user_id"])
        days.add(ended.date())
        if ended.date() == today:
            today_minutes += row["planned_seconds"] // 60
    active = connection.execute(
        "SELECT COUNT(*) AS n FROM presence WHERE seen_at >= ?",
        (iso(now() - timedelta(seconds=20)),),
    ).fetchone()["n"]
    consecutive = 0
    cursor = today
    while cursor in days or (cursor == today and today_minutes > 0):
        if cursor not in days and not (cursor == today and today_minutes > 0):
            break
        consecutive += 1
        cursor -= timedelta(days=1)
    return {
        "sessions": len(rows),
        "people": len(people),
        "minutes": sum(row["planned_seconds"] // 60 for row in rows),
        "todayMinutes": today_minutes,
        "activeUsers": active,
        "consecutiveDays": consecutive,
    }



class App(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        print(fmt % args)

    def send_json(self, code, payload, cookie=None, clear=False):
        body = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header('X-Content-Type-Options', 'nosniff')
        secure = '; Secure' if SECURE_COOKIES else ''
        if cookie:
            self.send_header("Set-Cookie", f"sqh_session={cookie}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000{secure}")
        if clear:
            self.send_header("Set-Cookie", f"sqh_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0{secure}")
        self.end_headers()
        self.wfile.write(body)

    def read_json(self):
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            return None
        if length < 0 or length > 8000:
            return None
        if length == 0:
            return {}
        try:
            payload = json.loads(self.rfile.read(length).decode())
            return payload if isinstance(payload, dict) else None
        except (json.JSONDecodeError, UnicodeDecodeError):
            return None

    def do_GET(self):
        path = urlparse(self.path).path
        if path == '/runtime.json':
            self.send_json(200, {'mode': 'server'})
            return
        if path.startswith("/api/"):
            self.api_get(path)
            return
        file_path = STATIC / "index.html" if path in ("/", "") else STATIC / path.lstrip("/")
        if not file_path.resolve().is_relative_to(STATIC.resolve()) or not file_path.is_file():
            self.send_json(404, {"error": "Not found"})
            return
        data = file_path.read_bytes()
        mime = mimetypes.guess_type(file_path.name)[0] or "application/octet-stream"
        self.send_response(200)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):
        origin = self.headers.get('Origin')
        if origin and urlparse(origin).netloc != self.headers.get('Host'):
            self.send_json(403, {'error': 'Cross-origin account requests are not allowed.'})
            return
        if 'application/json' not in self.headers.get('Content-Type', ''):
            self.send_json(415, {'error': 'Use application/json.'})
            return
        path = urlparse(self.path).path
        payload = self.read_json()
        if payload is None:
            self.send_json(400, {"error": "Bad JSON"})
            return
        with lock:
            connection = db()
            try:
                self.api_post(connection, path, payload)
                connection.commit()
            except (ValueError, TypeError, OverflowError):
                connection.rollback()
                self.send_json(400, {"error": "Invalid request values."})
            finally:
                connection.close()

    def api_get(self, path):
        if path == '/api/health':
            self.send_json(200, {'application': 'squeek-hours', 'version': 1})
            return
        if path == "/api/chain":
            body, error = fetch_chain()
            self.send_json(200, {"chain": body, "warning": error, "world": world_from(body)})
            return
        # External reads must never hold the database lock used by accounts and timers.
        expedition_chain = fetch_chain()[0] if path == '/api/expedition' else None
        with lock:
            connection = db()
            try:
                user = user_from_request(connection, self.headers)
                settle_due(connection)
                if path == "/api/me":
                    self.me(connection, user)
                elif path == "/api/rooms":
                    self.rooms(connection)
                elif path.startswith("/api/rooms/"):
                    self.room_detail(connection, path.split("/")[-1], user)
                elif path == "/api/leaderboard":
                    self.board(connection)
                elif path == "/api/expedition":
                    self.expedition(connection, expedition_chain)
                else:
                    self.send_json(404, {"error": "Not found"})
                connection.commit()
            finally:
                connection.close()

    def me(self, connection, user):
        if not user:
            self.send_json(200, {"user": None})
            return
        active = settle_active(connection, user["id"])
        badges, info = achievements(connection, user)
        self.send_json(200, {
            "user": {"id": user["id"], "username": user["username"], "theme": user["theme"]},
            "stats": info,
            "achievements": badges,
            "active": active,
            "serverNow": iso(now()),
            "themes": [{"id": name, "xp": need, "open": info["xp"] >= need} for name, need in THEMES],
        })

    def rooms(self, connection):
        cutoff = iso(now() - timedelta(seconds=20))
        rows = connection.execute(
            """
            SELECT rooms.*, (SELECT COUNT(*) FROM presence WHERE room_id = rooms.id AND seen_at >= ?) AS live
            FROM rooms WHERE kind = 'public' ORDER BY id
            """,
            (cutoff,),
        ).fetchall()
        self.send_json(200, {"rooms": [dict(row) for row in rows]})

    def room_detail(self, connection, slug, user):
        room = connection.execute("SELECT * FROM rooms WHERE slug = ?", (slug,)).fetchone()
        if not room:
            self.send_json(404, {"error": "No such room"})
            return
        if not can_read_room(connection, user, room):
            self.send_json(403, {'error': 'Join with a valid invite to read this private room.'})
            return
        cutoff = iso(now() - timedelta(seconds=20))
        people = connection.execute(
            """
            SELECT users.username, presence.focus, presence.seen_at
            FROM presence JOIN users ON users.id = presence.user_id
            WHERE presence.room_id = ? AND presence.seen_at >= ?
            ORDER BY users.username
            """,
            (room["id"], cutoff),
        ).fetchall()
        notes = connection.execute(
            """
            SELECT messages.body, messages.created_at, users.username
            FROM messages JOIN users ON users.id = messages.user_id
            WHERE messages.room_id = ? ORDER BY messages.id DESC LIMIT 30
            """,
            (room["id"],),
        ).fetchall()
        safe_room = {key: room[key] for key in ('id', 'slug', 'name', 'kind', 'goal')}
        self.send_json(200, {"room": safe_room, "people": [dict(row) for row in people], "messages": [dict(row) for row in reversed(notes)]})

    def board(self, connection):
        users = connection.execute("SELECT id, username, theme FROM users").fetchall()
        ranked = []
        for user in users:
            info = stats_for(completed_rows(connection, user["id"]))
            if info["sessions"] == 0:
                continue
            ranked.append({"username": user["username"], "theme": user["theme"], **info})
        ranked.sort(key=lambda item: (-item["xp"], -item["minutes"], item['username']))
        self.send_json(200, {"leaders": ranked[:50]})

    def expedition(self, connection, chain):
        facts = community(connection)
        self.send_json(200, {
            "mission": MISSION,
            "community": facts,
            "hamster": world_from(chain),
        })

    def api_post(self, connection, path, payload):
        user = user_from_request(connection, self.headers)
        if path == "/api/register":
            self.register(connection, payload)
        elif path == "/api/login":
            self.login(connection, payload)
        elif path == "/api/logout":
            self.logout(connection)
        elif path == "/api/sessions":
            self.start_session(connection, user, payload)
        elif path.endswith("/complete") and path.startswith("/api/sessions/"):
            self.finish_session(connection, user, path.split("/")[3])
        elif path.endswith("/cancel") and path.startswith("/api/sessions/"):
            self.cancel_session(connection, user, path.split("/")[3])
        elif path == "/api/theme":
            self.set_theme(connection, user, payload)
        elif path.endswith("/join") and path.startswith("/api/rooms/"):
            self.join_room(connection, user, path.split("/")[3], payload)
        elif path.endswith("/messages") and path.startswith("/api/rooms/"):
            self.post_message(connection, user, path.split("/")[3], payload)
        elif path == '/api/rooms/leave':
            if not user:
                self.send_json(401, {'error': 'Sign in.'})
                return
            connection.execute('DELETE FROM presence WHERE user_id = ?', (user['id'],))
            self.send_json(200, {'ok': True})
        elif path == "/api/rooms":
            self.create_room(connection, user, payload)
        else:
            self.send_json(404, {"error": "Not found"})

    def register(self, connection, payload):
        username = str(payload.get("username") or "")
        password = str(payload.get("password") or "")
        if not username.replace("_", "").isalnum() or not 3 <= len(username) <= 20:
            self.send_json(400, {"error": "Username must be 3–20 letters, numbers, or underscores."})
            return
        if not 8 <= len(password) <= 256:
            self.send_json(400, {"error": "Password must be 8–256 characters."})
            return
        if connection.execute("SELECT id FROM users WHERE username = ?", (username,)).fetchone():
            self.send_json(409, {"error": "That username is taken."})
            return
        salt, digest = hash_password(password)
        connection.execute(
            "INSERT INTO users (username, password_hash, salt, created_at) VALUES (?, ?, ?, ?)",
            (username, digest, salt, iso(now())),
        )
        self.issue(connection, username)

    def login(self, connection, payload):
        username = str(payload.get("username") or "")
        password = str(payload.get("password") or "")
        if len(password) > 256:
            self.send_json(400, {'error': 'Password is too long.'})
            return
        row = connection.execute("SELECT * FROM users WHERE username = ?", (username,)).fetchone()
        if not row:
            self.send_json(401, {"error": "Wrong username or password."})
            return
        _salt, digest = hash_password(password, row["salt"])
        if not hmac.compare_digest(digest, row["password_hash"]):
            self.send_json(401, {"error": "Wrong username or password."})
            return
        self.issue(connection, username)

    def issue(self, connection, username):
        connection.execute('DELETE FROM auth_sessions WHERE created_at < ?', (iso(now() - timedelta(days=30)),))
        user = connection.execute("SELECT id FROM users WHERE username = ?", (username,)).fetchone()
        token = secrets.token_urlsafe(32)
        connection.execute(
            "INSERT INTO auth_sessions (token_hash, user_id, created_at) VALUES (?, ?, ?)",
            (token_hash(token), user["id"], iso(now())),
        )
        self.send_json(200, {"ok": True, "username": username}, cookie=token)

    def logout(self, connection):
        user = user_from_request(connection, self.headers)
        if user:
            connection.execute('DELETE FROM presence WHERE user_id = ?', (user['id'],))
        cookie = self.headers.get("Cookie", "")
        for part in cookie.split(";"):
            name, _, value = part.strip().partition("=")
            if name == "sqh_session" and value:
                connection.execute("DELETE FROM auth_sessions WHERE token_hash = ?", (token_hash(value),))
        self.send_json(200, {"ok": True}, clear=True)

    def start_session(self, connection, user, payload):
        if not user:
            self.send_json(401, {"error": "Sign in to start a session."})
            return
        if settle_active(connection, user["id"]):
            self.send_json(409, {"error": "A session is already running."})
            return
        kind = str(payload.get("kind") or "")
        if kind == "25":
            seconds = 25 * 60
        elif kind == "50":
            seconds = 50 * 60
        elif kind == "custom":
            minutes = payload.get('minutes')
            if not isinstance(minutes, int) or isinstance(minutes, bool):
                self.send_json(400, {'error': 'Custom duration must be a whole number of minutes.'})
                return
            if minutes < 1 or minutes > 120:
                self.send_json(400, {"error": "Custom sessions are 1 to 120 minutes."})
                return
            seconds = minutes * 60
        else:
            self.send_json(400, {"error": "Unknown session."})
            return
        room_id = None
        slug = payload.get("room")
        if slug:
            room = connection.execute("SELECT * FROM rooms WHERE slug = ?", (str(slug),)).fetchone()
            if not room or not can_read_room(connection, user, room):
                self.send_json(403, {'error': 'Join this room before starting a session in it.'})
                return
            room_id = room['id']
        stamp = iso(now())
        cursor = connection.execute(
            """
            INSERT INTO focus_sessions (user_id, room_id, kind, planned_seconds, started_at, status, created_at)
            VALUES (?, ?, ?, ?, ?, 'active', ?)
            """,
            (user["id"], room_id, kind, seconds, stamp, stamp),
        )
        self.send_json(200, {"id": cursor.lastrowid, "kind": kind, "remaining": seconds, 'plannedSeconds': seconds, 'startedAt': stamp, 'serverNow': stamp})

    def finish_session(self, connection, user, session_id):
        if not user:
            self.send_json(401, {"error": "Sign in."})
            return
        row = connection.execute(
            "SELECT * FROM focus_sessions WHERE id = ? AND user_id = ? AND status IN ('active', 'completed')",
            (session_id, user["id"]),
        ).fetchone()
        if not row:
            self.send_json(404, {"error": "No active session."})
            return
        if row['status'] == 'completed':
            self.send_json(200, {'ok': True, 'xp': xp_for(row['kind'], row['planned_seconds']), 'minutes': row['planned_seconds'] // 60})
            return
        started = parse_time(row["started_at"])
        elapsed = (now() - started).total_seconds()
        if elapsed < row["planned_seconds"]:
            self.send_json(400, {"error": "This session has not finished yet."})
            return
        ended = iso(started + timedelta(seconds=row["planned_seconds"]))
        connection.execute(
            "UPDATE focus_sessions SET status = 'completed', ended_at = ? WHERE id = ?",
            (ended, row["id"]),
        )
        self.send_json(200, {"ok": True, "xp": xp_for(row["kind"], row["planned_seconds"]), "minutes": row["planned_seconds"] // 60})

    def cancel_session(self, connection, user, session_id):
        if not user:
            self.send_json(401, {"error": "Sign in."})
            return
        settle_active(connection, user['id'])
        result = connection.execute(
            "UPDATE focus_sessions SET status = 'cancelled', ended_at = ? WHERE id = ? AND user_id = ? AND status = 'active'",
            (iso(now()), session_id, user["id"]),
        )
        if result.rowcount == 0:
            self.send_json(409, {'error': 'This session already ended or does not belong to your account. Refresh your profile.'})
            return
        self.send_json(200, {"ok": True})

    def set_theme(self, connection, user, payload):
        if not user:
            self.send_json(401, {"error": "Sign in."})
            return
        theme = str(payload.get("theme") or "")
        _badges, info = achievements(connection, user)
        allowed = {name for name, need in THEMES if info["xp"] >= need}
        if theme not in allowed:
            self.send_json(400, {"error": "That theme is still locked."})
            return
        connection.execute("UPDATE users SET theme = ? WHERE id = ?", (theme, user["id"]))
        self.send_json(200, {"ok": True})

    def join_room(self, connection, user, slug, payload):
        if not user:
            self.send_json(401, {"error": "Sign in to join a room."})
            return
        room = connection.execute("SELECT * FROM rooms WHERE slug = ?", (slug,)).fetchone()
        if not room:
            self.send_json(404, {"error": "No such room"})
            return
        if not can_read_room(connection, user, room) and payload.get("invite") != room["invite"]:
            self.send_json(403, {"error": "Invite code required."})
            return
        if room['kind'] == 'private':
            connection.execute('INSERT OR IGNORE INTO room_members (user_id, room_id) VALUES (?, ?)', (user['id'], room['id']))
        focus = str(payload.get("focus") or "")[:80]
        connection.execute(
            """
            INSERT INTO presence (user_id, room_id, focus, seen_at) VALUES (?, ?, ?, ?)
            ON CONFLICT(user_id) DO UPDATE SET room_id = excluded.room_id, focus = excluded.focus, seen_at = excluded.seen_at
            """,
            (user["id"], room["id"], focus, iso(now())),
        )
        self.send_json(200, {"ok": True})

    def post_message(self, connection, user, slug, payload):
        if not user:
            self.send_json(401, {"error": "Sign in to talk."})
            return
        room = connection.execute("SELECT * FROM rooms WHERE slug = ?", (slug,)).fetchone()
        if not room:
            self.send_json(404, {"error": "No such room"})
            return
        if not can_read_room(connection, user, room):
            self.send_json(403, {'error': 'Join with a valid invite first.'})
            return
        body = " ".join(str(payload.get("body") or "").split())
        if not body or len(body) > 140:
            self.send_json(400, {"error": "Messages are 1–140 characters."})
            return
        present = connection.execute(
            "SELECT 1 FROM presence WHERE user_id = ? AND room_id = ? AND seen_at >= ?",
            (user["id"], room["id"], iso(now() - timedelta(seconds=20))),
        ).fetchone()
        if not present:
            self.send_json(403, {"error": "Join the room first."})
            return
        connection.execute(
            "INSERT INTO messages (room_id, user_id, body, created_at) VALUES (?, ?, ?, ?)",
            (room["id"], user["id"], body, iso(now())),
        )
        self.send_json(200, {"ok": True})

    def create_room(self, connection, user, payload):
        if not user:
            self.send_json(401, {"error": "Sign in to create a room."})
            return
        name = " ".join(str(payload.get("name") or "").split())
        if not 3 <= len(name) <= 40:
            self.send_json(400, {"error": "Room name must be 3–40 characters."})
            return
        slug = "p-" + secrets.token_hex(4)
        invite = secrets.token_urlsafe(18)
        goal = str(payload.get("goal") or "")[:80]
        connection.execute(
            """
            INSERT INTO rooms (slug, name, kind, invite, goal, owner_id, created_at)
            VALUES (?, ?, 'private', ?, ?, ?, ?)
            """,
            (slug, name, invite, goal, user["id"], iso(now())),
        )
        self.send_json(200, {"slug": slug, "invite": invite})


def main():
    global SECURE_COOKIES
    parser = argparse.ArgumentParser(description='Run the existing Squeek Hours shared service.')
    parser.add_argument('--host', default='127.0.0.1')
    parser.add_argument('--port', type=int, default=PORT)
    parser.add_argument('--secure-cookies', action='store_true', help='Use behind an HTTPS reverse proxy; cookies require HTTPS.')
    args = parser.parse_args()
    SECURE_COOKIES = args.secure_cookies
    init_db()
    server = ThreadingHTTPServer((args.host, args.port), App)
    print(f"SQUEEK HOURS on http://{args.host}:{args.port}")
    server.serve_forever()


if __name__ == "__main__":
    main()
