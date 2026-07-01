// =============================================================================
// Unit tests for the Whatnot ledger parser + analytics (server/ledger.cjs).
//
// PRIVACY NOTE: this repo is PUBLIC. Every byte of CSV below is a SYNTHETIC
// fixture invented for the test — it contains NO data from any real ledger.
// The fixture is hand-crafted to exercise each parsing/classification rule.
// =============================================================================
import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { parseLedgerRows, analyzeLedger, _internal } = require('../server/ledger.cjs')

// A small, fully synthetic ledger. Columns (Whatnot order):
//   Created Date, Amount, Listing ID, Order ID, Message, Status,
//   Transaction Type, Completed Date
//
// We deliberately include, in order:
//   1. an earning  "Break #1 - Lions"            (product "Topps Chrome")
//   2. an earning  "BREAK #1 - Bears" (UPPERCASE) same product -> case-insens.
//      grouping must collapse (Topps Chrome, break 1) to ONE (product,break)
//   3. a "2x " qty-prefixed earning (qty stripped from product label)
//   4. an earning with NO break number          -> unattributed
//   5. a $0.00 giveaway
//   6. a -$4.29 giveaway
//   7. a Shipping Subsidy ADJUSTMENT
//   8. a TIP
//   9. a PAYOUT (ignored entirely)
//  10. the malformed >8-column "Show Boost" row whose Message has unescaped
//      inner quotes AND commas (an ADJUSTMENT) -> must be repaired, not split.
const HEADER = '"Created Date","Amount","Listing ID","Order ID","Message","Status","Transaction Type","Completed Date"'
const SYNTHETIC_ROWS = [
  // 1) earning, lower-case "Break #1"
  '"Jun 20, 2026, 1:00:00 PM","$50.00","100","200","Earnings for selling a 1x Topps Chrome Break #1 - Lions","completed","SALES","Jun 20, 2026, 1:00:01 PM"',
  // 2) earning, UPPER-case "BREAK #1", SAME product -> same (product,break)
  '"Jun 20, 2026, 2:00:00 PM","$30.00","101","201","Earnings for selling a 1x Topps Chrome BREAK #1 - Bears","completed","SALES","Jun 20, 2026, 2:00:01 PM"',
  // 3) earning with "2x " qty prefix -> product label must NOT contain "2x"
  '"Jun 21, 2026, 3:00:00 PM","$80.00","102","202","Earnings for selling a 2x Topps Chrome Break #2 - Packers","completed","SALES","Jun 21, 2026, 3:00:01 PM"',
  // 4) earning with NO break -> unattributed
  '"Jun 21, 2026, 4:00:00 PM","$25.00","103","203","Earnings for selling a 1x Mystery Box","completed","SALES","Jun 21, 2026, 4:00:01 PM"',
  // 5) $0.00 giveaway
  '"Jun 21, 2026, 5:00:00 PM","$0.00","104","204","Charged deduction of $0.00 for giveaway order 555","completed","SALES","Jun 21, 2026, 5:00:01 PM"',
  // 6) -$4.29 giveaway
  '"Jun 22, 2026, 6:00:00 PM","-$4.29","105","205","Charged deduction of $4.29 for giveaway order 556","completed","SALES","Jun 22, 2026, 6:00:01 PM"',
  // 7) Shipping Subsidy ADJUSTMENT (excluded from revenue)
  '"Jun 22, 2026, 7:00:00 PM","$2.50","106","206","Shipping Subsidy","completed","ADJUSTMENT","Jun 22, 2026, 7:00:01 PM"',
  // 8) TIP (excluded from revenue)
  '"Jun 22, 2026, 8:00:00 PM","$10.00","","","Tip from buyer","completed","TIP","Jun 22, 2026, 8:00:01 PM"',
  // 9) PAYOUT (ignored entirely — not in any revenue/date range)
  '"Jun 29, 2026, 9:00:00 PM","-$1,234.56","","","Payout request: STRIPE acct_test","completed","PAYOUT","Jun 29, 2026, 9:00:01 PM"',
  // 10) MALFORMED >8-col ADJUSTMENT: Message has unescaped inner quotes + commas.
  //     A naive CSV split yields >8 fields; the repair keeps first 4 + last 3 and
  //     re-joins the middle. The known-good signal: its Transaction Type is
  //     ADJUSTMENT, NOT the stray phrase "CACTUS JACK BASKETBALL" inside the msg.
  '"Jun 23, 2026, 10:00:00 PM","$3.00","107","207","Show Boost: seller said "CACTUS JACK BASKETBALL, hoops, prizm" promo","completed","ADJUSTMENT","Jun 23, 2026, 10:00:01 PM"',
]
const CSV = '﻿' + [HEADER, ...SYNTHETIC_ROWS].join('\n') + '\n'

