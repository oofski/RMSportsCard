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
  slotId, teamName: name, price: 0, checkedOff: false, topSleeved: false, isGiveaway: false, ...opts,
})

// A synthetic order row; the multi-card / giveaway / sleeve counts are derived
// from the team slots exactly as the backend derives them.
function order(id, name, handle, breaks, specialRequest = null) {
  const slots = breaks.flatMap((b) => b.teams)
  const cardCount = slots.length
  const giveawayCount = slots.filter((t) => t.isGiveaway).length
  // Inject per-break subtotals + the order total, exactly as db._orderRow does.
  breaks = breaks.map((b) => ({ ...b, value: b.teams.reduce((n, t) => n + (Number(t.price) || 0), 0) }))
  const value = slots.reduce((n, t) => n + (Number(t.price) || 0), 0)
  return {
    value,
    id,
    customerId: handle,
    customer: { handle, realName: name, address: '', isNew: false },
    trackingNumber: 'T' + id,
    serviceType: 'Priority',
    uspsUrl: 'https://example.test/' + id,
    notes: null,
    specialRequest,
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
  // Also carries a special request → red banner pinned to the top of the card.
  order('a', 'Alice Alpha', 'alice', [{ breakNumber: 9, teams: [team('s1', 'Dallas Cowboys', { price: 25 })] }],
    { text: 'Ship in a team bag', setAt: '2026-07-01T00:00:00.000Z', setBy: 'owner' }),
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
    expect(html).toContain('Collapse all')      // the expand/collapse-all toggle (default expanded)
    expect(html).toContain('$25.00')            // Alice's order value badge
  })

  it('expands orders by default and pins a special request at the top', () => {
    const html = renderToStaticMarkup(<OrderQueue initialOrders={ORDERS} />)
    // Team chips live in the drop-down detail; their presence in flat view (with
    // no click) proves orders render EXPANDED by default (item 1).
    expect(html).toContain('Dallas Cowboys')
    expect(html).toContain('Green Bay Packers')
    // The special request banner + its text render red-pinned above the order (item 2).
    expect(html).toContain('Special request')
    expect(html).toContain('Ship in a team bag')
  })

  it('keeps a paid single-break order in its ready group despite a break-less giveaway rider', () => {
    // A paid card in Break #9 + a break-less promo giveaway (breakNumber null).
    // The giveaway ships in the same package, so the order must stay in
    // "Only in Break #9", not get demoted to "Other orders".
    const withRider = [
      order('r', 'Rider Rick', 'rick', [
        { breakNumber: 9, teams: [team('p1', 'Dallas Cowboys')] },
        { breakNumber: null, teams: [team('g1', 'Mystery Box', { isGiveaway: true })] },
      ]),
    ]
    const html = renderToStaticMarkup(<OrderQueue initialOrders={withRider} initialBreakFilter={9} />)
    expect(html).toContain('Only in Break #9 — 1 package') // stayed in the ready group
    expect(html).toContain('Other orders — 0')
    expect(html).toContain('Rider Rick')
    expect(html).toContain('🎁 Giveaway') // the break-less rider renders under its own header
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
