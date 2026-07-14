/* =============================================================================
   RM Cardz Inventory — frontend SPA (vanilla JS, no build step)
   Views: Items list · QR Scanner · Item detail · Add/Edit · Printable labels
   ============================================================================= */
'use strict'

const appEl = document.getElementById('app')
const statsEl = document.getElementById('stats')
const toastEl = document.getElementById('toast')

/* ---- Tiny helpers -------------------------------------------------------- */
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ))
}
function money(n) {
  const v = Number(n) || 0
  return v ? '$' + v.toFixed(2) : '—'
}
function fmtTime(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}
let toastTimer = null
function toast(msg, kind = '') {
  toastEl.textContent = msg
  toastEl.className = 'toast ' + kind
  toastEl.hidden = false
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { toastEl.hidden = true }, 2400)
}

/* ---- API -----------------------------------------------------------------
   The app can run two ways, and picks automatically at startup:
   • "server" — talks to the Express backend (inventory/server.cjs) over REST.
   • "local"  — no backend; data lives in the browser (store-local.js), so the
                app works as a plain static website (e.g. GitHub Pages).
   Both expose the same get/post/patch/del interface, so the view code below is
   identical regardless of mode. `backend` is chosen in boot().
--------------------------------------------------------------------------- */
async function apiFetch(path, opts) {
  const res = await fetch('/api' + path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  })
  let data = null
  try { data = await res.json() } catch (_) { /* non-JSON */ }
  if (!res.ok) throw new Error((data && data.error) || `Request failed (${res.status})`)
  return data
}
const serverApi = {
  get: (p) => apiFetch(p),
  post: (p, body) => apiFetch(p, { method: 'POST', body: JSON.stringify(body || {}) }),
  patch: (p, body) => apiFetch(p, { method: 'PATCH', body: JSON.stringify(body || {}) }),
  del: (p) => apiFetch(p, { method: 'DELETE' }),
}
const localApi = {
  get: (p) => window.InventoryLocal.route('GET', p, null),
  post: (p, body) => window.InventoryLocal.route('POST', p, body || {}),
  patch: (p, body) => window.InventoryLocal.route('PATCH', p, body || {}),
  del: (p) => window.InventoryLocal.route('DELETE', p, null),
}
let backend = serverApi
const isLocal = () => backend === localApi
const api = {
  get: (p) => backend.get(p),
  post: (p, b) => backend.post(p, b),
  patch: (p, b) => backend.patch(p, b),
  del: (p) => backend.del(p),
}

