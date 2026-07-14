// =============================================================================
// RM Cardz Inventory — Data access layer
// -----------------------------------------------------------------------------
// Domain operations on top of the JSON Store. The HTTP layer calls these; it
// never touches the raw store. Every mutation persists (debounced) automatically.
//
// Item shape:
//   {
//     id:          string   // internal id (uuid)
//     code:        string   // QR payload — unique; what the phone scans
//     name:        string
//     category:    string
//     quantity:    number    // integer >= 0
//     minQuantity: number    // low-stock threshold (0 = no alert)
//     price:       number    // unit value (optional)
//     location:    string    // e.g. "Shelf A3"
//     notes:       string
//     createdAt, updatedAt: ISO strings
//   }
//
// Movement (append-only audit log of quantity changes):
//   { id, itemId, code, name, delta, quantityAfter, reason, at }
// =============================================================================

const crypto = require('node:crypto')

const now = () => new Date().toISOString()
const uid = () => crypto.randomUUID()

/** Build an Error carrying an HTTP status so the router can map it to a response. */
function httpError(status, message) {
  const err = new Error(message)
  err.status = status
  return err
}

/** Characters used for generated item codes — no ambiguous 0/O/1/I/L. */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'

function toInt(value, fallback = 0) {
  const n = Math.trunc(Number(value))
  return Number.isFinite(n) ? n : fallback
}

function toMoney(value, fallback = 0) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.round(n * 100) / 100
}

function cleanStr(value, max = 500) {
  return String(value == null ? '' : value).trim().slice(0, max)
}

class Db {
  /** @param {import('./store.cjs').Store} store */
  constructor(store) {
    this.store = store
  }

  get state() {
    return this.store.state
  }

  // ---------------------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------------------

  /** All items, optionally filtered by a free-text query, sorted by name. */
  listItems({ q } = {}) {
    let items = this.state.items.slice()
    const needle = cleanStr(q).toLowerCase()
    if (needle) {
      items = items.filter((it) =>
        [it.code, it.name, it.category, it.location, it.notes]
          .filter(Boolean)
          .some((f) => String(f).toLowerCase().includes(needle)),
      )
    }
    return items.sort((a, b) =>
      (a.name || '').localeCompare(b.name || '', undefined, { sensitivity: 'base' }),
    )
  }

  getItem(id) {
    return this.state.items.find((it) => it.id === id) || null
  }

  /** Look up by scanned QR payload. Exact match first, then case-insensitive. */
  getItemByCode(code) {
    const c = cleanStr(code)
    if (!c) return null
    return (
      this.state.items.find((it) => it.code === c) ||
      this.state.items.find((it) => it.code.toLowerCase() === c.toLowerCase()) ||
      null
    )
  }

  listMovements(itemId, { limit = 100 } = {}) {
    return this.state.movements
      .filter((m) => m.itemId === itemId)
      .sort((a, b) => (a.at < b.at ? 1 : -1)) // newest first
      .slice(0, limit)
  }

  /** Roll-up numbers for the dashboard header. */
  stats() {
    const items = this.state.items
    const totalUnits = items.reduce((s, it) => s + toInt(it.quantity), 0)
    const totalValue = items.reduce(
      (s, it) => s + toInt(it.quantity) * toMoney(it.price),
      0,
    )
    const lowStock = items.filter(
      (it) => it.minQuantity > 0 && toInt(it.quantity) <= it.minQuantity,
    ).length
    const categories = [...new Set(items.map((it) => it.category).filter(Boolean))].sort()
    return {
      itemCount: items.length,
      totalUnits,
      totalValue: Math.round(totalValue * 100) / 100,
      lowStock,
      categories,
    }
  }

  // ---------------------------------------------------------------------------
  // Writes
  // ---------------------------------------------------------------------------

