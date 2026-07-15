// =============================================================================
// RM Cardz — JSON document store
// -----------------------------------------------------------------------------
// A tiny, dependency-free persistence layer. The whole application database is a
// single JSON document written atomically to disk. This is deliberately simple:
// the spec calls for SQLite in v1 (single-user internal tool) and Postgres only
// in v2. A plain JSON file gives us zero native dependencies — which keeps the
// cross-compiled Windows .exe build painless — and is more than fast enough for
// the ~112 customers / ~300 orders in a typical break event.
//
// The db.cjs layer sits on top of this and exposes domain operations; routes
// never touch the store directly.
// =============================================================================

const fs = require('node:fs')
const path = require('node:path')

/** The shape of a brand-new, empty database. */
function emptyState() {
  return {
    meta: {
      schemaVersion: 1,
      importedAt: null,
      event: { name: null, date: null },
      // Which league the current import was parsed as ('nfl' | 'mlb' | 'nba').
      // Drives the sport-aware fidelity audit (32 NFL, 30 MLB/NBA). Defaults NFL.
      sport: 'nfl',
      breaksPerEvent: 9,
    },
    users: [],
    breaks: [],
    teamSlots: [],
    customers: [],
    shipments: [],
    orders: [],
    batchUrls: [],
    parseJobs: {},
    warnings: [],
    // Per-break fidelity audit from the last import (teams captured vs the full
    // slate — 32 NFL / 30 MLB — missing teams, one-team-per-break collisions).
    // See server/parser/index.cjs. Surfaced read-only in the Checker tab.
    breakAudit: [],
    // Import history log (item 3) — one nameable entry per dataset upload
    // (PDF / shipping doc / demo). The operator names "what we are sorting and
    // shipping". Persists across re-imports, like snapshots and the user table.
    imports: [],
    // Saved daily snapshots of order + shipping data (History tab). Persist
    // across PDF re-imports, like the user table.
    snapshots: [],
    // Uploaded Whatnot ledger CSV (Sales Dashboard). { filename, uploadedAt,
    // rows:[classified], settings:{ breaksPerCase } } or null.
    ledger: null,
  }
}

class Store {
  /**
   * @param {string} dataDir - Directory to persist the JSON document in.
   * @param {string} [fileName='rmcardz-db.json']
   */
  constructor(dataDir, fileName = 'rmcardz-db.json') {
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
        this.state = { ...emptyState(), ...parsed, meta: { ...emptyState().meta, ...(parsed.meta || {}) } }
      }
    } catch (err) {
      // A corrupt file should not brick the app — start fresh but keep a backup.
      console.error('[store] Failed to load database, starting fresh:', err.message)
      try {
        if (fs.existsSync(this.filePath)) {
          fs.renameSync(this.filePath, `${this.filePath}.corrupt-${Date.now()}`)
        }
      } catch (_) { /* ignore */ }
      this.state = emptyState()
    }
  }

  /** Persist immediately and synchronously (used on shutdown). */
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

  /** Persist soon (debounced) — coalesces bursts of writes (e.g. fast tapping). */
  save() {
    if (this._saveTimer) return
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null
      try {
        this.saveNow()
      } catch (err) {
        console.error('[store] save failed:', err.message)
      }
    }, 250)
  }

  /** Replace the entire dataset (used after a successful PDF import). */
  replaceData(partial) {
    this.state = { ...this.state, ...partial }
    this.saveNow()
  }
}

module.exports = { Store, emptyState }
