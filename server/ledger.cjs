// =============================================================================
// RM Cardz — Whatnot ledger CSV parser + analytics (pure, no I/O)
// -----------------------------------------------------------------------------
// This module is a faithful JavaScript port of the DATA ANALYST's validated
// reference implementation (validate_ledger.py). It does NOT touch the disk,
// the network, or the store: callers pass in raw CSV text (and later, parsed
// rows) and receive plain data back. Keeping it pure makes it trivially unit
// testable and lets db.cjs own all persistence.
//
// Two exported functions:
//   parseLedgerRows(csvText)            -> { rows, warnings }
//   analyzeLedger(rows, { breaksPerCase }) -> the analysis object
//
// CLASSIFICATION (ported exactly from the reference):
//   Transaction Type is trimmed + upper-cased, then:
//     PAYOUT                                            -> payout_ignored
//     TIP                                               -> tip
//     ADJUSTMENT                                        -> adjustment
//     SALES + Message startsWith "Earnings for selling" -> earning
//     SALES + Message startsWith "Charged deduction"
//             + Message contains "giveaway" (case-insens.) -> giveaway
//     any other SALES (and any other type)              -> other
//
// Only `earning` and `giveaway` rows are "counted" toward revenue and the date
// range. Adjustments/tips are tallied but excluded from revenue; payouts are
// ignored entirely (counted + summed only for reference). `other` rows are
// counted and sampled into warnings so a human can review them.
// =============================================================================

'use strict'

// ---------------------------------------------------------------------------
// PARSING PRIMITIVES
// ---------------------------------------------------------------------------

// Matches a currency string with an optional leading minus, optional '$', and
// thousands separators: "$2.45", "-$36,690.75", "$0.00". Capture group 1 is the
// sign, group 2 is the bare number (commas stripped later).
const AMOUNT_RE = /^\s*(-?)\s*\$?\s*([\d,]+(?:\.\d+)?)\s*$/

/**
 * Parse a Whatnot money string into a Number.
 *   "$2.45"        ->  2.45
 *   "-$36,690.75"  -> -36690.75
 *   "$0.00"        ->  0
 * Throws on anything that doesn't look like a currency amount.
 * @param {string} s
 * @returns {number}
 */
function parseAmount(s) {
  const m = AMOUNT_RE.exec(s || '')
  if (!m) throw new Error(`unparseable amount: ${JSON.stringify(s)}`)
  const sign = m[1] === '-' ? -1 : 1
  return sign * Number(m[2].replace(/,/g, ''))
}

// Month abbreviation -> 1-based month number.
const MONTHS = {
  Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6,
  Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12,
}
// Whatnot dates look like "Jun 29, 2026, 5:11:59 PM" — we only need the date
// portion to build the day key, so we anchor on "Mon DD, YYYY,".
const DATE_RE = /^([A-Z][a-z]{2})\s+(\d{1,2}),\s+(\d{4}),/

/**
 * Convert a Whatnot date string into a YYYY-MM-DD "day key".
 *   "Jun 29, 2026, 5:11:59 PM" -> "2026-06-29"
 * Throws on an unparseable date.
 * @param {string} s
 * @returns {string}
 */
function parseDayKey(s) {
  const m = DATE_RE.exec(s || '')
  if (!m) throw new Error(`unparseable date: ${JSON.stringify(s)}`)
  const mon = MONTHS[m[1]]
  if (!mon) throw new Error(`unknown month: ${JSON.stringify(m[1])}`)
  const day = Number(m[2])
  const year = Number(m[3])
  const pad = (n, w) => String(n).padStart(w, '0')
  return `${pad(year, 4)}-${pad(mon, 2)}-${pad(day, 2)}`
}

// CASE-INSENSITIVE on purpose — the real ledger uses both "Break #N" and
// "BREAK #N". This flag is mandatory; without it ~half the breaks would be
// mis-grouped as unattributed.
const BREAK_RE = /Break\s*#\s*(\d+)/i
// Leading-quantity prefix on earnings messages: "1x ", "2x ", "4x "...
const QTY_RE = /^\d+x\s*/i
// Strip the "Earnings for selling a " lead-in (the trailing "a" + space too).
const EARN_LEAD_RE = /^Earnings for selling a\s*/i

const EARN_PREFIX = 'Earnings for selling'
const GIVEAWAY_PREFIX = 'Charged deduction'

/**
 * Collapse runs of whitespace to a single space and trim both ends.
 * @param {string} s
 * @returns {string}
 */
function collapseWhitespace(s) {
  return String(s == null ? '' : s).replace(/\s+/g, ' ').trim()
}

/**
 * Build the grouping KEY for a product display label. We upper-case, collapse
 * whitespace, and strip any trailing run of "!", "." or whitespace so trivial
 * typos / punctuation differences ("Topps Chrome!" vs "TOPPS CHROME") collapse
 * to one bucket. The original (display) label is kept separately by the caller.
 * @param {string} product
 * @returns {string}
 */
function productKeyOf(product) {
  return collapseWhitespace(product).toUpperCase().replace(/[!.\s]+$/, '')
}

// Sport words that end the "significant" portion of a Whatnot product string.
const SPORT_WORDS = new Set(['FOOTBALL', 'BASEBALL', 'BASKETBALL', 'HOCKEY', 'SOCCER'])
// Reverse of MONTHS (1 -> 'Jan'), built once for formatDayLabel.
const MONTH_ABBR = Object.entries(MONTHS).reduce((acc, [name, num]) => {
  acc[num] = name
  return acc
}, {})

