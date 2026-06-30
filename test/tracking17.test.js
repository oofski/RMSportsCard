// Unit tests for the 17TRACK status mapper (server/tracking17map.cjs — pure).
// No network calls: we only exercise the pure status->code translation.
import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { map17TrackStatus } = require('../server/tracking17map.cjs')

describe('map17TrackStatus', () => {
  it('maps InfoReceived -> label_created', () => {
    expect(map17TrackStatus('InfoReceived')).toBe('label_created')
  })

  it('maps InTransit -> in_transit', () => {
    expect(map17TrackStatus('InTransit')).toBe('in_transit')
  })

  it('maps OutForDelivery -> out_for_delivery', () => {
    expect(map17TrackStatus('OutForDelivery')).toBe('out_for_delivery')
  })

  it('maps Delivered -> delivered', () => {
    expect(map17TrackStatus('Delivered')).toBe('delivered')
  })

  it('maps AvailableForPickup -> exception', () => {
    expect(map17TrackStatus('AvailableForPickup')).toBe('exception')
  })

  it('maps DeliveryFailure -> exception', () => {
    expect(map17TrackStatus('DeliveryFailure')).toBe('exception')
  })

  it('maps Exception + a returning sub_status -> returned', () => {
    expect(map17TrackStatus('Exception', 'Exception_Returned')).toBe('returned')
  })

  it('maps Exception + a non-return sub_status -> exception', () => {
    expect(map17TrackStatus('Exception', 'Exception_Other')).toBe('exception')
  })

  it('maps NotFound -> null', () => {
    expect(map17TrackStatus('NotFound')).toBeNull()
  })

  it('maps Expired -> exception', () => {
    expect(map17TrackStatus('Expired')).toBe('exception')
  })

  it('is case-insensitive on the status string', () => {
    expect(map17TrackStatus('delivered')).toBe('delivered')
    expect(map17TrackStatus('INTRANSIT')).toBe('in_transit')
  })

  it('returns null for unknown / empty inputs', () => {
    expect(map17TrackStatus('SomethingNew')).toBeNull()
    expect(map17TrackStatus('')).toBeNull()
    expect(map17TrackStatus()).toBeNull()
  })
})
