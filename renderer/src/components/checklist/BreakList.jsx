// =============================================================================
// BreakList — the break SELECTION view (engineering spec §6.2)
// -----------------------------------------------------------------------------
// Presentational list of every break for the current event. Each break is a
// clickable card showing a progress bar (checkedTeams / totalTeams), an "X / Y"
// count, and a status badge. The badge upgrades to "COMPLETE ✓" whenever every
// team in a break has been checked off (checkedTeams === totalTeams, with at
// least one team) regardless of the persisted status code, so a freshly
// finished break reads as done even before someone marks it PACKED.
//
// All data loading + polling lives in the parent (BreakChecklist); this
// component is intentionally dumb and just renders + reports clicks upward.
// =============================================================================

import React from 'react'
import { breakStatusLabel } from '../../constants.js'

/**
 * Pick the badge descriptor (CSS modifier + text) for a break row.
 * The visual state is derived from progress first, then the status code:
 *   • fully picked            -> green  "Complete"
 *   • status === 'packed'     -> green  "Packed"
 *   • status === 'shipped'    -> green  "Shipped"
 *   • status === 'picking'    -> amber  "Picking"
 *   • anything else (pending) -> neutral "Pending"
 */
function badgeFor(brk) {
  const done = brk.totalTeams > 0 && brk.checkedTeams === brk.totalTeams
  if (done && brk.status !== 'packed' && brk.status !== 'shipped') {
    return { cls: 'green', text: 'Complete' }
  }
  switch (brk.status) {
    case 'packed':
      return { cls: 'green', text: breakStatusLabel('packed') }
    case 'shipped':
      return { cls: 'green', text: breakStatusLabel('shipped') }
    case 'picking':
      return { cls: 'amber', text: breakStatusLabel('picking') }
    default:
      return { cls: '', text: breakStatusLabel('pending') }
  }
}

export default function BreakList({ breaks, loading, error, onOpenBreak }) {
  return (
    <div className="container">
      <div className="row-between" style={{ marginBottom: 14 }}>
        <h2 style={{ margin: 0 }}>Breaks</h2>
        {/* Quiet activity hint; the list still shows stale rows while refreshing. */}
        {loading && <span className="small muted">Refreshing…</span>}
      </div>

      {/* A load failure is non-fatal: we keep whatever rows we already have. */}
      {error && (
        <div className="banner error" style={{ borderRadius: 8, marginBottom: 12 }}>
          {error}
        </div>
      )}

      {/* Empty state — distinguished from the initial loading spinner. */}
      {breaks.length === 0 && !loading && !error && (
        <div className="card muted">No breaks yet. Import a Whatnot PDF to create breaks.</div>
      )}

      <div className="col" style={{ gap: 12 }}>
        {breaks.map((brk) => {
          const total = brk.totalTeams || 0
          const checked = brk.checkedTeams || 0
          const pct = total > 0 ? Math.round((checked / total) * 100) : 0
          const done = total > 0 && checked === total
          const badge = badgeFor(brk)

          return (
            <button
              key={brk.id}
              type="button"
              className="card"
              onClick={() => onOpenBreak(brk.id)}
              // Override the default <button> look so the whole card reads as a
              // big tap target rather than a pill, while staying keyboard /
              // screen-reader friendly (it is a real button).
              style={{
                width: '100%',
                textAlign: 'left',
                cursor: 'pointer',
                color: 'inherit',
                font: 'inherit',
              }}
              aria-label={`Open break ${brk.breakNumber} — ${brk.eventName}, ${checked} of ${total} teams picked`}
            >
              <div className="row-between" style={{ marginBottom: 8 }}>
                <div className="col" style={{ gap: 2 }}>
                  <div style={{ fontWeight: 650, fontSize: 16 }}>
                    Break #{brk.breakNumber}
                  </div>
                  <div className="muted small">{brk.eventName}</div>
                </div>
                <span className={`badge ${badge.cls}`}>{badge.text}</span>
              </div>

              <div className="row" style={{ gap: 12 }}>
                {/* Bar turns solid green once the break is fully picked. */}
                <div className={`bar ${done ? 'good' : ''}`} style={{ flex: 1 }}>
                  <span style={{ width: `${pct}%` }} />
                </div>
                <span className="mono small nowrap" style={{ minWidth: 56, textAlign: 'right' }}>
                  {checked} / {total}
                </span>
              </div>

              {/* ---- Fidelity line: teams captured vs the full slate ----------
                  A break is a slot for the sport's whole slate (32 NFL / 30 MLB;
                  maxTeams carries the right count). We surface how many we parsed
                  so a fidelity gap (teams lost in the upload) is visible, and
                  alarm on any one-team-per-break collision. */}
              {brk.missingCount != null && (
                <div className="row" style={{ gap: 10, marginTop: 8, flexWrap: 'wrap' }}>
                  {brk.hasAll32 ? (
                    <span className="badge green small">All {brk.maxTeams} teams</span>
                  ) : (
                    <span
                      className="badge amber small"
                      title={`Missing ${brk.missingCount} of ${brk.maxTeams}: ${(brk.missingTeams || []).join(', ')}`}
                    >
                      {brk.maxTeams - brk.missingCount}/{brk.maxTeams} teams · {brk.missingCount} missing
                    </span>
                  )}
                  {brk.collisions && brk.collisions.length > 0 && (
                    <span
                      className="badge red small"
                      title={brk.collisions.map((c) => `${c.team}: ${c.customers.join(', ')}`).join('\n')}
                    >
                      <span className="status-dot" style={{ background: 'var(--bad)' }} aria-hidden="true" />
                      {brk.collisions.length} duplicate team{brk.collisions.length > 1 ? 's' : ''}
                    </span>
                  )}
                </div>
              )}
            </button>
          )
        })}
      </div>
    </div>
  )
}
