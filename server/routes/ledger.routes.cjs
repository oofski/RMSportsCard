// =============================================================================
// Whatnot Ledger CSV routes (Sales Dashboard analytics)
// -----------------------------------------------------------------------------
//   POST   /api/ledger           { filename, csv } -> import + analyze
//   GET    /api/ledger           ?breaksPerCase=N  -> current analysis
//   PATCH  /api/ledger/settings  { breaksPerCase }  -> persist case size
//   DELETE /api/ledger                              -> clear uploaded ledger
//
// All endpoints require authentication. The heavy lifting lives in db.cjs /
// ledger.cjs; these handlers only validate input and shuttle JSON.
// =============================================================================

const express = require('express')

module.exports = function ledgerRoutes({ db, requireAuth }) {
  const router = express.Router()

  // Upload + parse a ledger CSV. Body: { filename, csv }.
  router.post('/ledger', requireAuth, (req, res) => {
    const { filename, csv } = req.body || {}
    if (typeof csv !== 'string' || csv.trim() === '') {
      return res.status(400).json({ error: 'csv must be a non-empty string' })
    }
    res.json(db.importLedger(csv, filename))
  })

  // Read the current analysis, optionally previewing a different case size.
  router.get('/ledger', requireAuth, (req, res) => {
    const raw = req.query.breaksPerCase
    const bpc = raw != null && raw !== '' ? Number(raw) : undefined
    res.json(db.getLedgerAnalysis(Number.isFinite(bpc) ? bpc : undefined))
  })

  // Persist a new breaksPerCase setting.
  router.patch('/ledger/settings', requireAuth, (req, res) => {
    const { breaksPerCase } = req.body || {}
    res.json(db.setLedgerBreaksPerCase(Number(breaksPerCase)))
  })

  // Drop the uploaded ledger.
  router.delete('/ledger', requireAuth, (_req, res) => {
    res.json(db.clearLedger())
  })

  return router
}
