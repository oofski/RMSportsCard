// Integration tests for the Express API (server/index.cjs). We bind the app to
// an ephemeral port and drive it with global fetch (no supertest dependency).
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

const require = createRequire(import.meta.url)
const { createApp } = require('../server/index.cjs')
const { Auth } = require('../server/auth.cjs')
const { Store } = require('../server/store.cjs')

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

// Isolated from the ordered 'data flows' describe above: a FRESH app + dataDir so
// wiping accounts here never disturbs the shared 'owner' user. All data synthetic.
describe('reset-admin (return to first-run bootstrap)', () => {
  let rServer
  let rBase

  function rapi(p, opts = {}) {
    return fetch(rBase + p, {
      ...opts,
      headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    })
  }

  beforeAll(async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rmcardz-reset-'))
    const { app } = createApp({ dataDir })
    await new Promise((resolve) => {
      rServer = app.listen(0, '127.0.0.1', resolve)
    })
    rBase = `http://127.0.0.1:${rServer.address().port}`
    // Bootstrap an admin so accounts EXIST (reset is a not-bootstrap recovery).
    await rapi('/api/auth/register', { method: 'POST', body: JSON.stringify({ username: 'admin1', password: 'secret', displayName: 'Admin One' }) })
  })

  afterAll(() => {
    if (rServer) rServer.close()
  })

  it('rejects reset without an explicit confirm flag', async () => {
    const noBody = await rapi('/api/auth/reset-admin', { method: 'POST' })
    expect(noBody.status).toBe(400)
    const falseConfirm = await rapi('/api/auth/reset-admin', { method: 'POST', body: JSON.stringify({ confirm: false }) })
    expect(falseConfirm.status).toBe(400)
    // Accounts still exist — nothing was wiped.
    const status = await (await rapi('/api/auth/status')).json()
    expect(status.needsBootstrap).toBe(false)
  })

  it('wipes accounts with { confirm: true } and returns to bootstrap', async () => {
    const r = await rapi('/api/auth/reset-admin', { method: 'POST', body: JSON.stringify({ confirm: true }) })
    expect(r.status).toBe(200)
    const body = await r.json()
    expect(body.ok).toBe(true)
    expect(body.needsBootstrap).toBe(true)

    const status = await (await rapi('/api/auth/status')).json()
    expect(status.needsBootstrap).toBe(true)
  })

  it('lets a brand-new admin register again after reset', async () => {
    const r = await rapi('/api/auth/register', { method: 'POST', body: JSON.stringify({ username: 'admin2', password: 'secret2', displayName: 'Admin Two' }) })
    expect(r.status).toBe(201)
    expect((await r.json()).user.role).toBe('admin')
  })
})

// Direct unit test of the Auth class (no HTTP): drives resetToBootstrap()
// against a real Store on a temp dir. Synthetic accounts only.
describe('Auth.resetToBootstrap() (unit)', () => {
  let dir
  let auth

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rmcardz-auth-'))
    const store = new Store(dir)
    auth = new Auth(store)
    // Two synthetic accounts so we prove ALL of them get wiped, not just one.
    await auth.createUser({ username: 'admin1', password: 'secret', displayName: 'Admin One' })
    await auth.createUser({ username: 'picker1', password: 'pppp', role: 'picker' })
  })

  it('starts NOT in bootstrap while accounts exist', () => {
    expect(auth.needsBootstrap()).toBe(false)
    expect(auth.listUsers().length).toBe(2)
  })

  it('clears all users, invalidates sessions, and returns to bootstrap', async () => {
    // Open a live session first so we can prove it gets invalidated.
    const { token } = await auth.login({ username: 'admin1', password: 'secret' })
    expect(auth.userForToken(token)).toBeTruthy()

    const result = auth.resetToBootstrap()
    expect(result).toEqual({ ok: true, needsBootstrap: true })

    // Accounts gone -> first-run flow again.
    expect(auth.needsBootstrap()).toBe(true)
    expect(auth.listUsers()).toEqual([])
    // The previously-valid token no longer resolves (sessions cleared).
    expect(auth.userForToken(token)).toBe(null)
  })

  it('makes the next created user an admin again (fresh bootstrap)', async () => {
    const { user } = await auth.createUser({ username: 'fresh', password: 'secret', role: 'picker' })
    // First user after a reset is forced to admin regardless of requested role.
    expect(user.role).toBe('admin')
    expect(auth.needsBootstrap()).toBe(false)
  })
})