/**
 * PURE, deterministic short label for a long Whatnot product string. Derives
 * ONLY from the row string (never from breaksPerCase). Steps:
 *   1. collapse whitespace
 *   2. strip a leading 4-digit year ("2025 ") and a leading "Nx " quantity
 *   3. cut the string at the first structural boundary: " HOBBY", " BOX",
 *      " - ", " -", ",", "(", or a sport word (FOOTBALL/BASEBALL/...)
 *   4. take the first ~2 significant words and Title-Case them
 * Examples:
 *   "1x COSMIC CHROME FOOTBALL HOBBY BOX- ..." -> "Cosmic Chrome"
 *   "TIER ONE BASEBALL - NEW RELEASE!!"        -> "Tier One"
 *   "2025 INCEPTION BASEBALL RANDOM TEAMS (2 BOXES)" -> "Inception"
 * @param {string} product
 * @returns {string}
 */
function simplifyProduct(product) {
  let s = collapseWhitespace(product)
  s = s.replace(/^\d{4}\s+/, '')     // leading 4-digit year
  s = s.replace(/^\d+x\s*/i, '')     // leading "Nx " quantity
  // Cut at the first structural boundary. Split on the words FIRST so a sport
  // word terminates the significant portion, then also honor punctuation/dash.
  const words = []
  for (const raw of s.split(' ')) {
    if (!raw) continue
    const upper = raw.toUpperCase()
    // Stop BEFORE structural markers / sport words.
    if (upper === 'HOBBY' || upper === 'BOX' || upper === '-' || SPORT_WORDS.has(upper)) break
    // Punctuation-embedded boundary (e.g. "BOX-", "TEAMS(2", "RELEASE!!", "A,B").
    const cutIdx = raw.search(/[-(,]/)
    if (cutIdx === 0) break
    if (cutIdx > 0) {
      const head = raw.slice(0, cutIdx)
      const headUpper = head.toUpperCase()
      if (headUpper && headUpper !== 'HOBBY' && headUpper !== 'BOX' && !SPORT_WORDS.has(headUpper)) {
        words.push(head)
      }
      break
    }
    words.push(raw)
    if (words.length >= 2) break // first ~2 significant words
  }
  const titled = words.map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
  return titled.join(' ')
}

/**
 * PURE date label: "2026-06-28" -> "Jun 28". Derives only from the day key.
 * @param {string} dayKey  YYYY-MM-DD
 * @returns {string}
 */
function formatDayLabel(dayKey) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dayKey || ''))
  if (!m) return String(dayKey || '')
  const mon = MONTH_ABBR[Number(m[2])]
  if (!mon) return String(dayKey || '')
  return `${mon} ${Number(m[3])}`
}

// Classify an EARNING row into a sale TYPE. A third of real revenue has no
// "Break #N" — but that is not junk, it is a different kind of sale (a whole
// case, a hobby box, a random-team break). Surfacing the mix beats dumping it
// all into a scary "unattributed" bucket. Precedence: a real break number wins;
// otherwise a "case" beats "random team" (a "half case random teams" is a case).
function classifySaleType(row) {
  if (row && row.breakNumber != null) return 'team_break'
  const s = `${(row && row.product) || ''} ${(row && row.message) || ''}`.toUpperCase()
  if (/\b(FULL|HALF)\s*CASE\b|\bCASE\b/.test(s)) return 'case'
  if (/RANDOM\s*TEAM/.test(s)) return 'random_break'
  if (/HOBBY\s*BOX|\bBOX\b/.test(s)) return 'hobby_box'
  return 'single'
}

const SALE_TYPE_LABELS = {
  team_break: 'Team breaks',
  case: 'Cases / half-cases',
  random_break: 'Random-team breaks',
  hobby_box: 'Hobby boxes',
  single: 'Other singles',
}

