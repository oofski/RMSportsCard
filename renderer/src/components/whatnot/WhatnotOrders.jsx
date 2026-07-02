// =============================================================================
// Whatnot Orders view
// -----------------------------------------------------------------------------
// A read-only, filterable table of orders pulled from a Whatnot live break.
// Data comes from the aggregated /api/whatnot-orders endpoint (see api.js).
// Each order describes a single team slot sold (or given away) during a break,
// the customer who claimed it, and the price paid. This view lets an operator
// scan, search, and slice those orders by break, free-text, and giveaway-only.
//
// Lives in renderer/src/components/whatnot/, so the API client is two levels up.
// Uses ONLY existing design-system utility classes from styles.css — no new CSS.
// =============================================================================

import React, { useEffect, useMemo, useState } from 'react'
import * as api from '../../api.js'

/**
 * Format a number as USD with two decimals (e.g. 12 -> "$12.00").
 * Mirrors the money() helper used elsewhere in the app for visual consistency.
 */
function money(n) {
  return '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

/**
 * The effective revenue for a single order. Giveaways are always counted as
 * $0.00 regardless of any price the backend might carry on them, so totals and
 * the per-row display stay consistent with the "Giveaway" classification.
 */
function effectivePrice(o) {
  return o.isGiveaway ? 0 : Number(o.price || 0)
}

export default function WhatnotOrders({ currentUser }) {
  // ---- Remote state -------------------------------------------------------
  // `orders` is null until the first load resolves; that distinguishes the
  // initial loading state from a legitimately empty result set ([]).
  const [orders, setOrders] = useState(null)
  const [error, setError] = useState(null)

  // ---- Filter / control state --------------------------------------------
  const [query, setQuery] = useState('')          // free-text search box
  const [breakFilter, setBreakFilter] = useState('all') // 'all' or a breakNumber
  const [giveawaysOnly, setGiveawaysOnly] = useState(false)

  // ---- Load on mount ------------------------------------------------------
  // The `alive` guard prevents a state update if the component unmounts before
  // the request settles (avoids a React state-on-unmounted warning).
  useEffect(() => {
    let alive = true
    api.getWhatnotOrders()
      .then((data) => { if (alive) setOrders(Array.isArray(data) ? data : []) })
      .catch((e) => { if (alive) setError(e.message) })
    return () => { alive = false }
  }, [])

  // ---- Distinct break numbers for the <select> ----------------------------
  // Sorted numerically when the values look numeric, otherwise lexically, so
  // breaks read 1, 2, 10 (not 1, 10, 2). Recomputed only when orders change.
  const breakNumbers = useMemo(() => {
    if (!orders) return []
    const set = new Set(orders.map((o) => o.breakNumber))
    return Array.from(set).sort((a, b) => {
      const na = Number(a)
      const nb = Number(b)
      if (!Number.isNaN(na) && !Number.isNaN(nb)) return na - nb
      return String(a).localeCompare(String(b))
    })
  }, [orders])

  // ---- Filtered + stably-sorted rows --------------------------------------
  // useMemo keeps this cheap across re-renders for a few hundred rows. We sort
  // by breakNumber then orderId; the API already returns that order, but an
  // explicit stable sort makes the view robust to any backend ordering change.
  const filtered = useMemo(() => {
    if (!orders) return []
    const q = query.trim().toLowerCase()

    const rows = orders.filter((o) => {
      // Break filter (exact match against the chosen breakNumber).
      if (breakFilter !== 'all' && String(o.breakNumber) !== String(breakFilter)) return false
      // Giveaways-only toggle.
      if (giveawaysOnly && !o.isGiveaway) return false
      // Free-text search across orderId, real name, handle, and team name.
      if (q) {
        const haystack = [
          o.orderId,
          o.customer && o.customer.realName,
          o.customer && o.customer.handle,
          o.teamName,
        ].filter(Boolean).join(' ').toLowerCase()
        if (!haystack.includes(q)) return false
      }
      return true
    })

    // Stable comparator: primary key breakNumber (numeric when possible),
    // tie-broken by orderId.
    return rows.slice().sort((a, b) => {
      const na = Number(a.breakNumber)
      const nb = Number(b.breakNumber)
      if (!Number.isNaN(na) && !Number.isNaN(nb) && na !== nb) return na - nb
      const byBreak = String(a.breakNumber).localeCompare(String(b.breakNumber))
      if (byBreak !== 0) return byBreak
      return String(a.orderId).localeCompare(String(b.orderId))
    })
  }, [orders, query, breakFilter, giveawaysOnly])

  // ---- Aggregates over the filtered set -----------------------------------
  const totalRevenue = useMemo(
    () => filtered.reduce((sum, o) => sum + effectivePrice(o), 0),
    [filtered],
  )
  const giveawayCount = useMemo(
    () => filtered.reduce((n, o) => n + (o.isGiveaway ? 1 : 0), 0),
    [filtered],
  )

  // ---- Early returns: error / loading -------------------------------------
  if (error) {
    return <div className="banner error" style={{ borderRadius: 8 }}>{error}</div>
  }
  if (orders === null) {
    return <div className="muted">Loading Whatnot orders…</div>
  }

  return (
    <div className="col" style={{ gap: 18 }}>
      {/* Header: title + a muted summary line reflecting the filtered view. */}
      <div>
        <h2>Whatnot Orders</h2>
        <div className="muted">
          Showing {filtered.length} of {orders.length} order{orders.length === 1 ? '' : 's'}
          {' · '}
          {money(totalRevenue)} total
        </div>
      </div>

      {/* Controls: search, break filter, and giveaways-only toggle. */}
      <div className="row" style={{ flexWrap: 'wrap', gap: 12 }}>
        <input
          type="search"
          className="input"
          style={{ flex: 1, minWidth: 220 }}
          placeholder="Search order ID, customer, handle, or team…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <select
          className="select"
          style={{ width: 180 }}
          value={breakFilter}
          onChange={(e) => setBreakFilter(e.target.value)}
        >
          <option value="all">All breaks</option>
          {breakNumbers.map((bn) => (
            <option key={bn} value={bn}>Break #{bn}</option>
          ))}
        </select>
        <label className="row nowrap" style={{ gap: 8, cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={giveawaysOnly}
            onChange={(e) => setGiveawaysOnly(e.target.checked)}
          />
          <span className="small">Giveaways only</span>
        </label>
      </div>

      {/* At-a-glance stats for the current (filtered) view. */}
      <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
        <div className="stat" style={{ flex: 1, minWidth: 160 }}>
          <div className="label">Orders</div>
          <div className="value">{filtered.length}</div>
        </div>
        <div className="stat" style={{ flex: 1, minWidth: 160 }}>
          <div className="label">Revenue</div>
          <div className="value">{money(totalRevenue)}</div>
        </div>
        <div className="stat" style={{ flex: 1, minWidth: 160 }}>
          <div className="label">Giveaways</div>
          <div className="value">{giveawayCount}</div>
        </div>
      </div>

      {/* Orders table. Empty state shown when the active filters match nothing. */}
      <div className="panel">
        {filtered.length === 0 ? (
          <div className="muted" style={{ padding: 16 }}>No orders match.</div>
        ) : (
          <table className="grid">
            <thead>
              <tr>
                <th>Order ID</th>
                <th>Customer</th>
                <th className="nowrap">Break #</th>
                <th>Team</th>
                <th style={{ textAlign: 'right' }}>Price</th>
                <th>Type</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((o) => {
                const customer = o.customer || {}
                return (
                  <tr key={o.orderId}>
                    {/* Order ID rendered monospaced for easy scanning. */}
                    <td className="mono nowrap">{o.orderId}</td>

                    {/* Customer: real name, muted @handle, and a NEW badge. */}
                    <td>
                      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                        <span>{customer.realName || '—'}</span>
                        {customer.handle && (
                          <span className="muted small">@{customer.handle}</span>
                        )}
                        {customer.isNew && <span className="badge">New</span>}
                      </div>
                    </td>

                    <td className="mono">{o.breakNumber}</td>
                    <td>{o.teamName}</td>

                    {/* Price right-aligned; giveaways always display $0.00. */}
                    <td className="mono nowrap" style={{ textAlign: 'right' }}>
                      {money(effectivePrice(o))}
                    </td>

                    {/* Type badge: green "Paid" vs amber "Giveaway". */}
                    <td className="nowrap">
                      {o.isGiveaway
                        ? <span className="badge amber">Giveaway</span>
                        : <span className="badge green">Paid</span>}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
