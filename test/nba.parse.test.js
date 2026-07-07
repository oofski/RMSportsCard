// =============================================================================
// NBA support — the same breaking-slip pipeline, third league (mirrors MLB).
// Proves teams snap to the 30-team NBA slate, the fidelity audit reports
// maxTeams = 30, sport is carried through, and 'auto' detects NBA from the
// team names without bleeding into NFL/MLB.
//
// PRIVACY: every fixture below is fully synthetic.
// =============================================================================
import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { parsePages } = require('../server/parser/index.cjs')

const slotsFor = (ds, handle) => ds.teamSlots.filter((t) => t.customerId === handle)
const auditFor = (ds, n) => ds.breakAudit.find((a) => a.breakNumber === n)

// Includes "Los Angeles Clippers" (a city shared with NFL Rams/Chargers and MLB
// Dodgers/Angels) and "Philadelphia 76ers" (digits survive normalization).
const NBA_PAGE = `Whatnot - Breaking Slip
User
Hoops Fan (hoops)
#31
1 Breaks
Break #1
Orders: #31
__ Los Angeles Lakers
__ Los Angeles Clippers
__ Boston Celtics
__ Golden State Warriors
__ Philadelphia 76ers
Total: $150.00`

describe('NBA breaking slip — explicit sport', () => {
  it('snaps teams to the 30-team NBA slate', () => {
    const ds = parsePages([NBA_PAGE], { sport: 'nba' })
    const teams = slotsFor(ds, 'hoops').map((s) => s.teamName)
    expect(ds.sport).toBe('nba')
    expect(teams).toContain('Los Angeles Clippers')
    expect(teams).toContain('Philadelphia 76ers')
    expect(teams).toHaveLength(5)
  })

  it('audits each break against 30 NBA teams', () => {
    const a = auditFor(parsePages([NBA_PAGE], { sport: 'nba' }), 1)
    expect(a.maxTeams).toBe(30)
    expect(a.distinctTeamCount).toBe(5)
    expect(a.missingCount).toBe(25)
    expect(a.hasAll32).toBe(false)
    expect(a.missingTeams).toContain('Miami Heat')
    // No cross-league names leak into an NBA audit.
    expect(a.missingTeams).not.toContain('Los Angeles Rams')
    expect(a.missingTeams).not.toContain('Los Angeles Dodgers')
  })

  it('flags hasAll32 (full slate) when all 30 NBA teams are present', () => {
    const { listTeams } = require('../server/parser/teams.cjs')
    const lines = listTeams('nba').map((t) => `__ ${t}`).join('\n')
    const page = `Whatnot - Breaking Slip
User
Whale (whale)
#40
1 Breaks
Break #1
Orders: #40
${lines}
Total: $3000.00`
    const a = auditFor(parsePages([page], { sport: 'nba' }), 1)
    expect(a.distinctTeamCount).toBe(30)
    expect(a.missingCount).toBe(0)
    expect(a.hasAll32).toBe(true)
  })
})

describe('sport auto-detection with three leagues', () => {
  it("'auto' detects NBA from NBA names", () => {
    expect(parsePages([NBA_PAGE], { sport: 'auto' }).sport).toBe('nba')
  })
  it('an NFL slip still detects NFL (no NBA bleed)', () => {
    const nfl = `Whatnot - Breaking Slip
User
Joe (joe)
#1
1 Breaks
Break #1
Orders: #1
__ Kansas City Chiefs
__ Chicago Bears
Total: $40.00`
    expect(parsePages([nfl], { sport: 'auto' }).sport).toBe('nfl')
  })
})
