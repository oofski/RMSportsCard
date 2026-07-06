// =============================================================================
// RM Cardz — Data access layer
// -----------------------------------------------------------------------------
// Domain operations on top of the JSON Store. Route handlers call these; they
// never touch the raw store. Every mutation persists (debounced) automatically.
//
// The normalized data shape produced by the PDF parser (see server/parser) and
// consumed by importDataset() is:
//   {
//     event:      { name, date },
//     breaks:     [{ id, breakNumber, eventName, eventDate, status }],
//     teamSlots:  [{ id, breakId, breakNumber, teamName, customerId, orderId,
//                    price, isGiveaway, checkedOff, checkedOffAt, checkedOffBy }],
//     customers:  [{ id, whatnotHandle, realName, address, isNew }],
//     shipments:  [{ id, customerId, trackingNumber, carrier, serviceType,
//                    weightOz, uspsUrl, manualStatus, notes, lastUpdated }],
//     orders:     [{ id, customerId, breakId, breakNumber, teamName, price, isGiveaway }],
//     batchUrls:  [{ batchNumber, count, url }],
//     warnings:   [{ page, message, rawText }]
//   }
// =============================================================================

const crypto = require('node:crypto')
const reference = require('../shared/reference.json')
const { ordersCsv, shippingCsv } = require('./csv.cjs')
const { parseLedgerRows, analyzeLedger } = require('./ledger.cjs')
const { listTeams, normalizeSport } = require('./parser/teams.cjs')

const VALID_SHIPMENT_CODES = reference.shipmentStatuses.map((s) => s.code)
const EXCEPTION_CODES = reference.shipmentStatuses.filter((s) => s.isException).map((s) => s.code)

const now = () => new Date().toISOString()

class Db {
  /** @param {import('./store.cjs').Store} store */
  constructor(store) {
    this.store = store
  }

  get state() {
    return this.store.state
  }

  // ---------------------------------------------------------------------------
  // Import — load a freshly parsed dataset, preserving the user table.
  // ---------------------------------------------------------------------------
  importDataset(dataset, { filename } = {}) {
    const s = this.store.state
    s.meta.importedAt = now()
    s.meta.event = dataset.event || { name: null, date: null }
    // Which league this import was parsed as ('nfl' | 'mlb'). Defaults to NFL so
    // datasets from older parsers (no sport field) behave exactly as before.
    s.meta.sport = dataset.sport || 'nfl'
    s.breaks = dataset.breaks || []
    s.teamSlots = dataset.teamSlots || []
    s.customers = dataset.customers || []
    s.shipments = dataset.shipments || []
    s.orders = dataset.orders || []
    s.batchUrls = dataset.batchUrls || []
    s.warnings = dataset.warnings || []
    s.breakAudit = dataset.breakAudit || []
    if (filename) s.meta.lastImportFilename = filename
    // A fresh import starts untagged; a default template (if one matches this
    // sport) re-applies its top-sleeve marks automatically.
    s.meta.appliedSleeveTemplateId = null
    s.meta.appliedSleeveTemplateName = null
    const def = s.meta.defaultSleeveTemplateId
      ? s.sleeveTemplates.find((t) => t.id === s.meta.defaultSleeveTemplateId)
      : null
    if (def && def.sport === (s.meta.sport || 'nfl')) {
      this._applyTemplateToSlots(def)
    }
    this.store.saveNow()
    return this.summary()
  }

  /** Post-parse summary shown on the landing screen (spec §5.6). */
  summary() {
    const s = this.store.state
    const totalRevenue = s.orders.reduce((sum, o) => sum + (Number(o.price) || 0), 0)
    return {
      event: s.meta.event,
      sport: s.meta.sport || 'nfl',
      importedAt: s.meta.importedAt,
      customers: s.customers.length,
      breaks: s.breaks.length,
      totalOrders: s.orders.length,
      totalRevenue: Math.round(totalRevenue * 100) / 100,
      trackingNumbers: s.shipments.length,
      warnings: s.warnings.length,
      // Fidelity at a glance: how many breaks are missing teams vs the full 32,
      // and how many one-team-per-break collisions were detected on import.
      breaksMissingTeams: (s.breakAudit || []).filter((b) => !b.hasAll32).length,
      breakCollisions: (s.breakAudit || []).reduce((sum, b) => sum + ((b.collisions && b.collisions.length) || 0), 0),
      // Top-sleeve tagging at a glance: how many slots are tagged and which
      // template (if any) is currently applied.
      topSleevedSlots: s.teamSlots.filter((t) => t.topSleeved).length,
      appliedTemplate: s.meta.appliedSleeveTemplateId
        ? { id: s.meta.appliedSleeveTemplateId, name: s.meta.appliedSleeveTemplateName }
        : null,
    }
  }

  hasData() {
    return this.store.state.breaks.length > 0 || this.store.state.shipments.length > 0
  }

  // ---------------------------------------------------------------------------
  // Breaks (Module A)
  // ---------------------------------------------------------------------------
  listBreaks() {
    const s = this.store.state
    const auditByNumber = new Map((s.breakAudit || []).map((a) => [a.breakNumber, a]))
    return s.breaks
      .map((b) => {
        const slots = s.teamSlots.filter((t) => t.breakId === b.id)
        const checked = slots.filter((t) => t.checkedOff).length
        const topSleeved = slots.filter((t) => t.topSleeved).length
        const audit = auditByNumber.get(b.breakNumber) || null
        return {
          id: b.id,
          breakNumber: b.breakNumber,
          eventName: b.eventName,
          eventDate: b.eventDate,
          totalTeams: slots.length, // actual SOLD slots, not the 32 max (spec §13)
          checkedTeams: checked,
          topSleevedTeams: topSleeved, // how many slots this template tagged
          status: b.status,
          // Fidelity: how complete this break is vs the full 32-team NFL slate,
          // which teams are missing, and any one-team-per-break collisions. Null
          // audit (older imports) degrades gracefully on the UI side.
          maxTeams: audit ? audit.maxTeams : 32,
          missingCount: audit ? audit.missingCount : null,
          missingTeams: audit ? audit.missingTeams : [],
          hasAll32: audit ? audit.hasAll32 : null,
          collisions: audit ? audit.collisions : [],
        }
      })
      .sort((a, b) => a.breakNumber - b.breakNumber)
  }

