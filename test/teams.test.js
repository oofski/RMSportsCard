// Tests for team-name normalization (server/parser/teams.cjs) — NFL + MLB.
import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const {
  matchTeam,
  levenshtein,
  CANONICAL,
  createTeamMatcher,
  detectSport,
  listTeams,
  normalizeSport,
} = require('../server/parser/teams.cjs')

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

// -----------------------------------------------------------------------------
// Sport-aware matcher (NFL 32 / MLB 30) — createTeamMatcher / detectSport.
// -----------------------------------------------------------------------------
describe('createTeamMatcher — MLB', () => {
  const mlb = createTeamMatcher('mlb')

  it('exposes exactly the 30 MLB teams and matches each one', () => {
    expect(mlb.sport).toBe('mlb')
    expect(mlb.CANONICAL).toHaveLength(30)
    for (const t of mlb.CANONICAL) expect(mlb.matchTeam(t).team).toBe(t)
  })

  it('matches the single-word "Athletics" and multi-word MLB names', () => {
    expect(mlb.matchTeam('athletics').team).toBe('Athletics')
    expect(mlb.matchTeam('St. Louis Cardinals').team).toBe('St. Louis Cardinals')
    expect(mlb.matchTeam('San Francisco Giants').team).toBe('San Francisco Giants')
  })

  it('fuzzy-matches a small MLB typo within edit distance 2', () => {
    const m = mlb.matchTeam('Toronto Blue Jay') // missing trailing "s"
    expect(m.team).toBe('Toronto Blue Jays')
    expect(m.distance).toBeLessThanOrEqual(2)
  })

  it('does NOT bleed NFL names into MLB (and vice-versa)', () => {
    // "San Francisco Giants" (MLB) must not resolve under the NFL matcher, and
    // "New York Giants" (NFL) must not resolve under the MLB matcher.
    expect(createTeamMatcher('nfl').matchTeam('San Francisco Giants').team).toBeNull()
    expect(mlb.matchTeam('New York Giants').team).toBeNull()
  })

  it('unknown sport falls back to NFL (32 teams)', () => {
    const m = createTeamMatcher('nhl') // not a registered sport
    expect(m.sport).toBe('nfl')
    expect(m.CANONICAL).toHaveLength(32)
  })
})

describe('createTeamMatcher — NBA', () => {
  const nba = createTeamMatcher('nba')

  it('exposes exactly the 30 NBA teams and matches each one', () => {
    expect(nba.sport).toBe('nba')
    expect(nba.CANONICAL).toHaveLength(30)
    for (const t of nba.CANONICAL) expect(nba.matchTeam(t).team).toBe(t)
  })

  it('matches multi-word + numeric NBA names', () => {
    expect(nba.matchTeam('los angeles clippers').team).toBe('Los Angeles Clippers')
    expect(nba.matchTeam('Portland Trail Blazers').team).toBe('Portland Trail Blazers')
    expect(nba.matchTeam('Philadelphia 76ers').team).toBe('Philadelphia 76ers')
  })

  it('does NOT bleed across leagues (Bulls/Bears, Cavaliers/Browns)', () => {
    expect(createTeamMatcher('nfl').matchTeam('Chicago Bulls').team).toBeNull()
    expect(nba.matchTeam('Chicago Bears').team).toBeNull()
    expect(nba.matchTeam('Cleveland Browns').team).toBeNull()
  })
})

describe('detectSport', () => {
  it('classifies a batch of MLB names as mlb', () => {
    expect(detectSport(['New York Yankees', 'Athletics', 'San Francisco Giants'])).toBe('mlb')
  })
  it('classifies a batch of NFL names as nfl', () => {
    expect(detectSport(['Kansas City Chiefs', 'New York Giants', 'Dallas Cowboys'])).toBe('nfl')
  })
  it('classifies a batch of NBA names as nba', () => {
    expect(detectSport(['Los Angeles Lakers', 'Boston Celtics', 'Golden State Warriors'])).toBe('nba')
  })
  it('separates the three leagues that all field a "Los Angeles" team', () => {
    expect(detectSport(['Los Angeles Lakers', 'Los Angeles Clippers', 'Boston Celtics'])).toBe('nba')
    expect(detectSport(['Los Angeles Rams', 'Los Angeles Chargers', 'Dallas Cowboys'])).toBe('nfl')
    expect(detectSport(['Los Angeles Dodgers', 'Los Angeles Angels', 'New York Yankees'])).toBe('mlb')
  })
  it('defaults to nfl on empty / unrecognizable input', () => {
    expect(detectSport([])).toBe('nfl')
    expect(detectSport(['Not A Team', 'Zzz Qqq'])).toBe('nfl')
  })
})

describe('sport helpers', () => {
  it('listTeams returns the right slate per sport', () => {
    expect(listTeams('nfl')).toHaveLength(32)
    expect(listTeams('mlb')).toHaveLength(30)
    expect(listTeams('mlb')).toContain('Athletics')
    expect(listTeams('nba')).toHaveLength(30)
    expect(listTeams('nba')).toContain('Los Angeles Clippers')
  })
  it('normalizeSport validates codes and defaults to nfl', () => {
    expect(normalizeSport('mlb')).toBe('mlb')
    expect(normalizeSport('nba')).toBe('nba')
    expect(normalizeSport('NFL')).toBe('nfl')
    expect(normalizeSport('auto')).toBe('nfl')
    expect(normalizeSport(undefined)).toBe('nfl')
  })
})

describe('matchTeam — hardening', () => {
  it('snaps a city-prefixed name to a canonical (Oakland Athletics -> Athletics)', () => {
    expect(createTeamMatcher('mlb').matchTeam('Oakland Athletics').team).toBe('Athletics')
    expect(createTeamMatcher('mlb').matchTeam('Sacramento Athletics').team).toBe('Athletics')
  })
  it('does NOT fuzzy-snap a name that is an exact team in ANOTHER league', () => {
    // "New York Mets" (MLB) is edit-distance 1 from "New York Jets" (NFL): an NFL
    // matcher must NOT put a Mets card into a Jets slot.
    expect(createTeamMatcher('nfl').matchTeam('New York Mets').team).toBeNull()
    // And the MLB matcher still resolves it exactly.
    expect(createTeamMatcher('mlb').matchTeam('New York Mets').team).toBe('New York Mets')
  })
})
