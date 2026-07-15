// =============================================================================
// Upload / Parse — first-run data import
// -----------------------------------------------------------------------------
// Drives the "get data into the app" flow. The operator drops (or picks) a
// Whatnot order-export PDF; we POST it to the backend (api.uploadPdf), then poll
// the parse job (api.parseStatus) on an interval until it completes or errors.
// On success we fetch the event summary (api.summary) and show a recap with a
// "Continue to app" call-to-action. A "Load demo data" escape hatch lets someone
// try the app end-to-end without a real PDF in hand.
//
// The whole lifecycle is modelled by a single `phase` string so the render is a
// simple switch over states rather than a tangle of booleans:
//   idle      → nothing chosen yet (dropzone + demo button)
//   selected  → a .pdf is chosen, awaiting "Parse This PDF"
//   parsing   → upload done, polling status; progress bar is live
//   complete  → summary fetched; success card + Continue
//   error     → parse job reported errors (or upload threw); banner + retry
// =============================================================================

import React, { useCallback, useEffect, useRef, useState } from 'react'
import * as api from '../api.js'
import { SPORT_OPTIONS, sportLabel } from '../constants.js'
import Logo from './Logo.jsx'

// How often we re-poll the parse job while it is running (milliseconds).
const POLL_INTERVAL_MS = 1500

