# Changelog

All notable changes to RM Cardz — Break Manager & Shipping Tracker are documented
in this file. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
