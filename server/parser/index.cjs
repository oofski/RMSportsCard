// =============================================================================
// RM Cardz — Whatnot PDF parser (spec §5)
// -----------------------------------------------------------------------------
// Turns the per-page text of a Whatnot order export into the normalized dataset
// that server/db.cjs#importDataset expects (see the shape contract in db.cjs).
//
// Two entry points:
//   - parsePdf(buffer, opts)  : extract text then parse (the production path).
//   - parsePages(pages, opts) : PURE core over already-extracted page strings.
//                               This is the testable heart of the parser — it
//                               performs no I/O and is fully deterministic, so
//                               the whole grammar can be unit-tested with hand-
//                               written `pages` fixtures (no real PDF needed).
//
// The Whatnot export interleaves, per customer:
//   1. one or more "Whatnot Packing Slip" pages (the physical shipping label —
//      handle, real name, address, USPS tracking, weight, per-order prices), and
//   2. one or more "Whatnot - Breaking Slip" pages (the internal pick document —
//      the authoritative list of which teams were bought in which break).
//
// STRATEGY (why the breaking slip is parsed first):
//   The breaking slip is our GROUND TRUTH for team membership: it explicitly
//   lists "__ Team Name" checkbox lines per break. The packing slip's team data
//   is noisier (free-text product attributes). So we build the team slots from
//   the breaking slip, then SUPPLEMENT shipping/identity facts from the packing
//   slip. When a customer has only a packing slip (no breaking slip), we fall
//   back to deriving teams from the packing slip's "Break #N" product lines.
// =============================================================================

const { extractPages } = require('./pdf.cjs')
const { createTeamMatcher, detectSport, SPORTS } = require('./teams.cjs')
const { buildUspsUrl, buildBatchUrls } = require('./batchUrls.cjs')
const RX = require('./regex.cjs')

// --- small generic helpers ---------------------------------------------------

// Split a page string into trimmed, non-empty lines. Most line-anchored regexes
// (REAL_NAME, USER_LINE, TEAM_CHECKBOX, ...) are designed to run per-line.
function toLines(page) {
  return String(page || '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
}

// A breaking-slip section header can WRAP so the product title ends on the word
// "Break" and its "#N" number falls to the NEXT line — e.g.
//     "1x 2026 FINEST BASEBALL HOBBY BOX (NEW RELEASE!)- Break"
//     "#1"
// which splits "Break #N" across two lines so BREAK_HEADER matches neither and
// the whole break — plus its "__ Team" list — is silently dropped (we then fall
// back to the noisy packing slip). Rejoin a line ending in the word "Break" with
// a following line that starts with a SMALL "#N" (1–3 digits) so a 10-digit
// order-id line ("#1187236279") is never mistaken for a break number.
function stitchWrappedBreakHeaders(lines) {
  const out = []
  for (let i = 0; i < lines.length; i++) {
    const cur = lines[i]
    const next = lines[i + 1]
    if (next && /(?:^|\s)Break$/i.test(cur) && /^#\s*\d{1,3}(?:\s|$)/.test(next)) {
      out.push(`${cur} ${next}`)
      i++ // consumed the wrapped "#N" line
      continue
    }
    out.push(cur)
  }
  return out
}

// True for the non-team "structural" lines inside a breaking-slip break section
// (order summaries, item/break counts, totals, page indicators, headers). Used
// to guard the team-name fallback so it only ever promotes a real team line —
// never a structural line — to a purchased slot when the checkbox glyph is gone.
function isStructuralBreakLine(line) {
  return (
    !line ||
    /^Orders:/i.test(line) ||
    /^Total:/i.test(line) ||
    /^Break\s+#/i.test(line) ||
    /^\d+\s+(Item|Items|Item\(s\)|Break|Breaks)\b/i.test(line) ||
    /^Item\(s\)/i.test(line) ||
    /^#\d/.test(line) ||
    /^\d+\s*\/\s*\d+$/.test(line) ||
    /^User\b/i.test(line) ||
    /^Whatnot\b/i.test(line) ||
    /Break(?:ing)?\s+Slip/i.test(line)
  )
}

// Normalize a captured USPS service name to one of the two canonical values the
// UI/db expect. We look for "priority" vs. "ground" tokens (case-insensitive)
// rather than exact-matching the full glyph-laden string ("Priority Mail®").
function normalizeServiceType(raw) {
  const s = String(raw || '').toLowerCase()
  if (s.includes('priority')) return 'Priority Mail'
  if (s.includes('ground')) return 'Ground Advantage'
  // Unknown service: return a trimmed, glyph-stripped version so we never lose
  // information silently, but the two known services above are the common case.
  return String(raw || '').replace(/[®™]/g, '').replace(/\s+/g, ' ').trim() || null
}

// Parse a dollar string ("12.34" or "1,250.00") to a number, defaulting to 0
// (giveaways). Thousands separators are stripped so a big card isn't read as $1.
function toPrice(raw) {
  const n = Number(String(raw == null ? '' : raw).replace(/,/g, ''))
  return Number.isFinite(n) && n >= 0 ? n : 0
}

// Detects an event-date line in either "27 June, 2026" / "June 27, 2026" or
// "2026-06-27" form. Used to know where the address ends and the event block
// begins. US address lines (street, "City, ST 12345") never match this.
const DATE_LINE =
  /\b\d{4}-\d{2}-\d{2}\b|\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2},?\s+\d{4}\b|\b\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*,?\s+\d{4}\b/i

