// =============================================================================
// USPS tracking URL helpers (spec §5 STEP 4–5, Appendix C)
// -----------------------------------------------------------------------------
// Pure functions — no I/O — so they are trivially unit-testable. Used by both
// the PDF parser and the demo seed to precompute every "Open in USPS" URL and
// the batched "Open All in USPS" URLs at import time (no runtime construction).
// =============================================================================

const reference = require('../../shared/reference.json')

const BASE = reference.uspsTrackBaseUrl // https://tools.usps.com/go/TrackConfirmAction?tLabels=
const BATCH_SIZE = reference.uspsBatchSize // 35

/** Single-package tracking URL. */
function buildUspsUrl(trackingNumber) {
  return BASE + encodeURIComponent(String(trackingNumber || '').trim())
}

/**
 * Group tracking numbers into USPS bulk-lookup batches (max 35 each) and build
 * one comma-joined URL per batch. `%2C` is the URL-encoded comma USPS expects.
 * @param {string[]} trackingNumbers
 * @param {number} [batchSize=35]
 * @returns {{batchNumber:number, count:number, url:string}[]}
 */
function buildBatchUrls(trackingNumbers, batchSize = BATCH_SIZE) {
  const clean = (trackingNumbers || []).map((t) => String(t || '').trim()).filter(Boolean)
  const batches = []
  for (let i = 0; i < clean.length; i += batchSize) {
    const group = clean.slice(i, i + batchSize)
    batches.push({
      batchNumber: batches.length + 1,
      count: group.length,
      url: BASE + group.map((t) => encodeURIComponent(t)).join('%2C'),
    })
  }
  return batches
}

module.exports = { buildUspsUrl, buildBatchUrls, BATCH_SIZE }
