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
import Logo from './Logo.jsx'
import {
  IconBox, IconCheckSquare, IconTruck, IconBarChart, IconClock,
  IconSettings, IconLogOut, IconSun, IconMoon, IconUsers, IconUpload, IconShield,
} from './Icons.jsx'

// Nav model — split icon/label so the collapsed rail can render icons only.
// Keys must match the render switch in App.jsx.
const NAV = [
  { key: 'orders', icon: <IconBox />, label: 'Orders' },
  { key: 'checker', icon: <IconCheckSquare />, label: 'Checker' },
  { key: 'templates', icon: <IconShield />, label: 'Sleeve Templates' },
  { key: 'shipping', icon: <IconTruck />, label: 'Shipping Tracker' },
  { key: 'sales', icon: <IconBarChart />, label: 'Sales Dashboard' },
  { key: 'history', icon: <IconClock />, label: 'History' },
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
        {onUploadNew && <FootItem icon={<IconUpload />} label="Upload New PDF" onClick={onUploadNew} />}
        <FootItem
          icon={theme === 'light' ? <IconMoon /> : <IconSun />}
          label={theme === 'light' ? 'Dark mode' : 'Light mode'}
          onClick={onToggleTheme}
        />
        <FootItem icon={<IconSettings />} label="Settings" onClick={onOpenSettings} />
        {user.role === 'admin' && <FootItem icon={<IconUsers />} label="Users" onClick={onOpenUsers} />}
        <FootItem icon={<IconLogOut />} label="Sign out" onClick={onLogout} />
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