// A CLEAN product-family label for the "Revenue by product" view. simplifyProduct
// (used for per-break labels) is too aggressive here — it collapses "Cosmic
// Football" to "Cosmic" and leaves bare years like "2025" for products that start
// with one. This keeps the first TWO significant words after dropping a leading
// quantity ("1x") and year ("2025" / "2025-26" / "2025/26") and filler words, so
// families read as "Cosmic Chrome", "Cosmic Football", "Panini Signature", etc.
const PRODUCT_FILLER = new Set(['NEW', 'RELEASE', 'RELASE', 'THE', 'A', 'AND', 'OF', 'FOR', 'WITH', 'ON', 'SCREEN', 'NO', 'TO', 'IN'])
function productFamily(product) {
  let s = String(product == null ? '' : product).toUpperCase()
  s = s.replace(/^\s*\d+\s*X\s+/, '')                          // leading "1x" / "2 x"
  s = s.replace(/^\s*\d{4}(?:\s*[\/-]\s*\d{2,4})?\s+/, '')     // leading "2025" / "2025-26" / "2025 / 26"
  s = s.replace(/[^A-Z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim()
  // A "significant" token: not a filler word and not a bare number (a stray
  // year/quantity that slipped through) — those must never become the label.
  const sig = (w) => w && !PRODUCT_FILLER.has(w) && !/^\d+$/.test(w)
  const keep = []
  for (const w of s.split(' ')) { if (!sig(w)) continue; keep.push(w); if (keep.length >= 2) break }
  if (keep.length === 0) {
    // Empty-safe fallback: first significant token, else 'Other'. (Old code
    // could return '' for e.g. "BASEBALL BREAK #3" once the sport word led.)
    const first = s.split(' ').find(sig)
    return first ? first.charAt(0) + first.slice(1).toLowerCase() : 'Other'
  }
  return keep.map((w) => w.charAt(0) + w.slice(1).toLowerCase()).join(' ')
}

/**
 * Parse an earnings message into (product, breakNumber, team).
 *   "Earnings for selling a 2x Topps Chrome Break #3 - Cowboys"
 *      -> { product: "Topps Chrome", breakNumber: 3, team: "Cowboys" }
 * If there is no "Break #N", breakNumber/team are null and the whole (qty- and
 * lead-in-stripped) body is the product — these earnings are "unattributed".
 * @param {string} msg
 * @returns {{ product: string, breakNumber: (number|null), team: (string|null) }}
 */
function parseSaleMessage(msg) {
  let body = String(msg == null ? '' : msg)
  body = body.replace(EARN_LEAD_RE, '') // drop "Earnings for selling a "
  body = body.replace(QTY_RE, '')        // drop leading "1x "/"2x "/...
  const bm = BREAK_RE.exec(body)
  if (bm) {
    const product = stripDash(body.slice(0, bm.index))
    const breakNumber = Number(bm[1])
    const team = stripLeadDash(body.slice(bm.index + bm[0].length)) || null
    return { product, breakNumber, team }
  }
  return { product: stripDash(body), breakNumber: null, team: null }
}

// Trim whitespace AND any surrounding spaces/dashes from both ends — mirrors
// Python's str.strip(" -").
function stripDash(s) {
  return String(s).replace(/^[\s-]+/, '').replace(/[\s-]+$/, '')
}
// Mirror of Python's lstrip(" -").strip(): drop leading spaces/dashes, then trim.
function stripLeadDash(s) {
  return String(s).replace(/^[\s-]+/, '').trim()
}

// ---------------------------------------------------------------------------
// CLASSIFICATION
// ---------------------------------------------------------------------------

/**
 * Bucket a row by its Transaction Type + Message. See module header.
 * @param {{ type: string, message: string }} row  (type already trimmed)
 * @returns {('payout_ignored'|'tip'|'adjustment'|'earning'|'giveaway'|'other')}
 */
function classify(type, message) {
  const t = String(type || '').trim().toUpperCase()
  const msg = message || ''
  if (t === 'PAYOUT') return 'payout_ignored'
  if (t === 'TIP') return 'tip'
  if (t === 'ADJUSTMENT') return 'adjustment'
  if (t === 'SALES') {
    if (msg.startsWith(EARN_PREFIX)) return 'earning'
    if (msg.startsWith(GIVEAWAY_PREFIX) && msg.toLowerCase().includes('giveaway')) return 'giveaway'
    return 'other'
  }
  return 'other'
}

// ---------------------------------------------------------------------------
// ROBUST CSV READER
// ---------------------------------------------------------------------------
// A minimal RFC-4180-ish CSV parser. We can't use a third-party dep (hard rule)
// so this hand-rolled splitter handles quoted fields, escaped quotes (""), and
// embedded commas/newlines inside quotes. It deliberately does NOT try to be
// clever about Whatnot's malformed rows — that repair happens row-by-row below.

/**
 * Parse CSV text into an array of string-arrays (rows of fields).
 * Handles: UTF-8 BOM, quoted fields, "" escapes, CRLF and LF line endings,
 * and commas/newlines inside quoted fields.
 * @param {string} text
 * @returns {string[][]}
 */
function parseCsv(text) {
  let s = String(text == null ? '' : text)
  // Strip a UTF-8 BOM if present (utf-8-sig behaviour).
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1)

  const rows = []
  let field = ''
  let row = []
  let inQuotes = false
  let i = 0
  const n = s.length

  const pushField = () => { row.push(field); field = '' }
  const pushRow = () => { pushField(); rows.push(row); row = [] }

  while (i < n) {
    const c = s[i]
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i += 2; continue } // escaped quote
        inQuotes = false; i += 1; continue
      }
      field += c; i += 1; continue
    }
    if (c === '"') { inQuotes = true; i += 1; continue }
    if (c === ',') { pushField(); i += 1; continue }
    if (c === '\r') {
      // Treat CRLF or lone CR as one row terminator.
      pushRow()
      if (s[i + 1] === '\n') i += 2; else i += 1
      continue
    }
    if (c === '\n') { pushRow(); i += 1; continue }
    field += c; i += 1
  }
  // Flush a trailing field/row that wasn't terminated by a newline. Skip a
  // completely empty trailing line (common when files end with a newline).
  if (field !== '' || row.length > 0) pushRow()
  return rows
}

const EXPECTED_COLS = 8
// The canonical header, used to skip stray header repeats embedded in the body.
const HEADER = [
  'Created Date', 'Amount', 'Listing ID', 'Order ID',
  'Message', 'Status', 'Transaction Type', 'Completed Date',
]

/**
 * Parse a raw Whatnot ledger CSV into classified, normalized rows.
 *
 * Handles the two real-world quirks the analyst documented:
 *  1. A UTF-8 BOM at the start of the file.
 *  2. Rows that the CSV splitter blows out to >8 columns because the Message
 *     contained unescaped inner double-quotes AND commas (Whatnot's "Show Boost"
 *     style rows). For those, the first 4 fields and last 3 fields are reliable,
 *     so we keep them and re-join everything in between as the Message.
 *
 * A row that exactly equals the header is skipped (defends against the header
 * appearing again mid-file).
 *
 * @param {string} csvText
 * @returns {{ rows: object[], warnings: string[] }}
 */
