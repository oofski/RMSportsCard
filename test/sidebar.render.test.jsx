// Render smoke test for the restructured sidebar: the top rail is trimmed to
// the work views (Orders / Checker / History), and Shipping Tracker, Sales
// Dashboard, Users and the Light-mode toggle all live in the Settings flyout.
import { describe, it, expect } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import SideBar from '../renderer/src/components/SideBar.jsx'

const noop = () => {}
const baseProps = {
  user: { username: 'owner', displayName: 'Owner', role: 'admin' },
  tab: 'orders',
  onTab: noop,
  collapsed: false,
  onToggleCollapse: noop,
  appVersion: '9.9.9',
  onOpenSettings: noop,
  onOpenUsers: noop,
  onLogout: noop,
  theme: 'dark',
  onToggleTheme: noop,
}

describe('SideBar', () => {
  it('renders the trimmed top rail and the Settings flyout with its sub-tabs', () => {
    const html = renderToStaticMarkup(<SideBar {...baseProps} />)
    // Top work views.
    expect(html).toContain('Orders')
    expect(html).toContain('Checker')
    expect(html).toContain('History')
    // The Settings flyout and everything now nested under it.
    expect(html).toContain('nav-submenu')
    expect(html).toContain('Settings')
    expect(html).toContain('Shipping Tracker')
    expect(html).toContain('Sales Dashboard')
    expect(html).toContain('Users')       // admin
    expect(html).toContain('Light mode')  // theme toggle (dark -> offers Light)
    expect(html).toContain('Preferences')
    expect(html).toContain('Sign out')
    // Upload no longer lives in the sidebar (it moved under Orders).
    expect(html).not.toContain('Upload New PDF')
  })

  it('hides the work-view sub-tabs on the pre-import gate (tab = null) but keeps Settings', () => {
    const html = renderToStaticMarkup(<SideBar {...baseProps} tab={null} />)
    expect(html).not.toContain('Shipping Tracker') // views section hidden pre-import
    expect(html).toContain('Light mode')           // theme still reachable
    expect(html).toContain('Preferences')
  })
})
