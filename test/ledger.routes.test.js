// =============================================================================
// Route-level integration tests for the Whatnot-ledger Sales Dashboard API.
// PRIVACY: repo is public — the CSV below is fully SYNTHETIC (no real data).
// =============================================================================
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

// Synthetic ledger: 4 earnings (185), one with no break (25 -> unattributed),
// a $0 + a -$4.29 giveaway, a Shipping Subsidy adjustment, a $10 tip, a payout.
const HEADER = '"Created Date","Amount","Listing ID","Order ID","Message","Status","Transaction Type","Completed Date"'
const CSV = '﻿' + [
  HEADER,
  '"Jun 20, 2026, 1:00:00 PM","$50.00","100","200","Earnings for selling a 1x Topps Chrome Break #1 - Lions","completed","SALES","Jun 20, 2026, 1:00:01 PM"',
  '"Jun 20, 2026, 2:00:00 PM","$30.00","101","201","Earnings for selling a 1x Topps Chrome BREAK #1 - Bears","completed","SALES","Jun 20, 2026, 2:00:01 PM"',
  '"Jun 21, 2026, 3:00:00 PM","$80.00","102","202","Earnings for selling a 2x Topps Chrome Break #2 - Packers","completed","SALES","Jun 21, 2026, 3:00:01 PM"',
  '"Jun 21, 2026, 4:00:00 PM","$25.00","103","203","Earnings for selling a 1x Mystery Box","completed","SALES","Jun 21, 2026, 4:00:01 PM"',
  '"Jun 21, 2026, 5:00:00 PM","$0.00","104","204","Charged deduction of $0.00 for giveaway order 555","completed","SALES","Jun 21, 2026, 5:00:01 PM"',
  '"Jun 22, 2026, 6:00:00 PM","-$4.29","105","205","Charged deduction of $4.29 for giveaway order 556","completed","SALES","Jun 22, 2026, 6:00:01 PM"',
  '"Jun 22, 2026, 7:00:00 PM","$2.50","106","206","Shipping Subsidy","completed","ADJUSTMENT","Jun 22, 2026, 7:00:01 PM"',
  '"Jun 22, 2026, 8:00:00 PM","$10.00","","","Tip from buyer","completed","TIP","Jun 22, 2026, 8:00:01 PM"',
  '"Jun 29, 2026, 9:00:00 PM","-$1,234.56","","","Payout request: STRIPE acct_test","completed","PAYOUT","Jun 29, 2026, 9:00:01 PM"',
].join('\n') + '\n'

beforeAll(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rmcardz-ledger-'))
  const { app } = createApp({ dataDir })
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r) })
  base = `http://127.0.0.1:${server.address().port}`
  await api('/api/auth/register', { method: 'POST', body: JSON.stringify({ username: 'owner', password: 'secret' }) })
  token = (await (await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: 'owner', password: 'secret' }) })).json()).token
})
afterAll(() => server && server.close())

describe('ledger routes', () => {
  it('reports no ledger before upload', async () => {
    expect((await (await api('/api/ledger')).json()).hasLedger).toBe(false)
  })

  it('requires auth', async () => {
    const r = await fetch(base + '/api/ledger')
    expect(r.status).toBe(401)
  })

  it('rejects an empty CSV', async () => {
    const r = await api('/api/ledger', { method: 'POST', body: JSON.stringify({ filename: 'x.csv', csv: '   ' }) })
    expect(r.status).toBe(400)
  })

  it('uploads and computes net = gross + giveaways, excluding payouts/adjustments/tips', async () => {
    const a = await (await api('/api/ledger', { method: 'POST', body: JSON.stringify({ filename: 'ledger.csv', csv: CSV }) })).json()
    expect(a.hasLedger).toBe(true)
    expect(a.totals.grossEarnings).toBeCloseTo(185, 2)
    expect(a.totals.giveawayLost).toBeCloseTo(-4.29, 2)
    expect(a.totals.netRevenue).toBeCloseTo(180.71, 2)
    expect(a.totals.adjustments).toBeCloseTo(2.5, 2) // excluded from revenue
    expect(a.totals.tips).toBeCloseTo(10, 2) // excluded from revenue
    expect(a.totals.payoutsIgnoredCount).toBe(1)
    // payout/adjustment/tip must NOT be in net revenue
    expect(a.totals.netRevenue).not.toBeCloseTo(180.71 + 2.5 + 10, 2)
    // date range only over counted rows (Jun 20–22), payout on Jun 29 excluded
    expect(a.dateRange.start).toBe('2026-06-20')
    expect(a.dateRange.end).toBe('2026-06-22')
    expect(a.dateRange.days).toBe(3)
    expect(a.unattributed.count).toBe(1) // the Mystery Box
    expect(a.unattributed.revenue).toBeCloseTo(25, 2)
  })

  it('groups breaks case-insensitively and recomputes cases on breaksPerCase change', async () => {
    // case-insensitive: "Break #1" + "BREAK #1" same product collapse to one pair.
    const a9 = await (await api('/api/ledger?breaksPerCase=9')).json()
    expect(a9.perBreak.length).toBe(2) // (Topps Chrome, 1) and (Topps Chrome, 2)
    expect(a9.perCase.totalBreaks).toBe(2)
    expect(a9.perCase.totalCases).toBe(1) // ceil(2/9)

    const a1 = await (await api('/api/ledger/settings', { method: 'PATCH', body: JSON.stringify({ breaksPerCase: 1 }) })).json()
    expect(a1.perCase.breaksPerCase).toBe(1)
    expect(a1.perCase.totalCases).toBe(2) // ceil(2/1)
    expect(a1.perBreak.length).toBe(2) // perBreak unaffected by breaksPerCase
  })

  it('clears the ledger', async () => {
    expect((await (await api('/api/ledger', { method: 'DELETE' })).json()).hasLedger).toBe(false)
    expect((await (await api('/api/ledger')).json()).hasLedger).toBe(false)
  })
})
