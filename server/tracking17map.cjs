// =============================================================================
// 17TRACK status -> RM Cardz status code mapping (pure, no I/O)
// -----------------------------------------------------------------------------
// The 17TRACK API (track/v2.4) returns a tracking item's progress as a
// `latest_status.status` string (the "main" status) plus an optional
// `latest_status.sub_status` string (a finer-grained variant). This module
// translates that pair into ONE of the shipment status codes the rest of the
// app understands:
//
//   not_shipped | label_created | in_transit | out_for_delivery |
//   delivered   | exception     | returned
//
// or `null` when the 17TRACK status doesn't map to anything actionable
// (e.g. NotFound, or an unrecognized future status string). Callers must treat
// `null` as "leave this shipment's status untouched".
//
// Reference (17TRACK main statuses): NotFound, InfoReceived, InTransit,
// OutForDelivery, AvailableForPickup, DeliveryFailure, Delivered, Exception,
// Expired. We are intentionally case-insensitive and whitespace-tolerant on the
// inputs because the exact casing/spelling has drifted across API versions.
// =============================================================================

/**
 * Map a 17TRACK (status, subStatus) pair to one of our shipment status codes.
 *
 * @param {string} [status]    17TRACK main status (e.g. "InTransit", "Delivered").
 * @param {string} [subStatus] 17TRACK sub status (e.g. "Exception_Returned"). Optional.
 * @returns {('not_shipped'|'label_created'|'in_transit'|'out_for_delivery'|'delivered'|'exception'|'returned')|null}
 */
function map17TrackStatus(status, subStatus) {
  // Normalize to a lowercase, trimmed string so comparisons are robust to
  // casing ("Delivered" vs "delivered") and stray whitespace. Non-string /
  // missing inputs collapse to an empty string and fall through to `null`.
  const s = String(status == null ? '' : status).trim().toLowerCase()
  const sub = String(subStatus == null ? '' : subStatus).trim().toLowerCase()

  switch (s) {
    // Carrier has no record yet — nothing we can assert about the shipment.
    case 'notfound':
      return null

    // Carrier received pre-shipment info / label data but hasn't scanned it.
    case 'inforeceived':
      return 'label_created'

    // Package is moving through the network.
    case 'intransit':
      return 'in_transit'

    // Out for delivery with the final carrier.
    case 'outfordelivery':
      return 'out_for_delivery'

    // Item is waiting at a pickup point (PO box, locker, etc.). We surface this
    // as an exception so the user knows action is needed to complete delivery.
    case 'availableforpickup':
      return 'exception'

    // A delivery attempt failed (no access, refused, etc.).
    case 'deliveryfailure':
      return 'exception'

    // Successfully delivered.
    case 'delivered':
      return 'delivered'

    // Generic exception bucket. A return is a special kind of exception: 17TRACK
    // encodes it in the sub_status (e.g. "Exception_Returning"/"Exception_Returned"),
    // so we look for "return" there and elevate it to our `returned` code.
    case 'exception':
      if (sub.includes('return')) return 'returned'
      return 'exception'

    // Tracking expired without a terminal scan — treat as an exception so it's
    // visible rather than silently stuck.
    case 'expired':
      return 'exception'

    // Any unrecognized / future status string: don't guess.
    default:
      return null
  }
}

module.exports = { map17TrackStatus }