// =============================================================================
// STEP 1 — Split the flat page list into per-customer blocks, keyed by handle.
// -----------------------------------------------------------------------------
// A page is either a packing-slip page (has "Whatnot Packing Slip") or a
// breaking-slip page (has "Whatnot - Breaking Slip"). We associate the two slip
// types for the SAME customer by the Whatnot handle:
//   - packing slip handle  = the "To: <handle>" line
//   - breaking slip handle = the "(handle)" in the USER_LINE under "User"
//
// We bucket by handle into { handle, packingPages:[{page,pageIndex}], breakingPages:[...] }.
// A NEW block conceptually starts at a packing-slip page that carries a
// "To: <handle>" line; continuation packing pages ("2/2") inherit the most
// recent handle (they may omit "To:"), as do breaking-slip pages that follow.
// =============================================================================
function groupByCustomer(pages) {
  // Insertion-ordered map handle -> block, so output order follows first sight.
  const blocks = new Map()
  // The handle most recently established by a "To:" or breaking-slip user line.
  // Continuation pages (no own handle) attach to this.
  let currentHandle = null
  // The slip type of the most recent HEADER-bearing page ('packing' | 'breaking').
  // A breaking slip can span multiple physical pages, and Whatnot does NOT repeat
  // the "Whatnot - Breaking Slip" header on the continuation pages — a continuation
  // page may begin with "Total:", "Orders:", or a bare "__ Team" line. Such a page
  // matches NEITHER slip header, so without this we would drop it (losing every
  // break/team after the first page). We track the last header type so a header-less
  // non-blank page can be attached to the SAME customer under the SAME slip bucket.
  let currentSlip = null

  const ensureBlock = (handle) => {
    if (!blocks.has(handle)) {
      blocks.set(handle, { handle, packingPages: [], breakingPages: [] })
    }
    return blocks.get(handle)
  }

  // Find the breaking slip's own handle: the "(handle)" of the first USER_LINE
  // at/after a "User" label (falling back to any USER_LINE on the page).
  const breakingHandle = (page) => {
    const lines = toLines(page)
    const userIdx = lines.findIndex((l) => /^User\b/i.test(l))
    const searchFrom = userIdx >= 0 ? userIdx + 1 : 0
    for (let i = searchFrom; i < lines.length; i++) {
      const um = lines[i].match(RX.USER_LINE)
      if (um) return um[2]
    }
    return null
  }

  pages.forEach((page, pageIndex) => {
    const isPacking = RX.PACKING_SLIP_START.test(page)
    const isBreaking = RX.BREAKING_SLIP_START.test(page)

    if (isPacking) {
      // Try to read this page's own recipient handle. If present it (re)starts
      // the "current customer"; if absent this is a continuation page (e.g.
      // "2/2") and we keep attaching to the current handle.
      const m = page.match(RX.TO_USERNAME)
      if (m) currentHandle = m[1]
      currentSlip = 'packing'
      if (currentHandle) ensureBlock(currentHandle).packingPages.push({ page, pageIndex })
      return
    }

    if (isBreaking) {
      // Prefer the breaking slip's OWN handle so it groups with the right
      // customer even if pages are ordered oddly; else fall back to current.
      const handle = breakingHandle(page) || currentHandle
      currentSlip = 'breaking'
      if (handle) {
        currentHandle = handle
        ensureBlock(handle).breakingPages.push({ page, pageIndex })
      }
      return
    }

    // A page that matches NEITHER header. Two sub-cases:
    //   (1) Truly blank (cover/separator/empty) -> skip; it carries no data and
    //       must not reset currentHandle/currentSlip (a blank page between "1/2"
    //       and "2/2" must not orphan the continuation).
    //   (2) Non-blank -> it is a header-LESS CONTINUATION of the current slip
    //       (most often a breaking-slip page whose "Whatnot - Breaking Slip"
    //       header was not repeated). Attach it to the current customer under the
    //       current slip's bucket so its breaks/teams are not dropped.
    if (!page || !String(page).trim()) return
    if (currentHandle && currentSlip === 'breaking') {
      // Breaking slips continue WITHOUT repeating their header — attach the page.
      ensureBlock(currentHandle).breakingPages.push({ page, pageIndex })
    } else if (currentHandle && currentSlip === 'packing' && RX.ORDER_ID.test(page)) {
      // A header-less page under a packing slip is a real continuation ONLY if it
      // carries item ("Order <id>") lines. A bare shipping-LABEL page (address +
      // tracking barcode, no order lines) is NOT attached — so a label printed
      // BEFORE its own packing slip can't hijack the previous customer's
      // tracking/weight/service. (Packing pages always repeat the "Whatnot Packing
      // Slip" header, so a genuine 2/2 continuation is handled above, not here.)
      ensureBlock(currentHandle).packingPages.push({ page, pageIndex })
    }
    // else: a label/separator page with no order content — skip (but do NOT reset
    // currentHandle/currentSlip, so a real continuation after it still attaches).
  })

  return [...blocks.values()]
}

