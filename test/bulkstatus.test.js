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
})