  getBreak(breakId) {
    const s = this.store.state
    const b = s.breaks.find((x) => x.id === breakId)
    if (!b) return null
    const slots = s.teamSlots
      .filter((t) => t.breakId === breakId)
      .map((t) => {
        const customer = s.customers.find((c) => c.id === t.customerId)
        return {
          id: t.id,
          teamName: t.teamName,
          checkedOff: !!t.checkedOff,
          checkedOffAt: t.checkedOffAt || null,
          checkedOffBy: t.checkedOffBy || null,
          topSleeved: !!t.topSleeved,
          orderId: t.orderId,
          price: t.price,
          isGiveaway: !!t.isGiveaway,
          customer: customer
            ? { handle: customer.whatnotHandle, realName: customer.realName, address: customer.address }
            : { handle: t.customerId, realName: t.customerId, address: '' },
        }
      })
      // Unchecked first (for the picker), then checked sink to the bottom;
      // within each group keep alphabetical team order.
      .sort((a, b2) => {
        if (a.checkedOff !== b2.checkedOff) return a.checkedOff ? 1 : -1
        return a.teamName.localeCompare(b2.teamName)
      })
    return {
      id: b.id,
      breakNumber: b.breakNumber,
      eventName: b.eventName,
      eventDate: b.eventDate,
      status: b.status,
      totalTeams: slots.length,
      checkedTeams: slots.filter((x) => x.checkedOff).length,
      teamSlots: slots,
    }
  }

  /** Toggle a single team slot's checkbox and recompute its break's status. */
  setTeamSlotChecked(slotId, checkedOff, user) {
    const s = this.store.state
    const slot = s.teamSlots.find((t) => t.id === slotId)
    if (!slot) return null
    slot.checkedOff = !!checkedOff
    slot.checkedOffAt = checkedOff ? now() : null
    slot.checkedOffBy = checkedOff ? (user && user.username) || null : null
    this._recomputeBreakStatus(slot.breakId)
    this.store.save()
    return {
      id: slot.id,
      checkedOff: slot.checkedOff,
      checkedOffAt: slot.checkedOffAt,
      checkedOffBy: slot.checkedOffBy,
    }
  }

  /** Explicitly mark a break packed (spec §6.4 completion flow). */
  markBreakPacked(breakId) {
    const b = this.store.state.breaks.find((x) => x.id === breakId)
    if (!b) return null
    b.status = 'packed'
    this.store.saveNow()
    return this.listBreaks().find((x) => x.id === breakId)
  }

  /** Clear every checkbox in a break (spec §6.3 "Clear All"). */
  clearBreak(breakId) {
    const s = this.store.state
    s.teamSlots.filter((t) => t.breakId === breakId).forEach((t) => {
      t.checkedOff = false
      t.checkedOffAt = null
      t.checkedOffBy = null
    })
    this._recomputeBreakStatus(breakId)
    this.store.saveNow()
    return this.getBreak(breakId)
  }

  /** Derive pending/picking from progress, but never override an explicit packed/shipped. */
  _recomputeBreakStatus(breakId) {
    const s = this.store.state
    const b = s.breaks.find((x) => x.id === breakId)
    if (!b) return
    const slots = s.teamSlots.filter((t) => t.breakId === breakId)
    const checked = slots.filter((t) => t.checkedOff).length
    if (b.status === 'shipped') return
    if (checked === 0) b.status = 'pending'
    else if (slots.length > 0 && checked >= slots.length) b.status = b.status === 'packed' ? 'packed' : 'picking'
    else b.status = 'picking'
  }

  // ---------------------------------------------------------------------------
  // Sleeve templates (top-sleeve tagging)
  // ---------------------------------------------------------------------------
  // A template records, per break NUMBER, which teams get a toploader/sleeve.
  // Applying it stamps teamSlot.topSleeved so the pick screen shows which cards
  // need extra protection. Templates are sport-scoped (the team list differs by
  // league) and reusable across events; they survive PDF re-imports.

  /** Keep only valid break numbers + known teams for the sport; de-dupe. */
  _sanitizeTemplateBreaks(breaks, sport) {
    const valid = new Set(listTeams(sport))
    const out = {}
    if (breaks && typeof breaks === 'object') {
      for (const [k, teams] of Object.entries(breaks)) {
        const n = parseInt(k, 10)
        if (!Number.isInteger(n) || n < 1) continue
        if (!Array.isArray(teams)) continue
        const seen = new Set()
        const kept = []
        for (const t of teams) {
          if (valid.has(t) && !seen.has(t)) { seen.add(t); kept.push(t) }
        }
        if (kept.length) out[n] = kept
      }
    }
    return out
  }

  /** Public-shape metadata for one template (no per-break detail). */
  _templateMeta(t) {
    const s = this.store.state
    const teamCount = Object.values(t.breaks || {}).reduce((sum, arr) => sum + arr.length, 0)
    return {
      id: t.id,
      name: t.name,
      sport: t.sport,
      breakCount: Object.keys(t.breaks || {}).length,
      teamCount,
      isDefault: s.meta.defaultSleeveTemplateId === t.id,
      isApplied: s.meta.appliedSleeveTemplateId === t.id,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
    }
  }

  listSleeveTemplates() {
    return this.store.state.sleeveTemplates.map((t) => this._templateMeta(t))
  }

