// =============================================================================
// Sleeve-template routes + apply logic (top-sleeve tagging).
// The builder marks, per break, which teams get a toploader/sleeve; applying a
// template tags the current event's team slots. Covers CRUD, apply, sport
// mismatch, auto-apply of a default on import, per-slot toggle, and validation.
//
// PRIVACY: repo is public — every fixture below is fully SYNTHETIC.
// =============================================================================
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

const require = createRequire(import.meta.url)
const { createApp } = require('../server/index.cjs')
const { parsePages } = require('../server/parser/index.cjs')

let server, base, token, db
function api(p, opts = {}) {
  return fetch(base + p, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(opts.headers || {}) },
  })
}
const json = (r) => r.json()

// A small NFL event: Break #1 (Cowboys, Eagles), Break #2 (Cowboys, Bears).
const NFL_PAGES = [
  `Whatnot - Breaking Slip
User
Buyer A (a)
#1
2 Breaks
Break #1
Orders: #1
__ Dallas Cowboys
__ Philadelphia Eagles
Break #2
Orders: #2
__ Dallas Cowboys
__ Chicago Bears
Total: $80.00`,
]

beforeAll(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rmcardz-tmpl-'))
  const built = createApp({ dataDir })
  db = built.db
  await new Promise((r) => { server = built.app.listen(0, '127.0.0.1', r) })
  base = `http://127.0.0.1:${server.address().port}`
  await api('/api/auth/register', { method: 'POST', body: JSON.stringify({ username: 'owner', password: 'secret' }) })
  token = (await json(await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: 'owner', password: 'secret' }) }))).token
  // Seed a parsed NFL event straight through the db layer.
  db.importDataset(parsePages(NFL_PAGES, { sport: 'nfl' }), { filename: 'nfl.pdf' })
})
afterAll(() => server && server.close())

