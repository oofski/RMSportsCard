// =============================================================================
// BreakChecklist — Module A controller (engineering spec §6)
// -----------------------------------------------------------------------------
// The pick-and-pack tool used on the fulfillment-table tablet. It owns ALL of
// Module A's state and orchestration; the two presentational children render it:
//
//   • BreakList  (§6.2) — the break SELECTION list, polled every ~5s so two
//                          pickers working different breaks stay in sync.
//   • PickList   (§6.3) — the per-break PICK LIST: the operational screen where
//                          taps check teams off optimistically and sink them.
//
// Which view is shown is driven purely by local `selectedBreakId`.
//
// OFFLINE TOLERANCE (§6.5) is the load-bearing complexity here. Every toggle is:
//   1. applied to local state instantly (the picker never waits),
//   2. written to a localStorage buffer (slotId -> desired checkedOff),
//   3. pushed to the API. On success the slot leaves the buffer; on failure it
//      stays queued, an "Offline" banner shows, and a retry interval drains the
//      queue. When the queue empties we flash "Synced" then go quiet.
// When a break loads we REPLAY any still-pending local toggles on top of the
// server state, so a tap made while offline is never lost across a reload.
// =============================================================================

import React, { useCallback, useEffect, useRef, useState } from 'react'
import * as api from '../../api.js'
import BreakList from './BreakList.jsx'
import PickList from './PickList.jsx'

// How often to refresh the selection list and to retry the offline queue.
const POLL_MS = 5000
const RETRY_MS = 5000
// How long the green "Synced" banner lingers after the queue drains.
const SYNCED_FLASH_MS = 2000
// localStorage key for the offline buffer of un-synced toggles.
const PENDING_KEY = 'rmcardz.pendingSlots'

// ---- localStorage helpers ---------------------------------------------------
// The buffer maps a slot id -> the desired `checkedOff` boolean. It survives
// reloads and even an app restart, which is the whole point: an offline tap
// must outlive the renderer. Every accessor is defensive — a corrupted or
// quota-exceeded store must never crash the pick screen.

