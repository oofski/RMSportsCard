// Integration tests for the Import History log endpoints (item 3).
// PRIVACY: repo is public — everything here is synthetic demo data.
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
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rmcardz-imports-'))
  const { app } = createApp({ dataDir })
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r) })
  base = `http://127.0.0.1:${server.address().port}`
  await api('/api/auth/register', { method: 'POST', body: JSON.stringify({ username: 'owner', password: 'secret' }) })
  token = (await (await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: 'owner', password: 'secret' }) })).json()).token
})
afterAll(() => server && server.close())

describe('import history log', () => {
  let importId

  it('records a demo import named "Demo data" with counts', async () => {
    await api('/api/parse/demo', { method: 'POST' })
    const list = await (await api('/api/imports')).json()
    expect(list.length).toBe(1)
    const e = list[0]
    expect(e.name).toBe('Demo data')
    expect(e.kind).toBe('demo')
    expect(e.event.name).toBeTruthy()
    expect(e.counts.shipments).toBe(16)
    expect(e.counts.orders).toBeGreaterThan(100)
    expect(e.counts.customers).toBeGreaterThan(0)
    expect(e.counts.breaks).toBeGreaterThan(0)
    expect(typeof e.counts.giveaways).toBe('number')
    importId = e.id
  })

  it('renames an import entry', async () => {
    const r = await api(`/api/imports/${importId}`, { method: 'PATCH', body: JSON.stringify({ name: 'June Mega Break' }) })
    expect(r.status).toBe(200)
    expect((await r.json()).name).toBe('June Mega Break')
    expect((await (await api('/api/imports')).json())[0].name).toBe('June Mega Break')
  })

  it('404s renaming a missing import', async () => {
    const r = await api('/api/imports/nope', { method: 'PATCH', body: JSON.stringify({ name: 'x' }) })
    expect(r.status).toBe(404)
  })

  it('prepends the newest import and leaves snapshots untouched', async () => {
    await api('/api/parse/demo', { method: 'POST' })
    const list = await (await api('/api/imports')).json()
    expect(list.length).toBe(2) // newest-first
    const snaps = await (await api('/api/snapshots')).json()
    expect(snaps.length).toBe(0) // snapshots feature is independent
  })

  it('deletes an import entry (log only, not the live data)', async () => {
    const r = await api(`/api/imports/${importId}`, { method: 'DELETE' })
    expect(r.status).toBe(200)
    const list = await (await api('/api/imports')).json()
    expect(list.find((x) => x.id === importId)).toBeUndefined()
    // The live event is untouched — orders still load.
    const orders = await (await api('/api/orders')).json()
    expect(orders.length).toBe(16)
  })

  it('404s deleting a missing import', async () => {
    const r = await api('/api/imports/nope', { method: 'DELETE' })
    expect(r.status).toBe(404)
  })
})
