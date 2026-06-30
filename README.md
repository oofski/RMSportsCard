# RM Cardz — Break Manager & Shipping Tracker

RM Cardz is a Windows desktop app for NFL sports-card break fulfillment for the
Whatnot seller `rm_cardz`. After a live break event, you parse Whatnot's
post-event PDF to load every break, team slot, customer, and shipment; run
pick-and-pack checklists to pull and box each customer's cards; and track the
resulting USPS shipments to delivery. It is fully self-contained — a single
packaged `.exe` with an embedded backend, a local JSON datastore, and no
external service dependencies.

## Features

**Parser**
- Whatnot PDF import (breaking-slip-first extraction, packing-slip supplements).
- NFL team-name normalization to the canonical 32 teams (exact match, then a
  Levenshtein ≤ 2 fuzzy fallback).
- USPS tracking URLs precomputed at import: single-package URLs plus batched
  bulk-lookup URLs (35 tracking numbers per batch).
- One-team-per-break validation warnings surfaced after import.

**Module A — Break Checklist**
- Per-break pick list with tap-to-check rows; checked rows sink to the bottom.
- "Mark as Packed" completion flow, plus mark all / clear all and search.
- Offline-tolerant checkoff buffered in localStorage with a sync indicator.

**Module B — Shipping Tracker**
- Manual status board with per-row and "Open All in USPS" batch launch.
- Copy-all tracking numbers, per-row notes, and a breaks/teams detail drawer.
- Exception highlighting and pinning to keep problem shipments visible.

**Overview Dashboard**
- Event totals (orders, revenue, customers) with per-break and per-shipment
  status rollups.

**Accounts**
- First-run admin bootstrap; bcrypt-hashed passwords; admin / staff / picker
  roles with admin-gated user management.

**Auto-Update**
- electron-updater background downloads with user-initiated install.

## Tech Stack

| Layer          | Technology                                              |
| -------------- | ------------------------------------------------------- |
| Desktop shell  | Electron 42                                             |
| UI             | React 19, Vite 8                                         |
| Backend        | Express 4 (embedded, `127.0.0.1`, ephemeral port)       |
| Datastore      | JSON document store in Electron `userData`              |
| PDF parsing    | pdf-parse                                                |
| Uploads        | multer                                                   |
| Auth           | bcryptjs (hashing), in-memory session tokens            |
| Auto-update    | electron-updater (GitHub Releases)                      |
| Packaging      | electron-builder (NSIS + portable), @electron/packager  |
| Tests          | Vitest                                                   |

## Architecture

```
              +-----------------------------------------------------+
              |              Electron main process (.exe)           |
              |                                                     |
  React       |   +-------------------+      +-------------------+  |
  renderer  --+-->|  embedded Express |----->|  JSON document    |  |
  (REST over  |   |  127.0.0.1        |      |  store            |  |
  localhost)  |   |  (ephemeral port) |      |  (in userData)    |  |
              |   +-------------------+      +-------------------+  |
              +-----------------------------------------------------+

  NO external API dependencies; USPS tracking opens in the user's browser.
```

The renderer learns the backend's ephemeral URL from a launch argument and
talks plain REST to it over localhost. The only privileged operations bridged
to the main process are opening USPS tracking URLs in the default browser,
reporting the app version, and driving the auto-update lifecycle.

## Getting Started

```sh
npm install      # install dependencies
npm run dev      # Vite renderer + Electron (development)
npm test         # run the Vitest suite
```

## Building the Windows .exe

```sh
# Runnable .exe, no wine required (works on Linux, macOS, or Windows):
npm run pack:win
#   -> release/RM Cardz-win32-x64/RM Cardz.exe

# Installer + portable build via electron-builder (needs Windows or wine):
npm run dist:win            # NSIS installer + portable .exe, no publish

# Build and publish a GitHub release that feeds auto-update:
npm run dist:win:publish
```

## Auto-update

The app uses electron-updater, which reads the `publish` block in
`electron-builder.yml` (GitHub provider, owner `oofski`, repo `rmsportscard`) to
find newer releases. Updates download in the background and install only when the
user clicks "Restart & Install". Publishing a release requires `GH_TOKEN` in the
build environment.

## Accounts

The first launch has no accounts, so the first registration creates the **admin**
account (no hard-coded default password). Admins add and manage users via the
Users dialog. All passwords are bcrypt-hashed. Each account has one of three
roles — admin, staff, or picker — and user management is gated to admins.

## Importing data

On the upload screen, either upload Whatnot's post-event PDF to parse the real
event, or click **Load demo data** to populate a realistic sample event (a
9-break demo dataset) so the app is immediately usable for evaluation, training,
and screenshots.
