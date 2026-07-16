// Regression tests for the "Combined Labels + Packing Slips" Whatnot export,
// whose compressed PDF exposed three parser gaps:
//   1. the breaking-slip "Break #N" header WRAPS ("…- Break" then "#N"),
//   2. some breaking-slip fonts CORRUPT the break-number digit (so the number
//      must be reconciled from the clean packing slip), and
//   3. the packing slip puts the team BEFORE "Order" ("1 Houston Astros Order…"),
//      not after "Break #N", and a "N Items" summary must never become a team.
// Also covers "Oakland Athletics" -> canonical "Athletics" (city-prefix match).
// PRIVACY: repo is public — every slip below is SYNTHETIC.
import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { parsePages } = require('../server/parser/index.cjs')

const slotsFor = (ds, handle) => ds.teamSlots.filter((t) => t.customerId === handle)

describe('combined labels + packing slips (compressed export)', () => {
  // A — breaking slip with a WRAPPED "Break #1" header + a city-prefixed team.
  const packA = `Whatnot Packing Slip 1/1
To: alice From: rm_cardz
Alice Adams
5 Main St
Seminole, FL 33772
15 July, 2026
QTY Name & Description Attributes Subtotal
1 Oakland Athletics Order 800001 $12.00
1x 2026 FINEST BASEBALL HOBBY BOX (NEW RELEASE!)- Break #1
1 Item $12.00
USPS Ground Advantage #9300120762602323770001 4.0 oz`
  const breakA = `Whatnot - Breaking Slip
User
Alice Adams (alice)
Orders
#800001
1 Break
1x 2026 FINEST BASEBALL HOBBY BOX (NEW RELEASE!)- Break
#1
Orders: #800001
1 Item
__ Oakland Athletics
Total: $12.00`

  // B — packing-ONLY customer; team sits before "Order" and a "1 Item" summary
  // line must not be captured as a team.
  const packB = `Whatnot Packing Slip 1/1
To: bob From: rm_cardz
Bob Barker
9 Oak Ave
Modesto, CA 95356
15 July, 2026
QTY Name & Description Attributes Subtotal
1 Houston Astros Order 800100 $26.00
1x 2026 FINEST BASEBALL HOBBY BOX (NEW RELEASE!)- Break #2
1 Item $26.00
USPS Ground Advantage #9300120762602323770100 7.0 oz`

  // C — breaking slip's break number is CORRUPTED to #1 (wrapped), but the clean
  // packing slip says Break #3; reconciliation must move the team to break 3.
  const packC = `Whatnot Packing Slip 1/1
To: carol From: rm_cardz
Carol Chen
7 Pine Rd
Riverview, FL 33578
15 July, 2026
QTY Name & Description Attributes Subtotal
1 Minnesota Twins Order 800200 $15.00
1x 2026 FINEST BASEBALL HOBBY BOX (NEW RELEASE!)- Break #3
1 Item $15.00
USPS Priority Mail #9305520762601310170200 10.0 oz`
  const breakC = `Whatnot - Breaking Slip
User
Carol Chen (carol)
Orders
#800200
1 Break
1x 2026 FINEST BASEBALL HOBBY BOX (NEW RELEASE!)- Break
#1
Orders: #800200
1 Item
__ Minnesota Twins
Total: $15.00`

  const ds = parsePages([packA, breakA, packB, packC, breakC], { sport: 'mlb' })

  it('stitches a wrapped "Break #N" header and matches a city-prefixed team', () => {
    const s = slotsFor(ds, 'alice')
    expect(s).toHaveLength(1)
    expect(s[0].breakNumber).toBe(1)
    expect(s[0].teamName).toBe('Athletics') // "Oakland Athletics" -> canonical
  })

  it('reads the team BEFORE "Order" on a packing-only slip and skips "N Items"', () => {
    const s = slotsFor(ds, 'bob')
    expect(s).toHaveLength(1)
    expect(s[0].breakNumber).toBe(2)
    expect(s[0].teamName).toBe('Houston Astros')
    // No team slot anywhere is an "N Item(s)" summary line.
    expect(ds.teamSlots.some((t) => /items?$/i.test(t.teamName))).toBe(false)
  })

  it('reconciles a corrupted breaking-slip break number against the packing slip', () => {
    const s = slotsFor(ds, 'carol')
    expect(s).toHaveLength(1)
    expect(s[0].teamName).toBe('Minnesota Twins')
    expect(s[0].breakNumber).toBe(3) // corrected from the corrupted "#1" to packing's #3
  })

  it('produces clean breaks with no garbage-team warnings', () => {
    expect(ds.breaks.map((b) => b.breakNumber).sort((a, b) => a - b)).toEqual([1, 2, 3])
    expect(ds.warnings).toEqual([])
  })
})
