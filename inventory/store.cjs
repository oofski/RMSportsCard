// =============================================================================
// RM Cardz Inventory — JSON document store
// -----------------------------------------------------------------------------
// A tiny, dependency-free persistence layer for the standalone mobile inventory
// app. The whole inventory database is a single JSON document written
// atomically to disk. This mirrors the pattern used by the main app's
// server/store.cjs on purpose (same conventions, zero native dependencies), but
// is intentionally self-contained so the inventory app can run on its own with
// nothing more than `node inventory/server.cjs` — no npm install required.
//
// The db.cjs layer sits on top of this and exposes domain operations; the HTTP
// layer never touches the store directly.
// =============================================================================

const fs = require('node:fs')
const path = require('node:path')

/** The shape of a brand-new, empty inventory database. */
function emptyState() {
  return {
    meta: {
      schemaVersion: 1,
      createdAt: null,
    },
    // Inventory items. See db.cjs for the field shape.
    items: [],
    // Append-only audit log of quantity changes (stock in / out / adjust).
    movements: [],
  }
}

class Store {
  /**
   * @param {string} dataDir - Directory to persist the JSON document in.
   * @param {string} [fileName='inventory-db.json']
   */
  constructor(dataDir, fileName = 'inventory-db.json') {
    this.dataDir = dataDir
    this.filePath = path.join(dataDir, fileName)
    this.state = emptyState()
    this._saveTimer = null
    this._load()
  }

  _load() {
    try {
      fs.mkdirSync(this.dataDir, { recursive: true })
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, 'utf8')
        const parsed = JSON.parse(raw)
        // Merge onto a fresh empty state so older files missing newer keys
        // (forward migration) still load cleanly.
        this.state = {
          ...emptyState(),
          ...parsed,
          meta: { ...emptyState().meta, ...(parsed.meta || {}) },
        }
      } else {
        this.state.meta.createdAt = new Date().toISOString()
        this.saveNow()
      }
    } catch (err) {
      // A corrupt file should not brick the app — start fresh but keep a backup.
      console.error('[inventory/store] Failed to load database, starting fresh:', err.message)
      try {
        if (fs.existsSync(this.filePath)) {
          fs.renameSync(this.filePath, `${this.filePath}.corrupt-${Date.now()}`)
        }
      } catch (_) { /* ignore */ }
      this.state = emptyState()
    }
  }

  /** Persist immediately and synchronously (used on shutdown / in tests). */
  saveNow() {
    if (this._saveTimer) {
      clearTimeout(this._saveTimer)
      this._saveTimer = null
    }
    fs.mkdirSync(this.dataDir, { recursive: true })
    // Atomic write: write to a temp file then rename over the target so a crash
    // mid-write can never leave a half-written (corrupt) database.
    const tmp = `${this.filePath}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2), 'utf8')
    fs.renameSync(tmp, this.filePath)
  }

  /** Persist soon (debounced) — coalesces bursts of writes. */
  save() {
    if (this._saveTimer) return
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null
      try {
        this.saveNow()
      } catch (err) {
        console.error('[inventory/store] save failed:', err.message)
      }
    }, 200)
  }
}

module.exports = { Store, emptyState }
