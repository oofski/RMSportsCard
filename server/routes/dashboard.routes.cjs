// =============================================================================
// Dashboard & settings routes (spec §8 / §11 / §12)
// -----------------------------------------------------------------------------
//   GET   /api/dashboard   -> aggregated stats across both modules
//   GET   /api/settings    -> event name, break count, hasData flag
//   PATCH /api/settings    -> update event name / breaks per event
// =============================================================================

const express = require('express')

module.exports = function dashboardRoutes({ db, requireAuth }) {
  const router = express.Router()

  router.get('/dashboard', requireAuth, (_req, res) => {
    res.json(db.getDashboard())
  })

  router.get('/settings', requireAuth, (_req, res) => {
    res.json(db.getSettings())
  })

  router.patch('/settings', requireAuth, (req, res) => {
    res.json(db.updateSettings(req.body || {}))
  })

  return router
}