  getSleeveTemplate(id) {
    const t = this.store.state.sleeveTemplates.find((x) => x.id === id)
    if (!t) return null
    return { ...this._templateMeta(t), breaks: t.breaks || {} }
  }

  createSleeveTemplate({ name, sport, breaks } = {}) {
    const s = this.store.state
    const code = normalizeSport(sport)
    const t = {
      id: `tmpl_${crypto.randomBytes(6).toString('hex')}`,
      name: (name && String(name).trim()) || 'Untitled template',
      sport: code,
      breaks: this._sanitizeTemplateBreaks(breaks, code),
      createdAt: now(),
      updatedAt: now(),
    }
    s.sleeveTemplates.push(t)
    this.store.saveNow()
    return this.getSleeveTemplate(t.id)
  }

  updateSleeveTemplate(id, { name, breaks, isDefault } = {}) {
    const s = this.store.state
    const t = s.sleeveTemplates.find((x) => x.id === id)
    if (!t) return null
    if (name !== undefined) t.name = String(name).trim() || t.name
    // Re-sanitize against the template's OWN sport (sport itself is immutable
    // once created — the team list it was built from can't change under it).
    if (breaks !== undefined) t.breaks = this._sanitizeTemplateBreaks(breaks, t.sport)
    if (isDefault !== undefined) {
      if (isDefault) s.meta.defaultSleeveTemplateId = t.id
      else if (s.meta.defaultSleeveTemplateId === t.id) s.meta.defaultSleeveTemplateId = null
    }
    t.updatedAt = now()
    this.store.saveNow()
    return this.getSleeveTemplate(id)
  }

  setDefaultSleeveTemplate(id) {
    const s = this.store.state
    if (id && !s.sleeveTemplates.find((x) => x.id === id)) return null
    s.meta.defaultSleeveTemplateId = id || null
    this.store.saveNow()
    return this.listSleeveTemplates()
  }

  deleteSleeveTemplate(id) {
    const s = this.store.state
    const idx = s.sleeveTemplates.findIndex((x) => x.id === id)
    if (idx === -1) return { ok: false }
    s.sleeveTemplates.splice(idx, 1)
    if (s.meta.defaultSleeveTemplateId === id) s.meta.defaultSleeveTemplateId = null
    if (s.meta.appliedSleeveTemplateId === id) {
      s.meta.appliedSleeveTemplateId = null
      s.meta.appliedSleeveTemplateName = null
    }
    this.store.saveNow()
    return { ok: true }
  }

  /** Core: stamp topSleeved on every slot per the template (full overwrite). */
  _applyTemplateToSlots(t) {
    const s = this.store.state
    let tagged = 0
    const affected = new Set()
    for (const slot of s.teamSlots) {
      // JSON object keys are strings; slot.breakNumber is a number — property
      // access coerces, but we check both forms to be safe.
      const teams = t.breaks[slot.breakNumber] || t.breaks[String(slot.breakNumber)] || []
      const on = teams.includes(slot.teamName)
      slot.topSleeved = on
      if (on) { tagged += 1; affected.add(slot.breakNumber) }
    }
    s.meta.appliedSleeveTemplateId = t.id
    s.meta.appliedSleeveTemplateName = t.name
    return { tagged, breaksAffected: affected.size }
  }

  /** Apply a saved template to the current event's slots. */
  applySleeveTemplate(id) {
    const s = this.store.state
    const t = s.sleeveTemplates.find((x) => x.id === id)
    if (!t) return null
    const res = this._applyTemplateToSlots(t)
    this.store.saveNow()
    return {
      templateId: t.id,
      templateName: t.name,
      templateSport: t.sport,
      eventSport: s.meta.sport || 'nfl',
      // A template built for the other league won't match any team names — flag
      // it so the UI can explain a "0 tagged" result instead of looking broken.
      sportMismatch: t.sport !== (s.meta.sport || 'nfl'),
      totalSlots: s.teamSlots.length,
      ...res,
    }
  }

  /** Clear every top-sleeve tag and forget which template was applied. */
  clearSleeveTags() {
    const s = this.store.state
    s.teamSlots.forEach((t) => { t.topSleeved = false })
    s.meta.appliedSleeveTemplateId = null
    s.meta.appliedSleeveTemplateName = null
    this.store.saveNow()
    return { ok: true }
  }

  /** Manual per-slot top-sleeve toggle from the pick screen. */
  setTeamSlotTopSleeved(slotId, value) {
    const slot = this.store.state.teamSlots.find((t) => t.id === slotId)
    if (!slot) return null
    slot.topSleeved = !!value
    this.store.save()
    return { id: slot.id, topSleeved: slot.topSleeved }
  }

  // ---------------------------------------------------------------------------
  // Shipments (Module B)
  // ---------------------------------------------------------------------------
  listShipments() {
    const s = this.store.state
    return s.shipments.map((sh) => this._shipmentView(sh))
  }

  _shipmentView(sh) {
    const s = this.store.state
    const customer = s.customers.find((c) => c.id === sh.customerId)
    // Group this customer's orders by break for the detail drawer (spec §7.3).
    const byBreak = new Map()
    s.orders
      .filter((o) => o.customerId === sh.customerId)
      .forEach((o) => {
        if (!byBreak.has(o.breakNumber)) byBreak.set(o.breakNumber, [])
        byBreak.get(o.breakNumber).push(o.teamName)
      })
    const breaks = [...byBreak.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([breakNumber, teams]) => ({ breakNumber, teams }))
    return {
      id: sh.id,
      customer: customer
        ? { handle: customer.whatnotHandle, realName: customer.realName, address: customer.address, isNew: !!customer.isNew }
        : { handle: sh.customerId, realName: sh.customerId, address: '', isNew: false },
      trackingNumber: sh.trackingNumber,
      carrier: sh.carrier || 'USPS',
      serviceType: sh.serviceType,
      weightOz: sh.weightOz,
      uspsUrl: sh.uspsUrl,
      manualStatus: sh.manualStatus || { code: 'not_shipped', setAt: null, setBy: null },
      isException: EXCEPTION_CODES.includes((sh.manualStatus && sh.manualStatus.code) || 'not_shipped'),
      notes: sh.notes || null,
      lastUpdated: sh.lastUpdated || null,
      lastCheckedAt: sh.lastCheckedAt || null,
      breaks,
    }
  }

