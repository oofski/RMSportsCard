# Changelog

All notable changes to RM Cardz — Break Manager & Shipping Tracker are documented
in this file. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
