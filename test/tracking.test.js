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
  it('detects pre-shipment', () => {
    expect(mapStatusText('Pre-Shipment\nShipping Label Created, USPS Awaiting Item')).toBe('not_shipped')
  })
  it('returns null when undecidable / empty', () => {
    expect(mapStatusText('')).toBeNull()
    expect(mapStatusText('completely unrelated text')).toBeNull()
  })
})
