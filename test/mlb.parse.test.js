// =============================================================================
// MLB support — the same breaking-slip pipeline, different league (spec §5).
//
// These tests prove that a Whatnot PDF of an MLB break parses identically to an
// NFL one: teams snap to the 30-team MLB slate, the per-break fidelity audit
// reports maxTeams = 30, the sport is carried through the dataset + db summary,
// and 'auto' correctly detects NFL vs MLB from the team names on the slip.
//
// PRIVACY: every fixture below is fully synthetic.
// =============================================================================
import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

const require = createRequire(import.meta.url)
const { parsePages } = require('../server/parser/index.cjs')
const { Store } = require('../server/store.cjs')
const { Db } = require('../server/db.cjs')

const slotsFor = (ds, handle) => ds.teamSlots.filter((t) => t.customerId === handle)
const auditFor = (ds, n) => ds.breakAudit.find((a) => a.breakNumber === n)

// A synthetic MLB breaking slip. Includes the tricky single-word "Athletics"
// and cross-league-ambiguous "San Francisco Giants" (an NFL "Giants" exists).
const MLB_PAGE = `Whatnot - Breaking Slip
User
Ken Griffey (kgjr)
#77
1 Breaks
Break #1
Orders: #77
__ New York Yankees
__ Los Angeles Dodgers
__ San Francisco Giants
__ Athletics
__ St. Louis Cardinals
__ Toronto Blue Jays
Total: $120.00`

const NFL_PAGE = `Whatnot - Breaking Slip
User
Joe Fan (joef)
#88
1 Breaks
Break #1
Orders: #88
__ Kansas City Chiefs
__ New York Giants
__ San Francisco 49ers
Total: $60.00`

describe('MLB breaking slip — explicit sport', () => {
  it('snaps teams to the 30-team MLB slate (Athletics + SF Giants included)', () => {
    const ds = parsePages([MLB_PAGE], { sport: 'mlb' })
    const teams = slotsFor(ds, 'kgjr').map((s) => s.teamName)
    expect(ds.sport).toBe('mlb')
    expect(teams).toContain('Athletics')
    expect(teams).toContain('San Francisco Giants')
    expect(teams).toContain('St. Louis Cardinals')
    expect(teams).toHaveLength(6)
  })

  it('audits each break against 30 MLB teams (not 32)', () => {
    const ds = parsePages([MLB_PAGE], { sport: 'mlb' })
    const a = auditFor(ds, 1)
    expect(a.maxTeams).toBe(30)
    expect(a.distinctTeamCount).toBe(6)
    expect(a.missingCount).toBe(24)
    expect(a.hasAll32).toBe(false) // field name is legacy; means "full slate"
    expect(a.missingTeams).toContain('Boston Red Sox')
    expect(a.missingTeams).not.toContain('Athletics')
    // NFL teams must NOT appear in an MLB audit's missing list.
    expect(a.missingTeams).not.toContain('Kansas City Chiefs')
  })

  it('flags hasAll32 (full slate) when all 30 MLB teams are present', () => {
    const { listTeams } = require('../server/parser/teams.cjs')
    const lines = listTeams('mlb').map((t) => `__ ${t}`).join('\n')
    const page = `Whatnot - Breaking Slip
User
Whale Buyer (whale)
#90
1 Breaks
Break #1
Orders: #90
${lines}
Total: $2500.00`
    const a = auditFor(parsePages([page], { sport: 'mlb' }), 1)
    expect(a.distinctTeamCount).toBe(30)
    expect(a.missingCount).toBe(0)
    expect(a.hasAll32).toBe(true)
  })
})

describe('sport auto-detection through the parser', () => {
  it("'auto' detects MLB from MLB team names", () => {
    expect(parsePages([MLB_PAGE], { sport: 'auto' }).sport).toBe('mlb')
  })
  it("'auto' detects NFL from NFL team names", () => {
    expect(parsePages([NFL_PAGE], { sport: 'auto' }).sport).toBe('nfl')
  })
  it('omitted sport defaults to detection (NFL for NFL names)', () => {
    expect(parsePages([NFL_PAGE]).sport).toBe('nfl')
  })

  // Regression: a real MLB slip whose checkbox glyphs were LOST in text
  // extraction (bare team lines, no marker) and NO packing "Break #N <team>"
  // candidates anywhere must STILL auto-detect as MLB. Otherwise detection sees
  // zero candidates, defaults to NFL, and the NFL matcher fuzzy-snaps
  // "New York Mets" -> "New York Jets" while dropping non-NFL teams (silent
  // corruption). collectTeamCandidates now feeds detection the same glyph-loss
  // recovery the parser's fallback uses.
  it('auto-detects MLB even when checkbox glyphs were lost (bare team lines)', () => {
    const bare = `Whatnot - Breaking Slip
User
Jane Doe (jane_mlb)
Break #1
New York Mets
Boston Red Sox
Toronto Blue Jays
Total: $30.00`
    const ds = parsePages([bare], { sport: 'auto' })
    expect(ds.sport).toBe('mlb')
    const teams = slotsFor(ds, 'jane_mlb').map((s) => s.teamName).sort()
    expect(teams).toEqual(['Boston Red Sox', 'New York Mets', 'Toronto Blue Jays'])
    // Not corrupted into the NFL neighbor, and audited against the 30 MLB teams.
    expect(teams).not.toContain('New York Jets')
    expect(auditFor(ds, 1).maxTeams).toBe(30)
  })
})

describe('db carries sport through import + summary', () => {
  function freshDb() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rmcardz-mlb-'))
    return new Db(new Store(dir, 'db.json'))
  }

  it('importDataset stores the MLB sport and summary reports it', () => {
    const db = freshDb()
    const ds = parsePages([MLB_PAGE], { sport: 'mlb' })
    const summary = db.importDataset(ds, { filename: 'mlb-break.pdf' })
    expect(summary.sport).toBe('mlb')
    // listBreaks surfaces the sport-correct maxTeams (30) from the audit.
    const brk = db.listBreaks().find((b) => b.breakNumber === 1)
    expect(brk.maxTeams).toBe(30)
  })

  it('defaults to nfl when a dataset omits sport (older parser output)', () => {
    const db = freshDb()
    const ds = parsePages([NFL_PAGE], { sport: 'nfl' })
    delete ds.sport // simulate a pre-sports dataset
    const summary = db.importDataset(ds, { filename: 'legacy.pdf' })
    expect(summary.sport).toBe('nfl')
  })
})
