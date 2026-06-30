// =============================================================================
// RM Cardz — Automatic USPS status (no API key)
// -----------------------------------------------------------------------------
// USPS has no free tracking API for Whatnot-generated labels (the Mailer ID in
// the barcode belongs to Whatnot, not rm_cardz — see spec §7.1). So instead of
// an API we read the SAME public tracking page the "Open in USPS" button uses,
// but headlessly: each tracking number is loaded in a hidden Electron
// BrowserWindow (a real Chromium that runs the page's JS and passes USPS's bot
// checks far better than a raw HTTP request), and we parse the status text out
// of the rendered DOM and map it to our status codes.
//
// This necessarily runs in the Electron MAIN process (only it can open windows)
// and on the USER'S machine (this build sandbox blocks tools.usps.com). It is
// best-effort: if a page can't be read or matched, that shipment is left
// untouched and the operator can still set it manually.
// =============================================================================

const { BrowserWindow } = require('electron')
const reference = require('../shared/reference.json')
const { mapStatusText } = require('./uspsStatus.cjs')

const BASE = reference.uspsTrackBaseUrl
// A normal desktop-Chrome UA; the default Electron UA advertises "Electron".
const CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Load one tracking page in a hidden window and return its mapped status. */
async function fetchOne(trackingNumber) {
  const win = new BrowserWindow({
    show: false,
    webPreferences: { images: false, offscreen: false, backgroundThrottling: false },
  })
  try {
    win.webContents.setAudioMuted(true)
    const url = BASE + encodeURIComponent(trackingNumber)
    // loadURL rejects on some sub-resource aborts; we don't care — we just want
    // the document. Race against a hard timeout so a hung page can't stall us.
    await Promise.race([
      win.loadURL(url, { userAgent: CHROME_UA }).catch(() => {}),
      sleep(20000),
    ])
    // Give the page's JS a moment to render the status banner.
    await sleep(3500)
    const text = await win.webContents
      .executeJavaScript('document.body ? document.body.innerText : ""', true)
      .catch(() => '')
    return mapStatusText(text)
  } catch (_) {
    return null
  } finally {
    try { win.destroy() } catch (_) { /* ignore */ }
  }
}

/**
 * Refresh statuses for a list of shipments (each { trackingNumber }). Returns a
 * map trackingNumber -> statusCode for the ones we could read. Sequential with a
 * small delay so we never hammer USPS.
 * @param {{ shipments: Array, onProgress?: Function }} opts
 */
async function refreshTracking({ shipments, onProgress } = {}) {
  const map = {}
  const list = (shipments || []).filter((s) => s && s.trackingNumber)
  let done = 0
  for (const sh of list) {
    let code = null
    try { code = await fetchOne(sh.trackingNumber) } catch (_) { code = null }
    if (code) map[sh.trackingNumber] = code
    done += 1
    if (typeof onProgress === 'function') {
      onProgress({ done, total: list.length, trackingNumber: sh.trackingNumber, code })
    }
    await sleep(800)
  }
  return map
}

module.exports = { refreshTracking, mapStatusText }
