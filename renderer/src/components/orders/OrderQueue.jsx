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

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import * as api from '../../api.js'
import { PIPELINE_STAGES, ORDER_STAGES, stageByCode } from '../../constants.js'

const FLAGGED = new Set(['exception', 'returned'])
const PIPELINE_ORDER = ['to_pick', 'put_together', 'sent', 'all_good']

// The next stage a one-click "Done" should advance an order to.
function nextStageCode(stage) {
  if (stage === 'exception' || stage === 'returned') return 'all_good'
  const i = PIPELINE_ORDER.indexOf(stage)
  return i >= 0 && i < PIPELINE_ORDER.length - 1 ? PIPELINE_ORDER[i + 1] : 'all_good'
}

// `initialOrders` / `initialBreakFilter` are optional test seams: when supplied
// the component seeds from them and skips the network fetch (used by the render
// smoke test). Production passes neither.
export default function OrderQueue({ currentUser, initialOrders, initialBreakFilter = null }) {
  const [orders, setOrders] = useState(initialOrders || [])
  const [loading, setLoading] = useState(!initialOrders)
  const [error, setError] = useState('')
  const [filter, setFilter] = useState('all') // all | <stage> | held | flagged
  const [search, setSearch] = useState('')
  const [breakFilter, setBreakFilter] = useState(initialBreakFilter) // null = all breaks; else a break number
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

  useEffect(() => { if (initialOrders) return; load() }, [load]) // eslint-disable-line react-hooks/exhaustive-deps

  const toastTimer = useRef(null)
  const flash = useCallback((msg) => {
    setToast(msg)
    if (toastTimer.current) clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToast(''), 2200)
  }, [])
  // Clear any pending toast timer on unmount (e.g. switching tabs).
  useEffect(() => () => { if (toastTimer.current) clearTimeout(toastTimer.current) }, [])

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

  // ---- One-click "Done": advance to the next stage and collapse the card --
  // Because the active filter usually excludes the next stage, the finished
  // order drops out of view automatically — no need to keep the whole thing open.
  const markDone = useCallback(async (order) => {
    setExpanded((prev) => { const n = new Set(prev); n.delete(order.id); return n })
    await setStage(order, nextStageCode(order.stage))
  }, [setStage])

  // ---- Reset the manual queue order back to default -----------------------
  const resetQueue = useCallback(async () => {
    if (!window.confirm('Reset the queue back to its default order?')) return
    try {
      const rows = await api.resetQueue()
      setOrders(Array.isArray(rows) ? rows : [])
      flash('Queue order reset')
    } catch (err) { flash(err.message || 'Could not reset queue') }
  }, [flash])

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
      if (res && res.error) {
        flash(res.error)
      } else if (res) {
        const read = res.read != null ? res.read : (res.updated || 0)
        const extra = (res.blocked ? ` · ${res.blocked} blocked` : '') + (res.failed ? ` · ${res.failed} unreadable` : '')
        const checked = res.checked != null ? res.checked : (res.scanned || 0)
        const activeTotal = res.activeTotal != null ? res.activeTotal : checked
        const remainder = res.provider !== '17track' && activeTotal > checked
          ? ` · ${activeTotal - checked} more on next auto-check`
          : ''
        flash(read === 0 && (res.scanned || 0) > 0
          ? 'USPS read 0 statuses — add a 17TRACK key in Settings for reliable tracking'
          : `Updated ${res.updated || 0} · read ${read}/${res.scanned || 0}${extra}${remainder}`)
      }
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

  // Every break number that appears across all orders, ascending — drives the
  // "By break" selector.
  const allBreaks = useMemo(() => {
    const s = new Set()
    orders.forEach((o) => (o.breaks || []).forEach((b) => s.add(b.breakNumber)))
    return [...s].sort((a, b) => a - b)
  }, [orders])

  // When a break is selected, split the (already stage/search-filtered) list into
  // the packages that belong SOLELY to that break and everyone else.
  //
  // "Solely in break N" = every card the package contains is in break N — i.e.
  // the order spans exactly one break, and it's N. (A giveaway is just a card
  // slot in a break, so giveaways count here too.) These are the packages you
  // can pull and ship the moment break N is done; an order that also spans
  // breaks 10/12 can't be finished from break N alone, so it drops to
  // "Other orders" instead of cluttering the break-N group.
  const soleBreakOf = (o) => {
    const bs = o.breaks || []
    return bs.length === 1 ? bs[0].breakNumber : null
  }
  const inBreak = breakFilter != null ? visible.filter((o) => soleBreakOf(o) === breakFilter) : []
  const others = breakFilter != null ? visible.filter((o) => soleBreakOf(o) !== breakFilter) : []

  const toggleExpand = (id) => setExpanded((prev) => {
    const n = new Set(prev)
    n.has(id) ? n.delete(id) : n.add(id)
    return n
  })

  if (loading) return <div className="muted">Loading orders…</div>
  if (error) return <div className="banner error" style={{ borderRadius: 8 }}>{error}</div>

  const FILTERS = [
    { key: 'all', label: 'All' },
    ...PIPELINE_STAGES.map((s) => ({ key: s.code, label: s.label })),
    { key: 'flagged', label: 'Flagged' },
    { key: 'held', label: 'Held' },
  ]

  // Manual reordering is only coherent when the displayed list == the full queue.
  const reorderable = filter === 'all' && !search.trim() && breakFilter == null

  // One collapsed+expandable order row. `list` is the group it renders within (so
  // the move-down button knows the last row); `focusBreak` is that order's slice
  // of the selected break, shown inline so "Break #9" reads as its people + teams.
  const orderRow = (o, idx, list) => {
    const flagged = FLAGGED.has(o.stage)
    const sd = stageByCode[o.stage] || {}
    const isExpanded = expanded.has(o.id)
    const pct = o.pick.total ? Math.round((o.pick.checked / o.pick.total) * 100) : 0
    const focusBreak = breakFilter != null ? (o.breaks || []).find((b) => b.breakNumber === breakFilter) : null
    // Giveaway-only package: the customer bought nothing, they only won a
    // giveaway (every card in the package is a giveaway). None of the paid-card
    // badges apply to it, so without its own flag it looks like an empty order —
    // this makes the promo-only shipment impossible to miss.
    const giveawayOnly = o.hasGiveaway && o.cardCount > 0 && o.giveawayCount >= o.cardCount
    return (
      <div key={o.id} className={`order-row ${o.onHold ? 'held' : ''} ${flagged ? 'flagged' : ''} ${o.topSleevedCount > 0 ? 'has-sleeve' : ''} ${isExpanded ? 'open' : ''}`}>
        {/* Collapsed row — tap anywhere to drop down the team checklist. */}
        <div
          className="order-row-main"
          role="button"
          tabIndex={0}
          onClick={() => toggleExpand(o.id)}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleExpand(o.id) } }}
        >
          <span
            className="order-status-pill"
            style={{ '--pill': sd.color || '#9ca3af' }}
            onClick={(e) => e.stopPropagation()}
          >
            <span className="dot" aria-hidden="true" />
            {sd.label || o.stage}
          </span>

          <div className="order-row-id">
            <strong>{o.customer.realName}</strong>
            <span className="muted small">@{o.customer.handle}</span>
            {focusBreak && (
              <span className="badge" title={`Break #${breakFilter}: ${focusBreak.teams.map((t) => t.teamName).join(', ')}`}>
                {focusBreak.teams.map((t) => t.teamName).join(', ') || `Break #${breakFilter}`}
              </span>
            )}
            {o.customer.isNew && <span className="badge amber">New</span>}
            {o.multiCard && !giveawayOnly && (
              <span className="badge red" title={`Multiple cards (${o.cardCount}) across this order — double-check every card is packed`}>
                {o.cardCount} cards
              </span>
            )}
            {o.multiCard && o.hasGiveaway && !giveawayOnly && (
              <span
                className="badge giveaway-combo"
                title={`${o.cardCount} cards including ${o.giveawayCount} giveaway${o.giveawayCount > 1 ? 's' : ''} — verify the giveaway card ships with this package`}
              >
                🎁 Giveaway + {o.cardCount} cards
              </span>
            )}
            {giveawayOnly && (
              <span
                className="badge giveaway-only"
                title={`Giveaway only — this customer bought nothing, they only won ${o.giveawayCount > 1 ? `${o.giveawayCount} giveaways` : 'a giveaway'}. It still needs to be pulled and shipped.`}
              >
                🎁 Giveaway only{o.giveawayCount > 1 ? ` (${o.giveawayCount})` : ''}
              </span>
            )}
            {o.topSleevedCount > 0 && (
              <span className="badge sleeve solid" title={`${o.topSleevedCount} card(s) need a toploader`}>
                🛡 {o.topSleevedCount} toploader{o.topSleevedCount > 1 ? 's' : ''}
              </span>
            )}
            {o.onHold && <span className="badge" title={o.heldReason || 'On hold'}>Held</span>}
          </div>

          {/* Slim at-a-glance: pick progress only (details live in the drop-down). */}
          <div className="order-row-meta small muted">
            {o.breakCount > 1 && <span className="nowrap">{o.breakCount} breaks</span>}
            <span className="bar bar-inline"><span className={pct >= 100 ? 'good' : ''} style={{ width: pct + '%' }} /></span>
            <span className="mono">{o.pick.checked}/{o.pick.total}</span>
          </div>

          {/* One primary action + expander. (Stage-set moved into the drop-down.) */}
          <div className="order-row-actions" onClick={(e) => e.stopPropagation()}>
            {!sd.terminal && (
              <button className="btn btn-sm btn-primary" onClick={() => markDone(o)} title={`Mark done → ${(stageByCode[nextStageCode(o.stage)] || {}).label}`}>
                Done
              </button>
            )}
            <button className="btn btn-sm btn-ghost order-row-expand" onClick={() => toggleExpand(o.id)} aria-label={isExpanded ? 'Hide teams' : 'Show teams'}>
              {isExpanded ? '▾' : '▸'}
            </button>
          </div>
        </div>

        {/* Drop-down: per-break team CHECKLIST + tucked secondary actions. */}
        {isExpanded && (
          <div className="order-row-detail">
            {o.breaks.length === 0 && <div className="muted small">No teams on this order (giveaway-only).</div>}
            {o.breaks.map((b) => {
              const done = b.teams.filter((t) => t.checkedOff).length
              const complete = b.teams.length > 0 && done >= b.teams.length
              const sleeved = b.teams.filter((t) => t.topSleeved).length
              const isFocus = breakFilter != null && b.breakNumber === breakFilter
              return (
                <div key={b.breakNumber} className="break-group">
                  <div className="bk">
                    <span className="row" style={{ gap: 8, alignItems: 'center' }}>
                      Break #{b.breakNumber}
                      {isFocus && <span className="badge" style={{ padding: '0 6px' }}>selected</span>}
                      {sleeved > 0 && <span className="badge sleeve small" title={`${sleeved} top-sleeved in this break`}>🛡 {sleeved}</span>}
                    </span>
                    <span className="mono small" style={complete ? { color: 'var(--good)' } : undefined}>{done}/{b.teams.length}</span>
                  </div>
                  <div className="row" style={{ flexWrap: 'wrap' }}>
                    {b.teams.map((t) => (
                      <span
                        key={t.slotId}
                        className={`team-chip ${t.checkedOff ? 'checked' : ''} ${t.topSleeved ? 'sleeve' : ''} ${t.isGiveaway ? 'giveaway' : ''}`}
                        onClick={() => toggleTeam(o, t)}
                        title={`${t.checkedOff ? 'Packed — click to undo' : 'Tick when this card is bagged'}${t.topSleeved ? ' · Top-sleeved (needs a toploader)' : ''}${t.isGiveaway ? ' · Giveaway card' : ''}`}
                      >
                        {t.checkedOff ? '✓' : '☐'} {t.topSleeved ? '🛡 ' : ''}{t.isGiveaway ? '🎁 ' : ''}{t.teamName}
                      </span>
                    ))}
                  </div>
                </div>
              )
            })}

            {/* Secondary actions tucked below a hairline so they recede. */}
            <div className="order-detail-actions">
              {o.trackingNumber && <span className="muted small mono" title="Tracking number">{o.trackingNumber}</span>}
              <span className="spacer" />
              <button className="btn btn-sm btn-ghost" onClick={() => toggleHold(o)}>{o.onHold ? 'Resume' : 'Hold'}</button>
              <button className="btn btn-sm btn-ghost" disabled={!reorderable || idx === 0} onClick={() => move(o, 'up')} title={reorderable ? 'Move up' : 'Clear filters to reorder'} aria-label="Move up">↑</button>
              <button className="btn btn-sm btn-ghost" disabled={!reorderable || idx === list.length - 1} onClick={() => move(o, 'down')} title={reorderable ? 'Move down' : 'Clear filters to reorder'} aria-label="Move down">↓</button>
              {o.trackingNumber && <button className="btn btn-sm btn-ghost" onClick={() => api.openExternal(o.uspsUrl)} aria-label="Open USPS tracking">USPS</button>}
              <select className="select select-sm" value={o.stage} onChange={(e) => setStage(o, e.target.value)} aria-label="Set status" title="Set status">
                {ORDER_STAGES.map((s) => <option key={s.code} value={s.code}>{s.label}</option>)}
              </select>
            </div>
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="col" style={{ gap: 14 }}>
      {/* Toolbar */}
      <div className="row-between" style={{ flexWrap: 'wrap', gap: 10 }}>
        <h2 style={{ margin: 0 }}>Orders</h2>
        <div className="row" style={{ gap: 8 }}>
          <button className="btn btn-sm btn-ghost" onClick={resetQueue} title="Reset the manual queue order back to default">
            Reset queue
          </button>
          {tracking
            ? <span className="badge amber">Checking USPS… {tracking.done}/{tracking.total}</span>
            : (
              <button className="btn btn-sm" onClick={refreshUsps} title="Read live delivery status from USPS and update Sent / All Good automatically">
                Auto-update USPS status
              </button>
            )}
        </div>
      </div>

      {!api.isDesktop && (
        <div className="banner" style={{ background: 'var(--bg-3)', borderRadius: 8 }}>
          Auto USPS status runs in the desktop app. In the browser you can still advance stages manually.
        </div>
      )}

      {/* Filter chips + break selector + search */}
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        {FILTERS.map((f) => (
          <button key={f.key} className={`chip-filter ${filter === f.key ? 'active' : ''}`} onClick={() => setFilter(f.key)}>
            {f.label} <span className="muted">({counts[f.key] || 0})</span>
          </button>
        ))}
        {allBreaks.length > 0 && (
          <select
            className="select"
            style={{ width: 'auto' }}
            value={breakFilter == null ? '' : String(breakFilter)}
            onChange={(e) => setBreakFilter(e.target.value === '' ? null : Number(e.target.value))}
            aria-label="Group orders by break"
            title="Show one break's orders first, then the rest"
          >
            <option value="">All breaks</option>
            {allBreaks.map((n) => <option key={n} value={n}>Break #{n}</option>)}
          </select>
        )}
        <input
          className="input"
          style={{ width: 'auto', flex: 1, minWidth: 200 }}
          type="search"
          placeholder="Search name, handle, tracking #…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      {/* Order list — one scannable row per order. The full pipeline, hold/reorder,
          USPS and per-team pick detail live in the ▾ expand. When a break is
          selected, that break's packages are grouped first, then everyone else. */}
      {breakFilter == null ? (
        <>
          {visible.length === 0 && <div className="muted">No orders match this filter.</div>}
          {visible.map((o, idx) => orderRow(o, idx, visible))}
        </>
      ) : (
        <>
          <div className="section-title" style={{ margin: '4px 0' }}>
            Only in Break #{breakFilter} — {inBreak.length} package{inBreak.length === 1 ? '' : 's'}
          </div>
          <div className="muted small" style={{ marginTop: -2, marginBottom: 6 }}>
            Packages whose every card is in Break #{breakFilter} — pull and ship these together.
            Orders that also span other breaks are under “Other orders” below.
          </div>
          {inBreak.length === 0
            ? <div className="muted">No packages are solely in Break #{breakFilter}.</div>
            : inBreak.map((o, idx) => orderRow(o, idx, inBreak))}
          <div className="section-title" style={{ margin: '20px 0 4px' }}>
            Other orders — {others.length}
          </div>
          {others.length === 0
            ? <div className="muted">No other orders.</div>
            : others.map((o, idx) => orderRow(o, idx, others))}
        </>
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  )
}
