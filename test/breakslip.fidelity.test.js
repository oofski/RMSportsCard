// =============================================================================
// Break Slip parsing FIDELITY tests (server/parser + db roll-ups).
//
// The breaking slip is ground truth for "which teams a customer won in which
// break". Real Whatnot PDFs render the picker's checkbox inconsistently (plain
// underscores, a box glyph, or — when the glyph font doesn't survive text
// extraction — nothing at all) and have printed the header as both "Breaking
// Slip" and "Break Slip". If any of those variants is missed, teams silently
// vanish and a break no longer reconstructs all 32 NFL teams. These tests lock
// the format-tolerant recovery, the per-break 32-team audit, the one-team-per-
// break collision warning, and the multi-card alarm flag.
//
// PRIVACY: every fixture below is fully synthetic.
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
const auditFor = (ds, n) => ds.breakAudit.find((a) => a.breakNumber === n)

describe('breaking-slip format tolerance', () => {
  it('recovers teams when the checkbox glyph did NOT survive extraction (bare names)', () => {
    const page = `Whatnot - Breaking Slip
User
No Checkbox (nocb)
#1
1 Breaks
Break #1
Orders: #1
1 Item
Seattle Seahawks
Total: $26.00`
    const ds = parsePages([page])
    const teams = slotsFor(ds, 'nocb').map((s) => s.teamName)
    expect(teams).toEqual(['Seattle Seahawks'])
  })

  it('accepts the alternate "Whatnot - Break Slip" header as ground truth', () => {
    const page = `Whatnot - Break Slip
User
Alt Header (althdr)
#2
1 Breaks
Break #1
Orders: #2
__ Dallas Cowboys
Total: $30.00`
    const ds = parsePages([page])
    expect(slotsFor(ds, 'althdr').map((s) => s.teamName)).toEqual(['Dallas Cowboys'])
  })

  it('accepts a Unicode box-glyph checkbox', () => {
    const page = `Whatnot - Breaking Slip
User
Glyph Box (glyph)
#3
1 Breaks
Break #1
Orders: #3
☐ Green Bay Packers
☑ Detroit Lions
Total: $50.00`
    const ds = parsePages([page])
    expect(slotsFor(ds, 'glyph').map((s) => s.teamName).sort()).toEqual(['Detroit Lions', 'Green Bay Packers'])
  })

  it('does NOT promote structural lines (Orders/Total/Item counts) to teams', () => {
    const page = `Whatnot - Breaking Slip
User
Clean Section (clean)
#4
1 Breaks
Break #1
Orders: #4
1 Item
__ Chicago Bears
Total: $20.00`
    const ds = parsePages([page])
    expect(slotsFor(ds, 'clean').map((s) => s.teamName)).toEqual(['Chicago Bears'])
  })

  it('keeps multiple breaks for one customer separate (no cross-break bleed)', () => {
    const page = `Whatnot - Breaking Slip
User
Multi Break (multi)
#5 #6 #7
3 Breaks
Break #1
Orders: #5
Kansas City Chiefs
Break #4
Orders: #6
Las Vegas Raiders
Break #5
Orders: #7
Miami Dolphins
Total: $99.00`
    const ds = parsePages([page])
    const byBreak = {}
    slotsFor(ds, 'multi').forEach((s) => { byBreak[s.breakNumber] = (byBreak[s.breakNumber] || []).concat(s.teamName) })
    expect(byBreak[1]).toEqual(['Kansas City Chiefs'])
    expect(byBreak[4]).toEqual(['Las Vegas Raiders'])
    expect(byBreak[5]).toEqual(['Miami Dolphins'])
  })
})

describe('per-break 32-team fidelity audit', () => {
  // One break shared by two customers (no collision): 3 distinct teams of 32.
  const PAGES = [
    `Whatnot - Breaking Slip
User
Buyer One (one)
#10
1 Breaks
Break #1
Orders: #10
__ Philadelphia Eagles
__ Dallas Cowboys
Total: $60.00`,
    `Whatnot - Breaking Slip
User
Buyer Two (two)
#11
1 Breaks
Break #1
Orders: #11
__ New York Giants
Total: $25.00`,
  ]

  it('reports captured vs missing teams against the full 32', () => {
    const ds = parsePages(PAGES)
    const a = auditFor(ds, 1)
    expect(a.maxTeams).toBe(32)
    expect(a.distinctTeamCount).toBe(3)
    expect(a.missingCount).toBe(29)
    expect(a.hasAll32).toBe(false)
    expect(a.missingTeams).toContain('Kansas City Chiefs')
    expect(a.missingTeams).not.toContain('Dallas Cowboys')
  })

  it('flags hasAll32 only when every one of the 32 teams is present', () => {
    const { CANONICAL } = require('../server/parser/teams.cjs')
    const lines = CANONICAL.map((t) => `__ ${t}`).join('\n')
    const page = `Whatnot - Breaking Slip
User
Whale Buyer (whale)
#12
1 Breaks
Break #1
Orders: #12
${lines}
Total: $999.00`
    const ds = parsePages([page])
    const a = auditFor(ds, 1)
    expect(a.distinctTeamCount).toBe(32)
    expect(a.missingCount).toBe(0)
    expect(a.hasAll32).toBe(true)
  })
})

describe('one-team-per-break collision detection', () => {
  it('warns when the same team is sold to two customers in one break', () => {
    const PAGES = [
      `Whatnot - Breaking Slip
User
Owner A (owna)
#20
1 Breaks
Break #1
Orders: #20
__ Chicago Bears
Total: $20.00`,
      `Whatnot - Breaking Slip
User
Owner B (ownb)
#21
1 Breaks
Break #1
Orders: #21
__ Chicago Bears
Total: $22.00`,
    ]
    const ds = parsePages(PAGES)
    const a = auditFor(ds, 1)
    expect(a.collisions.length).toBe(1)
    expect(a.collisions[0].team).toBe('Chicago Bears')
    expect(a.collisions[0].customers.sort()).toEqual(['owna', 'ownb'])
    expect(ds.warnings.some((w) => /assigned to 2 customers/i.test(w.message))).toBe(true)
  })
})

describe('multi-card alarm flag (db.listOrders)', () => {
  function importPagesToDb(pages) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rmcardz-bs-'))
    const db = new Db(new Store(dir))
    db.importDataset(parsePages(pages))
    return db
  }

  it('flags a customer with more than one card and not a single-card one', () => {
    const PAGES = [
      // multi: 3 cards across two breaks
      `Whatnot - Breaking Slip
User
Multi Card (multicard)
#30 #31 #32
2 Breaks
Break #1
Orders: #30 #31
__ Buffalo Bills
__ New York Jets
Break #2
Orders: #32
__ Miami Dolphins
Total: $90.00`,
      // single: 1 card
      `Whatnot - Breaking Slip
User
Single Card (singlecard)
#33
1 Breaks
Break #1
Orders: #33
__ Cleveland Browns
Total: $20.00`,
    ]
    const db = importPagesToDb(PAGES)
    const orders = db.listOrders()
    const multi = orders.find((o) => o.customerId === 'multicard')
    const single = orders.find((o) => o.customerId === 'singlecard')
    expect(multi.cardCount).toBe(3)
    expect(multi.multiCard).toBe(true)
    expect(single.cardCount).toBe(1)
    expect(single.multiCard).toBe(false)
  })
})
