// Unit tests for the USPS status-text mapper (electron/uspsStatus.cjs — pure).
import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { mapStatusText } = require('../electron/uspsStatus.cjs')

describe('mapStatusText', () => {
  it('detects Delivered', () => {
    expect(mapStatusText('Status: Delivered\nYour item was delivered at 2:14 pm.')).toBe('delivered')
  })
  it('does NOT treat "Expected Delivery" as delivered', () => {
    expect(mapStatusText('In Transit\nExpected Delivery by Friday, arriving soon')).toBe('in_transit')
  })
  it('detects Out for Delivery', () => {
    expect(mapStatusText('Out for Delivery, 8:10 am')).toBe('out_for_delivery')
  })
  it('detects In Transit variants', () => {
    expect(mapStatusText('Arrived at USPS Regional Origin Facility')).toBe('in_transit')
    expect(mapStatusText('Accepted at USPS Origin Facility')).toBe('in_transit')
  })
  it('detects exceptions and pickups', () => {
    expect(mapStatusText('Alert: Delivery exception, no access to delivery location')).toBe('exception')
    expect(mapStatusText('Available for Pickup at PO')).toBe('exception')
  })
  it('detects returned', () => {
    expect(mapStatusText('Being returned to sender')).toBe('returned')
  })
  it('detects label created / pre-shipment', () => {
    expect(mapStatusText('Pre-Shipment\nShipping Label Created, USPS Awaiting Item')).toBe('label_created')
  })

  // ---- Regression: modern USPS in-transit copy that used to map to null -------
  // These are the strings that left genuinely-shipping packages stuck on
  // "Not Shipped". The current USPS page leads with an "Arriving On Time/Late"
  // headline (not the words "In Transit"), and its body promises the item is
  // "on track to be delivered" — which the old mapper mis-read as Delivered.
  it('maps the modern "Arriving" headline to in_transit', () => {
    expect(mapStatusText('Arriving On Time')).toBe('in_transit')
    expect(mapStatusText('Arriving Late')).toBe('in_transit')
    expect(mapStatusText('Arriving On Time\nExpected Delivery by 9:00pm')).toBe('in_transit')
  })
  it('does NOT mis-read "on track to be delivered" body copy as delivered', () => {
    expect(
      mapStatusText('Your item is moving within the USPS network and is on track to be delivered by the expected delivery date.')
    ).toBe('in_transit')
  })
  it('maps early in-transit scan events to in_transit', () => {
    expect(mapStatusText('Shipment Received, Package Acceptance Pending')).toBe('in_transit')
    expect(mapStatusText('Package Acceptance Pending')).toBe('in_transit')
    expect(mapStatusText('Forwarded')).toBe('in_transit')
  })
  it('handles a headline+detail concatenation (the probe joins them with newlines)', () => {
    // The scraper now joins the status nodes with a NEWLINE (".tb-status\n
    // .tb-status-detail"); a delivery-date headline is stripped per-line but the
    // In-Transit detail on the next line survives.
    expect(mapStatusText('Arriving On Time\nIn Transit to Next Facility')).toBe('in_transit')
    expect(mapStatusText('Expected Delivery Mon\nMoving Through Network')).toBe('in_transit')
    // Terminal precedence still holds when history rides along in the join.
    expect(mapStatusText('Delivered\nArrived at USPS Facility')).toBe('delivered')
  })
  it('still rejects page chrome that is not a real status', () => {
    expect(mapStatusText('Tracking Status')).toBeNull()
    expect(mapStatusText('Text & Email Updates')).toBeNull()
  })

  it('returns null when undecidable / empty', () => {
    expect(mapStatusText('')).toBeNull()
    expect(mapStatusText('completely unrelated text')).toBeNull()
  })
})
