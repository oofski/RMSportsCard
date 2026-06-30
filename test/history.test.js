// Integration tests for History snapshots + CSV export endpoints.
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
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rmcardz-history-'))
  const { app } = createApp({ dataDir })
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r) })
  base = `http://127.0.0.1:${server.address().port}`
  await api('/api/auth/register', { method: 'POST', body: JSON.stringify({ username: 'owner', password: 'secret' }) })
  token = (await (await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: 'owner', password: 'secret' }) })).json()).token
  await api('/api/parse/demo', { method: 'POST' })
})
afterAll(() => server && server.close())

describe('history snapshots + export', () => {
  let snapId

  it('saves a snapshot with order/shipment counts', async () => {
    const r = await api('/api/snapshots', { method: 'POST', body: JSON.stringify({ label: 'Day 1' }) })
    expect(r.status).toBe(201)
    const meta = await r.json()
    expect(meta.label).toBe('Day 1')
    expect(meta.orders).toBeGreaterThan(100)
    expect(meta.shipments).toBe(16)
    snapId = meta.id
  })

  it('lists saved snapshots', async () => {
    const list = await (await api('/api/snapshots')).json()
    expect(list.length).toBe(1)
    expect(list[0].id).toBe(snapId)
  })

  it('exports current orders CSV', async () => {
    const out = await (await api('/api/export/orders')).json()
    expect(out.filename).toMatch(/rmcardz-orders-\d{4}-\d{2}-\d{2}\.csv/)
    expect(out.csv.split('\r\n')[0]).toContain('Order ID')
  })

  it('exports a snapshot shipping CSV', async () => {
    const out = await (await api(`/api/export/shipping?snapshot=${snapId}`)).json()
    expect(out.csv).toContain('Tracking')
    expect(out.csv.split('\r\n').length).toBeGreaterThan(16) // header + 16 shipments
  })

  it('rejects an invalid export kind', async () => {
    const r = await api('/api/export/bogus')
    expect(r.status).toBe(400)
  })

  it('deletes a snapshot', async () => {
    const r = await api(`/api/snapshots/${snapId}`, { method: 'DELETE' })
    expect(r.status).toBe(200)
    expect((await (await api('/api/snapshots')).json()).length).toBe(0)
  })
})
