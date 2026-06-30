// =============================================================================
// RM Cardz — Module B (Shipping Tracker)
// ShippingTracker: desktop tool for monitoring USPS delivery of every outbound
// package. Loads all shipments + the batched USPS launch URLs, lets the operator
// bulk-open tracking pages / copy tracking numbers, filter and search the list,
// flip per-shipment statuses, and drill into a detail drawer for notes & breaks.
// -----------------------------------------------------------------------------
// State ownership: this component is the single source of truth for the shipment
// list. All edits (status, notes) are applied optimistically here, then synced
// to the backend via api.updateShipment; on failure we revert to the previous
// snapshot and surface a banner/toast. Designed to stay snappy for ~112 rows.
// =============================================================================

import React, { useEffect, useMemo, useState, useCallback, useRef } from 'react'
import * as api from '../../api.js'
import { SHIPMENT_STATUSES, statusByCode } from '../../constants.js'
import ShipmentRow from './ShipmentRow.jsx'

// Sentinel filter values that don't map to a real status code.
const FILTER_ALL = 'all'
const FILTER_NOT_UPDATED = 'not_updated'

// How long the transient confirmation toast stays on screen (ms).
const TOAST_MS = 2200

export default function ShippingTracker({ currentUser }) {
  // ---- Server-backed state -------------------------------------------------
  const [shipments, setShipments] = useState([])
  const [batchInfo, setBatchInfo] = useState({ totalPackages: 0, batches: [] })
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('') // fatal load failure banner
  const [actionError, setActionError] = useState('') // recoverable action banner
  const [tracking, setTracking] = useState(null) // { done, total } while auto-scanning USPS

  // ---- View state ----------------------------------------------------------
  const [statusFilter, setStatusFilter] = useState(FILTER_ALL)
  const [search, setSearch] = useState('')
  const [expandedId, setExpandedId] = useState(null) // single open drawer
  const [toast, setToast] = useState('') // transient confirmation message

  // Holds the active toast timer so rapid actions reset rather than stack it.
  const toastTimer = useRef(null)

  // Show a brief confirmation toast, replacing any currently visible one.
  const showToast = useCallback((message) => {
    setToast(message)
    if (toastTimer.current) clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToast(''), TOAST_MS)
  }, [])

  // ---- Initial load: shipments + batch URLs in parallel --------------------
  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        const [shipmentList, batches] = await Promise.all([
          api.getShipments(),
          api.getBatchUrls(),
        ])
        if (!alive) return
        // Guard against an unexpected non-array payload so the render path
        // (filter/map/reduce over the list) can never throw.
        setShipments(Array.isArray(shipmentList) ? shipmentList : [])
        setBatchInfo(batches && Array.isArray(batches.batches) ? batches : { totalPackages: 0, batches: [] })
      } catch (err) {
        if (!alive) return
        setLoadError(err.message || 'Failed to load shipments.')
      } finally {
        if (alive) setLoading(false)
      }
    })()
    // Cancel state updates if the component unmounts mid-flight, and clear any
    // pending toast timer.
    return () => {
      alive = false
      if (toastTimer.current) clearTimeout(toastTimer.current)
    }
  }, [])

  // ---- Status summary counts ----------------------------------------------
  // Tally each status code once over the full list (not the filtered view) plus
  // how many shipments have ever been updated (manualStatus.setAt truthy).
  const summary = useMemo(() => {
    const counts = Object.fromEntries(SHIPMENT_STATUSES.map((s) => [s.code, 0]))
    let updated = 0
    for (const s of shipments) {
      if (counts[s.manualStatus.code] !== undefined) counts[s.manualStatus.code] += 1
      if (s.manualStatus.setAt) updated += 1
    }
    return { counts, updated, total: shipments.length }
  }, [shipments])

  // ---- Filtered + searched + sorted view ----------------------------------
  const visibleShipments = useMemo(() => {
    const needle = search.trim().toLowerCase()

    let list = shipments.filter((s) => {
      // Status filter.
      if (statusFilter === FILTER_NOT_UPDATED) {
        if (s.manualStatus.setAt) return false
      } else if (statusFilter !== FILTER_ALL) {
        if (s.manualStatus.code !== statusFilter) return false
      }
      // Free-text search across real name, handle and tracking number.
      if (needle) {
        const haystack = [
          s.customer.realName,
          s.customer.handle,
          s.trackingNumber,
        ]
          .join(' ')
          .toLowerCase()
        if (!haystack.includes(needle)) return false
      }
      return true
    })

    // When showing everything, pin exception rows to the top so problems are
    // immediately visible. Use a stable sort that otherwise preserves the
    // server-provided order.
    if (statusFilter === FILTER_ALL) {
      list = [...list].sort((a, b) => Number(!!b.isException) - Number(!!a.isException))
    }
    return list
  }, [shipments, statusFilter, search])

  // ---- Optimistic mutation helper -----------------------------------------
  // Applies `localPatch` to the matching shipment locally, calls `apiCall`, and
  // on failure restores the pre-edit snapshot while surfacing an error. The
  // server returns the canonical shipment view which we merge back on success.
  const applyOptimistic = useCallback(async (id, localPatch, apiCall, successToast) => {
    setActionError('')
    // Capture ONLY the affected row (functionally, so concurrent edits to other
    // rows are never clobbered) and patch it in place.
    let snapshotRow = null
    setShipments((prev) =>
      prev.map((s) => {
        if (s.id !== id) return s
        snapshotRow = s
        return { ...s, ...localPatch }
      }),
    )
    try {
      const updated = await apiCall()
      // Reconcile with the authoritative server view (e.g. lastUpdated, setAt).
      if (updated && updated.id) {
        setShipments((prev) => prev.map((s) => (s.id === id ? updated : s)))
      }
      if (successToast) showToast(successToast)
    } catch (err) {
      // Revert ONLY this row to its pre-edit value; leave other rows untouched.
      setShipments((prev) => prev.map((s) => (s.id === id && snapshotRow ? snapshotRow : s)))
      setActionError(err.message || 'Update failed — change reverted.')
      showToast('Update failed — reverted')
    }
  }, [showToast])

  // ---- Row callbacks -------------------------------------------------------
  const handleToggle = useCallback((id) => {
    setExpandedId((cur) => (cur === id ? null : id))
  }, [])

  const handleStatusChange = useCallback((id, code) => {
    applyOptimistic(
      id,
      // Mirror the server's bookkeeping locally so the summary updates at once.
      {
        manualStatus: {
          code,
          setAt: new Date().toISOString(),
          setBy: currentUser ? currentUser.username || currentUser.displayName : null,
        },
        isException: !!statusByCode[code]?.isException,
      },
      () => api.updateShipment(id, { manualStatus: code }),
      `Status set to ${statusByCode[code]?.label || code}`,
    )
  }, [applyOptimistic, currentUser])

  const handleSaveNotes = useCallback((id, notes) => {
    return applyOptimistic(
      id,
      { notes },
      () => api.updateShipment(id, { notes }),
      'Notes saved',
    )
  }, [applyOptimistic])

  const handleOpenUsps = useCallback((url) => {
    api.openExternal(url)
  }, [])

  const handleCopyTracking = useCallback(async (trackingNumber) => {
    const ok = await api.copyToClipboard(trackingNumber)
    showToast(ok ? 'Copied tracking number' : 'Copy failed')
  }, [showToast])

  // ---- Auto-update status from USPS (desktop only) ------------------------
  // The Electron main process scrapes each tracking page in a hidden window and
  // writes back any changed statuses; we subscribe to its progress and reload.
  useEffect(() => {
    const off = api.onTrackingProgress((p) => setTracking({ done: p.done, total: p.total }))
    return off
  }, [])

  const refreshUsps = useCallback(async () => {
    if (!api.isDesktop) { showToast('Auto-tracking is only available in the desktop app'); return }
    setActionError('')
    setTracking({ done: 0, total: shipments.length })
    try {
      const res = await api.refreshTracking()
      if (res && res.error) setActionError(res.error)
      else showToast(`USPS check complete — ${res.updated} updated of ${res.scanned} scanned`)
      const fresh = await api.getShipments()
      setShipments(Array.isArray(fresh) ? fresh : [])
    } catch (err) {
      setActionError(err.message || 'USPS refresh failed')
    } finally {
      setTracking(null)
    }
  }, [shipments.length, showToast])

  // ---- Toolbar actions -----------------------------------------------------
  // Open every batch's USPS URL at once via the desktop bridge.
  const handleOpenAllBatches = useCallback(() => {
    const urls = batchInfo.batches.map((b) => b.url)
    if (urls.length === 0) return
    api.openExternalBatch(urls)
  }, [batchInfo])

  // Pull the canonical tracking-number list and copy them newline-separated.
  const handleCopyAllTracking = useCallback(async () => {
    setActionError('')
    try {
      const { trackingNumbers } = await api.getTrackingNumbers()
      const ok = await api.copyToClipboard(trackingNumbers.join('\n'))
      showToast(
        ok
          ? `Copied ${trackingNumbers.length} tracking numbers`
          : 'Copy failed — clipboard unavailable',
      )
    } catch (err) {
      setActionError(err.message || 'Could not fetch tracking numbers.')
    }
  }, [showToast])

  // ---- Render --------------------------------------------------------------
  if (loading) {
    return (
      <div className="container">
        <p className="muted">Loading shipments…</p>
      </div>
    )
  }

  if (loadError) {
    return (
      <div className="container">
        <div className="banner error">⚠️ {loadError}</div>
      </div>
    )
  }

  return (
    <div className="container col" style={{ gap: 16 }}>
      {/* ---- Recoverable action error banner ------------------------------- */}
      {actionError && <div className="banner error">⚠️ {actionError}</div>}

      {/* ---- Toolbar: bulk USPS launch + copy all -------------------------- */}
      <div className="card col" style={{ gap: 10 }}>
        <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
          {tracking ? (
            <span className="badge amber">Checking USPS… {tracking.done}/{tracking.total}</span>
          ) : (
            <button
              type="button"
              className="btn btn-primary"
              onClick={refreshUsps}
              title="Read live delivery status from USPS and update the board automatically"
            >
              🔄 Auto-update status (USPS)
            </button>
          )}
          <button
            type="button"
            className="btn"
            onClick={handleOpenAllBatches}
            disabled={batchInfo.batches.length === 0}
          >
            🌐 Open All in USPS ({batchInfo.batches.length} batches)
          </button>
          <button type="button" className="btn" onClick={handleCopyAllTracking}>
            📋 Copy All Tracking #s
          </button>
        </div>
        <p className="muted small" style={{ margin: 0 }}>
          {api.isDesktop
            ? 'Auto-update reads each package’s status directly from USPS (no manual entry). You can still set any status by hand below.'
            : 'Auto-update runs in the desktop app. Your browser may also block multiple tabs — allow popups for this app.'}
        </p>
      </div>

      {/* ---- Status summary panel ------------------------------------------ */}
      <div className="panel" style={{ padding: 16 }}>
        <div className="section-title" style={{ margin: '0 0 10px' }}>
          Status Summary
        </div>
        <div className="row" style={{ gap: 18, flexWrap: 'wrap' }}>
          {SHIPMENT_STATUSES.map((s) => (
            <span key={s.code} className="nowrap">
              <span aria-hidden="true">{s.emoji}</span> {s.label}:{' '}
              <strong>{summary.counts[s.code]}</strong>
            </span>
          ))}
        </div>
        <p className="muted small" style={{ margin: '10px 0 0' }}>
          Total: {summary.updated} / {summary.total} updated
        </p>
      </div>

      {/* ---- Filter + search controls -------------------------------------- */}
      <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
        <select
          className="select"
          style={{ width: 'auto' }}
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          aria-label="Filter by status"
        >
          <option value={FILTER_ALL}>All</option>
          {SHIPMENT_STATUSES.map((s) => (
            <option key={s.code} value={s.code}>
              {s.emoji} {s.label}
            </option>
          ))}
          <option value={FILTER_NOT_UPDATED}>Not Updated</option>
        </select>
        <input
          className="input"
          style={{ width: 'auto', flex: 1, minWidth: 220 }}
          type="search"
          placeholder="Search name, handle, or tracking #…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          aria-label="Search shipments"
        />
        <span className="muted small nowrap">
          {visibleShipments.length} of {shipments.length} shown
        </span>
      </div>

      {/* ---- Shipment table ------------------------------------------------ */}
      <div className="panel">
        <table className="grid">
          <thead>
            <tr>
              <th>Customer</th>
              <th>Handle</th>
              <th>Tracking #</th>
              <th>Status</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            {visibleShipments.length === 0 ? (
              <tr>
                <td colSpan={5} className="muted">
                  No shipments match the current filter.
                </td>
              </tr>
            ) : (
              visibleShipments.map((s) => (
                <ShipmentRow
                  key={s.id}
                  shipment={s}
                  expanded={expandedId === s.id}
                  onToggle={handleToggle}
                  onStatusChange={handleStatusChange}
                  onSaveNotes={handleSaveNotes}
                  onOpenUsps={handleOpenUsps}
                  onCopyTracking={handleCopyTracking}
                />
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* ---- Transient confirmation toast ---------------------------------- */}
      {toast && <div className="toast">{toast}</div>}
    </div>
  )
}