describe('sleeve-template CRUD', () => {
  it('requires auth', async () => {
    expect((await fetch(base + '/api/sleeve-templates')).status).toBe(401)
  })

  it('starts empty', async () => {
    expect(await json(await api('/api/sleeve-templates'))).toEqual([])
  })

  it('creates a template and keeps only known teams / valid breaks', async () => {
    const created = await json(await api('/api/sleeve-templates', {
      method: 'POST',
      body: JSON.stringify({
        name: 'Stars',
        sport: 'nfl',
        breaks: {
          1: ['Dallas Cowboys', 'Not A Team'],  // junk dropped
          2: ['Chicago Bears'],
          0: ['Green Bay Packers'],              // invalid break number dropped
        },
      }),
    }))
    expect(created.id).toMatch(/^tmpl_/)
    expect(created.sport).toBe('nfl')
    expect(created.breaks['1']).toEqual(['Dallas Cowboys']) // junk removed
    expect(created.breaks['2']).toEqual(['Chicago Bears'])
    expect(created.breaks['0']).toBeUndefined()
    expect(created.teamCount).toBe(2)
    expect(created.breakCount).toBe(2)
  })

  it('lists and edits a template', async () => {
    const [t] = await json(await api('/api/sleeve-templates'))
    const updated = await json(await api(`/api/sleeve-templates/${t.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ name: 'Stars & rookies', breaks: { 1: ['Dallas Cowboys', 'Philadelphia Eagles'] } }),
    }))
    expect(updated.name).toBe('Stars & rookies')
    expect(updated.breaks['1'].sort()).toEqual(['Dallas Cowboys', 'Philadelphia Eagles'])
    expect(updated.breaks['2']).toBeUndefined() // replaced wholesale
  })
})

describe('applying a template tags the event slots', () => {
  it('tags exactly the marked (break, team) slots', async () => {
    const [t] = await json(await api('/api/sleeve-templates'))
    // Template now marks Break #1 Cowboys + Eagles.
    const res = await json(await api(`/api/sleeve-templates/${t.id}/apply`, { method: 'POST' }))
    expect(res.sportMismatch).toBe(false)
    expect(res.tagged).toBe(2)          // both Break #1 slots
    expect(res.breaksAffected).toBe(1)  // only Break #1

    // Verify via the break detail: Break #1 both sleeved, Break #2 none.
    const breaks = await json(await api('/api/breaks'))
    const b1 = breaks.find((b) => b.breakNumber === 1)
    const b2 = breaks.find((b) => b.breakNumber === 2)
    expect(b1.topSleevedTeams).toBe(2)
    expect(b2.topSleevedTeams).toBe(0)

    const detail1 = await json(await api(`/api/breaks/${b1.id}`))
    expect(detail1.teamSlots.every((s) => s.topSleeved)).toBe(true)

    // Summary reflects the applied template + total tagged.
    const sum = await json(await api('/api/summary'))
    expect(sum.topSleevedSlots).toBe(2)
    expect(sum.appliedTemplate.name).toBe('Stars & rookies')
  })

  it('flags a sport mismatch and tags nothing', async () => {
    const mlb = await json(await api('/api/sleeve-templates', {
      method: 'POST',
      body: JSON.stringify({ name: 'MLB tmpl', sport: 'mlb', breaks: { 1: ['New York Yankees'] } }),
    }))
    const res = await json(await api(`/api/sleeve-templates/${mlb.id}/apply`, { method: 'POST' }))
    expect(res.sportMismatch).toBe(true)
    expect(res.tagged).toBe(0)
  })

  it('re-applying overwrites the previous tag set', async () => {
    // The MLB apply above tagged 0 — so the NFL tags were overwritten to false.
    const sum = await json(await api('/api/summary'))
    expect(sum.topSleevedSlots).toBe(0)
  })
})

describe('per-slot manual toggle + clear', () => {
  it('toggles one slot via the teamslot PATCH endpoint', async () => {
    const breaks = await json(await api('/api/breaks'))
    const b1 = breaks.find((b) => b.breakNumber === 1)
    const detail = await json(await api(`/api/breaks/${b1.id}`))
    const slot = detail.teamSlots[0]
    const r = await json(await api(`/api/teamslot/${slot.id}`, { method: 'PATCH', body: JSON.stringify({ topSleeved: true }) }))
    expect(r.topSleeved).toBe(true)
    expect((await json(await api('/api/summary'))).topSleevedSlots).toBe(1)
    // The pick checkbox is untouched by a sleeve toggle.
    const after = await json(await api(`/api/breaks/${b1.id}`))
    expect(after.teamSlots.find((s) => s.id === slot.id).checkedOff).toBe(false)
  })

  it('clears every tag', async () => {
    await api('/api/sleeve-tags/clear', { method: 'POST' })
    const sum = await json(await api('/api/summary'))
    expect(sum.topSleevedSlots).toBe(0)
    expect(sum.appliedTemplate).toBeNull()
  })
})

describe('default template auto-applies on import', () => {
  it('re-imports with the default NFL template auto-applied', async () => {
    const templates = await json(await api('/api/sleeve-templates'))
    const nfl = templates.find((t) => t.sport === 'nfl')
    await api(`/api/sleeve-templates/${nfl.id}/default`, { method: 'POST', body: JSON.stringify({ on: true }) })

    // Fresh import of the same event — the default should re-tag Break #1.
    db.importDataset(parsePages(NFL_PAGES, { sport: 'nfl' }), { filename: 'nfl-again.pdf' })
    const sum = await json(await api('/api/summary'))
    expect(sum.topSleevedSlots).toBe(2)
    expect(sum.appliedTemplate.name).toBe('Stars & rookies')
  })

  it('does NOT auto-apply a default whose sport differs from the import', async () => {
    // Import an MLB event; the NFL default must be skipped (no cross-sport tags).
    const mlbPage = `Whatnot - Breaking Slip
User
Buyer M (m)
#9
1 Breaks
Break #1
Orders: #9
__ New York Yankees
Total: $20.00`
    db.importDataset(parsePages([mlbPage], { sport: 'mlb' }), { filename: 'mlb.pdf' })
    const sum = await json(await api('/api/summary'))
    expect(sum.sport).toBe('mlb')
    expect(sum.topSleevedSlots).toBe(0)
    expect(sum.appliedTemplate).toBeNull()
  })
})

describe('delete', () => {
  it('deletes a template and clears it as default', async () => {
    const templates = await json(await api('/api/sleeve-templates'))
    const nfl = templates.find((t) => t.sport === 'nfl')
    expect((await api(`/api/sleeve-templates/${nfl.id}`, { method: 'DELETE' })).status).toBe(200)
    const after = await json(await api('/api/sleeve-templates'))
    expect(after.find((t) => t.id === nfl.id)).toBeUndefined()
  })

  it('404s an unknown template', async () => {
    expect((await api('/api/sleeve-templates/tmpl_nope/apply', { method: 'POST' })).status).toBe(404)
    expect((await api('/api/sleeve-templates/tmpl_nope', { method: 'DELETE' })).status).toBe(404)
  })
})
