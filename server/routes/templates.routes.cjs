// =============================================================================
// Sleeve-template routes — top-sleeve tagging (spec add-on)
// -----------------------------------------------------------------------------
//   GET    /api/sleeve-templates            -> list (metadata only)
//   POST   /api/sleeve-templates            -> create { name, sport, breaks }
//   GET    /api/sleeve-templates/:id        -> one template (with per-break teams)
//   PATCH  /api/sleeve-templates/:id        -> update { name?, breaks?, isDefault? }
//   DELETE /api/sleeve-templates/:id        -> delete
//   POST   /api/sleeve-templates/:id/apply  -> tag the current event's slots
//   POST   /api/sleeve-templates/:id/default-> make (or via {on:false} clear) default
//   POST   /api/sleeve-tags/clear           -> clear every top-sleeve tag
//
// A template marks, per break number, which teams get a toploader/sleeve. The
// team builder in the renderer draws from the sport's canonical list, so the
// stored names always match the parser's canonical slot names on apply.
// =============================================================================

const express = require('express')

module.exports = function templateRoutes({ db, requireAuth }) {
  const router = express.Router()

  router.get('/sleeve-templates', requireAuth, (_req, res) => {
    res.json(db.listSleeveTemplates())
  })

  router.post('/sleeve-templates', requireAuth, (req, res) => {
    const { name, sport, breaks } = req.body || {}
    const created = db.createSleeveTemplate({ name, sport, breaks })
    res.status(201).json(created)
  })

  router.get('/sleeve-templates/:id', requireAuth, (req, res) => {
    const t = db.getSleeveTemplate(req.params.id)
    if (!t) return res.status(404).json({ error: 'Template not found' })
    res.json(t)
  })

  router.patch('/sleeve-templates/:id', requireAuth, (req, res) => {
    const { name, breaks, isDefault } = req.body || {}
    const updated = db.updateSleeveTemplate(req.params.id, { name, breaks, isDefault })
    if (!updated) return res.status(404).json({ error: 'Template not found' })
    res.json(updated)
  })

  router.delete('/sleeve-templates/:id', requireAuth, (req, res) => {
    const result = db.deleteSleeveTemplate(req.params.id)
    if (!result.ok) return res.status(404).json({ error: 'Template not found' })
    res.json(result)
  })

  router.post('/sleeve-templates/:id/apply', requireAuth, (req, res) => {
    const result = db.applySleeveTemplate(req.params.id)
    if (!result) return res.status(404).json({ error: 'Template not found' })
    res.json(result)
  })

  router.post('/sleeve-templates/:id/default', requireAuth, (req, res) => {
    // { on:false } clears the default; anything else sets THIS template default.
    const on = !(req.body && req.body.on === false)
    const result = db.setDefaultSleeveTemplate(on ? req.params.id : null)
    if (!result) return res.status(404).json({ error: 'Template not found' })
    res.json(result)
  })

  router.post('/sleeve-tags/clear', requireAuth, (_req, res) => {
    res.json(db.clearSleeveTags())
  })

  return router
}
