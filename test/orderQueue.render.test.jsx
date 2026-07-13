// =============================================================================
// OrderQueue RENDER smoke test — the "By break" grouping view.
//
// A Vite build only compiles; it never executes the render. This mounts
// OrderQueue with seeded orders (skipping the network fetch) and asserts both
// the flat list AND the by-break grouping render without throwing.
//
// The grouping rule under test: selecting a break shows only the packages that
// live SOLELY in that break (every card is in it — giveaways included). A
// package that also spans other breaks must NOT appear in that break's group;
// it drops to "Other orders". A giveaway-only package (bought nothing, only won
// a giveaway) must stay visible and be flagged.
//
// PRIVACY: repo is public — the orders below are fully SYNTHETIC.
// =============================================================================
import { describe, it, expect } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import OrderQueue from '../renderer/src/components/orders/OrderQueue.jsx'

// A team slot, in the shape db._orderRow returns (giveaway/sleeve default off).
const team = (slotId, name, opts = {}) => ({
  slotId, teamName: name, checkedOff: false, topSleeved: false, isGiveaway: false, ...opts,
})

// A synthetic order row; the multi-card / giveaway / sleeve counts are derived
// from the team slots exactly as the backend derives them.
function order(id, name, handle, breaks) {
  const slots = breaks.flatMap((b) => b.teams)
  const cardCount = slots.length
  const giveawayCount = slots.filter((t) => t.isGiveaway).length
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
    cardCount,
    multiCard: cardCount > 1,
    topSleevedCount: slots.filter((t) => t.topSleeved).length,
    giveawayCount,
    hasGiveaway: giveawayCount > 0,
    pick: { checked: 0, total: cardCount },
  }
}

const ORDERS = [
  // Solely in break 9 (a paid card) → belongs in the "Only in Break #9" group.
  order('a', 'Alice Alpha', 'alice', [{ breakNumber: 9, teams: [team('s1', 'Dallas Cowboys')] }]),
  // Solely in break 2 → "Other orders" when break 9 is selected.
  order('b', 'Bob Beta', 'bob', [{ breakNumber: 2, teams: [team('s2', 'Chicago Bears')] }]),
  // Spans breaks 9 AND 10 → must NOT appear in the solely-9 group.
  order('c', 'Carol Gamma', 'carol', [
    { breakNumber: 9, teams: [team('s3', 'New York Giants')] },
    { breakNumber: 10, teams: [team('s4', 'Green Bay Packers')] },
  ]),
  // Bought nothing — only a giveaway, in break 9 → shows in "Only in Break #9"
  // AND is flagged "Giveaway only".
  order('d', 'Dave Delta', 'dave', [{ breakNumber: 9, teams: [team('s5', 'Miami Dolphins', { isGiveaway: true })] }]),
]

describe('OrderQueue renders', () => {
  it('renders the flat list, the break selector, and flags giveaway-only packages', () => {
    const html = renderToStaticMarkup(<OrderQueue initialOrders={ORDERS} />)
    expect(html).toContain('Alice Alpha')
    expect(html).toContain('Bob Beta')
    expect(html).toContain('Carol Gamma')
    expect(html).toContain('Dave Delta')
    expect(html).toContain('All breaks')       // the by-break selector
    expect(html).toContain('Break #9')          // an option for the derived break
    expect(html).toContain('Giveaway only')     // Dave's giveaway-only flag
  })

  it('groups "solely in the break" — multi-break orders are excluded', () => {
    const html = renderToStaticMarkup(<OrderQueue initialOrders={ORDERS} initialBreakFilter={9} />)
    // Alice (paid, solely 9) + Dave (giveaway-only, solely 9) = 2. Carol (9+10)
    // is NOT counted here — proving the "solely" rule (a "contains" rule would
    // give 3 here and 1 below).
    expect(html).toContain('Only in Break #9 — 2 packages')
    // Bob (solely 2) + Carol (9 & 10) = 2.
    expect(html).toContain('Other orders — 2')
    // Everyone still renders somewhere, and the giveaway-only flag survives.
    expect(html).toContain('Alice Alpha')
    expect(html).toContain('Carol Gamma')
    expect(html).toContain('Giveaway only')
  })
})
