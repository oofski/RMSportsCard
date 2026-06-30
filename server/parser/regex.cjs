// =============================================================================
// RM Cardz — Whatnot PDF regular-expression catalog (spec Appendix A)
// -----------------------------------------------------------------------------
// Every regex the parser relies on lives here as a *named, commented* constant.
// WHY a dedicated module:
//   - A single source of truth for the text-extraction grammar means the spec
//     can be audited against one file, and a formatting change in Whatnot's PDF
//     export only ever requires a one-line edit here (not buried in logic).
//   - Pure data (no logic) -> trivially importable by both the parser and tests.
//
// IMPORTANT regex hygiene notes:
//   - Regexes with the /g (global) flag carry mutable `lastIndex` state. Any
//     constant below that is global is intended to be used ONLY with
//     `String.prototype.matchAll` (which creates a fresh iterator and does not
//     leak lastIndex). Never call `.test()`/`.exec()` repeatedly on a shared
//     global regex — that is a classic stateful-regex bug.
//   - Anchored regexes (^...$) are meant to be matched against a SINGLE trimmed
//     line, not the whole multi-line page string (unless used with /m).
// =============================================================================

// --- Packing Slip (the physical shipping label) -----------------------------

// Marks the top of a "Whatnot Packing Slip" page. Presence of this token is the
// primary signal that a page is a packing slip (vs. a breaking slip).
const PACKING_SLIP_START = /Whatnot Packing Slip/

// Page indicator like "1/2" or "2/2". Group 1 = current page, group 2 = total.
// A packing slip for one customer can span multiple physical pages; the USPS
// tracking line only appears on the LAST page (e.g. the "2/2" page).
const PACKING_SLIP_PAGE = /(\d+)\/(\d+)/

// "To: <handle>" — the recipient's Whatnot handle on the label. We capture a
// run of non-whitespace so handles like "john.doe_99" survive intact. This
// handle is the JOIN KEY tying a packing slip to its breaking slip.
const TO_USERNAME = /To:\s*(\S+)/

// A buyer's real (human) name line: starts with an uppercase letter followed by
// a lowercase letter (so "John Smith" matches but "USPS"/"NEW"/all-caps tokens
// do not), then anything. Anchored — test against a single trimmed line.
const REAL_NAME = /^([A-Z][a-z].+)$/

// "Order 123456" — the Whatnot order id on a packing-slip product line.
const ORDER_ID = /Order\s+(\d+)/

// "Break #7" — the break number a product belongs to (appears on BOTH the
// packing slip product attribute and the breaking slip section header).
// Case-insensitive and tolerant of an optional space after '#' ("Break # 7"),
// because the real PDF text layer is inconsistent about both.
const BREAK_NUMBER = /Break\s+#\s*(\d+)/i

// --- Breaking Slip (the internal pick / break document) ---------------------

// Marks the top of the internal pick doc (our GROUND TRUTH for which teams a
// customer bought in which break). Whatnot has printed this header several ways
// — "Whatnot - Breaking Slip", "Whatnot - Break Slip", "Whatnot Break Slip" —
// and the extracted dash can be a hyphen/en-dash/em-dash or absent. We match all
// of them case-insensitively so the ground-truth path is never skipped over a
// cosmetic header difference (which would silently drop us to the noisier
// packing-slip fallback and lose team fidelity).
const BREAKING_SLIP_START = /Whatnot\s*[-–—]?\s*Break(?:ing)?\s+Slip/i

// "Real Name (handle)" — the line directly under the "User" label on a breaking
// slip. Group 1 = real name (non-greedy so it stops before the parens), group 2
// = the Whatnot handle. Anchored — test against a single trimmed line.
const USER_LINE = /^(.+?)\s+\((\S+)\)$/

// Order ids on the breaking slip "Orders: #111 #222" summary line. GLOBAL so it
// is used with matchAll to enumerate every "#<digits>" token on the line.
const ORDER_IDS_LINE = /#(\d+)/g

// Section header on the breaking slip: "Break #4". Same shape as BREAK_NUMBER
// but named per its breaking-slip role for readability at the call site.
const BREAK_HEADER = /Break\s+#\s*(\d+)/i

// A team checkbox line on the breaking slip: "__ Dallas Cowboys". The picker's
// empty checkbox most often extracts as two-or-more underscores, but depending
// on the PDF's font/glyphs it can also render as a bracket box ("[ ]", "[]"),
// a Unicode ballot/box glyph (☐ ☑ ✓ ✔ ❑ ▢ ◻ ◼ □ ■), or a bullet/dash. We accept
// any of those leading markers, then capture the team name. Anchored — test
// against a single trimmed line. (Lines with NO checkbox glyph at all are still
// recovered by the team-name fallback in parseBreakingSlip.)
const TEAM_CHECKBOX = /^(?:_{2,}|\[[ xX]?\]|[☐☑✓✔❑▢◻◼□■•·])\s+(.+)$/

// "Total: $123.45" — the dollar total for a break on the breaking slip; used as
// the price fallback when a packing-slip per-order price is unavailable.
const BREAK_TOTAL = /Total:\s+\$([0-9.]+)/

// --- Shipment metadata (on the packing slip) --------------------------------

// "USPS Priority Mail® #9400110200881234567890" — group 1 = the human service
// name (may contain the ® / ™ glyphs and spaces, non-greedy so it stops at the
// space before '#'), group 2 = the tracking number digits (the leading '#' is
// outside the capture, so the captured value is digits-only by construction).
const USPS_LINE = /USPS\s+([\w\s®™]+?)\s+#(\d+)/

// Parcel weight like "12.4 oz". Group 1 = the numeric ounces.
const WEIGHT_LINE = /([\d.]+)\s*oz/

// Presence of a giveaway flag on an order ("GIVEAWAY"). Giveaways are $0 and
// must still produce Customer + Shipment records.
const GIVEAWAY_FLAG = /GIVEAWAY/

// A literal "$0.00" price — the other signal (besides the GIVEAWAY token) that
// an order line is a no-charge giveaway.
const ZERO_PRICE = /\$0\.00\b/

// A generic price token "$12.34" used to read per-order prices off packing-slip
// product lines. GLOBAL — use with matchAll to find all prices on a line.
const PRICE_TOKEN = /\$([0-9]+(?:\.[0-9]{2})?)/g

module.exports = {
  PACKING_SLIP_START,
  PACKING_SLIP_PAGE,
  TO_USERNAME,
  REAL_NAME,
  ORDER_ID,
  BREAK_NUMBER,
  BREAKING_SLIP_START,
  USER_LINE,
  ORDER_IDS_LINE,
  BREAK_HEADER,
  TEAM_CHECKBOX,
  BREAK_TOTAL,
  USPS_LINE,
  WEIGHT_LINE,
  GIVEAWAY_FLAG,
  ZERO_PRICE,
  PRICE_TOKEN,
}