describe('parseLedgerRows', () => {
  const { rows, warnings } = parseLedgerRows(CSV)

  it('classifies each row into the right bucket', () => {
    const counts = rows.reduce((acc, r) => { acc[r.type] = (acc[r.type] || 0) + 1; return acc }, {})
    expect(counts.earning).toBe(4)        // rows 1,2,3,4
    expect(counts.giveaway).toBe(2)       // rows 5,6
    expect(counts.adjustment).toBe(2)     // rows 7,10 (the repaired one)
    expect(counts.tip).toBe(1)            // row 8
    expect(counts.payout_ignored).toBe(1) // row 9
    expect(counts.other).toBeUndefined()  // nothing falls through
  })

  it('strips the qty prefix from the product label', () => {
    const r = rows.find((x) => x.breakNumber === 2)
    expect(r.product).toBe('Topps Chrome') // "2x " must be gone
    expect(r.product).not.toMatch(/2x/i)
  })

  it('repairs the malformed >8-column row (does NOT split it)', () => {
    // The repaired row's Transaction Type must be ADJUSTMENT, and the inner
    // phrase must live in the Message, not leak into the type column.
    const repaired = rows.find((r) => r.type === 'adjustment' && /CACTUS JACK/i.test(r.message))
    expect(repaired).toBeTruthy()
    expect(repaired.type).toBe('adjustment')
    expect(repaired.type).not.toBe('cactus jack basketball')
    expect(repaired.amount).toBe(3) // first/last columns survived the repair
    // A warning records the repair.
    expect(warnings.some((w) => /repaired/i.test(w))).toBe(true)
  })

  it('parses amounts incl. leading minus + thousands commas', () => {
    expect(rows.find((r) => r.type === 'payout_ignored').amount).toBe(-1234.56)
    expect(rows.find((r) => r.message.includes('$0.00')).amount).toBe(0)
    expect(rows.find((r) => r.type === 'giveaway' && r.amount < 0).amount).toBe(-4.29)
  })
})

