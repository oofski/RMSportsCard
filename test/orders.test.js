// Integration tests for the Orders / Fulfillment Queue (Planner) endpoints.
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
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rmcardz-orders-'))
  const { app } = createApp({ dataDir })
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r) })
  base = `http://127.0.0.1:${server.address().port}`
  await api('/api/auth/register', { method: 'POST', body: JSON.stringify({ username: 'owner', password: 'secret' }) })
  token = (await (await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: 'owner', password: 'secret' }) })).json()).token
  await api('/api/parse/demo', { method: 'POST' })
})

afterAll(() => server && server.close())

describe('orders queue', () => {
  it('lists one order per package with breaks, pick progress, and a stage', async () => {
    const orders = await (await api('/api/orders')).json()
    expect(orders.length).toBe(16)
    const o = orders[0]
    expect(o).toHaveProperty('stage')
    expect(o).toHaveProperty('queueOrder')
    expect(Array.isArray(o.breaks)).toBe(true)
    expect(o.pick).toHaveProperty('total')
  })

  it('advancing to Sent / All Good drives the shipment status (one source of truth)', async () => {
    const orders = await (await api('/api/orders')).json()
    const id = orders[0].id
    let row = await (await api(`/api/orders/${id}/stage`, { method: 'PATCH', body: JSON.stringify({ stage: 'sent' }) })).json()
    expect(row.stage).toBe('sent')
    expect(row.manualStatus.code).toBe('in_transit')
    // The Shipping Tracker must reflect the same status.
    const ships = await (await api('/api/shipments')).json()
    expect(ships.find((s) => s.id === id).manualStatus.code).toBe('in_transit')

    row = await (await api(`/api/orders/${id}/stage`, { method: 'PATCH', body: JSON.stringify({ stage: 'all_good' }) })).json()
    expect(row.stage).toBe('all_good')
    expect(row.manualStatus.code).toBe('delivered')
  })

  it('Put Together sets packedAt and keeps it not-shipped', async () => {
    const id = (await (await api('/api/orders')).json())[2].id
    const row = await (await api(`/api/orders/${id}/stage`, { method: 'PATCH', body: JSON.stringify({ stage: 'put_together' }) })).json()
    expect(row.stage).toBe('put_together')
    expect(row.packedAt).toBeTruthy()
    expect(row.manualStatus.code).toBe('not_shipped')
  })

  it('rejects an invalid stage', async () => {
    const id = (await (await api('/api/orders')).json())[0].id
    const r = await api(`/api/orders/${id}/stage`, { method: 'PATCH', body: JSON.stringify({ stage: 'nope' }) })
    expect(r.status).toBe(400)
  })

  it('holds an order and sinks it to the bottom of the queue', async () => {
    const orders = await (await api('/api/orders')).json()
    const target = orders[1]
    const row = await (await api(`/api/orders/${target.id}/hold`, { method: 'PATCH', body: JSON.stringify({ onHold: true, reason: 'waiting on Break #4' }) })).json()
    expect(row.onHold).toBe(true)
    expect(row.heldReason).toBe('waiting on Break #4')
    const after = await (await api('/api/orders')).json()
    expect(after[after.length - 1].onHold).toBe(true) // held rows sink
  })

  it('moves an order in the queue', async () => {
    const orders = await (await api('/api/orders')).json()
    const second = orders[1]
    await api(`/api/orders/${second.id}/move`, { method: 'PATCH', body: JSON.stringify({ direction: 'up' }) })
    const after = await (await api('/api/orders')).json()
    expect(after[0].id).toBe(second.id) // moved to the front
  })
})
