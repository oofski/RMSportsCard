// =============================================================================
// RM Cardz — Electron main process
// -----------------------------------------------------------------------------
// Responsibilities:
//   1. Boot the embedded Express backend on an ephemeral localhost port.
//   2. Create the application window and load the React renderer
//      (Vite dev server in development, bundled file:// build in production).
//   3. Bridge privileged operations the renderer cannot do itself:
//        - open USPS tracking URLs in the user's default browser
//        - report the app version
//        - drive the auto-update lifecycle
//
// The whole app is self-contained: no external services, no separate server
// process. Everything runs inside this single packaged .exe.
// =============================================================================

const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron')
const path = require('node:path')
const { startServer } = require('../server/index.cjs')
const { initAutoUpdate, checkForUpdatesManually, quitAndInstall } = require('./updater.cjs')
const { refreshTracking } = require('./tracking.cjs')

// True when launched via `npm run dev` (renderer served by Vite on :5173).
const isDev = process.env.RMCARDZ_DEV === '1'

/** @type {BrowserWindow | null} */
let mainWindow = null
/** Handle to the running backend so we can close it cleanly on quit. */
let backend = null

/**
 * Create the main browser window and load the renderer.
 * @param {string} apiBase - Base URL of the embedded backend, e.g. http://127.0.0.1:51234
 */
function createWindow(apiBase) {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1024,
    minHeight: 680,
    title: 'RM Cardz — Break Manager',
    backgroundColor: '#0f172a',
    show: false, // revealed on ready-to-show to avoid a white flash
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true, // renderer cannot touch Node directly
      nodeIntegration: false,
      // The renderer learns the backend URL from this launch argument
      // (read in preload.cjs). This keeps the port out of global scope.
      additionalArguments: [`--rmcardz-api=${apiBase}`],
    },
  })

  mainWindow.once('ready-to-show', () => mainWindow.show())

  if (isDev) {
    mainWindow.loadURL('http://localhost:5173')
    mainWindow.webContents.openDevTools({ mode: 'detach' })
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'dist', 'index.html'))
  }

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  return mainWindow
}

// -----------------------------------------------------------------------------
// IPC handlers — the only privileged operations the renderer may request.
// -----------------------------------------------------------------------------

// Open an external URL (e.g. USPS tracking) in the OS default browser.
// This is the Electron-correct replacement for window.open() described in the
// spec (§7.4) — it reliably hits the user's default Windows browser.
ipcMain.handle('open-external', async (_event, url) => {
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
    throw new Error('Refusing to open non-http(s) URL')
  }
  await shell.openExternal(url)
  return true
})

// Open many URLs in sequence with a small delay so the browser doesn't throttle
// the burst of tabs (spec §7.4 — "Open All in USPS").
ipcMain.handle('open-external-batch', async (_event, urls) => {
  if (!Array.isArray(urls)) throw new Error('Expected an array of URLs')
  for (const url of urls) {
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) {
      await shell.openExternal(url)
      await new Promise((r) => setTimeout(r, 500)) // 500ms between tabs
    }
  }
  return urls.length
})

ipcMain.handle('app-version', () => app.getVersion())

// Auto-update controls invoked from the renderer's update banner.
ipcMain.handle('updates:check', () => checkForUpdatesManually())
ipcMain.handle('updates:install', () => quitAndInstall())

// Automatic USPS status refresh: scrape every shipment's tracking page in a
// hidden window and write back any changed statuses (setBy='auto'). Progress is
// streamed to the renderer so it can show a "12 / 112" indicator.
ipcMain.handle('tracking:refresh', async () => {
  if (!backend || !backend.db) return { error: 'Backend not ready', updated: 0, scanned: 0 }
  const shipments = backend.db.listShipments()
  const map = await refreshTracking({
    shipments,
    onProgress: (p) => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('tracking-progress', p)
    },
  })
  const result = backend.db.bulkSetShipmentStatusByTracking(map, { by: 'auto' })
  return { ...result, scanned: shipments.length }
})

// -----------------------------------------------------------------------------
// App lifecycle
// -----------------------------------------------------------------------------

app.whenReady().then(async () => {
  // Persist the datastore under the OS-standard userData directory so it
  // survives app updates and reinstalls (e.g. %APPDATA%/RM Cardz on Windows).
  const dataDir = process.env.RMCARDZ_DATA_DIR || path.join(app.getPath('userData'), 'data')

  // Boot the backend first so the renderer always has an API to talk to.
  backend = await startServer({ port: 0, dataDir })
  const apiBase = backend.url

  createWindow(apiBase)

  // Auto-update only makes sense for an installed/packaged build.
  if (!isDev && app.isPackaged) {
    initAutoUpdate(() => mainWindow)
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow(apiBase)
  })
}).catch((err) => {
  // If the backend fails to start there is nothing useful the app can do.
  dialog.showErrorBox('RM Cardz failed to start', String(err && err.stack ? err.stack : err))
  app.quit()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('quit', () => {
  if (backend && backend.close) backend.close()
})