describe('analyzeLedger', () => {
  const { rows } = parseLedgerRows(CSV)
  const a = analyzeLedger(rows, { breaksPerCase: 9 })

  it('tallies bucket totals correctly', () => {
    // grossEarnings = 50 + 30 + 80 + 25 = 185
    expect(a.totals.grossEarnings).toBe(185)
    expect(a.totals.earningCount).toBe(4)
    // giveawayLost = 0 + (-4.29) = -4.29
    expect(a.totals.giveawayLost).toBe(-4.29)
    expect(a.totals.giveawayCount).toBe(2)
  })

  it('netRevenue == grossEarnings + giveawayLost', () => {
    expect(a.totals.netRevenue).toBe(a.totals.grossEarnings + a.totals.giveawayLost)
    expect(a.totals.netRevenue).toBe(180.71)
  })

  it('excludes payouts from all revenue', () => {
    // Payout is counted + summed for reference only — never in net/gross.
    expect(a.totals.payoutsIgnoredCount).toBe(1)
    expect(a.totals.payoutsIgnoredSum).toBe(-1234.56)
    expect(a.totals.grossEarnings).toBe(185) // payout not added
  })

  it('excludes adjustments and tips from revenue', () => {
    // adjustments = 2.50 + 3.00 = 5.50 (tracked separately, NOT in net)
    expect(a.totals.adjustments).toBe(5.5)
    expect(a.totals.tips).toBe(10)
    expect(a.totals.netRevenue).toBe(180.71) // unaffected by adjustments/tips
  })

  it('collapses case-insensitive break labels into ONE (product,break)', () => {
    // Rows 1 ("Break #1") and 2 ("BREAK #1") share product "Topps Chrome".
    const tcBreak1 = a.perBreak.filter((b) => b.product === 'Topps Chrome' && b.breakNumber === 1)
    expect(tcBreak1.length).toBe(1)         // collapsed, not two rows
    expect(tcBreak1[0].count).toBe(2)       // both earnings landed here
    expect(tcBreak1[0].revenue).toBe(80)    // 50 + 30
  })

  it('captures earnings with no break as unattributed', () => {
    // "Mystery Box" ($25) has no Break #N.
    expect(a.unattributed.count).toBe(1)
    expect(a.unattributed.revenue).toBe(25)
  })

  it('reconciles: grossEarnings == attributedRevenue + unattributed.revenue', () => {
    expect(a.totals.grossEarnings).toBe(a.perCase.attributedRevenue + a.unattributed.revenue)
  })

  it('computes per-case math; breaksPerCase changes cases but not perBreak', () => {
    // Topps Chrome has 2 distinct breaks (#1, #2); Mystery Box is unattributed.
    const tc9 = a.perCase.byProduct.find((p) => p.product === 'Topps Chrome')
    expect(tc9.breaks).toBe(2)
    expect(tc9.cases).toBe(1)               // ceil(2/9) = 1
    expect(a.perCase.totalBreaks).toBe(2)
    expect(a.perCase.totalCases).toBe(1)

    const a4 = analyzeLedger(rows, { breaksPerCase: 4 })
    const tc4 = a4.perCase.byProduct.find((p) => p.product === 'Topps Chrome')
    expect(tc4.breaks).toBe(2)
    expect(tc4.cases).toBe(1)               // ceil(2/4) = 1 (only 2 breaks here)
    // perBreak content is independent of breaksPerCase.
    expect(a4.perBreak).toEqual(a.perBreak)
  })

  it('changing breaksPerCase changes totalCases when breaks exceed a case', () => {
    // Synthesize 10 distinct breaks for one product to make case math bite.
    const many = []
    for (let i = 1; i <= 10; i++) {
      many.push({ type: 'earning', dayKey: '2026-06-20', amount: 10, message: '',
        product: 'Mega Box', productKey: 'MEGA BOX', breakNumber: i, team: null })
    }
    const big9 = analyzeLedger(many, { breaksPerCase: 9 })
    const big4 = analyzeLedger(many, { breaksPerCase: 4 })
    expect(big9.perCase.totalCases).toBe(2) // ceil(10/9) = 2
    expect(big4.perCase.totalCases).toBe(3) // ceil(10/4) = 3
  })

  it('derives the date range from COUNTED rows only', () => {
    // Counted rows (earning + giveaway) span Jun 20 -> Jun 22. The PAYOUT on
    // Jun 29 and ADJUSTMENT/TIP rows on Jun 22/23 must NOT extend the range
    // beyond what counted rows cover (Jun 22 is the last counted day).
    expect(a.dateRange.start).toBe('2026-06-20')
    expect(a.dateRange.end).toBe('2026-06-22')
    expect(a.dateRange.days).toBe(3) // 20,21,22 inclusive
  })

  it('produces perDay sorted ascending with net = gross + giveaway', () => {
    const days = a.perDay.map((d) => d.day)
    expect(days).toEqual([...days].sort())
    for (const d of a.perDay) {
      expect(d.net).toBe(Math.round((d.gross + d.giveaway) * 100) / 100)
    }
  })
})

// =============================================================================
// FEATURE 3 — perBreak grouping by (day, product, break) with a human label.
//
// This fixture is DISTINCT from the one above: it puts the SAME break number
// (#8) on TWO different days for the SAME product, plus a long Whatnot-style
// product string, so we can prove the (day,product,break) grouping keeps them
// separate and that the label carries a simplified product name + the date.
// Fully SYNTHETIC — no real ledger data.
// =============================================================================
const MULTIDAY_HEADER = '"Created Date","Amount","Listing ID","Order ID","Message","Status","Transaction Type","Completed Date"'
const MULTIDAY_ROWS = [
  // Break #8, "Cosmic Chrome", on Jun 28 (two orders -> one grouped entry)
  '"Jun 28, 2026, 1:00:00 PM","$40.00","300","400","Earnings for selling a 1x COSMIC CHROME FOOTBALL HOBBY BOX- CHASE PLANETARY PURSUIT Break #8 - Bears","completed","SALES","Jun 28, 2026, 1:00:01 PM"',
  '"Jun 28, 2026, 1:05:00 PM","$60.00","301","401","Earnings for selling a 1x COSMIC CHROME FOOTBALL HOBBY BOX- CHASE PLANETARY PURSUIT Break #8 - Lions","completed","SALES","Jun 28, 2026, 1:05:01 PM"',
  // Break #8, SAME product, but on Jun 29 -> MUST stay a SEPARATE entry
  '"Jun 29, 2026, 2:00:00 PM","$25.00","302","402","Earnings for selling a 1x COSMIC CHROME FOOTBALL HOBBY BOX- CHASE PLANETARY PURSUIT Break #8 - Packers","completed","SALES","Jun 29, 2026, 2:00:01 PM"',
  // A different break (#3) of a different product on Jun 28, for sort/breakdown.
  '"Jun 28, 2026, 3:00:00 PM","$70.00","303","403","Earnings for selling a 1x TIER ONE BASEBALL - NEW RELEASE!! Break #3 - Reds","completed","SALES","Jun 28, 2026, 3:00:01 PM"',
]
const MULTIDAY_CSV = '﻿' + [MULTIDAY_HEADER, ...MULTIDAY_ROWS].join('\n') + '\n'

