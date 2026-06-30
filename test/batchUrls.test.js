// Tests for the USPS URL helpers (server/parser/batchUrls.cjs).
import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { buildUspsUrl, buildBatchUrls } = require('../server/parser/batchUrls.cjs')

const BASE = 'https://tools.usps.com/go/TrackConfirmAction?tLabels='

describe('buildUspsUrl', () => {
  it('builds a single-package tracking URL', () => {
    expect(buildUspsUrl('9305520762601281834387')).toBe(BASE + '9305520762601281834387')
  })
  it('trims whitespace', () => {
    expect(buildUspsUrl('  123 ')).toBe(BASE + '123')
  })
})

describe('buildBatchUrls', () => {
  it('returns [] for empty input', () => {
    expect(buildBatchUrls([])).toEqual([])
    expect(buildBatchUrls(null)).toEqual([])
  })

  it('groups into batches of 35 (USPS bulk limit)', () => {
    const nums = Array.from({ length: 80 }, (_, i) => String(1000000000000000000000 + i))
    const batches = buildBatchUrls(nums)
    expect(batches.map((b) => b.count)).toEqual([35, 35, 10])
    expect(batches.map((b) => b.batchNumber)).toEqual([1, 2, 3])
  })

  it('joins tracking numbers with the URL-encoded comma %2C', () => {
    const batches = buildBatchUrls(['111', '222', '333'])
    expect(batches).toHaveLength(1)
    expect(batches[0].url).toBe(BASE + '111%2C222%2C333')
    expect(batches[0].count).toBe(3)
  })

  it('respects a custom batch size', () => {
    const batches = buildBatchUrls(['a', 'b', 'c', 'd', 'e'], 2)
    expect(batches.map((b) => b.count)).toEqual([2, 2, 1])
  })

  it('drops empty/blank entries', () => {
    const batches = buildBatchUrls(['111', '', '  ', '222'])
    expect(batches[0].count).toBe(2)
    expect(batches[0].url).toBe(BASE + '111%2C222')
  })
})
