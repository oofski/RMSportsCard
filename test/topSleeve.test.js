// =============================================================================
// Top-sleeve tagging (post-template rework) + giveaway/multi-card order flag.
// - The sleeve-template mechanism is GONE: those routes must 404.
// - Tagging is manual: per slot (PATCH /api/teamslot/:id {topSleeved}) or in bulk
//   per break (POST /api/breaks/:id/sleeve-all {topSleeved}), sport-agnostic.
// - The Orders row exposes hasGiveaway/giveawayCount so the tracker can flag a
//   giveaway riding inside a paid multi-card package.
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

// A one-break NFL event (breaking slip → breaks + teamSlots, no shipment).
const NFL_PAGES = [
  `Whatnot - Breaking Slip
User
Buyer A (a)
#1
1 Breaks
Break #1
Orders: #1
__ Dallas Cowboys
__ Philadelphia Eagles
__ Chicago Bears
Total: $75.00`,
]

beforeAll(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rmcardz-sleeve-'))
  const built = createApp({ dataDir })
  db = built.db
  await new Promise((r) => { server = built.app.listen(0, '127.0.0.1', r) })
  base = `http://127.0.0.1:${server.address().port}`
  await api('/api/auth/register', { method: 'POST', body: JSON.stringify({ username: 'owner', password: 'secret' }) })
  token = (await json(await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: 'owner', password: 'secret' }) }))).token
  db.importDataset(parsePages(NFL_PAGES, { sport: 'nfl' }), { filename: 'nfl.pdf' })
})
afterAll(() => server && server.close())

describe('the sleeve-template mechanism is gone', () => {
  it('404s the removed template routes', async () => {
    expect((await api('/api/sleeve-templates')).status).toBe(404)
    expect((await api('/api/sleeve-templates/x/apply', { method: 'POST' })).status).toBe(404)
    expect((await api('/api/sleeve-tags/clear', { method: 'POST' })).status).toBe(404)
  })
  it('summary no longer reports an applied template but keeps topSleevedSlots', async () => {
    const sum = await json(await api('/api/summary'))
    expect('appliedTemplate' in sum).toBe(false)
    expect(sum.topSleevedSlots).toBe(0)
  })
})

describe('per-slot top-sleeve toggle', () => {
  it('tags one slot and leaves its pick checkbox untouched', async () => {
    const [b1] = await json(await api('/api/breaks'))
    const detail = await json(await api(`/api/breaks/${b1.id}`))
    const slot = detail.teamSlots[0]
    const r = await json(await api(`/api/teamslot/${slot.id}`, { method: 'PATCH', body: JSON.stringify({ topSleeved: true }) }))
    expect(r.topSleeved).toBe(true)
    expect((await json(await api('/api/summary'))).topSleevedSlots).toBe(1)
    const after = await json(await api(`/api/breaks/${b1.id}`))
    expect(after.teamSlots.find((s) => s.id === slot.id).checkedOff).toBe(false)
  })
})

