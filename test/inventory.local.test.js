// Unit tests for the client-side store (inventory/public/store-local.js), which
// powers the app when it's hosted as a static site (e.g. GitHub Pages) with no
// backend. store-local.js is browser code (an IIFE that attaches to `window`),
// so we shim the few browser globals it needs, then require it once.
import { describe, it, expect, beforeAll } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

let L
beforeAll(() => {
  const mem = new Map()
  global.window = {}
  global.localStorage = {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => mem.set(k, String(v)),
    removeItem: (k) => mem.delete(k),
  }
  global.window.crypto = global.crypto // Node exposes Web Crypto globally
  require('../inventory/public/store-local.js')
  L = global.window.InventoryLocal
})

describe('client-side store (local mode)', () => {
  let id
  let code

  it('exposes a REST-style router', () => {
    expect(typeof L.route).toBe('function')
  })

  it('creates an item with an auto-generated code', async () => {
    const it = await L.route('POST', '/items', { name: 'Local Box', category: 'Boxes', quantity: 4, price: 100 })
    expect(it.code).toMatch(/^RM-/)
    expect(it.quantity).toBe(4)
    id = it.id
    code = it.code
  })

  it('rejects a missing name', async () => {
    await expect(L.route('POST', '/items', { quantity: 1 })).rejects.toThrow(/name is required/i)
  })

  it('looks up by code (case-insensitive) — the scan path', async () => {
    const it = await L.route('GET', '/items/by-code/' + code.toLowerCase())
    expect(it.id).toBe(id)
  })

  it('rejects an unknown code', async () => {
    await expect(L.route('GET', '/items/by-code/NOPE')).rejects.toThrow()
  })

  it('adjusts stock and never goes negative', async () => {
    let it = await L.route('POST', `/items/${id}/adjust`, { delta: 3 })
    expect(it.quantity).toBe(7)
    it = await L.route('POST', `/items/${id}/adjust`, { delta: -9999 })
    expect(it.quantity).toBe(0)
    const moves = await L.route('GET', `/items/${id}/movements`)
    expect(moves.length).toBeGreaterThanOrEqual(2)
  })

  it('reports stats', async () => {
    const s = await L.route('GET', '/stats')
    expect(s.itemCount).toBe(1)
    expect(s.categories).toContain('Boxes')
  })

  it('backs up and restores', async () => {
    const dump = L.dump()
    expect(dump).toContain('Local Box')
    L.replace({ meta: {}, items: [{ id: 'z', code: 'RM-Z', name: 'Only Item', quantity: 1, minQuantity: 0, price: 0 }], movements: [] })
    const list = await L.route('GET', '/items')
    expect(list.length).toBe(1)
    expect(list[0].name).toBe('Only Item')
  })

  it('rejects a malformed restore file', () => {
    expect(() => L.replace({ nope: true })).toThrow(/valid inventory backup/i)
  })
})
