// =============================================================================
// Sales Dashboard (Whatnot LEDGER CSV)
// -----------------------------------------------------------------------------
// This tab is entirely driven by an uploaded Whatnot *ledger* CSV export. The
// client reads the CSV text and POSTs it to /api/ledger; the backend parses and
// aggregates it, returning a single analysis payload that this component renders:
//
//   • When no ledger is stored (hasLedger === false) we show an UPLOAD screen —
//     a drag-and-drop .dropzone plus a "Choose CSV…" file picker. Dropping or
//     picking a .csv reads it as text and uploads it.
//   • When a ledger exists we render a tabbed dashboard:
//       – Overview: KPI tiles, a "Net revenue by day" bar chart, a revenue-by-
//         product donut, the sale-type mix and a costs & extras card.
//       – Revenue by day: the expandable per-day list with per-product drill-down.
//       – Team breaks: breaks-per-case control, per-case stats and top breaks.
//
// Everything is composed from the existing design-system utility classes
// (.card / .panel / .stat / .stat-grid / .bar / .chip-filter / .table.grid /
// .section-title / .dropzone / .banner). Charts are the local SVG components in
// ./charts.jsx — no chart library. The render is defensive about empty / zero
// data so it never produces NaN or divides by zero.
//
// Stripe payouts are intentionally ignored by the backend (they are transfers,
// not revenue); giveaways are tracked as losses (negative values).
// =============================================================================

import React, { useEffect, useRef, useState } from 'react'
import * as api from '../../api.js'
import { BarChart, Donut } from './charts.jsx'

/**
 * Format a number as USD with two decimals — e.g. 1234.5 → "$1,234.50".
 * Number(n || 0) coerces null/undefined/'' to 0 so the output is never NaN.
 * Negative inputs render with the minus BEFORE the dollar sign (e.g.
 * "-$703.02"), which is exactly how we want giveaway losses to read — we
 * format the magnitude and prepend the sign so it never lands as "$-703.02".
 */
function money(n) {
  const v = Number(n || 0)
  const body = Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  return (v < 0 ? '-$' : '$') + body
}

/** Format a plain integer count with thousands separators (e.g. 1,234). */
function count(n) {
  return Number(n || 0).toLocaleString('en-US')
}

// The dashboard tabs (id ↔ visible label).
const TABS = [
  ['overview', 'Overview'],
  ['profit', 'Profit'],
  ['byday', 'Revenue by day'],
  ['breaks', 'Team breaks'],
]

/** Format a percent number as e.g. 65 → "65%". */
function pct(n) {
  return Number(n || 0).toFixed(0) + '%'
}

// "2026-06-28" → "Jun 28" (renderer-side twin of ledger.cjs formatDayLabel).
const MONTHS_ABBR = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
function dayLabel(k) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(k || ''))
  return m ? `${MONTHS_ABBR[Number(m[2])] || ''} ${Number(m[3])}` : String(k || '')
}

/** Immutably sort a copy of `rows` by `key` in `dir` ('asc'|'desc'). Strings
 *  compare via localeCompare; everything else numerically. */
function sortRows(rows, key, dir) {
  const sign = dir === 'asc' ? 1 : -1
  return rows.slice().sort((a, b) => {
    const av = a[key], bv = b[key]
    if (typeof av === 'string' || typeof bv === 'string') {
      return String(av ?? '').localeCompare(String(bv ?? '')) * sign
    }
    return ((Number(av) || 0) - (Number(bv) || 0)) * sign
  })
}

