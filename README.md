# Squeek Hours

Work together. Move the world.

This is the existing Squeek Hours application, repaired without a framework migration or a branding change. Read [AUDIT.md](AUDIT.md) for the initial technical/functional audit, [DESIGN.md](DESIGN.md) for the implemented design system, and [VALIDATION.md](VALIDATION.md) for actual checks and remaining limits.

## Run it

Python 3.10+ is sufficient to build and run the application. Node 22+ and npm are only needed for JavaScript checks. No API key, wallet or Python package is required by the app.

For the full shared application:

```sh
python3 server.py
```

Open `http://127.0.0.1:4183`. Create a Squeek Hours account with a 3–20 character username and an 8–256 character password. Start a 25/50-minute or custom 1–120 minute session. Sessions continue through reloads and sign-out. Completion, profile statistics and shared rankings persist in `data/app.db`. Back up that database before changing a deployed server. Startup adds the private membership table without deleting existing records. Existing accounts are separate from Squeekchain Community accounts.

Public rooms support presence, personal focus notes and messages. Create a private room and share both its room code and invite privately. New invites use 144 random bits; existing room codes and invites remain valid. Membership survives heartbeat renewal and signing back in. Leave removes current presence; inactive presence expires after 20 seconds. Participation polls every 4 seconds, rather than using WebSockets. Profile themes unlock at 0/100/300/800 XP, and share cards download as PNGs.

For the static site:

```sh
python3 scripts/build.py
python3 -m http.server 4183 --bind 127.0.0.1 --directory dist
```

Open `http://127.0.0.1:4183`. The static export is usable independently: real Squeekchain reads, a device timer, persistent personal statistics/name/themes and PNG downloads. `dist/runtime.json` declares device mode. The Python server dynamically serves `runtime.json` in server mode. This avoids probing nonexistent `/api` routes on IPFS or silently changing storage modes during an outage.

**Static hosting cannot run Python or share SQLite state.** Accounts, shared rooms, community expeditions and shared rankings require the Python application to be hosted on the same origin as its frontend. This assignment does not deploy that service. The static UI says which features need it; personal device records never masquerade as a shared leaderboard. Clearing browser site data removes device records; they are not synced or automatically uploaded. Do not change the static runtime flag to server without providing the real API.

## Install, check and rebuild

The small check toolchain lives in `web/` so root dependency files remain untouched. Its manifest and exact npm lockfile are delivered with the source. Install normal development dependencies; they are not included in the export or submission.

```sh
npm ci --prefix web
npm run typecheck --prefix web
npm test --prefix web
python3 -m unittest discover -s tests -p 'test_*.py' -v
npm run build --prefix web
python3 scripts/check_export.py
```

`typecheck` runs TypeScript with `checkJs`, `allowJs` and `noEmit` on the browser modules. The production build is a deterministic Python copy of `public/` to `dist/` and needs no network or npm install. `check_export.py` verifies byte-for-byte source/export equality and relative local asset paths. All four original artwork files are retained. Hash navigation and relative assets support a gateway subpath; no server rewrite is required.

Browser checks require Playwright and Chromium. Point `IMD_PLAYWRIGHT` at an existing Playwright ES module (or make `playwright` importable) and set `PLAYWRIGHT_BROWSERS_PATH` if needed, then run:

```sh
node tests/browser.mjs
```

That script manages a temporary static preview and Python test service in the foreground, uses disposable accounts/databases, and stops both itself. It includes one live official API check; the remaining chain scenarios use explicitly synthetic test fixtures, outside production. Clocks advance only inside tests, so a long focus session is tested without a long real-time wait. Results and screenshots go to `test/scratch/`, never into the app. `tests/serve.py` is a test harness and is not the application server.

Optional full live-schema validation requires the development package `jsonschema` and network access:

```sh
python3 tests/check_api.py
```

It validates both responses against the official draft-2020-12 schemas, including date-time, UUID and unsigned decimal formats, and checks ETag revalidation. No live measurements are built into the export.

## Chain data and freshness

The public base is `https://api.squeekchain.com`; [official API docs](https://docs.squeekchain.com/developers/api/) publish the [core schema](https://docs.squeekchain.com/assets/api/core.json) and [status schema](https://docs.squeekchain.com/assets/api/status.json).

- `/v1/core` supplies confirmed rounds, work, block height and safe Ethereum block on Sepolia, chain 11155111, with 12 confirmations. The view links its confirming transaction. World stages use only this read.
- `/v1/status` supplies wheel measurements and settlement queue information. A fresh IDLE measurement is the only state shown as a resting wheel. Provisional work and submitted transactions never unlock a stage or earn Focus XP.
- Reads poll at 8 seconds with concurrent-request deduplication, 8-second timeouts, exact ETag/304 handling and Retry-After backoff for 429/503. A 200 unavailable response or invalid response is an error, not a zero value. Runtime parsers validate the fields they consume and ignore unknown additive fields; the optional audit script checks the full published schemas.
- A last-good snapshot is marked stale on failure, after 45 seconds without a successful read, or after 5 minutes without a changed safe block. Measurement age uses the API's 120-second limit. These display freshness rules do not change Ethereum finality. Cached data is held in memory, not shipped as sample state.

Focus XP is not SQK. Finished 25/50-minute sessions award 25/50 XP; custom sessions shorter than five minutes award zero, otherwise one XP per whole minute, capped at 120. Cancelled sessions award none. UTC days determine streaks, daily totals and time-of-day badges. Timers measure elapsed time, not verified human attention; device records are user-editable and never eligible for shared rankings.

## Operator notes

For an HTTPS reverse proxy, keep the frontend and API on the same origin, preserve Host/Origin, and run:

```sh
python3 server.py --host 127.0.0.1 --port 4183 --secure-cookies
```

The flag adds Secure to the existing HttpOnly/SameSite=Lax cookie. Do not use it for a plain HTTP development URL. The service enforces a 30-day auth lifetime, rejects cross-origin JSON mutations, hashes passwords and stored auth tokens, and checks private membership before returning room data. Operator TLS, backups, request/rate limits and process management remain deployment responsibilities. Password reset, email verification, abuse moderation and account recovery are not implemented. The stdlib/SQLite service is suitable for this small application's existing deployment model, not a claim of production-scale availability or a security certification.

## Verified results

On 2026-11-06: production build and checkJs typecheck passed; 21 JavaScript tests and 21 Python tests passed; Chromium completed all available interaction scenarios with no unexpected page errors; the pinned taste probe passed 16/16 checks at 320/390/1440px. Full live official-schema validation and both endpoints' HTTP 304 handling passed. Real confirmed reads worked from Chromium and the Python compatibility proxy. See the validation report for exact coverage and limitations: WebKit/Safari, physical devices, screen-reader operation and native 200% browser zoom were not verified. These checks are worker observations, not independent certification.