describe('bulk per-break sleeve (sport-agnostic)', () => {
  it('top-sleeves and clears every slot in a break; 404s an unknown break', async () => {
    const [b1] = await json(await api('/api/breaks'))
    // Check one slot off first — a bulk sleeve must NOT disturb pick state.
    const pre = await json(await api(`/api/breaks/${b1.id}`))
    const pickedId = pre.teamSlots[0].id
    await api(`/api/teamslot/${pickedId}`, { method: 'PATCH', body: JSON.stringify({ checkedOff: true }) })

    const on = await json(await api(`/api/breaks/${b1.id}/sleeve-all`, { method: 'POST', body: JSON.stringify({ topSleeved: true }) }))
    expect(on.teamSlots.length).toBeGreaterThan(0)
    expect(on.teamSlots.every((s) => s.topSleeved)).toBe(true)
    // The previously-checked slot stays checked (sleeve-all touches only topSleeved).
    expect(on.teamSlots.find((s) => s.id === pickedId).checkedOff).toBe(true)
    const list = await json(await api('/api/breaks'))
    expect(list.find((b) => b.id === b1.id).topSleevedTeams).toBe(on.teamSlots.length)
    expect((await json(await api('/api/summary'))).topSleevedSlots).toBe(on.teamSlots.length)

    const off = await json(await api(`/api/breaks/${b1.id}/sleeve-all`, { method: 'POST', body: JSON.stringify({ topSleeved: false }) }))
    expect(off.teamSlots.every((s) => !s.topSleeved)).toBe(true)
    expect((await json(await api('/api/summary'))).topSleevedSlots).toBe(0)

    expect((await api('/api/breaks/nope/sleeve-all', { method: 'POST', body: JSON.stringify({ topSleeved: true }) })).status).toBe(404)
  })

  it('works identically for MLB and NBA imports (no team-list coupling)', async () => {
    for (const sport of ['mlb', 'nba']) {
      const page = `Whatnot - Breaking Slip
User
Fan ${sport} (${sport}fan)
#9
1 Breaks
Break #1
Orders: #9
${sport === 'mlb' ? '__ New York Yankees\n__ Boston Red Sox' : '__ Los Angeles Lakers\n__ Boston Celtics'}
Total: $40.00`
      db.importDataset(parsePages([page], { sport }), { filename: `${sport}.pdf` })
      const [b1] = await json(await api('/api/breaks'))
      const on = await json(await api(`/api/breaks/${b1.id}/sleeve-all`, { method: 'POST', body: JSON.stringify({ topSleeved: true }) }))
      expect(on.teamSlots.every((s) => s.topSleeved)).toBe(true)
    }
  })
})

describe('Orders tracker flags a giveaway inside a paid multi-card package', () => {
  function freshDb() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rmcardz-give-'))
    const { Db } = require('../server/db.cjs')
    const { Store } = require('../server/store.cjs')
    return new Db(new Store(dir, 'g.json'))
  }
  // 2 team slots for one customer: 1 paid + 1 giveaway, plus a shipment.
  function seed(d, slots) {
    d.importDataset({
      event: { name: 'E', date: '2026-01-01' },
      sport: 'nfl',
      breaks: [{ id: 'b1', breakNumber: 1, eventName: 'E', eventDate: '2026-01-01', status: 'pending' }],
      teamSlots: slots,
      customers: [{ id: 'c1', whatnotHandle: 'c1', realName: 'Cust', address: '', isNew: false }],
      shipments: [{ id: 'sh1', customerId: 'c1', trackingNumber: 'T1', serviceType: 'Priority', manualStatus: { code: 'not_shipped' } }],
      orders: slots.map((s, i) => ({ id: `o${i}`, customerId: 'c1', breakId: 'b1', breakNumber: 1, teamName: s.teamName, price: s.isGiveaway ? 0 : 10, isGiveaway: !!s.isGiveaway })),
      batchUrls: [],
      warnings: [],
    }, { filename: 'x.pdf' })
  }

  it('exposes hasGiveaway/giveawayCount + per-team isGiveaway on a multi-card order', () => {
    const d = freshDb()
    seed(d, [
      { id: 's1', breakId: 'b1', breakNumber: 1, teamName: 'Dallas Cowboys', customerId: 'c1', orderId: 'o0', price: 10, isGiveaway: false, checkedOff: false },
      { id: 's2', breakId: 'b1', breakNumber: 1, teamName: 'Philadelphia Eagles', customerId: 'c1', orderId: 'o1', price: 0, isGiveaway: true, checkedOff: false },
    ])
    const [row] = d.listOrders()
    expect(row.cardCount).toBe(2)
    expect(row.multiCard).toBe(true)
    expect(row.hasGiveaway).toBe(true)
    expect(row.giveawayCount).toBe(1)
    const teams = row.breaks[0].teams
    expect(teams.find((t) => t.teamName === 'Philadelphia Eagles').isGiveaway).toBe(true)
    expect(teams.find((t) => t.teamName === 'Dallas Cowboys').isGiveaway).toBe(false)
  })

  it('does not flag a single giveaway-only order as multi-card', () => {
    const d = freshDb()
    seed(d, [
      { id: 's1', breakId: 'b1', breakNumber: 1, teamName: 'Dallas Cowboys', customerId: 'c1', orderId: 'o0', price: 0, isGiveaway: true, checkedOff: false },
    ])
    const [row] = d.listOrders()
    expect(row.multiCard).toBe(false)
    expect(row.hasGiveaway).toBe(true)
    expect(row.giveawayCount).toBe(1)
  })
})
