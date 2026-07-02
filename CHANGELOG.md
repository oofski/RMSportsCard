# Changelog

All notable changes to RM Cardz — Break Manager & Shipping Tracker are documented
in this file. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.5.10] - 2026-07-02

### Changed — UI polish: calmer, more professional look
The interface read as "AI-generated" — emoji in every heading and button, shouty
UPPERCASE labels, gradient bars, pill-shaped everything. A full visual pass:
- **All emoji removed** from headings, buttons, banners, badges and status pills.
  Sidebar navigation now uses crisp line icons; statuses show a small colored dot
  + label instead of an emoji.
- **Quieter typography** — smaller, lighter headings; sentence-case stat labels
  ("Net revenue", not "NET REVENUE"); tabular numerals so money columns line up.
- **Flatter, cleaner charts** — thin solid-blue progress/revenue bars (no
  gradients or borders), softer badge tints, rectangular chips instead of pills,
  hairline borders instead of drop shadows.
- Copy cleanup ("Break #1 complete" instead of "🎉 Break #1 Complete!") and
  visible keyboard-focus outlines throughout. Both dark and light themes updated.
No functional changes — every button, filter, and workflow behaves exactly as before.

## [1.5.9] - 2026-07-01

### Changed — Sales Dashboard redesigned around what the ledger actually is
A data analysis of a real ledger showed the dashboard was framing everything as
"per break / per case", so a THIRD of revenue (cases, boxes, random breaks) fell
into a scary "Unattributed" bucket and the most useful cut — which product makes
the money — wasn't shown at all. Rebuilt the dashboard to match the real business:
- **Revenue by Product** is now the hero view — e.g. Cosmic Chrome ~65% of gross,
  with a clean short product name, share %, sale count and average. (A new
  product-family labeler fixes messy names like "2025" → "Panini Signature".)
- **Sale-type mix** replaces "Unattributed": **Team breaks / Cases / Hobby boxes /
  Random-team breaks**, each with revenue and % — real categories, not an error.
- **Costs & Extras** summarizes the leakage in one place: giveaways, shipping
  subsidies (money in), platform fees (money out), and tips.
- **Revenue by Day** drill-down now breaks the day down **by product** and
  reconciles exactly to the day's gross.
- The old per-break table + per-case control are kept but demoted to a
  **collapsible "Team-break detail"** section, so the headline stays clean.
- Net/gross/giveaway totals, the date range, and per-case math are unchanged
  (verified against the real ledger: net $117,276.39 / gross $117,979.41).

## [1.5.8] - 2026-07-01

### Added / Changed — RM SPORTSCARDS rebrand + Sales Dashboard depth + admin recovery
- **New RM SPORTSCARDS branding.** A new blue-circle "RM SPORTSCARDS" logo is the
  app icon (installer, taskbar, window) and appears in-app on the sign-in card,
  sidebar, loading screen and dashboard header. The whole UI accent shifts from
  cyan to the brand **royal blue** (with a lighter shade on the dark theme for
  contrast).
- **Reset admin from the sign-in screen.** If you're locked out, the sign-in
  screen now has a "Forgot password? Reset admin" recovery: a two-step confirm
  clears the accounts and returns the app to first-run setup so you can create a
  fresh admin, exactly like a new install. (Local app only — it never leaves your
  machine, and requires an explicit confirmation.)
- **Sales Dashboard breaks now show the pack + date.** Instead of a bare
  "Break 8", each break reads **"Break 8 · Cosmic Chrome · Jun 28"** — the
  simplified pack name and the day — so the same break number on different days
  is no longer merged together.
- **Per-day revenue drill-down.** Each "Revenue by Day" row expands to show what
  made up that day's revenue: every break/pack contribution **plus an
  "Unattributed sales" bucket, so the breakdown reconciles to the day's gross**
  (no more "where did the rest of the day's revenue go?").
- Revenue/giveaway/payout totals, the date range, and per-case math are
  unchanged — verified against a real ledger export.

## [1.5.7] - 2026-06-30

### Fixed — USPS auto-check no longer stalls after the first ~20 packages
USPS rate-limits the keyless scraper: after roughly 20 lookups in one session it
starts serving bot-challenge pages, so a big event would update the first ~20 and
then keep "checking" without updating the rest. The scraper now works *with* that
limit instead of against it:
- **Stale-first rotation.** Each scraper run reads a safe batch (16) of the
  packages **most in need of an update** (least-recently-checked first), then the
  background auto-checks rotate through the rest over the next runs — so every
  package gets covered without tripping the block.