describe('perBreak grouping by (day, product, break) with label', () => {
  const { rows } = parseLedgerRows(MULTIDAY_CSV)
  const a = analyzeLedger(rows, { breaksPerCase: 9 })

  it('keeps the SAME break number on different days as SEPARATE entries', () => {
    // Break #8 of the Cosmic Chrome product exists on Jun 28 AND Jun 29.
    const break8 = a.perBreak.filter((b) => b.breakNumber === 8)
    expect(break8.length).toBe(2) // NOT merged into one
    const days = break8.map((b) => b.day).sort()
    expect(days).toEqual(['2026-06-28', '2026-06-29'])
  })

  it('carries per-entry day, revenue, and count grouped by (day,product,break)', () => {
    const jun28 = a.perBreak.find((b) => b.breakNumber === 8 && b.day === '2026-06-28')
    const jun29 = a.perBreak.find((b) => b.breakNumber === 8 && b.day === '2026-06-29')
    // Jun 28 got two orders (40 + 60); Jun 29 got one (25).
    expect(jun28.revenue).toBe(100)
    expect(jun28.count).toBe(2)
    expect(jun29.revenue).toBe(25)
    expect(jun29.count).toBe(1)
  })

  it('labels each entry "Break N · <SimplifiedProduct> · Mon D"', () => {
    const jun28 = a.perBreak.find((b) => b.breakNumber === 8 && b.day === '2026-06-28')
    const jun29 = a.perBreak.find((b) => b.breakNumber === 8 && b.day === '2026-06-29')
    // Long "COSMIC CHROME FOOTBALL HOBBY BOX- ..." simplifies to "Cosmic Chrome".
    expect(jun28.label).toBe('Break 8 · Cosmic Chrome · Jun 28')
    expect(jun29.label).toBe('Break 8 · Cosmic Chrome · Jun 29')
    // Structural check: matches the documented shape for ANY entry.
    for (const b of a.perBreak) {
      expect(b.label).toMatch(/^Break \d+ · .+ · [A-Z][a-z]{2} \d+$/)
    }
  })

  it('preserves the full display product (not the simplified label)', () => {
    const jun28 = a.perBreak.find((b) => b.breakNumber === 8 && b.day === '2026-06-28')
    // `product` is the ungrouped display string; `label` holds the short name.
    expect(jun28.product).toMatch(/COSMIC CHROME FOOTBALL HOBBY BOX/)
  })
})

describe('simplifyProduct — deterministic short label from a long string', () => {
  const { simplifyProduct } = _internal

  it('shortens a long Whatnot product string to its first significant words', () => {
    expect(simplifyProduct('1x COSMIC CHROME FOOTBALL HOBBY BOX- CHASE PLANETARY PURSUIT RANDOM TEAMS')).toBe('Cosmic Chrome')
  })

  it('stops at a sport word / punctuation boundary and Title-Cases', () => {
    expect(simplifyProduct('TIER ONE BASEBALL - NEW RELEASE!!')).toBe('Tier One')
  })

  it('strips a leading 4-digit year and a leading "Nx " quantity', () => {
    expect(simplifyProduct('2025 INCEPTION BASEBALL RANDOM TEAMS (2 BOXES)')).toBe('Inception')
    expect(simplifyProduct('3x MEGA BREAK FOOTBALL')).toBe('Mega Break')
  })

  it('is deterministic — same input yields the same output every time', () => {
    const input = '1x COSMIC CHROME FOOTBALL HOBBY BOX- CHASE PLANETARY PURSUIT'
    expect(simplifyProduct(input)).toBe(simplifyProduct(input))
  })

  it('formats a day key as "Mon D" (formatDayLabel)', () => {
    expect(_internal.formatDayLabel('2026-06-28')).toBe('Jun 28')
    expect(_internal.formatDayLabel('2026-01-05')).toBe('Jan 5')
  })
})

describe('perBreak/perDay enrichment does NOT change money totals', () => {
  // Reuse the top-of-file SYNTHETIC fixture (CSV) whose totals are asserted
  // above. This locks the invariant that the grouping/label enrichment for
  // features 3 & 4 left net/gross/giveaway (and the date range) untouched.
  const { rows } = parseLedgerRows(CSV)
  const a = analyzeLedger(rows, { breaksPerCase: 9 })

  it('holds gross / giveaway / net unchanged for the known fixture', () => {
    expect(a.totals.grossEarnings).toBe(185)
    expect(a.totals.giveawayLost).toBe(-4.29)
    expect(a.totals.netRevenue).toBe(180.71)
  })

  it('holds the date range unchanged for the known fixture', () => {
    expect(a.dateRange).toEqual({ start: '2026-06-20', end: '2026-06-22', days: 3 })
  })
})

