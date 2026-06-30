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
const { parseLedgerRows, analyzeLedger } = require('../server/ledger.cjs')

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
