// =============================================================================
// RM Cardz — History (daily snapshots + CSV export)
// -----------------------------------------------------------------------------
// Save a dated snapshot of the current event's order + shipping data so you can
// go back and check it later, and export either the LIVE data or any saved
// snapshot to a CSV file on disk (native Save dialog in the desktop app; a
// normal download in a browser). Two CSVs per source: Orders and Shipping.
// =============================================================================

import React, { useCallback, useEffect, useRef, useState } from 'react'
import * as api from '../../api.js'

function money(n) {
  return '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function when(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString()
}

export default function History({ currentUser }) {
  const [snapshots, setSnapshots] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [toast, setToast] = useState('')

  const mounted = useRef(true)
  const toastTimer = useRef(null)
  useEffect(() => () => {
    mounted.current = false
    if (toastTimer.current) clearTimeout(toastTimer.current)
  }, [])

  const flash = useCallback((msg) => {
    setToast(msg)
    if (toastTimer.current) clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => { if (mounted.current) setToast('') }, 2600)
  }, [])

  const load = useCallback(async () => {
    try {
      const data = await api.listSnapshots()
      if (mounted.current) setSnapshots(Array.isArray(data) ? data : [])
    } catch (err) {
      if (mounted.current) setError(err.message || 'Failed to load history')
    } finally {
      if (mounted.current) setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  // Export current live data OR a snapshot to a CSV file on disk.
  const doExport = useCallback(async (kind, snapshotId, labelForToast) => {
    setBusy(true)
    try {
      const { filename, csv } = await api.exportData(kind, snapshotId)
      const res = await api.saveCsvToDisk(filename, csv)
      if (res && res.saved === false) flash('Export cancelled')
      else flash(`Saved ${kind} CSV${labelForToast ? ` (${labelForToast})` : ''}`)
    } catch (err) {
      flash(err.message || 'Export failed')
    } finally {
      setBusy(false)
    }
  }, [flash])

  const saveSnapshot = useCallback(async () => {
    const label = window.prompt('Name this snapshot (optional):', '') || ''
    setBusy(true)
    try {
      await api.saveSnapshot(label)
      await load()
      flash('Snapshot saved')
    } catch (err) {
      flash(err.message || 'Could not save snapshot')
    } finally {
      setBusy(false)
    }
  }, [load, flash])

  const remove = useCallback(async (snap) => {
    if (!window.confirm(`Delete the snapshot "${snap.label}"?`)) return
    try {
      await api.deleteSnapshot(snap.id)
      await load()
      flash('Snapshot deleted')
    } catch (err) {
      flash(err.message || 'Could not delete')
    }
  }, [load, flash])

  if (loading) return <div className="muted">Loading history…</div>
  if (error) return <div className="banner error" style={{ borderRadius: 8 }}>{error}</div>

  return (
    <div className="col" style={{ gap: 16 }}>
      <div className="row-between" style={{ flexWrap: 'wrap', gap: 10 }}>
        <h2 style={{ margin: 0 }}>🗄 History</h2>
        <button className="btn btn-primary btn-sm" onClick={saveSnapshot} disabled={busy}>＋ Save today’s snapshot</button>
      </div>

      {/* Export the CURRENT live data straight to disk. */}
      <div className="card col" style={{ gap: 10 }}>
        <div className="section-title" style={{ margin: 0 }}>Export current data (CSV)</div>
        <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
          <button className="btn btn-sm" onClick={() => doExport('orders', null, 'current')} disabled={busy}>⬇ Orders CSV</button>
          <button className="btn btn-sm" onClick={() => doExport('shipping', null, 'current')} disabled={busy}>⬇ USPS Shipping CSV</button>
        </div>
        <p className="muted small" style={{ margin: 0 }}>
          Saves a spreadsheet of the current event to your computer. Use “Save today’s snapshot” to keep a dated copy you can revisit and re-export later.
        </p>
      </div>

      {/* Saved snapshots */}
      <div>
        <div className="section-title">Saved snapshots</div>
        <div className="panel">
          {snapshots.length === 0 ? (
            <div style={{ padding: 16 }} className="muted">No snapshots yet. Click “Save today’s snapshot” to keep a record of the current orders and shipping.</div>
          ) : (
            <table className="grid">
              <thead>
                <tr>
                  <th>Saved</th>
                  <th>Event</th>
                  <th style={{ textAlign: 'right' }}>Orders</th>
                  <th style={{ textAlign: 'right' }}>Shipments</th>
                  <th style={{ textAlign: 'right' }}>Revenue</th>
                  <th>Export</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {snapshots.map((s) => (
                  <tr key={s.id}>
                    <td className="small">{when(s.savedAt)}</td>
                    <td>
                      <strong>{s.label}</strong>
                      {s.eventDate && <span className="muted small"> · {s.eventDate}</span>}
                    </td>
                    <td className="mono" style={{ textAlign: 'right' }}>{s.orders}</td>
                    <td className="mono" style={{ textAlign: 'right' }}>{s.shipments}</td>
                    <td className="mono" style={{ textAlign: 'right' }}>{money(s.revenue)}</td>
                    <td>
                      <div className="row" style={{ gap: 6 }}>
                        <button className="btn btn-sm btn-ghost" onClick={() => doExport('orders', s.id, s.label)} disabled={busy}>Orders</button>
                        <button className="btn btn-sm btn-ghost" onClick={() => doExport('shipping', s.id, s.label)} disabled={busy}>Shipping</button>
                      </div>
                    </td>
                    <td>
                      <button className="btn btn-sm btn-danger" onClick={() => remove(s)}>Delete</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {toast && <div className="toast">{toast}</div>}
    </div>
  )
}