// =============================================================================
// STEP 2 — Parse the Breaking Slip as ground truth.
// -----------------------------------------------------------------------------
// Returns { realName, breaks: [{ breakNumber, orderIds:[...], teams:[raw,...] }] }.
// Each "Break #N" header opens a section; every "__ Team Name" line until the
// next "Break #" / "Total:" / end of page is one purchased team slot.
//
// `matchTeam` is the sport-bound matcher (see teams.cjs). It is only consulted
// by the glyph-loss FALLBACK below to decide whether a bare line is a real team.
// =============================================================================
function parseBreakingSlip(block, matchTeam) {
  let realName = null
  // Map breakNumber -> { breakNumber, orderIds:Set, teams:[raw,...] }, so the
  // same break appearing across multiple breaking-slip pages merges cleanly.
  const breakMap = new Map()

  const ensureBreak = (n) => {
    if (!breakMap.has(n)) breakMap.set(n, { breakNumber: n, orderIds: new Set(), teams: [] })
    return breakMap.get(n)
  }

  // The "current break" pointer. A breaking slip can span multiple physical
  // pages with the "Break #N" header on one page and its "__ Team" / "Orders:"
  // lines continuing on the NEXT page (the continuation page has no break header
  // of its own). We therefore declare `current` OUTSIDE the per-page loop so it
  // PERSISTS across pages within one customer's breaking slip; it is only changed
  // by a "Break #N" header (switch) or a "Total:" line (close). Resetting it per
  // page would drop any team that spilled onto a continuation page.
  let current = null

  for (const { page } of block.breakingPages) {
    const lines = stitchWrappedBreakHeaders(toLines(page))

    // Real name from the line under "User" (group 1 of USER_LINE).
    if (!realName) {
      const userIdx = lines.findIndex((l) => /^User\b/i.test(l))
      const searchFrom = userIdx >= 0 ? userIdx + 1 : 0
      for (let i = searchFrom; i < lines.length; i++) {
        const um = lines[i].match(RX.USER_LINE)
        if (um) {
          realName = um[1].trim()
          break
        }
      }
    }

    // Walk the page tracking the "current break" so checkbox/order lines attach
    // to the right section. `current` carries over from the previous page (see
    // the declaration above) so a break split across a page boundary is intact.
    for (const line of lines) {
      const bh = line.match(RX.BREAK_HEADER)
      if (bh) {
        current = ensureBreak(Number(bh[1]))
        continue
      }
      // "Total:" closes the current break section.
      if (RX.BREAK_TOTAL.test(line)) {
        current = null
        continue
      }
      if (!current) continue

      // "Orders: #111 #222" — enumerate every order id on the line.
      if (/^Orders:/i.test(line)) {
        for (const m of line.matchAll(RX.ORDER_IDS_LINE)) current.orderIds.add(m[1])
        continue
      }

      // "__ Team Name" checkbox -> one team slot for this break.
      const cb = line.match(RX.TEAM_CHECKBOX)
      if (cb) {
        const rawTeam = cb[1].trim()
        // Ignore an empty checkbox or the "N Item(s)" count noise.
        if (rawTeam && !/^Item\(s\)$/i.test(rawTeam) && !/^\d+\s+Item\(s\)$/i.test(rawTeam)) {
          current.teams.push(rawTeam)
        }
        continue
      }

      // FALLBACK — recover a team whose checkbox glyph did not survive text
      // extraction. Inside a break section, a non-structural line that
      // confidently resolves to a known team (for this sport) IS a purchased
      // slot. Without
      // this, any breaking slip whose checkboxes render as an unknown glyph would
      // yield ZERO teams and silently fall back to the noisy packing slip — the
      // exact "losing fidelity" failure. We strip any leading marker remnant and
      // require a real team match (matchTeam only resolves within edit-distance 2).
      if (isStructuralBreakLine(line)) continue
      const stripped = line.replace(/^[^A-Za-z0-9]+/, '').trim()
      if (stripped && matchTeam(stripped).team) {
        current.teams.push(stripped)
      }
    }
  }

  return { realName, breaks: [...breakMap.values()] }
}

