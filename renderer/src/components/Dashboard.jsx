// =============================================================================
// Operations Dashboard / Overview tab (spec §8)
// -----------------------------------------------------------------------------
// A read-only, at-a-glance rollup of both modules. Pulls everything from the
// aggregated /api/dashboard endpoint and lets the user jump straight into the
// Break Checklist or Shipping Tracker. Clicking a break row deep-links to Module A.
// =============================================================================

import React, { useEffect, useState } from 'react'
import * as api from '../api.js'
import { SHIPMENT_STATUSES, breakStatusLabel } from '../constants.js'
import Logo from './Logo.jsx'

/** Format a number as USD with two decimals. */
function money(n) {
  return '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

export default function Dashboard({ onGoTo }) {
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    let alive = true
    api.getDashboard()
      .then((d) => { if (alive) setData(d) })
      .catch((e) => { if (alive) setError(e.message) })
    return () => { alive = false }
  }, [])

  if (error) return <div className="banner error" style={{ borderRadius: 8 }}>{error}</div>
  if (!data) return <div className="muted">Loading dashboard…</div>

  const { event, totalOrders, totalRevenue, totalBreaks, totalShipments, breakStats, shippingStats, breaks } = data
  const exceptionCount = (shippingStats.exception || 0) + (shippingStats.returned || 0)

  return (
    <div className="col" style={{ gap: 18 }}>
      {/* Event header */}
      <div className="row" style={{ gap: 12, alignItems: 'center' }}>
        <Logo size={40} />
        <div>
          <h2 style={{ margin: 0 }}>RM Sports Cardz — Break Manager</h2>
          <div className="muted">
            {event?.name ? `Event: ${event.name}` : 'No event name'}{event?.date ? ` · ${event.date}` : ''}
          </div>
        </div>
      </div>

      {/* Headline stats */}
      <div className="stat-grid">
        <div className="stat">
          <div className="label">Total Orders</div>
          <div className="value">{totalOrders}</div>
        </div>
        <div className="stat">
          <div className="label">Total Revenue</div>
          <div className="value">{money(totalRevenue)}</div>
        </div>
        <div className="stat">
          <div className="label">Breaks Done</div>
          <div className="value">{breakStats.complete} / {totalBreaks}</div>
        </div>
        <div className="stat">
          <div className="label">Pkgs Delivered</div>
          <div className="value">{shippingStats.delivered} / {totalShipments}</div>
        </div>
      </div>

      {/* Module A — break progress */}
      <div>
        <div className="row-between">
          <div className="section-title" style={{ margin: 0 }}>Module A — Break Progress</div>
          <button className="btn btn-sm" onClick={() => onGoTo('checker')}>Open Checker →</button>
        </div>
        <div className="panel" style={{ marginTop: 10 }}>
          {breaks.length === 0 && <div style={{ padding: 16 }} className="muted">No breaks imported.</div>}
          {breaks.map((b) => {
            const pct = b.totalTeams ? Math.round((b.checkedTeams / b.totalTeams) * 100) : 0
            const done = b.totalTeams > 0 && b.checkedTeams >= b.totalTeams
            return (
              <div
                key={b.id}
                className="row"
                style={{ padding: '10px 14px', borderBottom: '1px solid var(--line)', cursor: 'pointer', gap: 14 }}
                onClick={() => onGoTo('checker')}
                title="Open the Break Checklist"
              >
                <strong style={{ width: 90 }}>Break #{b.breakNumber}</strong>
                <div className="bar" style={{ flex: 1 }}>
                  <span className={done ? 'good' : ''} style={{ width: pct + '%' }} />
                </div>
                <span className="mono small" style={{ width: 64, textAlign: 'right' }}>{b.checkedTeams}/{b.totalTeams}</span>
                <span className={`badge ${done ? 'green' : b.status === 'pending' ? '' : 'amber'}`} style={{ width: 90, justifyContent: 'center' }}>
                  {done ? 'Complete' : breakStatusLabel(b.status)}
                </span>
              </div>
            )
          })}
        </div>
      </div>

      {/* Module B — shipping overview */}
      <div>
        <div className="row-between">
          <div className="section-title" style={{ margin: 0 }}>Module B — Shipping Overview</div>
          <div className="row" style={{ gap: 10 }}>
            {exceptionCount > 0 && <span className="badge red">{exceptionCount} exceptions</span>}
            <button className="btn btn-sm" onClick={() => onGoTo('shipping')}>Open Shipping Tracker →</button>
          </div>
        </div>
        <div className="panel" style={{ marginTop: 10, padding: 16 }}>
          <div className="stat-grid">
            {SHIPMENT_STATUSES.map((s) => (
              <div key={s.code} className="row" style={{ gap: 10 }}>
                <span className="status-dot" style={{ background: s.color }} aria-hidden="true" />
                <div className="col" style={{ gap: 0 }}>
                  <span className="value" style={{ fontSize: 22 }}>{shippingStats[s.code] || 0}</span>
                  <span className="muted small">{s.label}</span>
                </div>
              </div>
            ))}
          </div>
          <div className="muted small" style={{ marginTop: 12 }}>
            {shippingStats.not_updated || 0} package(s) not yet updated · {totalShipments} total
          </div>
        </div>
      </div>
    </div>
  )
}
