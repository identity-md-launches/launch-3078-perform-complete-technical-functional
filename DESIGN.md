# Squeek Hours design system

## Overview

Squeek Hours is a focus timer with personal profiles, shared focus rooms and a separate view of Squeekchain's confirmed progress. This update preserves the existing name, “Work together. Move the world.” signature, hamster artwork, dark palette and serif/sans pairing. The main action sits with the timer; chain state has its own section so a failed read cannot obscure the timer.

Source of truth: `public/styles.css`, `public/index.html`, and the render functions in `public/app.js`. `dist/` is an exact export, not a second design implementation. Review observations and limitations are in `VALIDATION.md`.

## Colors

| Token | Value | Role |
| --- | --- | --- |
| `--bg` | `#090d16` | Page and input backgrounds |
| `--card` | `#111827` | Timer, room and summary surfaces |
| `--ink` | `#f5f7fa` | Main text and secondary controls |
| `--muted` | `#a5afbf` | Help, labels and source/freshness details |
| `--lime` | `#a6ff5b` | Main action fill and selected-state outlines/text |
| `--teal` | `#49d9cf` | Data links, activity and keyboard focus |
| `--line` | `#485265` | Input and secondary-control borders |
| `--error` | `#ffb4b4` | Recoverable errors |

Primary buttons use `#102006` text. Hovering neutral controls uses `#263041`. The three existing unlockable themes are applied through `body[data-theme]`: lamp changes card/teal to `#211c16`/`#f1c674`; studio to `#122521`/`#77e6cf`; crystal to `#201a30`/`#c6b2ff`. Theme names and XP thresholds remain unchanged. These are earned surface variants, not separate light/dark modes.

The final rendered probe measured 8.01:1 for session help on the timer surface and 8.78:1 for freshness text on the page background. All measured entry-page text passed the probe's 4.5:1 normal / 3:1 large thresholds. These measurements do not establish contrast for every possible theme, hover state or assistive mode.

## Typography

Six declared steps in `:root`: `--text-small` .875rem, `--text-body` 1rem, `--text-heading` 1.5rem, `--text-title` 2rem, `--text-number` 3rem and `--text-timer` 4rem. At the default browser size these are 14, 16, 24, 32, 48 and 64px. The phone timer uses the number step. The final entry probe used five sizes at 390 and six including one-offs at 1440.

Body, controls and labels request `Segoe UI, sans-serif`; the brand, headings and timer request `Palatino, Georgia, serif`. System fallbacks are intentional; there are no downloaded fonts. Requested families are not proof that a particular font is installed. Weights are 400 and 700. Body line height is 1.5, headings 1.1–1.25, timer 1.15 and buttons 1.4. No tracked uppercase section labels are used. Changing counters use tabular numbers. Prose caps at 75ch, values wrap with `overflow-wrap: anywhere`, and inputs remain 1rem on phones.

## Layout

Shared primitives are `.row`, `.spread`, `.grid`, `.top`, `main` and `.clock`. Gaps use 4/8/12/16px according to grouping; surfaces use 20px padding, desktop timer/main use 24px and phone page margins use 16px. Main/footer cap at 1028px including padding; the header caps at 1320px.

The timer has a 1.15fr/1fr content/art split on wide screens. At 700px and below it becomes one column, with controls before a 150px artwork crop. The timer remains usable while chain data loads. Summary cards use two columns; room lists use three. Both collapse to one column at 700px. At 1000px and below navigation takes its own row; at 700px it becomes a three-column, two-row grid. Nothing depends on a horizontally scrolling nav.

An active room appears before the room list and receives heading focus when first joined. Public room browsing and private-room forms remain below it. Native dialog width is at most 520px or viewport minus 32px, with viewport-bounded vertical scrolling. All text containers can grow. Browser checks covered all views at 320, 390, 700 and 1440px, plus 200% text enlargement and an RTL stress check; native browser zoom and translated content were not tested.

## Elevation & Depth

The interface uses tonal layers, not card shadows. Outlines identify selected controls, input boundaries and keyboard focus. There are no cards nested inside cards, decorative gradients or floating panels over content. The auth dialog has a 70% black native backdrop. The timer artwork is visually dimmed for unavailable activity and desaturated for fresh idle activity; accompanying text always explains the state.

## Shapes

Timer radius 24px; summaries, rooms, banners and dialog 18px; inputs 12px; buttons use the existing pill shape. The image rounds only the outside timer corners appropriate to the current layout. There is no global clipping rule that hides long values or overflowing text.

## Components

| Pattern | Source | Behavior |
| --- | --- | --- |
| Main and secondary buttons | `public/styles.css`, `.ghost` | Lime primary; outlined secondary; 44px minimum height, wrapping labels, disabled busy state. Press scales to .96 over 120ms only when motion is allowed. |
| Navigation | `public/index.html`, `navigate`/`show` | Six preserved views, hash navigation/back-forward, visible selection and `aria-current`. Keyboard route changes focus the destination heading. |
| Focus timer | `.clock`, `paintSession`, `start` | 25/50/custom controls; deadline-based countdown; explicit cancellation confirmation; durable completion in the applicable storage mode. |
| Chain readout | `paintChain`, `public/chain.js` | Confirmed values separate from measurement and pending work; loading, unavailable, stale last-good, success and retry states. Source, safe block and transaction are available in a native details element. |
| Room panel | `enter`, `paintRoom`, `heartbeat` | Named participants, goal, focus text, messages, leave/focus controls. Updates poll every 4 seconds while visible; failures display alongside the panel. |
| Forms | Native labels/inputs/forms | Persistent labels, length/range hints, browser validity, visible status/errors; no placeholders used as labels. |
| Authentication | Native `dialog`, `openAuth`/`sendAuth` | Modal focus containment/Escape, restore trigger focus, busy/error states. Static mode explains account scope and hides credential fields. |
| Profile | `paintProfile`, `shareCard` | Personal/shared scope, XP/level/streak, earned/locked theme buttons with pressed state, badge states and a PNG download. Sign-out clears prior private content. |

Keyboard focus uses a 2px teal outline with 4px offset. There are no endless animations. Hover treatments are restricted to hover-capable pointers. Status is conveyed in words, never by color alone.

## Do's and Don'ts

Reuse the existing tokens, rows, grids, surface styles and native controls. New views should join the existing hash-navigation pattern and use a heading, short purpose line where needed, and the relevant controls before decorative media. Keep filled emphasis on the main action and use `.ghost` for alternatives.

Keep settlement values as validated decimal strings/BigInt; never turn missing data into zero. Keep device records, shared Focus XP and confirmed/provisional chain data distinct. Do not add sample users or fake room counts to fill empty space. Preserve the supplied artwork and the brand signature. Do not introduce a framework or wallet flow for read-only data.

Design review uses Better Interface (Jakub Krehel, MIT); documentation method adapts Impeccable (Paul Bakaus, Apache-2.0). Attribution and licenses are retained in `docs/design-guidance/`.
