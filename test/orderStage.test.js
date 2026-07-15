// Unit tests for order-stage derivation, re-import state carry-forward, and
// packed-break preservation — the verified bug fixes in this release.
// PRIVACY: repo is public — synthetic demo data only.
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rmcardz-stage-'))
  db = new Db(new Store(dir))
  db.importDataset(demoDataset())
})

describe('order-stage derivation', () => {
  it('derives a label_created shipment to put_together, never back to to_pick', () => {
    // A created shipping label means the package is packed/ready. Previously
    // _deriveStage had no case for it and fell through to to_pick, so an order
    // with a printed label reappeared in the pick pile and disagreed with the
    // Shipping Tracker.
    const ship = db.listShipments()[0]
    db.updateShipment(ship.id, { manualStatus: 'label_created' }, { username: 'alice' })
    const order = db.listOrders().find((o) => o.id === ship.id) // _orderRow.id === shipment id
    expect(order.stage).toBe('put_together')
  })
})

describe('re-import carries operator state forward (corrected re-export)', () => {
  it('preserves pack, special request, hold and checkoffs for matching customers', () => {
    const order = db.listOrders().find((o) => o.breaks.length && o.breaks[0].teams.length)
    const cust = order.customerId
    const slotId = order.breaks[0].teams[0].slotId

    db.setOrderStage(order.id, 'put_together', { username: 'alice' })
    db.setOrderSpecialRequest(order.id, '  Ship in a team bag  ', { username: 'alice' })
    db.setOrderHold(order.id, true, 'waiting on Break #4', { username: 'alice' })
    db.setTeamSlotChecked(slotId, true, { username: 'alice' })

    // A corrected PDF is re-imported — the same customers/teams come back.
    db.importDataset(demoDataset())

    const after = db.listOrders().find((o) => o.customerId === cust)
    expect(after).toBeTruthy()
    expect(after.packedAt).toBeTruthy() // pack survived
    expect(after.specialRequest.text).toBe('Ship in a team bag') // request survived (trimmed)
    expect(after.onHold).toBe(true) // hold survived
    expect(after.pick.checked).toBeGreaterThan(0) // checkoff survived
  })

  it('does not carry state onto a brand-new event (no matching customers)', () => {
    const order = db.listOrders()[0]
    db.setOrderSpecialRequest(order.id, 'note', { username: 'alice' })
    // Re-import a dataset whose customers do not match (empty event -> fresh).
    db.importDataset({ event: { name: 'Other', date: '2026-01-01' }, breaks: [], teamSlots: [], customers: [], shipments: [], orders: [] })
    expect(db.listOrders().length).toBe(0) // cleanly replaced, nothing carried
  })
})

describe('packed break status behaves correctly under checkoff edits and re-import', () => {
  it('keeps a packed break packed on a partial uncheck, but Clear All un-packs it', () => {
    const brk = db.state.breaks[0]
    const slots = db.state.teamSlots.filter((t) => t.breakId === brk.id)
    slots.forEach((s) => db.setTeamSlotChecked(s.id, true, { username: 'alice' }))
    db.markBreakPacked(brk.id)
    expect(db.state.breaks.find((b) => b.id === brk.id).status).toBe('packed')

    // Unchecking one card to review it must NOT revert the packed marker.
    db.setTeamSlotChecked(slots[0].id, false, { username: 'alice' })
    expect(db.state.breaks.find((b) => b.id === brk.id).status).toBe('packed')

    // Clear All is a deliberate reset — it IS allowed to un-pack (the un-pack path).
    db.clearBreak(brk.id)
    expect(db.state.breaks.find((b) => b.id === brk.id).status).toBe('pending')
  })

  it('does not keep a break packed after a re-import adds a new unchecked card (shortpack guard)', () => {
    // Pack a break fully, then re-import a dataset whose SAME break gains an
    // extra (unchecked) team slot. The break must NOT stay green "Packed".
    const brk = db.state.breaks[0]
    const brkNo = brk.breakNumber
    db.state.teamSlots.filter((t) => t.breakId === brk.id).forEach((s) => db.setTeamSlotChecked(s.id, true, { username: 'a' }))
    db.markBreakPacked(brk.id)

    const ds = demoDataset()
    // Append one brand-new team slot to that same break for an existing customer.
    const anySlot = ds.teamSlots.find((t) => t.breakNumber === brkNo)
    ds.teamSlots.push({
      id: `slot_${brkNo}_added_x`, breakId: `break_${brkNo}`, breakNumber: brkNo,
      teamName: 'Zzz Added Team', customerId: anySlot.customerId, orderId: null,
      price: 10, isGiveaway: false, checkedOff: false, checkedOffAt: null, checkedOffBy: null,
    })
    db.importDataset(ds)

    const after = db.listBreaks().find((b) => b.breakNumber === brkNo)
    expect(after.status).not.toBe('packed') // dropped back so the new card isn't missed
  })
})
