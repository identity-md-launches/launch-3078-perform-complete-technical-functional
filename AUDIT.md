# Squeek Hours technical and functional audit

Initial review: 2026-11-06, before implementation. Scope: every existing source file (`server.py`, `public/app.js`, `public/styles.css`, `public/index.html`), README, ignore rules, tracked file list and four supplied artwork assets. No existing build configuration, dependencies or lockfiles exist. No deployment or rebranding is proposed.

## Current stack

Python standard-library HTTP server, SQLite, PBKDF2 password hashing, cookie sessions, plain browser JavaScript modules and CSS. No React, TypeScript, npm toolchain, build script or static export. The previous delivery was hosted statically at `squeek-hours.identitymd.eth`; the Python process does not run on IPFS.

## Feature inventory before changes

| Area | Existing implementation and observed issues | Scoped fix |
| --- | --- | --- |
| Chain | Official `/v1/status` is reachable and supports browser CORS. Browser first requests unavailable same-origin `/api/chain`; fallback can return an incompatible shape; failures leave the initial copy indefinitely. Proxy mishandles urllib's HTTP 304, discards warnings in the UI, and does not bound retry parsing or reliably age cached state. | Read official `/v1/core` for confirmed settlement independently of `/v1/status` telemetry. Validate consumed fields, preserve decimal precision, handle timeouts/304/429/503, identify last-good data and expose retry. |
| Authentication | Registration, login, PBKDF2 and HttpOnly cookie exist on the Python server. No server is available in the static deployment. Auth sessions never expire on the server; unvalidated body types can crash handlers. | Retain server accounts; enforce expiration and input validation, clear presence at logout, test authorization. Explain server requirements on static hosting. |
| Focus and persistence | 25/50/custom server sessions exist. Custom sessions have no UI. `/api/me` settles an elapsed session but closes its SQLite connection without committing: reported XP disappears on the next request. Countdown subtracts ticks rather than using deadlines. | Commit completion, settle due sessions consistently, add custom control, use server deadline and resync on return. Add explicitly device-only focus persistence to make the static export useful without posing as an account. |
| Rooms and participation | Public/private rooms, presence and messages exist. Any caller can GET private-room details including the invite and messages. Private heartbeat drops invite and fails silently. Guest joins set local room state before rejection. No leave control. Presence is polling, not sockets. | Persist private membership after valid invitation, redact secrets, authorize reads/posts/session room assignment, explicit leave, recoverable failures, label polling. |
| XP and leaderboard | Finished-session XP/streak/level logic exists, separate from SQK. The read rollback prevents normal completion from appearing durably on the board; ties have no defined ordering. | Repair settlement transaction and cover XP boundaries, cancellation, streaks and deterministic ranking. Keep device statistics out of shared rankings. |
| Expeditions | Server derives community totals and chain-derived world stages. Chain fetch happens while holding the app's global database lock, blocking account/session actions up to 8 seconds. Static UI starts with fabricated-looking zero community counts. | Keep shared totals unknown until loaded, decouple chain reads, maintain separation between focus and confirmed chain progress. |
| Profiles | Stats, badges, theme selection and PNG download exist. Sign out leaves prior profile content visible. Stored themes have no visual application. | Clear private view state, implement the existing themes, refresh stats, test download. |
| Layout and delivery | Branding, dark palette, serif typography and hamster artwork are established. No favicon or social metadata. Absolute assets break gateway subpaths. At phone widths the large image pushes session controls below the first screen. Several controls have placeholders only. | Retain brand and artwork, move session action beside timer, responsive image, relative URLs, labels/focus/error states, metadata, repeatable static build. |

## Blockchain investigation

Primary references: [official API documentation](https://docs.squeekchain.com/developers/api/), [status schema](https://docs.squeekchain.com/assets/api/status.json), [core schema](https://docs.squeekchain.com/assets/api/core.json). Direct live checks on 2026-11-06 returned HTTP 200 from `https://api.squeekchain.com/v1/status` and `/v1/core`; `Access-Control-Allow-Origin: *`, exposed ETag/Retry-After and OPTIONS allowing `If-None-Match` were verified. Status schema version 1 remains current: there is no evidence of a version migration causing this defect. No API key or wallet is needed for these public reads.

The documented confirmed read is `/v1/core`, pinned 12 Ethereum blocks behind tip. Pipeline status is an independent measurement/queue snapshot, shared for one second; core is shared for five seconds. The live observations differed by one settled round, confirming that pipeline anchor lag must not gate the confirmed view. A measurement can be missing/stale while core remains readable. HTTP 200 `status: unavailable` means unknown. Optimistic projections and submitted transactions are never confirmed data or Focus XP.

## Reproduced baseline defects

A bounded HTTP test against an isolated SQLite database reproduced anonymous private-room invite disclosure, nonpersistent `/api/me` completion, and a missing leaderboard entry despite the same user's reported 25 XP. Tests use synthetic accounts only. No live user database was accessed.

## Recommended order and boundaries

1. Correct confirmed reads and independent telemetry, then verify failure/caching states.
2. Repair the existing server's persistence, authorization and room polling; retain all features and API routes.
3. Add honest device-only timer/profile support for the static export. Shared accounts, rooms and rankings still require this application's Python server; do not manufacture community activity or silently turn local records into a global board.
4. Improve the existing layout/accessibility and deliver a small deterministic export with source, test tooling, lockfile and documentation.

This is a scoped extension of the existing application, without a framework migration, a new hosted identity provider or a replacement backend. See `VALIDATION.md` for final results, remaining operational needs and the limits of this audit.

## Final disposition

| Area | Result after scoped repairs |
| --- | --- |
| Confirmed settlement | Real `/v1/core` responses loaded in Chromium and the Python compatibility proxy. Both official response schemas and conditional HTTP 304 responses were verified live. |
| Failure/freshness handling | Confirmed and activity reads have independent availability. Timeout, network/HTML/malformed response, unavailable, 304, Retry-After, last-good stale and recovery behavior were exercised. |
| Accounts | Registration/login failure/login/logout, server-enforced expiration, Secure-cookie option and private-view clearing tested. The shared service must be operated to offer accounts publicly. |
| Focus and XP | 25/50/custom flows, duplicate starts, early completion, cancellation, late cancellation, idempotent completion, reload, durable XP and UTC statistics tested. |
| Rooms | Two real test accounts exchanged messages and focus notes; automatic polling, valid-invite membership, private heartbeat, denied reads/posts/session attachment, leave and expiry tested. Active room now precedes the room list. |
| League/expeditions | Finished sessions populate deterministic shared rankings and shared expedition totals; device records remain excluded. World stages depend only on confirmed core state. |
| Profiles | Name editing in device mode, server statistics, theme locks/unlocks, applied theme state, badge derivation, PNG download and sign-out clearing tested. |
| Delivery | Relative static export, source, deterministic build script, check toolchain/lockfile, responsive retained branding and design documentation delivered. |

The application remains plain JavaScript plus the existing Python/SQLite backend. The only frontend dependency added is development-only TypeScript for checkJs; the runtime and build have no new third-party dependencies. Deployment/hosting of the shared Python service remains an operational requirement, not a feature supplied by static IPFS hosting. Password recovery, moderation and production abuse/scaling controls are documented limitations rather than mock interfaces. WebKit/Safari and physical-device/screen-reader testing were unavailable. Full evidence and review coverage follow in `VALIDATION.md`.