  /** Generate a short, unique, human-readable code not already in use. */
  generateCode(prefix = 'RM') {
    for (let attempt = 0; attempt < 50; attempt++) {
      let body = ''
      const bytes = crypto.randomBytes(6)
      for (let i = 0; i < 6; i++) body += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length]
      const code = `${prefix}-${body}`
      if (!this.getItemByCode(code)) return code
    }
    // Astronomically unlikely; fall back to a uuid slice.
    return `${prefix}-${uid().slice(0, 8).toUpperCase()}`
  }

  createItem(input = {}) {
    const name = cleanStr(input.name, 200)
    if (!name) throw httpError(400, 'Item name is required')

    let code = cleanStr(input.code, 200)
    if (code) {
      if (this.getItemByCode(code)) {
        throw httpError(409, `An item with code "${code}" already exists`)
      }
    } else {
      code = this.generateCode()
    }

    const quantity = Math.max(0, toInt(input.quantity, 0))
    const item = {
      id: uid(),
      code,
      name,
      category: cleanStr(input.category, 100),
      quantity,
      minQuantity: Math.max(0, toInt(input.minQuantity, 0)),
      price: Math.max(0, toMoney(input.price, 0)),
      location: cleanStr(input.location, 200),
      notes: cleanStr(input.notes, 1000),
      createdAt: now(),
      updatedAt: now(),
    }
    this.state.items.push(item)
    if (quantity > 0) {
      this._logMovement(item, quantity, quantity, 'Initial stock')
    }
    this.store.save()
    return item
  }

  updateItem(id, patch = {}) {
    const item = this.getItem(id)
    if (!item) throw httpError(404, 'Item not found')

    if (patch.name !== undefined) {
      const name = cleanStr(patch.name, 200)
      if (!name) throw httpError(400, 'Item name is required')
      item.name = name
    }
    if (patch.code !== undefined) {
      const code = cleanStr(patch.code, 200)
      if (!code) throw httpError(400, 'Item code cannot be empty')
      const clash = this.getItemByCode(code)
      if (clash && clash.id !== item.id) {
        throw httpError(409, `An item with code "${code}" already exists`)
      }
      item.code = code
    }
    if (patch.category !== undefined) item.category = cleanStr(patch.category, 100)
    if (patch.minQuantity !== undefined) item.minQuantity = Math.max(0, toInt(patch.minQuantity, 0))
    if (patch.price !== undefined) item.price = Math.max(0, toMoney(patch.price, 0))
    if (patch.location !== undefined) item.location = cleanStr(patch.location, 200)
    if (patch.notes !== undefined) item.notes = cleanStr(patch.notes, 1000)

    // A direct quantity edit is logged as an adjustment for the audit trail.
    if (patch.quantity !== undefined) {
      const target = Math.max(0, toInt(patch.quantity, item.quantity))
      const delta = target - item.quantity
      if (delta !== 0) {
        item.quantity = target
        this._logMovement(item, delta, target, cleanStr(patch.reason) || 'Manual edit')
      }
    }

    item.updatedAt = now()
    this.store.save()
    return item
  }

  /** Relative stock change (+ in, − out). Never drives quantity below zero. */
  adjustQuantity(id, delta, reason) {
    const item = this.getItem(id)
    if (!item) throw httpError(404, 'Item not found')
    const d = toInt(delta, 0)
    if (d === 0) throw httpError(400, 'Adjustment must be a non-zero whole number')

    const target = Math.max(0, item.quantity + d)
    const applied = target - item.quantity // may be smaller than d if it clamped at 0
    item.quantity = target
    item.updatedAt = now()
    if (applied !== 0) {
      this._logMovement(item, applied, target, cleanStr(reason) || (d > 0 ? 'Stock in' : 'Stock out'))
    }
    this.store.save()
    return item
  }

  deleteItem(id) {
    const idx = this.state.items.findIndex((it) => it.id === id)
    if (idx === -1) throw httpError(404, 'Item not found')
    const [removed] = this.state.items.splice(idx, 1)
    // Keep this item's movements as a historical record but tag them removed.
    this.store.save()
    return removed
  }

  _logMovement(item, delta, quantityAfter, reason) {
    this.state.movements.push({
      id: uid(),
      itemId: item.id,
      code: item.code,
      name: item.name,
      delta,
      quantityAfter,
      reason,
      at: now(),
    })
  }
}

module.exports = { Db, httpError }
