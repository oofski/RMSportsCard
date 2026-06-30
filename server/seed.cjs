// =============================================================================
// RM Cardz — Demo data generator
// -----------------------------------------------------------------------------
// Produces a realistic, fully-formed dataset (same shape the PDF parser emits)
// so the app is immediately usable for evaluation, training, screenshots, and
// automated tests — no real 481-page Whatnot PDF required. Anchored on the real
// Appendix A example customers, then deterministically expanded to fill 9 breaks.
//
// Determinism: a seeded LCG drives all "randomness" so the demo is identical on
// every load (stable screenshots and test fixtures).
// =============================================================================

const reference = require('../shared/reference.json')
const { buildUspsUrl, buildBatchUrls } = require('./parser/batchUrls.cjs')

const TEAMS = reference.nflTeams
const NUM_BREAKS = reference.defaultBreaksPerEvent
const EVENT = { name: 'COSMIC FOOTBALL MARATHON! STARTING AT $1!', date: '2026-06-27' }

// Real anchor customers from the spec (Appendix A / §2.4) plus generated extras.
const BASE_CUSTOMERS = [
  { handle: 'luknstar7', realName: 'Lucas Snow', address: '1 Carriage Way, Ballston Spa, NY 12020-2700', isNew: false, service: 'Priority Mail', weightOz: 42.0, tracking: '9305520762601281834387' },
  { handle: '504cardsaint', realName: 'Matthew Heine', address: '88 Bayou St, New Orleans, LA 70112', isNew: false, service: 'Ground Advantage', weightOz: 6.0, tracking: '9300120762602276538614' },
  { handle: 'mltwncds04432', realName: 'Pete Mergens', address: '210 Maple Ave, Milltown, NJ 08850', isNew: true, service: 'Priority Mail', weightOz: 18.0, tracking: '9305520762601281834196' },
  { handle: 'jvtugs', realName: 'Jv Tugano', address: '4417 Vine St, Cypress, CA 90630', isNew: false, service: 'Priority Mail', weightOz: 12.5, tracking: '9305520762601281834301' },
  { handle: 'spookyfreak', realName: 'Sam Vance', address: '77 Hollow Rd, Salem, MA 01970', isNew: false, service: 'Ground Advantage', weightOz: 8.0, tracking: '9300120762602276538966' },
  { handle: 'bigmike_cards', realName: 'Mike Dolan', address: '900 Lake Shore Dr, Chicago, IL 60611', isNew: false, service: 'Priority Mail', weightOz: 22.0, tracking: '9305520762601281835018' },
  { handle: 'theinfamous_d_o_m', realName: 'Dominic Russo', address: '15 Elm St, Providence, RI 02903', isNew: true, service: 'Ground Advantage', weightOz: 5.0, tracking: '9300120762602276539123' },
  { handle: 'cardkingdfw', realName: 'Brandon Webb', address: '3201 Main St, Dallas, TX 75201', isNew: false, service: 'Priority Mail', weightOz: 31.0, tracking: '9305520762601281835209' },
  { handle: 'gridirongrace', realName: 'Grace Holloway', address: '12 Birch Ln, Madison, WI 53703', isNew: false, service: 'Ground Advantage', weightOz: 7.5, tracking: '9300120762602276539407' },
  { handle: 'hobbyhank', realName: 'Hank Pierce', address: '64 Sunset Blvd, Phoenix, AZ 85003', isNew: false, service: 'Priority Mail', weightOz: 16.0, tracking: '9305520762601281835513' },
  { handle: 'queencitybreaks', realName: 'Tara Nguyen', address: '500 Vine St, Cincinnati, OH 45202', isNew: true, service: 'Ground Advantage', weightOz: 9.0, tracking: '9300120762602276539881' },
  { handle: 'pnwpulls', realName: 'Evan Brooks', address: '410 Pine St, Seattle, WA 98101', isNew: false, service: 'Priority Mail', weightOz: 27.0, tracking: '9305520762601281835704' },
  { handle: 'risingrookie', realName: 'Owen Diaz', address: '22 Harbor Rd, Tampa, FL 33602', isNew: false, service: 'Ground Advantage', weightOz: 6.5, tracking: '9300120762602276540115' },
  { handle: 'mtnwestmint', realName: 'Cole Barrett', address: '78 Aspen Way, Denver, CO 80202', isNew: false, service: 'Priority Mail', weightOz: 19.0, tracking: '9305520762601281836022' },
  { handle: 'bayareabreaks', realName: 'Priya Shah', address: '99 Market St, San Francisco, CA 94105', isNew: true, service: 'Ground Advantage', weightOz: 8.5, tracking: '9300120762602276540338' },
  { handle: 'steelcityslabs', realName: 'Frank Kowalski', address: '301 Grant St, Pittsburgh, PA 15219', isNew: false, service: 'Priority Mail', weightOz: 24.0, tracking: '9305520762601281836410' },
]

