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

You'll see something like:

```
  On this computer:   https://localhost:8787

  On your phone (same WiFi), open one of these:
      https://192.168.1.42:8787
```

1. On your computer, open the `localhost` URL to add items and print labels.
2. On your **phone** (same WiFi), open the `192.168.x.x` URL to scan.

### The certificate warning is expected

Phone browsers only allow the camera on a **secure connection**, so the server
serves HTTPS with a **self-signed certificate** it generates on first run. The
first time you open it, your phone will warn "Not secure / Not private" — tap
**Advanced → Proceed anyway**. This is normal for a local app and is required
for QR scanning to work. (On the computer itself, `localhost` is already trusted,
so scanning works there without any warning.)

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
