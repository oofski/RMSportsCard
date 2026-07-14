// Integration tests for the standalone Inventory app (inventory/server.cjs).
// We boot the server on an ephemeral HTTP port (no cert needed) against a temp
// data dir and drive it with global fetch — same pattern as test/api.test.js.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

const require = createRequire(import.meta.url)
const { start, terminalQr } = require('../inventory/server.cjs')

let handle
let base

function api(p, opts = {}) {
  return fetch(base + p, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
  })
}
const json = (p, opts) => api(p, opts).then((r) => r.json())

beforeAll(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rmcardz-inv-test-'))
  handle = await start({ port: 0, host: '127.0.0.1', dataDir, useHttps: false })
  base = `http://127.0.0.1:${handle.port}`
})

afterAll(async () => {
  if (handle) await handle.close()
})

describe('health & empty state', () => {
  it('reports healthy with zero items', async () => {
    const d = await json('/api/health')
    expect(d.ok).toBe(true)
    expect(d.itemCount).toBe(0)
  })

  it('serves the SPA shell at /', async () => {
    const r = await fetch(base + '/')
    expect(r.status).toBe(200)
    expect(r.headers.get('content-type')).toMatch(/text\/html/)
    expect(await r.text()).toContain('RM Cardz')
  })
})

describe('phone connect helpers', () => {
  it('reports LAN URLs for the /connect page', async () => {
    const d = await json('/api/connect-info')
    expect(d.scheme).toBe('http') // this test runs over plain HTTP
    expect(Array.isArray(d.urls)).toBe(true)
  })

  it('serves the /connect helper page', async () => {
    const r = await fetch(base + '/connect')
    expect(r.status).toBe(200)
    expect(await r.text()).toContain('Scan to open on your phone')
  })

  it('404s /cert when running without HTTPS (no cert in play)', async () => {
    const r = await fetch(base + '/cert')
    expect(r.status).toBe(404)
  })

  it('builds a scannable terminal QR string', () => {
    const s = terminalQr('https://192.168.1.50:8787/')
    expect(s.length).toBeGreaterThan(0)
    expect(s).toContain('▀')
  })
})

describe('item lifecycle', () => {
  let id
  let code

  it('creates an item and auto-generates a code', async () => {
    const r = await api('/api/items', {
      method: 'POST',
      body: JSON.stringify({ name: '2023 Prizm Hobby Box', category: 'Boxes', quantity: 5, price: 299.99, location: 'A3' }),
    })
    expect(r.status).toBe(201)
    const it = await r.json()
    expect(it.id).toBeTruthy()
    expect(it.code).toMatch(/^RM-/)
    expect(it.quantity).toBe(5)
    id = it.id
    code = it.code
  })

  it('rejects an item with no name', async () => {
    const r = await api('/api/items', { method: 'POST', body: JSON.stringify({ quantity: 1 }) })
    expect(r.status).toBe(400)
  })

  it('looks the item up by its code (the scan path)', async () => {
    const it = await json('/api/items/by-code/' + encodeURIComponent(code))
    expect(it.id).toBe(id)
  })

  it('is case-insensitive on code lookup', async () => {
    const it = await json('/api/items/by-code/' + encodeURIComponent(code.toLowerCase()))
    expect(it.id).toBe(id)
  })

  it('404s for an unknown code', async () => {
    const r = await api('/api/items/by-code/NOPE-123')
    expect(r.status).toBe(404)
  })

  it('rejects a duplicate explicit code with 409', async () => {
    const r = await api('/api/items', { method: 'POST', body: JSON.stringify({ name: 'Dup', code }) })
    expect(r.status).toBe(409)
  })

  it('adjusts stock up and down and logs movements', async () => {
    let it = await json('/api/items/' + id + '/adjust', { method: 'POST', body: JSON.stringify({ delta: 3, reason: 'Restock' }) })
    expect(it.quantity).toBe(8)
    it = await json('/api/items/' + id + '/adjust', { method: 'POST', body: JSON.stringify({ delta: -2 }) })
    expect(it.quantity).toBe(6)

    const moves = await json('/api/items/' + id + '/movements')
    // initial stock (+5), +3, -2  => 3 movements, newest first
    expect(moves.length).toBe(3)
    expect(moves[0].delta).toBe(-2)
    expect(moves[moves.length - 1].reason).toBe('Initial stock')
  })

  it('never lets quantity go negative', async () => {
    const it = await json('/api/items/' + id + '/adjust', { method: 'POST', body: JSON.stringify({ delta: -9999 }) })
    expect(it.quantity).toBe(0)
  })

  it('updates editable fields', async () => {
    const it = await json('/api/items/' + id, { method: 'PATCH', body: JSON.stringify({ location: 'Shelf B1', minQuantity: 2 }) })
    expect(it.location).toBe('Shelf B1')
    expect(it.minQuantity).toBe(2)
  })

  it('reports rollup stats', async () => {
    const s = await json('/api/stats')
    expect(s.itemCount).toBe(1)
    expect(s.categories).toContain('Boxes')
    expect(typeof s.totalValue).toBe('number')
  })

  it('deletes the item', async () => {
    const r = await api('/api/items/' + id, { method: 'DELETE' })
    expect(r.status).toBe(200)
    const after = await api('/api/items/' + id)
    expect(after.status).toBe(404)
  })
})

describe('routing', () => {
  it('404s an unknown API route as JSON', async () => {
    const r = await api('/api/nope')
    expect(r.status).toBe(404)
    expect(r.headers.get('content-type')).toMatch(/application\/json/)
  })
})
