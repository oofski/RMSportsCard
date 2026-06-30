// Tests for NFL team-name normalization (server/parser/teams.cjs).
import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { matchTeam, levenshtein, CANONICAL } = require('../server/parser/teams.cjs')

describe('matchTeam — exact (case/punctuation-insensitive)', () => {
  it('matches canonical names exactly', () => {
    const m = matchTeam('Kansas City Chiefs')
    expect(m.team).toBe('Kansas City Chiefs')
    expect(m.exact).toBe(true)
    expect(m.distance).toBe(0)
  })
  it('is case-insensitive', () => {
    expect(matchTeam('kansas city chiefs').team).toBe('Kansas City Chiefs')
  })
  it('ignores punctuation/extra spaces', () => {
    expect(matchTeam('San   Francisco 49ers').team).toBe('San Francisco 49ers')
  })
  it('covers all 32 canonical teams', () => {
    expect(CANONICAL).toHaveLength(32)
    for (const t of CANONICAL) expect(matchTeam(t).team).toBe(t)
  })
})

describe('matchTeam — fuzzy (Levenshtein <= 2)', () => {
  it('matches a small typo', () => {
    const m = matchTeam('Kansas City Chefs') // missing the "i"
    expect(m.team).toBe('Kansas City Chiefs')
    expect(m.exact).toBe(false)
    expect(m.distance).toBeLessThanOrEqual(2)
  })
  it('returns null beyond distance 2', () => {
    expect(matchTeam('Completely Different Name').team).toBeNull()
  })
  it('returns null for empty input', () => {
    expect(matchTeam('').team).toBeNull()
  })
})

describe('levenshtein', () => {
  it('computes basic edit distances', () => {
    expect(levenshtein('kitten', 'sitting')).toBe(3)
    expect(levenshtein('abc', 'abc')).toBe(0)
    expect(levenshtein('', 'abc')).toBe(3)
  })
})
