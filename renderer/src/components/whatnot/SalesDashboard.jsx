// =============================================================================
// Whatnot Sales Dashboard (analytics)
// -----------------------------------------------------------------------------
// A read-only analytics rollup for a single Whatnot selling event. Pulls the
// pre-aggregated payload from /api/sales (via api.getSales) and renders:
//   • Headline stat cards (revenue, orders, AOV, giveaways) plus a smaller
//     customer-mix row (unique vs. new customers).
//   • A "Revenue by Break" section using horizontal .bar charts.
//   • "Top Teams" and "Top Customers" tables (table.grid).
// Everything is composed from the existing design-system utility classes; no
// new CSS is introduced. The component is defensive about empty/zero datasets
// so it never renders NaN or divides by zero.
// =============================================================================

import React, { useEffect, useState } from 'react'
import * as api from '../../api.js'

/**
 * Format a number as USD with two decimals.
 * Mirrors the money() helper used in Dashboard.jsx so currency reads the same
 * everywhere in the app. Number(n || 0) coerces null/undefined/'' to 0, which
 * keeps the output free of NaN for missing fields.
 */
function money(n) {
  return '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

/**
 * Format a plain integer count with thousands separators (e.g. 1,234).
 * Number(n || 0) again guards against undefined/null values from the API.
 */
function count(n) {
  return Number(n || 0).toLocaleString('en-US')
}

export default function SalesDashboard({ currentUser }) {
  // `data` holds the /api/sales payload once loaded; null means "still loading".
  // `error` holds a human-readable message when the request fails.
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)

  // Load the sales analytics once on mount. The `alive` flag prevents a state
  // update after the component has unmounted (e.g. tab switched mid-request).
  useEffect(() => {
    let alive = true
    api.getSales()
      .then((d) => { if (alive) setData(d) })
      .catch((e) => { if (alive) setError(e.message) })
    return () => { alive = false }
  }, [])

  // --- Loading & error states -------------------------------------------------
  if (error) return <div className="banner error" style={{ borderRadius: 8 }}>{error}</div>
  if (!data) return <div className="muted">Loading sales dashboard…</div>

  // Destructure the payload, defaulting every collection to an empty array and
  // every nested object to an empty object so the render below never touches an
  // undefined property even if the backend omits a field.
  const {
    event = {},
    totalRevenue,
    totalOrders,
    paidOrders,
    giveaways,
    avgOrderValue,
    uniqueCustomers,
    newCustomers,
    revenueByBreak = [],
    topTeams = [],
    topCustomers = [],
  } = data

  // Sort breaks ascending by break number for a stable, readable order. We copy
  // the array first (slice) so we never mutate the API-provided data in place.
  const breaks = revenueByBreak.slice().sort((a, b) => (a.breakNumber || 0) - (b.breakNumber || 0))

  // Largest break revenue, used to scale the bar widths. Guarded so an empty
  // list (or all-zero revenue) yields 0 rather than -Infinity from Math.max([]).
  const maxBreakRevenue = breaks.reduce((max, b) => Math.max(max, Number(b.revenue) || 0), 0)

  // topTeams / topCustomers arrive already sorted by revenue desc; we just cap
  // the display to the leading ~12 rows to keep the tables compact.
  const teams = topTeams.slice(0, 12)
  const customers = topCustomers.slice(0, 12)

  return (
    <div className="col" style={{ gap: 18 }}>
      {/* ---- Header --------------------------------------------------------- */}
      <div>
        <h2>💰 Whatnot Sales Dashboard</h2>
        <div className="muted">
          {event?.name ? event.name : 'Unnamed event'}{event?.date ? ` · ${event.date}` : ''}
        </div>
      </div>

      {/* ---- Headline stats ------------------------------------------------- */}
      <div className="stat-grid">
        <div className="stat">
          <div className="label">Total Revenue</div>
          <div className="value">{money(totalRevenue)}</div>
        </div>
        <div className="stat">
          <div className="label">Total Orders</div>
          <div className="value">{count(totalOrders)}</div>
        </div>
        <div className="stat">
          <div className="label">Avg Order Value</div>
          <div className="value">{money(avgOrderValue)}</div>
        </div>
        <div className="stat">
          <div className="label">Giveaways</div>
          <div className="value">{count(giveaways)}</div>
        </div>
      </div>

      {/* ---- Customer mix (smaller secondary row) --------------------------- */}
      {/* Rendered as badges so it reads as a lighter, supporting metric row
          beneath the headline stat cards. paidOrders is surfaced here too when
          present, since it pairs naturally with the order/giveaway split. */}
      <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
        <span className="badge green">Unique Customers · {count(uniqueCustomers)}</span>
        <span className="badge amber">New Customers · {count(newCustomers)}</span>
        <span className="badge">Paid Orders · {count(paidOrders)}</span>
      </div>

      {/* ---- Revenue by Break ---------------------------------------------- */}
      <div>
        <div className="section-title" style={{ margin: 0 }}>Revenue by Break</div>
        <div className="panel" style={{ marginTop: 10 }}>
          {breaks.length === 0 && (
            <div style={{ padding: 16 }} className="muted">No break revenue recorded.</div>
          )}
          {breaks.map((b) => {
            const rev = Number(b.revenue) || 0
            // Scale the fill to the largest break's revenue. Guard the divisor:
            // when maxBreakRevenue is 0 every break sits at 0% (no NaN).
            const pct = maxBreakRevenue > 0 ? (rev / maxBreakRevenue) * 100 : 0
            return (
              <div
                key={b.breakNumber}
                className="row"
                style={{ padding: '10px 14px', borderBottom: '1px solid var(--line)', gap: 14 }}
              >
                <strong style={{ width: 90 }} className="nowrap">Break #{b.breakNumber}</strong>
                <div className="bar" style={{ flex: 1 }}>
                  {/* The .good modifier paints the fill green per the spec. */}
                  <span className="good" style={{ width: pct + '%' }} />
                </div>
                <span className="mono nowrap" style={{ width: 96, textAlign: 'right' }}>{money(rev)}</span>
                <span className="muted small nowrap" style={{ width: 84, textAlign: 'right' }}>
                  ({count(b.orders)} orders)
                </span>
              </div>
            )
          })}
        </div>
      </div>

      {/* ---- Top Teams ----------------------------------------------------- */}
      <div>
        <div className="section-title" style={{ margin: 0 }}>Top Teams</div>
        <div className="panel" style={{ marginTop: 10 }}>
          <table className="grid">
            <thead>
              <tr>
                <th>Team</th>
                <th style={{ textAlign: 'right' }}>Orders</th>
                <th style={{ textAlign: 'right' }}>Revenue</th>
              </tr>
            </thead>
            <tbody>
              {teams.length === 0 && (
                <tr>
                  <td colSpan={3} className="muted">No team sales recorded.</td>
                </tr>
              )}
              {teams.map((t, i) => (
                // teamName should be unique, but fall back to the index to keep
                // a stable key if the backend ever returns duplicates/blanks.
                <tr key={t.teamName || i}>
                  <td>{t.teamName || '—'}</td>
                  <td className="mono" style={{ textAlign: 'right' }}>{count(t.count)}</td>
                  <td className="mono" style={{ textAlign: 'right' }}>{money(t.revenue)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* ---- Top Customers ------------------------------------------------- */}
      <div>
        <div className="section-title" style={{ margin: 0 }}>Top Customers</div>
        <div className="panel" style={{ marginTop: 10 }}>
          <table className="grid">
            <thead>
              <tr>
                <th>Customer</th>
                <th style={{ textAlign: 'right' }}>Orders</th>
                <th style={{ textAlign: 'right' }}>Revenue</th>
              </tr>
            </thead>
            <tbody>
              {customers.length === 0 && (
                <tr>
                  <td colSpan={3} className="muted">No customer sales recorded.</td>
                </tr>
              )}
              {customers.map((c, i) => (
                // Whatnot handles are unique per event, so they make a good key;
                // fall back to the index if a handle is somehow missing.
                <tr key={c.handle || i}>
                  <td>
                    {c.realName || '—'}
                    {c.handle ? <span className="muted small"> @{c.handle}</span> : null}
                  </td>
                  <td className="mono" style={{ textAlign: 'right' }}>{count(c.orders)}</td>
                  <td className="mono" style={{ textAlign: 'right' }}>{money(c.revenue)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
