// =============================================================================
// PDF parse routes (spec §5 / §12)
// -----------------------------------------------------------------------------
//   POST /api/parse                 -> { jobId, status, totalPages }
//   GET  /api/parse/status/:jobId   -> async job progress
//   GET  /api/summary               -> post-parse summary (landing screen)
//   POST /api/parse/demo            -> load bundled demo data (no PDF needed)
//
// Parsing runs as a background job (the 481-page PDF takes 10-30s), so the
// upload returns immediately with a jobId and the frontend polls for progress.
// =============================================================================

const express = require('express')
const multer = require('multer')

// Hold the PDF in memory (a few MB) — no temp files to clean up.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 200 * 1024 * 1024 } })

module.exports = function parseRoutes({ db, requireAuth }) {
  const router = express.Router()

  router.post('/parse', requireAuth, upload.single('file'), async (req, res, next) => {
    try {
      if (!req.file) return res.status(400).json({ error: 'No PDF file uploaded (field name: "file")' })

      // Lazy-require so a parser load error surfaces here, not at server boot.
      const { parsePdf } = require('../parser/index.cjs')

      // Sport picker: multer surfaces non-file text fields on req.body. 'auto'
      // (or absent) auto-detects the league (NFL / MLB / NBA) from the team names.
      const sport = (req.body && req.body.sport) || 'auto'

      const job = db.createParseJob({ filename: req.file.originalname, totalPages: 0 })

      // Kick off async parsing — do NOT await; respond with the jobId now.
      ;(async () => {
        try {
          const dataset = await parsePdf(req.file.buffer, {
            sport,
            onProgress: (p) => db.updateParseJob(job.id, {
              pagesProcessed: p.pagesProcessed || 0,
              totalPages: p.totalPages || job.totalPages,
              customersFound: p.customersFound || 0,
              breaksFound: p.breaksFound || 0,
            }),
          })
          db.importDataset(dataset, { filename: req.file.originalname })
          db.updateParseJob(job.id, {
            status: 'complete',
            pagesProcessed: dataset.totalPages || job.pagesProcessed,
            totalPages: dataset.totalPages || job.totalPages,
            customersFound: dataset.customers.length,
            breaksFound: dataset.breaks.length,
            errors: dataset.warnings || [],
          })
        } catch (err) {
          console.error('[parse] job failed:', err)
          db.updateParseJob(job.id, {
            status: 'error',
            errors: [{ page: 0, message: err.message, rawText: '' }],
          })
        }
      })()

      res.status(202).json({ jobId: job.id, status: 'processing', totalPages: job.totalPages })
    } catch (err) { next(err) }
  })

  router.get('/parse/status/:jobId', requireAuth, (req, res) => {
    const job = db.getParseJob(req.params.jobId)
    if (!job) return res.status(404).json({ error: 'Job not found' })
    res.json({
      status: job.status,
      pagesProcessed: job.pagesProcessed,
      totalPages: job.totalPages,
      customersFound: job.customersFound,
      breaksFound: job.breaksFound,
      errors: job.errors || [],
    })
  })

  router.get('/summary', requireAuth, (_req, res) => {
    res.json(db.summary())
  })

  // Load the bundled demo dataset (Appendix A) so the app is usable instantly
  // for evaluation, training, or screenshots without a real Whatnot PDF.
  router.post('/parse/demo', requireAuth, (_req, res, next) => {
    try {
      const { demoDataset } = require('../seed.cjs')
      db.importDataset(demoDataset(), { filename: 'demo-data' })
      res.json({ ok: true, summary: db.summary() })
    } catch (err) { next(err) }
  })

  return router
}
