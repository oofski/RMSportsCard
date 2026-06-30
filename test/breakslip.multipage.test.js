// =============================================================================
// Break Slip MULTI-PAGE fidelity tests (server/parser + db roll-ups).
//
// A real Whatnot order export interleaves, per customer, a "Whatnot Packing
// Slip" (the shipping label) and a "Whatnot - Breaking Slip" (the ground-truth
// pick document listing which teams went into which break). When a customer's
// breaking slip is long, it SPILLS ONTO MULTIPLE PHYSICAL PAGES — and Whatnot
// does NOT repeat the "Whatnot - Breaking Slip" header on those continuation
// pages. Two failures used to cascade from that:
//
//   (1) groupByCustomer() only attached a page to a customer if it matched the
//       packing-slip OR breaking-slip header, so a header-LESS continuation page
//       was classified as "neither" and DROPPED entirely — every break/team
//       after the first physical page was lost.
//   (2) parseBreakingSlip() reset its "current break" pointer to null at the
//       START of each page, so a break whose "Break #N" header was on one page
//       but whose "__ Team" lines continued on the NEXT page lost those teams
//       even when the page was attached.
//
// These tests reproduce that REAL failure STRUCTURE (multi-page split, header-
// less continuation page, a break header split from its teams across a page
// boundary, a blank separator page) and lock the recovery.
//
// PRIVACY: this repo is PUBLIC and the real export contains real customer
// names, addresses and USPS tracking numbers. NONE of that appears here — every
// handle, person name, street, order id and tracking number below is 100%
// INVENTED. (NFL team names are canonical league data the parser matches
// against, not customer PII.)
// =============================================================================
import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

const require = createRequire(import.meta.url)
const { parsePages } = require('../server/parser/index.cjs')
const { Store } = require('../server/store.cjs')
const { Db } = require('../server/db.cjs')

const slotsFor = (ds, handle) => ds.teamSlots.filter((t) => t.customerId === handle)
const byBreak = (ds, handle) => {
  const out = {}
  slotsFor(ds, handle).forEach((s) => {
    out[s.breakNumber] = (out[s.breakNumber] || []).concat(s.teamName)
  })
  return out
}

function importPagesToDb(pages) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rmcardz-mp-'))
  const db = new Db(new Store(dir))
  db.importDataset(parsePages(pages))
  return db
}

describe('multi-page breaking slip: header-less continuation page', () => {
  // Mirrors real pages 8/9/14/25: a breaking slip's first page carries the
  // "Whatnot - Breaking Slip" header and Break #1; the SECOND page has NO header
  // (begins straight with "Total:" / a new "Break #N") and carries more teams.
  // Pre-fix, that header-less page was "neither slip" and got dropped, losing
  // every team after Break #1. (Invented handle/name/team data.)
  const PAGES = [
    // packing slip (identity) — invented PII
    `Whatnot Packing Slip 1/1
To: zephyrpacks From: rm_cardz
Quinn Halloway COSMIC FOOTBALL MARATHON!
12 Lantern Row. Maple Hollow, ZZ. STARTING AT $1!
00001-0001. US 27 June, 2026
QTY Name & Description Attributes Subtotal
1 Order 9000000001 $20.00
Pittsburgh Steelers Break #1
1 Order 9000000002 $20.00
Minnesota Vikings Break #2
USPS Ground Advantage #9911111111111111111111 7.0 oz`,
    // breaking slip — PAGE A: header + Break #1 only
    `Whatnot - Breaking Slip
User
Quinn Halloway (zephyrpacks)
Orders
#9000000001 #9000000002
2 Breaks
Break #1
Orders: #9000000001
1 Item
__ Pittsburgh Steelers
Notes`,
    // breaking slip — PAGE B: NO HEADER (header-less continuation). Begins with
    // Total: then a fresh Break #2 + its team. This is the page pre-fix dropped.
    `Total: $20.00
Break #2
Orders: #9000000002
1 Item
__ Minnesota Vikings
Notes
Total: $20.00`,
  ]

  it('recovers the continuation page teams instead of dropping them', () => {
    const ds = parsePages(PAGES)
    const teams = slotsFor(ds, 'zephyrpacks').map((s) => s.teamName).sort()
    // Pre-fix this was just ['Pittsburgh Steelers'] — the continuation was lost.
    expect(teams).toEqual(['Minnesota Vikings', 'Pittsburgh Steelers'])
  })

  it('keeps the continuation teams attached to the RIGHT break', () => {
    const ds = parsePages(PAGES)
    const m = byBreak(ds, 'zephyrpacks')
    expect(m[1]).toEqual(['Pittsburgh Steelers'])
    expect(m[2]).toEqual(['Minnesota Vikings'])
    expect(ds.breaks.map((b) => b.breakNumber)).toEqual([1, 2])
  })
})

