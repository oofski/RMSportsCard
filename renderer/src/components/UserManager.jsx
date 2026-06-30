// =============================================================================
// User Manager (admin only)
// -----------------------------------------------------------------------------
// A modal dialog for administrators to manage application accounts. The caller
// is responsible for only mounting this for admins; it lists every user and lets
// the admin add accounts, change a user's role, reset a password, and delete an
// account.
//
// Business rules surfaced here (the backend is the source of truth and enforces
// them — we simply reflect/guard in the UI and surface any thrown error):
//   • You cannot delete your own account (guarded locally + tooltip).
//   • The last remaining admin cannot be deleted (API enforces; we note it and
//     show the server's error in a banner if the delete is rejected).
//
// All state is local. After every mutation we reload the list from the server so
// the table always reflects authoritative data (timestamps, roles, etc.).
// =============================================================================

import React, { useEffect, useState } from 'react'
import * as api from '../api.js'
import { USER_ROLES } from '../constants.js'

/** The default new-user form shape; role defaults to the first known role. */
const emptyForm = () => ({
  username: '',
  displayName: '',
  password: '',
  role: (USER_ROLES[0] && USER_ROLES[0].code) || '',
})

/** Format an ISO timestamp to a short, local date + time. Returns "—" if empty. */
function fmtDateTime(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—' // guard against malformed values
  return d.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

/** Human label for a role code, falling back to the raw code if unknown. */
const roleLabel = (code) => (USER_ROLES.find((r) => r.code === code) || { label: code }).label

/** Choose a badge color so admins stand out from staff/pickers. */
const roleBadgeClass = (code) => (code === 'admin' ? 'badge green' : 'badge')

export default function UserManager({ me, onClose }) {
  // The authoritative list of users (reloaded after each mutation).
  const [users, setUsers] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  // "Add user" panel: toggle + form fields + in-flight guard.
  const [adding, setAdding] = useState(false)
  const [form, setForm] = useState(emptyForm)
  const [creating, setCreating] = useState(false)

  // Per-row "Reset password" inline editor: the row id being edited and its value.
  const [resetForId, setResetForId] = useState(null)
  const [resetValue, setResetValue] = useState('')

  // A set of user ids that currently have a mutation in flight, so we can
  // disable just that row's controls without freezing the whole table.
  const [busyIds, setBusyIds] = useState(() => new Set())

  const markBusy = (id, on) =>
    setBusyIds((prev) => {
      const next = new Set(prev)
      if (on) next.add(id)
      else next.delete(id)
      return next
    })

  /** Load (or reload) the user list, surfacing any failure in the banner. */
  const reload = async () => {
    try {
      const list = await api.listUsers()
      setUsers(Array.isArray(list) ? list : [])
    } catch (err) {
      setError(err.message || 'Failed to load users')
    }
  }

  // Initial load on mount.
  useEffect(() => {
    let alive = true
    ;(async () => {
      setLoading(true)
      setError(null)
      try {
        const list = await api.listUsers()
        if (alive) setUsers(Array.isArray(list) ? list : [])
      } catch (err) {
        if (alive) setError(err.message || 'Failed to load users')
      } finally {
        if (alive) setLoading(false)
      }
    })()
    return () => {
      alive = false // ignore a late response after unmount
    }
  }, [])

  // ---- Add user ----------------------------------------------------------
  const canSubmitNew =
    form.username.trim().length > 0 && form.password.length >= 4 && !creating

  const submitNew = async (e) => {
    e.preventDefault()
    // Defensive client-side validation (the button is also disabled).
    if (form.username.trim().length === 0) {
      setError('Username is required')
      return
    }
    if (form.password.length < 4) {
      setError('Password must be at least 4 characters')
      return
    }
    setCreating(true)
    setError(null)
    try {
      await api.createUser({
        username: form.username.trim(),
        password: form.password,
        displayName: form.displayName.trim(),
        role: form.role,
      })
      await reload()
      setForm(emptyForm()) // clear the form for the next entry
      setAdding(false)
    } catch (err) {
      setError(err.message || 'Failed to create user')
    } finally {
      setCreating(false)
    }
  }

  // ---- Row: change role --------------------------------------------------
  const changeRole = async (row, role) => {
    if (role === row.role) return // no-op
    setError(null)
    markBusy(row.id, true)
    try {
      await api.updateUser(row.id, { role })
      await reload()
    } catch (err) {
      setError(err.message || 'Failed to update role')
    } finally {
      markBusy(row.id, false)
    }
  }

  // ---- Row: reset password ----------------------------------------------
  const openReset = (row) => {
    setResetForId(row.id)
    setResetValue('')
    setError(null)
  }
  const cancelReset = () => {
    setResetForId(null)
    setResetValue('')
  }
  const saveReset = async (row) => {
    if (resetValue.length < 4) {
      setError('Password must be at least 4 characters')
      return
    }
    setError(null)
    markBusy(row.id, true)
    try {
      await api.updateUser(row.id, { password: resetValue })
      await reload()
      cancelReset()
    } catch (err) {
      setError(err.message || 'Failed to reset password')
    } finally {
      markBusy(row.id, false)
    }
  }

  // ---- Row: delete -------------------------------------------------------
  const removeUser = async (row) => {
    // Never allow deleting your own account from the UI.
    if (row.id === me.id) return
    const ok = window.confirm(
      `Delete user "${row.displayName || row.username}"? This cannot be undone.`,
    )
    if (!ok) return
    setError(null)
    markBusy(row.id, true)
    try {
      await api.deleteUser(row.id)
      await reload()
    } catch (err) {
      // Surfaces e.g. "last admin cannot be deleted" from the backend.
      setError(err.message || 'Failed to delete user')
    } finally {
      markBusy(row.id, false)
    }
  }

  return (
    // Click on the backdrop closes; clicks inside the card are stopped so they
    // don't bubble up and trigger the close handler.
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal card"
        style={{ maxWidth: 760 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="row-between" style={{ marginBottom: 12 }}>
          <h3>Users</h3>
          <button className="btn btn-ghost btn-sm" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        {error && (
          <div className="banner error" style={{ borderRadius: 8, marginBottom: 12 }}>
            {error}
          </div>
        )}

        {/* ---- Add user toggle + panel ------------------------------------ */}
        <div className="row-between" style={{ marginBottom: 12 }}>
          <span className="muted small">The last administrator account cannot be deleted.</span>
          <button
            className="btn btn-sm"
            onClick={() => {
              setError(null)
              setForm(emptyForm())
              setAdding((v) => !v)
            }}
          >
            {adding ? 'Cancel' : 'Add user'}
          </button>
        </div>

        {adding && (
          <form className="panel card" style={{ marginBottom: 16 }} onSubmit={submitNew}>
            <div className="section-title" style={{ marginTop: 0 }}>New user</div>
            <div className="row" style={{ alignItems: 'flex-end', flexWrap: 'wrap' }}>
              <label className="field" style={{ flex: '1 1 150px', marginBottom: 0 }}>
                <span>Username</span>
                <input
                  className="input"
                  value={form.username}
                  autoFocus
                  autoComplete="off"
                  onChange={(e) => setForm({ ...form, username: e.target.value })}
                />
              </label>
              <label className="field" style={{ flex: '1 1 150px', marginBottom: 0 }}>
                <span>Display name</span>
                <input
                  className="input"
                  value={form.displayName}
                  onChange={(e) => setForm({ ...form, displayName: e.target.value })}
                />
              </label>
              <label className="field" style={{ flex: '1 1 150px', marginBottom: 0 }}>
                <span>Password</span>
                <input
                  className="input"
                  type="password"
                  value={form.password}
                  autoComplete="new-password"
                  onChange={(e) => setForm({ ...form, password: e.target.value })}
                />
              </label>
              <label className="field" style={{ flex: '0 1 140px', marginBottom: 0 }}>
                <span>Role</span>
                <select
                  className="select"
                  value={form.role}
                  onChange={(e) => setForm({ ...form, role: e.target.value })}
                >
                  {USER_ROLES.map((r) => (
                    <option key={r.code} value={r.code}>
                      {r.label}
                    </option>
                  ))}
                </select>
              </label>
              <button className="btn btn-primary" type="submit" disabled={!canSubmitNew}>
                {creating ? 'Adding…' : 'Add'}
              </button>
            </div>
            <div className="muted small" style={{ marginTop: 8 }}>
              Password must be at least 4 characters.
            </div>
          </form>
        )}

        {/* ---- User table ------------------------------------------------- */}
        {loading ? (
          <div className="muted" style={{ padding: '12px 0' }}>Loading users…</div>
        ) : users.length === 0 ? (
          <div className="muted" style={{ padding: '12px 0' }}>No users found.</div>
        ) : (
          <table className="grid">
            <thead>
              <tr>
                <th>Display name</th>
                <th>Username</th>
                <th>Role</th>
                <th>Created</th>
                <th>Last login</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {users.map((row) => {
                const isSelf = row.id === me.id
                const rowBusy = busyIds.has(row.id)
                return (
                  <tr key={row.id}>
                    <td>
                      {row.displayName || <span className="muted">—</span>}
                      {isSelf && <span className="muted small"> (you)</span>}
                    </td>
                    <td className="mono">{row.username}</td>
                    <td>
                      <span className={roleBadgeClass(row.role)}>{roleLabel(row.role)}</span>
                    </td>
                    <td className="nowrap muted small">{fmtDateTime(row.createdAt)}</td>
                    <td className="nowrap muted small">{fmtDateTime(row.lastLoginAt)}</td>
                    <td>
                      <div className="col" style={{ gap: 8 }}>
                        {/* Role changer bound to the row's current role. */}
                        <div className="row" style={{ gap: 8 }}>
                          <select
                            className="select"
                            style={{ width: 'auto' }}
                            value={row.role}
                            disabled={rowBusy}
                            onChange={(e) => changeRole(row, e.target.value)}
                          >
                            {USER_ROLES.map((r) => (
                              <option key={r.code} value={r.code}>
                                {r.label}
                              </option>
                            ))}
                          </select>
                          <button
                            className="btn btn-ghost btn-sm"
                            disabled={rowBusy}
                            onClick={() => openReset(row)}
                          >
                            Reset password
                          </button>
                          <button
                            className="btn btn-danger btn-sm"
                            disabled={rowBusy || isSelf}
                            title={isSelf ? 'You cannot delete your own account' : 'Delete user'}
                            onClick={() => removeUser(row)}
                          >
                            Delete
                          </button>
                        </div>

                        {/* Inline reset-password editor, revealed per-row. */}
                        {resetForId === row.id && (
                          <div className="row" style={{ gap: 8 }}>
                            <input
                              className="input"
                              style={{ width: 180 }}
                              type="password"
                              placeholder="New password"
                              value={resetValue}
                              autoFocus
                              autoComplete="new-password"
                              disabled={rowBusy}
                              onChange={(e) => setResetValue(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') saveReset(row)
                                if (e.key === 'Escape') cancelReset()
                              }}
                            />
                            <button
                              className="btn btn-primary btn-sm"
                              disabled={rowBusy || resetValue.length < 4}
                              onClick={() => saveReset(row)}
                            >
                              Save
                            </button>
                            <button
                              className="btn btn-ghost btn-sm"
                              disabled={rowBusy}
                              onClick={cancelReset}
                            >
                              Cancel
                            </button>
                          </div>
                        )}
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}

        <div className="row-between" style={{ marginTop: 16 }}>
          <span className="spacer" />
          <button className="btn" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  )
}