  // ---------------------------------------------------------------------------
  // Tracking rotation — pick which shipments a single auto-check run should read.
  // -----------------------------------------------------------------------------
  // USPS rate-limits the keyless scraper: after ~20 lookups in one session it
  // starts serving bot challenges, so a 100-package event can never finish in one
  // pass. The fix is to read a SMALL batch of the STALEST non-final packages per
  // run and rotate — the background auto-refresh then covers everyone over a few
  // cycles without tripping the block. Delivered/returned packages are skipped
  // (their status is final, so re-checking them just wastes the budget).
  // ---------------------------------------------------------------------------
  /** Non-final shipments that still have a tracking number (the work set). */
  _activeTrackingShipments() {
    const FINAL = ['delivered', 'returned']
    return this.store.state.shipments.filter((sh) => {
      if (!sh.trackingNumber) return false
      const code = (sh.manualStatus && sh.manualStatus.code) || 'not_shipped'
      return !FINAL.includes(code)
    })
  }

  /** Count of packages still worth auto-checking (for "checked N of M" messaging). */
  activeTrackingCount() {
    return this._activeTrackingShipments().length
  }

  /**
   * The next batch to auto-check: the least-recently-checked active shipments,
   * capped to `limit` (0 / falsy = all). Never-checked rows sort first, so a
   * fresh import is covered before anything is re-checked.
   * @returns {Array<{id:string, trackingNumber:string}>}
   */
  shipmentsForTracking({ limit = 0 } = {}) {
    const active = this._activeTrackingShipments().slice().sort((a, b) => {
      const ta = a.lastCheckedAt ? Date.parse(a.lastCheckedAt) : 0
      const tb = b.lastCheckedAt ? Date.parse(b.lastCheckedAt) : 0
      return ta - tb
    })
    const picked = limit && limit > 0 ? active.slice(0, limit) : active
    return picked.map((sh) => ({ id: sh.id, trackingNumber: sh.trackingNumber }))
  }

  /**
   * Stamp lastCheckedAt on every shipment we just ATTEMPTED (read, blocked, or
   * failed) so the rotation advances even when USPS blocked the read. Called by
   * the Electron main process right after a provider run.
   */
  markShipmentsChecked(trackingNumbers) {
    const set = new Set(trackingNumbers || [])
    if (set.size === 0) return 0
    const ts = now()
    let n = 0
    for (const sh of this.store.state.shipments) {
      if (sh.trackingNumber && set.has(sh.trackingNumber)) {
        sh.lastCheckedAt = ts
        n += 1
      }
    }
    if (n) this.store.saveNow()
    return n
  }

  updateShipment(shipmentId, { manualStatus, notes }, user) {
    const sh = this.store.state.shipments.find((x) => x.id === shipmentId)
    if (!sh) return null
    if (manualStatus !== undefined) {
      if (!VALID_SHIPMENT_CODES.includes(manualStatus)) {
        throw Object.assign(new Error(`Invalid status code: ${manualStatus}`), { status: 400 })
      }
      sh.manualStatus = { code: manualStatus, setAt: now(), setBy: (user && user.username) || null }
    }
    if (notes !== undefined) sh.notes = notes
    sh.lastUpdated = now()
    this.store.save()
    return this._shipmentView(sh)
  }

  getBatchUrls() {
    const s = this.store.state
    return {
      totalPackages: s.shipments.length,
      batches: s.batchUrls,
    }
  }

  allTrackingNumbers() {
    return this.store.state.shipments.map((s) => s.trackingNumber).filter(Boolean)
  }

  /**
   * Auto-tracking: bulk-update statuses by tracking number (called by the
   * Electron main process after a provider lookup). Enforces the spec's "manual
   * status is truth" rule (§13) — an automatic scan must never overwrite a status
   * an operator DELIBERATELY chose — but with one deliberate exception so genuine
   * carrier progress is never lost:
   *
   *   A row that is still in a PRE-SHIP state (`not_shipped` / `label_created`)
   *   may always be advanced FORWARD by a real carrier scan, even if a human set
   *   that pre-ship state. This matters because the unified Orders queue stamps a
   *   human `setBy` of `not_shipped` when an operator merely PACKS an order (a
   *   "to_pick"/"put_together" stage); that is "I packed it", NOT "freeze this
   *   row forever". Without this exception a packed-then-shipped package stays
   *   stuck on "Not Shipped" because auto-tracking refuses to write `in_transit`.
   *
   * A human who forced a terminal/shipping decision (delivered/returned/
   * exception/in_transit/out_for_delivery) is still fully protected.
   *
   * Auto markers ('auto' | '17track' | 'usps') count as non-human so a previous
   * automatic write never blocks the next one. ('usps' is the default-scraper
   * marker — it MUST be whitelisted here, or the scraper would lock itself out
   * after its first write and could only ever advance a row once.)
   *
   * @param {Record<string,string>} map trackingNumber -> status code
   */
  bulkSetShipmentStatusByTracking(map, { by = 'auto' } = {}) {
    const s = this.store.state
    // Markers for an automatic (non-human) write. 'usps' is the default scrape
    // provider's marker (see electron/main.cjs) — omitting it self-locks the scraper.
    const AUTO_SETTERS = ['auto', '17track', 'usps']
    // Pre-ship codes a carrier scan is always allowed to advance forward, even
    // when a human set them while packing (packing is not a "freeze" decision).
    const PRESHIP = ['not_shipped', 'label_created']
    // Real carrier-progress target codes (a forward scan moves a row INTO one).
    const CARRIER = ['label_created', 'in_transit', 'out_for_delivery', 'delivered', 'exception', 'returned']
    let updated = 0
    let unchanged = 0
    let kept = 0 // manual statuses intentionally left untouched
    for (const sh of s.shipments) {
      const code = map && map[sh.trackingNumber]
      if (!code) continue
      if (!VALID_SHIPMENT_CODES.includes(code)) continue
      const cur = sh.manualStatus || {}
      if (cur.code === code) { unchanged += 1; continue }
      // Manual is truth: a status set by a real user (setBy is a username, not an
      // auto marker) is normally left alone. Unset (null) or auto-set rows are
      // always fair game.
      const humanSet = cur.setBy && !AUTO_SETTERS.includes(cur.setBy)
      // ...EXCEPT a genuine carrier scan may advance a human pre-ship row forward
      // (e.g. a packed "not_shipped" order that has now actually shipped).
      const forwardFromPreship = PRESHIP.includes(cur.code) && CARRIER.includes(code)
      if (humanSet && !forwardFromPreship) { kept += 1; continue }
      sh.manualStatus = { code, setAt: now(), setBy: by }
      sh.lastUpdated = now()
      updated += 1
    }
    // Record WHEN we last synced from a carrier, regardless of whether anything
    // changed — so the UI can show a "last checked" freshness time and the
    // background auto-refresh can pace itself. Persist even on a zero-update sync.
    this.store.state.meta.lastTrackingSyncAt = now()
    this.store.saveNow()
    return { updated, matched: Object.keys(map || {}).length, unchanged, kept, lastTrackingSyncAt: this.store.state.meta.lastTrackingSyncAt }
  }

