// =============================================================================
// RM Cardz — Auto-update
// -----------------------------------------------------------------------------
// Thin wrapper around electron-updater. On launch (packaged builds only) the app
// checks the configured generic feed (see electron-builder.yml -> publish, which
// serves dist/latest.yml over the GitHub "raw" CDN) for a newer version,
// downloads it in the background, and surfaces lifecycle events to the renderer
// so the UI can show an "Update available / Restart to install" banner. The user
// stays in control: nothing installs until they click.
//
// The launch check is not enough on its own: this app is typically left open all
// day, and a launch-only check would never fire again — so a release published
// while the app is running would go unnoticed until the next full restart. We
// therefore ALSO re-check on a background interval (RECHECK_MS). Periodic checks
// are silent on failure (offline, transient CDN error) so the user is never
// nagged by an error banner for a check they didn't ask for.
// =============================================================================

const { autoUpdater } = require('electron-updater')

// How often to re-check the feed while the app stays open (ms).
const RECHECK_MS = 4 * 60 * 60 * 1000 // 4 hours

let getWindow = () => null
let initialised = false
let recheckTimer = null

/** Push an update-status event to the renderer if a window exists. */
function emit(status, info) {
  const win = getWindow()
  if (win && !win.isDestroyed()) {
    win.webContents.send('update-status', { status, info: info || null })
  }
}

/**
 * Wire up electron-updater and kick off the first background check.
 * @param {() => import('electron').BrowserWindow | null} windowGetter
 */
function initAutoUpdate(windowGetter) {
  getWindow = windowGetter
  if (initialised) return
  initialised = true

  // We download automatically but never install without explicit user consent,
  // so an update can never interrupt an in-progress pick/pack session.
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('checking-for-update', () => emit('checking'))
  autoUpdater.on('update-available', (info) => emit('available', info))
  autoUpdater.on('update-not-available', (info) => emit('not-available', info))
  autoUpdater.on('download-progress', (p) => emit('download-progress', p))
  autoUpdater.on('update-downloaded', (info) => emit('downloaded', info))
  autoUpdater.on('error', (err) => emit('error', { message: String(err && err.message ? err.message : err) }))

  // Initial check on startup (surfaces an error banner if it fails, once).
  autoUpdater.checkForUpdates().catch((err) => emit('error', { message: String(err) }))

  // Keep checking while the app stays open so a release published mid-session is
  // still picked up without a manual restart. Silent on failure (no nag banner).
  if (!recheckTimer) {
    recheckTimer = setInterval(() => {
      autoUpdater.checkForUpdates().catch(() => {})
    }, RECHECK_MS)
    // Don't let the timer keep the process alive on its own.
    if (recheckTimer.unref) recheckTimer.unref()
  }
}

/** Manual "Check for updates" trigger from the UI. */
function checkForUpdatesManually() {
  return autoUpdater.checkForUpdates().catch((err) => {
    emit('error', { message: String(err) })
    return null
  })
}

/** Quit and install a previously-downloaded update. */
function quitAndInstall() {
  // isSilent=false, isForceRunAfter=true -> reopen RM Cardz after updating.
  autoUpdater.quitAndInstall(false, true)
}

module.exports = { initAutoUpdate, checkForUpdatesManually, quitAndInstall }
