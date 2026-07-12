// =============================================================================
// SalesDashboard RENDER smoke test.
//
// The backend analyzeLedger unit tests can't catch a render-time crash in the
// React component (a Vite build only compiles; it never executes the render).
// This mounts SalesDashboard with a realistic analysis payload and asserts the
// default Overview tab renders — the exact guard that would have caught the
// `pct` shadowing bug (a local number shadowing the module-level pct() formatter
// threw "pct is not a function" for any ledger with sales). Also renders a
// LEGACY payload lacking the new split-cost fields to prove the fallback path.
//
// PRIVACY: repo is public — the fixture below is fully SYNTHETIC.
// =============================================================================
import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import SalesDashboard from '../renderer/src/components/whatnot/SalesDashboard.jsx'

const require = createRequire(import.meta.url)
const { parseLedgerRows, analyzeLedger } = require('../server/ledger.cjs')

const HEADER = '"Created Date","Amount","Listing ID","Order ID","Message","Status","Transaction Type","Completed Date"'
const CSV = '﻿' + [
  HEADER,
  '"Jun 20, 2026, 1:00:00 PM","$100.00","1","1","Earnings for selling a 1x Topps Chrome Break #1 - Bears","completed","SALES","Jun 20, 2026, 1:00:01 PM"',
  '"Jun 20, 2026, 2:00:00 PM","-$8.00","2","2","Whatnot platform charge for shipping adjustment","completed","ADJUSTMENT","Jun 20, 2026, 2:00:01 PM"',
  '"Jun 20, 2026, 3:00:00 PM","-$4.00","3","3","Charged deduction of $4.00 for giveaway order 9","completed","SALES","Jun 20, 2026, 3:00:01 PM"',
].join('\n') + '\n'

function payload(costInputs) {
  const { rows } = parseLedgerRows(CSV)
  const a = analyzeLedger(rows, { costInputs: costInputs || {} })
  return { hasLedger: true, filename: 'x.csv', uploadedAt: '2026-07-01T00:00:00Z', breaksPerCase: a.perCase.breaksPerCase, ...a }
}

describe('SalesDashboard renders without throwing', () => {
  it('renders the Overview tab for a real analysis payload (guards the pct-shadow crash)', () => {
    const html = renderToStaticMarkup(<SalesDashboard initialData={payload({})} />)
    expect(html).toContain('Sale category')          // the previously-crashing card
    expect(html).toContain('Ledger composition')     // transactionMix strip
    expect(html).toContain('Shipping costs')          // split cost line
  })

  it('renders a LEGACY payload lacking the split cost fields (fallback path)', () => {
    const p = payload({})
    delete p.profit
    delete p.transactionMix
    delete p.costInputs
    // Old-shape costs: no shippingCosts/promotionFees → hasSplit === false.
    p.costs = {
      giveaways: p.costs.giveaways,
      shippingSubsidies: p.costs.shippingSubsidies,
      platformFees: p.costs.platformFees,
      tips: p.costs.tips,
      adjustmentsNet: p.costs.adjustmentsNet,
    }
    const html = renderToStaticMarkup(<SalesDashboard initialData={p} />)
    expect(html).toContain('Platform fees')          // legacy single-row fallback
  })
})
