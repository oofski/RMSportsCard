// =============================================================================
// USPS status text -> status code mapping (pure, no Electron deps)
// -----------------------------------------------------------------------------
// Extracted from the scraper so it can be unit-tested in plain Node. Given the
// visible text of a USPS tracking page, return one of our shipment status codes
// (or null if undecidable). Order matters: terminal/problem states win over the
// in-transit history that also appears on the page, and we strip
// "expected/estimated delivery" phrasing so it isn't mistaken for "Delivered".
// =============================================================================

function mapStatusText(rawText) {
  if (!rawText) return null
  const t = String(rawText)
    .toLowerCase()
    .replace(/expected delivery[^\n.]*/g, ' ')
    .replace(/estimated delivery[^\n.]*/g, ' ')
    .replace(/scheduled delivery[^\n.]*/g, ' ')
    .replace(/delivery (date|by|window|instructions|options|changes|attempt window)[^\n.]*/g, ' ')
    // USPS in-transit body copy reads "...on track to be delivered by the
    // expected delivery date." Strip that PROMISE so the leftover word
    // "delivered" can't be mistaken for an actual delivery confirmation.
    .replace(/(to|will) be delivered[^\n.]*/g, ' ')

  if (/return to sender|returned to sender|being returned to sender/.test(t)) return 'returned'
  if (/\bdelivered\b|left with individual|in\/at mailbox|delivered to agent|delivered, /.test(t)) return 'delivered'
  if (/alert|delivery exception|action needed|undeliverable|no access to delivery|delivery attempt[^\n]*?(unsuccess|fail)|held at|available for pickup|reschedule|address (issue|problem)/.test(t)) return 'exception'
  if (/out for delivery/.test(t)) return 'out_for_delivery'
  // In-transit detection. Includes the modern USPS headline copy ("Arriving On
  // Time/Late", "moving within the USPS network") and early-scan events
  // ("Package Acceptance Pending", "Shipment Received", "Forwarded") that the
  // old, narrower list missed — those were falling through to null and leaving
  // genuinely-shipping packages stuck on "Not Shipped".
  if (/in transit|arrived at|departed|in possession of|usps in possession|accepted|moving through network|on its way|processed through|picked up|origin facility|regional (origin|destination) facility|arriving (on time|late)|moving within|package (received|acceptance)|shipment received|item (arrived|departed)|forwarded|\barrived\b|\bdeparted\b/.test(t)) return 'in_transit'
  if (/pre-shipment|shipping label created|label created|awaiting item|usps awaiting/.test(t)) return 'label_created'
  return null
}

module.exports = { mapStatusText }