/** Read the whole pending-toggle buffer as a plain object. */
function readPending() {
  try {
    const raw = localStorage.getItem(PENDING_KEY)
    const parsed = raw ? JSON.parse(raw) : null
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

/** Persist the buffer (best-effort; ignore quota / serialization failures). */
function writePending(map) {
  try {
    localStorage.setItem(PENDING_KEY, JSON.stringify(map))
  } catch {
    /* If storage is unavailable we still keep the in-memory optimistic state. */
  }
}

/** Queue one desired toggle. Returns the new buffer. */
function enqueuePending(slotId, checkedOff) {
  const map = readPending()
  map[slotId] = checkedOff
  writePending(map)
  return map
}

/** Remove a slot from the buffer once the server has confirmed it. */
function dequeuePending(slotId) {
  const map = readPending()
  if (slotId in map) {
    delete map[slotId]
    writePending(map)
  }
  return map
}

export default function BreakChecklist({ currentUser }) {
  // ---- Selection-view state ----
  const [breaks, setBreaks] = useState([])
  const [breaksLoading, setBreaksLoading] = useState(true)
  const [breaksError, setBreaksError] = useState(null)

  // ---- Pick-view state ----
  const [selectedBreakId, setSelectedBreakId] = useState(null)
  const [activeBreak, setActiveBreak] = useState(null) // full detail (meta only)
  const [slots, setSlots] = useState([])               // optimistic slot list
  const [pickError, setPickError] = useState(null)
  const [busyBulk, setBusyBulk] = useState(false)

  // ---- Sync indicator: 'idle' | 'offline' | 'synced' ----
  const [syncState, setSyncState] = useState('idle')

  // Latest slots in a ref so the retry interval (a stable closure) can read the
  // current list without being re-created on every toggle.
  const slotsRef = useRef(slots)
  useEffect(() => { slotsRef.current = slots }, [slots])

  // -------------------------------------------------------------------------
  // Selection list: initial load + ~5s polling while this view is on screen.
  // -------------------------------------------------------------------------
  const loadBreaks = useCallback(async (showSpinner) => {
    if (showSpinner) setBreaksLoading(true)
    try {
      const data = await api.getBreaks()
      setBreaks(Array.isArray(data) ? data : [])
      setBreaksError(null)
    } catch (err) {
      // Polling failures are quiet; we keep the stale list rather than blanking.
      setBreaksError(err.message || 'Could not load breaks')
    } finally {
      if (showSpinner) setBreaksLoading(false)
    }
  }, [])

  useEffect(() => {
    // Only poll while the SELECTION view is showing (no break selected).
    if (selectedBreakId != null) return
    loadBreaks(true)
    const id = setInterval(() => loadBreaks(false), POLL_MS)
    return () => clearInterval(id) // stop polling on unmount / navigation
  }, [selectedBreakId, loadBreaks])

  // -------------------------------------------------------------------------
  // Open a break: fetch its detail, then REPLAY pending local toggles on top
  // so any un-synced taps survive a reload (§6.5 reconcile).
  // -------------------------------------------------------------------------
  const openBreak = useCallback(async (id) => {
    setSelectedBreakId(id)
    setActiveBreak(null)
    setSlots([])
    setPickError(null)
    try {
      const detail = await api.getBreak(id)
      const pending = readPending()
      const reconciled = (detail.teamSlots || []).map((slot) =>
        // A still-pending local toggle wins over the server's value.
        slot.id in pending ? { ...slot, checkedOff: pending[slot.id] } : slot
      )
      setActiveBreak(detail)
      setSlots(reconciled)
      // If anything is still queued for this (or any) break, we are effectively
      // offline until the retry drains it.
      if (Object.keys(pending).length > 0) setSyncState('offline')
    } catch (err) {
      setPickError(err.message || 'Could not load this break')
    }
  }, [])

  const backToBreaks = useCallback(() => {
    setSelectedBreakId(null)
    setActiveBreak(null)
    setSlots([])
    setPickError(null)
    // Re-poll the list immediately so progress reflects what we just did.
    loadBreaks(true)
  }, [loadBreaks])

  // -------------------------------------------------------------------------
  // Confirm one queued toggle against the server. Shared by the live toggle
  // path and the retry loop. Returns true if the server accepted it.
  // -------------------------------------------------------------------------
  const flushSlot = useCallback(async (slotId, desired) => {
    try {
      await api.toggleTeamSlot(slotId, desired)
      dequeuePending(slotId)
      return true
    } catch {
      // Leave it queued; the retry loop will pick it up.
      return false
    }
  }, [])

  // -------------------------------------------------------------------------
  // Optimistic toggle (§6.3 + §6.5). Update UI instantly, buffer to storage,
  // then try the network. The list re-sorts (checked sink) inside PickList.
  // -------------------------------------------------------------------------
  const toggleSlot = useCallback(async (slotId, next) => {
    // 1) optimistic local update — never block the picker on the network.
    setSlots((prev) =>
      prev.map((s) =>
        s.id === slotId
          ? {
              ...s,
              checkedOff: next,
              // Reflect who/when locally; the server is authoritative on sync.
              checkedOffAt: next ? new Date().toISOString() : null,
              checkedOffBy: next ? (currentUser?.displayName || currentUser?.username || null) : null,
            }
          : s
      )
    )
    // 2) buffer the desired state to localStorage immediately.
    enqueuePending(slotId, next)
    // 3) try to persist now.
    const ok = await flushSlot(slotId, next)
    if (ok) {
      // If that drained the very last queued item, flash "Synced". Use a
      // functional update so a bulk loop (markAllPacked) doesn't read a stale
      // syncState captured in this callback's closure.
      if (Object.keys(readPending()).length === 0) {
        setSyncState((cur) => (cur !== 'idle' ? 'synced' : cur))
      }
    } else {
      setSyncState('offline')
    }
  }, [currentUser, flushSlot])

  // -------------------------------------------------------------------------
  // Retry loop (§6.5): every RETRY_MS, attempt to flush every queued slot.
  // Runs only while a break is open (where toggles originate). When the queue
  // empties, flash "Synced" then settle back to idle.
  // -------------------------------------------------------------------------
  useEffect(() => {
    if (selectedBreakId == null) return
    const id = setInterval(async () => {
      const pending = readPending()
      const ids = Object.keys(pending)
      if (ids.length === 0) return
      setSyncState('offline')
      let anyFailed = false
      for (const slotId of ids) {
        const ok = await flushSlot(slotId, pending[slotId])
        if (!ok) anyFailed = true
      }
      if (!anyFailed && Object.keys(readPending()).length === 0) {
        setSyncState('synced')
      }
    }, RETRY_MS)
    return () => clearInterval(id)
  }, [selectedBreakId, flushSlot])

  // Auto-hide the green "Synced" banner a moment after it appears.
  useEffect(() => {
    if (syncState !== 'synced') return
    const id = setTimeout(() => setSyncState('idle'), SYNCED_FLASH_MS)
    return () => clearTimeout(id)
  }, [syncState])

  // -------------------------------------------------------------------------
  // Bulk: check every currently-unchecked slot, persisting each through the
  // same optimistic + buffered path so offline tolerance still applies.
  // -------------------------------------------------------------------------
  const markAllPacked = useCallback(async () => {
    const targets = slotsRef.current.filter((s) => !s.checkedOff)
    if (targets.length === 0) return
    setBusyBulk(true)
    try {
      for (const slot of targets) {
        // eslint-disable-next-line no-await-in-loop -- sequential keeps the
        // server's per-slot ordering and avoids hammering it from a tablet.
        await toggleSlot(slot.id, true)
      }
    } finally {
      setBusyBulk(false)
    }
  }, [toggleSlot])

  // -------------------------------------------------------------------------
  // Bulk: clear the whole break server-side, drop any queued toggles for its
  // slots, then reload the reconciled detail.
  // -------------------------------------------------------------------------
  const clearAll = useCallback(async () => {
    if (selectedBreakId == null) return
    setBusyBulk(true)
    setPickError(null)
    try {
      const detail = await api.clearBreak(selectedBreakId)
      // A successful clear supersedes any queued toggles for these slots.
      const pending = readPending()
      for (const slot of detail.teamSlots || []) delete pending[slot.id]
      writePending(pending)
      setActiveBreak(detail)
      setSlots(detail.teamSlots || [])
      if (Object.keys(readPending()).length === 0) setSyncState('idle')
    } catch (err) {
      setPickError(err.message || 'Could not clear this break')
    } finally {
      setBusyBulk(false)
    }
  }, [selectedBreakId])

  // -------------------------------------------------------------------------
  // Completion: mark the break PACKED, then refresh so its badge updates.
  // -------------------------------------------------------------------------
  const confirmPacked = useCallback(async () => {
    if (selectedBreakId == null) return
    setBusyBulk(true)
    setPickError(null)
    try {
      const detail = await api.packBreak(selectedBreakId)
      const pending = readPending()
      const reconciled = (detail.teamSlots || []).map((slot) =>
        slot.id in pending ? { ...slot, checkedOff: pending[slot.id] } : slot
      )
      setActiveBreak(detail)
      setSlots(reconciled)
    } catch (err) {
      setPickError(err.message || 'Could not mark this break as packed')
    } finally {
      setBusyBulk(false)
    }
  }, [selectedBreakId])

  // -------------------------------------------------------------------------
  // Render: SELECTION view when no break is open, otherwise the PICK LIST.
  // -------------------------------------------------------------------------
  if (selectedBreakId == null) {
    return (
      <BreakList
        breaks={breaks}
        loading={breaksLoading}
        error={breaksError}
        onOpenBreak={openBreak}
      />
    )
  }

  // A break is selected but its detail is still loading (or failed).
  if (!activeBreak) {
    return (
      <div className="container">
        <div className="row" style={{ marginBottom: 10 }}>
          <button className="btn btn-ghost" onClick={backToBreaks}>← Back to Breaks</button>
        </div>
        {pickError ? (
          <div className="banner error" style={{ borderRadius: 8 }}>{pickError}</div>
        ) : (
          <div className="card muted">Loading break…</div>
        )}
      </div>
    )
  }

  return (
    <>
      {/* Non-fatal pick-screen errors (e.g. a failed bulk op) sit above the list. */}
      {pickError && (
        <div className="container">
          <div className="banner error" style={{ borderRadius: 8, marginBottom: 12 }}>
            {pickError}
          </div>
        </div>
      )}
      <PickList
        brk={activeBreak}
        slots={slots}
        onBack={backToBreaks}
        onToggleSlot={toggleSlot}
        onMarkAllPacked={markAllPacked}
        onClearAll={clearAll}
        onConfirmPacked={confirmPacked}
        busyBulk={busyBulk}
        syncState={syncState}
      />
    </>
  )
}
