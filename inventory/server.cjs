// =============================================================================
// RM Cardz Inventory — standalone mobile web app server
// -----------------------------------------------------------------------------
// A zero-dependency Node server (built-in http/https only — no npm install
// needed) that serves the mobile inventory UI and a small JSON REST API on top
// of a local JSON datastore.
//
// Why standalone / why HTTPS:
//   The main RM Cardz desktop app binds its backend to 127.0.0.1, so a phone
//   can't reach it. This app binds to 0.0.0.0 so you can open it from your
//   phone over WiFi. Phone browsers only allow camera access (needed to scan
//   QR codes) in a "secure context" — HTTPS or localhost — so on first run we
//   auto-generate a self-signed certificate (via openssl) and serve HTTPS.
//
// Run it:
//   node inventory/server.cjs           # HTTPS on :8787 (self-signed)
//   INVENTORY_HTTP=1 node inventory/...  # plain HTTP (camera only works on localhost)
//   PORT=9000 node inventory/server.cjs  # choose the port
//
// Exports (for tests):
//   createHandler(db) -> (req, res)      request handler, mountable on http.Server
//   makeDb(dataDir)   -> Db
//   start(opts)       -> Promise<{ server, url, port, close }>
// =============================================================================

const http = require('node:http')
const https = require('node:https')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const { Store } = require('./store.cjs')
const { Db } = require('./db.cjs')

const PUBLIC_DIR = path.join(__dirname, 'public')
const MAX_BODY_BYTES = 1024 * 1024 // 1 MB — plenty for JSON item payloads

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain; charset=utf-8',
}

// ---------------------------------------------------------------------------
// Small response helpers
// ---------------------------------------------------------------------------
function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  })
  res.end(body)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('Request body too large'), { status: 413 }))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (!chunks.length) return resolve({})
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch (_) {
        reject(Object.assign(new Error('Invalid JSON body'), { status: 400 }))
      }
    })
    req.on('error', reject)
  })
}

// ---------------------------------------------------------------------------
// API router — returns true if it handled the request.
// ---------------------------------------------------------------------------
async function handleApi(db, req, res, segments, query) {
  const method = req.method
  // segments[0] === 'api'
  const resource = segments[1]

  if (resource === 'health' && method === 'GET') {
    return sendJson(res, 200, { ok: true, itemCount: db.state.items.length })
  }

  if (resource === 'stats' && method === 'GET') {
    return sendJson(res, 200, db.stats())
  }

  if (resource === 'items') {
    // /api/items
    if (segments.length === 2) {
      if (method === 'GET') return sendJson(res, 200, db.listItems({ q: query.get('q') }))
      if (method === 'POST') {
        const body = await readBody(req)
        return sendJson(res, 201, db.createItem(body))
      }
    }

    // /api/items/by-code/:code
    if (segments.length === 4 && segments[2] === 'by-code' && method === 'GET') {
      const item = db.getItemByCode(decodeURIComponent(segments[3]))
      if (!item) return sendJson(res, 404, { error: 'No item with that code' })
      return sendJson(res, 200, item)
    }

    // /api/items/:id  and sub-resources
    if (segments.length === 3) {
      const id = segments[2]
      if (method === 'GET') {
        const item = db.getItem(id)
        if (!item) return sendJson(res, 404, { error: 'Item not found' })
        return sendJson(res, 200, item)
      }
      if (method === 'PATCH') {
        const body = await readBody(req)
        return sendJson(res, 200, db.updateItem(id, body))
      }
      if (method === 'DELETE') {
        db.deleteItem(id)
        return sendJson(res, 200, { ok: true })
      }
    }

    if (segments.length === 4 && method === 'POST' && segments[3] === 'adjust') {
      const body = await readBody(req)
      return sendJson(res, 200, db.adjustQuantity(segments[2], body.delta, body.reason))
    }

    if (segments.length === 4 && method === 'GET' && segments[3] === 'movements') {
      if (!db.getItem(segments[2])) return sendJson(res, 404, { error: 'Item not found' })
      return sendJson(res, 200, db.listMovements(segments[2]))
    }
  }

  return sendJson(res, 404, { error: 'Unknown API route' })
}

// ---------------------------------------------------------------------------
// Static file serving (with SPA fallback to index.html)
// ---------------------------------------------------------------------------
function serveStatic(req, res, pathname) {
  // Resolve safely inside PUBLIC_DIR — reject path traversal.
  const rel = decodeURIComponent(pathname).replace(/^\/+/, '')
  const target = path.join(PUBLIC_DIR, rel || 'index.html')
  if (!target.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end('Forbidden')
    return
  }

  fs.stat(target, (err, stat) => {
    if (!err && stat.isFile()) return streamFile(res, target)
    // Fall back to index.html for client-side routes / unknown paths (GET only).
    if (req.method === 'GET') return streamFile(res, path.join(PUBLIC_DIR, 'index.html'))
    res.writeHead(404).end('Not found')
  })
}

function streamFile(res, filePath) {
  const ext = path.extname(filePath).toLowerCase()
  const type = CONTENT_TYPES[ext] || 'application/octet-stream'
  // Vendored libraries never change; cache them. App files stay fresh.
  const cache = filePath.includes(`${path.sep}vendor${path.sep}`)
    ? 'public, max-age=31536000, immutable'
    : 'no-cache'
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404).end('Not found')
      return
    }
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': cache })
    res.end(data)
  })
}

