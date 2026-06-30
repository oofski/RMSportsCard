// =============================================================================
// Whatnot Orders + Sales Dashboard routes
// -----------------------------------------------------------------------------
//   GET /api/whatnot-orders -> flat list of every order line item + customer
//   GET /api/sales          -> aggregated sales analytics for the event
// =============================================================================

const express = require('express')

module.exports = function whatnotRoutes({ db, requireAuth }) {
  const router = express.Router()

  router.get('/whatnot-orders', requireAuth, (_req, res) => {
    res.json(db.listWhatnotOrders())
  })

  router.get('/sales', requireAuth, (_req, res) => {
    res.json(db.getSalesDashboard())
  })

  return router
}