  // ---------------------------------------------------------------------------
  // Orders / Fulfillment Queue (Planner view)
  // -----------------------------------------------------------------------------
  // One row per customer PACKAGE (= shipment), which is the unit that actually
  // ships under a single tracking number. Each row carries that customer's
  // breaks + teams (the pick detail), a pick progress count, and a single
  // "fulfillment stage" that unifies pick/pack with shipping so Sent/All Good
  // ARE the shipment's manualStatus (one source of truth with Module B).
  //
  // Stage derivation (manualStatus is authoritative for shipping states):
  //   returned/exception            -> that stage
  //   delivered                     -> all_good
  //   in_transit/out_for_delivery   -> sent
  //   not_shipped + packedAt set    -> put_together
  //   not_shipped + not packed      -> to_pick
  // ---------------------------------------------------------------------------
  _deriveStage(sh) {
    const code = (sh.manualStatus && sh.manualStatus.code) || 'not_shipped'
    if (code === 'returned') return 'returned'
    if (code === 'exception') return 'exception'
    if (code === 'delivered') return 'all_good'
    if (code === 'in_transit' || code === 'out_for_delivery') return 'sent'
    return sh.packedAt ? 'put_together' : 'to_pick'
  }

  /** Ensure every shipment has a stable integer queue position for manual ordering. */
  _ensureQueueOrder() {
    const s = this.store.state
    let max = 0
    s.shipments.forEach((sh) => { if (typeof sh.queueOrder === 'number') max = Math.max(max, sh.queueOrder) })
    s.shipments.forEach((sh) => { if (typeof sh.queueOrder !== 'number') sh.queueOrder = ++max })
  }

  _orderRow(sh) {
    const s = this.store.state
    const customer = s.customers.find((c) => c.id === sh.customerId)
    const slots = s.teamSlots.filter((t) => t.customerId === sh.customerId)
    const byBreak = new Map()
    slots.forEach((t) => {
      if (!byBreak.has(t.breakNumber)) byBreak.set(t.breakNumber, [])
      byBreak.get(t.breakNumber).push({ slotId: t.id, teamName: t.teamName, checkedOff: !!t.checkedOff, topSleeved: !!t.topSleeved, orderId: t.orderId })
    })
    const breaks = [...byBreak.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([breakNumber, teams]) => ({ breakNumber, teams: teams.sort((x, y) => x.teamName.localeCompare(y.teamName)) }))
    const checked = slots.filter((t) => t.checkedOff).length
    return {
      id: sh.id,
      customerId: sh.customerId,
      customer: customer
        ? { handle: customer.whatnotHandle, realName: customer.realName, address: customer.address, isNew: !!customer.isNew }
        : { handle: sh.customerId, realName: sh.customerId, address: '', isNew: false },
      trackingNumber: sh.trackingNumber,
      serviceType: sh.serviceType,
      uspsUrl: sh.uspsUrl,
      notes: sh.notes || null,
      manualStatus: sh.manualStatus || { code: 'not_shipped', setAt: null, setBy: null },
      stage: this._deriveStage(sh),
      onHold: !!sh.onHold,
      heldReason: sh.heldReason || null,
      queueOrder: sh.queueOrder,
      packedAt: sh.packedAt || null,
      packedBy: sh.packedBy || null,
      breaks,
      breakCount: breaks.length,
      // Multi-card alarm: a customer with more than one card (team slot) across
      // their breaks is flagged so the packer double-checks nothing is missed.
      // cardCount is the total team slots; multiCard drives the warning badge.
      cardCount: slots.length,
      multiCard: slots.length > 1,
      // How many of this package's cards are tagged top-sleeved (from an applied
      // sleeve template / manual tagging) so the planner grabs a toploader.
      topSleevedCount: slots.filter((t) => t.topSleeved).length,
      pick: { checked, total: slots.length },
    }
  }

  listOrders() {
    this._ensureQueueOrder()
    const rows = this.store.state.shipments.map((sh) => this._orderRow(sh))
    // Held orders sink to the bottom; otherwise honor the manual queue order.
    return rows.sort((a, b) => {
      if (a.onHold !== b.onHold) return a.onHold ? 1 : -1
      return a.queueOrder - b.queueOrder
    })
  }