function parseLedgerRows(csvText) {
  const warnings = []
  const grid = parseCsv(csvText)
  if (grid.length === 0) return { rows: [], warnings }

  let repaired = 0
  let amountErrors = 0
  let dateErrors = 0
  const rows = []

  // First non-empty grid line is the header; we drop it. (We don't rely on its
  // exact contents — the column ORDER is what matters.)
  let start = 0
  // Skip leading blank lines, then the header.
  while (start < grid.length && grid[start].every((c) => c === '')) start += 1
  start += 1 // consume the header row

  for (let r = start; r < grid.length; r++) {
    const raw = grid[r]
    if (!raw || raw.every((c) => c === '')) continue // blank line
    // Skip a row that exactly equals the header (defensive against repeats).
    if (raw.length === HEADER.length && raw.every((c, idx) => c === HEADER[idx])) continue

    let created, amount, lid, oid, msg, status, ttype, completed
    if (raw.length === EXPECTED_COLS) {
      ;[created, amount, lid, oid, msg, status, ttype, completed] = raw
    } else if (raw.length > EXPECTED_COLS) {
      // Known malformed case: keep first 4 + last 3, join the middle as Message.
      created = raw[0]; amount = raw[1]; lid = raw[2]; oid = raw[3]
      completed = raw[raw.length - 1]
      ttype = raw[raw.length - 2]
      status = raw[raw.length - 3]
      msg = raw.slice(4, raw.length - 3).join(',')
      repaired += 1
    } else {
      // Short row: pad with empty strings so destructuring is safe.
      const padded = raw.concat(Array(EXPECTED_COLS - raw.length).fill(''))
      ;[created, amount, lid, oid, msg, status, ttype, completed] = padded
    }

    const type = classify(ttype, msg)

    // Parse amount (default 0 on failure, but record a warning).
    let amt = 0
    try {
      amt = parseAmount(amount)
    } catch (_e) {
      amountErrors += 1
      if (amountErrors <= 5) warnings.push(`row ${r + 1}: ${_e.message}`)
    }

    // Parse the day key from the Created Date (null if unparseable).
    let dayKey = null
    try {
      dayKey = parseDayKey(created)
    } catch (_e) {
      dateErrors += 1
      if (dateErrors <= 5) warnings.push(`row ${r + 1}: ${_e.message}`)
    }

    const out = {
      createdDate: created,
      dayKey,
      amount: amt,
      message: msg,
      type,
    }
    // Decompose earnings into product / break / team for grouping.
    if (type === 'earning') {
      const { product, breakNumber, team } = parseSaleMessage(msg)
      out.product = product
      out.productKey = productKeyOf(product)
      out.breakNumber = breakNumber
      out.team = team
    }
    rows.push(out)
  }

  if (repaired > 0) warnings.push(`repaired ${repaired} malformed row(s) (unescaped quotes/commas in Message)`)
  return { rows, warnings }
}

// ---------------------------------------------------------------------------
// ANALYSIS
// ---------------------------------------------------------------------------

/** Round to 2 decimals at the output boundary (and normalize -0 -> 0). */
function round2(n) {
  const r = Math.round((Number(n) + Number.EPSILON) * 100) / 100
  return Object.is(r, -0) ? 0 : r
}

/**
 * Normalize the user-entered manual cost inputs (COGS, shipping, supplies,
 * labor, hours, cancellations). Every dollar/rate field is coerced to a
 * non-negative number; "total" overrides are null when blank (so a per-unit
 * rate is used instead). hoursLog is a list of { id, date, hours, note }.
 * Pure + defensive so a malformed persisted object never throws downstream.
 * @param {object} ci
 */
function normalizeCostInputs(ci) {
  const c = ci && typeof ci === 'object' ? ci : {}
  const num = (v) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : 0 }
  const orNull = (v) => { if (v == null || v === '') return null; const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : null }
  const hoursLog = Array.isArray(c.hoursLog) ? c.hoursLog.map((h, i) => ({
    id: (h && h.id) || `h${i}`, date: String((h && h.date) || ''), hours: num(h && h.hours), note: String((h && h.note) || ''),
  })) : []
  return {
    giveawayCogsPerUnit: num(c.giveawayCogsPerUnit), giveawayCogsTotal: orNull(c.giveawayCogsTotal),
    giveawayShipPerUnit: num(c.giveawayShipPerUnit), giveawayShipTotal: orNull(c.giveawayShipTotal),
    suppliesTotal: num(c.suppliesTotal), laborDirect: num(c.laborDirect), laborHourlyRate: num(c.laborHourlyRate),
    hoursLog, cancellationsOverride: orNull(c.cancellationsOverride),
    productGrouping: c.productGrouping === 'full' ? 'full' : 'family',
  }
}

/** Whole-day difference between two YYYY-MM-DD day keys (b - a), inclusive-safe. */
function dayDiff(a, b) {
  const [ay, am, ad] = a.split('-').map(Number)
  const [by, bm, bd] = b.split('-').map(Number)
  const da = Date.UTC(ay, am - 1, ad)
  const db = Date.UTC(by, bm - 1, bd)
  return Math.round((db - da) / 86400000)
}

/**
 * Aggregate classified rows into the full analysis object (see spec). The shape
 * mirrors the reference script exactly; all money is rounded to 2 decimals at
 * this boundary only.
 *
 * @param {object[]} rows  output of parseLedgerRows().rows
 * @param {{ breaksPerCase?: number }} [opts]
 * @returns {object}
 */