// =============================================================================
// STEP 3 — Parse the Packing Slip(s) for identity + shipping facts.
// -----------------------------------------------------------------------------
// Returns:
//   { realName, address, isNew, serviceType, trackingNumber, weightOz,
//     orders: [{ breakNumber, team:raw, orderId, price, isGiveaway }] }
//
// Recipient real name: the first REAL_NAME line after the "To:" handle (before
// the "From:" sender block). Address: the lines after that real name up to the
// first clearly-non-address marker (order/USPS/break/weight/NEW).
//
// Tracking: comes from the LAST packing-slip page that carries a USPS line —
// the whole customer ships as ONE parcel, so one tracking number is shared. We
// iterate pages in order and overwrite, so the last-seen value wins.
//
// `matchTeam` is the sport-bound matcher (see teams.cjs), used to canonicalize
// the team text that follows each "Break #N" on a per-order line.
// =============================================================================
function parsePackingSlip(block, matchTeam) {
  let realName = null
  let address = null
  let isNew = false
  let serviceType = null
  let trackingNumber = null
  let weightOz = null
  const orders = []

  block.packingPages.forEach(({ page }) => {
    const lines = toLines(page)

    // isNew: a standalone "NEW" tag line anywhere on the label.
    if (lines.some((l) => /^NEW$/i.test(l))) isNew = true

    const toIdx = lines.findIndex((l) => RX.TO_USERNAME.test(l))
    const fromIdx = lines.findIndex((l) => /^From:/i.test(l))

    // Per spec §2.2 the recipient's real name and shipping address are printed
    // AFTER the "From: rm_cardz" sender block (the seller line is "From:"; the
    // buyer's identity follows it). So we anchor the scan at the From: line —
    // the first proper-case line after it is the recipient's real name, and the
    // following 1–3 lines (until an order/USPS/break/weight/NEW marker) are the
    // address. If there is no From: line we fall back to scanning after "To:".
    const identityStart = fromIdx >= 0 ? fromIdx + 1 : (toIdx >= 0 ? toIdx + 1 : -1)

    if (identityStart >= 0) {
      // Locate the recipient real name line on this page.
      let nameIdx = -1
      if (realName == null) {
        for (let i = identityStart; i < lines.length; i++) {
          const l = lines[i]
          // Stop if we hit order/shipping content before finding a name.
          if (RX.ORDER_ID.test(l) || RX.USPS_LINE.test(l) || RX.BREAK_NUMBER.test(l)) break
          const nm = l.match(RX.REAL_NAME)
          if (nm) {
            realName = nm[1].trim()
            nameIdx = i
            break
          }
        }
      } else {
        nameIdx = lines.indexOf(realName, identityStart)
      }

      // Address: the run of lines immediately after the recipient real name up
      // to the first line that is clearly NOT address. The address is "1–3 lines"
      // (spec §2.2); after it comes the event name + date, so we also stop at a
      // line carrying a price ($) or a date (which begins the event block), and
      // hard-cap at 3 lines so a stray event title never bleeds into the address.
      if (address == null && nameIdx >= 0) {
        const addrLines = []
        for (let i = nameIdx + 1; i < lines.length; i++) {
          if (addrLines.length >= 3) break
          const l = lines[i]
          if (
            RX.ORDER_ID.test(l) ||
            RX.USPS_LINE.test(l) ||
            RX.BREAK_NUMBER.test(l) ||
            RX.WEIGHT_LINE.test(l) ||
            RX.GIVEAWAY_FLAG.test(l) ||
            /^NEW$/i.test(l) ||
            RX.TO_USERNAME.test(l) ||
            /^From:/i.test(l) ||
            /\$[0-9]/.test(l) ||
            DATE_LINE.test(l)
          ) {
            break
          }
          addrLines.push(l)
        }
        if (addrLines.length) address = addrLines.join(', ')
      }
    }

    // Per-order lines: each "Order <id>" line carries a product whose attributes
    // include a "Break #N" and a team. We look at a small window of following
    // lines to gather the break number, team text, price and giveaway signal.
    for (let i = 0; i < lines.length; i++) {
      const om = lines[i].match(RX.ORDER_ID)
      if (!om) continue
      const orderId = om[1]

      // Scope this order's attributes to the lines up to the NEXT "Order <id>"
      // line (capped), so a following order's GIVEAWAY/price can't bleed in.
      let end = i + 1
      while (end < lines.length && end < i + 8 && !RX.ORDER_ID.test(lines[end])) end++
      const windowLines = lines.slice(i, end)
      const windowText = windowLines.join(' ')

      let breakNumber = null
      let team = null
      let price = 0
      let isGiveaway = false

      const bm = windowText.match(RX.BREAK_NUMBER)
      if (bm) breakNumber = Number(bm[1])

      // Team name — Whatnot puts it in one of two places depending on the export:
      //   (a) AFTER "Break #N" in the product attributes ("…- Break #7 Dallas Cowboys")
      //   (b) BEFORE "Order <id>" on the line item ("1 Houston Astros Order 123 $26.00")
      // Collect both candidates, drop "N Item(s)" summary noise, and PREFER the
      // one that resolves to a canonical team. This makes the packing slip a
      // reliable fallback when the breaking slip is unusable — e.g. a compressed
      // PDF whose breaking-slip font mangles the break-number digits so the
      // ground-truth path can't be used.
      const teamCandidates = []
      if (bm) {
        teamCandidates.push(
          windowText.slice(windowText.indexOf(bm[0]) + bm[0].length)
            .replace(/^[\s:|,–—-]*/, '')
            .replace(/\$[0-9.]+.*$/, '')
            .replace(/Order\s+\d+.*$/, '')
            .trim()
        )
      }
      {
        const idx = lines[i].indexOf(om[0])
        if (idx > 0) {
          teamCandidates.push(
            lines[i].slice(0, idx)
              .replace(/^\s*\d+\s*x?\s*/i, '') // strip a leading quantity ("1 ", "2x ")
              .replace(/[\s:|,–—-]+$/, '')
              .trim()
          )
        }
      }
      for (const c of teamCandidates) {
        if (!c || /^\d+\s*items?$/i.test(c)) continue // skip empty + "N Item(s)" noise
        const mt = matchTeam(c)
        if (mt.team) { team = mt.team; break } // a resolved team always wins
        if (!team) team = c // otherwise keep the first plausible raw
      }

      // Price = this item's own subtotal (the first $ on/after the order line).
      const pm = windowText.match(/\$([0-9][0-9,]*(?:\.[0-9]{2})?)/)
      if (pm) price = toPrice(pm[1])
      // A card is a giveaway IFF its subtotal is $0. The literal "GIVEAWAY" token
      // is NOT reliable on its own: it also appears inside all-caps break/product
      // TITLES (a giveaway-themed release), which would wrongly flag every PAID
      // card in that break as a $0 giveaway. Requiring the $0 subtotal — and only
      // trusting a standalone GIVEAWAY token when the price is also $0 — makes the
      // signal definitive. (A missing/unparseable price defaults to 0 -> giveaway,
      // which is the safe read for a $0 line.)
      isGiveaway = price === 0
      if (isGiveaway) price = 0

      orders.push({ breakNumber, team, orderId, price, isGiveaway })
    }

    // USPS line (service + tracking). Last page with a USPS line wins.
    const usps = page.match(RX.USPS_LINE)
    if (usps) {
      serviceType = normalizeServiceType(usps[1])
      trackingNumber = usps[2] // digits only by regex construction (no '#')
    }

    // Weight (last one wins, same reasoning as tracking).
    const wm = page.match(RX.WEIGHT_LINE)
    if (wm) weightOz = toPrice(wm[1])
  })

  return { realName, address, isNew, serviceType, trackingNumber, weightOz, orders }
}

