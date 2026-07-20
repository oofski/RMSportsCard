// =============================================================================
// Parser robustness ("bulletproof") suite — hardening the order/label parse
// against the messy real-world Whatnot exports (combined labels + packing slips,
// interleaved shipping-label pages, multi-page slips, odd page order, giveaway
// variants, big prices, missing fields). Every fixture is SYNTHETIC (public repo).
// =============================================================================
import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { parsePages } = require('../server/parser/index.cjs')

const slots = (ds, handle) => ds.teamSlots.filter((t) => t.customerId === handle)
const ship = (ds, handle) => ds.shipments.find((s) => s.customerId === handle)

// --- Reusable synthetic page builders ---------------------------------------
const pack = (handle, name, lines, tracking = '9300120762602323770000') => `Whatnot Packing Slip 1/1
To: ${handle} From: rm_cardz
${name}
1 Main St
Reno, NV 89501
15 July, 2026
QTY Name & Description Attributes Subtotal
${lines}
USPS Ground Advantage #${tracking} 7.0 oz`

const brk = (handle, name, n, teams, total = '30.00') => `Whatnot - Breaking Slip
User
${name} (${handle})
Orders
#800001
1 Break
1x 2026 FINEST BASEBALL HOBBY BOX (NEW RELEASE!)- Break
#${n}
Orders: #800001
${teams.map((t) => `__ ${t}`).join('\n')}
Total: $${total}`

