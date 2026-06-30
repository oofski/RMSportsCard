// =============================================================================
// RM Cardz — Auto-update
// -----------------------------------------------------------------------------
// Thin wrapper around electron-updater. On launch (packaged builds only) the app
// checks the configured GitHub Releases feed (see electron-builder.yml -> publish)
// for a newer version, downloads it in the background, and surfaces lifecycle
// events to the renderer so the UI can show an "Update available / Restart to
// install" banner. The user stays in control: nothing installs until they click.
// =============================================================================

const { autoUpdater } = require('electron-updater')

let getWindow = () => null
let initialised = false

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

  // Initial silent check shortly after startup.
  autoUpdater.checkForUpdates().catch((err) => emit('error', { message: String(err) }))
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