export default function Upload({ onImported, onCancel }) {
  // --- Core state ----------------------------------------------------------
  const [phase, setPhase] = useState('idle') // see header for the state machine
  const [dragging, setDragging] = useState(false) // dropzone hover highlight
  const [file, setFile] = useState(null) // the chosen File (null until selected)
  const [sport, setSport] = useState('auto') // league picker: auto | nfl | mlb | nba
  const [importName, setImportName] = useState('') // "what we are sorting/shipping" (item 3)
  const [existing, setExisting] = useState(null) // { hasData, eventName } if an event is already loaded (re-import warning)
  const [jobId, setJobId] = useState(null) // parse job id returned by uploadPdf
  const [progress, setProgress] = useState(null) // latest parseStatus payload
  const [summary, setSummary] = useState(null) // event summary once complete
  const [parseErrors, setParseErrors] = useState([]) // [{page,message}] on failure
  const [errorMessage, setErrorMessage] = useState(null) // top-level error text
  const [demoBusy, setDemoBusy] = useState(false) // "Load demo data" in flight

  // Refs that the polling loop / cleanup need without re-subscribing effects.
  const pollRef = useRef(null) // setInterval handle so we can clear it
  const inputRef = useRef(null) // hidden <input type=file> for the picker button
  const mountedRef = useRef(true) // guards setState after unmount

  // Stop any running poll. Safe to call repeatedly.
  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current)
      pollRef.current = null
    }
  }, [])

  // Clear the interval and mark unmounted so async callbacks bail out quietly.
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      stopPolling()
    }
  }, [stopPolling])

  // Is an event already loaded? If so this is a RE-IMPORT — warn that it replaces
  // the current event (packing/shipping progress is carried forward for matching
  // customers, but a different event starts fresh) and offer a way back.
  useEffect(() => {
    ;(async () => {
      try {
        const s = await api.getSettings()
        if (mountedRef.current && s && s.hasData) setExisting({ hasData: true, eventName: s.eventName || null })
      } catch { /* ignore — treat as first run */ }
    })()
  }, [])

  // --- File selection ------------------------------------------------------
  // Accept exactly one .pdf. Anything else surfaces a friendly inline message
  // and leaves us in the idle phase so the operator can try again.
  const chooseFile = useCallback((picked) => {
    if (!picked) return
    const isPdf =
      picked.type === 'application/pdf' || /\.pdf$/i.test(picked.name || '')
    if (!isPdf) {
      setErrorMessage('That file is not a PDF. Please choose a Whatnot order PDF (ending in .pdf).')
      return
    }
    setFile(picked)
    setErrorMessage(null)
    setParseErrors([])
    setPhase('selected')
  }, [])

  // Native file picker handlers (button → hidden input).
  const openPicker = () => inputRef.current && inputRef.current.click()
  const onInputChange = (e) => {
    const picked = e.target.files && e.target.files[0]
    chooseFile(picked)
    // Reset the input value so picking the same file again still fires onChange.
    e.target.value = ''
  }

  // Drag-and-drop handlers. We toggle `.drag` for the highlighted border and
  // preventDefault so the browser does not navigate to the dropped file.
  const onDragOver = (e) => {
    e.preventDefault()
    setDragging(true)
  }
  const onDragLeave = (e) => {
    e.preventDefault()
    setDragging(false)
  }
  const onDrop = (e) => {
    e.preventDefault()
    setDragging(false)
    const picked = e.dataTransfer.files && e.dataTransfer.files[0]
    chooseFile(picked)
  }

  // --- Parse flow ----------------------------------------------------------
  // Upload the chosen PDF, then poll the job until it resolves. We translate the
  // backend's "no selectable text" failure into plain language because it is the
  // single most common real-world snag (a scanned / image-only PDF).
  const startParse = useCallback(async () => {
    if (!file) return
    setPhase('parsing')
    setProgress(null)
    setParseErrors([])
    setErrorMessage(null)

    try {
      const { jobId: id } = await api.uploadPdf(file, sport, importName)
      if (!mountedRef.current) return
      setJobId(id)

      // Poll on an interval. Each tick re-reads status; on a terminal status we
      // clear the interval and move to the matching phase.
      const tick = async () => {
        try {
          const status = await api.parseStatus(id)
          if (!mountedRef.current) return
          setProgress(status)

          if (status.status === 'complete') {
            stopPolling()
            // Pull the rolled-up event summary to render the recap card.
            const sum = await api.summary()
            if (!mountedRef.current) return
            setSummary(sum)
            setPhase('complete')
          } else if (status.status === 'error') {
            stopPolling()
            setParseErrors(Array.isArray(status.errors) ? status.errors : [])
            setPhase('error')
          }
        } catch (err) {
          // A failed status read is treated as a hard error so we never spin
          // forever against a dead job.
          stopPolling()
          if (!mountedRef.current) return
          setErrorMessage(friendlyError(err))
          setPhase('error')
        }
      }

      // Kick once immediately for snappy feedback, then on the interval.
      stopPolling()
      pollRef.current = setInterval(tick, POLL_INTERVAL_MS)
      tick()
    } catch (err) {
      // Upload itself failed (bad PDF, network, etc.).
      if (!mountedRef.current) return
      setErrorMessage(friendlyError(err))
      setPhase('error')
    }
  }, [file, sport, importName, stopPolling])

  // Reset everything back to the start so the operator can pick another file.
  const retry = () => {
    stopPolling()
    setPhase('idle')
    setFile(null)
    setJobId(null)
    setProgress(null)
    setSummary(null)
    setParseErrors([])
    setErrorMessage(null)
  }

  // --- Demo data -----------------------------------------------------------
  // Seeds a realistic sample event so the rest of the app can be explored
  // without a real Whatnot PDF, then hands off via onImported().
  const loadDemo = async () => {
    setDemoBusy(true)
    setErrorMessage(null)
    try {
      await api.loadDemo()
      if (!mountedRef.current) return
      onImported()
    } catch (err) {
      if (!mountedRef.current) return
      setErrorMessage(friendlyError(err))
    } finally {
      if (mountedRef.current) setDemoBusy(false)
    }
  }

  // --- Derived progress numbers -------------------------------------------
  const pagesDone = (progress && progress.pagesProcessed) || 0
  const pagesTotal = (progress && progress.totalPages) || 0
  const pct = pagesTotal > 0 ? Math.round((pagesDone / pagesTotal) * 100) : 0
  const customersFound = (progress && progress.customersFound) || 0
  const breaksFound = (progress && progress.breaksFound) || 0

  return (
    <div className="center-screen">
      <div className="card" style={{ width: 560 }}>
        <div style={{ marginBottom: 4 }}>
          <Logo withWordmark size={120} />
        </div>
        <div className="muted small" style={{ marginBottom: 18 }}>
          Import a Whatnot order PDF to set up this event.
        </div>

        {/* ---- IDLE / SELECTED: dropzone + picker ------------------------- */}
        {(phase === 'idle' || phase === 'selected') && (
          <>
            {/* Re-import warning (bug fix): an event is already loaded, so parsing
                a new PDF replaces it. Progress is carried forward for matching
                customers; a genuinely different event starts fresh. */}
            {existing && existing.hasData && (
              <div
                className="banner"
                style={{ background: 'color-mix(in srgb, var(--warn) 14%, var(--bg-2))', border: '1px solid color-mix(in srgb, var(--warn) 40%, transparent)', borderRadius: 8, marginBottom: 12 }}
              >
                <div className="col" style={{ gap: 2 }}>
                  <strong>Replace the current event{existing.eventName ? ` — “${existing.eventName}”` : ''}?</strong>
                  <span className="small muted">
                    Importing loads a new event in its place. Packing &amp; shipping progress is kept for customers that still match; anything not in the new file is cleared. Use “Back to app” below if you didn’t mean to.
                  </span>
                </div>
              </div>
            )}
            <div
              className={`dropzone${dragging ? ' drag' : ''}`}
              onDragOver={onDragOver}
              onDragEnter={onDragOver}
              onDragLeave={onDragLeave}
              onDrop={onDrop}
            >
              {file ? (
                <div className="col" style={{ alignItems: 'center', gap: 6 }}>
                  <div className="mono nowrap">{file.name}</div>
                  <div className="muted small">Ready to parse</div>
                </div>
              ) : (
                <div className="col" style={{ alignItems: 'center', gap: 6 }}>
                  <div>Drag &amp; drop your order PDF here</div>
                  <div className="muted small">or use the button below — .pdf only</div>
                </div>
              )}
            </div>

            {/* Hidden native input, driven by the visible button. */}
            <input
              ref={inputRef}
              type="file"
              accept=".pdf"
              className="hidden"
              onChange={onInputChange}
            />

            {/* Sport picker — same PDF flow, different league. "Auto-detect"
                lets the parser infer NFL vs MLB from the team names. */}
            <div className="col" style={{ gap: 6, marginTop: 14 }}>
              <div className="muted small">Sport / league</div>
              <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                {SPORT_OPTIONS.map((opt) => (
                  <button
                    key={opt.code}
                    type="button"
                    className={`btn btn-sm${sport === opt.code ? ' btn-primary' : ''}`}
                    aria-pressed={sport === opt.code}
                    onClick={() => setSport(opt.code)}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Name this import — free-text label for History › Import log (item 3). */}
            <div className="col" style={{ gap: 6, marginTop: 14 }}>
              <div className="muted small">Name this import (optional)</div>
              <input
                type="text"
                className="input"
                placeholder="e.g. NFL Mega Break — June 27"
                value={importName}
                onChange={(e) => setImportName(e.target.value)}
              />
              <div className="muted small">A label for what you’re sorting &amp; shipping. Shows in History › Import log.</div>
            </div>

            <div className="row" style={{ marginTop: 14 }}>
              {existing && existing.hasData && onCancel && (
                <button className="btn btn-ghost" onClick={onCancel}>← Back to app</button>
              )}
              <button className="btn" onClick={openPicker}>
                {file ? 'Choose a different PDF' : 'Choose PDF…'}
              </button>
              {phase === 'selected' && (
                <button className="btn btn-primary" onClick={startParse}>
                  Parse This PDF
                </button>
              )}
            </div>
          </>
        )}

        {/* ---- PARSING: live progress ------------------------------------ */}
        {phase === 'parsing' && (
          <div className="col">
            <div className="row-between">
              <span className="section-title" style={{ margin: 0 }}>Parsing…</span>
              <span className="mono small muted">
                {pagesDone}/{pagesTotal || '?'} pages · {pct}%
              </span>
            </div>
            <div className="bar">
              <span style={{ width: `${pct}%` }} />
            </div>
            <div className="muted small">
              {customersFound} customers · {breaksFound} breaks found so far
            </div>
          </div>
        )}

        {/* ---- COMPLETE: success recap ----------------------------------- */}
        {phase === 'complete' && summary && (
          <div className="col">
            <div className="section-title" style={{ margin: 0, color: 'var(--good)' }}>
              Parse complete — {summary.event.name} · {summary.event.date}
            </div>
            {summary.sport && (
              <div className="row">
                <span className="badge">{sportLabel(summary.sport)}</span>
                {sport === 'auto' && (
                  <span className="muted small">detected automatically</span>
                )}
              </div>
            )}
            <div className="row" style={{ flexWrap: 'wrap' }}>
              <span className="mono">
                {summary.customers} customers · {summary.breaks} breaks ·{' '}
                {summary.totalOrders} orders · ${summary.totalRevenue} revenue
              </span>
            </div>
            <div className="row">
              <span className={`badge${summary.warnings > 0 ? ' amber' : ''}`}>
                {summary.warnings} parse warnings
              </span>
            </div>
            <div className="row" style={{ marginTop: 6 }}>
              <button className="btn btn-primary btn-lg" onClick={onImported}>
                Continue to app
              </button>
            </div>
          </div>
        )}

        {/* ---- ERROR: per-page messages + retry -------------------------- */}
        {phase === 'error' && (
          <div className="col">
            <div className="banner error" style={{ borderRadius: 8 }}>
              <div className="col" style={{ gap: 4 }}>
                <strong>Could not parse this PDF</strong>
                {errorMessage && <span className="small">{errorMessage}</span>}
                {parseErrors.map((e, i) => (
                  <span key={i} className="small">
                    {e.page != null ? `Page ${e.page}: ` : ''}
                    {e.message}
                  </span>
                ))}
              </div>
            </div>
            <div className="row">
              <button className="btn btn-primary" onClick={retry}>
                Try another PDF
              </button>
            </div>
          </div>
        )}

        {/* ---- Inline (non-fatal) message for idle/selected mistakes ------ */}
        {errorMessage && (phase === 'idle' || phase === 'selected') && (
          <div className="banner error" style={{ borderRadius: 8, marginTop: 12 }}>
            {errorMessage}
          </div>
        )}

        {/* ---- Demo data escape hatch ------------------------------------ */}
        {phase !== 'parsing' && phase !== 'complete' && (
          <>
            <div className="section-title">No PDF handy?</div>
            <button className="btn btn-ghost" onClick={loadDemo} disabled={demoBusy}>
              {demoBusy ? 'Loading demo…' : 'Load demo data'}
            </button>
            <div className="muted small" style={{ marginTop: 6 }}>
              Loads a realistic sample event (customers, breaks and orders) so you
              can try the app without a real Whatnot PDF.
            </div>
          </>
        )}
      </div>
    </div>
  )
}

// ---- Helpers ---------------------------------------------------------------
// Turn raw backend/error text into something an operator can act on. The
// scanned-PDF case is special-cased because it is both common and confusing.
function friendlyError(err) {
  const msg = (err && err.message) || 'Something went wrong while parsing.'
  if (/does not appear to contain selectable text/i.test(msg)) {
    return (
      'This PDF has no selectable text — it looks like a scan or image. ' +
      'Re-export the order list from Whatnot as a text PDF (not a screenshot) and try again.'
    )
  }
  return msg
}
