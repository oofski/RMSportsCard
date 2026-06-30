// Integration tests for the Express API (server/index.cjs). We bind the app to
// an ephemeral port and drive it with global fetch (no supertest dependency).
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

const require = createRequire(import.meta.url)
const { createApp } = require('../server/index.cjs')

let server
let base
let token

function api(p, opts = {}) {
  return fetch(base + p, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(opts.headers || {}),
    },
  })
}

beforeAll(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rmcardz-test-'))
  const { app } = createApp({ dataDir })
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve)
  })
  base = `http://127.0.0.1:${server.address().port}`
})

afterAll(() => {
  if (server) server.close()
})

describe('auth & bootstrap', () => {
  it('reports needsBootstrap before any user exists', async () => {
    const d = await (await api('/api/auth/status')).json()
    expect(d.needsBootstrap).toBe(true)
  })

  it('makes the first registered user an admin', async () => {
    const r = await api('/api/auth/register', { method: 'POST', body: JSON.stringify({ username: 'owner', password: 'secret', displayName: 'Owner' }) })
    expect(r.status).toBe(201)
    expect((await r.json()).user.role).toBe('admin')
  })

  it('closes open registration after bootstrap', async () => {
    const r = await api('/api/auth/register', { method: 'POST', body: JSON.stringify({ username: 'x', password: 'yyyy' }) })
    expect(r.status).toBe(403)
  })

  it('logs in and returns a token', async () => {
    const d = await (await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: 'owner', password: 'secret' }) })).json()
    expect(d.token).toBeTruthy()
    token = d.token
  })

  it('rejects protected routes without a token', async () => {
    const r = await fetch(base + '/api/breaks')
    expect(r.status).toBe(401)
  })

  it('lets an admin create a picker', async () => {
    const r = await api('/api/users', { method: 'POST', body: JSON.stringify({ username: 'picker1', password: 'pppp', role: 'picker' }) })
    expect(r.status).toBe(201)
    expect((await r.json()).user.role).toBe('picker')
  })
})

describe('data flows (demo dataset)', () => {
  it('loads the demo dataset with 9 breaks', async () => {
    const d = await (await api('/api/parse/demo', { method: 'POST' })).json()
    expect(d.summary.breaks).toBe(9)
  })

  it('lists breaks and toggles a team slot with attribution', async () => {
    const breaks = await (await api('/api/breaks')).json()
    expect(breaks).toHaveLength(9)
    const detail = await (await api('/api/breaks/' + breaks[0].id)).json()
    const slot = detail.teamSlots.find((s) => !s.checkedOff)
    const upd = await (await api('/api/teamslot/' + slot.id, { method: 'PATCH', body: JSON.stringify({ checkedOff: true }) })).json()
    expect(upd.checkedOff).toBe(true)
    expect(upd.checkedOffBy).toBe('owner')
  })

  it('updates a shipment status and rejects an invalid code', async () => {
    const ships = await (await api('/api/shipments')).json()
    const ok = await api('/api/shipments/' + ships[0].id, { method: 'PATCH', body: JSON.stringify({ manualStatus: 'delivered', notes: 'left at door' }) })
    const okJson = await ok.json()
    expect(okJson.manualStatus.code).toBe('delivered')
    expect(okJson.notes).toBe('left at door')
    const bad = await api('/api/shipments/' + ships[0].id, { method: 'PATCH', body: JSON.stringify({ manualStatus: 'banana' }) })
    expect(bad.status).toBe(400)
  })

  it('serves batch URLs and tracking numbers', async () => {
    const batch = await (await api('/api/shipments/batch-urls')).json()
    expect(batch.totalPackages).toBeGreaterThan(0)
    expect(batch.batches[0].url).toContain('%2C')
    const tn = await (await api('/api/shipments/tracking-numbers')).json()
    expect(tn.trackingNumbers.length).toBe(batch.totalPackages)
  })

  it('aggregates the dashboard and settings', async () => {
    const dash = await (await api('/api/dashboard')).json()
    expect(dash.totalBreaks).toBe(9)
    expect(typeof dash.totalRevenue).toBe('number')
    const settings = await (await api('/api/settings')).json()
    expect(settings.hasData).toBe(true)
  })
})
