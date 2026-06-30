// =============================================================================
// Tests for the live shipping-status sync plumbing:
//   - bulkSetShipmentStatusByTracking stamps a lastTrackingSyncAt every run
//     (even a zero-update sync) so the UI can show freshness.
//   - settings round-trip + clamp the background auto-refresh cadence.
//   - getTrackingConfig exposes the cadence + last sync time to the Electron
//     main process (which paces the background auto-refresh from them).
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rmcardz-sync-'))
  db = new Db(new Store(dir))
  db.importDataset(demoDataset())
})

describe('lastTrackingSyncAt stamping', () => {
  it('stamps a sync time even when NOTHING changed', () => {
    const ship = db.listShipments()[0]
    // Same code => zero updates, but the sync still "happened".
    const res = db.bulkSetShipmentStatusByTracking({ [ship.trackingNumber]: ship.manualStatus.code }, { by: 'usps' })
    expect(res.updated).toBe(0)
    expect(res.lastTrackingSyncAt).toBeTruthy()
    expect(Number.isFinite(Date.parse(res.lastTrackingSyncAt))).toBe(true)
    // It is persisted and readable back through settings/config.
    expect(db.getSettings().lastTrackingSyncAt).toBe(res.lastTrackingSyncAt)
    expect(db.getTrackingConfig().lastTrackingSyncAt).toBe(res.lastTrackingSyncAt)
  })

  it('advances the sync time on a later run', () => {
    const ship = db.listShipments()[0]
    const first = db.bulkSetShipmentStatusByTracking({ [ship.trackingNumber]: 'in_transit' }, { by: 'usps' })
    const second = db.bulkSetShipmentStatusByTracking({ [ship.trackingNumber]: 'delivered' }, { by: 'usps' })
    expect(Date.parse(second.lastTrackingSyncAt)).toBeGreaterThanOrEqual(Date.parse(first.lastTrackingSyncAt))
  })
})

describe('background auto-refresh cadence setting', () => {
  it('defaults to 30 minutes', () => {
    expect(db.getSettings().trackingAutoRefreshMinutes).toBe(30)
    expect(db.getTrackingConfig().autoRefreshMinutes).toBe(30)
  })

  it('accepts allowed cadences (0/15/30/60/120) and persists them', () => {
    for (const m of [0, 15, 30, 60, 120]) {
      const s = db.updateSettings({ trackingAutoRefreshMinutes: m })
      expect(s.trackingAutoRefreshMinutes).toBe(m)
      expect(db.getTrackingConfig().autoRefreshMinutes).toBe(m)
    }
  })

  it('clamps an out-of-range / junk cadence back to the 30-minute default', () => {
    expect(db.updateSettings({ trackingAutoRefreshMinutes: 5 }).trackingAutoRefreshMinutes).toBe(30)
    expect(db.updateSettings({ trackingAutoRefreshMinutes: 9999 }).trackingAutoRefreshMinutes).toBe(30)
    expect(db.updateSettings({ trackingAutoRefreshMinutes: 'banana' }).trackingAutoRefreshMinutes).toBe(30)
  })

  it('leaves the cadence untouched when not provided', () => {
    db.updateSettings({ trackingAutoRefreshMinutes: 60 })
    db.updateSettings({ eventName: 'Some Event' }) // unrelated update
    expect(db.getSettings().trackingAutoRefreshMinutes).toBe(60)
  })
})