- **Final packages are skipped.** Delivered/returned packages aren't re-checked,
  so the budget goes to packages whose status can still change.
- **Honest messaging.** A refresh now says e.g. "Checked the 16 most in need of an
  update … the remaining N update automatically on the next background checks" so
  a partial batch reads as expected progress, not a failure.
- **17TRACK is unaffected** by the cap — with a free key, every package updates in
  one pass (no scraping, no block). This remains the recommended setup for large
  events.

## [1.5.6] - 2026-06-30

### Fixed / Added — shipping status now updates the board LIVE
The Shipping tab was only as fresh as your last manual click, and the screen
never re-read saved statuses, so live tracking "didn't report back." Reworked:
- **Background auto-check.** The desktop app now re-checks USPS on its own on a
  schedule you choose (Settings → "Auto-check USPS in the background": Off / 15 /
  30 / 60 / 120 min, default 30) and updates the board automatically — no button
  press needed. Background and manual checks are de-duplicated so they never
  scrape the same packages at once.
- **The board stays live.** The Shipping list now re-pulls saved statuses every
  few seconds and refreshes the instant any sync finishes, so a status that
  changed in the background (or on another screen) shows up here right away.
- **Freshness is visible.** A "🛰️ Last USPS check: 3m ago" line shows exactly how
  current the data is and whether background checks are on — no more guessing
  whether a status is stale.
- Reminder surfaced in-app: USPS may block the keyless scraper, so for reliable
  background updates add a free **17TRACK** key (Settings → Status source).

## [1.5.5] - 2026-06-30

### Fixed — Break Slip parsing now reads MULTI-PAGE breaking slips (the real bug)
Tested against a real Whatnot export, the v1.5.4 fix still lost teams. Root cause,
now fixed: **a customer's Breaking Slip spans several physical pages, and Whatnot
does not repeat the "Whatnot - Breaking Slip" header on the continuation pages.**
- The page grouper treated those header-less continuation pages as junk and
  **dropped them entirely**, so every break/team after the first page vanished.
  Now a header-less page is recognized as a continuation and attached to the
  right customer.
- A break whose **"Break #N" header was on one page but whose teams continued on
  the next** lost those teams (the section pointer reset at each page boundary).
  The pointer now carries across pages, so a split break stays whole.

On the real sample this takes a customer who bought **6 cards across breaks
1 / 4 / 5** from showing **1 team** to showing **all 6**, and restores the breaks
(2, 4, 5) and team slots that were previously missing — the parser now reconstructs
every customer's full per-break team list. Verified end-to-end against the actual
export (6 customers, breaks 1/2/4/5, 14 team slots, no false collisions).

## [1.5.4] - 2026-06-30

### Fixed — USPS auto-tracking: "in transit" no longer shows as "Not Shipped"
A multi-agent investigation found packages that had actually shipped were stuck
on **Not Shipped**, while label-created ones read correctly. Root causes, all
fixed:
- **Packing froze the status.** Marking an order picked/packed in the Orders
  queue stamped a *human* "not shipped", and the "manual is truth" rule then
  refused to let auto-tracking advance it. Now a genuine carrier scan may move a
  **pre-ship** row (not shipped / label created) **forward** into a shipping
  state — while a status you deliberately set (delivered, returned, exception)
  stays protected.
- **The scraper locked itself out.** The default USPS reader's own writes were
  mistakenly treated as "manual", so it could only update a package once. Its
  writes are now recognized as automatic.
- **Modern USPS wording wasn't recognized.** "Arriving On Time / Late", "moving
  within the USPS network", "Package received", "Forwarded" and similar now map
  to In Transit; the "…on track to be delivered…" promise is no longer misread
  as Delivered. The reader also now combines the status headline with its detail
  line, so "In Transit" is caught even when the headline is just a delivery date.

### Added / Fixed — Break Slip team fidelity + multi-card alarm
- **No more silently lost teams.** The per-customer **Break Slip** is the ground
  truth for which teams each customer won in which break. The parser is now
  tolerant of real-world export variations — header wording ("Break Slip" vs
  "Breaking Slip"), letter case, and the pick checkbox rendering as underscores,
  a box glyph, or nothing at all — and will **recover a team by name** even when
  its checkbox didn't survive the PDF text extraction. Customers in multiple
  breaks are kept cleanly separated.
