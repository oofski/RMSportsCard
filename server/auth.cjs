// =============================================================================
// RM Cardz — Authentication & user management
// -----------------------------------------------------------------------------
// Implements the "create users" requirement. This is a local desktop app, so
// auth is lightweight: it identifies WHO is picking/packing and updating
// shipments (feeding checkedOffBy / setBy in the data model) and gates the
// user-management screen behind an admin role.
//
// Passwords are hashed with bcryptjs (pure JS — no native build step, keeping
// the Windows .exe cross-compile clean). Sessions are opaque in-memory tokens;
// they don't survive an app restart, which is fine for a single-machine tool.
//
// First-run bootstrap: if no users exist, the very first registration becomes
// the admin. This avoids shipping a hard-coded default password.
// =============================================================================

const crypto = require('node:crypto')
const bcrypt = require('bcryptjs')

const SALT_ROUNDS = 10

class Auth {
  /** @param {import('./store.cjs').Store} store */
  constructor(store) {
    this.store = store
    /** token -> { userId, createdAt } (in-memory only) */
    this.sessions = new Map()
  }

  get users() {
    return this.store.state.users
  }

  /** True when no accounts exist yet — drives the first-run "create admin" flow. */
  needsBootstrap() {
    return this.users.length === 0
  }

  _publicUser(u) {
    if (!u) return null
    const { passwordHash, ...rest } = u
    return rest
  }

  findByUsername(username) {
    const key = String(username || '').trim().toLowerCase()
    return this.users.find((u) => u.username.toLowerCase() === key) || null
  }

  /**
   * Create a user. The first user ever created is forced to admin (bootstrap).
   * @returns {{user: object}}
   */
  async createUser({ username, password, displayName, role }) {
    username = String(username || '').trim()
    if (!username) throw Object.assign(new Error('Username is required'), { status: 400 })
    if (!password || String(password).length < 4) {
      throw Object.assign(new Error('Password must be at least 4 characters'), { status: 400 })
    }
    if (this.findByUsername(username)) {
      throw Object.assign(new Error('That username already exists'), { status: 409 })
    }
    const isFirstUser = this.users.length === 0
    const user = {
      id: `user_${crypto.randomBytes(5).toString('hex')}`,
      username,
      displayName: String(displayName || username).trim(),
      role: isFirstUser ? 'admin' : role === 'admin' || role === 'staff' || role === 'picker' ? role : 'picker',
      passwordHash: await bcrypt.hash(String(password), SALT_ROUNDS),
      createdAt: new Date().toISOString(),
      lastLoginAt: null,
    }
    this.users.push(user)
    this.store.saveNow()
    return { user: this._publicUser(user) }
  }

  /** Verify credentials and open a session. */
  async login({ username, password }) {
    const user = this.findByUsername(username)
    if (!user) throw Object.assign(new Error('Invalid username or password'), { status: 401 })
    const ok = await bcrypt.compare(String(password || ''), user.passwordHash)
    if (!ok) throw Object.assign(new Error('Invalid username or password'), { status: 401 })
    user.lastLoginAt = new Date().toISOString()
    this.store.save()
    const token = crypto.randomBytes(24).toString('hex')
    this.sessions.set(token, { userId: user.id, createdAt: Date.now() })
    return { token, user: this._publicUser(user) }
  }

  logout(token) {
    this.sessions.delete(token)
  }

  /** Resolve a bearer token to its user, or null. */
  userForToken(token) {
    const session = token && this.sessions.get(token)
    if (!session) return null
    return this.users.find((u) => u.id === session.userId) || null
  }

  listUsers() {
    return this.users.map((u) => this._publicUser(u))
  }

  async updateUser(id, { displayName, role, password }) {
    const user = this.users.find((u) => u.id === id)
    if (!user) throw Object.assign(new Error('User not found'), { status: 404 })
    if (displayName !== undefined) user.displayName = String(displayName).trim()
    if (role !== undefined && ['admin', 'staff', 'picker'].includes(role)) user.role = role
    if (password) {
      if (String(password).length < 4) throw Object.assign(new Error('Password too short'), { status: 400 })
      user.passwordHash = await bcrypt.hash(String(password), SALT_ROUNDS)
    }
    this.store.saveNow()
    return this._publicUser(user)
  }

  deleteUser(id) {
    const idx = this.users.findIndex((u) => u.id === id)
    if (idx === -1) throw Object.assign(new Error('User not found'), { status: 404 })
    // Never allow deleting the last admin — the app must always have one.
    const target = this.users[idx]
    if (target.role === 'admin' && this.users.filter((u) => u.role === 'admin').length <= 1) {
      throw Object.assign(new Error('Cannot delete the only admin'), { status: 400 })
    }
    this.users.splice(idx, 1)
    this.store.saveNow()
    return { ok: true }
  }
}

module.exports = { Auth }
