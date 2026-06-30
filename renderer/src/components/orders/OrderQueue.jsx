// =============================================================================
// RM Cardz — Planner view (Order Fulfillment Queue)
// -----------------------------------------------------------------------------
// One card per customer ORDER (= package / shipment). Each card shows the
// breaks + teams in that order and a four-step pipeline the planner clicks
// through as they physically assemble and ship it:
//     To Pick → Put Together → Sent → All Good
// "Sent" and "All Good" write the shipment's manual status, so the Shipping
// Tracker stays in sync (one source of truth). Orders can be put on HOLD
// (e.g. waiting on a break that isn't opened yet) and MOVED up/down the queue.
//
// Team checkboxes are the shared pick detail (same data the Checker view edits).
// A desktop-only "Auto-update USPS status" button scrapes USPS for live
// delivery status and advances Sent/All Good automatically.
// =============================================================================

import React, { useCallback, useEffect, useMemo, useState } from 'react'
import * as api from '../../api.js'
import { PIPELINE_STAGES, stageByCode } from '../../constants.js'

const FLAGGED = new Set(['exception', 'returned'])

export default function OrderQueue({ currentUser }) {
  const [orders, setOrders] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [filter, setFilter] = useState('all') // all | <stage> | held | flagged
  const [search, setSearch] = useState('')
  const [expanded, setExpanded] = useState(() => new Set())
  const [toast, setToast] = useState('')
  const [tracking, setTracking] = useState(null) // { done, total } while scanning

  const load = useCallback(async () => {
    try {
      const data = await api.getOrders()
      setOrders(Array.isArray(data) ? data : [])
    } catch (err) {
      setError(err.message || 'Failed to load orders')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const flash = useCallback((msg) => {
    setToast(msg)
    setTimeout(() => setToast(''), 2200)
  }, [])

  // ---- Replace a single order row in local state (after a mutation) --------
  const replaceRow = useCallback((row) => {
    if (!row || !row.id) return
    setOrders((prev) => {
      const next = prev.map((o) => (o.id === row.id ? row : o))
      // Re-apply the backend sort: held last, then queue order.
      return next.sort((a, b) => (a.onHold !== b.onHold ? (a.onHold ? 1 : -1) : a.queueOrder - b.queueOrder))
    })
  }, [])

  // ---- Stage change (click any pipeline step) -----------------------------
  const setStage = useCallback(async (order, stage) => {
    if (order.stage === stage) return
    try {
      const row = await api.setOrderStage(order.id, stage)
      replaceRow(row)
    } catch (err) { flash(err.message || 'Could not update stage') }
  }, [replaceRow, flash])

  // ---- Hold / resume ------------------------------------------------------
  const toggleHold = useCallback(async (order) => {
    let reason = null
    if (!order.onHold) {
      reason = window.prompt('Put this order on hold — reason? (optional, e.g. "waiting on Break #4")', '') || null
    }
    try {
      const row = await api.setOrderHold(order.id, !order.onHold, reason)
      replaceRow(row)
    } catch (err) { flash(err.message || 'Could not change hold') }
  }, [replaceRow, flash])

  // ---- Move up / down in the queue ----------------------------------------
  const move = useCallback(async (order, direction) => {
    try {
      await api.moveOrder(order.id, direction)
      await load() // a move swaps two rows; reload to reflect the new order
    } catch (err) { flash(err.message || 'Could not move order') }
  }, [load, flash])

  // ---- Toggle a team checkbox (shared pick detail) ------------------------
  const toggleTeam = useCallback(async (order, slot) => {
    const next = !slot.checkedOff
    // Optimistic: flip the slot + pick count locally.
    setOrders((prev) => prev.map((o) => {
      if (o.id !== order.id) return o
      const breaks = o.breaks.map((b) => ({
        ...b,
        teams: b.teams.map((t) => (t.slotId === slot.slotId ? { ...t, checkedOff: next } : t)),
      }))
      const checked = breaks.reduce((n, b) => n + b.teams.filter((t) => t.checkedOff).length, 0)
      return { ...o, breaks, pick: { ...o.pick, checked } }
    }))
    try {
      await api.toggleTeamSlot(slot.slotId, next)
    } catch (err) {
      flash('Save failed — reloading')
      load()
    }
  }, [load, flash])

  // ---- Auto-update USPS status (desktop only) -----------------------------
  useEffect(() => {
    // Live progress while the main process scrapes USPS.
    const off = api.onTrackingProgress((p) => setTracking({ done: p.done, total: p.total }))
    return off
  }, [])

  const refreshUsps = useCallback(async () => {
    if (!api.isDesktop) { flash('Auto-tracking is only available in the desktop app'); return }
    setTracking({ done: 0, total: orders.length })
    try {
      const res = await api.refreshTracking()
      if (res && res.error) flash(res.error)
      else flash(`USPS check done — ${res.updated} updated of ${res.scanned} scanned`)
      await load()
    } catch (err) {
      flash(err.message || 'USPS refresh failed')
    } finally {
      setTracking(null)
    }
  }, [orders.length, load, flash])

  // ---- Derived: counts + filtered/searched view ---------------------------
  const counts = useMemo(() => {
    const c = { all: orders.length, held: 0, flagged: 0 }
    PIPELINE_STAGES.forEach((s) => { c[s.code] = 0 })
    orders.forEach((o) => {
      if (o.onHold) c.held += 1
      if (FLAGGED.has(o.stage)) c.flagged += 1
      if (c[o.stage] !== undefined) c[o.stage] += 1
    })
    return c
  }, [orders])

  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase()
    return orders.filter((o) => {
      if (filter === 'held' && !o.onHold) return false
      else if (filter === 'flagged' && !FLAGGED.has(o.stage)) return false
      else if (filter !== 'all' && filter !== 'held' && filter !== 'flagged' && o.stage !== filter) return false
      if (needle) {
        const hay = `${o.customer.realName} ${o.customer.handle} ${o.trackingNumber || ''}`.toLowerCase()
        if (!hay.includes(needle)) return false
      }
      return true
    })
  }, [orders, filter, search])

  const toggleExpand = (id) => setExpanded((prev) => {
    const n = new Set(prev)
    n.has(id) ? n.delete(id) : n.add(id)
    return n
  })

  if (loading) return <div className="muted">Loading orders…</div>
  if (error) return <div className="banner error" style={{ borderRadius: 8 }}>{error}</div>

  const FILTERS = [
    { key: 'all', label: 'All' },
    ...PIPELINE_STAGES.map((s) => ({ key: s.code, label: `${s.emoji} ${s.label}` })),
    { key: 'flagged', label: '🔴 Flagged' },
    { key: 'held', label: '⏸ Held' },
  ]

  return (
    <div className="col" style={{ gap: 14 }}>
      {/* Toolbar */}
      <div className="row-between" style={{ flexWrap: 'wrap', gap: 10 }}>
        <h2 style={{ margin: 0 }}>📋 Planner — Order Queue</h2>
        <div className="row" style={{ gap: 8 }}>
          {tracking
            ? <span className="badge amber">Checking USPS… {tracking.done}/{tracking.total}</span>
            : (
              <button className="btn btn-sm" onClick={refreshUsps} title="Read live delivery status from USPS and update Sent / All Good automatically">
                🔄 Auto-update USPS status
              </button>
            )}
        </div>
      </div>

      {!api.isDesktop && (
        <div className="banner" style={{ background: 'var(--bg-3)', borderRadius: 8 }}>
          Auto USPS status runs in the desktop app. In the browser you can still advance stages manually.
        </div>
      )}

      {/* Filter chips */}
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        {FILTERS.map((f) => (
          <button key={f.key} className={`chip-filter ${filter === f.key ? 'active' : ''}`} onClick={() => setFilter(f.key)}>
            {f.label} <span className="muted">({counts[f.key] || 0})</span>
          </button>
        ))}
        <input
          className="input"
          style={{ width: 'auto', flex: 1, minWidth: 200 }}
          type="search"
          placeholder="Search name, handle, tracking #…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      {/* Order cards */}
      {visible.length === 0 && <div className="muted">No orders match this filter.</div>}
      {visible.map((o, idx) => {
        const flagged = FLAGGED.has(o.stage)
        const sd = stageByCode[o.stage] || {}
        const isExpanded = expanded.has(o.id)
        const pct = o.pick.total ? Math.round((o.pick.checked / o.pick.total) * 100) : 0
        return (
          <div key={o.id} className={`order-card ${o.onHold ? 'held' : ''} ${flagged ? 'flagged' : ''}`}>
            {/* Header */}
            <div className="row-between" style={{ flexWrap: 'wrap', gap: 8 }}>
              <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
                <span className="badge" style={{ background: sd.color || 'var(--bg-3)', color: '#06283a' }}>
                  {sd.emoji} {sd.label || o.stage}
                </span>
                <strong>{o.customer.realName}</strong>
                <span className="muted small">@{o.customer.handle}</span>
                {o.customer.isNew && <span className="badge amber">NEW</span>}
                {o.onHold && <span className="badge">⏸ On hold{o.heldReason ? `: ${o.heldReason}` : ''}</span>}
              </div>
              <div className="row" style={{ gap: 12 }}>
                <span className="small muted">{o.breakCount} break{o.breakCount === 1 ? '' : 's'}</span>
                <span className="small mono">{o.pick.checked}/{o.pick.total} picked</span>
                {o.trackingNumber && (
                  <span className="small mono nowrap" title={o.trackingNumber}>
                    {o.trackingNumber.slice(0, 4)}…{o.trackingNumber.slice(-4)}
                  </span>
                )}
              </div>
            </div>

            {/* Pick progress */}
            <div className="bar" style={{ margin: '10px 0' }}>
              <span className={pct >= 100 ? 'good' : ''} style={{ width: pct + '%' }} />
            </div>

            {/* Pipeline stepper */}
            <div className="stage-steps">
              {PIPELINE_STAGES.map((s, i) => (
                <React.Fragment key={s.code}>
                  {i > 0 && <span className="stage-arrow">→</span>}
                  <button
                    className={`stage-step ${o.stage === s.code ? 'active' : ''}`}
                    style={o.stage === s.code ? { background: s.color } : undefined}
                    onClick={() => setStage(o, s.code)}
                    title={`Mark as ${s.label}`}
                  >
                    {s.emoji} {s.label}
                  </button>
                </React.Fragment>
              ))}
            </div>

            {/* Actions */}
            <div className="row" style={{ gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
              <button className="btn btn-sm btn-ghost" onClick={() => toggleExpand(o.id)}>
                {isExpanded ? '▾ Hide teams' : '▸ Show teams'}
              </button>
              <button className="btn btn-sm btn-ghost" onClick={() => toggleHold(o)}>
                {o.onHold ? '▶ Resume' : '⏸ Hold'}
              </button>
              <button className="btn btn-sm btn-ghost" disabled={idx === 0} onClick={() => move(o, 'up')} title="Move up in queue">↑</button>
              <button className="btn btn-sm btn-ghost" disabled={idx === visible.length - 1} onClick={() => move(o, 'down')} title="Move down in queue">↓</button>
              {o.trackingNumber && (
                <button className="btn btn-sm btn-ghost" onClick={() => api.openExternal(o.uspsUrl)}>🌐 USPS</button>
              )}
            </div>

            {/* Breaks + teams */}
            {isExpanded && (
              <div style={{ marginTop: 10 }}>
                {o.breaks.length === 0 && <div className="muted small">No teams on this order (giveaway-only).</div>}
                {o.breaks.map((b) => (
                  <div key={b.breakNumber} className="break-group">
                    <div className="bk">Break #{b.breakNumber}</div>
                    <div className="row" style={{ flexWrap: 'wrap' }}>
                      {b.teams.map((t) => (
                        <span
                          key={t.slotId}
                          className={`team-chip ${t.checkedOff ? 'checked' : ''}`}
                          onClick={() => toggleTeam(o, t)}
                          title={t.checkedOff ? 'Picked — click to uncheck' : 'Click when this card is pulled'}
                        >
                          {t.checkedOff ? '✓' : '☐'} {t.teamName}
                        </span>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )
      })}

      {toast && <div className="toast">{toast}</div>}
    </div>
  )
}
