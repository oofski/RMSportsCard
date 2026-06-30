// =============================================================================
// NFL team name normalization (spec Appendix B)
// -----------------------------------------------------------------------------
// The PDF text layer can contain minor formatting variations of team names.
// We snap each extracted name to the canonical 32-team list using a case- and
// punctuation-insensitive match first, then a Levenshtein distance <= 2 fuzzy
// fallback. Pure functions -> easy to unit test.
// =============================================================================

const reference = require('../../shared/reference.json')

const CANONICAL = reference.nflTeams

/** Lowercase, strip non-alphanumerics, collapse whitespace. */
function normalizeKey(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

const KEY_TO_CANONICAL = new Map(CANONICAL.map((t) => [normalizeKey(t), t]))

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

/**
 * Resolve a raw team string to a canonical NFL team name.
 * @returns {{ team: string|null, exact: boolean, distance: number }}
 */
function matchTeam(raw) {
  const key = normalizeKey(raw)
  if (!key) return { team: null, exact: false, distance: Infinity }

  const exact = KEY_TO_CANONICAL.get(key)
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

module.exports = { matchTeam, normalizeKey, levenshtein, CANONICAL }
