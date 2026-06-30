// =============================================================================
// Settings modal
// -----------------------------------------------------------------------------
// A lightweight overlay for the two operator-editable settings (event name and
// breaks-per-event) plus read-only context (the imported event date and whether
// any data is loaded). On desktop it also exposes the app version and a
// "Check for updates" button that talks to the Electron main process via the
// preloaded `window.rmcardz` bridge.
//
// Pattern: .modal-backdrop closes on click; the inner .modal.card stops
// propagation so clicks inside it don't dismiss. We load current settings once
// on mount, edit a local copy, and PATCH on Save before telling the parent to
// refresh (onChanged) and closing (onClose).
// =============================================================================

import React, { useEffect, useState } from 'react'
import * as api from '../api.js'

// Backend default when no value has been configured yet (matches a 9-team box).
const DEFAULT_BREAKS_PER_EVENT = 9

export default function SettingsModal({ onClose, onChanged }) {
  // --- Editable + read-only settings state --------------------------------
  const [eventName, setEventName] = useState('')
  const [breaksPerEvent, setBreaksPerEvent] = useState(DEFAULT_BREAKS_PER_EVENT)
  const [eventDate, setEventDate] = useState('') // read-only, from import
  const [hasData, setHasData] = useState(false) // read-only, from import

  // --- USPS auto-tracking provider ----------------------------------------
  const [trackingProvider, setTrackingProvider] = useState('scrape') // 'scrape' | '17track'
  const [trackingApiKey, setTrackingApiKey] = useState('') // only sent if non-empty
  const [trackingKeySet, setTrackingKeySet] = useState(false) // a key is already stored
  const [autoMinutes, setAutoMinutes] = useState(30) // background auto-check cadence (0 = off)

  // --- Lifecycle / status state -------------------------------------------
  const [loading, setLoading] = useState(true) // initial getSettings in flight
  const [saving, setSaving] = useState(false) // updateSettings in flight
  const [error, setError] = useState(null) // any surfaced failure text

  // --- Desktop-only (Electron) extras -------------------------------------
  // `window.rmcardz` only exists inside the Electron shell. In a plain browser
  // these stay falsy and the update controls are simply not rendered.
  const desktop = typeof window !== 'undefined' && !!window.rmcardz
  const [appVersion, setAppVersion] = useState('') // resolved app version string
  const [checkingUpdates, setCheckingUpdates] = useState(false)

  // Load current settings (and, on desktop, the app version) once on mount.
  useEffect(() => {
    let active = true
    ;(async () => {
      try {
        const s = await api.getSettings()
        if (!active) return
        setEventName(s.eventName || '')
        setBreaksPerEvent(
          s.breaksPerEvent != null ? s.breaksPerEvent : DEFAULT_BREAKS_PER_EVENT,
        )
        setEventDate(s.eventDate || '')
        setHasData(!!s.hasData)
        setTrackingProvider(s.trackingProvider || 'scrape')
        setTrackingKeySet(!!s.trackingKeySet)
        setAutoMinutes(s.trackingAutoRefreshMinutes != null ? s.trackingAutoRefreshMinutes : 30)
      } catch (err) {
        if (active) setError(err.message || 'Could not load settings.')
      } finally {
        if (active) setLoading(false)
      }

      // App version is a desktop bridge call that returns a promise.
      if (desktop) {
        try {
          const v = await window.rmcardz.getAppVersion()
          if (active) setAppVersion(v)
        } catch {
          /* version is purely informational — ignore failures */
        }
      }
    })()
    return () => {
      active = false
    }
  }, [desktop])

  // --- Save ----------------------------------------------------------------
  // PATCH the two editable fields, then let the parent re-read and close. We
  // coerce breaksPerEvent to a positive integer so the backend never receives a
  // NaN/blank from an emptied number input.
  const save = async () => {
    setSaving(true)
    setError(null)
    try {
      const count = Number(breaksPerEvent)
      const payload = {
        eventName: eventName.trim(),
        breaksPerEvent: Number.isFinite(count) && count > 0 ? count : DEFAULT_BREAKS_PER_EVENT,
        trackingProvider,
        trackingAutoRefreshMinutes: Number(autoMinutes),
      }
      // Only send the key when the user actually typed one, so leaving the field
      // blank never wipes a previously-saved key.
      if (trackingApiKey.trim()) payload.trackingApiKey = trackingApiKey.trim()
      await api.updateSettings(payload)
      onChanged()
      onClose()
    } catch (err) {
      setError(err.message || 'Could not save settings.')
    } finally {
      setSaving(false)
    }
  }

  // --- Check for updates (desktop only) -----------------------------------
  const checkForUpdates = async () => {
    setCheckingUpdates(true)
    setError(null)
    try {
      await window.rmcardz.checkForUpdates()
    } catch (err) {
      setError(err.message || 'Could not check for updates.')
    } finally {
      setCheckingUpdates(false)
    }
  }

  return (
    // Clicking the dim backdrop closes; clicks inside .modal are stopped below.
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal card" onClick={(e) => e.stopPropagation()}>
        <div className="row-between">
          <h3>Settings</h3>
          <button className="btn btn-ghost btn-sm" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        {/* Any failure (load, save, update check) surfaces here. */}
        {error && (
          <div className="banner error" style={{ borderRadius: 8, margin: '12px 0' }}>
            {error}
          </div>
        )}

        {loading ? (
          <p className="muted small">Loading settings…</p>
        ) : (
          <>
            {/* ---- Editable fields --------------------------------------- */}
            <label className="field">
              <span>Event name</span>
              <input
                className="input"
                value={eventName}
                onChange={(e) => setEventName(e.target.value)}
                placeholder="e.g. Friday Night Football Breaks"
              />
            </label>

            <label className="field">
              <span>Breaks per event</span>
              <input
                className="input"
                type="number"
                min={1}
                value={breaksPerEvent}
                onChange={(e) => setBreaksPerEvent(e.target.value)}
              />
            </label>

            {/* ---- Read-only import context ------------------------------ */}
            <div className="section-title">Imported event</div>
            <div className="row-between small">
              <span className="muted">Event date</span>
              <span className="mono">{eventDate || '—'}</span>
            </div>
            <div className="row-between small" style={{ marginTop: 6 }}>
              <span className="muted">Data loaded</span>
              <span className={`badge${hasData ? ' green' : ' amber'}`}>
                {hasData ? 'yes' : 'no'}
              </span>
            </div>

            {/* ---- USPS auto-tracking provider --------------------------- */}
            <div className="section-title">USPS auto-tracking</div>
            <label className="field">
              <span>Status source</span>
              <select
                className="select"
                value={trackingProvider}
                onChange={(e) => setTrackingProvider(e.target.value)}
              >
                <option value="scrape">Auto-read from USPS (no key, best-effort)</option>
                <option value="17track">17TRACK API (reliable — free key)</option>
              </select>
            </label>
            {trackingProvider === '17track' && (
              <label className="field">
                <span>
                  17TRACK API key{' '}
                  {trackingKeySet && <span className="muted small">(saved — leave blank to keep it)</span>}
                </span>
                <input
                  className="input"
                  type="password"
                  value={trackingApiKey}
                  onChange={(e) => setTrackingApiKey(e.target.value)}
                  placeholder={trackingKeySet ? '•••••••• (saved)' : 'Paste your 17TRACK Access Key'}
                  autoComplete="off"
                />
              </label>
            )}
            <p className="muted small" style={{ marginTop: -4 }}>
              {trackingProvider === '17track'
                ? 'Free key at features.17track.net → Settings → Security → Access Key (free for 100 numbers/month). Reliable structured status — no scraping.'
                : 'Reads each package’s status from the USPS website. Free and keyless, but USPS may block automated checks. If a refresh reads 0 statuses, switch to 17TRACK above.'}
            </p>

            {desktop && (
              <label className="field">
                <span>Auto-check USPS in the background</span>
                <select
                  className="select"
                  value={autoMinutes}
                  onChange={(e) => setAutoMinutes(Number(e.target.value))}
                >
                  <option value={0}>Off (manual refresh only)</option>
                  <option value={15}>Every 15 minutes</option>
                  <option value={30}>Every 30 minutes</option>
                  <option value={60}>Every hour</option>
                  <option value={120}>Every 2 hours</option>
                </select>
              </label>
            )}
            {desktop && (
              <p className="muted small" style={{ marginTop: -4 }}>
                When on, the app re-checks USPS on its own and updates the Shipping board live —
                no need to press refresh. (17TRACK is recommended so background checks aren’t blocked.)
              </p>
            )}

            {/* ---- Desktop: version + update check ----------------------- */}
            {desktop && (
              <>
                <div className="section-title">Application</div>
                <div className="row-between small">
                  <span className="muted">App version</span>
                  <span className="mono">{appVersion || '—'}</span>
                </div>
                <div className="row" style={{ marginTop: 10 }}>
                  <button
                    className="btn btn-ghost btn-sm"
                    onClick={checkForUpdates}
                    disabled={checkingUpdates}
                  >
                    {checkingUpdates ? 'Checking…' : 'Check for updates'}
                  </button>
                </div>
              </>
            )}

            {/* ---- Actions ----------------------------------------------- */}
            <div className="row" style={{ marginTop: 18 }}>
              <button className="btn btn-primary" onClick={save} disabled={saving}>
                {saving ? 'Saving…' : 'Save'}
              </button>
              <button className="btn btn-ghost" onClick={onClose} disabled={saving}>
                Cancel
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
