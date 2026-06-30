// =============================================================================
// RM Cardz — Order Tracking (simple view)
// -----------------------------------------------------------------------------
// A deliberately plain, read-only overview of every order: the order name
// (customer), how it is (current status), and each break with the teams in it.
// No action buttons, no pipeline controls — those live in the "Order Manager"
// tab. This view just answers "what's in this order and where is it?" at a
// glance, and refreshes itself so status changes made elsewhere show up here.
// =============================================================================

import React, { useEffect, useMemo, useState } from 'react'
import * as api from '../../api.js'
import { ORDER_STAGES, stageByCode } from '../../constants.js'

export default function OrderTracking({ currentUser }) {
  const [orders, setOrders] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState('all')

  // Load once, then poll gently so status changes (Planner / auto-USPS) appear.
  useEffect(() => {
    let alive = true
    const load = () => api.getOrders()
      .then((d) => { if (alive) { setOrders(Array.isArray(d) ? d : []); setError('') } })
      .catch((e) => { if (alive) setError(e.message || 'Failed to load orders') })
      .finally(() => { if (alive) setLoading(false) })
    load()
    const id = setInterval(load, 10000)
    return () => { alive = false; clearInterval(id) }
  }, [])

  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase()
    return orders.filter((o) => {
      if (filter !== 'all' && o.stage !== filter) return false
      if (needle) {
        const teams = o.breaks.map((b) => b.teams.map((t) => t.teamName).join(' ')).join(' ')
        const hay = `${o.customer.realName} ${o.customer.handle} ${teams}`.toLowerCase()
        if (!hay.includes(needle)) return false
      }
      return true
    })
  }, [orders, search, filter])

  if (loading) return <div className="muted">Loading orders…</div>
  if (error) return <div className="banner error" style={{ borderRadius: 8 }}>{error}</div>

  return (
    <div className="col" style={{ gap: 14 }}>
      <div className="row-between" style={{ flexWrap: 'wrap', gap: 10 }}>
        <h2 style={{ margin: 0 }}>📋 Order Tracking</h2>
        <span className="muted small">{visible.length} of {orders.length} orders</span>
      </div>

      {/* Minimal controls: status filter + search. No order actions here. */}
      <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
        <select className="select" style={{ width: 'auto' }} value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter by status">
          <option value="all">All statuses</option>
          {ORDER_STAGES.map((s) => <option key={s.code} value={s.code}>{s.emoji} {s.label}</option>)}
        </select>
        <input
          className="input"
          style={{ width: 'auto', flex: 1, minWidth: 220 }}
          type="search"
          placeholder="Search order or team…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      {visible.length === 0 && <div className="muted">No orders match.</div>}

      {visible.map((o) => {
        const sd = stageByCode[o.stage] || {}
        return (
          <div key={o.id} className="panel" style={{ padding: 14 }}>
            {/* Order name + status */}
            <div className="row-between" style={{ flexWrap: 'wrap', gap: 8, marginBottom: o.breaks.length ? 10 : 0 }}>
              <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
                <strong>{o.customer.realName}</strong>
                <span className="muted small">@{o.customer.handle}</span>
                {o.customer.isNew && <span className="badge amber">NEW</span>}
              </div>
              <span className="order-status-pill" style={{ background: sd.color || 'var(--bg-3)' }}>
                {sd.emoji} {sd.label || o.stage}
              </span>
            </div>

            {/* Breaks + the teams in each */}
            {o.breaks.length === 0 ? (
              <div className="muted small">No teams on this order (giveaway-only).</div>
            ) : (
              o.breaks.map((b) => (
                <div key={b.breakNumber} className="row" style={{ gap: 10, padding: '3px 0', alignItems: 'baseline' }}>
                  <span className="bk" style={{ flex: '0 0 84px', margin: 0 }}>Break #{b.breakNumber}</span>
                  <span>{b.teams.map((t) => t.teamName).join(', ')}</span>
                </div>
              ))
            )}
          </div>
        )
      })}
    </div>
  )
}
