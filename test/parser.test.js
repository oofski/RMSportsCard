// Tests for the pure parser core (server/parser/index.cjs -> parsePages),
// using synthetic page text in the documented Whatnot layout (spec §2).
import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { parsePages } = require('../server/parser/index.cjs')

// --- Fixture builders (each string mimics one extracted PDF page) ------------

// Customer A: simplest case — 1 break, 1 team, single-page packing slip.
const A_PACK = `Whatnot Packing Slip
1/1
To: 504cardsaint
From: rm_cardz
Matthew Heine
88 Bayou St
New Orleans, LA 70112
COSMIC FOOTBALL MARATHON June 27, 2026
Order 1145425409
1x COSMIC CHROME FOOTBALL HOBBY BOX Break #1 Seattle Seahawks $26.00
6 Items
USPS Ground Advantage™ #9300120762602276538614
6.0 oz`

const A_BREAK = `Whatnot - Breaking Slip
User
Matthew Heine (504cardsaint)
#1145425409
1 Breaks
Break #1
Orders: #1145425409
1 Item
__ Seattle Seahawks
Total: $26.00`

// Customer B: 3 breaks (1, 4, 5), 6 teams, MULTI-PAGE packing slip with the
// USPS tracking line only on the LAST page (2/2).
const B_PACK1 = `Whatnot Packing Slip
1/2
To: luknstar7
From: rm_cardz
Lucas Snow
1 Carriage Way
Ballston Spa, NY 12020-2700
COSMIC FOOTBALL MARATHON June 27, 2026
Order 1145426802
1x COSMIC CHROME FOOTBALL Break #1 Los Angeles Chargers $31.00
Order 1145606676
1x COSMIC CHROME FOOTBALL Break #4 Denver Broncos $30.00
Order 1145606677
1x COSMIC CHROME FOOTBALL Break #4 Green Bay Packers $28.00
Order 1145606678
1x COSMIC CHROME FOOTBALL Break #4 Detroit Lions $26.00`

const B_PACK2 = `Whatnot Packing Slip
2/2
To: luknstar7
Order 1145608853
1x COSMIC CHROME FOOTBALL Break #5 Kansas City Chiefs $40.00
Order 1145608854
1x COSMIC CHROME FOOTBALL Break #5 New Orleans Saints $35.00
6 Items
USPS Priority Mail® #9305520762601281834387
42.0 oz`

const B_BREAK = `Whatnot - Breaking Slip
User
Lucas Snow (luknstar7)
#1145426802 #1145606676 #1145606677 #1145606678 #1145608853 #1145608854
3 Breaks
Break #1
Orders: #1145426802
1 Item
__ Los Angeles Chargers
Total: $31.00
Break #4
Orders: #1145606676 #1145606677 #1145606678
3 Items
__ Denver Broncos
__ Green Bay Packers
__ Detroit Lions
Total: $84.00
Break #5
Orders: #1145608853 #1145608854
2 Items
__ Kansas City Chiefs
__ New Orleans Saints
Total: $75.00`

// Customer C: includes a GIVEAWAY $0.00 order in Break #1.
const C_PACK = `Whatnot Packing Slip
1/1
NEW
To: mltwncds04432
From: rm_cardz
Pete Mergens
210 Maple Ave
Milltown, NJ 08850
COSMIC FOOTBALL MARATHON June 27, 2026
Order 1145431457
1x COSMIC CHROME FOOTBALL Break #1 Las Vegas Raiders $40.00
Order 1145433704
1x COSMIC CHROME FOOTBALL Break #1 Carolina Panthers $38.00
Order 1145435985
GIVEAWAY 1x COSMIC CHROME FOOTBALL Break #1 Arizona Cardinals $0.00
6 Items
USPS Priority Mail® #9305520762601281834196
18.0 oz`

const C_BREAK = `Whatnot - Breaking Slip
User
Pete Mergens (mltwncds04432)
#1145431457 #1145433704 #1145435985
1 Breaks
Break #1
Orders: #1145431457 #1145433704 #1145435985
3 Items
__ Las Vegas Raiders
__ Carolina Panthers
__ Arizona Cardinals
Total: $78.00`

const PAGES = [A_PACK, A_BREAK, B_PACK1, B_PACK2, B_BREAK, C_PACK, C_BREAK]

describe('parsePages', () => {
  const ds = parsePages(PAGES)

  it('finds all customers, breaks, slots, and shipments', () => {
    expect(ds.customers).toHaveLength(3)
    expect(ds.breaks.map((b) => b.breakNumber).sort((a, b) => a - b)).toEqual([1, 4, 5])
    expect(ds.teamSlots).toHaveLength(10) // 1 + 6 + 3
    expect(ds.shipments).toHaveLength(3)
    expect(ds.totalPages).toBe(PAGES.length)
  })

  it('parses tracking numbers as digits only and builds USPS URLs', () => {
    const lucas = ds.shipments.find((s) => s.customerId === 'luknstar7')
    expect(lucas.trackingNumber).toBe('9305520762601281834387') // last-page tracking
    expect(lucas.serviceType).toBe('Priority Mail')
    expect(lucas.weightOz).toBe(42)
    expect(lucas.uspsUrl).toContain('tools.usps.com')
    expect(lucas.uspsUrl).toContain('9305520762601281834387')
  })

  it('groups a multi-break customer across breaks 1/4/5', () => {
    const lucasSlots = ds.teamSlots.filter((t) => t.customerId === 'luknstar7')
    expect(lucasSlots).toHaveLength(6)
    expect([...new Set(lucasSlots.map((t) => t.breakNumber))].sort((a, b) => a - b)).toEqual([1, 4, 5])
  })

  it('extracts the shipping address from after the From: block', () => {
    const matthew = ds.customers.find((c) => c.id === '504cardsaint')
    expect(matthew.realName).toBe('Matthew Heine')
    expect(matthew.address).toContain('Bayou')
    expect(matthew.address).not.toMatch(/FOOTBALL/i) // event line must not leak in
  })

  it('flags the NEW customer', () => {
    expect(ds.customers.find((c) => c.id === 'mltwncds04432').isNew).toBe(true)
  })

  it('handles a GIVEAWAY order: price 0, isGiveaway true', () => {
    const cards = ds.teamSlots.find((t) => t.customerId === 'mltwncds04432' && t.teamName === 'Arizona Cardinals')
    expect(cards.isGiveaway).toBe(true)
    expect(cards.price).toBe(0)
    // The paid teammates are NOT marked giveaway (window bleed regression guard).
    const raiders = ds.teamSlots.find((t) => t.teamName === 'Las Vegas Raiders')
    expect(raiders.isGiveaway).toBe(false)
    expect(raiders.price).toBe(40)
  })

  it('precomputes batch URLs for all tracking numbers', () => {
    expect(ds.batchUrls).toHaveLength(1) // 3 numbers -> 1 batch
    expect(ds.batchUrls[0].count).toBe(3)
    expect(ds.batchUrls[0].url).toContain('%2C')
  })

  it('produces no warnings for clean data', () => {
    expect(ds.warnings).toEqual([])
  })

  it('emits a warning for a duplicate team in the same break', () => {
    const dupPages = [
      `Whatnot - Breaking Slip
User
Dup Tester (duphandle)
#1
1 Breaks
Break #1
Orders: #1
__ Chicago Bears
__ Chicago Bears
Total: $10.00`,
    ]
    const out = parsePages(dupPages)
    expect(out.warnings.some((w) => /Duplicate team/i.test(w.message))).toBe(true)
  })
})
