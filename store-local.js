/* =============================================================================
   RM Cardz Inventory — client-side data store (no backend)
   -----------------------------------------------------------------------------
   Lets the exact same app.js run as a pure static website (e.g. GitHub Pages)
   with no server: data is kept in the browser's localStorage. It exposes a
   REST-style router that mirrors inventory/server.cjs, so app.js talks to it
   the same way it talks to the real API. app.js auto-detects which to use.
   ============================================================================= */
(function () {
  'use strict'

  var KEY = 'rmcardz-inventory-v1'
  var CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789' // no ambiguous 0/O/1/I/L

  function nowIso() { return new Date().toISOString() }
  function uid() {
    if (window.crypto && typeof crypto.randomUUID === 'function') {
      try { return crypto.randomUUID() } catch (e) { /* fall through */ }
    }
    return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10)
  }
  function toInt(v, d) { var n = Math.trunc(Number(v)); return Number.isFinite(n) ? n : (d || 0) }
  function toMoney(v, d) { var n = Number(v); if (!Number.isFinite(n)) return d || 0; return Math.round(n * 100) / 100 }
  function cleanStr(v, max) { return String(v == null ? '' : v).trim().slice(0, max || 500) }
  function blank() { return { meta: { schemaVersion: 1, createdAt: nowIso() }, items: [], movements: [] } }
  function err(status, message) { var e = new Error(message); e.status = status; return e }

  var state
  try { state = JSON.parse(localStorage.getItem(KEY)) } catch (e) { state = null }
  if (!state || !Array.isArray(state.items)) state = blank()
  function save() { try { localStorage.setItem(KEY, JSON.stringify(state)) } catch (e) { /* quota */ } }

  function getItem(id) { return state.items.find(function (it) { return it.id === id }) || null }
  function getItemByCode(code) {
    var c = cleanStr(code); if (!c) return null
    return state.items.find(function (it) { return it.code === c }) ||
      state.items.find(function (it) { return it.code.toLowerCase() === c.toLowerCase() }) || null
  }
  function generateCode() {
    for (var a = 0; a < 50; a++) {
      var body = ''
      for (var i = 0; i < 6; i++) body += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)]
      var code = 'RM-' + body
      if (!getItemByCode(code)) return code
    }
    return 'RM-' + uid().slice(0, 8).toUpperCase()
  }
  function logMovement(item, delta, qAfter, reason) {
    state.movements.push({ id: uid(), itemId: item.id, code: item.code, name: item.name, delta: delta, quantityAfter: qAfter, reason: reason, at: nowIso() })
  }

  function listItems(q) {
    var items = state.items.slice()
    var needle = cleanStr(q).toLowerCase()
    if (needle) {
      items = items.filter(function (it) {
        return [it.code, it.name, it.category, it.location, it.notes].filter(Boolean)
          .some(function (f) { return String(f).toLowerCase().indexOf(needle) >= 0 })
      })
    }
    return items.sort(function (a, b) { return (a.name || '').localeCompare(b.name || '', undefined, { sensitivity: 'base' }) })
  }
  function listMovements(itemId, limit) {
    return state.movements.filter(function (m) { return m.itemId === itemId })
      .sort(function (a, b) { return a.at < b.at ? 1 : -1 }).slice(0, limit || 100)
  }
  function stats() {
    var items = state.items
    var totalUnits = items.reduce(function (s, it) { return s + toInt(it.quantity) }, 0)
    var totalValue = items.reduce(function (s, it) { return s + toInt(it.quantity) * toMoney(it.price) }, 0)
    var lowStock = items.filter(function (it) { return it.minQuantity > 0 && toInt(it.quantity) <= it.minQuantity }).length
    var categories = Array.from(new Set(items.map(function (it) { return it.category }).filter(Boolean))).sort()
    return { itemCount: items.length, totalUnits: totalUnits, totalValue: Math.round(totalValue * 100) / 100, lowStock: lowStock, categories: categories }
  }

  function createItem(input) {
    input = input || {}
    var name = cleanStr(input.name, 200); if (!name) throw err(400, 'Item name is required')
    var code = cleanStr(input.code, 200)
    if (code) { if (getItemByCode(code)) throw err(409, 'An item with code "' + code + '" already exists') }
    else { code = generateCode() }
    var quantity = Math.max(0, toInt(input.quantity, 0))
    var item = {
      id: uid(), code: code, name: name, category: cleanStr(input.category, 100),
      quantity: quantity, minQuantity: Math.max(0, toInt(input.minQuantity, 0)),
      price: Math.max(0, toMoney(input.price, 0)), location: cleanStr(input.location, 200),
      notes: cleanStr(input.notes, 1000), createdAt: nowIso(), updatedAt: nowIso(),
    }
    state.items.push(item)
    if (quantity > 0) logMovement(item, quantity, quantity, 'Initial stock')
    save(); return item
  }
  function updateItem(id, patch) {
    patch = patch || {}
    var item = getItem(id); if (!item) throw err(404, 'Item not found')
    if (patch.name !== undefined) { var nm = cleanStr(patch.name, 200); if (!nm) throw err(400, 'Item name is required'); item.name = nm }
    if (patch.code !== undefined) {
      var cd = cleanStr(patch.code, 200); if (!cd) throw err(400, 'Item code cannot be empty')
      var clash = getItemByCode(cd); if (clash && clash.id !== item.id) throw err(409, 'An item with code "' + cd + '" already exists')
      item.code = cd
    }
    if (patch.category !== undefined) item.category = cleanStr(patch.category, 100)
    if (patch.minQuantity !== undefined) item.minQuantity = Math.max(0, toInt(patch.minQuantity, 0))
    if (patch.price !== undefined) item.price = Math.max(0, toMoney(patch.price, 0))
    if (patch.location !== undefined) item.location = cleanStr(patch.location, 200)
    if (patch.notes !== undefined) item.notes = cleanStr(patch.notes, 1000)
    if (patch.quantity !== undefined) {
      var target = Math.max(0, toInt(patch.quantity, item.quantity)); var delta = target - item.quantity
      if (delta !== 0) { item.quantity = target; logMovement(item, delta, target, cleanStr(patch.reason) || 'Manual edit') }
    }
    item.updatedAt = nowIso(); save(); return item
  }
  function adjustQuantity(id, delta, reason) {
    var item = getItem(id); if (!item) throw err(404, 'Item not found')
    var d = toInt(delta, 0); if (d === 0) throw err(400, 'Adjustment must be a non-zero whole number')
    var target = Math.max(0, item.quantity + d); var applied = target - item.quantity
    item.quantity = target; item.updatedAt = nowIso()
    if (applied !== 0) logMovement(item, applied, target, cleanStr(reason) || (d > 0 ? 'Stock in' : 'Stock out'))
    save(); return item
  }
  function deleteItem(id) {
    var idx = state.items.findIndex(function (it) { return it.id === id }); if (idx === -1) throw err(404, 'Item not found')
    var removed = state.items.splice(idx, 1)[0]; save(); return removed
  }

  // REST-style router mirroring server.cjs handleApi(). Paths are WITHOUT the
  // '/api' prefix (app.js passes '/items', '/stats', etc.). Returns a Promise.
  function route(method, path, body) {
    return new Promise(function (resolve, reject) {
      try {
        var query = ''
        var qi = path.indexOf('?')
        if (qi >= 0) { query = path.slice(qi + 1); path = path.slice(0, qi) }
        var seg = path.split('/').filter(Boolean)
        var res

        if (seg[0] === 'health') res = { ok: true, itemCount: state.items.length }
        else if (seg[0] === 'stats') res = stats()
        else if (seg[0] === 'connect-info') res = { scheme: 'local', port: '', urls: [] }
        else if (seg[0] === 'items') {
          if (seg.length === 1) {
            if (method === 'GET') res = listItems(new URLSearchParams(query).get('q'))
            else if (method === 'POST') res = createItem(body)
          } else if (seg.length === 3 && seg[1] === 'by-code' && method === 'GET') {
            var found = getItemByCode(decodeURIComponent(seg[2]))
            if (!found) throw err(404, 'No item with that code')
            res = found
          } else if (seg.length === 2) {
            if (method === 'GET') { var g = getItem(seg[1]); if (!g) throw err(404, 'Item not found'); res = g }
            else if (method === 'PATCH') res = updateItem(seg[1], body)
            else if (method === 'DELETE') { deleteItem(seg[1]); res = { ok: true } }
          } else if (seg.length === 3 && seg[2] === 'adjust' && method === 'POST') {
            res = adjustQuantity(seg[1], body && body.delta, body && body.reason)
          } else if (seg.length === 3 && seg[2] === 'movements' && method === 'GET') {
            if (!getItem(seg[1])) throw err(404, 'Item not found')
            res = listMovements(seg[1])
          }
        }
        if (res === undefined) throw err(404, 'Unknown route')
        resolve(res)
      } catch (e) { reject(e) }
    })
  }

  window.InventoryLocal = {
    route: route,
    dump: function () { return JSON.stringify(state, null, 2) },
    replace: function (json) {
      var s = typeof json === 'string' ? JSON.parse(json) : json
      if (!s || !Array.isArray(s.items)) throw new Error('That file is not a valid inventory backup')
      state = { meta: s.meta || blank().meta, items: s.items, movements: Array.isArray(s.movements) ? s.movements : [] }
      save()
    },
    reset: function () { state = blank(); save() },
  }
})()