- **Fidelity is now visible.** Each break shows how many of the full **32 NFL
  teams** were captured, lists which are **missing**, and raises a **🔴 alarm**
  if the same team was sold to two customers in one break (one team = one
  customer per break).
- **Multi-card alarm.** Any customer with more than one card across their breaks
  gets a **⚠️ N cards** badge on the Orders list, so the packer double-checks
  nothing is missed.

## [1.5.3] - 2026-06-30

### Added — Sales Dashboard runs on your Whatnot ledger CSV
The **Sales Dashboard** tab is now driven by an uploaded Whatnot **Ledger** CSV
export (the per-transaction earnings/giveaway/payout sheet). Drop the file in and
it parses, classifies, and rolls up every row:
- **Date range auto-set** from the counted rows (earnings + giveaways) — payout,
  tip and adjustment rows never stretch the window.
- **Headline revenue:** **Net Revenue** (gross earnings **minus** giveaways),
  **Gross**, **Given Away** (shown in red), and the sales count.
- **Revenue per day** as a scaled bar list, plus **revenue per break** and
  **per case** — case size defaults to **9 breaks** and is adjustable inline,
  recomputing the case rollups on the fly.
- **Giveaways analyzed:** total money given away is tallied separately and netted
  out of revenue, so you see exactly what the freebies cost.
- **Stripe payout withdrawals are ignored** entirely — they're counted for
  reference but never touch any revenue, giveaway, or date figure.
- **Shipping subsidies and tips are shown separately and excluded** from revenue.
- **Top breaks** table and an **unattributed** line for earnings with no
  `Break #N`, plus a warnings panel for any rows that needed repair on import.
- Built to survive real exports: BOM handling, `$1,234.56`/`-$x` amount parsing,
  case-insensitive `Break #N` grouping, and repair of malformed (>8-column) rows
  so stray text can't leak into the transaction-type column.

### Fixed
- Negative currency now renders as **`-$703.02`** (sign before the dollar sign),
  not `$-703.02`, on the Given Away stat and any negative per-day net.
- Per-day revenue bars clamp at 0% so a net-negative day can't produce an invalid
  negative bar width.

## [1.5.2] - 2026-06-30

### Changed — streamlined, less clunky
- **Merged Order Tracking + Order Manager into one "Orders" tab.** Each order is
  a clean row (customer + status); **tap it to drop down the teams as a
  click-to-check packing checklist** (grouped by break, with per-break progress).
  Secondary actions (hold, reorder, USPS, set-status) are tucked into the
  drop-down instead of cluttering the row.
- **Fewer tabs:** Orders · Checker · Shipping Tracker · Sales Dashboard · History.
  Archived the **Whatnot Orders** and **Overview** tabs from the nav (their data
  still lives in Sales Dashboard and History/CSV).
- **Visual polish:** softer card shadows, roomier spacing, larger team checkboxes
  with a positive green "packed" state (no more strike-through), and calmer,
  legible status pills (a tint of the stage color) in both light and dark.

### Added
- New **History** tab: save a dated snapshot of the current event's order +
  shipping data so you can go back and check it later, and **export to CSV on
  disk** (native Save dialog in the desktop app). Two exports per source —
  Orders and USPS Shipping — for either the live data or any saved snapshot.
  Snapshots persist across PDF re-imports.

## [1.5.0] - 2026-06-30

### Fixed / Added — USPS auto-tracking (it now actually works)
A multi-agent analysis found the old auto-tracking failed because the keyless
USPS scrape hit Akamai's bot wall and silently reported "0 updated." Rework:
- **Pluggable tracking provider** (Settings → "USPS auto-tracking"):
  - **17TRACK API (recommended, reliable):** paste a free Access Key and the app
    uses structured statuses by tracking number — no scraping, no Mailer ID.
  - **Auto-read from USPS (default, no key):** a hardened best-effort scraper —
    one reused window with a persistent warmed session, usps.com warm-up,
    consistent UA + Accept-Language, sequential + jittered requests, status-banner
    selector-polling, and explicit Akamai challenge detection (stops early instead
    of hammering).
