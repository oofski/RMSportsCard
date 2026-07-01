// =============================================================================
// Auth & user-management routes
// -----------------------------------------------------------------------------
//   GET    /api/auth/status        -> { needsBootstrap }  (no auth)
//   POST   /api/auth/register      -> create user (open only during bootstrap)
//   POST   /api/auth/reset-admin   -> wipe all accounts -> first-run (no auth;
//                                     requires body { confirm: true })
//   POST   /api/auth/login         -> { token, user }
//   POST   /api/auth/logout        -> { ok }
//   GET    /api/auth/me            -> current user
//   GET    /api/users              -> list users        (admin)
//   POST   /api/users              -> create user       (admin)
//   PATCH  /api/users/:id          -> update user       (admin)
//   DELETE /api/users/:id          -> delete user       (admin)
// =============================================================================

const express = require('express')

module.exports = function authRoutes({ auth, requireAuth, requireAdmin }) {
  const router = express.Router()

  // Tells the UI whether to show the first-run "create admin" screen.
  router.get('/auth/status', (_req, res) => {
    res.json({ needsBootstrap: auth.needsBootstrap() })
  })

  // Open registration is permitted ONLY before the first account exists (it
  // creates the admin). After that, accounts are created by an admin via /users.
  router.post('/auth/register', async (req, res, next) => {
    try {
      if (!auth.needsBootstrap()) {
        return res.status(403).json({ error: 'Registration is closed. Ask an admin to create your account.' })
      }
      const { user } = await auth.createUser(req.body || {})
      res.status(201).json({ user })
    } catch (err) { next(err) }
  })

  // Destructive "forgot password" recovery: clears ALL accounts (and live
  // sessions) so the app returns to the first-run "create the admin" flow.
  // Deliberately UNAUTHENTICATED — a locked-out user has no token, and the
  // datastore is local (physical access is the real trust boundary). The
  // explicit { confirm: true } flag guards against accidental calls.
  router.post('/auth/reset-admin', (req, res) => {
    if (!req.body || req.body.confirm !== true) {
      return res.status(400).json({ error: 'Reset requires explicit confirmation.' })
    }
    res.json(auth.resetToBootstrap())
  })

  router.post('/auth/login', async (req, res, next) => {
    try {
      const result = await auth.login(req.body || {})
      res.json(result)
    } catch (err) { next(err) }
  })

  router.post('/auth/logout', (req, res) => {
    if (req.token) auth.logout(req.token)
    res.json({ ok: true })
  })

  router.get('/auth/me', requireAuth, (req, res) => {
    const { passwordHash, ...user } = req.user
    res.json({ user })
  })

  // ---- Admin-only user management -----------------------------------------
  router.get('/users', requireAdmin, (_req, res) => {
    res.json(auth.listUsers())
  })

  router.post('/users', requireAdmin, async (req, res, next) => {
    try {
      const { user } = await auth.createUser(req.body || {})
      res.status(201).json({ user })
    } catch (err) { next(err) }
  })

  router.patch('/users/:id', requireAdmin, async (req, res, next) => {
    try {
      const user = await auth.updateUser(req.params.id, req.body || {})
      res.json({ user })
    } catch (err) { next(err) }
  })

  router.delete('/users/:id', requireAdmin, (req, res, next) => {
    try {
      // An admin may not delete their own account from under themselves.
      if (req.params.id === req.user.id) {
        return res.status(400).json({ error: 'You cannot delete your own account while signed in.' })
      }
      res.json(auth.deleteUser(req.params.id))
    } catch (err) { next(err) }
  })

  return router
}
