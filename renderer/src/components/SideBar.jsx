// =============================================================================
// RM Cardz — Left navigation sidebar
// -----------------------------------------------------------------------------
// A vertical, collapsible left rail. The TOP nav is the day-to-day work views
// (Orders / Checker / History). Everything else — the Shipping Tracker and Sales
// Dashboard views, plus Users, the light/dark toggle and Preferences — lives in
// a single hover-to-open "Settings" flyout in the footer, so the rail stays
// short. Collapse state is owned by App (persisted); `tab` is null on the
// pre-import data gate, which hides the work-view nav but keeps Settings.
// =============================================================================

import React from 'react'
import Logo from './Logo.jsx'
import {
  IconBox, IconCheckSquare, IconTruck, IconBarChart, IconClock,
  IconSettings, IconLogOut, IconSun, IconMoon, IconUsers,
} from './Icons.jsx'

// Primary work views — the trimmed top rail. Keys match App.jsx's render switch.
const NAV = [
  { key: 'orders', icon: <IconBox />, label: 'Orders' },
  { key: 'checker', icon: <IconCheckSquare />, label: 'Checker' },
  { key: 'history', icon: <IconClock />, label: 'History' },
]

export default function SideBar({
  user, tab, onTab,
  collapsed, onToggleCollapse,
  appVersion,
  onOpenSettings, onOpenUsers, onLogout,
  theme, onToggleTheme,
}) {
  // The Settings group reads as "active" while you're in one of its sub-views.
  const inSettingsView = tab === 'shipping' || tab === 'sales'

  return (
    <aside className={`sidebar ${collapsed ? 'collapsed' : ''}`}>
      <div className="sidebar-head">
        <span className="brand">
          {collapsed ? <Logo size={28} /> : <Logo withWordmark size={120} />}
        </span>
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
        {/* Settings — hover (or focus) to reveal the sub-tabs flyout. */}
        <div className="nav-group">
          <button
            className={`nav-item ${inSettingsView ? 'active' : ''}`}
            title={collapsed ? 'Settings' : undefined}
            aria-haspopup="true"
          >
            <span className="nav-icon"><IconSettings /></span>
            {!collapsed && <span className="nav-label">Settings</span>}
            {!collapsed && <span className="nav-caret" aria-hidden="true">›</span>}
          </button>

          <div className="nav-submenu" role="menu">
            {tab !== null && (
              <>
                <div className="nav-submenu-title">Views</div>
                <button className={`nav-subitem ${tab === 'shipping' ? 'active' : ''}`} role="menuitem" onClick={() => onTab('shipping')}>
                  <span className="nav-icon"><IconTruck /></span><span className="nav-label">Shipping Tracker</span>
                </button>
                <button className={`nav-subitem ${tab === 'sales' ? 'active' : ''}`} role="menuitem" onClick={() => onTab('sales')}>
                  <span className="nav-icon"><IconBarChart /></span><span className="nav-label">Sales Dashboard</span>
                </button>
                <div className="nav-submenu-sep" />
              </>
            )}
            {user.role === 'admin' && (
              <button className="nav-subitem" role="menuitem" onClick={onOpenUsers}>
                <span className="nav-icon"><IconUsers /></span><span className="nav-label">Users</span>
              </button>
            )}
            <button className="nav-subitem" role="menuitem" onClick={onToggleTheme}>
              <span className="nav-icon">{theme === 'light' ? <IconMoon /> : <IconSun />}</span>
              <span className="nav-label">{theme === 'light' ? 'Dark mode' : 'Light mode'}</span>
            </button>
            <button className="nav-subitem" role="menuitem" onClick={onOpenSettings}>
              <span className="nav-icon"><IconSettings /></span><span className="nav-label">Preferences</span>
            </button>
          </div>
        </div>

        <button className="nav-item" onClick={onLogout} title={collapsed ? 'Sign out' : undefined}>
          <span className="nav-icon"><IconLogOut /></span>
          {!collapsed && <span className="nav-label">Sign out</span>}
        </button>

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
