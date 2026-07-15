// =============================================================================
// RM Cardz — API client
// -----------------------------------------------------------------------------
// Thin wrapper over fetch() that targets the embedded backend. The base URL is
// injected by the Electron preload (window.rmcardz.apiBase); in a plain browser
// it falls back to the dev default. The session token is persisted to
// localStorage so a renderer reload keeps you signed in.
// =============================================================================

const API_BASE =
  (typeof window !== 'undefined' && window.rmcardz && window.rmcardz.apiBase) ||
  'http://127.0.0.1:3000'

const TOKEN_KEY = 'rmcardz.token'

export const getToken = () => localStorage.getItem(TOKEN_KEY)
export const setToken = (t) => (t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY))

/** Core request helper. Throws an Error (with .status) on non-2xx. */
async function request(path, { method = 'GET', body, isForm } = {}) {
  const headers = {}
  const token = getToken()
  if (token) headers.Authorization = `Bearer ${token}`
  let payload
  if (isForm) {
    payload = body // FormData; let the browser set the multipart boundary
  } else if (body !== undefined) {
    headers['Content-Type'] = 'application/json'
    payload = JSON.stringify(body)
  }
  const res = await fetch(API_BASE + path, { method, headers, body: payload })
  const text = await res.text()
  const data = text ? JSON.parse(text) : null
  if (!res.ok) {
    const err = new Error((data && data.error) || `Request failed (${res.status})`)
    err.status = res.status
    throw err
  }
  return data
}

// ---- Auth & users ---------------------------------------------------------
export const authStatus = () => request('/api/auth/status')
export const register = (payload) => request('/api/auth/register', { method: 'POST', body: payload })
export const login = (payload) => request('/api/auth/login', { method: 'POST', body: payload })
export const logout = () => request('/api/auth/logout', { method: 'POST' })
export const me = () => request('/api/auth/me')
export const listUsers = () => request('/api/users')
export const createUser = (payload) => request('/api/users', { method: 'POST', body: payload })
export const updateUser = (id, payload) => request(`/api/users/${id}`, { method: 'PATCH', body: payload })
export const deleteUser = (id) => request(`/api/users/${id}`, { method: 'DELETE' })
// Destructive recovery: wipe all accounts so the app returns to first-run
// bootstrap (create-admin). Requires an explicit { confirm: true } on the wire;
// the route intentionally has no auth (a locked-out user has no token).
export const resetAdmin = () => request('/api/auth/reset-admin', { method: 'POST', body: { confirm: true } })

// ---- Parse / import -------------------------------------------------------
// sport: 'auto' (detect NFL vs MLB from the PDF), or force 'nfl' / 'mlb'.
export function uploadPdf(file, sport = 'auto', name = '') {
  const form = new FormData()
  form.append('file', file)
  form.append('sport', sport || 'auto')
  if (name) form.append('name', name) // Import history label (item 3)
  return request('/api/parse', { method: 'POST', body: form, isForm: true })
}
export const parseStatus = (jobId) => request(`/api/parse/status/${jobId}`)
export const summary = () => request('/api/summary')
export const loadDemo = () => request('/api/parse/demo', { method: 'POST' })

// ---- Top-sleeve tagging ---------------------------------------------------
// Tag which cards need a toploader/sleeve, per slot or in bulk per break.
// Toggle one slot's top-sleeve tag (reuses the team-slot PATCH endpoint).
export const toggleTeamSlotSleeve = (id, topSleeved) => request(`/api/teamslot/${id}`, { method: 'PATCH', body: { topSleeved } })

// ---- Breaks (Module A) ----------------------------------------------------
export const getBreaks = () => request('/api/breaks')
export const getBreak = (id) => request(`/api/breaks/${id}`)
export const toggleTeamSlot = (id, checkedOff) => request(`/api/teamslot/${id}`, { method: 'PATCH', body: { checkedOff } })
export const packBreak = (id) => request(`/api/breaks/${id}/pack`, { method: 'POST' })
export const clearBreak = (id) => request(`/api/breaks/${id}/clear`, { method: 'POST' })
// Bulk set/clear the top-sleeve tag for every team slot in a break.
export const setBreakTopSleeved = (id, on) => request(`/api/breaks/${id}/sleeve-all`, { method: 'POST', body: { topSleeved: on } })

// ---- Shipments (Module B) -------------------------------------------------
export const getShipments = () => request('/api/shipments')
export const updateShipment = (id, payload) => request(`/api/shipments/${id}`, { method: 'PATCH', body: payload })
export const getBatchUrls = () => request('/api/shipments/batch-urls')
export const getTrackingNumbers = () => request('/api/shipments/tracking-numbers')