  /** Advance/revert an order through the fulfillment pipeline. */
  setOrderStage(shipmentId, stage, user) {
    const sh = this.store.state.shipments.find((x) => x.id === shipmentId)
    if (!sh) return null
    const ts = now()
    const by = (user && user.username) || null
    switch (stage) {
      case 'to_pick':
        sh.packedAt = null; sh.packedBy = null
        sh.manualStatus = { code: 'not_shipped', setAt: ts, setBy: by }
        break
      case 'put_together':
        sh.packedAt = ts; sh.packedBy = by
        sh.manualStatus = { code: 'not_shipped', setAt: ts, setBy: by }
        break
      case 'sent':
        sh.packedAt = sh.packedAt || ts
        sh.manualStatus = { code: 'in_transit', setAt: ts, setBy: by } // shipping source of truth
        break
      case 'all_good':
        sh.packedAt = sh.packedAt || ts
        sh.manualStatus = { code: 'delivered', setAt: ts, setBy: by }
        break
      default:
        throw Object.assign(new Error(`Invalid stage: ${stage}`), { status: 400 })
    }
    sh.lastUpdated = ts
    this.store.saveNow()
    return this._orderRow(sh)
  }

  /** Pause/resume an order (e.g. waiting on a break that isn't opened yet). */
  setOrderHold(shipmentId, onHold, reason, user) {
    const sh = this.store.state.shipments.find((x) => x.id === shipmentId)
    if (!sh) return null
    sh.onHold = !!onHold
    sh.heldReason = onHold ? (reason || null) : null
    sh.lastUpdated = now()
    this.store.saveNow()
    return this._orderRow(sh)
  }

  /**
   * Move an order up/down in the queue AS DISPLAYED. We sort the same way
   * listOrders does (held rows last, then queueOrder) and swap queue positions
   * with the nearest neighbor that shares the same hold state — so moving never
   * tangles active orders with paused ones.
   */
  moveOrder(shipmentId, direction) {
    this._ensureQueueOrder()
    const sorted = [...this.store.state.shipments].sort((a, b) =>
      (!!a.onHold !== !!b.onHold ? (a.onHold ? 1 : -1) : a.queueOrder - b.queueOrder))
    const idx = sorted.findIndex((x) => x.id === shipmentId)
    if (idx < 0) return null
    const target = sorted[idx]
    const step = direction === 'up' ? -1 : 1
    let j = idx + step
    // Skip over neighbors in the other hold group.
    while (j >= 0 && j < sorted.length && (!!sorted[j].onHold !== !!target.onHold)) j += step
    if (j >= 0 && j < sorted.length) {
      const neighbor = sorted[j]
      const tmp = target.queueOrder; target.queueOrder = neighbor.queueOrder; neighbor.queueOrder = tmp
      this.store.saveNow()
    }
    return this._orderRow(target)
  }

  /**
   * Reset the manual queue order back to the default (import order). Use this
   * to recover after dragging orders around. Also clears holds optionally? No —
   * holds are intentional; only the ordering is reset.
   */
  resetQueueOrder() {
    const s = this.store.state
    s.shipments.forEach((sh, i) => { sh.queueOrder = i + 1 })
    this.store.saveNow()
    return this.listOrders()
  }

  // ---------------------------------------------------------------------------
  // Whatnot Orders (raw line items) + Sales analytics
  // ---------------------------------------------------------------------------
  /** Flat list of every Whatnot order line item, joined with customer info. */
  listWhatnotOrders() {
    const s = this.store.state
    return s.orders
      .map((o) => {
        const c = s.customers.find((x) => x.id === o.customerId)
        return {
          orderId: o.id,
          breakNumber: o.breakNumber,
          teamName: o.teamName,
          price: Number(o.price) || 0,
          isGiveaway: !!o.isGiveaway,
          customer: c
            ? { handle: c.whatnotHandle, realName: c.realName, isNew: !!c.isNew }
            : { handle: o.customerId, realName: o.customerId, isNew: false },
        }
      })
      .sort((a, b) => (a.breakNumber - b.breakNumber) || String(a.orderId).localeCompare(String(b.orderId)))
  }

  /** Aggregated sales analytics for the Whatnot Sales Dashboard. */
  getSalesDashboard() {
    const s = this.store.state
    const orders = s.orders
    const paid = orders.filter((o) => !o.isGiveaway)
    const giveaways = orders.filter((o) => o.isGiveaway)
    const totalRevenue = orders.reduce((sum, o) => sum + (Number(o.price) || 0), 0)
    const round = (n) => Math.round(n * 100) / 100

    // Revenue + counts per break.
    const breakMap = new Map()
    orders.forEach((o) => {
      if (!breakMap.has(o.breakNumber)) breakMap.set(o.breakNumber, { breakNumber: o.breakNumber, orders: 0, revenue: 0 })
      const b = breakMap.get(o.breakNumber)
      b.orders += 1
      b.revenue += Number(o.price) || 0
    })
    const revenueByBreak = [...breakMap.values()].sort((a, b) => a.breakNumber - b.breakNumber).map((b) => ({ ...b, revenue: round(b.revenue) }))

    // Per-team popularity (count) + revenue.
    const teamMap = new Map()
    orders.forEach((o) => {
      if (!teamMap.has(o.teamName)) teamMap.set(o.teamName, { teamName: o.teamName, count: 0, revenue: 0 })
      const t = teamMap.get(o.teamName)
      t.count += 1
      t.revenue += Number(o.price) || 0
    })
    const topTeams = [...teamMap.values()].map((t) => ({ ...t, revenue: round(t.revenue) }))
      .sort((a, b) => b.revenue - a.revenue || b.count - a.count)

    // Top customers by spend.
    const custMap = new Map()
    orders.forEach((o) => {
      if (!custMap.has(o.customerId)) custMap.set(o.customerId, { customerId: o.customerId, orders: 0, revenue: 0 })
      const c = custMap.get(o.customerId)
      c.orders += 1
      c.revenue += Number(o.price) || 0
    })
    const topCustomers = [...custMap.values()].map((c) => {
      const cust = s.customers.find((x) => x.id === c.customerId)
      return { handle: cust ? cust.whatnotHandle : c.customerId, realName: cust ? cust.realName : c.customerId, orders: c.orders, revenue: round(c.revenue) }
    }).sort((a, b) => b.revenue - a.revenue)

    return {
      event: s.meta.event,
      totalRevenue: round(totalRevenue),
      totalOrders: orders.length,
      paidOrders: paid.length,
      giveaways: giveaways.length,
      avgOrderValue: paid.length ? round(totalRevenue / paid.length) : 0,
      uniqueCustomers: s.customers.length,
      newCustomers: s.customers.filter((c) => c.isNew).length,
      revenueByBreak,
      topTeams,
      topCustomers,
    }
  }

