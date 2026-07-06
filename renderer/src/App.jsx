// =============================================================================
// RM Cardz — Root application component
// -----------------------------------------------------------------------------
// Orchestrates the top-level flow:
//   1. Auth gate      -> first-run "create admin" or login (Login.jsx)
//   2. Data gate      -> if no event is imported, show Upload (Upload.jsx)
//   3. Main app       -> left sidebar nav over the feature views (Orders /
//                        Checker / Shipping / Sales / History), plus the
//                        Settings and User-management modals.
// The auto-update banner (UpdateBanner.jsx) sits above everything on desktop.
// =============================================================================

import React, { useCallback, useEffect, useState } from 'react'
import * as api from './api.js'
import { setToken } from './api.js'

import Login from './components/Login.jsx'
import Logo from './components/Logo.jsx'
import SideBar from './components/SideBar.jsx'
import UpdateBanner from './components/UpdateBanner.jsx'
import Upload from './components/Upload.jsx'
import OrderQueue from './components/orders/OrderQueue.jsx'
import BreakChecklist from './components/checklist/BreakChecklist.jsx'
import SleeveTemplates from './components/templates/SleeveTemplates.jsx'
import ShippingTracker from './components/shipping/ShippingTracker.jsx'
import SalesDashboard from './components/whatnot/SalesDashboard.jsx'
import History from './components/history/History.jsx'
// Archived (kept on disk, no longer linked in the nav): Dashboard (Overview),
// OrderTracking, WhatnotOrders.
import SettingsModal from './components/SettingsModal.jsx'
import UserManager from './components/UserManager.jsx'

export default function App() {
  const [booting, setBooting] = useState(true)
  const [needsBootstrap, setNeedsBootstrap] = useState(false)
  const [user, setUser] = useState(null)
  const [hasData, setHasData] = useState(false)
  const [tab, setTab] = useState('orders') // orders | checker | shipping | sales | history
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [usersOpen, setUsersOpen] = useState(false)
  const [appVersion, setAppVersion] = useState('1.0.0')
  // Theme: persisted light/dark, applied to <html data-theme> for the whole app.
  const [theme, setTheme] = useState(() => localStorage.getItem('rmcardz.theme') || 'dark')
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
    localStorage.setItem('rmcardz.theme', theme)
  }, [theme])
  const toggleTheme = () => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))

  // Sidebar collapse: persisted icon-only rail vs. full nav.
  const [navCollapsed, setNavCollapsed] = useState(() => localStorage.getItem('rmcardz.nav.collapsed') === '1')
  useEffect(() => {
    localStorage.setItem('rmcardz.nav.collapsed', navCollapsed ? '1' : '0')
  }, [navCollapsed])
  const toggleNav = () => setNavCollapsed((v) => !v)

  // Re-read whether an event is imported (drives the data gate).
  const refreshDataState = useCallback(async () => {
    try {
      const s = await api.getSettings()
      setHasData(!!s.hasData)
    } catch {
      setHasData(false)
    }
  }, [])

  // Initial boot: restore session if a token exists, learn bootstrap state.
  useEffect(() => {
    ;(async () => {
      try {
        const status = await api.authStatus()
        setNeedsBootstrap(status.needsBootstrap)
        if (api.getToken()) {
          try {
            const { user: u } = await api.me()
            setUser(u)
            await refreshDataState()
          } catch {
            setToken(null) // stale/expired token
          }
        }
      } catch (err) {
        // Backend unreachable — surface but keep the login screen usable.
        console.error('boot error', err)
      } finally {
        setBooting(false)
      }
      if (window.rmcardz) {
        try { setAppVersion(await window.rmcardz.getAppVersion()) } catch { /* ignore */ }
      }
    })()
  }, [refreshDataState])

  const handleAuthenticated = async (u) => {
    setUser(u)
    setNeedsBootstrap(false)
    await refreshDataState()
  }

  const handleLogout = async () => {
    try { await api.logout() } catch { /* ignore */ }
    setToken(null)
    setUser(null)
    setHasData(false)
  }

  if (booting) {
    return (
      <div className="center-screen">
        <div className="col" style={{ alignItems: 'center', gap: 12 }}>
          <Logo withWordmark size={96} />
          <div className="muted">Loading…</div>
        </div>
      </div>
    )
  }

  // --- Gate 1: authentication ---------------------------------------------
  if (!user) {
    return (
      <>
        <UpdateBanner />
        <Login
          needsBootstrap={needsBootstrap}
          onAuthenticated={handleAuthenticated}
          onNeedsBootstrap={() => setNeedsBootstrap(true)}
        />
      </>
    )
  }

  // --- Gate 2: data (must import an event before using the modules) -------
  if (!hasData) {
    return (
      <div className="app">
        <UpdateBanner />
        <div className="app-shell">
          <SideBar
            user={user}
            appVersion={appVersion}
            tab={null}
            onTab={() => {}}
            collapsed={navCollapsed}
            onToggleCollapse={toggleNav}
            onLogout={handleLogout}
            onOpenSettings={() => setSettingsOpen(true)}
            onOpenUsers={() => setUsersOpen(true)}
            onUploadNew={null}
            theme={theme}
            onToggleTheme={toggleTheme}
          />
          <main className="app-main">
            <div className="container">
              <Upload onImported={refreshDataState} />
            </div>
          </main>
        </div>
        {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} onChanged={refreshDataState} />}
        {usersOpen && <UserManager me={user} onClose={() => setUsersOpen(false)} />}
      </div>
    )
  }

  // --- Gate 3: main two-tab app -------------------------------------------
  return (
    <div className="app">
      <UpdateBanner />
      <div className="app-shell">
        <SideBar
          user={user}
          appVersion={appVersion}
          tab={tab}
          onTab={setTab}
          collapsed={navCollapsed}
          onToggleCollapse={toggleNav}
          onLogout={handleLogout}
          onOpenSettings={() => setSettingsOpen(true)}
          onOpenUsers={() => setUsersOpen(true)}
          onUploadNew={() => setHasData(false)}
          theme={theme}
          onToggleTheme={toggleTheme}
        />
        <main className="app-main">
          <div className="container">
            {tab === 'orders' && <OrderQueue currentUser={user} />}
            {tab === 'checker' && <BreakChecklist currentUser={user} />}
            {tab === 'templates' && <SleeveTemplates />}
            {tab === 'shipping' && <ShippingTracker currentUser={user} />}
            {tab === 'sales' && <SalesDashboard currentUser={user} />}
            {tab === 'history' && <History currentUser={user} />}
          </div>
        </main>
      </div>

      {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} onChanged={refreshDataState} />}
      {usersOpen && <UserManager me={user} onClose={() => setUsersOpen(false)} />}
    </div>
  )
}