// Best-effort event name + date from a customer's packing pages. The event line
// typically contains a date ("Aug 12, 2025" or "2025-08-12"); the text before
// the date is the event name. Never throws.
function extractEvent(block, event) {
  if (event.name && event.date) return
  for (const { page } of block.packingPages) {
    for (const l of toLines(page)) {
      if (/^From:|^To:/i.test(l) || RX.ORDER_ID.test(l) || RX.USPS_LINE.test(l)) continue
      const dm = l.match(/(\d{4}-\d{2}-\d{2}|[A-Z][a-z]{2,8}\s+\d{1,2},?\s+\d{4})/)
      if (dm) {
        if (!event.date) event.date = dm[1]
        const namePart = l.slice(0, dm.index).replace(/[-–—:|]+$/, '').trim()
        if (!event.name && namePart) event.name = namePart
        return
      }
    }
  }
}

// Gather raw team strings for sport auto-detection, WITHOUT canonicalizing them
// (detection must not presuppose a sport). We read breaking-slip checkbox names
// (ground truth) plus the "Break #N <team>" text from packing slips (so a
// packing-only PDF can still be classified). We ALSO include bare, non-structural
// breaking-slip lines — the exact glyph-loss case parseBreakingSlip's fallback
// recovers — so an MLB slip whose checkbox markers didn't survive extraction is
// still classified as MLB instead of silently defaulting to NFL. Detection only
// SCORES candidates that match a sport's list, so non-team noise is harmless.
// Cheap, best-effort, never throws.
function collectTeamCandidates(blocks) {
  const out = []
  for (const block of blocks) {
    for (const { page } of block.breakingPages) {
      for (const line of toLines(page)) {
        const cb = line.match(RX.TEAM_CHECKBOX)
        if (cb) {
          const raw = cb[1].trim()
          if (raw && !/^Item\(s\)$/i.test(raw) && !/^\d+\s+Item\(s\)$/i.test(raw)) out.push(raw)
          continue
        }
        // Glyph-loss recovery (mirrors the fallback in parseBreakingSlip): a
        // non-structural bare line MAY be a team whose checkbox marker was lost.
        if (isStructuralBreakLine(line)) continue
        const stripped = line.replace(/^[^A-Za-z0-9]+/, '').trim()
        if (stripped) out.push(stripped)
      }
    }
    for (const { page } of block.packingPages) {
      const lines = toLines(page)
      for (let i = 0; i < lines.length; i++) {
        if (!RX.ORDER_ID.test(lines[i])) continue
        let end = i + 1
        while (end < lines.length && end < i + 8 && !RX.ORDER_ID.test(lines[end])) end++
        const windowText = lines.slice(i, end).join(' ')
        const bm = windowText.match(RX.BREAK_NUMBER)
        if (!bm) continue
        const after = windowText.slice(windowText.indexOf(bm[0]) + bm[0].length)
        const candidate = after
          .replace(/^[\s:|,–—-]*/, '')
          .replace(/\$[0-9.]+.*$/, '')
          .replace(/Order\s+\d+.*$/, '')
          .trim()
        if (candidate) out.push(candidate)
      }
    }
  }
  return out
}

