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
//   • When a ledger exists we render the dashboard: headline revenue stats, a
//     "Revenue by day" bar chart, a "Per break / per case" section (with a live
//     breaks-per-case control), a "Top breaks" table, an "Unattributed" line,
//     and any backend warnings.
//
// Everything is composed from the existing design-system utility classes
// (.card / .panel / .stat / .stat-grid / .bar / .badge / .table.grid /
// .section-title / .dropzone / .banner). No new CSS is introduced. The render is
// defensive about empty / zero data so it never produces NaN or divides by zero.
//
// Stripe payouts are intentionally ignored by the backend (they are transfers,
// not revenue); giveaways are tracked as losses (negative values).
// =============================================================================

import React, { useEffect, useRef, useState } from 'react'
import * as api from '../../api.js'

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

export default function SalesDashboard({ currentUser }) {
  // ---- Component state ------------------------------------------------------
  // `data` is the /api/ledger analysis payload (or { hasLedger:false }); null
  // means "still loading the initial fetch". `error` is a human-readable banner
  // message. `busy` is true while a CSV is being read + uploaded (disables the
  // dropzone / buttons and shows a spinner-y label).
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  const [dragging, setDragging] = useState(false) // dropzone hover highlight

  // Hidden <input type=file> used by the visible "Choose CSV…" / "Replace CSV"
  // buttons. `alive` guards setState after unmount (tab switched mid-request).
  const inputRef = useRef(null)
  const aliveRef = useRef(true)

  // ---- Initial load ---------------------------------------------------------
  useEffect(() => {
    aliveRef.current = true
    api.getLedger()
      .then((d) => { if (aliveRef.current) setData(d) })
      .catch((e) => { if (aliveRef.current) setError(e.message) })
    return () => { aliveRef.current = false }
  }, [])

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
          <h2>💰 Sales Dashboard</h2>
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
  } = data

  const {
    grossEarnings = 0,
    giveawayLost = 0,   // <= 0 (a loss)
    netRevenue = 0,
    adjustments = 0,
    tips = 0,
    payoutsIgnoredCount = 0,
    earningCount = 0,
  } = totals

  // Per-day chart scaling. We copy the array (perDay is already sorted ascending
  // by day) and find the max net so bar fills scale 0–100%. Guard the divisor so
  // an empty / all-zero list never yields NaN.
  const days = perDay.slice()
  const maxNet = days.reduce((max, d) => Math.max(max, Number(d.net) || 0), 0)

  // Top breaks: sort a copy by revenue desc and cap to the leading 15 rows.
  const TOP_BREAK_LIMIT = 15
  const sortedBreaks = perBreak.slice().sort((a, b) => (Number(b.revenue) || 0) - (Number(a.revenue) || 0))
  const topBreaks = sortedBreaks.slice(0, TOP_BREAK_LIMIT)
  const moreBreaks = Math.max(0, sortedBreaks.length - TOP_BREAK_LIMIT)

  // ---- Per-case rollups + the live "breaks per case" control ----------------
  const {
    breaksPerCase = 1,
    totalBreaks = 0,
    totalCases = 0,
    avgRevenuePerBreak = 0,
    avgRevenuePerCase = 0,
    byProduct = [],
  } = perCase

  return (
    <div className="col" style={{ gap: 18 }}>
      {/* Hidden input drives the "Replace CSV" button on this screen too. */}
      {fileInput}

      {/* ---- Header row ----------------------------------------------------- */}
      <div className="row-between" style={{ alignItems: 'flex-start' }}>
        <div>
          <h2>💰 Sales Dashboard</h2>
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

      {/* Non-fatal error banner (e.g. a failed Replace/Clear) shown in-context. */}
      {error && (
        <div className="banner error" style={{ borderRadius: 8 }}>{error}</div>
      )}

      {/* ---- Headline stats ------------------------------------------------- */}
      <div className="stat-grid">
        <div className="stat">
          <div className="label">Net Revenue</div>
          <div className="value">{money(netRevenue)}</div>
        </div>
        <div className="stat">
          <div className="label">Gross Earnings</div>
          <div className="value">{money(grossEarnings)}</div>
        </div>
        <div className="stat">
          <div className="label">Given Away</div>
          {/* giveawayLost is <= 0; render in red so the loss reads clearly. */}
          <div className="value" style={{ color: 'var(--bad)' }}>{money(giveawayLost)}</div>
        </div>
        <div className="stat">
          <div className="label">Sales</div>
          <div className="value">{count(earningCount)}</div>
        </div>
      </div>

      {/* ---- Excluded-from-revenue summary line ----------------------------- */}
      <div className="muted small">
        Excluded from revenue: Adjustments {money(adjustments)} · Tips {money(tips)} ·
        Payouts ignored ({count(payoutsIgnoredCount)})
      </div>

      {/* ---- Revenue by day ------------------------------------------------- */}
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
            return (
              <div
                key={d.day}
                className="row"
                style={{ padding: '10px 14px', borderBottom: '1px solid var(--line)', gap: 14 }}
              >
                <span className="mono small nowrap" style={{ width: 96 }}>{d.day}</span>
                <div className="bar" style={{ flex: 1 }}>
                  <span style={{ width: pct + '%' }} />
                </div>
                <span className="mono nowrap" style={{ width: 100, textAlign: 'right' }}>{money(net)}</span>
                <span className="muted small nowrap" style={{ width: 56, textAlign: 'right' }}>
                  ({count(d.count)})
                </span>
              </div>
            )
          })}
        </div>
      </div>

      {/* ---- Per break / per case ------------------------------------------- */}
      <div>
        <div className="section-title" style={{ margin: 0 }}>Per Break / Per Case</div>
        <div className="panel" style={{ marginTop: 10, padding: 16 }}>
          {/* Live control: change breaks-per-case to recompute the case rollups.
              The input is uncontrolled-ish — it seeds from breaksPerCase and we
              commit on Enter or blur so we don't fire a request on every keypress. */}
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

          {/* Per-case headline numbers. */}
          <div className="stat-grid" style={{ marginTop: 14 }}>
            <div className="stat">
              <div className="label">Total Breaks</div>
              <div className="value">{count(totalBreaks)}</div>
            </div>
            <div className="stat">
              <div className="label">Total Cases</div>
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

          {/* Per-product breakdown table. */}
          <table className="grid" style={{ marginTop: 14 }}>
            <thead>
              <tr>
                <th>Product</th>
                <th style={{ textAlign: 'right' }}>Breaks</th>
                <th style={{ textAlign: 'right' }}>Cases</th>
                <th style={{ textAlign: 'right' }}>Revenue</th>
              </tr>
            </thead>
            <tbody>
              {byProduct.length === 0 && (
                <tr><td colSpan={4} className="muted">No per-product breaks recorded.</td></tr>
              )}
              {byProduct.map((p, i) => (
                <tr key={p.product || i}>
                  <td>{p.product || '—'}</td>
                  <td className="mono" style={{ textAlign: 'right' }}>{count(p.breaks)}</td>
                  <td className="mono" style={{ textAlign: 'right' }}>{count(p.cases)}</td>
                  <td className="mono" style={{ textAlign: 'right' }}>{money(p.revenue)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* ---- Top breaks ----------------------------------------------------- */}
      <div>
        <div className="section-title" style={{ margin: 0 }}>Top Breaks</div>
        <div className="panel" style={{ marginTop: 10 }}>
          <table className="grid">
            <thead>
              <tr>
                <th>Product</th>
                <th style={{ textAlign: 'right' }}>Break #</th>
                <th style={{ textAlign: 'right' }}>Revenue</th>
                <th style={{ textAlign: 'right' }}>Sales</th>
              </tr>
            </thead>
            <tbody>
              {topBreaks.length === 0 && (
                <tr><td colSpan={4} className="muted">No breaks recorded.</td></tr>
              )}
              {topBreaks.map((b, i) => (
                // Compose a stable key from product + break # (fall back to index).
                <tr key={`${b.product || ''}-${b.breakNumber ?? i}`}>
                  <td>{b.product || '—'}</td>
                  <td className="mono" style={{ textAlign: 'right' }}>
                    {b.breakNumber != null ? `#${b.breakNumber}` : '—'}
                  </td>
                  <td className="mono" style={{ textAlign: 'right' }}>{money(b.revenue)}</td>
                  <td className="mono" style={{ textAlign: 'right' }}>{count(b.count)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {moreBreaks > 0 && (
            <div className="muted small" style={{ padding: '10px 14px' }}>
              + {count(moreBreaks)} more break{moreBreaks === 1 ? '' : 's'} not shown.
            </div>
          )}
        </div>
      </div>

      {/* ---- Unattributed --------------------------------------------------- */}
      <div>
        <div className="section-title" style={{ margin: 0 }}>Unattributed</div>
        <div className="panel" style={{ marginTop: 10, padding: 16 }}>
          <div className="muted small">
            {count(unattributed.count)} sale{Number(unattributed.count) === 1 ? '' : 's'} with no
            break # (sealed boxes / non-break listings): {money(unattributed.revenue)}
          </div>
        </div>
      </div>

      {/* ---- Warnings (collapsible) ----------------------------------------- */}
      {warnings.length > 0 && (
        <details className="banner" style={{ borderRadius: 8, display: 'block' }}>
          <summary style={{ cursor: 'pointer', fontWeight: 700 }}>
            ⚠️ {count(warnings.length)} parse warning{warnings.length === 1 ? '' : 's'}
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
