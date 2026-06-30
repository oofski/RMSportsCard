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
function analyzeLedger(rows, { breaksPerCase = 9 } = {}) {
  // Guard the divisor: a case must hold at least one break.
  const bpc = Math.max(1, Math.floor(Number(breaksPerCase) || 9))

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
  }

  // day -> { gross, giveaway, count }
  const perDayMap = new Map()
  // productKey -> { revenue, count } per break number, plus the display label.
  // key = `${productKey} ${breakNumber}`
  const perBreakMap = new Map()
  // productKey -> { product(display), breaks:Set<number>, revenue }
  const byProductMap = new Map()
  const unattributed = { count: 0, revenue: 0 }
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
        bumpDay(row.dayKey, 'gross', amt)
        if (row.breakNumber != null) {
          const pkey = row.productKey
          const bkey = `${pkey} ${row.breakNumber}`
          let pb = perBreakMap.get(bkey)
          if (!pb) {
            pb = { product: row.product, breakNumber: row.breakNumber, revenue: 0, count: 0 }
            perBreakMap.set(bkey, pb)
          }
          pb.revenue += amt
          pb.count += 1
          let bp = byProductMap.get(pkey)
          if (!bp) { bp = { product: row.product, breaks: new Set(), revenue: 0 }; byProductMap.set(pkey, bp) }
          bp.breaks.add(row.breakNumber)
          bp.revenue += amt
        } else {
          unattributed.count += 1
          unattributed.revenue += amt
        }
        break
      }
      case 'giveaway':
        totals.giveawayLost += amt // amounts are <= 0
        totals.giveawayCount += 1
        bumpDay(row.dayKey, 'giveaway', amt)
        break
      case 'adjustment':
        totals.adjustments += amt
        totals.adjustmentCount += 1
        break
      case 'tip':
        totals.tips += amt
        totals.tipCount += 1
        break
      case 'payout_ignored':
        totals.payoutsIgnoredCount += 1
        totals.payoutsIgnoredSum += amt
        // intentionally excluded from revenue, perDay and date range
        break
      default: // 'other'
        totals.otherCount += 1
        if (otherSampled < 10) {
          warnings.push(`unclassified SALES row: ${JSON.stringify(String(row.message || '').slice(0, 80))}`)
          otherSampled += 1
        }
        break
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

  // perDay sorted ascending by day.
  const perDay = [...perDayMap.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([day, v]) => ({
      day,
      gross: round2(v.gross),
      giveaway: round2(v.giveaway),
      net: round2(v.gross + v.giveaway),
      count: v.count,
    }))

  // perBreak: display product label; sorted by product then breakNumber.
  const perBreak = [...perBreakMap.values()]
    .map((v) => ({
      product: v.product,
      breakNumber: v.breakNumber,
      revenue: round2(v.revenue),
      count: v.count,
    }))
    .sort((a, b) => {
      const p = a.product.localeCompare(b.product)
      if (p !== 0) return p
      return a.breakNumber - b.breakNumber
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
      return { product: p.product, breaks, cases, revenue: round2(p.revenue) }
    })
    .sort((a, b) => {
      const p = a.product.localeCompare(b.product)
      if (p !== 0) return p
      return b.revenue - a.revenue
    })

  const avgRevenuePerBreak = totalBreaks ? attributedRevenue / totalBreaks : 0
  const avgRevenuePerCase = totalCases ? attributedRevenue / totalCases : 0

  return {
    dateRange: { start, end, days },
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
  _internal: { parseAmount, parseDayKey, parseSaleMessage, productKeyOf, classify, parseCsv },
}
