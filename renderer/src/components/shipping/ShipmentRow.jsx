// =============================================================================
// RM Cardz — Module B (Shipping Tracker)
// ShipmentRow: one shipment in the dense desktop tracking table.
// -----------------------------------------------------------------------------
// Each shipment renders as TWO sibling rows inside the same <tbody>:
//   1) the summary row (Customer / Handle / Tracking # / Status / Action)
//   2) an expanded detail row (full-width <td colSpan>) holding a .detail-drawer
//      — only mounted when this row is expanded.
// All data mutations (status change, notes save) are optimistic and bubble up
// to the parent via callbacks; the parent owns the authoritative shipment list
// and performs the API call + revert-on-error. This component stays presentational
// apart from the local, unsaved notes draft kept while the drawer is open.
// =============================================================================

import React, { useState, useEffect } from 'react'
import * as api from '../../api.js'
import { SHIPMENT_STATUSES, statusByCode } from '../../constants.js'

// Number of table columns in the summary row — used by the detail row's colSpan
// so the drawer spans the entire grid width.
const COLUMN_COUNT = 5

/**
 * Render a tracking number as "9305…4387": the first four and last four
 * characters joined by an ellipsis. Short/empty values are returned as-is so we
 * never produce a misleading truncation.
 */
function truncateTracking(value) {
  if (!value) return '—'
  if (value.length <= 8) return value
  return `${value.slice(0, 4)}…${value.slice(-4)}`
}

