# RM Cardz — Inventory Manager (mobile QR app)

A lightweight, phone-friendly inventory manager for the RM Cardz card business.
Stick a QR label on each box/lot, then **scan it with your phone** to instantly
see stock and adjust it (stock in / stock out) — no logging into the desktop app.

It lives in the same repo as the main RM Cardz desktop app but runs on its own:
a single **zero-dependency** Node server (built-in `http`/`https` only) that
serves a mobile web UI and a small JSON API on top of a local JSON file. Nothing
to `npm install`, no cloud, no accounts.

## Quick start

```sh
node inventory/server.cjs
# or:  npm run inventory
```

The terminal prints a **QR code** — just point your phone's camera at it to
open the app. No typing an IP address.

```
  On this computer:   https://localhost:8787

  ── Open on your phone (same WiFi) ─────────────────────────
  Point your phone camera at this QR code:

      █▀▀▀▀▀█ ▀▄▀ █▀▀▀▀▀█
      █ ███ █ ▀█▀ █ ███ █      (a real scannable QR renders here)
      █ ▀▀▀ █ ▀ ▀ █ ▀▀▀ █
      ▀▀▀▀▀▀▀ ▀ ▀ ▀▀▀▀▀▀▀

  …or open on this computer:   https://localhost:8787/connect
```

1. On your computer, open the `localhost` URL to add items and print labels.
2. To use your **phone**: scan the QR in the terminal, **or** open
   `https://localhost:8787/connect` on the computer for a bigger QR and
   step-by-step instructions, **or** tap the 📱 icon in the app header.

Prefer not to look at the terminal? The **/connect** page shows the QR plus the
exact taps for the one-time security prompt on iPhone and Android.

### The certificate warning (one-time)

Phone browsers only allow the camera on a **secure connection**, so the server
serves HTTPS with a **self-signed certificate** it generates on first run. The
first time you open it on a phone, you'll see a "Not secure / Not private"
warning — tap through it once (iPhone Safari: *Show Details → visit this
website*; Android Chrome: *Advanced → Proceed*). This is normal for a local app
and is required for QR scanning.

The certificate is generated **once and reused**, so you only accept it a single
time — it is *not* re-generated when your computer's IP changes. (On the computer
itself, `localhost` is already trusted, so there's no warning there.)

Want to never see the warning again? The **/connect** page has an *"Advanced:
remove the security warning permanently"* section that walks you through
installing the certificate as trusted on your phone (download link: `/cert`).

If you don't need phone scanning, run plain HTTP:

```sh
INVENTORY_HTTP=1 node inventory/server.cjs
```

## How you'll use it

1. **Add items** (Add tab): name, optional category, starting quantity, unit
   value, location, and a low-stock threshold. Leave the code blank to
   auto-generate one (e.g. `RM-7GK2QM`).
2. **Print labels** (Labels tab): prints a QR sheet. Stick one on each box/lot.
3. **Scan** (Scan tab): point your phone at a label → the item opens → tap
   **−/＋** to adjust stock, or use **Stock in / Stock out** for a bulk amount.
   Every change is logged with a timestamp.
4. Scanning an **unknown** code offers to create a new item with that code
   pre-filled — handy for labels you print elsewhere.

The QR label encodes just the item's code (not a URL), so labels keep working
even if your computer's IP address changes.

## Configuration

| Env var              | Default                | Purpose                                  |
| -------------------- | ---------------------- | ---------------------------------------- |
| `PORT`               | `8787`                 | Port to listen on                        |
| `INVENTORY_HTTP`     | _(unset)_              | Set to `1` to serve plain HTTP           |
| `INVENTORY_DATA_DIR` | `inventory/data/`      | Where the JSON db + cert are stored      |

Data (`inventory-db.json`) and the generated certificate live in the data dir,
which is git-ignored. Back up `inventory-db.json` to keep your inventory.

## REST API

All JSON. Useful if you want to script against it.

| Method & path                     | Description                                  |
| --------------------------------- | -------------------------------------------- |
| `GET /api/health`                 | `{ ok, itemCount }`                           |
| `GET /api/stats`                  | totals: items, units, value, low-stock, cats |
| `GET /api/items?q=`               | list / search items                          |
| `POST /api/items`                 | create `{ name, code?, category?, quantity?, price?, location?, minQuantity?, notes? }` |
| `GET /api/items/:id`              | one item                                     |
| `GET /api/items/by-code/:code`    | look up by scanned code (the scan path)      |
| `PATCH /api/items/:id`            | update fields                                |
| `POST /api/items/:id/adjust`      | `{ delta, reason? }` — stock in/out (won't go below 0) |
| `GET /api/items/:id/movements`    | quantity change history                      |
| `DELETE /api/items/:id`           | remove an item                               |

## Tests

Part of the repo's Vitest suite:

```sh
npm test               # runs everything, including test/inventory.test.js
```

## Notes

- **Self-contained:** no external services; QR libraries are vendored locally
  (`public/vendor/`, MIT-licensed — see `LICENSES.md`).
- **Not exposed to the internet:** it binds to your LAN. Keep it on a trusted
  network; there's no authentication (single-operator tool, like the desktop app).