export default function SalesDashboard({ currentUser, initialData }) {
  // ---- Component state ------------------------------------------------------
  // `data` is the /api/ledger analysis payload (or { hasLedger:false }); null
  // means "still loading the initial fetch". A caller may hand us the payload
  // directly via `initialData`, in which case the initial fetch is skipped.
  // `error` is a human-readable banner message. `busy` is true while a CSV is
  // being read + uploaded (disables the dropzone / buttons).
  const [data, setData] = useState(initialData || null)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  const [dragging, setDragging] = useState(false) // dropzone hover highlight
  // Which "Revenue by Day" rows are expanded to show their per-break breakdown.
  const [expandedDays, setExpandedDays] = useState(() => new Set())
  // Active dashboard tab: 'overview' | 'profit' | 'byday' | 'breaks'.
  const [tab, setTab] = useState('overview')
  // Team-breaks tab: sortable columns + a product filter box.
  const [sortBreaks, setSortBreaks] = useState({ key: 'revenue', dir: 'desc' })
  const [breakQuery, setBreakQuery] = useState('')

  // Hidden <input type=file> used by the visible "Choose CSV…" / "Replace CSV"
  // buttons. `alive` guards setState after unmount (tab switched mid-request).
  const inputRef = useRef(null)
  const aliveRef = useRef(true)

  // ---- Initial load ---------------------------------------------------------
  // Skipped entirely when the payload was provided via `initialData`.
  useEffect(() => {
    aliveRef.current = true
    if (!initialData) {
      api.getLedger()
        .then((d) => { if (aliveRef.current) setData(d) })
        .catch((e) => { if (aliveRef.current) setError(e.message) })
    }
    return () => { aliveRef.current = false }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // ---- CSV upload -----------------------------------------------------------
  // Validate that the picked file is a .csv, read it as text, upload it, and
  // replace state with the returned analysis. Used by both the first-run upload
  // screen and the dashboard's "Replace CSV" button.
  async function handleFile(file) {
    if (!file) return
    const isCsv = file.type === 'text/csv' || /\.csv$/i.test(file.name || '')
    if (!isCsv) {
      setError('That file is not a CSV. Please choose your Whatnot ledger export (ending in .csv).')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const text = await file.text() // File.text() resolves the contents as a string
      const result = await api.uploadLedger(file.name, text)
      if (!aliveRef.current) return
      setData(result)
    } catch (e) {
      if (aliveRef.current) setError(e.message)
    } finally {
      if (aliveRef.current) setBusy(false)
    }
  }

  // File-picker plumbing: button → hidden input → handleFile.
  const openPicker = () => inputRef.current && inputRef.current.click()
  const onInputChange = (e) => {
    const picked = e.target.files && e.target.files[0]
    handleFile(picked)
    e.target.value = '' // reset so re-picking the same file still fires onChange
  }

  // Drag-and-drop handlers. preventDefault stops the browser from navigating to
  // the dropped file; `dragging` toggles the .drag highlight on the dropzone.
  const onDragOver = (e) => { e.preventDefault(); setDragging(true) }
  const onDragLeave = (e) => { e.preventDefault(); setDragging(false) }
  const onDrop = (e) => {
    e.preventDefault()
    setDragging(false)
    if (busy) return
    const picked = e.dataTransfer.files && e.dataTransfer.files[0]
    handleFile(picked)
  }

  // ---- Clear ledger ---------------------------------------------------------
  async function handleClear() {
    if (!window.confirm('Clear the uploaded ledger? This removes the current sales analysis.')) return
    setBusy(true)
    setError(null)
    try {
      await api.clearLedger()
      if (!aliveRef.current) return
      setData({ hasLedger: false }) // back to the upload screen
    } catch (e) {
      if (aliveRef.current) setError(e.message)
    } finally {
      if (aliveRef.current) setBusy(false)
    }
  }

  // ---- Hidden file input (shared by both screens) ---------------------------
  const fileInput = (
    <input ref={inputRef} type="file" accept=".csv" className="hidden" onChange={onInputChange} />
  )

  // ---- Loading state --------------------------------------------------------
  if (!data && !error) return <div className="muted">Loading sales dashboard…</div>

  // =====================================================================
  // UPLOAD SCREEN — shown on hard error before any data, or when no ledger.
  // =====================================================================
  if ((error && !data) || (data && !data.hasLedger)) {
    return (
      <div className="center-screen">
        <div className="card" style={{ width: 560 }}>
          <h2>Sales Dashboard</h2>
          <div className="muted small" style={{ marginBottom: 18 }}>
            Upload your Whatnot ledger CSV export to see revenue, per-day, per-break and
            per-case totals. Stripe payouts are ignored; giveaways are tracked as losses.
          </div>

          {/* Dropzone: drag-drop a .csv anywhere inside this box. */}
          <div
            className={`dropzone${dragging ? ' drag' : ''}`}
            onDragOver={onDragOver}
            onDragEnter={onDragOver}
            onDragLeave={onDragLeave}
            onDrop={onDrop}
          >
            <div className="col" style={{ alignItems: 'center', gap: 6 }}>
              <div>{busy ? 'Parsing your ledger…' : 'Drag & drop your Whatnot ledger CSV here'}</div>
              <div className="muted small">or use the button below — .csv only</div>
            </div>
          </div>

          {fileInput}

          <div className="row" style={{ marginTop: 14 }}>
            <button className="btn btn-primary" onClick={openPicker} disabled={busy}>
              {busy ? 'Uploading…' : 'Choose CSV…'}
            </button>
          </div>

          {/* Error banner (validation or upload failure). */}
          {error && (
            <div className="banner error" style={{ borderRadius: 8, marginTop: 12 }}>
              {error}
            </div>
          )}
        </div>
      </div>
    )
  }

  // From here on we have a real ledger payload. Destructure with safe defaults
  // so a missing nested field never throws or yields NaN downstream.
  const {
    filename,
    uploadedAt,
    dateRange = {},
    totals = {},
    perDay = [],
    perBreak = [],
    perCase = {},
    unattributed = {},
    warnings = [],
    revenueByProduct = [],
    saleTypeMix = [],
    transactionMix = [],
    profit = {},
    costInputs = {},
    costs = {},
  } = data

  // New split cost fields (present on v1.5.18+ payloads). `hasSplit` gates the
  // richer Costs card + Profit tab so an OLD stored payload degrades gracefully.
  const {
    shippingCosts, promotionFees = 0, sellerBonuses = 0, otherFees = 0,
    netShipping = 0, platformFees = 0,
  } = costs
  const hasSplit = shippingCosts !== undefined
  const hasProfit = profit && profit.initialProfit !== undefined

  const {
    grossEarnings = 0,
    giveawayLost = 0,   // <= 0 (a loss)
    netRevenue = 0,
    adjustments = 0,
    tips = 0,
    payoutsIgnoredCount = 0,
    earningCount = 0,
  } = totals

  // Per-day list scaling (Revenue by day tab). We copy the array (perDay is
  // already sorted ascending by day) and find the max net so bar fills scale
  // 0–100%. Guard the divisor so an empty / all-zero list never yields NaN.
  const days = perDay.slice()
  const maxNet = days.reduce((max, d) => Math.max(max, Number(d.net) || 0), 0)

  // Team-breaks tab: filter perBreak by the query (product/label), then sort by
  // the active column. No cap — the table scrolls and is fully sortable.
  const breakNeedle = breakQuery.trim().toLowerCase()
  const filteredBreaks = breakNeedle
    ? perBreak.filter((b) => `${b.productLabel || ''} ${b.product || ''}`.toLowerCase().includes(breakNeedle))
    : perBreak
  const sortedFilteredBreaks = sortRows(filteredBreaks, sortBreaks.key, sortBreaks.dir)
  const toggleSort = (key) =>
    setSortBreaks((s) => (s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'desc' }))

  // ---- Per-case rollups + the live "breaks per case" control ----------------
  const {
    breaksPerCase = 1,
    totalBreaks = 0,
    totalCases = 0,
    avgRevenuePerBreak = 0,
    avgRevenuePerCase = 0,
    byProduct = [],
  } = perCase

  // Toggle a day row open/closed in the "Revenue by Day" drill-down. We copy the
  // Set so React sees a new reference and re-renders.
  const toggleDay = (day) => {
    setExpandedDays((prev) => {
      const next = new Set(prev)
      if (next.has(day)) next.delete(day)
      else next.add(day)
      return next
    })
  }

  // Sale-type-mix bar scaling and the per-day average (guard days > 0).
  const maxTypeRev = saleTypeMix.reduce((m, t) => Math.max(m, Number(t.revenue) || 0), 0)
  const avgPerDay = Number(dateRange.days) > 0 ? netRevenue / Number(dateRange.days) : 0

  // ---- Overview chart inputs -------------------------------------------------
  // Bar chart: one bar per day, MM-DD label, net clamped ≥ 0, sales count sub.
  const barData = perDay.map((d) => ({
    label: String(d.day || '').slice(5),
    value: Math.max(0, Number(d.net) || 0),
    sub: `${count(d.count)} sales`,
  }))
  // Donut: revenue share per product (the Donut itself sorts / folds "Other").
  // `title` carries the full product string so the legend hover shows the real name.
  const donutSlices = revenueByProduct.map((p) => ({
    label: p.productLabel,
    title: p.product || p.productLabel,
    value: Number(p.revenue) || 0,
  }))

  // A stacked label/value row for the "Costs & extras" card.
  const costRow = (label, value, color) => (
    <div className="row-between" style={{ padding: '6px 0', borderBottom: '1px solid var(--line)' }}>
      <span className="muted small">{label}</span>
      <span className="mono small" style={color ? { color } : undefined}>{money(value)}</span>
    </div>
  )

  return (
    <div className="col" style={{ gap: 18 }}>
      {/* Hidden input drives the "Replace CSV" button on this screen too. */}
      {fileInput}

      {/* ---- 1. Header row -------------------------------------------------- */}
      <div className="row-between" style={{ alignItems: 'flex-start' }}>
        <div>
          <h2>Sales Dashboard</h2>
          <div className="muted small">
            Ledger: {filename || '—'} · {dateRange.start || '?'} → {dateRange.end || '?'}{' '}
            ({count(dateRange.days)} days)
          </div>
        </div>
        <div className="row" style={{ gap: 8 }}>
          <button className="btn btn-sm" onClick={openPicker} disabled={busy}>
            {busy ? 'Working…' : 'Replace CSV'}
          </button>
          <button className="btn btn-sm btn-danger" onClick={handleClear} disabled={busy}>
            Clear
          </button>
        </div>
      </div>

      {/* ---- 2. Non-fatal error banner (e.g. a failed Replace/Clear) -------- */}
      {error && (
        <div className="banner error" style={{ borderRadius: 8 }}>{error}</div>
      )}

      {/* ---- 3. Tab row ------------------------------------------------------ */}
      <div className="row" role="tablist" aria-label="Sales dashboard views" style={{ gap: 8 }}>
        {TABS.map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            className={`chip-filter${tab === id ? ' active' : ''}`}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </div>

      {/* ---- 4. Tab content --------------------------------------------------- */}

      {/* ===================== OVERVIEW TAB ===================== */}
      {tab === 'overview' && (
        <div
          style={{
            display: 'grid',
            // Row 1: 260px KPI rail + wide chart. Row 2: three EQUAL card slots —
            // the donut needs ~380px for svg + legend, so it must not inherit the
            // 260px rail column (that collided the legend into the next card).
            gridTemplateColumns: 'repeat(6, 1fr)',
            gridTemplateAreas:
              "'kpis kpis chart chart chart chart' 'donut donut mix mix costs costs'",
            gap: 16,
            alignItems: 'stretch',
          }}
        >
          {/* KPI tiles (left rail) */}
          <div className="col" style={{ gridArea: 'kpis', gap: 12, minWidth: 0 }}>
            <div className="stat">
              <div className="label">Net revenue</div>
              <div className="value">{money(netRevenue)}</div>
            </div>
            <div className="stat">
              <div className="label">Gross</div>
              <div className="value">{money(grossEarnings)}</div>
            </div>
            <div className="stat">
              <div className="label">Given away</div>
              {/* giveawayLost is <= 0; render in red so the loss reads clearly. */}
              <div className="value" style={{ color: 'var(--bad)' }}>{money(giveawayLost)}</div>
            </div>
            <div className="stat">
              <div className="label">Sales</div>
              <div className="value">{count(earningCount)}</div>
            </div>
            <div className="stat">
              <div className="label">Avg/day</div>
              <div className="value">{money(avgPerDay)}</div>
            </div>
          </div>

          {/* Net revenue by day (hero bar chart) */}
          <div className="card" style={{ gridArea: 'chart', minWidth: 0 }}>
            <div className="section-title" style={{ margin: '0 0 12px' }}>Net revenue by day</div>
            <BarChart data={barData} height={260} ariaLabel="Net revenue by day" />
          </div>

          {/* Revenue by product (donut) */}
          <div className="card" style={{ gridArea: 'donut', minWidth: 0 }}>
            <div className="section-title" style={{ margin: '0 0 12px' }}>Revenue by product</div>
            <Donut slices={donutSlices} centerValue={grossEarnings} centerLabel="Gross" size={160} thickness={26} />
          </div>

          {/* Sale category (thin-bar rows) + raw ledger composition strip. */}
          <div className="card" style={{ gridArea: 'mix', minWidth: 0 }}>
            <div className="section-title" style={{ margin: '0 0 4px' }}>Sale category</div>
            <div className="muted small" style={{ marginBottom: 10 }}>
              Gross earnings grouped by how the item sold (classified from the product text).
            </div>
            {saleTypeMix.length === 0 && <div className="muted small">No sales recorded.</div>}
            {saleTypeMix.map((t) => {
              // Scale to the biggest type; clamp 0–100 so a zero max or a
              // negative revenue never produces an invalid width. NB: named
              // `barPct` (NOT `pct`) so it doesn't shadow the module-level pct()
              // formatter used just below for the percent-of-gross column.
              const barPct = maxTypeRev > 0
                ? Math.min(100, Math.max(0, ((Number(t.revenue) || 0) / maxTypeRev) * 100))
                : 0
              return (
                <div key={t.type} className="row" style={{ gap: 10, padding: '6px 0', minWidth: 0 }}>
                  <span
                    className="small nowrap"
                    style={{ width: 110, overflow: 'hidden', textOverflow: 'ellipsis' }}
                    title={t.label}
                  >
                    {t.label}
                  </span>
                  <div className="bar" style={{ flex: 1, minWidth: 24 }}>
                    <span style={{ width: barPct + '%' }} />
                  </div>
                  <span className="mono small nowrap" style={{ width: 84, textAlign: 'right' }}>{money(t.revenue)}</span>
                  <span className="muted small nowrap" style={{ width: 38, textAlign: 'right' }}>{pct(t.pctOfGross)}</span>
                  <span className="muted small nowrap" style={{ width: 48, textAlign: 'right' }}>({count(t.count)})</span>
                </div>
              )
            })}

            {/* Ledger composition: the RAW transaction vocabulary (what the file
                actually contained), distinct from the derived category mix above. */}
            {transactionMix.length > 0 && (
              <>
                <div className="muted small" style={{ fontWeight: 600, margin: '12px 0 4px' }}>Ledger composition</div>
                {transactionMix.map((tx) => (
                  <div key={tx.type} className="row-between" style={{ padding: '3px 0' }}>
                    <span className="muted small">{tx.label} <span className="mono">({count(tx.count)})</span></span>
                    <span className="mono small">{money(tx.amount)}</span>
                  </div>
                ))}
              </>
            )}
          </div>

          {/* Costs & extras — the ADJUSTMENT bucket split into named income/cost
              lines. Falls back to the single legacy "Platform fees" row on an
              old payload (hasSplit === false). */}
          <div className="card" style={{ gridArea: 'costs', minWidth: 0 }}>
            <div className="section-title" style={{ margin: '0 0 12px' }}>Costs &amp; extras</div>
            {hasSplit ? (
              <>
                <div className="muted small" style={{ fontWeight: 600, marginBottom: 2 }}>Income</div>
                {costRow('Shipping subsidies', costs.shippingSubsidies, 'var(--good)')}
                {sellerBonuses !== 0 && costRow('Seller bonuses', sellerBonuses, 'var(--good)')}
                <div className="muted small" style={{ fontWeight: 600, margin: '8px 0 2px' }}>Costs</div>
                {costRow('Shipping costs', shippingCosts, 'var(--bad)')}
                {costRow('Promotion fees (boosts)', promotionFees, 'var(--bad)')}
                {costRow('Given away', costs.giveaways, 'var(--bad)')}
                {otherFees !== 0 && costRow('Other fees', otherFees, 'var(--bad)')}
                <div style={{ marginTop: 6 }} />
                {costRow('Net shipping', netShipping, netShipping < 0 ? 'var(--bad)' : 'var(--good)')}
                {costRow('Tips', costs.tips)}
                {costRow('Net adjustments', costs.adjustmentsNet)}
              </>
            ) : (
              <>
                {costRow('Given away', costs.giveaways, 'var(--bad)')}
                {costRow('Shipping subsidies', costs.shippingSubsidies, 'var(--good)')}
                {costRow('Platform fees', platformFees, 'var(--bad)')}
                {costRow('Tips', costs.tips)}
                {costRow('Net adjustments', costs.adjustmentsNet)}
              </>
            )}
            <div className="muted small" style={{ marginTop: 10 }}>
              Payouts ignored ({count(payoutsIgnoredCount)}) · excluded from net revenue
            </div>
          </div>
        </div>
      )}

      {/* ===================== REVENUE BY DAY TAB ===================== */}
      {tab === 'byday' && (
        <div>
          <div className="section-title" style={{ margin: 0 }}>Revenue by Day</div>
          <div className="panel" style={{ marginTop: 10 }}>
            {days.length === 0 && (
              <div style={{ padding: 16 }} className="muted">No daily revenue recorded.</div>
            )}
            {days.map((d) => {
              const net = Number(d.net) || 0
              // Scale the fill to the busiest day. When maxNet is 0 every bar sits
              // at 0% (no NaN / divide-by-zero). Clamp to >=0 so a negative-net day
              // (giveaways exceed gross) never yields an invalid negative width.
              const pct = maxNet > 0 ? Math.max(0, (net / maxNet) * 100) : 0
              // Day drill-down: that day's revenue grouped by PRODUCT (sums to the
              // day's gross). Falls back gracefully on older payloads.
              const products = d.products || []
              const hasDetail = products.length > 0
              const isOpen = expandedDays.has(d.day)
              return (
                <div key={d.day} style={{ borderBottom: '1px solid var(--line)' }}>
                  <div
                    className="row"
                    style={{
                      padding: '10px 14px',
                      gap: 14,
                      cursor: hasDetail ? 'pointer' : 'default',
                    }}
                    onClick={hasDetail ? () => toggleDay(d.day) : undefined}
                    role={hasDetail ? 'button' : undefined}
                    aria-expanded={hasDetail ? isOpen : undefined}
                  >
                    <span className="mono small nowrap" style={{ width: 14, opacity: hasDetail ? 1 : 0 }}>
                      {isOpen ? '▾' : '▸'}
                    </span>
                    <span className="mono small nowrap" style={{ width: 96 }}>{d.day}</span>
                    <div className="bar" style={{ flex: 1 }}>
                      <span style={{ width: pct + '%' }} />
                    </div>
                    <span className="mono nowrap" style={{ width: 100, textAlign: 'right' }}>{money(net)}</span>
                    <span className="muted small nowrap" style={{ width: 56, textAlign: 'right' }}>
                      ({count(d.count)})
                    </span>
                  </div>
                  {isOpen && hasDetail && (
                    <div style={{ padding: '4px 14px 12px 42px' }}>
                      <div className="muted small" style={{ marginBottom: 4 }}>By product (gross)</div>
                      {products.map((entry, i) => (
                        <div
                          key={`${entry.productLabel || ''}-${i}`}
                          className="row"
                          style={{ gap: 12, padding: '3px 0' }}
                        >
                          <span className="small nowrap" style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }} title={entry.product || entry.productLabel}>
                            {entry.productLabel}
                          </span>
                          <span className="mono small nowrap" style={{ width: 100, textAlign: 'right' }}>
                            {money(entry.revenue)}
                          </span>
                          <span className="muted small nowrap" style={{ width: 56, textAlign: 'right' }}>
                            ({count(entry.count)})
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* ===================== TEAM BREAKS TAB ===================== */}
      {tab === 'breaks' && (
        <div className="card">
          {/* Live control: change breaks-per-case to recompute the case rollups. */}
          <BreaksPerCaseControl
            value={breaksPerCase}
            busy={busy}
            onCommit={async (n) => {
              setBusy(true)
              setError(null)
              try {
                const result = await api.setLedgerBreaksPerCase(n)
                if (!aliveRef.current) return
                setData(result)
              } catch (e) {
                if (aliveRef.current) setError(e.message)
              } finally {
                if (aliveRef.current) setBusy(false)
              }
            }}
          />
          <div className="stat-grid" style={{ marginTop: 14 }}>
            <div className="stat">
              <div className="label">Team breaks</div>
              <div className="value">{count(totalBreaks)}</div>
            </div>
            <div className="stat">
              <div className="label">Cases (÷{count(breaksPerCase)})</div>
              <div className="value">{count(totalCases)}</div>
            </div>
            <div className="stat">
              <div className="label">Avg / Break</div>
              <div className="value">{money(avgRevenuePerBreak)}</div>
            </div>
            <div className="stat">
              <div className="label">Avg / Case</div>
              <div className="value">{money(avgRevenuePerCase)}</div>
            </div>
          </div>
          <div className="muted small" style={{ marginTop: 8 }}>
            A break = one “Break #N” of a product on a given day. Cases = breaks ÷ breaks-per-case.
          </div>

          {/* Per-product / per-case rollup */}
          <div className="section-title">By product / case</div>
          <table className="grid">
            <thead>
              <tr>
                <th>Product</th>
                <th style={{ textAlign: 'right' }}>Breaks</th>
                <th style={{ textAlign: 'right' }}>Cases</th>
                <th style={{ textAlign: 'right' }}>Revenue</th>
                <th style={{ textAlign: 'right' }}>Avg / break</th>
                <th style={{ textAlign: 'right' }}>Avg / case</th>
              </tr>
            </thead>
            <tbody>
              {byProduct.length === 0 && (
                <tr><td colSpan={6} className="muted">No team breaks recorded.</td></tr>
              )}
              {byProduct.map((p, i) => (
                <tr key={`${p.productLabel || p.product || i}`}>
                  <td title={p.product}>{p.productLabel || p.product || '—'}</td>
                  <td className="mono" style={{ textAlign: 'right' }}>{count(p.breaks)}</td>
                  <td className="mono" style={{ textAlign: 'right' }}>{count(p.cases)}</td>
                  <td className="mono" style={{ textAlign: 'right' }}>{money(p.revenue)}</td>
                  <td className="mono" style={{ textAlign: 'right' }}>{money(p.breaks ? p.revenue / p.breaks : 0)}</td>
                  <td className="mono" style={{ textAlign: 'right' }}>{money(p.cases ? p.revenue / p.cases : 0)}</td>
                </tr>
              ))}
            </tbody>
          </table>

          {/* Every break — sortable columns + a product filter (no cap). */}
          <div className="row-between" style={{ marginTop: 20, alignItems: 'center' }}>
            <div className="section-title" style={{ margin: 0 }}>Breaks ({count(sortedFilteredBreaks.length)})</div>
            <input
              className="input"
              style={{ width: 220 }}
              type="search"
              placeholder="Filter by product…"
              value={breakQuery}
              onChange={(e) => setBreakQuery(e.target.value)}
            />
          </div>
          <table className="grid" style={{ marginTop: 8 }}>
            <thead>
              <tr>
                {[['breakNumber', 'Break #', 'left'], ['productLabel', 'Product', 'left'], ['day', 'Date', 'left'], ['revenue', 'Revenue', 'right'], ['count', 'Sales', 'right']].map(([key, label, align]) => (
                  <th
                    key={key}
                    style={{ textAlign: align, cursor: 'pointer', userSelect: 'none' }}
                    onClick={() => toggleSort(key)}
                    title="Sort"
                  >
                    {label}{sortBreaks.key === key ? (sortBreaks.dir === 'asc' ? ' ▲' : ' ▼') : ''}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sortedFilteredBreaks.length === 0 && (
                <tr><td colSpan={5} className="muted">No breaks match.</td></tr>
              )}
              {sortedFilteredBreaks.map((b, i) => (
                <tr key={`${b.day || ''}-${b.product || ''}-${b.breakNumber ?? i}`}>
                  <td className="mono">#{b.breakNumber}</td>
                  <td title={b.product}>{b.productLabel || b.product || '—'}</td>
                  <td className="mono">{dayLabel(b.day)}</td>
                  <td className="mono" style={{ textAlign: 'right' }}>{money(b.revenue)}</td>
                  <td className="mono" style={{ textAlign: 'right' }}>{count(b.count)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* ===================== PROFIT TAB ===================== */}
      {tab === 'profit' && (
        <ProfitTab
          profit={profit}
          costInputs={costInputs}
          hasProfit={hasProfit}
          busy={busy}
          resetKey={`${filename || ''}|${uploadedAt || ''}`}
          onCommit={async (patch) => {
            setBusy(true)
            setError(null)
            try {
              const result = await api.setLedgerCostInputs(patch)
              if (!aliveRef.current) return
              setData(result)
            } catch (e) {
              if (aliveRef.current) setError(e.message)
            } finally {
              if (aliveRef.current) setBusy(false)
            }
          }}
        />
      )}

      {/* ---- 5. Warnings (collapsible, always last) -------------------------- */}
      {warnings.length > 0 && (
        <details className="banner" style={{ borderRadius: 8, display: 'block' }}>
          <summary style={{ cursor: 'pointer', fontWeight: 600 }}>
            {count(warnings.length)} parse warning{warnings.length === 1 ? '' : 's'}
          </summary>
          <ul className="muted small" style={{ margin: '8px 0 0', paddingLeft: 20 }}>
            {warnings.map((w, i) => <li key={i}>{w}</li>)}
          </ul>
        </details>
      )}
    </div>
  )
}

// =============================================================================
// BreaksPerCaseControl
// -----------------------------------------------------------------------------
// A small numeric input + label. It keeps a local draft string so typing is
// smooth, and only commits (via onCommit) on Enter or blur when the value has
// actually changed and is a valid positive integer. This avoids firing a network
// request on every keystroke. When `value` (the server-confirmed setting)
// changes, the draft is re-synced via the effect below.
// =============================================================================
function BreaksPerCaseControl({ value, busy, onCommit }) {
  const [draft, setDraft] = useState(String(value ?? 1))

  // Re-sync the draft whenever the authoritative server value changes (e.g. a
  // fresh upload or a successful commit returning a normalized number).
  useEffect(() => { setDraft(String(value ?? 1)) }, [value])

  // Commit only a valid, changed, positive integer; otherwise reset the draft.
  const commit = () => {
    const n = parseInt(draft, 10)
    if (Number.isFinite(n) && n >= 1 && n !== Number(value)) {
      onCommit(n)
    } else {
      setDraft(String(value ?? 1)) // revert invalid / unchanged input
    }
  }

  return (
    <div className="row" style={{ gap: 10 }}>
      <span className="muted small nowrap">Breaks per case:</span>
      <input
        className="input"
        type="number"
        min={1}
        step={1}
        value={draft}
        disabled={busy}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }}
        style={{ width: 90 }}
      />
    </div>
  )
}

// =============================================================================
// ProfitTab
// -----------------------------------------------------------------------------
// Left: editable manual cost inputs (giveaway COGS/shipping, supplies, labor +
// an hours log, cancellations override) that persist and recompute the whole
// analysis. Right: a transparent P&L waterfall from Gross sales down to Full
// profit, plus headline profit/margin tiles — everything computed by the backend
// so the numbers always reconcile. Commits are debounced to blur (a field) or
// an explicit hours-log add/remove; the draft re-syncs when the server value
// changes (mirrors BreaksPerCaseControl).
// =============================================================================
function draftFromCostInputs(ci) {
  // Zero and null both render as an empty field (a cost of 0 == "not entered").
  const s = (v) => (v == null || Number(v) === 0 ? '' : String(v))
  const c = ci || {}
  return {
    giveawayCogsPerUnit: s(c.giveawayCogsPerUnit), giveawayCogsTotal: s(c.giveawayCogsTotal),
    giveawayShipPerUnit: s(c.giveawayShipPerUnit), giveawayShipTotal: s(c.giveawayShipTotal),
    suppliesTotal: s(c.suppliesTotal), laborDirect: s(c.laborDirect), laborHourlyRate: s(c.laborHourlyRate),
    cancellationsOverride: s(c.cancellationsOverride),
    hoursLog: Array.isArray(c.hoursLog) ? c.hoursLog.map((h) => ({ id: h.id, date: h.date || '', hours: s(h.hours), note: h.note || '' })) : [],
  }
}

function ProfitTab({ profit, costInputs, hasProfit, busy, onCommit, resetKey }) {
  const [draft, setDraft] = useState(() => draftFromCostInputs(costInputs))
  const idRef = useRef(1)
  // Re-seed the form ONLY when the ledger itself changes (a fresh upload/clear),
  // not on every cost commit — otherwise the server echo would clobber an edit
  // in progress in another field. During editing the local draft is authoritative;
  // the live P&L on the right always reflects the freshly recomputed `profit`.
  useEffect(() => { setDraft(draftFromCostInputs(costInputs)) }, [resetKey]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!hasProfit) {
    return (
      <div className="card">
        <div className="section-title" style={{ margin: 0 }}>Profit</div>
        <div className="muted" style={{ marginTop: 8 }}>
          Profit analysis is available after re-uploading your ledger. Use “Replace CSV” above to enable it.
        </div>
      </div>
    )
  }

  const setField = (k, v) => setDraft((d) => ({ ...d, [k]: v }))
  // Commit one scalar field (blank total → null via the backend normalizer).
  const commitField = (k) => onCommit({ [k]: draft[k] === '' ? null : draft[k] })

  // Hours-log editing. Add/remove commit immediately; per-cell edits commit on blur.
  const commitHours = (log) => onCommit({ hoursLog: log.map((h) => ({ id: h.id, date: h.date, hours: h.hours === '' ? 0 : h.hours, note: h.note })) })
  const addHours = () => {
    const log = [...draft.hoursLog, { id: `h${idRef.current++}_${draft.hoursLog.length}`, date: '', hours: '', note: '' }]
    setDraft((d) => ({ ...d, hoursLog: log }))
    commitHours(log)
  }
  const removeHours = (i) => {
    const log = draft.hoursLog.filter((_, idx) => idx !== i)
    setDraft((d) => ({ ...d, hoursLog: log }))
    commitHours(log)
  }
  const setHoursCell = (i, k, v) => setDraft((d) => {
    const log = d.hoursLog.map((h, idx) => (idx === i ? { ...h, [k]: v } : h))
    return { ...d, hoursLog: log }
  })

  const c = profit.costs || {}
  const inc = profit.income || {}
  const lab = profit.labor || {}
  const hrs = profit.hours || {}

  // A number input bound to draft[key], committing on blur.
  const numInput = (key, placeholder) => (
    <input
      className="input" type="number" min={0} step="0.01" placeholder={placeholder}
      value={draft[key]} disabled={busy}
      onChange={(e) => setField(key, e.target.value)}
      onBlur={() => commitField(key)}
      onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }}
      style={{ width: 110 }}
    />
  )
  // One P&L waterfall row. kind: 'income' (+green) | 'cost' (−red) | 'subtotal' (bold).
  const pnl = (label, value, kind) => {
    const v = Number(value || 0)
    const color = kind === 'income' ? 'var(--good)' : kind === 'cost' ? 'var(--bad)' : undefined
    const text = kind === 'cost' ? `−${money(v)}` : kind === 'income' ? `+${money(v)}` : money(v)
    return (
      <div className="row-between" style={{ padding: '6px 0', borderBottom: kind === 'subtotal' ? '2px solid var(--line)' : '1px solid var(--line)' }}>
        <span className={kind === 'subtotal' ? '' : 'muted small'} style={kind === 'subtotal' ? { fontWeight: 700 } : undefined}>{label}</span>
        <span className="mono small" style={{ color, fontWeight: kind === 'subtotal' ? 700 : undefined }}>{text}</span>
      </div>
    )
  }

  const field = (label, node, hint) => (
    <div className="col" style={{ gap: 4, minWidth: 0 }}>
      <label className="muted small">{label}</label>
      {node}
      {hint && <span className="muted small">{hint}</span>}
    </div>
  )

  const profitColor = (n) => (Number(n) >= 0 ? 'var(--good)' : 'var(--bad)')

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: 16, alignItems: 'start' }}>
      {/* ---------------- LEFT: editable cost inputs ---------------- */}
      <div className="card">
        <div className="section-title" style={{ margin: '0 0 4px' }}>Your costs</div>
        <div className="muted small" style={{ marginBottom: 12 }}>
          Enter the costs the ledger can’t know. Everything recomputes live. Blank uses $0 (or the per-unit rate).
        </div>

        <div className="col" style={{ gap: 14 }}>
          {field('Giveaway COGS — per giveaway',
            <div className="row" style={{ gap: 8, alignItems: 'center' }}>{numInput('giveawayCogsPerUnit', '0.00')}<span className="muted small">× {count(profit.giveawayCount)} giveaways</span></div>,
            'or set a flat total below (overrides the rate)')}
          {field('Giveaway COGS — flat total', numInput('giveawayCogsTotal', 'optional'))}

          {field('Giveaway shipping — per giveaway',
            <div className="row" style={{ gap: 8, alignItems: 'center' }}>{numInput('giveawayShipPerUnit', '0.00')}<span className="muted small">× {count(profit.giveawayCount)} giveaways</span></div>,
            'or a flat total below')}
          {field('Giveaway shipping — flat total', numInput('giveawayShipTotal', 'optional'))}

          {field('Supplies (bags, toploaders, tape…)', numInput('suppliesTotal', '0.00'))}

          {field('Labor — flat amount', numInput('laborDirect', '0.00'))}
          {field('Labor — hourly rate', numInput('laborHourlyRate', '0.00'), `× ${hrs.total || 0} logged hours = ${money(lab.hourlyCost)}`)}

          {/* Hours log */}
          <div className="col" style={{ gap: 6 }}>
            <div className="row-between">
              <label className="muted small">Hours worked</label>
              <button className="btn btn-sm" onClick={addHours} disabled={busy}>+ Add hours</button>
            </div>
            {draft.hoursLog.length === 0 && <span className="muted small">No hours logged yet.</span>}
            {draft.hoursLog.map((h, i) => (
              <div key={h.id || i} className="row" style={{ gap: 6, alignItems: 'center' }}>
                <input className="input" type="date" value={h.date} disabled={busy}
                  onChange={(e) => setHoursCell(i, 'date', e.target.value)} onBlur={() => commitHours(draft.hoursLog)} style={{ width: 140 }} />
                <input className="input" type="number" min={0} step="0.25" placeholder="hrs" value={h.hours} disabled={busy}
                  onChange={(e) => setHoursCell(i, 'hours', e.target.value)} onBlur={() => commitHours(draft.hoursLog)} style={{ width: 70 }} />
                <input className="input" placeholder="note" value={h.note} disabled={busy}
                  onChange={(e) => setHoursCell(i, 'note', e.target.value)} onBlur={() => commitHours(draft.hoursLog)} style={{ flex: 1, minWidth: 60 }} />
                <button className="btn btn-sm btn-danger" onClick={() => removeHours(i)} disabled={busy} aria-label="Remove">✕</button>
              </div>
            ))}
            {hrs.total > 0 && (
              <div className="muted small">
                {hrs.total} hrs · {money(hrs.revenuePerHour)}/hr revenue · {money(hrs.profitPerHour)}/hr profit
              </div>
            )}
          </div>

          {field('Cancellations / refunds (override)', numInput('cancellationsOverride', 'auto'),
            profit.cancellationsDetail && profit.cancellationsDetail.count > 0
              ? `${count(profit.cancellationsDetail.count)} refund row(s) auto-detected (${money(profit.cancellationsDetail.auto)})`
              : 'auto-detected from refund rows (none found in this ledger)')}
        </div>
      </div>

      {/* ---------------- RIGHT: P&L + headline tiles ---------------- */}
      <div className="col" style={{ gap: 16 }}>
        <div className="stat-grid">
          <div className="stat">
            <div className="label">Initial profit</div>
            <div className="value" style={{ color: profitColor(profit.initialProfit) }}>{money(profit.initialProfit)}</div>
          </div>
          <div className="stat">
            <div className="label">Full profit</div>
            <div className="value" style={{ color: profitColor(profit.fullProfit) }}>{money(profit.fullProfit)}</div>
          </div>
          <div className="stat">
            <div className="label">Margin (full)</div>
            <div className="value">{pct(profit.fullMargin)}</div>
          </div>
          <div className="stat">
            <div className="label">Gross / break</div>
            <div className="value">{money(profit.grossSalesPerBreak)}</div>
          </div>
        </div>

        <div className="card">
          <div className="section-title" style={{ margin: '0 0 8px' }}>Profit &amp; loss</div>
          {pnl('Gross sales', inc.grossEarnings, 'income')}
          {Number(c.giveawayCharge) !== 0 && pnl('Giveaways (Whatnot deduction)', c.giveawayCharge, 'cost')}
          {Number(inc.shippingSubsidies) !== 0 && pnl('Shipping subsidies', inc.shippingSubsidies, 'income')}
          {Number(c.shippingCosts) !== 0 && pnl('Shipping costs', c.shippingCosts, 'cost')}
          {Number(c.promotionFees) !== 0 && pnl('Promotion fees (boosts)', c.promotionFees, 'cost')}
          {Number(inc.sellerBonuses) !== 0 && pnl('Seller bonuses', inc.sellerBonuses, 'income')}
          {Number(c.otherFees) !== 0 && pnl('Other fees', c.otherFees, 'cost')}
          {Number(inc.otherAdjustments) !== 0 && pnl('Other adjustments', inc.otherAdjustments, 'income')}
          {pnl('Ledger net', profit.ledgerNet, 'subtotal')}
          {pnl('Giveaway COGS', c.giveawayCogs, 'cost')}
          {pnl('Giveaway shipping', c.giveawayShipping, 'cost')}
          {Number(c.cancellations) !== 0 && pnl('Cancellations', c.cancellations, 'cost')}
          {pnl('Initial profit', profit.initialProfit, 'subtotal')}
          {pnl('Supplies', c.supplies, 'cost')}
          {pnl('Labor', c.labor, 'cost')}
          {pnl('Full profit', profit.fullProfit, 'subtotal')}
          <div className="muted small" style={{ marginTop: 10 }}>
            Initial profit is before supplies &amp; labor; full profit is after. Margins are vs. gross sales.
          </div>
        </div>
      </div>
    </div>
  )
}
