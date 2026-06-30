// =============================================================================
// Orders / Fulfillment Queue routes — Planner view
// -----------------------------------------------------------------------------
//   GET   /api/orders               -> per-order (per-package) queue rows
//   PATCH /api/orders/:id/stage     -> advance/revert  { stage }
//   PATCH /api/orders/:id/hold      -> pause/resume     { onHold, reason? }
//   PATCH /api/orders/:id/move      -> reorder queue    { direction: 'up'|'down' }
//
// Picking individual teams still uses PATCH /api/teamslot/:id (shared with the
// Checker view). Stage 'sent'/'all_good' write the shipment's manualStatus, so
// the Shipping Tracker reflects them automatically (one source of truth).
// =============================================================================

const express = require('express')

module.exports = function orderRoutes({ db, requireAuth }) {
  const router = express.Router()

  router.get('/orders', requireAuth, (_req, res) => {
    res.json(db.listOrders())
  })

  router.patch('/orders/:id/stage', requireAuth, (req, res, next) => {
    try {
      const row = db.setOrderStage(req.params.id, req.body && req.body.stage, req.user)
      if (!row) return res.status(404).json({ error: 'Order not found' })
      res.json(row)
    } catch (err) { next(err) }
  })

  router.patch('/orders/:id/hold', requireAuth, (req, res) => {
    const { onHold, reason } = req.body || {}
    const row = db.setOrderHold(req.params.id, !!onHold, reason, req.user)
    if (!row) return res.status(404).json({ error: 'Order not found' })
    res.json(row)
  })

  router.patch('/orders/:id/move', requireAuth, (req, res) => {
    const dir = req.body && req.body.direction === 'up' ? 'up' : 'down'
    const row = db.moveOrder(req.params.id, dir)
    if (!row) return res.status(404).json({ error: 'Order not found' })
    res.json(row)
  })

  return router
}
