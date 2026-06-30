// =============================================================================
// RM Cardz — Preload bridge
// -----------------------------------------------------------------------------
// Runs in an isolated context before the renderer loads. It exposes a small,
// explicitly-allowlisted API on `window.rmcardz` so the React app can reach
// privileged main-process features WITHOUT having raw Node/Electron access
// (contextIsolation is on). Anything not exposed here is unreachable from the UI.
// =============================================================================

const { contextBridge, ipcRenderer } = require('electron')

// The backend base URL is passed as a launch argument from main.cjs, e.g.
//   --rmcardz-api=http://127.0.0.1:51234
const apiArg = process.argv.find((a) => a.startsWith('--rmcardz-api='))
const apiBase = apiArg ? apiArg.split('=')[1] : 'http://127.0.0.1:3000'

contextBridge.exposeInMainWorld('rmcardz', {
  /** Base URL of the embedded backend API. */
  apiBase,

  /** True when running inside the Electron desktop shell (vs. a plain browser). */
  isDesktop: true,

  platform: process.platform,

  /** Open a single external URL (e.g. a USPS tracking page) in the OS browser. */
  openExternal: (url) => ipcRenderer.invoke('open-external', url),

  /** Open a batch of URLs, throttled, for "Open All in USPS". */
  openExternalBatch: (urls) => ipcRenderer.invoke('open-external-batch', urls),

  /** The installed application version (from package.json). */
  getAppVersion: () => ipcRenderer.invoke('app-version'),

  /** Save text content to disk via a native Save dialog. Resolves to
   *  { saved, path } (saved:false if the user cancelled). */
  saveFile: (payload) => ipcRenderer.invoke('file:save', payload),

  // ---- Automatic USPS status -------------------------------------------------
  /** Scrape USPS for every shipment and auto-update statuses. Resolves to
   *  { updated, matched, scanned }. */
  refreshTracking: () => ipcRenderer.invoke('tracking:refresh'),
  /** Subscribe to scrape progress { done, total, trackingNumber, code }.
   *  Returns an unsubscribe function. */
  onTrackingProgress: (callback) => {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('tracking-progress', listener)
    return () => ipcRenderer.removeListener('tracking-progress', listener)
  },

  // ---- Auto-update -------------------------------------------------------
  /** Ask the updater to check the release feed now. */
  checkForUpdates: () => ipcRenderer.invoke('updates:check'),
  /** Quit and install a downloaded update. */
  installUpdate: () => ipcRenderer.invoke('updates:install'),
  /**
   * Subscribe to update lifecycle events. Returns an unsubscribe function.
   * The callback receives { status, info } where status is one of:
   * checking | available | not-available | download-progress | downloaded | error
   */
  onUpdateStatus: (callback) => {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('update-status', listener)
    return () => ipcRenderer.removeListener('update-status', listener)
  },
})