export default function ShipmentRow({
  shipment,
  expanded,
  onToggle,
  onStatusChange,
  onSaveNotes,
  onOpenUsps,
  onCopyTracking,
}) {
  // Local working copy of the notes textarea. Seeded from the shipment and kept
  // in sync whenever the underlying shipment notes change (e.g. after a save or
  // a parent refresh) so the drawer always reflects committed state.
  const [notesDraft, setNotesDraft] = useState(shipment.notes || '')
  // Tracks an in-flight notes save so the Save button can disable itself and
  // avoid duplicate requests on rapid clicks.
  const [savingNotes, setSavingNotes] = useState(false)

  useEffect(() => {
    setNotesDraft(shipment.notes || '')
  }, [shipment.notes])

  const status = statusByCode[shipment.manualStatus.code] || statusByCode.not_shipped
  const isException = !!shipment.isException

  // Persist notes through the parent (which owns the API call + toast/error
  // handling). We await so the local "saving" flag clears once the round-trip
  // completes, regardless of success or failure.
  async function handleSaveNotes() {
    setSavingNotes(true)
    try {
      await onSaveNotes(shipment.id, notesDraft)
    } finally {
      setSavingNotes(false)
    }
  }

  return (
    <>
      {/* ---- Summary row ---------------------------------------------------- */}
      {/* Clicking anywhere on the row toggles the drawer; interactive controls
          inside (the status select and USPS button) stopPropagation so they
          never accidentally collapse/expand the row. */}
      <tr
        className={`clickable${isException ? ' exception' : ''}`}
        onClick={() => onToggle(shipment.id)}
      >
        {/* Customer: real name, an exception marker, and a NEW pill. */}
        <td>
          <div className="row" style={{ gap: 8 }}>
            {isException && (
              <span
                className="status-dot"
                style={{ background: 'var(--bad)' }}
                role="img"
                title="Exception — needs attention"
                aria-label="exception"
              />
            )}
            <span>{shipment.customer.realName}</span>
            {shipment.customer.isNew && <span className="badge green small">New</span>}
          </div>
        </td>

        {/* Handle (social/marketplace identity). */}
        <td className="muted nowrap">{shipment.customer.handle}</td>

        {/* Tracking number — truncated for density, full value on hover. */}
        <td className="mono nowrap" title={shipment.trackingNumber}>
          {truncateTracking(shipment.trackingNumber)}
        </td>

        {/* Status: colored dot + a bound <select>. Optimistic change handled by parent. */}
        <td onClick={(e) => e.stopPropagation()}>
          <div className="row nowrap" style={{ gap: 8 }}>
            <span className="status-dot" style={{ background: status.color }} aria-hidden="true" />
            <select
              className="select"
              value={shipment.manualStatus.code}
              onChange={(e) => onStatusChange(shipment.id, e.target.value)}
              aria-label={`Status for ${shipment.customer.realName}`}
            >
              {SHIPMENT_STATUSES.map((s) => (
                <option key={s.code} value={s.code}>
                  {s.label}
                </option>
              ))}
            </select>
          </div>
        </td>

        {/* Action: jump straight to the USPS tracking page. */}
        <td onClick={(e) => e.stopPropagation()}>
          <button
            type="button"
            className="btn btn-sm btn-ghost nowrap"
            onClick={() => onOpenUsps(shipment.uspsUrl)}
            aria-label="Open USPS tracking"
          >
            USPS
          </button>
        </td>
      </tr>

      {/* ---- Detail drawer row --------------------------------------------- */}
      {/* Only mounted while expanded so we keep ~112 rows light. The single cell
          spans the full grid width and hosts the .detail-drawer panel. */}
      {expanded && (
        <tr>
          <td colSpan={COLUMN_COUNT} style={{ padding: 0 }}>
            <div className="detail-drawer">
              <div className="col" style={{ gap: 14 }}>
                {/* Top metadata grid: full tracking #, service, weight. */}
                <div className="row" style={{ gap: 28, flexWrap: 'wrap', alignItems: 'flex-start' }}>
                  <div className="col" style={{ gap: 2 }}>
                    <span className="small muted">Tracking #</span>
                    <span className="mono">{shipment.trackingNumber}</span>
                  </div>
                  <div className="col" style={{ gap: 2 }}>
                    <span className="small muted">Service</span>
                    <span>
                      {shipment.carrier} · {shipment.serviceType}
                    </span>
                  </div>
                  <div className="col" style={{ gap: 2 }}>
                    <span className="small muted">Weight</span>
                    <span>{shipment.weightOz} oz</span>
                  </div>
                </div>

                {/* Shipping address. */}
                <div className="col" style={{ gap: 2 }}>
                  <span className="small muted">Address</span>
                  <span>{shipment.customer.address}</span>
                </div>

                {/* Breaks bundled into this package. */}
                <div className="col" style={{ gap: 4 }}>
                  <span className="small muted">Breaks in this package</span>
                  {shipment.breaks && shipment.breaks.length > 0 ? (
                    <ul style={{ margin: 0, paddingLeft: 18 }}>
                      {shipment.breaks.map((b) => (
                        <li key={b.breakNumber}>
                          Break #{b.breakNumber} → {b.teams.join(', ')}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <span className="muted small">No breaks recorded.</span>
                  )}
                </div>

                {/* Notes editor — bound to a local draft, saved via the parent. */}
                <div className="col" style={{ gap: 6 }}>
                  <span className="small muted">Notes</span>
                  <textarea
                    className="input"
                    rows={3}
                    value={notesDraft}
                    onChange={(e) => setNotesDraft(e.target.value)}
                    placeholder="Add a note for this shipment…"
                  />
                  <div className="row">
                    <button
                      type="button"
                      className="btn btn-sm btn-primary"
                      onClick={handleSaveNotes}
                      disabled={savingNotes}
                    >
                      {savingNotes ? 'Saving…' : 'Save'}
                    </button>
                  </div>
                </div>

                {/* Quick actions for this shipment. */}
                <div className="row" style={{ gap: 10 }}>
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => onOpenUsps(shipment.uspsUrl)}
                  >
                    Open USPS Tracking
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm btn-ghost"
                    onClick={() => onCopyTracking(shipment.trackingNumber)}
                  >
                    Copy Tracking #
                  </button>
                </div>
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  )
}