// =============================================================================
// parsePages — the pure, testable core.
// -----------------------------------------------------------------------------
// `sport` selects the canonical team list teams are snapped to: 'nfl' | 'mlb'
// force a league; 'auto' (or omitted/unknown) auto-detects it from the parsed
// team names so the same PDF flow serves either league unchanged.
// =============================================================================
function parsePages(pages, { onProgress, sport } = {}) {
  pages = Array.isArray(pages) ? pages : []
  const warnings = []
  const event = { name: null, date: null }

  // STEP 1 — group pages into per-customer blocks keyed by handle.
  const blocks = groupByCustomer(pages)

  // Resolve the sport, then build the matcher/canonical list ONCE for this parse.
  // An explicit, known sport code wins; anything else ('auto', blank, garbage)
  // auto-detects from the raw team names on the slips.
  const explicit = String(sport || '').toLowerCase().trim()
  const resolvedSport = SPORTS[explicit] ? explicit : detectSport(collectTeamCandidates(blocks))
  const { matchTeam, CANONICAL } = createTeamMatcher(resolvedSport)

  // Accumulators for the normalized dataset.
  const breakNumbers = new Set() // every break number that actually appears
  const customers = []
  const shipments = []
  const orders = []
  const teamSlots = []
  const trackingNumbers = []

  let customersProcessed = 0

  for (const block of blocks) {
    const handle = block.handle

    // STEP 2 — breaking slip = ground truth (teams per break).
    const breaking = parseBreakingSlip(block, matchTeam)
    // STEP 3 — packing slip = identity + shipping + per-order facts.
    const packing = parsePackingSlip(block, matchTeam)

    // STEP 3.5 — reconcile a corrupted breaking-slip break NUMBER against the
    // packing slip. Some Whatnot exports (compressed PDFs) corrupt the DIGITS in
    // the breaking-slip font, so its "Break #N" header can read the wrong number
    // ("Break #2" -> "Break #1") while the team NAMES and the whole packing slip
    // stay clean. The breaking slip is still ground truth for which teams go
    // TOGETHER; we only correct each break's NUMBER to the packing slip's clean
    // value, decided by a vote over the teams/orders the two slips share. On a
    // clean PDF the two agree, so nothing changes.
    if (breaking.breaks.length && packing.orders.length) {
      // Map each packing ORDER ID -> its (clean) break number. Order ids are the
      // ONLY reliable join key here: each id belongs to exactly one break, so it
      // can never fuse two distinct breaks the way a shared TEAM name can (a
      // customer can own the same team in two different breaks). Team-name voting
      // was removed for exactly that reason — it merged distinct breaks even on
      // clean PDFs.
      const packOrderBreak = new Map()
      for (const o of packing.orders) {
        if (o.breakNumber == null || !o.orderId) continue
        packOrderBreak.set(String(o.orderId), o.breakNumber)
      }
      let changed = false
      for (const b of breaking.breaks) {
        const votes = new Map()
        for (const oid of b.orderIds) {
          const bn = packOrderBreak.get(String(oid))
          if (bn != null) votes.set(bn, (votes.get(bn) || 0) + 1)
        }
        if (!votes.size) continue // no packing evidence -> trust the breaking slip
        // Override ONLY on an unambiguous winner: one packing break backed by a
        // strict majority of this break's order ids that beats every other
        // candidate. This corrects a corrupted break number without ever merging
        // two genuinely-distinct breaks.
        const sorted = [...votes.entries()].sort((x, y) => y[1] - x[1])
        const [topBn, topV] = sorted[0]
        const secondV = sorted[1] ? sorted[1][1] : 0
        if (topBn !== b.breakNumber && topV > secondV && topV * 2 > b.orderIds.size) {
          b.breakNumber = topBn
          changed = true
        }
      }
      if (changed) {
        // A correction can collapse two breaks onto one number — merge them so a
        // break number is never emitted twice for one customer.
        const mergedBreaks = new Map()
        for (const b of breaking.breaks) {
          if (!mergedBreaks.has(b.breakNumber)) mergedBreaks.set(b.breakNumber, { breakNumber: b.breakNumber, orderIds: new Set(), teams: [] })
          const m = mergedBreaks.get(b.breakNumber)
          for (const o of b.orderIds) m.orderIds.add(o)
          for (const t of b.teams) m.teams.push(t)
        }
        breaking.breaks = [...mergedBreaks.values()]
      }
    }

    extractEvent(block, event)

    // Prefer the breaking slip's real name (cleaner), fall back to packing slip.
    const realName = breaking.realName || packing.realName || handle

    // --- Customer record -----------------------------------------------------
    customers.push({
      id: handle,
      whatnotHandle: handle,
      realName,
      address: packing.address || '',
      isNew: !!packing.isNew,
    })

    // --- Shipment record (one parcel per customer) ---------------------------
    // Even giveaway-only customers without tracking get a shipment record
    // (trackingNumber may be null). uspsUrl is only set when we have a number.
    const trackingNumber = packing.trackingNumber || null
    if (trackingNumber) trackingNumbers.push(trackingNumber)
    shipments.push({
      id: 'ship_' + handle,
      customerId: handle,
      trackingNumber,
      carrier: 'USPS',
      serviceType: packing.serviceType || null,
      weightOz: packing.weightOz != null ? packing.weightOz : null,
      uspsUrl: trackingNumber ? buildUspsUrl(trackingNumber) : null,
      manualStatus: { code: 'not_shipped', setAt: null, setBy: null },
      notes: null,
      lastUpdated: null,
    })

    // --- Determine the per-break team list -----------------------------------
    // Ground truth = breaking slip. If there is none, fall back to the packing
    // slip's per-order (breakNumber, team) pairs so a packing-only customer
    // still yields teams.
    let breakSpecs // [{ breakNumber, orderIds:[], teams:[raw,...] }]
    if (breaking.breaks.length > 0) {
      breakSpecs = breaking.breaks.map((b) => ({
        breakNumber: b.breakNumber,
        orderIds: [...b.orderIds],
        teams: b.teams.slice(),
      }))
    } else {
      const byBreak = new Map()
      for (const o of packing.orders) {
        if (o.breakNumber == null) continue
        if (!byBreak.has(o.breakNumber)) {
          byBreak.set(o.breakNumber, { breakNumber: o.breakNumber, orderIds: [], teams: [] })
        }
        const slot = byBreak.get(o.breakNumber)
        if (o.team) slot.teams.push(o.team)
        if (o.orderId) slot.orderIds.push(o.orderId)
      }
      breakSpecs = [...byBreak.values()]
    }

    // Index packing-slip orders by break number for supplementing price /
    // giveaway / orderId onto each ground-truth team slot.
    const packingByBreak = new Map()
    for (const o of packing.orders) {
      if (o.breakNumber == null) continue
      if (!packingByBreak.has(o.breakNumber)) packingByBreak.set(o.breakNumber, [])
      packingByBreak.get(o.breakNumber).push(o)
    }

    // --- Emit breaks, team slots and orders ----------------------------------
    // Track which packing-slip orders a team slot has already "consumed" (by
    // reference) so the giveaway sweep below can tell which giveaways were never
    // turned into a slot and therefore still need one.
    const consumedPacks = new Set()
    for (const spec of breakSpecs) {
      const n = spec.breakNumber
      breakNumbers.add(n)
      const breakId = 'break_' + n

      // STEP 7 — one-team-per-break: detect duplicate team names in this break.
      const seenTeams = new Map() // normalizedTeamName -> count

      // Packing-slip orders available to "consume" for this break (to pair an
      // orderId/price with each team slot). Cloned so we can splice.
      const packOrders = (packingByBreak.get(n) || []).slice()

      spec.teams.forEach((rawTeam, i) => {
        // Canonicalize the team; on failure keep raw + warn (STEP 2 rule).
        const mt = matchTeam(rawTeam)
        const teamName = mt.team || rawTeam
        if (!mt.team) {
          warnings.push({
            page: null,
            message: `Unrecognized team "${rawTeam}" in Break #${n} for ${handle}`,
            rawText: rawTeam,
          })
        }

        // Duplicate-team detection (do NOT drop the slot).
        const dupKey = teamName.toLowerCase()
        seenTeams.set(dupKey, (seenTeams.get(dupKey) || 0) + 1)
        if (seenTeams.get(dupKey) === 2) {
          warnings.push({
            page: null,
            message: `Duplicate team "${teamName}" within Break #${n} for ${handle}`,
            rawText: rawTeam,
          })
        }

        // Pair with a packing-slip order (for price / giveaway / orderId). First
        // try to match by canonical team; else consume the next unused order.
        let pack = null
        if (mt.team) {
          const idx = packOrders.findIndex((p) => p.team && matchTeam(p.team).team === mt.team)
          if (idx >= 0) pack = packOrders.splice(idx, 1)[0]
        }
        if (!pack && packOrders.length) pack = packOrders.shift()
        if (pack) consumedPacks.add(pack)

        const orderId = (pack && pack.orderId) || spec.orderIds[i] || spec.orderIds[0] || null
        const isGiveaway = pack ? !!pack.isGiveaway : false
        const price = isGiveaway ? 0 : pack ? pack.price : 0

        teamSlots.push({
          id: `slot_${n}_${handle}_${i}`,
          breakId,
          breakNumber: n,
          teamName,
          customerId: handle,
          orderId,
          price,
          isGiveaway,
          checkedOff: false,
          checkedOffAt: null,
          checkedOffBy: null,
        })

        // One order per team slot (mirrors a purchased team).
        orders.push({
          id: `order_${n}_${handle}_${i}`,
          customerId: handle,
          breakId,
          breakNumber: n,
          teamName,
          price,
          isGiveaway,
        })
      })

      // STEP 6 — cross-reference: warn if the breaking slip's team count for
      // this break disagrees with the packing slip's order count. Never throws.
      if (breaking.breaks.length > 0) {
        const packCount = (packingByBreak.get(n) || []).length
        if (packCount > 0 && packCount !== spec.teams.length) {
          warnings.push({
            page: null,
            message: `Break #${n} for ${handle}: breaking slip lists ${spec.teams.length} team(s) but packing slip shows ${packCount} order(s)`,
            rawText: null,
          })
        }
      }
    }

    // --- Giveaways no break slot claimed -> their own checkable team slot -----
    // A giveaway card the breaking slip never lists as a checkbox team — a promo
    // rider on a paid package, or a package that is JUST a giveaway — is a real
    // physical card that still has to be pulled, bagged and shipped. If we leave
    // it off the team-slot list it vanishes from the pick detail: nothing to
    // check off, and a giveaway-only package renders as an empty order ("No teams
    // on this order"). So emit a REAL team slot (isGiveaway=true, price 0) for
    // every giveaway packing order that no slot above consumed. A giveaway tied
    // to a break groups under it; a break-less promo keeps breakNumber null (it
    // belongs to no break) and never fabricates a phantom Break record.
    let giveawaySeq = 0
    for (const o of packing.orders) {
      if (!o.isGiveaway || consumedPacks.has(o)) continue
      // Dedup: if this giveaway's team is ALREADY a slot for this customer (it was
      // listed on the breaking slip but its packing line was break-less, so it
      // never paired and looked unconsumed), mark THAT slot as the giveaway
      // instead of emitting a duplicate card.
      if (o.team) {
        const gteam = matchTeam(o.team).team || o.team
        const existing = teamSlots.find((ts) => ts.customerId === handle && (matchTeam(ts.teamName).team || ts.teamName) === gteam)
        if (existing) {
          existing.isGiveaway = true
          existing.price = 0
          const eo = orders.find((ord) => ord.id === 'order_' + existing.id.slice('slot_'.length))
          if (eo) { eo.isGiveaway = true; eo.price = 0 }
          continue
        }
      }
      const n = o.breakNumber != null ? o.breakNumber : null
      const breakId = n != null ? 'break_' + n : `giveaway_${handle}`
      if (n != null) breakNumbers.add(n)
      const teamName = o.team || 'Giveaway'
      const key = `g${giveawaySeq++}`
      teamSlots.push({
        id: `slot_${n != null ? n : 'g'}_${handle}_${key}`,
        breakId,
        breakNumber: n,
        teamName,
        customerId: handle,
        orderId: o.orderId || null,
        price: 0,
        isGiveaway: true,
        checkedOff: false,
        checkedOffAt: null,
        checkedOffBy: null,
      })
      orders.push({
        id: `order_${n != null ? n : 'g'}_${handle}_${key}`,
        customerId: handle,
        breakId,
        breakNumber: n,
        teamName,
        price: 0,
        isGiveaway: true,
      })
    }

    // A customer with a shipment but genuinely no cards (not even a giveaway)
    // still produced Customer + Shipment records above, satisfying the spec.

    customersProcessed += 1
    if (typeof onProgress === 'function') {
      onProgress({
        // Text is already extracted before parsePages runs, so from this pure
        // core's vantage point every page is "processed".
        pagesProcessed: pages.length,
        totalPages: pages.length,
        customersFound: customersProcessed,
        breaksFound: breakNumbers.size,
      })
    }
  }

  // Materialize Break records ONLY for break numbers that actually appeared.
  const breaks = [...breakNumbers]
    .sort((a, b) => a - b)
    .map((n) => ({
      id: 'break_' + n,
      breakNumber: n,
      eventName: event.name,
      eventDate: event.date,
      status: 'pending',
    }))

  // ---------------------------------------------------------------------------
  // PER-BREAK FIDELITY AUDIT (across ALL customers)
  // ---------------------------------------------------------------------------
  // A break is a single case slot for every one of the sport's teams (32 NFL /
  // 30 MLB), and a given team belongs to exactly ONE customer per break (spec
  // §2.3). After building every team slot we audit each break so fidelity loss
  // is VISIBLE rather than silent: how many of the full slate we captured, which
  // are missing, and whether any team was assigned to more than one customer (a
  // true data error). The missing list is informational (not every team is
  // necessarily sold), but a COLLISION is surfaced as a hard warning.
  const breakAudit = [...breakNumbers]
    .sort((a, b) => a - b)
    .map((n) => {
      const slots = teamSlots.filter((t) => t.breakNumber === n)
      const byTeam = new Map() // canonical team -> [customerId,...]
      for (const slot of slots) {
        const mt = matchTeam(slot.teamName)
        const canon = mt.team || slot.teamName
        if (!byTeam.has(canon)) byTeam.set(canon, [])
        byTeam.get(canon).push(slot.customerId)
      }
      const missingTeams = CANONICAL.filter((t) => !byTeam.has(t))
      const collisions = []
      for (const [team, custs] of byTeam) {
        const distinct = [...new Set(custs)]
        if (distinct.length > 1) {
          collisions.push({ team, customers: distinct })
          warnings.push({
            page: null,
            message: `Break #${n}: "${team}" is assigned to ${distinct.length} customers (${distinct.join(', ')}) — only one customer may own a team per break`,
            rawText: null,
          })
        }
      }
      return {
        breakNumber: n,
        teamCount: slots.length, // total purchased slots (may exceed distinct if duplicated)
        distinctTeamCount: byTeam.size,
        maxTeams: CANONICAL.length, // 32 (NFL) / 30 (MLB)
        missingCount: missingTeams.length,
        missingTeams,
        // Kept as `hasAll32` for back-compat; means "captured the full slate"
        // (all 32 NFL or all 30 MLB teams) for this sport.
        hasAll32: missingTeams.length === 0,
        collisions,
      }
    })

  // STEP 5 — batched USPS "open all" URLs across every shipment's tracking #.
  const batchUrls = buildBatchUrls(trackingNumbers)

  return {
    event,
    sport: resolvedSport, // which league's canonical list this parse was snapped to
    breaks,
    breakAudit,
    teamSlots,
    customers,
    shipments,
    orders,
    batchUrls,
    warnings,
    totalPages: pages.length,
  }
}

/**
 * Production entry point: extract text from a PDF buffer, then parse it.
 * @param {Buffer} buffer
 * @param {{ onProgress?: Function, sport?: string }} [opts]
 *        sport: 'nfl' | 'mlb' to force a league, or 'auto'/omitted to detect it.
 * @returns {Promise<object>} normalized dataset (see db.cjs contract)
 */
async function parsePdf(buffer, { onProgress, sport } = {}) {
  const pages = await extractPages(buffer)
  return parsePages(pages, { onProgress, sport })
}

module.exports = { parsePdf, parsePages }