describe('multi-page breaking slip: break header split from its teams', () => {
  // Mirrors the real multi-break buyer whose final break header sat at the very
  // bottom of one page while its "__ Team" lines spilled onto the NEXT
  // (header-less) page.
  // Pre-fix, parseBreakingSlip reset `current` to null at the top of every page,
  // so those spilled teams attached to no break and were dropped. (Invented data.)
  const PAGES = [
    `Whatnot Packing Slip 1/1
To: orbitalbreaks From: rm_cardz
Reyna Ostwood COSMIC FOOTBALL MARATHON!
8 Cinder Lane. Fox Glen, ZZ. STARTING AT $1!
00002-0002. US 27 June, 2026
QTY Name & Description Attributes Subtotal
1 Order 9000000010 $15.00
Houston Texans Break #3
1 Order 9000000011 $15.00
Tennessee Titans Break #3
USPS Ground Advantage #9922222222222222222222 7.0 oz`,
    // breaking slip — PAGE A: header + Break #3 HEADER ONLY (teams spill over).
    `Whatnot - Breaking Slip
User
Reyna Ostwood (orbitalbreaks)
Orders
#9000000010 #9000000011
1 Breaks
Break #3
Orders: #9000000010 #9000000011`,
    // breaking slip — PAGE B: NO HEADER, NO "Break #N" — just the spilled teams.
    `2 Items
__ Houston Texans
__ Tennessee Titans
Notes
Total: $30.00`,
  ]

  it('attaches teams that spilled onto the next page to the same break', () => {
    const ds = parsePages(PAGES)
    const m = byBreak(ds, 'orbitalbreaks')
    // Pre-fix: Break #3 had zero teams (current reset at the page boundary).
    expect(m[3].sort()).toEqual(['Houston Texans', 'Tennessee Titans'])
    // No phantom extra breaks were created by the split.
    expect(Object.keys(m)).toEqual(['3'])
  })
})

describe('multi-break customer split across THREE pages', () => {
  // Mirrors the real multi-break buyer: breaks 1, 4 and 5 spread across three
  // physical breaking-slip pages, with the Break #5 header on page 2 and its
  // teams on page 3. All teams across all breaks must be captured and grouped,
  // and the customer must be flagged multiCard via db.listOrders(). (Invented.)
  const PAGES = [
    // packing slip 1/2
    `Whatnot Packing Slip 1/2
To: tridentcards From: rm_cardz
Marlo Pfeatherby COSMIC FOOTBALL MARATHON!
44 Harbor Mews. Tide Point, ZZ. STARTING AT $1!
00003-0003. US 27 June, 2026
QTY Name & Description Attributes Subtotal
1 Order 9000000100 $31.00
Los Angeles Chargers Break #1
1 Denver Broncos Order 9000000101 $30.00 Break #4
1 Green Bay Packers Order 9000000102 $31.00 Break #4
USPS Priority Mail #9933333333333333333333 42.0 oz`,
    // packing slip 2/2
    `Whatnot Packing Slip 2/2
1 Detroit Lions Order 9000000103 $25.00 Break #4
1 Kansas City Chiefs Order 9000000104 $12.00 Break #5
1 New Orleans Saints Order 9000000105 $21.00 Break #5
6 Items $150.00
USPS Priority Mail #9933333333333333333333 42.0 oz`,
    // breaking slip — PAGE A: header + Break #1
    `Whatnot - Breaking Slip
User
Marlo Pfeatherby (tridentcards)
Orders
#9000000100 #9000000101 #9000000102
#9000000103 #9000000104 #9000000105
3 Breaks
Break #1
Orders: #9000000100
1 Item
__ Los Angeles Chargers
Notes`,
    // breaking slip — PAGE B: NO HEADER. Closes Break #1, full Break #4, then
    // the Break #5 HEADER at the very bottom (its teams spill to page C).
    `Total: $31.00
Break #4
Orders: #9000000101 #9000000102
#9000000103
3 Items
__ Denver Broncos
__ Green Bay Packers
__ Detroit Lions
Notes
Total: $86.00
Break #5`,
    // breaking slip — PAGE C: NO HEADER, NO "Break #N" — Break #5's spilled teams.
    `Orders: #9000000104 #9000000105
2 Items
__ Kansas City Chiefs
__ New Orleans Saints
Notes
Total: $33.00`,
  ]

  it('captures every team across every break, grouped correctly', () => {
    const ds = parsePages(PAGES)
    const m = byBreak(ds, 'tridentcards')
    expect(m[1]).toEqual(['Los Angeles Chargers'])
    expect(m[4]).toEqual(['Denver Broncos', 'Green Bay Packers', 'Detroit Lions'])
    expect(m[5]).toEqual(['Kansas City Chiefs', 'New Orleans Saints'])
    expect(ds.breaks.map((b) => b.breakNumber)).toEqual([1, 4, 5])
    expect(slotsFor(ds, 'tridentcards').length).toBe(6)
    // No phantom collisions from the page splits.
    expect(ds.breakAudit.flatMap((a) => a.collisions)).toEqual([])
  })

  it('flags the customer multiCard via db.listOrders()', () => {
    const db = importPagesToDb(PAGES)
    const o = db.listOrders().find((x) => x.customerId === 'tridentcards')
    expect(o).toBeTruthy()
    expect(o.cardCount).toBe(6)
    expect(o.breakCount).toBe(3)
    expect(o.multiCard).toBe(true)
  })
})