// =============================================================================
// FEATURE 4 — per-day revenue drill-down (perDay[i].breakdown).
// Uses the multi-day fixture: Jun 28 has TWO break-attributed products, Jun 29
// has one. breakdown must be present, sorted by revenue DESC, and sum to that
// day's GROSS break-attributed earnings.
// =============================================================================
describe('perDay breakdown drill-down', () => {
  const { rows } = parseLedgerRows(MULTIDAY_CSV)
  const a = analyzeLedger(rows, { breaksPerCase: 9 })

  it('attaches a breakdown array to each perDay entry', () => {
    for (const d of a.perDay) {
      expect(Array.isArray(d.breakdown)).toBe(true)
    }
  })

  it('sorts each day breakdown by revenue DESC', () => {
    const jun28 = a.perDay.find((d) => d.day === '2026-06-28')
    // Jun 28: Cosmic Chrome Break #8 (100) and Tier One Break #3 (70).
    expect(jun28.breakdown.length).toBe(2)
    const revs = jun28.breakdown.map((e) => e.revenue)
    expect(revs).toEqual([...revs].sort((x, y) => y - x))
    expect(revs).toEqual([100, 70]) // 100 first (desc)
  })

  it('carries label / product / breakNumber / revenue / count per breakdown entry', () => {
    const jun28 = a.perDay.find((d) => d.day === '2026-06-28')
    const top = jun28.breakdown[0]
    expect(top).toMatchObject({
      label: 'Break 8 · Cosmic Chrome',
      breakNumber: 8,
      revenue: 100,
      count: 2,
    })
    expect(top.product).toMatch(/COSMIC CHROME FOOTBALL HOBBY BOX/)
  })

  it('breakdown revenue sums to that day GROSS break-attributed earnings', () => {
    for (const d of a.perDay) {
      const sum = d.breakdown.reduce((acc, e) => acc + e.revenue, 0)
      // Every earning in this fixture is break-attributed, so the day's
      // breakdown sum equals the day's gross earnings exactly.
      expect(Math.round(sum * 100) / 100).toBe(d.gross)
    }
  })

  it('includes an "Unattributed sales" bucket so the breakdown reconciles to gross', () => {
    // Add a giveaway + an unattributed earning on Jun 28. The drill-down must
    // account for the WHOLE day's gross: the two break-attributed products PLUS
    // an "Unattributed sales" bucket. Giveaways stay OUT of the breakdown (they
    // are shown as the day-level negative), so the sum equals gross, not net.
    const extra = '﻿' + [
      MULTIDAY_HEADER,
      ...MULTIDAY_ROWS,
      '"Jun 28, 2026, 4:00:00 PM","-$5.00","304","404","Charged deduction of $5.00 for giveaway order 900","completed","SALES","Jun 28, 2026, 4:00:01 PM"',
      '"Jun 28, 2026, 5:00:00 PM","$15.00","305","405","Earnings for selling a 1x Loose Single Card","completed","SALES","Jun 28, 2026, 5:00:01 PM"',
    ].join('\n') + '\n'
    const r2 = parseLedgerRows(extra).rows
    const a2 = analyzeLedger(r2, { breaksPerCase: 9 })
    const jun28 = a2.perDay.find((d) => d.day === '2026-06-28')
    // Two break-attributed products + one "Unattributed sales" bucket.
    expect(jun28.breakdown.length).toBe(3)
    const unatt = jun28.breakdown.find((e) => e.unattributed)
    expect(unatt).toMatchObject({ label: 'Unattributed sales', breakNumber: null, revenue: 15 })
    // Breakdown reconciles to the day's GROSS (100 + 70 + 15 = 185), NOT the
    // giveaway-reduced net (the -$5 giveaway is a day-level negative, excluded).
    const sum = jun28.breakdown.reduce((acc, e) => acc + e.revenue, 0)
    expect(Math.round(sum * 100) / 100).toBe(jun28.gross)
    expect(sum).toBe(185)
    // The giveaway shows on the day itself, never inside the breakdown.
    expect(jun28.giveaway).toBe(-5)
    expect(jun28.breakdown.every((e) => e.revenue >= 0)).toBe(true)
  })
})
