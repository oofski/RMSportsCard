// =============================================================================
// Shipping Tracker routes — Module B (spec §7 / §12)
// -----------------------------------------------------------------------------
//   GET   /api/shipments               -> all shipments + manual status + breaks
//   PATCH /api/shipments/:id           -> update manual status and/or notes
//   GET   /api/shipments/batch-urls    -> precomputed USPS bulk-lookup URLs
//   GET   /api/shipments/tracking-numbers -> all tracking #s (for "Copy All")
// =============================================================================

const express = require('express')

module.exports = function shipmentRoutes({ db, requireAuth }) {
  const router = express.Router()

  router.get('/shipments', requireAuth, (_req, res) => {
    res.json(db.listShipments())
  })

  // NOTE: declare the specific paths BEFORE '/shipments/:id' so Express does
  // not treat "batch-urls" / "tracking-numbers" as an :id.
  router.get('/shipments/batch-urls', requireAuth, (_req, res) => {
    res.json(db.getBatchUrls())
  })

  router.get('/shipments/tracking-numbers', requireAuth, (_req, res) => {
    res.json({ trackingNumbers: db.allTrackingNumbers() })
  })

  router.patch('/shipments/:id', requireAuth, (req, res, next) => {
    try {
      const { manualStatus, notes } = req.body || {}
      const updated = db.updateShipment(req.params.id, { manualStatus, notes }, req.user)
      if (!updated) return res.status(404).json({ error: 'Shipment not found' })
      res.json(updated)
    } catch (err) { next(err) }
  })

  return router
}