- **Honest results:** the refresh now reports "Updated X · read Y/N · Z blocked"
  instead of a fake "0 updated"; reading 0 statuses points you to add a 17TRACK key.
- See `docs/USPS_TRACKING.md` for the full analysis, options, and plan.

## [1.4.0] - 2026-06-30

### Added
- New **Order Tracking** tab — a simple, read-only overview of every order: the
  order name (customer), its status, and each break with the teams in it. No
  controls, just an at-a-glance view; it refreshes itself every few seconds.
  It's now the default landing tab.

### Changed
- The full interactive order queue (advance/Done, hold, reorder, USPS auto-update,
  per-team pick) is now the **Order Manager** tab (🗂), kept separate from the
  simple Order Tracking view.

## [1.3.1] - 2026-06-30

### Fixed — auto-update
- **Auto-update now has a feed.** The app was configured to check GitHub
  *Releases*, but no Releases are ever published from the build environment
  (tag/release pushes are blocked), so the updater had nothing to find. Switched
  electron-updater to a **generic feed served from the committed `/dist` folder**
  over the GitHub raw CDN — the same place each installer + `latest.yml` is
  published. From this version on, installed apps will detect and download new
  versions automatically. (Builds before 1.3.1 had the old, empty GitHub-Releases
  feed embedded and won't self-update; install 1.3.1 once to get the working feed.)

## [1.3.0] - 2026-06-30

### Changed — navigation
- Moved the top tab bar to a **collapsible left sidebar**. Click « / » to collapse
  it to an icon-only rail (or expand it back); the choice is remembered between
  sessions. Account actions (Upload New PDF, theme, Settings, Users, Sign out,
  version) now live in the sidebar footer.

### Changed — Planner
- Reworked the order queue into a **simpler, scannable list**. Each order is now a
  compact row — status pill, customer, breaks/picked-progress/tracking at a glance,
  one **✓ Done →** button, and a compact stage dropdown — instead of a card full of
  buttons. Hold/resume, reorder, USPS, and the per-team pick checkboxes moved into a
  per-row ▾ expander. All previous behavior is preserved.

### Notes
- This release is UI-only; no API or data changes.

### Added
- **Light / dark mode** toggle in the top bar, remembered between sessions.
- **Whatnot Orders** tab/module: searchable, filterable table of every order
  line item (order id, customer, break, team, price, paid/giveaway).
- **Whatnot Sales Dashboard** tab: revenue/orders/avg-order-value/giveaways,
  revenue-by-break bars, top teams, and top customers.
- Planner **Reset queue** button (restores the default order) and a one-click
  **✓ Done** per order that advances it to the next stage and drops it out of
  the active view — no need to keep the whole card open.
- New **Label Created** shipment status (USPS pre-shipment) in the status
  dropdown and summaries.

### Changed
- Automatic USPS status is now **much faster**: lookups run through a pool of
  hidden windows concurrently (≈6 at a time) instead of one-at-a-time, and the
  per-page wait was trimmed. Still no API key.

### Fixed
- `moveOrder` now reorders orders as they're displayed (held rows excluded),
  matching what you see.

## [1.1.1] - 2026-06-30

### Fixed
- `pack:win` no longer hard-codes `--app-version=1.0.0` — the packaged build now
  takes its version from package.json, so the no-wine path stamps the correct
  version.
- `pack:win` now ignores `dist/` so the bundled installers aren't packed into
  the app payload.

### Build
- Republished the downloadable Windows installer as
  `dist/RM-Cardz-Setup-1.1.1.exe` (carries all v1.1.0 features).

## [1.1.0] - 2026-06-30

Reworks fulfillment around the order, adds a planner/checker split, and makes
USPS delivery status automatic.

### Added — Planner (Order Queue)
- New order-centric **Planner** view: one card per customer order (package),
  showing that order's breaks + teams, with a four-step pipeline the planner
  clicks through — **To Pick → Put Together → Sent → All Good**.
- **Hold/Pause** an order (e.g. waiting on a break that isn't opened yet); held
  orders sink to the bottom of the queue with an optional reason.
- **Move up / down** to manually reorder the queue (within active vs. held).
- Per-order team checkboxes (shared pick detail with the Checker view) and a
  live pick-progress bar; filter chips by stage / flagged / held + search.

### Changed — two roles
- The per-break checklist is now the **Checker** view (check off which cards are
  present from each break); the new **Planner** view handles per-order assembly.
  Tabs are now Planner · Checker · Shipping Tracker · Overview.
- "Sent" and "All Good" in the Planner write the shipment's status, so the
  Shipping Tracker stays in sync — one source of truth.

### Added — automatic USPS status (no API key)
- **Auto-update status (USPS)** button in the Shipping Tracker and Planner: the
  Electron main process loads each tracking page in a hidden Chromium window and
  reads the live status (Delivered / In Transit / Out for Delivery / Exception /
  Returned), updating the board automatically (stamped setBy "auto"). No API key
  or signup; best-effort with manual fallback. (Runs in the desktop app.)

### Fixed
- electron-builder NSIS and portable targets had the same artifactName and
  collided; they're now `Setup-*` and `Portable-*`.

## [1.0.0] - 2026-06-30

First public release: a self-contained Windows desktop app for fulfilling NFL
sports-card breaks sold on Whatnot by `rm_cardz` — parse the post-event PDF, run
pick-and-pack checklists, and track USPS shipments.

### Added
- Single-page app with a two-module tabbed shell (Break Checklist + Shipping
  Tracker) plus an operations Overview dashboard.
- Auth gate then data gate flow: log in (or bootstrap an admin on first run),
  import an event, then work the two modules.
- Overview dashboard summarizing the event: order/revenue/customer counts,
  per-break status rollups, and shipping-status rollups.
- Self-contained runtime — the Electron main process boots an embedded Express
  backend on an ephemeral `127.0.0.1` port and the React renderer talks REST to
  it over localhost; no external services.
- "Load demo data" seed that populates a realistic 9-break sample event (same
  shape the PDF parser emits) for evaluation, training, and screenshots.

### Parser
- Whatnot PDF parser (`pdf-parse`) using a breaking-slip-first extraction
  strategy, with packing-slip pages supplementing customer/address details.
- USPS tracking URLs precomputed at import time: a single-package
  `Open in USPS` URL per shipment plus batched bulk-lookup URLs grouped 35
  tracking numbers per batch (comma-joined).
- NFL team-name normalization: snap each extracted name to the canonical
  32-team list via a case- and punctuation-insensitive match, then a
  Levenshtein edit-distance (≤ 2) fuzzy fallback.
- One-team-per-break validation that emits warnings (with page and raw text)
  for anomalies surfaced after import.

### Module A — Break Checklist
- Per-break pick list with tap-to-check team rows; checked rows sink to the
  bottom while unchecked rows stay on top for the picker.
- Completion flow: an explicit "Mark as Packed" action per break, distinct from
  per-row checkoff progress.
- Mark all / clear all controls and per-list search.
- Offline-tolerant checkoff: changes buffer to localStorage and sync to the
  backend, with a sync-status indicator.
- Checkoff attribution records who checked each slot and when.

### Module B — Shipping Tracker
- Manual status board for every shipment with editable per-shipment status.
- Per-row `Open in USPS` launch plus an `Open All in USPS` batch launch that
  opens the precomputed 35-per-batch bulk URLs.
- Copy-all of every tracking number to the clipboard.
- Per-row notes and a detail drawer showing the customer's breaks and teams.
- Exception highlighting (and pinning) for shipments in exception/returned
  states so problems stay visible.

### Accounts & Security
- First-run admin bootstrap: with no accounts present, the first registration
  becomes the admin — no hard-coded default password.
- bcrypt-hashed (`bcryptjs`) account passwords; opaque in-memory session tokens.
- Three roles — admin, staff, picker — with user management gated to admins;
  the last remaining admin cannot be deleted.

### Auto-Update
- electron-updater auto-update against GitHub Releases: new versions download in
  the background and install only when the user clicks "Restart & Install".

### Build & Packaging
- Windows distributables via electron-builder: an NSIS installer (configurable
  install dir, desktop + start-menu shortcuts) and a single-file portable `.exe`.
- No-wine packaging path via `@electron/packager` (`npm run pack:win`) that
  produces a runnable `.exe` from Linux/macOS/Windows without wine.
- `npm run dist:win:publish` builds and publishes a GitHub release that feeds the
  auto-updater.

[Unreleased]: https://github.com/oofski/rmsportscard/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/oofski/rmsportscard/releases/tag/v1.0.0
