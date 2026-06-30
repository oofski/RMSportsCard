// =============================================================================
// RM Cardz — PDF text extraction (spec §5 STEP 0)
// -----------------------------------------------------------------------------
// Turns a PDF buffer into an ORDERED array of per-page plain-text strings, with
// the on-page reading order reconstructed as faithfully as possible.
//
// WHY a custom `pagerender` instead of pdf-parse's default text blob:
//   - pdf-parse's stock renderer concatenates ALL pages into one string with no
//     reliable page boundaries. Our parser must reason per page (a customer's
//     packing slip can span "1/2"/"2/2", and the tracking number lives only on
//     the LAST page) — so we MUST preserve page boundaries.
//   - The stock renderer also splits lines purely on a change in Y, which can
//     scramble word order within a line and split a visual line into many. PDF
//     text items are emitted in content-stream order, NOT visual order. We
//     therefore re-group items into visual lines by their (rounded) Y baseline
//     and sort within a line by X so words read left-to-right.
//
// Coordinate model (pdf.js TextItem.transform is a 2-D affine matrix):
//   transform = [a, b, c, d, e, f] where e = X (transform[4]) and
//   f = Y (transform[5]) of the text item's baseline. Larger Y = higher up the
//   page, so to read top-to-bottom we sort lines by Y DESCENDING.
// =============================================================================

const pdf = require('pdf-parse')

// Y baselines for items on the same visual line are rarely bit-identical (sub-
// pixel kerning/rounding in the PDF). Rounding the baseline to the nearest
// integer point collapses those near-equal values into one bucket so a single
// visual line is not shattered into several "lines".
function roundY(item) {
  return Math.round(item.transform[5])
}

/**
 * Render one PDF page (called by pdf-parse for each page, in page order) into a
 * single plain-text string with visual line breaks reconstructed.
 *
 * @param {object} pageData pdf.js page proxy supplied by pdf-parse.
 * @returns {Promise<string>}
 */
function renderPage(pageData) {
  // normalizeWhitespace:false keeps the original glyphs (incl. ® / ™ that the
  // USPS line regex tolerates); disableCombineTextItems:false lets pdf.js merge
  // adjacent glyph runs into words where it can.
  const options = { normalizeWhitespace: false, disableCombineTextItems: false }

  return pageData.getTextContent(options).then((textContent) => {
    // Bucket text items by their rounded Y baseline -> one bucket per visual line.
    const lineBuckets = new Map()
    for (const item of textContent.items) {
      // pdf.js can emit empty marker items; skip ones with no string at all.
      if (item.str == null) continue
      const y = roundY(item)
      if (!lineBuckets.has(y)) lineBuckets.set(y, [])
      lineBuckets.get(y).push(item)
    }

    // Sort the line buckets by Y DESCENDING (top of page first).
    const sortedYs = [...lineBuckets.keys()].sort((a, b) => b - a)

    const lines = sortedYs.map((y) => {
      // Within a line, sort items left-to-right by X (transform[4]) ascending.
      const items = lineBuckets.get(y).sort((a, b) => a.transform[4] - b.transform[4])
      // Join with a single space: PDF word fragments often arrive without their
      // own trailing space, so a space keeps tokens like "USPS" and "Priority"
      // separated for the line regexes. Collapse runs of whitespace afterward.
      return items
        .map((it) => it.str)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim()
    })

    return lines.join('\n')
  })
}

/**
 * Extract every page of a PDF as a plain-text string, preserving page order.
 *
 * @param {Buffer} buffer Raw PDF bytes.
 * @returns {Promise<string[]>} One string per page, in document order.
 * @throws {Error} If the PDF has no selectable text on ANY page (e.g. a scanned
 *                 image-only PDF), since the parser cannot proceed without text.
 */
async function extractPages(buffer) {
  // We accumulate rendered pages here. pdf-parse invokes `pagerender` for each
  // page sequentially and in order, so simply pushing yields correct page order.
  const pages = []

  // Wrap renderPage so that, as a side effect, we capture each page's text in
  // order while still returning the string pdf-parse expects from pagerender.
  const pagerender = (pageData) =>
    renderPage(pageData).then((text) => {
      pages.push(text)
      return text
    })

  // max:0 => render ALL pages (no page cap).
  await pdf(buffer, { pagerender, max: 0 })

  // Guard against scanned/image-only PDFs: if not a single page produced any
  // non-whitespace text, there is nothing for the grammar to match.
  const hasAnyText = pages.some((p) => p && p.trim().length > 0)
  if (!hasAnyText) {
    throw new Error('PDF does not appear to contain selectable text')
  }

  return pages
}

module.exports = { extractPages }
