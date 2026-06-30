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

export default function Login({ needsBootstrap, onAuthenticated }) {
  const [username, setUsername] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

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

  return (
    <div className="center-screen">
      <form className="card" style={{ width: 380 }} onSubmit={submit}>
        <div className="brand" style={{ fontSize: 22, marginBottom: 4 }}>
          RM<span className="dot"> ●</span> Cardz
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
      </form>
    </div>
  )
}