describe('parser robustness', () => {
  it('does not cross-contaminate customers when shipping-label / blank pages are interleaved', () => {
    const label = `Jane Doe\n123 Elm St\nSpringfield, IL 62704\nUSPS TRACKING\n9400 1111 2222 3333` // header-less label page
    const blank = `   `
    const ds = parsePages([
      pack('aaa', 'Al Adams', '1 Houston Astros Order 800001 $26.00\n1x 2026 FINEST BASEBALL HOBBY BOX (NEW RELEASE!)- Break #1\n1 Item $26.00', '9300120762602323770001'),
      label, // a label page after A's packing slip
      brk('aaa', 'Al Adams', 1, ['Houston Astros']),
      blank,
      pack('bbb', 'Bo Barker', '1 Chicago Cubs Order 800002 $18.00\n1x 2026 FINEST BASEBALL HOBBY BOX (NEW RELEASE!)- Break #2\n1 Item $18.00', '9300120762602323770002'),
      brk('bbb', 'Bo Barker', 2, ['Chicago Cubs']),
    ], { sport: 'mlb' })
    expect(slots(ds, 'aaa').map((t) => t.teamName)).toEqual(['Houston Astros'])
    expect(slots(ds, 'bbb').map((t) => t.teamName)).toEqual(['Chicago Cubs'])
    expect(slots(ds, 'aaa')[0].breakNumber).toBe(1)
    expect(slots(ds, 'bbb')[0].breakNumber).toBe(2)
  })

  it('reads tracking from the LAST page of a multi-page packing slip and keeps all items', () => {
    const p1 = `Whatnot Packing Slip 1/2
To: multi From: rm_cardz
Manny Multi
2 Oak Ave
Reno, NV 89501
15 July, 2026
QTY Name & Description Attributes Subtotal
1 New York Mets Order 800001 $20.00
1x 2026 FINEST BASEBALL HOBBY BOX (NEW RELEASE!)- Break #3`
    const p2 = `Whatnot Packing Slip 2/2
1 Boston Red Sox Order 800002 $22.00
1x 2026 FINEST BASEBALL HOBBY BOX (NEW RELEASE!)- Break #3
2 Items $42.00
USPS Priority Mail #9305520762601310170099 12.0 oz`
    const ds = parsePages([p1, p2], { sport: 'mlb' })
    const s = slots(ds, 'multi')
    expect(s.map((t) => t.teamName).sort()).toEqual(['Boston Red Sox', 'New York Mets'])
    expect(ship(ds, 'multi').trackingNumber).toBe('9305520762601310170099')
  })

  it('parses correctly even when the breaking slip comes BEFORE its packing slip', () => {
    const ds = parsePages([
      brk('rev', 'Reva Reverse', 4, ['Los Angeles Dodgers']),
      pack('rev', 'Reva Reverse', '1 Los Angeles Dodgers Order 800001 $40.00\n1x 2026 FINEST BASEBALL HOBBY BOX (NEW RELEASE!)- Break #4\n1 Item $40.00'),
    ], { sport: 'mlb' })
    const s = slots(ds, 'rev')
    expect(s).toHaveLength(1)
    expect(s[0].teamName).toBe('Los Angeles Dodgers')
    expect(s[0].breakNumber).toBe(4)
  })

  it('parses a big price with a thousands separator (not $1)', () => {
    const ds = parsePages([
      pack('whale', 'Big Whale', '1 New York Yankees Order 900900 $1,250.00\n1x 2026 FINEST BASEBALL HOBBY BOX (NEW RELEASE!)- Break #1\n1 Item $1,250.00'),
    ], { sport: 'mlb' })
    expect(slots(ds, 'whale')[0].price).toBe(1250)
  })

  it('makes a break-less giveaway (no team, no breaking slip) a single checkable slot', () => {
    const ds = parsePages([`Whatnot Packing Slip 1/1
To: promowin From: rm_cardz
Promo Winner
5 Main St
Seminole, FL 33772
15 July, 2026
QTY Name & Description Attributes Subtotal
GIVEAWAY
1 Order 1187236279 $0.00
GIVEAWAY ON SCREEN #1
2025 Chrome Update Pack
1 Item $0.00
USPS Ground Advantage #9300120762602323776686 1.0 oz`], { sport: 'mlb' })
    const s = slots(ds, 'promowin')
    expect(s).toHaveLength(1)
    expect(s[0].isGiveaway).toBe(true)
    expect(s[0].price).toBe(0)
    expect(s[0].breakNumber).toBe(null)
    expect(ship(ds, 'promowin')).toBeTruthy()
    expect(ds.breaks.some((b) => b.breakNumber == null)).toBe(false) // no phantom break
  })

  it('handles MULTIPLE giveaways in one order as distinct checkable slots', () => {
    const ds = parsePages([`Whatnot Packing Slip 1/1
To: multigive From: rm_cardz
Multi Give
6 Pine Rd
Reno, NV 89501
15 July, 2026
QTY Name & Description Attributes Subtotal
GIVEAWAY 1 Detroit Tigers Order 700001 $0.00
1x 2026 FINEST BASEBALL HOBBY BOX (NEW RELEASE!)- Break #5
GIVEAWAY 1 Seattle Mariners Order 700002 $0.00
1x 2026 FINEST BASEBALL HOBBY BOX (NEW RELEASE!)- Break #5
2 Items $0.00
USPS Ground Advantage #9300120762602323776111 2.0 oz`], { sport: 'mlb' })
    const gv = slots(ds, 'multigive').filter((t) => t.isGiveaway)
    expect(gv).toHaveLength(2)
    // Distinct slot ids (no collision) and both in break 5.
    expect(new Set(gv.map((t) => t.slotId ?? t.id)).size).toBe(2)
    expect(gv.every((t) => t.breakNumber === 5)).toBe(true)
    expect(gv.map((t) => t.teamName).sort()).toEqual(['Detroit Tigers', 'Seattle Mariners'])
  })

  it('does not double-emit a giveaway that the breaking slip already lists', () => {
    const ds = parsePages([
      pack('mix', 'Mix Buyer', '1 Chicago Bears Order 800001 $30.00\n1x 2026 FINEST FOOTBALL - Break #2\nGIVEAWAY 1 Arizona Cardinals Order 800002 $0.00\n1x 2026 FINEST FOOTBALL - Break #2\n2 Items $30.00', '9300120762602323770077'),
      `Whatnot - Breaking Slip
User
Mix Buyer (mix)
Orders
#800001 #800002
1 Break
1x 2026 FINEST FOOTBALL - Break #2
Orders: #800001 #800002
__ Chicago Bears
__ Arizona Cardinals
Total: $30.00`,
    ], { sport: 'nfl' })
    const s = slots(ds, 'mix')
    expect(s).toHaveLength(2) // Bears + Cardinals, NOT 3
    expect(s.map((t) => t.teamName).sort()).toEqual(['Arizona Cardinals', 'Chicago Bears'])
  })

  it('survives a missing tracking number (shipment still created, no crash)', () => {
    const ds = parsePages([`Whatnot Packing Slip 1/1
To: notrack From: rm_cardz
No Track
7 Birch Ln
Reno, NV 89501
15 July, 2026
QTY Name & Description Attributes Subtotal
1 Texas Rangers Order 800001 $19.00
1x 2026 FINEST BASEBALL HOBBY BOX (NEW RELEASE!)- Break #6
1 Item $19.00`], { sport: 'mlb' })
    const sh = ship(ds, 'notrack')
    expect(sh).toBeTruthy()
    expect(sh.trackingNumber).toBeNull()
    expect(slots(ds, 'notrack')[0].teamName).toBe('Texas Rangers')
  })

  it('does NOT flag paid cards as giveaways when the break/product TITLE says "GIVEAWAY"', () => {
    const ds = parsePages([
      pack('gv', 'Gee Vee', '1 Boston Red Sox Order 800001 $30.00\n1x 2026 FINEST GIVEAWAY RELEASE (NEW!)- Break #1\n1 Item $30.00'),
    ], { sport: 'mlb' })
    const s = slots(ds, 'gv')
    expect(s).toHaveLength(1)
    expect(s[0].isGiveaway).toBe(false) // paid $30 despite "GIVEAWAY" in the title
    expect(s[0].price).toBe(30)
  })

  it('keeps two DISTINCT breaks that share a team (no false reconciliation merge on clean input)', () => {
    const packing = pack('dup', 'Dup Owner',
      '1 Chicago Cubs Order 800001 $20.00\n1x 2026 FINEST - Break #1\n1 Chicago Cubs Order 800002 $22.00\n1x 2026 FINEST - Break #3\n2 Items $42.00')
    const breaking = `Whatnot - Breaking Slip
User
Dup Owner (dup)
Orders
#800001 #800002
2 Breaks
1x 2026 FINEST - Break #1
Orders: #800001
__ Chicago Cubs
1x 2026 FINEST - Break #3
Orders: #800002
__ Chicago Cubs
Total: $42.00`
    const ds = parsePages([packing, breaking], { sport: 'mlb' })
    const s = slots(ds, 'dup')
    expect(s).toHaveLength(2)
    expect(s.map((t) => t.breakNumber).sort((a, b) => a - b)).toEqual([1, 3]) // both kept, not merged
    expect(s.every((t) => t.teamName === 'Chicago Cubs')).toBe(true)
  })

  it('a shipping-label page before a packing slip does not steal the previous customer tracking', () => {
    const labelForB = `Bee Bee\n9 Label Ln\nReno, NV 89501\nUSPS Priority Mail #9999999999999999999999 5.0 oz`
    const ds = parsePages([
      pack('cusa', 'Cus A', '1 New York Mets Order 800001 $20.00\n1x 2026 FINEST - Break #1\n1 Item $20.00', '1111111111111111111111'),
      labelForB, // B's label printed BEFORE B's packing slip (label-first)
      pack('cusb', 'Cus B', '1 Boston Red Sox Order 800002 $22.00\n1x 2026 FINEST - Break #2\n1 Item $22.00', '2222222222222222222222'),
    ], { sport: 'mlb' })
    expect(ship(ds, 'cusa').trackingNumber).toBe('1111111111111111111111') // NOT the label's number
    expect(ship(ds, 'cusb').trackingNumber).toBe('2222222222222222222222')
  })

  it('does not double-emit a giveaway the breaking slip lists but whose packing line is break-less', () => {
    const packing = pack('bl', 'BL Buyer',
      '1 Chicago Bears Order 800001 $30.00\n1x 2026 FINEST FOOTBALL - Break #2\nGIVEAWAY 1 Arizona Cardinals Order 800002 $0.00\n2 Items $30.00')
    const breaking = `Whatnot - Breaking Slip
User
BL Buyer (bl)
Orders
#800001 #800002
1 Break
1x 2026 FINEST FOOTBALL - Break #2
Orders: #800001 #800002
__ Chicago Bears
__ Arizona Cardinals
Total: $30.00`
    const ds = parsePages([packing, breaking], { sport: 'nfl' })
    const s = slots(ds, 'bl')
    const cards = s.filter((t) => t.teamName === 'Arizona Cardinals')
    expect(cards).toHaveLength(1) // once, not twice
    expect(cards[0].isGiveaway).toBe(true) // and correctly marked a giveaway
    expect(s).toHaveLength(2) // Bears + Cardinals
  })

  it('never throws on empty / whitespace / header-only pages', () => {
    expect(() => parsePages([], { sport: 'mlb' })).not.toThrow()
    expect(() => parsePages(['', '   ', '\n\n'], { sport: 'mlb' })).not.toThrow()
    expect(() => parsePages(['Whatnot Packing Slip 1/1'], { sport: 'mlb' })).not.toThrow()
    expect(() => parsePages(['Whatnot - Breaking Slip\nUser'], { sport: 'mlb' })).not.toThrow()
  })
})
