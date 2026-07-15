// =============================================================================
// History (daily snapshots) + CSV export routes
// -----------------------------------------------------------------------------
//   POST   /api/snapshots            -> save a snapshot of current data { label? }
//   GET    /api/snapshots            -> list saved snapshots (metadata)
//   DELETE /api/snapshots/:id        -> delete a snapshot
//   GET    /api/imports              -> list the import history log (item 3)
//   PATCH  /api/imports/:id          -> rename an import entry { name }
//   DELETE /api/imports/:id          -> delete an import log entry (not the data)
//   GET    /api/export/:kind         -> { filename, csv } for kind=orders|shipping
//                                       optional ?snapshot=<id> (else current data)
// =============================================================================

const express = require('express')

module.exports = function historyRoutes({ db, requireAuth }) {
  const router = express.Router()

  router.post('/snapshots', requireAuth, (req, res) => {
    const meta = db.saveSnapshot(req.body && req.body.label, req.user)
    res.status(201).json(meta)
  })

  router.get('/snapshots', requireAuth, (_req, res) => {
    res.json(db.listSnapshots())
  })

  router.delete('/snapshots/:id', requireAuth, (req, res) => {
    const result = db.deleteSnapshot(req.params.id)
    if (!result.ok) return res.status(404).json({ error: 'Snapshot not found' })
    res.json(result)
  })

  // Import history log (item 3) — a nameable record of every dataset upload.
  router.get('/imports', requireAuth, (_req, res) => {
    res.json(db.listImports())
  })

  router.patch('/imports/:id', requireAuth, (req, res) => {
    const entry = db.renameImport(req.params.id, req.body && req.body.name)
    if (!entry) return res.status(404).json({ error: 'Import not found' })
    res.json(entry)
  })

  router.delete('/imports/:id', requireAuth, (req, res) => {
    const result = db.deleteImport(req.params.id)
    if (!result.ok) return res.status(404).json({ error: 'Import not found' })
    res.json(result)
  })

  router.get('/export/:kind', requireAuth, (req, res) => {
    const kind = req.params.kind
    if (kind !== 'orders' && kind !== 'shipping') {
      return res.status(400).json({ error: 'kind must be orders or shipping' })
    }
    const out = db.exportCsv(kind, req.query.snapshot || null)
    if (!out) return res.status(404).json({ error: 'Nothing to export (snapshot not found?)' })
    res.json(out)
  })

  return router
}