// A spread of statuses so Module B looks alive on first open.
const STATUS_CYCLE = ['delivered', 'in_transit', 'in_transit', 'out_for_delivery', 'delivered', 'not_shipped', 'in_transit', 'exception', 'delivered', 'returned']

/** Tiny seeded LCG for deterministic shuffling. */
function makeRng(seed) {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 0xffffffff
  }
}

function shuffled(arr, rng) {
  const a = arr.slice()
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

/**
 * Build the full demo dataset.
 * @returns the normalized dataset (see server/db.cjs importDataset docs).
 */
function demoDataset() {
  const rng = makeRng(20260627)
  const nowIso = new Date().toISOString()

  const customers = BASE_CUSTOMERS.map((c) => ({
    id: c.handle,
    whatnotHandle: c.handle,
    realName: c.realName,
    address: c.address,
    isNew: c.isNew,
  }))

  const breaks = []
  const teamSlots = []
  const orders = []
  let orderSeq = 1145425000

  for (let n = 1; n <= NUM_BREAKS; n++) {
    breaks.push({
      id: `break_${n}`,
      breakNumber: n,
      eventName: EVENT.name,
      eventDate: EVENT.date,
      status: 'pending',
    })

    // Each break sells a realistic subset (22–32) of the 32 teams.
    const sold = 22 + Math.floor(rng() * 11)
    const teamsForBreak = shuffled(TEAMS, rng).slice(0, sold)

    teamsForBreak.forEach((teamName, idx) => {
      // Round-robin assign teams to customers; one team = one customer per break.
      const customer = customers[(idx + n) % customers.length]
      const price = 12 + Math.floor(rng() * 30) // $12–$41
      const orderId = String(orderSeq++)
      orders.push({
        id: orderId,
        customerId: customer.id,
        breakId: `break_${n}`,
        breakNumber: n,
        teamName,
        price,
        isGiveaway: false,
      })
      teamSlots.push({
        id: `slot_${n}_${idx}`,
        breakId: `break_${n}`,
        breakNumber: n,
        teamName,
        customerId: customer.id,
        orderId,
        price,
        isGiveaway: false,
        checkedOff: false,
        checkedOffAt: null,
        checkedOffBy: null,
      })
    })
  }

  // Pre-check a couple of early breaks so progress bars look realistic.
  teamSlots.filter((t) => t.breakId === 'break_3').forEach((t) => { t.checkedOff = true; t.checkedOffAt = nowIso; t.checkedOffBy = 'demo' })
  breaks.find((b) => b.id === 'break_3').status = 'packed'
  const b1 = teamSlots.filter((t) => t.breakId === 'break_1')
  b1.slice(0, Math.floor(b1.length / 2)).forEach((t) => { t.checkedOff = true; t.checkedOffAt = nowIso; t.checkedOffBy = 'demo' })
  breaks.find((b) => b.id === 'break_1').status = 'picking'

  const shipments = BASE_CUSTOMERS.map((c, i) => ({
    id: `ship_${c.handle}`,
    customerId: c.handle,
    trackingNumber: c.tracking,
    carrier: 'USPS',
    serviceType: c.service,
    weightOz: c.weightOz,
    uspsUrl: buildUspsUrl(c.tracking),
    manualStatus: { code: STATUS_CYCLE[i % STATUS_CYCLE.length], setAt: nowIso, setBy: 'auto' },
    notes: STATUS_CYCLE[i % STATUS_CYCLE.length] === 'exception' ? 'Address issue — called customer.' : null,
    lastUpdated: nowIso,
  }))

  const batchUrls = buildBatchUrls(shipments.map((s) => s.trackingNumber))

  return {
    event: EVENT,
    breaks,
    teamSlots,
    customers,
    shipments,
    orders,
    batchUrls,
    warnings: [],
    totalPages: 0,
  }
}

module.exports = { demoDataset }