  // ---------------------------------------------------------------------------
  // Dashboard (spec §8 / §12)
  // ---------------------------------------------------------------------------
  getDashboard() {
    const s = this.store.state
    const totalRevenue = s.orders.reduce((sum, o) => sum + (Number(o.price) || 0), 0)

    const breakStats = { pending: 0, picking: 0, packed: 0, shipped: 0, complete: 0 }
    s.breaks.forEach((b) => {
      breakStats[b.status] = (breakStats[b.status] || 0) + 1
      const slots = s.teamSlots.filter((t) => t.breakId === b.id)
      if (slots.length > 0 && slots.every((t) => t.checkedOff)) breakStats.complete += 1
    })

    const shippingStats = { not_shipped: 0, label_created: 0, in_transit: 0, out_for_delivery: 0, delivered: 0, exception: 0, returned: 0, not_updated: 0 }
    s.shipments.forEach((sh) => {
      const code = (sh.manualStatus && sh.manualStatus.code) || 'not_shipped'
      shippingStats[code] = (shippingStats[code] || 0) + 1
      if (!sh.manualStatus || !sh.manualStatus.setAt) shippingStats.not_updated += 1
    })

    return {
      event: s.meta.event,
      totalOrders: s.orders.length,
      totalRevenue: Math.round(totalRevenue * 100) / 100,
      totalCustomers: s.customers.length,
      totalBreaks: s.breaks.length,
      totalShipments: s.shipments.length,
      breakStats,
      shippingStats,
      breaks: this.listBreaks(),
    }
  }

  // ---------------------------------------------------------------------------
  // Parse jobs (async PDF processing — spec §9.2)
  // ---------------------------------------------------------------------------
  createParseJob({ filename, totalPages }) {
    const id = `job_${crypto.randomBytes(6).toString('hex')}`
    const job = {
      id,
      filename,
      status: 'processing',
      totalPages: totalPages || 0,
      pagesProcessed: 0,
      customersFound: 0,
      breaksFound: 0,
      errors: [],
      uploadedAt: now(),
    }
    this.store.state.parseJobs[id] = job
    this.store.save()
    return job
  }

  updateParseJob(id, patch) {
    const job = this.store.state.parseJobs[id]
    if (!job) return null
    Object.assign(job, patch)
    this.store.save()
    return job
  }

  getParseJob(id) {
    return this.store.state.parseJobs[id] || null
  }

  // ---------------------------------------------------------------------------
  // Settings
  // ---------------------------------------------------------------------------
  // ---------------------------------------------------------------------------
  // History — daily snapshots of order + shipping data, and CSV export
  // ---------------------------------------------------------------------------
  /** Capture the current event's orders + shipments as a dated snapshot. */
  saveSnapshot(label, user) {
    const s = this.store.state
    const snapshot = {
      id: `snap_${crypto.randomBytes(5).toString('hex')}`,
      label: (label && String(label).trim()) || s.meta.event.name || 'Snapshot',
      savedAt: now(),
      savedBy: (user && user.username) || null,
      event: { name: s.meta.event.name, date: s.meta.event.date },
      orders: this.listWhatnotOrders(), // line items at this moment
      shipments: this.listShipments(), // statuses + breaks at this moment
      sales: this.getSalesDashboard(), // summary numbers
    }
    s.snapshots.unshift(snapshot)
    this.store.saveNow()
    return this._snapshotMeta(snapshot)
  }

  _snapshotMeta(snap) {
    return {
      id: snap.id,
      label: snap.label,
      savedAt: snap.savedAt,
      savedBy: snap.savedBy || null,
      eventName: (snap.event && snap.event.name) || null,
      eventDate: (snap.event && snap.event.date) || null,
      orders: (snap.orders || []).length,
      shipments: (snap.shipments || []).length,
      revenue: (snap.sales && snap.sales.totalRevenue) || 0,
    }
  }

  listSnapshots() {
    return this.store.state.snapshots.map((snap) => this._snapshotMeta(snap))
  }

  getSnapshot(id) {
    return this.store.state.snapshots.find((x) => x.id === id) || null
  }

  deleteSnapshot(id) {
    const s = this.store.state
    const idx = s.snapshots.findIndex((x) => x.id === id)
    if (idx === -1) return { ok: false }
    s.snapshots.splice(idx, 1)
    this.store.saveNow()
    return { ok: true }
  }