/* ---- QR helpers ---------------------------------------------------------- */
function qrDataUrl(text, cell = 4, margin = 2) {
  if (typeof window.qrcode !== 'function') return null
  try {
    const qr = window.qrcode(0, 'M')
    qr.addData(String(text))
    qr.make()
    return qr.createDataURL(cell, margin)
  } catch (_) {
    return null
  }
}
/** Pull an item code out of a scanned payload (bare code, or one of our URLs). */
function extractCode(text) {
  const t = String(text || '').trim()
  if (/^https?:\/\//i.test(t)) {
    try {
      const u = new URL(t)
      const byQuery = u.searchParams.get('code')
      if (byQuery) return byQuery.trim()
      const m = (u.hash + ' ' + u.pathname).match(/(?:code|item)[/=]([^/?#\s]+)/i)
      if (m) return decodeURIComponent(m[1]).trim()
    } catch (_) { /* fall through */ }
  }
  return t
}

/* ---- Header stats -------------------------------------------------------- */
async function refreshStats() {
  try {
    const s = await api.get('/stats')
    statsEl.innerHTML = `
      <div class="stat"><b>${s.itemCount}</b><span>items</span></div>
      <div class="stat"><b>${s.totalUnits}</b><span>units</span></div>
      <div class="stat"><b>${s.lowStock}</b><span>low</span></div>`
  } catch (_) { statsEl.innerHTML = '' }
}

/* =============================================================================
   Router
   ============================================================================= */
let stopScanner = null

function parseHash() {
  const raw = location.hash.replace(/^#/, '') || '/'
  const [path, queryStr] = raw.split('?')
  return {
    parts: path.split('/').filter(Boolean),
    query: new URLSearchParams(queryStr || ''),
  }
}

function setActiveTab(parts) {
  const key = '/' + (parts[0] || '')
  document.querySelectorAll('.tab').forEach((t) => {
    t.classList.toggle('active', t.dataset.tab === key)
  })
}

async function render() {
  if (stopScanner) { try { stopScanner() } catch (_) {} stopScanner = null }
  const { parts, query } = parseHash()
  setActiveTab(parts)
  refreshStats()
  try {
    if (parts.length === 0) return viewList(query)
    if (parts[0] === 'scan') return viewScan()
    if (parts[0] === 'new') return viewForm(null, query.get('code'))
    if (parts[0] === 'labels') return viewLabels()
    if (parts[0] === 'item' && parts[2] === 'edit') return viewForm(parts[1])
    if (parts[0] === 'item' && parts[1]) return viewDetail(parts[1])
    viewList(query)
  } catch (err) {
    appEl.innerHTML = `<div class="empty"><div class="big">⚠️</div><p>${escapeHtml(err.message)}</p>
      <a class="btn btn-primary" href="#/">Back to items</a></div>`
  }
}

/* =============================================================================
   View: Items list
   ============================================================================= */
function qtyBadge(it) {
  const q = it.quantity
  let cls = ''
  if (q <= 0) cls = 'out'
  else if (it.minQuantity > 0 && q <= it.minQuantity) cls = 'low'
  return `<div class="qty-badge ${cls}"><b>${q}</b><span>qty</span></div>`
}

async function viewList(query) {
  const initial = query.get('q') || ''
  appEl.innerHTML = `
    <input id="search" class="search" type="search" placeholder="Search items, codes, locations…"
      value="${escapeHtml(initial)}" autocomplete="off" />
    <div id="list" class="list"><div class="spinner">Loading…</div></div>
    ${isLocal() ? `
      <div class="local-tools">
        <div class="local-tools-note">Your inventory is saved on this device. Back it up, or move it to another phone/computer:</div>
        <div class="btn-row">
          <button class="btn" id="exportBtn">⭳ Back up</button>
          <label class="btn" for="importFile">⭱ Restore</label>
          <input id="importFile" type="file" accept="application/json,.json" hidden />
        </div>
      </div>` : ''}`

  const listEl = document.getElementById('list')
  const searchEl = document.getElementById('search')

  async function load() {
    const q = searchEl.value.trim()
    try {
      const items = await api.get('/items' + (q ? '?q=' + encodeURIComponent(q) : ''))
      if (!items.length) {
        listEl.innerHTML = q
          ? `<div class="empty"><div class="big">🔍</div><p>No items match “${escapeHtml(q)}”.</p></div>`
          : `<div class="empty"><div class="big">📦</div>
               <p>No inventory yet.<br>Scan a QR code or add your first item.</p>
               <div class="btn-row" style="max-width:320px;margin:0 auto">
                 <a class="btn btn-primary" href="#/scan">▣ Scan</a>
                 <a class="btn" href="#/new">＋ Add item</a>
               </div></div>`
        return
      }
      listEl.innerHTML = items.map((it) => `
        <a class="item-card" href="#/item/${it.id}">
          <div class="item-main">
            <div class="item-name">${escapeHtml(it.name)}</div>
            <div class="item-sub">
              <span class="item-code">${escapeHtml(it.code)}</span>
              ${it.category ? ' · ' + escapeHtml(it.category) : ''}
              ${it.location ? ' · ' + escapeHtml(it.location) : ''}
            </div>
          </div>
          ${qtyBadge(it)}
        </a>`).join('')
    } catch (err) {
      listEl.innerHTML = `<div class="empty"><p>${escapeHtml(err.message)}</p></div>`
    }
  }

  let debounce = null
  searchEl.addEventListener('input', () => {
    clearTimeout(debounce)
    debounce = setTimeout(load, 180)
  })

  if (isLocal()) {
    document.getElementById('exportBtn').onclick = () => {
      const blob = new Blob([window.InventoryLocal.dump()], { type: 'application/json' })
      const a = document.createElement('a')
      a.href = URL.createObjectURL(blob)
      a.download = 'rmcardz-inventory-backup.json'
      a.click()
      setTimeout(() => URL.revokeObjectURL(a.href), 1000)
      toast('Backup downloaded', 'ok')
    }
    document.getElementById('importFile').onchange = (e) => {
      const file = e.target.files && e.target.files[0]
      if (!file) return
      const reader = new FileReader()
      reader.onload = () => {
        try {
          window.InventoryLocal.replace(reader.result)
          toast('Inventory restored', 'ok')
          load()
          refreshStats()
        } catch (err) { toast(err.message, 'err') }
      }
      reader.readAsText(file)
    }
  }

  load()
}

/* =============================================================================
   View: Item detail
   ============================================================================= */
async function viewDetail(id) {
  appEl.innerHTML = `<div class="spinner">Loading…</div>`
  const [item, moves] = await Promise.all([
    api.get('/items/' + id),
    api.get('/items/' + id + '/movements').catch(() => []),
  ])

  const q = item.quantity
  let numCls = ''
  if (q <= 0) numCls = 'out'
  else if (item.minQuantity > 0 && q <= item.minQuantity) numCls = 'low'
  const qr = qrDataUrl(item.code, 4, 2)

  appEl.innerHTML = `
    <div class="detail-card">
      <div class="detail-head">
        <div>
          <h1 class="detail-name">${escapeHtml(item.name)}</h1>
          <div class="detail-meta">
            <span class="item-code">${escapeHtml(item.code)}</span>
            ${item.category ? `<span class="pill">${escapeHtml(item.category)}</span>` : ''}
          </div>
        </div>
        <a class="btn btn-ghost" href="#/item/${item.id}/edit">Edit</a>
      </div>

      <div class="qty-hero">
        <button class="round-btn minus" id="dec" aria-label="Remove one">−</button>
        <div class="num ${numCls}" id="qtyNum">${q}</div>
        <button class="round-btn plus" id="inc" aria-label="Add one">＋</button>
      </div>
      <div class="scan-hint">Tap − / ＋ to adjust stock by one</div>

      <div class="field">
        <div class="btn-row">
          <input id="adjAmt" class="search" style="margin:0" type="number" inputmode="numeric" min="1" value="1" aria-label="Adjust amount" />
          <button class="btn" id="stockOut">− Stock out</button>
          <button class="btn btn-primary" id="stockIn">＋ Stock in</button>
        </div>
      </div>
    </div>

    <div class="detail-card">
      ${item.location ? `<div class="kv"><span class="k">Location</span><span class="v">${escapeHtml(item.location)}</span></div>` : ''}
      <div class="kv"><span class="k">Unit value</span><span class="v">${money(item.price)}</span></div>
      ${item.minQuantity > 0 ? `<div class="kv"><span class="k">Low-stock at</span><span class="v">≤ ${item.minQuantity}</span></div>` : ''}
      <div class="kv"><span class="k">Total value</span><span class="v">${money((item.price || 0) * q)}</span></div>
      ${item.notes ? `<div class="kv"><span class="k">Notes</span><span class="v">${escapeHtml(item.notes)}</span></div>` : ''}
      <div class="kv"><span class="k">Updated</span><span class="v">${fmtTime(item.updatedAt)}</span></div>
    </div>

    <div class="detail-card qr-wrap">
      ${qr ? `<img src="${qr}" alt="QR code for ${escapeHtml(item.code)}" />` : '<p>QR unavailable</p>'}
      <span class="item-code">${escapeHtml(item.code)}</span>
      <div class="btn-row" style="margin-top:12px">
        <button class="btn" id="printOne">⧉ Print label</button>
      </div>
    </div>

    <div class="section-title">Recent activity</div>
    <div class="detail-card">
      <div class="moves">${
        moves.length
          ? moves.map((m) => `
            <div class="move">
              <div class="move-delta ${m.delta >= 0 ? 'up' : 'down'}">${m.delta >= 0 ? '+' : ''}${m.delta}</div>
              <div class="move-body">
                <div class="move-reason">${escapeHtml(m.reason)}</div>
                <div class="move-time">${fmtTime(m.at)}</div>
              </div>
              <div class="move-after">→ ${m.quantityAfter}</div>
            </div>`).join('')
          : '<div class="move-time">No activity yet.</div>'
      }</div>
    </div>

    <button class="btn btn-danger btn-block" id="del">Delete item</button>`

  async function adjust(delta, reason) {
    if (!delta) return
    try {
      await api.post('/items/' + id + '/adjust', { delta, reason })
      viewDetail(id)
      refreshStats()
    } catch (err) { toast(err.message, 'err') }
  }
  document.getElementById('inc').onclick = () => adjust(1)
  document.getElementById('dec').onclick = () => adjust(-1)
  document.getElementById('stockIn').onclick = () => adjust(Math.abs(parseInt(document.getElementById('adjAmt').value, 10) || 0))
  document.getElementById('stockOut').onclick = () => adjust(-Math.abs(parseInt(document.getElementById('adjAmt').value, 10) || 0))
  document.getElementById('printOne').onclick = () => printLabels([item])
  document.getElementById('del').onclick = async () => {
    if (!confirm(`Delete “${item.name}”? This cannot be undone.`)) return
    try {
      await api.del('/items/' + id)
      toast('Item deleted', 'ok')
      location.hash = '#/'
    } catch (err) { toast(err.message, 'err') }
  }
}

/* =============================================================================
   View: Add / Edit form
   ============================================================================= */
async function viewForm(id, prefillCode) {
  const editing = !!id
  let item = { name: '', code: prefillCode || '', category: '', quantity: 0, minQuantity: 0, price: '', location: '', notes: '' }
  if (editing) item = await api.get('/items/' + id)

  const stats = await api.get('/stats').catch(() => ({ categories: [] }))
  const cats = (stats.categories || []).map((c) => `<option value="${escapeHtml(c)}">`).join('')

  appEl.innerHTML = `
    <div class="section-title">${editing ? 'Edit item' : 'Add item'}</div>
    <form class="form" id="form">
      <div class="field">
        <label for="f-name">Name *</label>
        <input id="f-name" required value="${escapeHtml(item.name)}" placeholder="e.g. 2023 Prizm Football Hobby Box" />
      </div>
      <div class="field">
        <label for="f-code">Barcode / code</label>
        <input id="f-code" value="${escapeHtml(item.code)}" placeholder="${editing ? '' : 'Scan or type a barcode, or leave blank'}" autocapitalize="characters" />
        <span class="hint">${editing ? 'The barcode or code used to pull up this item when you scan.' : 'Scan an item’s existing barcode into here, or leave blank to auto-generate a code you can print.'}</span>
      </div>
      <div class="grid-2">
        <div class="field">
          <label for="f-cat">Category</label>
          <input id="f-cat" list="cats" value="${escapeHtml(item.category)}" placeholder="Boxes, Singles…" />
          <datalist id="cats">${cats}</datalist>
        </div>
        <div class="field">
          <label for="f-loc">Location</label>
          <input id="f-loc" value="${escapeHtml(item.location)}" placeholder="Shelf A3" />
        </div>
      </div>
      <div class="grid-2">
        ${editing ? '' : `
        <div class="field">
          <label for="f-qty">Starting quantity</label>
          <input id="f-qty" type="number" inputmode="numeric" min="0" value="${item.quantity || 0}" />
        </div>`}
        <div class="field">
          <label for="f-min">Low-stock alert at</label>
          <input id="f-min" type="number" inputmode="numeric" min="0" value="${item.minQuantity || 0}" />
        </div>
        <div class="field">
          <label for="f-price">Unit value ($)</label>
          <input id="f-price" type="number" inputmode="decimal" min="0" step="0.01" value="${item.price || ''}" placeholder="0.00" />
        </div>
      </div>
      <div class="field">
        <label for="f-notes">Notes</label>
        <textarea id="f-notes" placeholder="Anything worth remembering…">${escapeHtml(item.notes)}</textarea>
      </div>
      <button class="btn btn-primary btn-lg btn-block" type="submit">${editing ? 'Save changes' : 'Add item'}</button>
      <a class="btn btn-block" href="${editing ? '#/item/' + id : '#/'}">Cancel</a>
    </form>`

  document.getElementById('form').addEventListener('submit', async (e) => {
    e.preventDefault()
    const payload = {
      name: document.getElementById('f-name').value,
      code: document.getElementById('f-code').value.trim(),
      category: document.getElementById('f-cat').value,
      minQuantity: document.getElementById('f-min').value,
      price: document.getElementById('f-price').value,
      location: document.getElementById('f-loc').value,
      notes: document.getElementById('f-notes').value,
    }
    if (!editing) payload.quantity = document.getElementById('f-qty').value
    try {
      const saved = editing
        ? await api.patch('/items/' + id, payload)
        : await api.post('/items', payload)
      toast(editing ? 'Saved' : 'Item added', 'ok')
      location.hash = '#/item/' + saved.id
    } catch (err) { toast(err.message, 'err') }
  })
}

/* =============================================================================
   View: Scanner (barcodes + QR)
   ============================================================================= */
async function handleScannedCode(raw) {
  const code = extractCode(raw)
  if (!code) return
  try {
    const item = await api.get('/items/by-code/' + encodeURIComponent(code))
    toast('Found: ' + item.name, 'ok')
    location.hash = '#/item/' + item.id
  } catch (err) {
    // Unknown code → offer to create it.
    if (confirm(`No item has code “${code}”.\n\nAdd a new item with this code?`)) {
      location.hash = '#/new?code=' + encodeURIComponent(code)
    } else {
      location.hash = '#/scan' // stay/rescan
      render()
    }
  }
}

function viewScan() {
  const secure = window.isSecureContext
  const hasCamera = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia)
  const hasReader = !!(window.ZXing && window.ZXing.BrowserMultiFormatReader)
  const canScan = secure && hasCamera && hasReader

  appEl.innerHTML = `
    ${!secure ? `<div class="scan-note"><b>Camera needs a secure connection.</b><br>
      Open this app over <b>https://</b> or on the computer itself.
      You can still look up an item by typing its number below.</div>` : ''}
    <div class="scanner" id="scanner" ${!canScan ? 'style="display:none"' : ''}>
      <video id="video" playsinline muted></video>
      <div class="scan-frame"></div>
      <div class="scan-controls" id="scanControls"></div>
    </div>
    <div class="scan-hint" id="scanHint">${canScan ? 'Line the barcode up inside the box and hold steady' : ''}</div>

    <div class="divider">or enter it by hand</div>
    <form id="manual" class="btn-row">
      <input id="manualCode" class="search" style="margin:0" placeholder="Type or paste a barcode / code" autocomplete="off" />
      <button class="btn btn-primary" type="submit">Go</button>
    </form>`

  document.getElementById('manual').addEventListener('submit', (e) => {
    e.preventDefault()
    const v = document.getElementById('manualCode').value.trim()
    if (v) handleScannedCode(v)
  })

  if (!canScan) return

  const Z = window.ZXing
  const video = document.getElementById('video')
  const hint = document.getElementById('scanHint')

  // Restrict to the formats actually used (UPC/EAN barcodes + Code 128/39/ITF +
  // QR) and enable TRY_HARDER. Fewer formats = faster and far fewer misreads.
  const hints = new Map()
  hints.set(Z.DecodeHintType.POSSIBLE_FORMATS, [
    Z.BarcodeFormat.UPC_A, Z.BarcodeFormat.UPC_E, Z.BarcodeFormat.EAN_13, Z.BarcodeFormat.EAN_8,
    Z.BarcodeFormat.CODE_128, Z.BarcodeFormat.CODE_39, Z.BarcodeFormat.ITF, Z.BarcodeFormat.QR_CODE,
  ])
  hints.set(Z.DecodeHintType.TRY_HARDER, true)
  const reader = new Z.BrowserMultiFormatReader(hints, 200) // scan ~5x/sec

  let done = false
  let ctlTimer = null
  let lastText = null
  let sameCount = 0

  function stop() {
    done = true
    if (ctlTimer) { clearInterval(ctlTimer); ctlTimer = null }
    try { reader.reset() } catch (_) { /* ignore */ }
  }
  stopScanner = stop

  // Accept a read only after seeing the SAME value on two consecutive frames.
  // Combined with the check digit that UPC/EAN barcodes carry, this makes a
  // wrong-SKU misread extremely unlikely. QR codes self-verify, so accept those
  // on the first read.
  function onResult(result) {
    if (done || !result) return
    const text = result.getText ? result.getText() : String(result)
    const isQR = result.getBarcodeFormat && result.getBarcodeFormat() === Z.BarcodeFormat.QR_CODE
    if (!isQR) {
      if (text === lastText) { sameCount++ } else { lastText = text; sameCount = 1 }
      if (sameCount < 2) { if (hint) hint.textContent = 'Reading ' + text + '… hold steady'; return }
    }
    stop()
    if (navigator.vibrate) navigator.vibrate(60)
    if (hint) hint.textContent = 'Got it: ' + text
    handleScannedCode(text)
  }

  reader
    .decodeFromConstraints(
      {
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
        audio: false,
      },
      video,
      onResult,
    )
    .catch((err) => {
      const scanner = document.getElementById('scanner')
      if (scanner) scanner.style.display = 'none'
      if (hint) hint.textContent = ''
      const msg = err && err.name === 'NotAllowedError'
        ? 'Camera permission was blocked. Enter the number below, or allow camera access and reopen Scan.'
        : 'Could not start the camera. Enter the number below instead.'
      const note = document.createElement('div')
      note.className = 'scan-note'
      note.textContent = msg
      appEl.prepend(note)
    })

  // Once the stream is live, add a flashlight and zoom control if the phone
  // exposes them (big help for small/low-contrast barcodes on iPhone).
  let tries = 0
  ctlTimer = setInterval(() => {
    if (done) { clearInterval(ctlTimer); return }
    const track = video.srcObject && video.srcObject.getVideoTracks && video.srcObject.getVideoTracks()[0]
    if (track && track.getCapabilities) {
      clearInterval(ctlTimer)
      addCameraControls(track)
    } else if (++tries > 25) {
      clearInterval(ctlTimer)
    }
  }, 200)

  function addCameraControls(track) {
    const box = document.getElementById('scanControls')
    if (!box) return
    let caps = {}
    try { caps = track.getCapabilities() } catch (_) { return }

    if (caps.torch) {
      let on = false
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'scan-ctl-btn'
      btn.textContent = '🔦'
      btn.setAttribute('aria-label', 'Toggle flashlight')
      btn.onclick = async () => {
        on = !on
        try { await track.applyConstraints({ advanced: [{ torch: on }] }); btn.classList.toggle('on', on) } catch (_) { /* ignore */ }
      }
      box.appendChild(btn)
    }

    if (caps.zoom && (caps.zoom.max || 1) > (caps.zoom.min || 1)) {
      const slider = document.createElement('input')
      slider.type = 'range'
      slider.className = 'scan-zoom'
      slider.min = caps.zoom.min
      slider.max = caps.zoom.max
      slider.step = caps.zoom.step || 0.1
      try { slider.value = (track.getSettings().zoom || caps.zoom.min) } catch (_) { slider.value = caps.zoom.min }
      slider.setAttribute('aria-label', 'Zoom')
      slider.oninput = () => { try { track.applyConstraints({ advanced: [{ zoom: Number(slider.value) }] }) } catch (_) { /* ignore */ } }
      box.appendChild(slider)
    }
  }
}

/* =============================================================================
   View: Printable labels
   ============================================================================= */
function labelHtml(it) {
  const qr = qrDataUrl(it.code, 4, 1)
  return `<div class="label">
    ${qr ? `<img src="${qr}" alt="${escapeHtml(it.code)}" />` : ''}
    <div class="label-name">${escapeHtml(it.name)}</div>
    <div class="label-code">${escapeHtml(it.code)}</div>
  </div>`
}

function printLabels(items) {
  const w = window.open('', '_blank')
  if (!w) { toast('Allow pop-ups to print', 'err'); return }
  const grid = items.map(labelHtml).join('')
  w.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>QR Labels</title>
    <style>
      body { font-family: -apple-system, Segoe UI, Roboto, sans-serif; margin: 12px; }
      .g { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; }
      .label { border: 1px solid #999; border-radius: 8px; padding: 8px; text-align: center; break-inside: avoid; }
      .label img { width: 100%; max-width: 150px; image-rendering: pixelated; }
      .label-name { font-size: 12px; font-weight: 700; margin-top: 4px; }
      .label-code { font-family: monospace; font-size: 11px; color: #333; }
    </style></head><body><div class="g">${grid}</div>
    <script>window.onload=function(){setTimeout(function(){window.print()},250)}<\/script>
    </body></html>`)
  w.document.close()
}

async function viewLabels() {
  appEl.innerHTML = `<div class="spinner">Loading…</div>`
  const items = await api.get('/items')
  if (!items.length) {
    appEl.innerHTML = `<div class="empty"><div class="big">⧉</div>
      <p>No items to label yet.</p><a class="btn btn-primary" href="#/new">＋ Add an item</a></div>`
    return
  }
  appEl.innerHTML = `
    <div class="labels-toolbar">
      <button class="btn btn-primary" id="printAll">⧉ Print all ${items.length} labels</button>
    </div>
    <div class="section-title">Stick these on your boxes, then scan to check stock</div>
    <div class="labels-grid">${items.map(labelHtml).join('')}</div>`
  document.getElementById('printAll').onclick = () => printLabels(items)
}

/* ---- Boot ----------------------------------------------------------------
   Detect whether a backend is reachable. If not (static hosting like GitHub
   Pages, or opened as a file), fall back to the in-browser local store.
--------------------------------------------------------------------------- */
async function detectBackend() {
  try {
    const res = await fetch('/api/health', { cache: 'no-store' })
    if (res.ok) return 'server'
  } catch (_) { /* no backend */ }
  return 'local'
}

;(async function boot() {
  let mode = 'server'
  if (window.InventoryLocal) mode = await detectBackend()
  backend = mode === 'local' ? localApi : serverApi
  document.body.dataset.mode = mode
  if (mode === 'local') {
    // The "link a phone" flow is server-only; there's nothing to connect to here.
    const cl = document.querySelector('.connect-link')
    if (cl) cl.remove()
  }
  window.addEventListener('hashchange', render)
  render()
})()