// ---- Orders / Fulfillment Queue (Planner view) ----------------------------
export const getOrders = () => request('/api/orders')
export const setOrderStage = (id, stage) => request(`/api/orders/${id}/stage`, { method: 'PATCH', body: { stage } })
export const setOrderHold = (id, onHold, reason) => request(`/api/orders/${id}/hold`, { method: 'PATCH', body: { onHold, reason } })
export const setOrderSpecialRequest = (id, specialRequest) => request(`/api/orders/${id}/special-request`, { method: 'PATCH', body: { specialRequest } })
export const moveOrder = (id, direction) => request(`/api/orders/${id}/move`, { method: 'PATCH', body: { direction } })
export const resetQueue = () => request('/api/orders/reset-queue', { method: 'POST' })

// ---- Whatnot orders + sales analytics -------------------------------------
export const getWhatnotOrders = () => request('/api/whatnot-orders')
export const getSales = () => request('/api/sales')

// ---- Whatnot ledger (Sales Dashboard, CSV-driven) -------------------------
// The Sales Dashboard is now powered by an uploaded Whatnot LEDGER CSV export.
// uploadLedger posts the raw CSV text (already read on the client) and returns
// the freshly computed analysis. getLedger fetches the current analysis, with
// an optional breaksPerCase override to recompute per-case rollups on the fly.
// setLedgerBreaksPerCase persists the breaks-per-case setting and returns the
// recomputed analysis. clearLedger drops the stored ledger entirely.
export const uploadLedger = (filename, csv) => request('/api/ledger', { method: 'POST', body: { filename, csv } })
export const getLedger = (breaksPerCase) => request(`/api/ledger${breaksPerCase ? `?breaksPerCase=${breaksPerCase}` : ''}`)
export const setLedgerBreaksPerCase = (breaksPerCase) => request('/api/ledger/settings', { method: 'PATCH', body: { breaksPerCase } })
// Persist the manual profit cost inputs (giveaway COGS/shipping, supplies,
// labor, hours log, cancellations) — returns the recomputed analysis.
export const setLedgerCostInputs = (costInputs) => request('/api/ledger/cost-inputs', { method: 'PATCH', body: { costInputs } })
export const clearLedger = () => request('/api/ledger', { method: 'DELETE' })

// ---- History (daily snapshots) + CSV export -------------------------------
export const saveSnapshot = (label) => request('/api/snapshots', { method: 'POST', body: { label } })
export const listSnapshots = () => request('/api/snapshots')
export const deleteSnapshot = (id) => request(`/api/snapshots/${id}`, { method: 'DELETE' })

// Import history log (item 3)
export const listImports = () => request('/api/imports')
export const renameImport = (id, name) => request(`/api/imports/${id}`, { method: 'PATCH', body: { name } })
export const deleteImport = (id) => request(`/api/imports/${id}`, { method: 'DELETE' })
export const exportData = (kind, snapshotId) =>
  request(`/api/export/${kind}${snapshotId ? `?snapshot=${encodeURIComponent(snapshotId)}` : ''}`)

// Save CSV text to disk: native Save dialog on desktop, browser download in a browser.
export async function saveCsvToDisk(filename, csv) {
  if (window.rmcardz && window.rmcardz.saveFile) {
    return window.rmcardz.saveFile({ defaultName: filename, content: csv })
  }
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
  return { saved: true, browser: true }
}

// ---- Dashboard / settings -------------------------------------------------
export const getDashboard = () => request('/api/dashboard')
export const getSettings = () => request('/api/settings')
export const updateSettings = (payload) => request('/api/settings', { method: 'PATCH', body: payload })

// ---- Desktop bridges (USPS launch, app version, updates) ------------------
export const isDesktop = typeof window !== 'undefined' && !!window.rmcardz

export function openExternal(url) {
  if (window.rmcardz) return window.rmcardz.openExternal(url)
  window.open(url, '_blank') // browser fallback
}
export function openExternalBatch(urls) {
  if (window.rmcardz) return window.rmcardz.openExternalBatch(urls)
  // Browser fallback: open sequentially with a small delay.
  urls.forEach((u, i) => setTimeout(() => window.open(u, '_blank'), i * 500))
}
export async function copyToClipboard(text) {
  try { await navigator.clipboard.writeText(text); return true } catch { return false }
}

// Automatic USPS status refresh (desktop only — needs the Electron browser).
export function refreshTracking() {
  if (window.rmcardz && window.rmcardz.refreshTracking) return window.rmcardz.refreshTracking()
  return Promise.resolve({ error: 'Auto-tracking is only available in the desktop app.', updated: 0, scanned: 0 })
}
export function onTrackingProgress(cb) {
  if (window.rmcardz && window.rmcardz.onTrackingProgress) return window.rmcardz.onTrackingProgress(cb)
  return () => {}
}
// Fires after any status sync (manual or background auto-refresh) so views can
// reload the board live. Returns an unsubscribe function; no-op in the browser.
export function onTrackingSynced(cb) {
  if (window.rmcardz && window.rmcardz.onTrackingSynced) return window.rmcardz.onTrackingSynced(cb)
  return () => {}
}
