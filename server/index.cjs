// =============================================================================
// RM Cardz — Embedded backend (Express)
// -----------------------------------------------------------------------------
// Builds the REST API described in the engineering spec (§12) and runs it on an
// ephemeral localhost port inside the Electron main process. The renderer talks
// to it over plain HTTP/JSON. There are NO external service dependencies.
//
// Exports:
//   createApp({ dataDir }) -> { app, db, auth, store }   (used by tests too)
//   startServer({ port, dataDir }) -> Promise<{ url, port, server, close }>
// =============================================================================

const express = require('express')
const path = require('node:path')
const { Store } = require('./store.cjs')
const { Db } = require('./db.cjs')
const { Auth } = require('./auth.cjs')

const authRoutes = require('./routes/auth.routes.cjs')
const parseRoutes = require('./routes/parse.routes.cjs')
const breakRoutes = require('./routes/breaks.routes.cjs')
const orderRoutes = require('./routes/orders.routes.cjs')
const whatnotRoutes = require('./routes/whatnot.routes.cjs')
const ledgerRoutes = require('./routes/ledger.routes.cjs')
const historyRoutes = require('./routes/history.routes.cjs')
const shipmentRoutes = require('./routes/shipments.routes.cjs')
const dashboardRoutes = require('./routes/dashboard.routes.cjs')
const templateRoutes = require('./routes/templates.routes.cjs')

/**
 * Build the Express app and its backing data services.
 * Separated from startServer() so unit/integration tests can mount the app
 * without binding a TCP port.
 */
function createApp({ dataDir }) {
  const store = new Store(dataDir)
  const db = new Db(store)
  const auth = new Auth(store)
  const ctx = { db, auth, store }

  const app = express()
  app.use(express.json({ limit: '2mb' }))

  // --- Auth middleware ------------------------------------------------------
  // Attach the session user (if any) to every request from the Bearer token.
  app.use((req, _res, next) => {
    const header = req.headers.authorization || ''
    const token = header.startsWith('Bearer ') ? header.slice(7) : null
    req.token = token
    req.user = auth.userForToken(token)
    next()
  })

  const requireAuth = (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' })
    next()
  }
  const requireAdmin = (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' })
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin role required' })
    next()
  }
  ctx.requireAuth = requireAuth
  ctx.requireAdmin = requireAdmin

  app.get('/api/health', (_req, res) => res.json({ ok: true, hasData: db.hasData() }))

  // --- Mount feature routers ------------------------------------------------
  app.use('/api', authRoutes(ctx))
  app.use('/api', parseRoutes(ctx))
  app.use('/api', breakRoutes(ctx))
  app.use('/api', orderRoutes(ctx))
  app.use('/api', whatnotRoutes(ctx))
  app.use('/api', ledgerRoutes(ctx))
  app.use('/api', historyRoutes(ctx))
  app.use('/api', shipmentRoutes(ctx))
  app.use('/api', dashboardRoutes(ctx))
  app.use('/api', templateRoutes(ctx))

  // --- Central error handler ------------------------------------------------
  app.use((err, _req, res, _next) => {
    const status = err.status || 500
    if (status >= 500) console.error('[api] error:', err)
    res.status(status).json({ error: err.message || 'Internal error' })
  })

  return { app, db, auth, store }
}

/** Boot the HTTP server on a (by default ephemeral) localhost port. */
function startServer({ port = 0, dataDir } = {}) {
  if (!dataDir) dataDir = path.join(process.cwd(), 'data')
  const { app, db, auth, store } = createApp({ dataDir })

  return new Promise((resolve, reject) => {
    const server = app.listen(port, '127.0.0.1', () => {
      const actualPort = server.address().port
      const url = `http://127.0.0.1:${actualPort}`
      console.log(`[rmcardz] backend listening on ${url} (data: ${dataDir})`)
      resolve({
        url,
        port: actualPort,
        server,
        db,
        auth,
        close: () => {
          try { store.saveNow() } catch (_) { /* ignore */ }
          server.close()
        },
      })
    })
    server.on('error', reject)
  })
}

module.exports = { createApp, startServer }