// ---------------------------------------------------------------------------
// Top-level request handler
// ---------------------------------------------------------------------------
function createHandler(db) {
  return async function handler(req, res) {
    try {
      const url = new URL(req.url, 'http://localhost')
      const pathname = url.pathname

      if (pathname === '/api' || pathname.startsWith('/api/')) {
        const segments = pathname.split('/').filter(Boolean) // ['api', ...]
        return await handleApi(db, req, res, segments, url.searchParams)
      }

      return serveStatic(req, res, pathname)
    } catch (err) {
      const status = err.status || 500
      if (status >= 500) console.error('[inventory] error:', err)
      if (!res.headersSent) sendJson(res, status, { error: err.message || 'Internal error' })
      else res.end()
    }
  }
}

// ---------------------------------------------------------------------------
// Networking helpers
// ---------------------------------------------------------------------------
/** All non-internal IPv4 addresses of this machine (for "open on your phone" URLs). */
function lanAddresses() {
  const out = []
  const ifaces = os.networkInterfaces()
  for (const name of Object.keys(ifaces)) {
    for (const net of ifaces[name] || []) {
      if (net.family === 'IPv4' && !net.internal) out.push(net.address)
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Self-signed certificate bootstrap (so phone camera access works over HTTPS).
// Regenerated automatically if this machine's LAN IPs change.
// ---------------------------------------------------------------------------
function ensureCert(dataDir) {
  const keyPath = path.join(dataDir, 'inventory-key.pem')
  const certPath = path.join(dataDir, 'inventory-cert.pem')
  const hostsPath = path.join(dataDir, 'inventory-cert-hosts.json')

  const hosts = ['localhost', '127.0.0.1', ...lanAddresses()]
  const desired = JSON.stringify(hosts.slice().sort())

  const fresh =
    fs.existsSync(keyPath) &&
    fs.existsSync(certPath) &&
    (() => {
      try {
        return fs.readFileSync(hostsPath, 'utf8') === desired
      } catch (_) {
        return false
      }
    })()

  if (!fresh) {
    const san = hosts
      .map((h) => (/^\d+\.\d+\.\d+\.\d+$/.test(h) ? `IP:${h}` : `DNS:${h}`))
      .join(',')
    try {
      fs.mkdirSync(dataDir, { recursive: true })
      execFileSync(
        'openssl',
        [
          'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
          '-keyout', keyPath,
          '-out', certPath,
          '-days', '3650',
          '-subj', '/CN=RM Cardz Inventory',
          '-addext', `subjectAltName=${san}`,
        ],
        { stdio: 'ignore' },
      )
      fs.writeFileSync(hostsPath, desired)
    } catch (err) {
      console.warn('[inventory] Could not generate a self-signed certificate:', err.message)
      return null
    }
  }

  try {
    return { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) }
  } catch (_) {
    return null
  }
}

function makeDb(dataDir) {
  return new Db(new Store(dataDir))
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
function start({
  port = Number(process.env.PORT) || 8787,
  host = '0.0.0.0',
  dataDir = process.env.INVENTORY_DATA_DIR || path.join(__dirname, 'data'),
  useHttps = process.env.INVENTORY_HTTP ? false : true,
} = {}) {
  const db = makeDb(dataDir)
  const handler = createHandler(db)

  let server
  let scheme = 'http'
  if (useHttps) {
    const creds = ensureCert(dataDir)
    if (creds) {
      server = https.createServer(creds, handler)
      scheme = 'https'
    } else {
      console.warn('[inventory] Falling back to HTTP — phone camera scanning requires HTTPS.')
      server = http.createServer(handler)
    }
  } else {
    server = http.createServer(handler)
  }

  return new Promise((resolve, reject) => {
    server.on('error', reject)
    server.listen(port, host, () => {
      const actualPort = server.address().port
      const url = `${scheme}://localhost:${actualPort}`
      resolve({
        server,
        db,
        url,
        port: actualPort,
        scheme,
        close: () =>
          new Promise((r) => {
            try { db.store.saveNow() } catch (_) { /* ignore */ }
            server.close(() => r())
          }),
      })
    })
  })
}

/** Pretty startup banner with the URLs to open on a phone. */
function printBanner({ scheme, port }) {
  const lines = []
  lines.push('')
  lines.push('  ┌─────────────────────────────────────────────────────────┐')
  lines.push('  │  RM Cardz — Inventory Manager                            │')
  lines.push('  └─────────────────────────────────────────────────────────┘')
  lines.push('')
  lines.push(`  On this computer:   ${scheme}://localhost:${port}`)
  const lan = lanAddresses()
  if (lan.length) {
    lines.push('')
    lines.push('  On your phone (same WiFi), open one of these:')
    for (const ip of lan) lines.push(`      ${scheme}://${ip}:${port}`)
  }
  if (scheme === 'https') {
    lines.push('')
    lines.push('  NOTE: the certificate is self-signed, so your phone will show a')
    lines.push('  "Not private / not secure" warning the first time. Tap Advanced →')
    lines.push('  Proceed. This is expected for a local app and is required for the')
    lines.push('  camera (QR scanning) to work.')
  }
  lines.push('')
  lines.push('  Press Ctrl+C to stop.')
  lines.push('')
  console.log(lines.join('\n'))
}

// Run directly: node inventory/server.cjs
if (require.main === module) {
  start()
    .then((s) => {
      printBanner(s)
      const shutdown = () => {
        console.log('\n[inventory] shutting down…')
        s.close().then(() => process.exit(0))
      }
      process.on('SIGINT', shutdown)
      process.on('SIGTERM', shutdown)
    })
    .catch((err) => {
      if (err && err.code === 'EADDRINUSE') {
        console.error(`[inventory] Port is already in use. Try: PORT=9000 node inventory/server.cjs`)
      } else {
        console.error('[inventory] Failed to start:', err)
      }
      process.exit(1)
    })
}

module.exports = { createHandler, makeDb, start, ensureCert, lanAddresses }
