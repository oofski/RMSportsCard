// =============================================================================
// Auto-update banner
// -----------------------------------------------------------------------------
// Subscribes to update lifecycle events emitted by the Electron main process
// (electron-updater). It is purely informational until an update has fully
// downloaded, at which point it offers a "Restart & Install" button. Nothing
// installs without the user clicking — an update can never interrupt a pick.
// Renders nothing in a plain browser (no window.rmcardz bridge).
// =============================================================================

import React, { useEffect, useState } from 'react'

export default function UpdateBanner() {
  const [state, setState] = useState({ status: 'idle', info: null })

  useEffect(() => {
    if (!window.rmcardz || !window.rmcardz.onUpdateStatus) return
    const unsubscribe = window.rmcardz.onUpdateStatus(setState)
    return unsubscribe
  }, [])

  const { status, info } = state
  if (!window.rmcardz) return null
  if (['idle', 'checking', 'not-available'].includes(status)) return null

  if (status === 'available') {
    return <div className="banner update">A new version{info?.version ? ` (${info.version})` : ''} is available — downloading…</div>
  }
  if (status === 'download-progress') {
    const pct = info && info.percent ? Math.round(info.percent) : 0
    return <div className="banner update">Downloading update… {pct}%</div>
  }
  if (status === 'downloaded') {
    return (
      <div className="banner update">
        Update{info?.version ? ` ${info.version}` : ''} ready.
        <button className="btn btn-sm" style={{ marginLeft: 12 }} onClick={() => window.rmcardz.installUpdate()}>
          Restart &amp; Install
        </button>
      </div>
    )
  }
  if (status === 'error') {
    return <div className="banner error">Update check failed: {info?.message || 'unknown error'}</div>
  }
  return null
}
