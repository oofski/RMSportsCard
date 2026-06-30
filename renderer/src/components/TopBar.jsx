// =============================================================================
// Top application bar — brand, module tabs, and account actions.
// `tab` is null on the upload/data-gate screen (tabs hidden there).
// =============================================================================

import React from 'react'

export default function TopBar({ user, appVersion, tab, onTab, onLogout, onOpenSettings, onOpenUsers, onUploadNew, theme, onToggleTheme }) {
  const TABS = [
    { key: 'planner', label: '📋 Planner' },
    { key: 'checker', label: '✅ Checker' },
    { key: 'shipping', label: '🚚 Shipping Tracker' },
    { key: 'whatnot', label: '🧾 Whatnot Orders' },
    { key: 'sales', label: '💰 Sales Dashboard' },
    { key: 'overview', label: '📊 Overview' },
  ]
  return (
    <div className="topbar">
      <div className="brand">RM<span className="dot"> ●</span> Cardz</div>

      {tab !== null && (
        <div className="tabs">
          {TABS.map((t) => (
            <button key={t.key} className={`tab ${tab === t.key ? 'active' : ''}`} onClick={() => onTab(t.key)}>
              {t.label}
            </button>
          ))}
        </div>
      )}

      <div className="spacer" />

      {onUploadNew && (
        <button className="btn btn-sm" onClick={onUploadNew} title="Import a different Whatnot PDF">⬆ Upload New PDF</button>
      )}
      {onToggleTheme && (
        <button
          className="btn btn-sm btn-ghost"
          onClick={onToggleTheme}
          title={theme === 'light' ? 'Switch to dark mode' : 'Switch to light mode'}
        >
          {theme === 'light' ? '🌙' : '☀️'}
        </button>
      )}
      <button className="btn btn-sm btn-ghost" onClick={onOpenSettings} title="Settings">⚙️</button>
      {user.role === 'admin' && (
        <button className="btn btn-sm btn-ghost" onClick={onOpenUsers} title="Manage users">👥 Users</button>
      )}

      <div className="row" style={{ gap: 8 }}>
        <span className="small muted">{user.displayName || user.username} · {user.role}</span>
        <button className="btn btn-sm btn-ghost" onClick={onLogout}>Sign out</button>
      </div>
      <span className="small muted nowrap" title="App version">v{appVersion}</span>
    </div>
  )
}
