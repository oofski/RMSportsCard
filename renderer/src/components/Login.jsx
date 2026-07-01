// =============================================================================
// Login / first-run account creation
// -----------------------------------------------------------------------------
// When the database has no users yet (needsBootstrap), this screen creates the
// first account, which the backend forces to the `admin` role, then signs in.
// Otherwise it is a normal username/password login. Additional accounts are
// created later by an admin via the User Manager.
// =============================================================================

import React, { useState } from 'react'
import * as api from '../api.js'
import { setToken } from '../api.js'
import Logo from './Logo.jsx'

export default function Login({ needsBootstrap, onAuthenticated, onNeedsBootstrap }) {
  const [username, setUsername] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  // Two-step "Reset admin" recovery: false = hidden, true = showing the
  // destructive confirm panel. Reset whenever we leave sign-in mode.
  const [confirming, setConfirming] = useState(false)

  const submit = async (e) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      if (needsBootstrap) {
        // Create the first admin account, then immediately sign in with it.
        await api.register({ username, password, displayName })
      }
      const { token, user } = await api.login({ username, password })
      setToken(token)
      onAuthenticated(user)
    } catch (err) {
      setError(err.message || 'Something went wrong')
    } finally {
      setBusy(false)
    }
  }

  // Destructive recovery: wipe every account and return the app to first-run
  // "create the admin account" mode. Clears the form + error and asks App to
  // flip needsBootstrap so this screen re-renders as bootstrap.
  const doReset = async () => {
    setBusy(true)
    setError(null)
    try {
      await api.resetAdmin()
      setUsername('')
      setPassword('')
      setDisplayName('')
      setError(null)
      setConfirming(false)
      if (onNeedsBootstrap) onNeedsBootstrap()
    } catch (err) {
      setError(err.message || 'Could not reset admin')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="center-screen">
      <form className="card" style={{ width: 380 }} onSubmit={submit}>
        <div style={{ marginBottom: 4 }}>
          <Logo withWordmark size={140} />
        </div>
        <div className="muted small" style={{ marginBottom: 18 }}>
          Break Manager &amp; Shipping Tracker
        </div>

        <h3>{needsBootstrap ? 'Create the admin account' : 'Sign in'}</h3>
        {needsBootstrap && (
          <p className="muted small">No accounts exist yet. The first account you create is the administrator.</p>
        )}

        <label className="field">
          <span>Username</span>
          <input className="input" value={username} autoFocus
            onChange={(e) => setUsername(e.target.value)} autoComplete="username" />
        </label>

        {needsBootstrap && (
          <label className="field">
            <span>Display name (optional)</span>
            <input className="input" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
          </label>
        )}

        <label className="field">
          <span>Password</span>
          <input className="input" type="password" value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete={needsBootstrap ? 'new-password' : 'current-password'} />
        </label>

        {error && <div className="banner error" style={{ borderRadius: 8, marginBottom: 12 }}>{error}</div>}

        <button className="btn btn-primary btn-lg" style={{ width: '100%' }} disabled={busy || !username || !password}>
          {busy ? 'Please wait…' : needsBootstrap ? 'Create admin & sign in' : 'Sign in'}
        </button>

        {/* Reset-admin recovery — sign-in mode only. Two-step confirm because it
            wipes ALL accounts and returns the app to first-run setup. */}
        {!needsBootstrap && !confirming && (
          <div style={{ marginTop: 14, textAlign: 'center' }}>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              disabled={busy}
              onClick={() => { setError(null); setConfirming(true) }}
            >
              Forgot password? Reset admin
            </button>
          </div>
        )}

        {!needsBootstrap && confirming && (
          <div className="banner error" style={{ borderRadius: 8, marginTop: 14, display: 'block' }}>
            <div style={{ fontWeight: 700, marginBottom: 6 }}>Reset admin?</div>
            <div className="small" style={{ marginBottom: 10 }}>
              This deletes ALL accounts and returns the app to first-run setup. This
              cannot be undone. Your imported event data is not affected.
            </div>
            <div className="row" style={{ gap: 8 }}>
              <button
                type="button"
                className="btn btn-sm"
                disabled={busy}
                onClick={() => setConfirming(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-sm btn-danger"
                disabled={busy}
                onClick={doReset}
              >
                {busy ? 'Resetting…' : 'Yes, reset'}
              </button>
            </div>
          </div>
        )}
      </form>
    </div>
  )
}
