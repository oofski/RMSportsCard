// Unit tests for the CSV builders (server/csv.cjs).
import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { csvField, toCsv, ordersCsv, shippingCsv } = require('../server/csv.cjs')

describe('csvField', () => {
  it('passes plain values through', () => {
    expect(csvField('hello')).toBe('hello')
    expect(csvField(42)).toBe('42')
    expect(csvField(null)).toBe('')
  })
  it('quotes and escapes commas, quotes, newlines', () => {
    expect(csvField('a,b')).toBe('"a,b"')
    expect(csvField('she said "hi"')).toBe('"she said ""hi"""')
    expect(csvField('line1\nline2')).toBe('"line1\nline2"')
  })
})

describe('ordersCsv', () => {
  const src = {
    event: { name: 'Cosmic, Football', date: '2026-06-27' },
    orders: [
      { orderId: '111', customer: { realName: 'Lucas Snow', handle: 'luknstar7', isNew: false }, breakNumber: 1, teamName: 'Los Angeles Chargers', price: 31, isGiveaway: false },
      { orderId: '222', customer: { realName: 'Pete Mergens', handle: 'mlt', isNew: true }, breakNumber: 1, teamName: 'Arizona Cardinals', price: 0, isGiveaway: true },
    ],
  }
  const csv = ordersCsv(src)
  const lines = csv.split('\r\n')
  it('has a header row and one row per order', () => {
    expect(lines[0]).toContain('Order ID')
    expect(lines).toHaveLength(3)
  })
  it('escapes the event name with a comma', () => {
    expect(lines[1]).toContain('"Cosmic, Football"')
  })
  it('formats price and giveaway type', () => {
    expect(lines[1]).toContain('31.00')
    expect(lines[1]).toContain('Paid')
    expect(lines[2]).toContain('0.00')
    expect(lines[2]).toContain('Giveaway')
  })
})

describe('shippingCsv', () => {
  const src = {
    event: { name: 'Evt', date: '2026-06-27' },
    shipments: [
      { customer: { realName: 'Lucas Snow', handle: 'luknstar7' }, trackingNumber: '9305', serviceType: 'Priority Mail', weightOz: 42, manualStatus: { code: 'delivered', setBy: 'auto' }, notes: 'left at door', breaks: [{ breakNumber: 1, teams: ['Chargers'] }, { breakNumber: 4, teams: ['Broncos', 'Packers'] }] },
    ],
  }
  const csv = shippingCsv(src)
  it('includes status and joined breaks/teams', () => {
    expect(csv).toContain('Tracking')
    expect(csv).toContain('delivered')
    expect(csv).toContain('Break #1: Chargers | Break #4: Broncos / Packers')
  })
})
