// =============================================================================
// RM Cardz — Left navigation sidebar
// -----------------------------------------------------------------------------
// Replaces the old horizontal top-bar tabs with a vertical, collapsible left
// rail. Expanded it shows icons + labels + account actions; collapsed it shows
// an icon-only rail (labels become hover tooltips). The collapse state is owned
// by App (persisted to localStorage) so the main panel can flex alongside it.
//
// `tab` is null on the data-gate (pre-import) screen — the nav is hidden there
// but the account footer (theme, settings, sign out, version) stays available.
// =============================================================================

import React from 'react'

// Nav model — split icon/label so the collapsed rail can render icons only.
// NOTE: keys must stay stable; Dashboard.onGoTo() navigates by these keys.
const NAV = [
  { key: 'tracking', icon: '📋', label: 'Order Tracking' },
  { key: 'planner', icon: '🗂', label: 'Order Manager' },
  { key: 'checker', icon: '✅', label: 'Checker' },
  { key: 'shipping', icon: '🚚', label: 'Shipping Tracker' },
  { key: 'whatnot', icon: '🧾', label: 'Whatnot Orders' },
  { key: 'sales', icon: '💰', label: 'Sales Dashboard' },
  { key: 'history', icon: '🗄', label: 'History' },
  { key: 'overview', icon: '📊', label: 'Overview' },
]

export default function SideBar({
  user, tab, onTab,
  collapsed, onToggleCollapse,
  appVersion,
  onUploadNew, onOpenSettings, onOpenUsers, onLogout,
  theme, onToggleTheme,
}) {
  // A footer action button (icon always; label only when expanded).
  const FootItem = ({ icon, label, onClick }) => (
    <button className="nav-item" onClick={onClick} title={collapsed ? label : undefined}>
      <span className="nav-icon">{icon}</span>
      {!collapsed && <span className="nav-label">{label}</span>}
    </button>
  )

  return (
    <aside className={`sidebar ${collapsed ? 'collapsed' : ''}`}>
      <div className="sidebar-head">
        {!collapsed && <span className="brand">RM<span className="dot"> ●</span> Cardz</span>}
        <button
          className="sidebar-toggle"
          onClick={onToggleCollapse}
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          {collapsed ? '»' : '«'}
        </button>
      </div>

      {tab !== null && (
        <nav className="sidebar-nav">
          {NAV.map((n) => (
            <button
              key={n.key}
              className={`nav-item ${tab === n.key ? 'active' : ''}`}
              onClick={() => onTab(n.key)}
              title={collapsed ? n.label : undefined}
            >
              <span className="nav-icon">{n.icon}</span>
              {!collapsed && <span className="nav-label">{n.label}</span>}
            </button>
          ))}
        </nav>
      )}

      <div className="sidebar-foot">
        {onUploadNew && <FootItem icon="⬆" label="Upload New PDF" onClick={onUploadNew} />}
        <FootItem
          icon={theme === 'light' ? '🌙' : '☀️'}
          label={theme === 'light' ? 'Dark mode' : 'Light mode'}
          onClick={onToggleTheme}
        />
        <FootItem icon="⚙️" label="Settings" onClick={onOpenSettings} />
        {user.role === 'admin' && <FootItem icon="👥" label="Users" onClick={onOpenUsers} />}
        <FootItem icon="⎋" label="Sign out" onClick={onLogout} />
        {!collapsed && (
          <div className="sidebar-user small muted">
            {user.displayName || user.username} · {user.role}
            <br />v{appVersion}
          </div>
        )}
      </div>
    </aside>
  )
}
