// =============================================================================
// Break Checklist routes — Module A (spec §6 / §12)
// -----------------------------------------------------------------------------
//   GET   /api/breaks               -> break list with pick progress
//   GET   /api/breaks/:id           -> one break's team-slot pick list
//   PATCH /api/teamslot/:id         -> toggle a checkbox  { checkedOff }
//   POST  /api/breaks/:id/pack      -> mark break packed (completion flow)
//   POST  /api/breaks/:id/clear     -> clear all checkboxes in a break
// =============================================================================

const express = require('express')

module.exports = function breakRoutes({ db, requireAuth }) {
  const router = express.Router()

  router.get('/breaks', requireAuth, (_req, res) => {
    res.json(db.listBreaks())
  })

  router.get('/breaks/:id', requireAuth, (req, res) => {
    const data = db.getBreak(req.params.id)
    if (!data) return res.status(404).json({ error: 'Break not found' })
    res.json(data)
  })

  router.patch('/teamslot/:id', requireAuth, (req, res) => {
    const updated = db.setTeamSlotChecked(req.params.id, !!req.body.checkedOff, req.user)
    if (!updated) return res.status(404).json({ error: 'Team slot not found' })
    res.json(updated)
  })

  router.post('/breaks/:id/pack', requireAuth, (req, res) => {
    const result = db.markBreakPacked(req.params.id)
    if (!result) return res.status(404).json({ error: 'Break not found' })
    res.json(result)
  })

  router.post('/breaks/:id/clear', requireAuth, (req, res) => {
    const result = db.clearBreak(req.params.id)
    if (!result) return res.status(404).json({ error: 'Break not found' })
    res.json(result)
  })

  return router
}
