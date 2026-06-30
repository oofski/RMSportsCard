// Unit test for the "manual is truth" rule in bulkSetShipmentStatusByTracking:
// an automatic scan may update unset/auto-set statuses but must NEVER overwrite
// a status a human deliberately set.
import { describe, it, expect, beforeEach } from 'vitest'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

const require = createRequire(import.meta.url)
const { Store } = require('../server/store.cjs')
const { Db } = require('../server/db.cjs')
const { demoDataset } = require('../server/seed.cjs')

let db
beforeEach(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rmcardz-bulk-'))
  db = new Db(new Store(dir))
  db.importDataset(demoDataset())
})

describe('bulkSetShipmentStatusByTracking — manual is truth', () => {
  it('updates an auto/unset status but skips a human-set one', () => {
    const ships = db.listShipments()
    const autoShip = ships[0] // demo statuses are stamped setBy:'auto'
    const humanShip = ships[1]

    // A human deliberately marks the second shipment delivered.
    db.updateShipment(humanShip.id, { manualStatus: 'delivered' }, { username: 'alice' })

    // An automatic scan reports a (different) status for BOTH.
    const map = {
      [autoShip.trackingNumber]: 'out_for_delivery',
      [humanShip.trackingNumber]: 'in_transit',
    }
    const res = db.bulkSetShipmentStatusByTracking(map, { by: 'auto' })

    const after = db.listShipments()
    const a = after.find((s) => s.id === autoShip.id)
    const h = after.find((s) => s.id === humanShip.id)

    expect(a.manualStatus.code).toBe('out_for_delivery') // auto-set was updated
    expect(h.manualStatus.code).toBe('delivered') // human-set was protected
    expect(res.updated).toBe(1)
    expect(res.kept).toBe(1)
  })

  it('does not count a no-op (same code) as an update', () => {
    const ship = db.listShipments()[0]
    const res = db.bulkSetShipmentStatusByTracking({ [ship.trackingNumber]: ship.manualStatus.code }, { by: 'auto' })
    expect(res.updated).toBe(0)
    expect(res.unchanged).toBe(1)
  })

  it('advances a human-set PRE-SHIP (packed) row forward when the carrier scan ships it', () => {
    // Reproduces the reported bug: an operator PACKS an order via the Orders
    // queue, which stamps manualStatus { code:'not_shipped', setBy:<username> }.
    // The package then actually ships; a carrier scan reads 'in_transit'. The
    // packed (human pre-ship) row MUST advance — packing is not a "freeze".
    const ship = db.listShipments()[0]
    db.setOrderStage(ship.id, 'put_together', { username: 'alice' }) // human, not_shipped
    const beforePacked = db.listShipments().find((s) => s.id === ship.id)
    expect(beforePacked.manualStatus.code).toBe('not_shipped')
    expect(beforePacked.manualStatus.setBy).toBe('alice') // human-set

    const res = db.bulkSetShipmentStatusByTracking({ [ship.trackingNumber]: 'in_transit' }, { by: 'usps' })
    const after = db.listShipments().find((s) => s.id === ship.id)
    expect(after.manualStatus.code).toBe('in_transit') // advanced, not stuck on not_shipped
    expect(res.updated).toBe(1)
  })

  it('does NOT advance a human-set TERMINAL decision (delivered stays put)', () => {
    // A human who forced a terminal/shipping state is still protected — only
    // pre-ship rows may be advanced forward by a scan.
    const ship = db.listShipments()[0]
    db.updateShipment(ship.id, { manualStatus: 'delivered' }, { username: 'alice' })
    const res = db.bulkSetShipmentStatusByTracking({ [ship.trackingNumber]: 'in_transit' }, { by: 'usps' })
    const after = db.listShipments().find((s) => s.id === ship.id)
    expect(after.manualStatus.code).toBe('delivered')
    expect(res.kept).toBe(1)
  })

  it("treats the default scraper marker ('usps') as auto so it never self-locks", () => {
    // The scraper writes setBy:'usps'. A SECOND scrape must be able to advance
    // the row it wrote on the first scrape — 'usps' must count as an auto setter.
    const ship = db.listShipments()[0]
    db.bulkSetShipmentStatusByTracking({ [ship.trackingNumber]: 'label_created' }, { by: 'usps' })
    const mid = db.listShipments().find((s) => s.id === ship.id)
    expect(mid.manualStatus.setBy).toBe('usps')

    const res = db.bulkSetShipmentStatusByTracking({ [ship.trackingNumber]: 'in_transit' }, { by: 'usps' })
    const after = db.listShipments().find((s) => s.id === ship.id)
    expect(after.manualStatus.code).toBe('in_transit') // not locked out by its own prior write
    expect(res.updated).toBe(1)
  })

  // --- Hardening: a HUMAN-set carrier/terminal decision is never downgraded ---
  // Only PRE-SHIP human rows (not_shipped/label_created) may be advanced. A human
  // who set any carrier state must survive a scan reporting an EARLIER state.
  it('does NOT pull a human-set in_transit BACKWARD to label_created', () => {
    const ship = db.listShipments()[0]
    db.updateShipment(ship.id, { manualStatus: 'in_transit' }, { username: 'bob' })
    const res = db.bulkSetShipmentStatusByTracking({ [ship.trackingNumber]: 'label_created' }, { by: 'usps' })
    const after = db.listShipments().find((s) => s.id === ship.id)
    expect(after.manualStatus.code).toBe('in_transit') // protected, not downgraded
    expect(res.kept).toBe(1)
    expect(res.updated).toBe(0)
  })

  it.each(['returned', 'exception', 'out_for_delivery'])(
    'does NOT overwrite a human-set %s with a scan reporting in_transit',
    (humanCode) => {
      const ship = db.listShipments()[0]
      db.updateShipment(ship.id, { manualStatus: humanCode }, { username: 'carol' })
      const res = db.bulkSetShipmentStatusByTracking({ [ship.trackingNumber]: 'in_transit' }, { by: 'usps' })
      const after = db.listShipments().find((s) => s.id === ship.id)
      expect(after.manualStatus.code).toBe(humanCode)
      expect(res.kept).toBe(1)
    }
  )

  // --- Characterization: AUTO-over-AUTO trusts the LATEST scrape (incl. backward).
  // This is intentional (the comment header: "a previous automatic write never
  // blocks the next one"). The latest read of the live USPS page is authoritative
  // for an auto-set row, so a corrected/regressed scan may move it either way.
  // Locking it so any future change to this trade-off is a DELIBERATE one.
  it('lets a later auto scan overwrite an earlier AUTO-set row, even backward', () => {
    const ship = db.listShipments()[0]
    db.bulkSetShipmentStatusByTracking({ [ship.trackingNumber]: 'in_transit' }, { by: 'usps' })
    const res = db.bulkSetShipmentStatusByTracking({ [ship.trackingNumber]: 'label_created' }, { by: 'usps' })
    const after = db.listShipments().find((s) => s.id === ship.id)
    expect(after.manualStatus.code).toBe('label_created') // auto trusts the latest auto read
    expect(res.updated).toBe(1)
  })

  it('advances a human-set label_created (the other pre-ship code) forward on a scan', () => {
    const ship = db.listShipments()[0]
    db.updateShipment(ship.id, { manualStatus: 'label_created' }, { username: 'dave' })
    const res = db.bulkSetShipmentStatusByTracking({ [ship.trackingNumber]: 'out_for_delivery' }, { by: 'usps' })
    const after = db.listShipments().find((s) => s.id === ship.id)
    expect(after.manualStatus.code).toBe('out_for_delivery') // pre-ship -> carrier is allowed
    expect(res.updated).toBe(1)
  })

  it("treats the legacy 'auto' and '17track' markers as auto-setters too", () => {
    const ship = db.listShipments()[0]
    // Simulate a row previously written by each legacy auto marker; a new scan
    // must be free to advance it (none of them count as a human freeze).
    for (const marker of ['auto', '17track']) {
      db.bulkSetShipmentStatusByTracking({ [ship.trackingNumber]: 'label_created' }, { by: marker })
      const res = db.bulkSetShipmentStatusByTracking({ [ship.trackingNumber]: 'in_transit' }, { by: 'usps' })
      expect(res.updated).toBe(1)
      expect(db.listShipments().find((s) => s.id === ship.id).manualStatus.code).toBe('in_transit')
    }
  })

  it('ignores unknown status codes and unmatched tracking numbers', () => {
    const ship = db.listShipments()[0]
    const before = ship.manualStatus.code
    const res = db.bulkSetShipmentStatusByTracking(
      { [ship.trackingNumber]: 'teleported', 'NO-SUCH-TRACKING': 'delivered' },
      { by: 'usps' }
    )
    const after = db.listShipments().find((s) => s.id === ship.id)
    expect(after.manualStatus.code).toBe(before) // invalid code left the row untouched
    expect(res.updated).toBe(0)
  })
})
