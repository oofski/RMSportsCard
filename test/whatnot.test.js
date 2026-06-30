// Integration tests for Whatnot Orders, Sales analytics, reset-queue, and the
// new label_created shipment status.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

const require = createRequire(import.meta.url)
const { createApp } = require('../server/index.cjs')

let server, base, token
function api(p, opts = {}) {
  return fetch(base + p, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(opts.headers || {}) },
  })
}

beforeAll(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rmcardz-whatnot-'))
  const { app } = createApp({ dataDir })
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r) })
  base = `http://127.0.0.1:${server.address().port}`
  await api('/api/auth/register', { method: 'POST', body: JSON.stringify({ username: 'owner', password: 'secret' }) })
  token = (await (await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: 'owner', password: 'secret' }) })).json()).token
  await api('/api/parse/demo', { method: 'POST' })
})
afterAll(() => server && server.close())

describe('whatnot orders + sales', () => {
  it('lists every order line item with customer info', async () => {
    const rows = await (await api('/api/whatnot-orders')).json()
    expect(rows.length).toBeGreaterThan(100)
    const r = rows[0]
    expect(r).toHaveProperty('orderId')
    expect(r).toHaveProperty('breakNumber')
    expect(r).toHaveProperty('teamName')
    expect(typeof r.price).toBe('number')
    expect(r.customer).toHaveProperty('handle')
  })

  it('aggregates sales analytics', async () => {
    const s = await (await api('/api/sales')).json()
    expect(typeof s.totalRevenue).toBe('number')
    expect(s.revenueByBreak.length).toBe(9)
    expect(Array.isArray(s.topTeams)).toBe(true)
    expect(Array.isArray(s.topCustomers)).toBe(true)
    // Top customers are sorted by revenue descending.
    for (let i = 1; i < s.topCustomers.length; i++) {
      expect(s.topCustomers[i - 1].revenue).toBeGreaterThanOrEqual(s.topCustomers[i].revenue)
    }
  })

  it('accepts the new label_created shipment status', async () => {
    const ships = await (await api('/api/shipments')).json()
    const r = await api(`/api/shipments/${ships[0].id}`, { method: 'PATCH', body: JSON.stringify({ manualStatus: 'label_created' }) })
    expect(r.status).toBe(200)
    expect((await r.json()).manualStatus.code).toBe('label_created')
  })

  it('resets the queue to default order', async () => {
    const id = (await (await api('/api/orders')).json())[0].id
    await api(`/api/orders/${id}/move`, { method: 'PATCH', body: JSON.stringify({ direction: 'down' }) })
    const reset = await (await api('/api/orders/reset-queue', { method: 'POST' })).json()
    expect(reset.map((o) => o.queueOrder)).toEqual(reset.map((_, i) => i + 1))
  })

  it('stores the tracking provider + key without echoing the raw key', async () => {
    await api('/api/settings', { method: 'PATCH', body: JSON.stringify({ trackingProvider: '17track', trackingApiKey: 'secret-key-123' }) })
    const s = await (await api('/api/settings')).json()
    expect(s.trackingProvider).toBe('17track')
    expect(s.trackingKeySet).toBe(true)
    expect(s.trackingApiKey).toBeUndefined() // raw key is never returned to the client
    // Leaving the key undefined on a later PATCH must not wipe it.
    await api('/api/settings', { method: 'PATCH', body: JSON.stringify({ trackingProvider: '17track' }) })
    expect((await (await api('/api/settings')).json()).trackingKeySet).toBe(true)
  })
})
