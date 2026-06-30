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
    s.breaks = dataset.breaks || []
    s.teamSlots = dataset.teamSlots || []
    s.customers = dataset.customers || []
    s.shipments = dataset.shipments || []
    s.orders = dataset.orders || []
    s.batchUrls = dataset.batchUrls || []
    s.warnings = dataset.warnings || []
    if (filename) s.meta.lastImportFilename = filename
    this.store.saveNow()
    return this.summary()
  }

  /** Post-parse summary shown on the landing screen (spec §5.6). */
  summary() {
    const s = this.store.state
    const totalRevenue = s.orders.reduce((sum, o) => sum + (Number(o.price) || 0), 0)
    return {
      event: s.meta.event,
      importedAt: s.meta.importedAt,
      customers: s.customers.length,
      breaks: s.breaks.length,
      totalOrders: s.orders.length,
      totalRevenue: Math.round(totalRevenue * 100) / 100,
      trackingNumbers: s.shipments.length,
      warnings: s.warnings.length,
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
    return s.breaks
      .map((b) => {
        const slots = s.teamSlots.filter((t) => t.breakId === b.id)
        const checked = slots.filter((t) => t.checkedOff).length
        return {
          id: b.id,
          breakNumber: b.breakNumber,
          eventName: b.eventName,
          eventDate: b.eventDate,
          totalTeams: slots.length, // actual SOLD slots, not the 32 max (spec §13)
          checkedTeams: checked,
          status: b.status,
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
      breaks,
    }
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

    const shippingStats = { not_shipped: 0, in_transit: 0, out_for_delivery: 0, delivered: 0, exception: 0, returned: 0, not_updated: 0 }
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
  getSettings() {
    const s = this.store.state
    return {
      eventName: s.meta.event.name,
      eventDate: s.meta.event.date,
      breaksPerEvent: s.meta.breaksPerEvent,
      hasData: this.hasData(),
    }
  }

  updateSettings({ eventName, breaksPerEvent }) {
    const s = this.store.state
    if (eventName !== undefined) s.meta.event.name = eventName
    if (breaksPerEvent !== undefined) s.meta.breaksPerEvent = Number(breaksPerEvent) || 9
    this.store.saveNow()
    return this.getSettings()
  }
}

module.exports = { Db }
