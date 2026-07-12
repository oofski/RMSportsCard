// =============================================================================
// OrderQueue RENDER smoke test — the "By break" grouping view.
//
// A Vite build only compiles; it never executes the render. This mounts
// OrderQueue with seeded orders (skipping the network fetch) and asserts both
// the flat list AND the by-break grouping render without throwing — the guard
// that would catch a render-time regression in the refactored row.
//
// PRIVACY: repo is public — the orders below are fully SYNTHETIC.
// =============================================================================
import { describe, it, expect } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import OrderQueue from '../renderer/src/components/orders/OrderQueue.jsx'

// Two synthetic order rows, in the shape db._orderRow returns.
function order(id, name, handle, breaks) {
  return {
    id,
    customerId: handle,
    customer: { handle, realName: name, address: '', isNew: false },
    trackingNumber: 'T' + id,
    serviceType: 'Priority',
    uspsUrl: 'https://example.test/' + id,
    notes: null,
    manualStatus: { code: 'not_shipped', setAt: null, setBy: null },
    stage: 'to_pick',
    onHold: false,
    heldReason: null,
    queueOrder: 1,
    packedAt: null,
    packedBy: null,
    breaks,
    breakCount: breaks.length,
    cardCount: breaks.reduce((n, b) => n + b.teams.length, 0),
    multiCard: false,
    topSleevedCount: 0,
    giveawayCount: 0,
    hasGiveaway: false,
    pick: { checked: 0, total: breaks.reduce((n, b) => n + b.teams.length, 0) },
  }
}

const ORDERS = [
  order('a', 'Alice Alpha', 'alice', [{ breakNumber: 9, teams: [{ slotId: 's1', teamName: 'Dallas Cowboys', checkedOff: false, topSleeved: false, isGiveaway: false }] }]),
  order('b', 'Bob Beta', 'bob', [{ breakNumber: 2, teams: [{ slotId: 's2', teamName: 'Chicago Bears', checkedOff: false, topSleeved: false, isGiveaway: false }] }]),
]

describe('OrderQueue renders', () => {
  it('renders the flat list without throwing and offers the break selector', () => {
    const html = renderToStaticMarkup(<OrderQueue initialOrders={ORDERS} />)
    expect(html).toContain('Alice Alpha')
    expect(html).toContain('Bob Beta')
    expect(html).toContain('All breaks')      // the by-break selector
    expect(html).toContain('Break #9')         // an option for the derived break
  })

  it('renders the By-break grouping (selected break first, then the rest)', () => {
    const html = renderToStaticMarkup(<OrderQueue initialOrders={ORDERS} initialBreakFilter={9} />)
    expect(html).toContain('Break #9 — 1 package')  // the focused-break header
    expect(html).toContain('Other orders — 1')       // the remainder header
    expect(html).toContain('Alice Alpha')            // in Break #9
    expect(html).toContain('Bob Beta')               // in Other orders
  })
})
