// =============================================================================
// PickList — the per-break PICK LIST view (engineering spec §6.3 / §6.4 / §6.5)
// -----------------------------------------------------------------------------
// The single most important operational screen. A picker stands at the table,
// scans the order paper, and taps the matching team row. Requirements baked in:
//   • One giant tap target per team (.pick-row, already >=56px tall).
//   • Tapping ANYWHERE on a row toggles it OPTIMISTICALLY (handled by parent).
//   • Checked rows strike through (.checked) and SINK to the bottom.
//   • A search box filters by team name (no horizontal scroll on a tablet).
//   • Bulk "Mark All Packed ✓" and "Clear All ✗" actions.
//   • A completion prompt when every team is checked (§6.4).
//   • Offline / Synced banners reflecting the parent's sync queue (§6.5).
//
// This component owns ONLY the local search text. Every slot, its optimistic
// checked state, sorting, and persistence are owned by BreakChecklist and
// flow in through props so the offline buffer stays the single source of truth.
// =============================================================================

import React, { useMemo, useState } from 'react'

export default function PickList({
  brk,              // full break detail { id, breakNumber, eventName, teamSlots, ... }
  slots,            // array of slots with the parent's optimistic `checkedOff`
  onBack,           // () => return to the selection list
  onToggleSlot,     // (slotId, nextChecked) => optimistic toggle + persist
  onToggleSleeve,   // (slotId, nextSleeved) => toggle the top-sleeve tag
  onSleeveAll,      // () => top-sleeve every slot in this break
  onClearSleeves,   // () => remove the top-sleeve tag from every slot in this break
  onMarkAllPacked,  // () => check every currently-unchecked slot
  onClearAll,       // () => clearBreak then reload
  onConfirmPacked,  // () => packBreak(id) then refresh (completion prompt)
  busyBulk,         // boolean — a bulk action is in flight (disable buttons)
  syncState,        // 'idle' | 'offline' | 'synced' — drives the sync banner
}) {
  const [query, setQuery] = useState('')
  // The completion prompt is dismissible; dismissing it lets the picker keep
  // reviewing without nagging until they navigate away and back.
  const [promptDismissed, setPromptDismissed] = useState(false)

  const total = slots.length
  const checkedCount = slots.filter((s) => s.checkedOff).length
  const pct = total > 0 ? Math.round((checkedCount / total) * 100) : 0
  const allChecked = total > 0 && checkedCount === total
  const sleevedCount = slots.filter((s) => s.topSleeved).length

  // Filter by team name, then stable-sort unchecked-first so checked rows sink.
  // We re-sort here (not only on the server) because optimistic toggles change
  // a row's bucket instantly and it should glide to the bottom right away.
  const visibleSlots = useMemo(() => {
    const q = query.trim().toLowerCase()
    const filtered = q
      ? slots.filter((s) => (s.teamName || '').toLowerCase().includes(q))
      : slots
    // Copy before sort (never mutate props). Within a bucket keep the parent's
    // order, which the server already sorted sensibly.
    return [...filtered].sort((a, b) => Number(a.checkedOff) - Number(b.checkedOff))
  }, [slots, query])

  return (
    <div className="container">
      {/* ---- Sync banner (§6.5) ------------------------------------------- */}
      {syncState === 'offline' && (
        <div className="banner offline" style={{ borderRadius: 8, marginBottom: 12 }}>
          Offline — changes saved locally
        </div>
      )}
      {syncState === 'synced' && (
        <div className="banner synced" style={{ borderRadius: 8, marginBottom: 12 }}>
          Synced
        </div>
      )}

      {/* ---- Header ------------------------------------------------------- */}
      <div className="row" style={{ marginBottom: 10 }}>
        <button className="btn btn-ghost" onClick={onBack}>← Back to Breaks</button>
      </div>

      <div className="row-between" style={{ marginBottom: 6 }}>
        <h2 style={{ margin: 0 }}>
          BREAK #{brk.breakNumber} — {brk.eventName}
        </h2>
        <span className={`badge ${allChecked ? 'green' : 'amber'}`}>
          {allChecked ? 'Complete' : `${pct}%`}
        </span>
      </div>

      {/* Progress line: "X / Y picked" + bar + percent. */}
      <div className="row" style={{ gap: 12, marginBottom: 4 }}>
        <span className="mono small nowrap">{checkedCount} / {total} picked</span>
        <div className={`bar ${allChecked ? 'good' : ''}`} style={{ flex: 1 }}>
          <span style={{ width: `${pct}%` }} />
        </div>
        <span className="mono small nowrap" style={{ minWidth: 44, textAlign: 'right' }}>{pct}%</span>
      </div>

      {/* Per-break bulk top-sleeve control (sport-agnostic — operates on slots). */}
      <div className="row" style={{ gap: 8, marginBottom: 2, alignItems: 'center', flexWrap: 'wrap' }}>
        {sleevedCount > 0 && <span className="badge sleeve">🛡 {sleevedCount} top-sleeved</span>}
        <span style={{ flex: 1 }} />
        <button
          className="btn btn-sm"
          disabled={busyBulk || total === 0 || sleevedCount === total}
          onClick={onSleeveAll}
          title="Mark every team on this break as top-sleeved"
        >
          🛡 Top-sleeve all
        </button>
        <button
          className="btn btn-sm btn-ghost"
          disabled={busyBulk || sleevedCount === 0}
          onClick={onClearSleeves}
          title="Remove the top-sleeve tag from every team on this break"
        >
          Clear sleeves
        </button>
      </div>

      {/* ---- Completion prompt (§6.4) ------------------------------------- */}
      {allChecked && !promptDismissed && brk.status !== 'packed' && brk.status !== 'shipped' && (
        <div className="card" style={{ marginTop: 14, marginBottom: 4, borderColor: 'var(--good)' }}>
          <div style={{ fontWeight: 650, marginBottom: 4 }}>
            Break #{brk.breakNumber} complete
          </div>
          <div className="muted" style={{ marginBottom: 12 }}>
            All teams checked. Mark this break as PACKED?
          </div>
          <div className="row" style={{ gap: 10 }}>
            <button className="btn btn-primary" disabled={busyBulk} onClick={onConfirmPacked}>
              Yes, Mark as Packed
            </button>
            <button className="btn btn-ghost" onClick={() => setPromptDismissed(true)}>
              Not yet — keep reviewing
            </button>
          </div>
        </div>
      )}

      {/* ---- Toolbar: search + bulk actions ------------------------------ */}
      <div className="row" style={{ gap: 10, margin: '14px 0' }}>
        <input
          className="input"
          style={{ flex: 1 }}
          placeholder="Search teams…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Filter teams by name"
          autoComplete="off"
        />
        <button
          className="btn"
          disabled={busyBulk || allChecked}
          onClick={onMarkAllPacked}
          title="Check off every remaining team"
        >
          Mark All Packed
        </button>
        <button
          className="btn btn-danger"
          disabled={busyBulk || checkedCount === 0}
          onClick={onClearAll}
          title="Uncheck every team on this break"
        >
          Clear All
        </button>
      </div>

      {/* ---- The rows ----------------------------------------------------- */}
      <div className="panel">
        {visibleSlots.length === 0 && (
          <div className="pick-row" style={{ cursor: 'default' }}>
            <span className="muted">
              {total === 0 ? 'No teams in this break.' : 'No teams match your search.'}
            </span>
          </div>
        )}

        {visibleSlots.map((slot) => {
          const customer = slot.customer || {}
          // Hover/long-press detail: realName + full address. Surfaced via the
          // title attribute (works on tablet long-press and desktop hover) and
          // also rendered inline as a small drawer for at-a-glance packing.
          const detailParts = []
          if (customer.realName) detailParts.push(customer.realName)
          if (customer.address) detailParts.push(customer.address)
          const detailTitle = detailParts.join('\n')

          // "who" line: handle · #orderId. Giveaways have no order, so we say so.
          const handle = customer.handle || (slot.isGiveaway ? 'Giveaway' : 'Unassigned')
          const who = slot.orderId ? `${handle} · #${slot.orderId}` : handle

          return (
            <div
              key={slot.id}
              className={`pick-row ${slot.checkedOff ? 'checked' : ''} ${slot.topSleeved ? 'sleeve' : ''}`}
              onClick={() => onToggleSlot(slot.id, !slot.checkedOff)}
              role="checkbox"
              aria-checked={slot.checkedOff}
              tabIndex={0}
              // Keyboard parity: Space / Enter toggles, just like a real checkbox.
              onKeyDown={(e) => {
                if (e.key === ' ' || e.key === 'Enter') {
                  e.preventDefault()
                  onToggleSlot(slot.id, !slot.checkedOff)
                }
              }}
              title={detailTitle || undefined}
            >
              <span className="check">{slot.checkedOff ? '✓' : ''}</span>
              <span className="team">
                {slot.teamName}
                {slot.topSleeved && (
                  <span className="badge sleeve small" style={{ marginLeft: 8 }}>🛡 Top sleeve</span>
                )}
                {slot.isGiveaway && (
                  <span className="badge amber small" style={{ marginLeft: 8 }}>Giveaway</span>
                )}
              </span>
              <span className="who">
                {who}
                {/* Inline detail drawer (a plus over the title tooltip): the real
                    name + address are right there for the packing slip without a
                    hover, but kept dim so they never compete with the team name. */}
                {(customer.realName || customer.address) && (
                  <span className="muted small" style={{ display: 'block' }}>
                    {[customer.realName, customer.address].filter(Boolean).join(' · ')}
                  </span>
                )}
              </span>
              {/* Top-sleeve toggle. stopPropagation so tapping it never also flips
                  the pick checkbox on the row. */}
              {onToggleSleeve && (
                <button
                  type="button"
                  className={`sleeve-toggle ${slot.topSleeved ? 'on' : ''}`}
                  title={slot.topSleeved ? 'Top-sleeved — tap to remove' : 'Mark as top-sleeved'}
                  aria-pressed={!!slot.topSleeved}
                  onClick={(e) => { e.stopPropagation(); onToggleSleeve(slot.id, !slot.topSleeved) }}
                >
                  🛡
                </button>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