function analyzeLedger(rows, { breaksPerCase = 9, costInputs = {} } = {}) {
  // Guard the divisor: a case must hold at least one break.
  const bpc = Math.max(1, Math.floor(Number(breaksPerCase) || 9))
  // Normalize the manual cost inputs (authoritative here — callers may pass raw).
  const ci = normalizeCostInputs(costInputs)
  const groupFull = ci.productGrouping === 'full'

  const totals = {
    grossEarnings: 0,
    giveawayLost: 0,
    netRevenue: 0,
    adjustments: 0,
    tips: 0,
    payoutsIgnoredCount: 0,
    payoutsIgnoredSum: 0,
    earningCount: 0,
    giveawayCount: 0,
    adjustmentCount: 0,
    tipCount: 0,
    otherCount: 0,
    // Memo accumulators: unclassified SALES sum, auto-detected refunds, and
    // negative earnings (a partial refund landing on an earning row).
    otherSum: 0,
    refundCount: 0,
    refundsSum: 0,
    refundedEarningsCount: 0,
    refundedEarningsSum: 0,
  }

  // day -> { gross, giveaway, count }
  const perDayMap = new Map()
  // Per-break revenue keyed by (dayKey, productKey, breakNumber) - the same
  // break number on different days no longer merges. Value carries the display
  // product label, the day, and a human label.
  // key = `${dayKey}|${productKey}|${breakNumber}`
  const perBreakMap = new Map()
  // Per-day drill-down: same (dayKey, productKey, breakNumber) key -> that day's
  // break/product revenue contribution. Grouped back per-day at output time.
  const perDayBreakdownMap = new Map()
  // productKey -> { product(display), breaks:Set<number>, revenue }
  const byProductMap = new Map()
  const unattributed = { count: 0, revenue: 0 }
  // day -> { revenue, count } of earnings with NO Break #N, so the per-day
  // drill-down can show an "Unattributed sales" bucket and reconcile to gross.
  const perDayUnattributedMap = new Map()
  // --- Product/sale-type analytics (over ALL earnings) ---------------------
  // familyKey -> { productLabel, product, revenue, count } — revenue by product.
  const productFamilyMap = new Map()
  // saleType -> { revenue, count } — the team-break / case / box / random mix.
  const saleTypeMap = new Map()
  // `${day}|${familyKey}` -> { productLabel, revenue, count } — day drill-down
  // by product (reconciles to the day's gross).
  const perDayProductsMap = new Map()
  // Costs & extras: giveaways, tips, and the ADJUSTMENT bucket split by message
  // into shipping subsidy (income), shipping cost, promotion/boost fee, seller
  // bonus (income), other fees, and other positive adjustments. platformFees is
  // kept as a deprecated alias (= the old lump of ALL negative adjustments).
  const costs = {
    giveaways: 0, shippingSubsidies: 0, shippingCosts: 0, promotionFees: 0,
    sellerBonuses: 0, otherFees: 0, platformFees: 0, otherAdjustments: 0, tips: 0,
  }
  const daysSeen = new Set()
  const warnings = []
  let otherSampled = 0

  const bumpDay = (day, field, amt) => {
    if (!day) return
    daysSeen.add(day)
    let d = perDayMap.get(day)
    if (!d) { d = { gross: 0, giveaway: 0, count: 0 }; perDayMap.set(day, d) }
    d[field] += amt
    d.count += 1
  }

  for (const row of rows) {
    const amt = Number(row.amount) || 0
    switch (row.type) {
      case 'earning': {
        totals.grossEarnings += amt
        totals.earningCount += 1
        if (amt < 0) { totals.refundedEarningsCount += 1; totals.refundedEarningsSum += amt }
        bumpDay(row.dayKey, 'gross', amt)
        // Revenue by product family (ALL earnings, attributed or not), the
        // sale-type mix, and the per-day product breakdown. Grouping is 'family'
        // (clean short label) by default or 'full' (exact product string) when
        // the user opts in. The representative `product` is the highest-revenue
        // single row in the group, so hovers show a real, meaningful name.
        const famLabel = groupFull ? row.product : productFamily(row.product)
        const famKey = groupFull ? row.productKey : famLabel.toUpperCase()
        let fam = productFamilyMap.get(famKey)
        if (!fam) { fam = { productLabel: famLabel, product: row.product, _maxAmt: amt, revenue: 0, count: 0 }; productFamilyMap.set(famKey, fam) }
        fam.revenue += amt; fam.count += 1
        if (amt > fam._maxAmt) { fam._maxAmt = amt; fam.product = row.product }
        const stype = classifySaleType(row)
        let st = saleTypeMap.get(stype)
        if (!st) { st = { revenue: 0, count: 0 }; saleTypeMap.set(stype, st) }
        st.revenue += amt; st.count += 1
        if (row.dayKey) {
          const dpKey = `${row.dayKey}|${famKey}`
          let dp = perDayProductsMap.get(dpKey)
          if (!dp) { dp = { productLabel: famLabel, product: row.product, _maxAmt: amt, revenue: 0, count: 0 }; perDayProductsMap.set(dpKey, dp) }
          dp.revenue += amt; dp.count += 1
          if (amt > dp._maxAmt) { dp._maxAmt = amt; dp.product = row.product }
        }
        if (row.breakNumber != null) {
          const pkey = row.productKey
          // Group per-break by (dayKey, productKey, breakNumber) so the same
          // break number on different days/events no longer merges.
          const bkey = `${row.dayKey}|${pkey}|${row.breakNumber}`
          let pb = perBreakMap.get(bkey)
          if (!pb) {
            pb = {
              product: row.product,
              breakNumber: row.breakNumber,
              day: row.dayKey,
              label: `Break ${row.breakNumber} · ${productFamily(row.product)} · ${formatDayLabel(row.dayKey)}`,
              revenue: 0,
              count: 0,
            }
            perBreakMap.set(bkey, pb)
          }
          pb.revenue += amt
          pb.count += 1
          // Per-day drill-down: only break-attributed earning rows contribute
          // (giveaways/unattributed never leak in). Same composite key as above.
          let db = perDayBreakdownMap.get(bkey)
          if (!db) {
            db = {
              label: `Break ${row.breakNumber} · ${productFamily(row.product)}`,
              product: row.product,
              breakNumber: row.breakNumber,
              day: row.dayKey,
              revenue: 0,
              count: 0,
            }
            perDayBreakdownMap.set(bkey, db)
          }
          db.revenue += amt
          db.count += 1
          let bp = byProductMap.get(pkey)
          if (!bp) { bp = { product: row.product, breaks: new Set(), revenue: 0 }; byProductMap.set(pkey, bp) }
          bp.breaks.add(row.breakNumber)
          bp.revenue += amt
        } else {
          unattributed.count += 1
          unattributed.revenue += amt
          // Also bucket unattributed earnings per day so the drill-down reconciles
          // to the day's gross (attributed breaks + unattributed = gross).
          if (row.dayKey) {
            let ud = perDayUnattributedMap.get(row.dayKey)
            if (!ud) { ud = { revenue: 0, count: 0 }; perDayUnattributedMap.set(row.dayKey, ud) }
            ud.revenue += amt
            ud.count += 1
          }
        }
        break
      }
      case 'giveaway':
        totals.giveawayLost += amt // amounts are <= 0
        totals.giveawayCount += 1
        bumpDay(row.dayKey, 'giveaway', amt)
        break
      case 'adjustment': {
        totals.adjustments += amt
        totals.adjustmentCount += 1
        // Split the ADJUSTMENT bucket by its message so each real cost/income is
        // visible on its own (the old code lumped every negative one together):
        //   "Shipping Subsidy"                          -> income (shippingSubsidies)
        //   "Whatnot platform charge for shipping ..."  -> shipping COST
        //   "Seller purchased Show Boost ..."           -> promotion fee
        //   "Super Seller Bonus"                        -> income (sellerBonuses)
        //   any other negative                          -> otherFees
        //   any other positive                          -> otherAdjustments
        // The `amt < 0` guards keep a positive "Show Boost"/"shipping" line on
        // the income side rather than mis-filing it as a fee. First match wins.
        const m = row.message || ''
        if (amt > 0 && /shipping\s*subsid/i.test(m)) costs.shippingSubsidies += amt
        else if (amt < 0 && /shipping/i.test(m)) costs.shippingCosts += amt
        else if (amt < 0 && /boost|promo/i.test(m)) costs.promotionFees += amt
        else if (amt > 0 && /bonus/i.test(m)) costs.sellerBonuses += amt
        else if (amt < 0) costs.otherFees += amt
        else costs.otherAdjustments += amt
        break
      }
      case 'tip':
        totals.tips += amt
        totals.tipCount += 1
        break
      case 'payout_ignored':
        totals.payoutsIgnoredCount += 1
        totals.payoutsIgnoredSum += amt
        // intentionally excluded from revenue, perDay and date range
        break
      default: { // 'other' — includes best-effort refund/cancellation detection
        const m = row.message || ''
        if (amt < 0 && /refund|cancel|return|reversal/i.test(m)) {
          // A negative SALES row that reads as a refund/cancellation. Tracked as
          // its own bucket (magnitude subtracted from profit); NOT counted as an
          // "unclassified" warning and NOT fed into gross / the date range.
          totals.refundCount += 1
          totals.refundsSum += amt // <= 0
        } else {
          totals.otherCount += 1
          totals.otherSum += amt
          if (otherSampled < 10) {
            warnings.push(`unclassified SALES row: ${JSON.stringify(String(m).slice(0, 80))}`)
            otherSampled += 1
          }
        }
        break
      }
    }
  }

  const netRevenueRaw = totals.grossEarnings + totals.giveawayLost // giveawayLost <= 0

  // Date range over COUNTED rows only (earning + giveaway feed daysSeen).
  let start = null
  let end = null
  if (daysSeen.size > 0) {
    const sorted = [...daysSeen].sort()
    start = sorted[0]
    end = sorted[sorted.length - 1]
  }
  const days = start && end ? dayDiff(start, end) + 1 : 0

  // Group the per-day drill-down entries by their dayKey (first segment of the
  // composite `${dayKey}|${productKey}|${breakNumber}` key). Each perDay row
  // gets only its own day's break/product contributions.
  const breakdownByDay = new Map()
  for (const [key, v] of perDayBreakdownMap.entries()) {
    const day = key.slice(0, key.indexOf('|'))
    let list = breakdownByDay.get(day)
    if (!list) { list = []; breakdownByDay.set(day, list) }
    list.push({
      label: v.label,
      product: v.product,
      breakNumber: v.breakNumber,
      revenue: round2(v.revenue),
      count: v.count,
    })
  }

  // Append each day's UNATTRIBUTED earnings (sales with no Break #N) as a single
  // bucket so the drill-down accounts for the WHOLE day's gross — otherwise a day
  // dominated by unattributed sales would appear to lose most of its revenue.
  for (const [day, ud] of perDayUnattributedMap.entries()) {
    if (round2(ud.revenue) === 0 && ud.count === 0) continue
    let list = breakdownByDay.get(day)
    if (!list) { list = []; breakdownByDay.set(day, list) }
    list.push({
      label: 'Unattributed sales',
      product: null,
      breakNumber: null,
      revenue: round2(ud.revenue),
      count: ud.count,
      unattributed: true,
    })
  }

  // Per-day PRODUCT breakdown (cleaner than the per-break one for a day view):
  // group each day's earnings by product family. sum(products.revenue) == gross.
  const productsByDay = new Map()
  for (const [key, v] of perDayProductsMap.entries()) {
    const day = key.slice(0, key.indexOf('|'))
    let list = productsByDay.get(day)
    if (!list) { list = []; productsByDay.set(day, list) }
    list.push({ productLabel: v.productLabel, product: v.product, revenue: round2(v.revenue), count: v.count })
  }

  // perDay sorted ascending by day. `products` is that day's revenue grouped by
  // product family (sums to gross) — the drill-down the dashboard shows. The
  // legacy `breakdown` (per-break + an "Unattributed sales" bucket) is kept for
  // back-compat; both reconcile to the day's GROSS earnings.
  const perDay = [...perDayMap.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([day, v]) => ({
      day,
      gross: round2(v.gross),
      giveaway: round2(v.giveaway),
      net: round2(v.gross + v.giveaway),
      count: v.count,
      products: (productsByDay.get(day) || []).sort((a, b) => b.revenue - a.revenue),
      breakdown: (breakdownByDay.get(day) || []).sort((a, b) => b.revenue - a.revenue),
    }))

  // perBreak: keyed by (dayKey, productKey, breakNumber); carries the display
  // product label, its day, and a human `label` ("Break 8 · Cosmic Chrome ·
  // Jun 28"). Deterministic stable sort across days: product, then breakNumber,
  // then day.
  const perBreak = [...perBreakMap.values()]
    .map((v) => ({
      product: v.product,
      productLabel: productFamily(v.product),
      breakNumber: v.breakNumber,
      day: v.day,
      label: v.label,
      revenue: round2(v.revenue),
      count: v.count,
    }))
    .sort((a, b) => {
      const p = a.product.localeCompare(b.product)
      if (p !== 0) return p
      if (a.breakNumber !== b.breakNumber) return a.breakNumber - b.breakNumber
      return a.day.localeCompare(b.day)
    })

  // perCase: per product, breaks = #distinct break numbers, cases = ceil(breaks/bpc).
  // Products never share a case, so totalCases is the sum of per-product cases.
  let totalBreaks = 0
  let attributedRevenue = 0
  let totalCases = 0
  const byProduct = [...byProductMap.values()]
    .map((p) => {
      const breaks = p.breaks.size
      const cases = Math.ceil(breaks / bpc)
      totalBreaks += breaks
      totalCases += cases
      attributedRevenue += p.revenue
      return { product: p.product, productLabel: productFamily(p.product), breaks, cases, revenue: round2(p.revenue) }
    })
    .sort((a, b) => {
      const p = a.product.localeCompare(b.product)
      if (p !== 0) return p
      return b.revenue - a.revenue
    })

  const avgRevenuePerBreak = totalBreaks ? attributedRevenue / totalBreaks : 0
  const avgRevenuePerCase = totalCases ? attributedRevenue / totalCases : 0

  // Revenue by product family across ALL earnings (the dashboard's hero view).
  // pctOfGross is each family's share of gross earnings; sum(revenue) == gross.
  const grossForPct = totals.grossEarnings || 1
  const revenueByProduct = [...productFamilyMap.values()]
    .map((f) => ({
      productLabel: f.productLabel,
      product: f.product,
      revenue: round2(f.revenue),
      count: f.count,
      avg: round2(f.count ? f.revenue / f.count : 0),
      pctOfGross: round2((f.revenue / grossForPct) * 100),
    }))
    .sort((a, b) => b.revenue - a.revenue)

  // Sale-type mix — reframes the old "unattributed" as real categories.
  const saleTypeMix = [...saleTypeMap.entries()]
    .map(([type, v]) => ({
      type,
      label: SALE_TYPE_LABELS[type] || type,
      revenue: round2(v.revenue),
      count: v.count,
      pctOfGross: round2((v.revenue / grossForPct) * 100),
    }))
    .sort((a, b) => b.revenue - a.revenue)

  // Costs & extras summary. giveaways/tips mirror the totals; the ADJUSTMENT
  // bucket is now split into named income/cost lines.
  costs.giveaways = round2(totals.giveawayLost)
  costs.tips = round2(totals.tips)
  costs.shippingSubsidies = round2(costs.shippingSubsidies)
  costs.shippingCosts = round2(costs.shippingCosts)
  costs.promotionFees = round2(costs.promotionFees)
  costs.sellerBonuses = round2(costs.sellerBonuses)
  costs.otherFees = round2(costs.otherFees)
  costs.otherAdjustments = round2(costs.otherAdjustments)
  // Deprecated alias — the OLD "platformFees" lump = every negative adjustment
  // (shipping cost + promotion fee + other fees). Kept for back-compat; the UI
  // now shows the split fields instead.
  costs.platformFees = round2(costs.shippingCosts + costs.promotionFees + costs.otherFees)
  // Net of every adjustment line — invariant: adjustmentsNet === totals.adjustments.
  costs.adjustmentsNet = round2(costs.shippingSubsidies + costs.shippingCosts + costs.promotionFees + costs.sellerBonuses + costs.otherFees + costs.otherAdjustments)
  // Net shipping = subsidy income minus shipping cost (a quick "is shipping
  // paying for itself?" read-out).
  costs.netShipping = round2(costs.shippingSubsidies + costs.shippingCosts)

  // --- Ledger composition (raw transaction vocabulary) ----------------------
  // The counts + sums of each RAW ledger type, so the operator can see what the
  // file actually contained (distinct from the derived sale-category mix).
  const transactionMix = [
    { type: 'earning', label: 'Sales (earnings)', count: totals.earningCount, amount: round2(totals.grossEarnings) },
    { type: 'giveaway', label: 'Giveaways', count: totals.giveawayCount, amount: round2(totals.giveawayLost) },
    { type: 'adjustment', label: 'Adjustments', count: totals.adjustmentCount, amount: round2(totals.adjustments) },
    { type: 'tip', label: 'Tips', count: totals.tipCount, amount: round2(totals.tips) },
    { type: 'payout', label: 'Payouts (ignored)', count: totals.payoutsIgnoredCount, amount: round2(totals.payoutsIgnoredSum) },
    { type: 'other', label: 'Unclassified', count: totals.otherCount, amount: round2(totals.otherSum) },
  ]

  // --- PROFIT model ---------------------------------------------------------
  // Start from the ledger's own net (revenue + every adjustment line), then
  // subtract the manual cost inputs the operator entered. All math on RAW
  // values; round only at the output boundary (avoids penny drift).
  //   ledgerNet      = grossEarnings + giveawayLost + adjustments
  //   initialProfit  = ledgerNet − giveawayCOGS − giveawayShipping − cancellations
  //   fullProfit     = initialProfit − supplies − labor
  const gc = ci.giveawayCogsTotal != null ? ci.giveawayCogsTotal : ci.giveawayCogsPerUnit * totals.giveawayCount
  const gs = ci.giveawayShipTotal != null ? ci.giveawayShipTotal : ci.giveawayShipPerUnit * totals.giveawayCount
  const loggedHours = ci.hoursLog.reduce((s, h) => s + h.hours, 0)
  const laborFromHours = ci.laborHourlyRate * loggedHours
  const labor = ci.laborDirect + laborFromHours
  const supplies = ci.suppliesTotal
  const cancellationsAuto = -totals.refundsSum // magnitude >= 0
  const cancellations = ci.cancellationsOverride != null ? ci.cancellationsOverride : cancellationsAuto
  const ledgerNet = netRevenueRaw + totals.adjustments
  const initialProfit = ledgerNet - gc - gs - cancellations
  const fullProfit = initialProfit - supplies - labor
  const gForM = totals.grossEarnings || 0
  const profit = {
    grossSales: round2(totals.grossEarnings),
    ledgerNet: round2(ledgerNet),
    breakCount: totalBreaks,
    giveawayCount: totals.giveawayCount,
    grossSalesPerBreak: round2(totalBreaks ? totals.grossEarnings / totalBreaks : 0),
    income: {
      grossEarnings: round2(totals.grossEarnings),
      shippingSubsidies: costs.shippingSubsidies,
      sellerBonuses: costs.sellerBonuses,
      otherAdjustments: costs.otherAdjustments,
    },
    costs: {
      shippingCosts: round2(-costs.shippingCosts),
      promotionFees: round2(-costs.promotionFees),
      otherFees: round2(-costs.otherFees),
      giveawayCharge: round2(-totals.giveawayLost), // memo: already inside ledgerNet
      cancellations: round2(cancellations),
      giveawayCogs: round2(gc),
      giveawayShipping: round2(gs),
      supplies: round2(supplies),
      labor: round2(labor),
    },
    labor: {
      direct: round2(ci.laborDirect),
      hourlyRate: round2(ci.laborHourlyRate),
      hours: round2(loggedHours),
      hourlyCost: round2(laborFromHours),
      total: round2(labor),
    },
    hours: {
      total: round2(loggedHours),
      revenuePerHour: round2(loggedHours ? totals.grossEarnings / loggedHours : 0),
      profitPerHour: round2(loggedHours ? fullProfit / loggedHours : 0),
    },
    cancellationsDetail: {
      count: totals.refundCount,
      amount: round2(cancellations),
      auto: round2(cancellationsAuto),
      source: ci.cancellationsOverride != null ? 'override' : 'auto',
    },
    initialProfit: round2(initialProfit),
    fullProfit: round2(fullProfit),
    initialMargin: round2(gForM ? (initialProfit / gForM) * 100 : 0),
    fullMargin: round2(gForM ? (fullProfit / gForM) * 100 : 0),
  }

  return {
    dateRange: { start, end, days },
    revenueByProduct,
    saleTypeMix,
    transactionMix,
    profit,
    costInputs: ci,
    costs,
    totals: {
      grossEarnings: round2(totals.grossEarnings),
      giveawayLost: round2(totals.giveawayLost),
      netRevenue: round2(netRevenueRaw),
      adjustments: round2(totals.adjustments),
      tips: round2(totals.tips),
      payoutsIgnoredCount: totals.payoutsIgnoredCount,
      payoutsIgnoredSum: round2(totals.payoutsIgnoredSum),
      earningCount: totals.earningCount,
      giveawayCount: totals.giveawayCount,
      adjustmentCount: totals.adjustmentCount,
      tipCount: totals.tipCount,
      otherCount: totals.otherCount,
      otherSum: round2(totals.otherSum),
      refundCount: totals.refundCount,
      refundsSum: round2(totals.refundsSum),
      refundedEarningsCount: totals.refundedEarningsCount,
      refundedEarningsSum: round2(totals.refundedEarningsSum),
    },
    perDay,
    perBreak,
    perCase: {
      breaksPerCase: bpc,
      totalBreaks,
      totalCases,
      attributedRevenue: round2(attributedRevenue),
      avgRevenuePerBreak: round2(avgRevenuePerBreak),
      avgRevenuePerCase: round2(avgRevenuePerCase),
      byProduct,
    },
    unattributed: {
      count: unattributed.count,
      revenue: round2(unattributed.revenue),
    },
    warnings,
  }
}

module.exports = {
  parseLedgerRows,
  analyzeLedger,
  // Exported for completeness / potential reuse; not part of the public contract.
  _internal: { parseAmount, parseDayKey, parseSaleMessage, productKeyOf, classify, parseCsv, simplifyProduct, formatDayLabel, productFamily, normalizeCostInputs },
}
