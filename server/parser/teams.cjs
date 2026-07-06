// =============================================================================
// Team name normalization (spec Appendix B) — sport-aware
// -----------------------------------------------------------------------------
// The PDF text layer can contain minor formatting variations of team names.
// We snap each extracted name to a canonical team list using a case- and
// punctuation-insensitive match first, then a Levenshtein distance <= 2 fuzzy
// fallback. The SAME logic serves every sport — only the canonical list changes
// (NFL = 32 teams, MLB = 30 teams). createTeamMatcher(sport) builds a matcher
// bound to one sport's list; detectSport(candidates) picks the most likely
// league from a set of raw team strings so an upload can auto-detect its sport.
//
// Back-compat: the module still exports a default NFL matchTeam / CANONICAL so
// existing callers and tests keep working unchanged. Pure functions -> easy to
// unit test.
// =============================================================================

const reference = require('../../shared/reference.json')

/** Lowercase, strip non-alphanumerics, collapse whitespace. */
function normalizeKey(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Classic Levenshtein edit distance. */
function levenshtein(a, b) {
  a = a || ''
  b = b || ''
  const m = a.length
  const n = b.length
  if (m === 0) return n
  if (n === 0) return m
  let prev = Array.from({ length: n + 1 }, (_, i) => i)
  let curr = new Array(n + 1)
  for (let i = 1; i <= m; i++) {
    curr[0] = i
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost)
    }
    ;[prev, curr] = [curr, prev]
  }
  return prev[n]
}

// --- Sport registry ----------------------------------------------------------
// code -> { code, label, teams:[canonical...] }. Driven by shared/reference.json
// so the team lists stay a single source of truth across backend + renderer.
const SPORTS = (reference.sports || [
  { code: 'nfl', label: 'NFL', teamsKey: 'nflTeams' },
]).reduce((acc, s) => {
  acc[s.code] = { code: s.code, label: s.label, teams: reference[s.teamsKey] || [] }
  return acc
}, {})

const DEFAULT_SPORT = 'nfl'

/** Normalize an arbitrary sport hint to a known sport code (defaults to NFL). */
function normalizeSport(sport) {
  const key = String(sport || '').toLowerCase().trim()
  return SPORTS[key] ? key : DEFAULT_SPORT
}

/** The canonical team list for a sport (defaults to NFL). */
function listTeams(sport) {
  return SPORTS[normalizeSport(sport)].teams
}

/**
 * Build a team matcher bound to a single sport's canonical list.
 * @param {string} sport  'nfl' | 'mlb' (unknown -> nfl)
 * @returns {{ matchTeam:(raw:string)=>{team:string|null,exact:boolean,distance:number},
 *            CANONICAL:string[], sport:string, label:string }}
 */
function createTeamMatcher(sport) {
  const code = normalizeSport(sport)
  const CANONICAL = SPORTS[code].teams
  const keyToCanonical = new Map(CANONICAL.map((t) => [normalizeKey(t), t]))

  function matchTeam(raw) {
    const key = normalizeKey(raw)
    if (!key) return { team: null, exact: false, distance: Infinity }

    const exact = keyToCanonical.get(key)
    if (exact) return { team: exact, exact: true, distance: 0 }

    // Fuzzy fallback — nearest canonical team within edit distance 2.
    let best = null
    let bestDist = Infinity
    for (const canon of CANONICAL) {
      const d = levenshtein(key, normalizeKey(canon))
      if (d < bestDist) {
        bestDist = d
        best = canon
      }
    }
    if (bestDist <= 2) return { team: best, exact: false, distance: bestDist }
    return { team: null, exact: false, distance: bestDist }
  }

  return { matchTeam, CANONICAL, sport: code, label: SPORTS[code].label }
}

/**
 * Score how well a set of raw team strings fits one sport. Exact (normalized)
 * hits dominate; near (edit-distance <= 2) hits break ties. Cross-league names
 * like "San Francisco Giants" (MLB) vs "New York Giants" (NFL) are distinct at
 * full length, so exact hits are an unambiguous signal of the true league.
 * @returns {{ exact:number, fuzzy:number }}
 */
function scoreSport(sport, candidates) {
  const { matchTeam } = createTeamMatcher(sport)
  let exact = 0
  let fuzzy = 0
  for (const raw of candidates || []) {
    const m = matchTeam(raw)
    if (m.exact) exact += 1
    else if (m.team) fuzzy += 1
  }
  return { exact, fuzzy }
}

/**
 * Detect the most likely sport for a batch of raw team strings. Returns a sport
 * code. When nothing matches any league (or on a tie) it falls back to NFL so an
 * ambiguous or empty upload behaves exactly as it did before sports existed.
 * @param {string[]} candidates raw team strings (e.g. breaking-slip checkboxes)
 * @returns {string} sport code ('nfl' | 'mlb')
 */
function detectSport(candidates) {
  const codes = Object.keys(SPORTS)
  let bestCode = DEFAULT_SPORT
  let bestScore = -1
  for (const code of codes) {
    const { exact, fuzzy } = scoreSport(code, candidates)
    // Weight exact hits far above fuzzy so a handful of confident matches wins.
    const score = exact * 100 + fuzzy
    // Strict '>' keeps the FIRST sport (NFL, listed first) on a tie — the
    // back-compat default.
    if (score > bestScore) {
      bestScore = score
      bestCode = code
    }
  }
  return bestScore > 0 ? bestCode : DEFAULT_SPORT
}

// --- Default (NFL) exports for back-compat -----------------------------------
// Existing callers/tests import a bare matchTeam / CANONICAL; keep them pointed
// at NFL so nothing changes for the default path.
const nfl = createTeamMatcher(DEFAULT_SPORT)

module.exports = {
  // Back-compat default (NFL).
  matchTeam: nfl.matchTeam,
  CANONICAL: nfl.CANONICAL,
  normalizeKey,
  levenshtein,
  // Sport-aware API.
  createTeamMatcher,
  detectSport,
  scoreSport,
  listTeams,
  normalizeSport,
  SPORTS,
  DEFAULT_SPORT,
}