describe('blank page between customers does not corrupt grouping', () => {
  // A truly blank separator page sits between two customers' breaking slips. It
  // must NOT orphan the preceding continuation NOR bleed the previous customer's
  // "current slip" into the next customer. (Invented handle/name/team data.)
  const PAGES = [
    // customer 1: header page + header-less continuation page
    `Whatnot - Breaking Slip
User
Dale Brimwood (cobaltbreaks)
Orders
#9000000200 #9000000201
2 Breaks
Break #1
Orders: #9000000200
1 Item
__ Buffalo Bills
Notes`,
    `Total: $20.00
Break #2
Orders: #9000000201
1 Item
__ New York Jets
Notes
Total: $20.00`,
    // a blank separator page (whitespace only)
    `
   `,
    // customer 2: its own single-page breaking slip
    `Whatnot - Breaking Slip
User
Faye Underhill (saffronpacks)
Orders
#9000000210
1 Breaks
Break #1
Orders: #9000000210
1 Item
__ Cleveland Browns
Total: $20.00`,
  ]

  it('keeps each customer\'s teams intact across the blank page', () => {
    const ds = parsePages(PAGES)
    // Customer 1 keeps BOTH breaks (the continuation page survived the blank).
    expect(byBreak(ds, 'cobaltbreaks')).toEqual({ 1: ['Buffalo Bills'], 2: ['New York Jets'] })
    // Customer 2 is clean and separate — no bleed of customer 1's teams.
    expect(byBreak(ds, 'saffronpacks')).toEqual({ 1: ['Cleveland Browns'] })
  })

  it('does not invent extra customers from the blank page', () => {
    const ds = parsePages(PAGES)
    expect(ds.customers.map((c) => c.id).sort()).toEqual(['cobaltbreaks', 'saffronpacks'])
  })
})

describe('regression guard: single-page breaking slip still works', () => {
  // The common case — a customer whose entire breaking slip fits on ONE page
  // (header + all breaks + Total). The multi-page fix must not regress this.
  // (Invented handle/name/team data.)
  const PAGE = `Whatnot - Breaking Slip
User
Iris Kettleby (singlepage)
Orders
#9000000300 #9000000301 #9000000302
2 Breaks
Break #1
Orders: #9000000300 #9000000301
1 Item
__ Las Vegas Raiders
__ Arizona Cardinals
Break #4
Orders: #9000000302
1 Item
__ Carolina Panthers
Total: $90.00`

  it('parses all breaks and teams from a single page', () => {
    const ds = parsePages([PAGE])
    const m = byBreak(ds, 'singlepage')
    expect(m[1]).toEqual(['Las Vegas Raiders', 'Arizona Cardinals'])
    expect(m[4]).toEqual(['Carolina Panthers'])
    expect(ds.breaks.map((b) => b.breakNumber)).toEqual([1, 4])
    expect(slotsFor(ds, 'singlepage').length).toBe(3)
  })

  it('flags the single-page multi-team buyer multiCard via db.listOrders()', () => {
    const db = importPagesToDb([PAGE])
    const o = db.listOrders().find((x) => x.customerId === 'singlepage')
    expect(o.cardCount).toBe(3)
    expect(o.breakCount).toBe(2)
    expect(o.multiCard).toBe(true)
  })
})
