// =============================================================================
// Tests for the auto-check ROTATION that fixes "first ~20 update, the rest don't".
//
// USPS rate-limits the keyless scraper, so a run can only read a small batch.
// db.shipmentsForTracking() returns the STALEST non-final packages first (capped),
// markShipmentsChecked() advances the rotation, and final (delivered/returned)
// packages are skipped — so the background auto-refresh covers everyone over a
// few runs instead of all-at-once-and-blocked.
// =============================================================================
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rmcardz-rot-'))
  db = new Db(new Store(dir))
  db.importDataset(demoDataset())
})

const tnsOf = (rows) => rows.map((r) => r.trackingNumber)

describe('shipmentsForTracking — batch selection', () => {
  it('caps the batch to the requested limit', () => {
    const all = db.shipmentsForTracking({ limit: 0 })
    expect(all.length).toBeGreaterThan(3)
    const batch = db.shipmentsForTracking({ limit: 3 })
    expect(batch.length).toBe(3)
  })

  it('skips final (delivered / returned) packages', () => {
    const ships = db.listShipments()
    // Force the first two into final states by hand.
    db.updateShipment(ships[0].id, { manualStatus: 'delivered' }, { username: 'op' })
    db.updateShipment(ships[1].id, { manualStatus: 'returned' }, { username: 'op' })
    const active = db.shipmentsForTracking({ limit: 0 })
    const ids = active.map((r) => r.id)
    expect(ids).not.toContain(ships[0].id)
    expect(ids).not.toContain(ships[1].id)
    expect(db.activeTrackingCount()).toBe(active.length)
  })

  it('rotates: a checked package sinks to the back so the next run covers new ones', () => {
    const batch1 = db.shipmentsForTracking({ limit: 2 })
    expect(batch1.length).toBe(2)
    // Mark batch1 as checked -> they become the most-recently-checked.
    db.markShipmentsChecked(tnsOf(batch1))
    const batch2 = db.shipmentsForTracking({ limit: 2 })
    // The next batch must NOT be the same two we just checked.
    expect(tnsOf(batch2).some((tn) => tnsOf(batch1).includes(tn))).toBe(false)
  })

  it('eventually covers EVERY active package across rotating runs', () => {
    const active = db.shipmentsForTracking({ limit: 0 })
    const total = active.length
    const seen = new Set()
    // Simulate runs of 2 until everything has been checked at least once.
    for (let run = 0; run < total; run++) {
      const batch = db.shipmentsForTracking({ limit: 2 })
      batch.forEach((r) => seen.add(r.trackingNumber))
      db.markShipmentsChecked(tnsOf(batch))
      if (seen.size >= total) break
    }
    expect(seen.size).toBe(total)
  })

  it('markShipmentsChecked stamps lastCheckedAt (surfaced in listShipments)', () => {
    const batch = db.shipmentsForTracking({ limit: 1 })
    db.markShipmentsChecked(tnsOf(batch))
    const view = db.listShipments().find((s) => s.id === batch[0].id)
    expect(view.lastCheckedAt).toBeTruthy()
    expect(Number.isFinite(Date.parse(view.lastCheckedAt))).toBe(true)
  })
})