  /**
   * Build a CSV export for a snapshot (by id) or for the CURRENT live data.
   * @param {'orders'|'shipping'} kind
   * @param {string} [snapshotId]
   * @returns {{ filename: string, csv: string } | null}
   */
  exportCsv(kind, snapshotId) {
    let src
    let dateTag
    if (snapshotId) {
      const snap = this.getSnapshot(snapshotId)
      if (!snap) return null
      src = { event: snap.event, orders: snap.orders, shipments: snap.shipments }
      dateTag = (snap.savedAt || now()).slice(0, 10)
    } else {
      src = { event: this.store.state.meta.event, orders: this.listWhatnotOrders(), shipments: this.listShipments() }
      dateTag = now().slice(0, 10)
    }
    if (kind === 'orders') return { filename: `rmcardz-orders-${dateTag}.csv`, csv: ordersCsv(src) }
    if (kind === 'shipping') return { filename: `rmcardz-shipping-${dateTag}.csv`, csv: shippingCsv(src) }
    return null
  }

  getSettings() {
    const s = this.store.state
    return {
      eventName: s.meta.event.name,
      eventDate: s.meta.event.date,
      breaksPerEvent: s.meta.breaksPerEvent,
      hasData: this.hasData(),
      // USPS auto-tracking config. The raw key is never returned to the UI —
      // only whether one is set — but the provider choice is.
      trackingProvider: s.meta.trackingProvider || 'scrape', // 'scrape' | '17track'
      trackingKeySet: !!s.meta.trackingApiKey,
      // How often the desktop app auto-checks USPS in the background (minutes;
      // 0 = off). Default 30 so statuses update live without manual clicks.
      trackingAutoRefreshMinutes:
        s.meta.trackingAutoRefreshMinutes != null ? s.meta.trackingAutoRefreshMinutes : 30,
      // When the last automatic/manual carrier sync ran (ISO string or null).
      lastTrackingSyncAt: s.meta.lastTrackingSyncAt || null,
    }
  }

  updateSettings({ eventName, breaksPerEvent, trackingProvider, trackingApiKey, trackingAutoRefreshMinutes }) {
    const s = this.store.state
    if (eventName !== undefined) s.meta.event.name = eventName
    if (breaksPerEvent !== undefined) s.meta.breaksPerEvent = Number(breaksPerEvent) || 9
    if (trackingProvider !== undefined && ['scrape', '17track'].includes(trackingProvider)) {
      s.meta.trackingProvider = trackingProvider
    }
    // Empty string clears the key; undefined leaves it untouched.
    if (trackingApiKey !== undefined) s.meta.trackingApiKey = trackingApiKey ? String(trackingApiKey).trim() : null
    // Background auto-refresh cadence. Clamp to a small allow-list (0 = off) so a
    // typo can never set a punishing 10-second USPS hammer that trips Akamai.
    if (trackingAutoRefreshMinutes !== undefined) {
      const ALLOWED = [0, 15, 30, 60, 120]
      const n = Number(trackingAutoRefreshMinutes)
      s.meta.trackingAutoRefreshMinutes = ALLOWED.includes(n) ? n : 30
    }
    this.store.saveNow()
    return this.getSettings()
  }

  /** Tracking provider + key + cadence for the Electron main process. */
  getTrackingConfig() {
    const s = this.store.state
    return {
      provider: s.meta.trackingProvider || 'scrape',
      apiKey: s.meta.trackingApiKey || null,
      autoRefreshMinutes:
        s.meta.trackingAutoRefreshMinutes != null ? s.meta.trackingAutoRefreshMinutes : 30,
      lastTrackingSyncAt: s.meta.lastTrackingSyncAt || null,
    }
  }

  // ---------------------------------------------------------------------------
  // Whatnot Ledger CSV (Sales Dashboard) — see server/ledger.cjs
  // ---------------------------------------------------------------------------
  // The uploaded ledger lives at s.ledger (or null). We store the PARSED rows
  // (cheap to re-aggregate) plus the source filename, an upload timestamp, and
  // the user-tunable settings (breaksPerCase). Aggregation is recomputed on read
  // so changing breaksPerCase never requires a re-upload.

  /**
   * Parse + store a freshly uploaded ledger CSV, then return its analysis.
   * @param {string} csvText  raw CSV text (with header)
   * @param {string} [filename]
   * @returns {object} analysis (see getLedgerAnalysis)
   */
  importLedger(csvText, filename) {
    const s = this.store.state
    const { rows } = parseLedgerRows(csvText)
    s.ledger = {
      filename: filename || null,
      uploadedAt: now(),
      rows,
      settings: { breaksPerCase: 9 },
    }
    this.store.saveNow()
    return this.getLedgerAnalysis()
  }

  /**
   * Aggregate the stored ledger. If no ledger has been uploaded, returns a
   * lightweight { hasLedger: false }. An optional breaksPerCase override lets the
   * UI preview different case sizes without persisting them.
   * @param {number} [breaksPerCase]
   * @returns {object}
   */
  getLedgerAnalysis(breaksPerCase) {
    const s = this.store.state
    if (!s.ledger) return { hasLedger: false }
    const bpc = breaksPerCase != null ? breaksPerCase : s.ledger.settings.breaksPerCase
    const analysis = analyzeLedger(s.ledger.rows, { breaksPerCase: bpc })
    return {
      hasLedger: true,
      filename: s.ledger.filename,
      uploadedAt: s.ledger.uploadedAt,
      breaksPerCase: analysis.perCase.breaksPerCase,
      ...analysis,
    }
  }

  /**
   * Persist a new breaksPerCase setting (clamped to >= 1) and return the
   * re-aggregated analysis.
   * @param {number} n
   * @returns {object}
   */
  setLedgerBreaksPerCase(n) {
    const s = this.store.state
    if (!s.ledger) return { hasLedger: false }
    const clamped = Math.max(1, Math.floor(Number(n) || 9))
    s.ledger.settings.breaksPerCase = clamped
    this.store.saveNow()
    return this.getLedgerAnalysis()
  }

  /** Discard the uploaded ledger entirely. */
  clearLedger() {
    this.store.state.ledger = null
    this.store.saveNow()
    return { hasLedger: false }
  }
}

module.exports = { Db }
