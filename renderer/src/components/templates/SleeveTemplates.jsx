// =============================================================================
// Sleeve Templates — top-sleeve tagging (feature add-on)
// -----------------------------------------------------------------------------
// Build a reusable template that marks, per break, which teams get a toploader /
// sleeve. Pick a sport, go break by break, tap the teams to check them, and save.
// Later — after importing a Whatnot PDF — hit "Apply" and every matching team
// slot (per break) is tagged top-sleeved, so the pick screen shows at a glance
// which cards need extra protection. One template can also be set as the DEFAULT,
// which auto-applies on every future import.
//
// Two modes driven by `mode`:
//   list  → saved templates + this-event status + New button
//   edit  → the per-break team-chip builder (new or editing an existing one)
// =============================================================================

import React, { useCallback, useEffect, useState } from 'react'
import * as api from '../../api.js'
import { SPORT_OPTIONS, teamsForSport, sportLabel } from '../../constants.js'

const DEFAULT_BREAKS = 9
const MAX_BREAKS = 24
// Only real leagues are selectable when building (no "Auto-detect").
const SPORT_CHOICES = SPORT_OPTIONS.filter((s) => s.code !== 'auto')

// Map a notice kind to a theme color for the inline banner.
const NOTICE_COLOR = { good: 'var(--good)', warn: 'var(--warn)', bad: 'var(--bad)' }

export default function SleeveTemplates() {
  const [templates, setTemplates] = useState([])
  const [summary, setSummary] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [mode, setMode] = useState('list') // 'list' | 'edit'
  const [draft, setDraft] = useState(null) // { id, name, sport, numBreaks, marks:{n:Set} }
  const [notice, setNotice] = useState(null) // { kind, text }
  const [busy, setBusy] = useState(false)
  const [confirmDeleteId, setConfirmDeleteId] = useState(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [t, s] = await Promise.all([
        api.listSleeveTemplates(),
        api.summary().catch(() => null),
      ])
      setTemplates(Array.isArray(t) ? t : [])
      setSummary(s)
      setError(null)
    } catch (e) {
      setError(e.message || 'Could not load templates')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const eventSport = summary && summary.sport ? summary.sport : null

  // --- Builder state helpers ------------------------------------------------
  const startNew = () => {
    setDraft({ id: null, name: '', sport: eventSport || 'nfl', numBreaks: DEFAULT_BREAKS, marks: {} })
    setNotice(null)
    setMode('edit')
  }

  const startEdit = async (id) => {
    setBusy(true)
    try {
      const full = await api.getSleeveTemplate(id)
      const marks = {}
      let maxN = DEFAULT_BREAKS
      for (const [k, teams] of Object.entries(full.breaks || {})) {
        const n = parseInt(k, 10)
        marks[n] = new Set(teams)
        if (n > maxN) maxN = n
      }
      setDraft({ id: full.id, name: full.name, sport: full.sport, numBreaks: Math.min(maxN, MAX_BREAKS), marks })
      setNotice(null)
      setMode('edit')
    } catch (e) {
      setNotice({ kind: 'bad', text: e.message || 'Could not open template' })
    } finally {
      setBusy(false)
    }
  }

  const toggleTeam = (n, team) => setDraft((d) => {
    const marks = { ...d.marks }
    const set = new Set(marks[n] || [])
    if (set.has(team)) set.delete(team); else set.add(team)
    marks[n] = set
    return { ...d, marks }
  })

  const setBreakAll = (n, on) => setDraft((d) => {
    const marks = { ...d.marks }
    marks[n] = on ? new Set(teamsForSport(d.sport)) : new Set()
    return { ...d, marks }
  })

  const copyToAll = (n) => setDraft((d) => {
    const src = new Set(d.marks[n] || [])
    const marks = {}
    for (let i = 1; i <= d.numBreaks; i++) marks[i] = new Set(src)
    return { ...d, marks }
  })

  const bumpBreaks = (delta) => setDraft((d) => ({
    ...d, numBreaks: Math.max(1, Math.min(MAX_BREAKS, d.numBreaks + delta)),
  }))

  const save = async () => {
    if (!draft) return
    setBusy(true); setNotice(null)
    try {
      const breaks = {}
      for (let i = 1; i <= draft.numBreaks; i++) {
        const set = draft.marks[i]
        if (set && set.size) breaks[i] = [...set]
      }
      const name = (draft.name || '').trim() || 'Untitled template'
      if (draft.id) await api.updateSleeveTemplate(draft.id, { name, breaks })
      else await api.createSleeveTemplate({ name, sport: draft.sport, breaks })
      await load()
      setMode('list')
      setNotice({ kind: 'good', text: `Saved "${name}".` })
    } catch (e) {
      setNotice({ kind: 'bad', text: e.message || 'Could not save template' })
    } finally {
      setBusy(false)
    }
  }

  // --- List actions ---------------------------------------------------------
  const apply = async (t) => {
    setBusy(true); setNotice(null)
    try {
      const r = await api.applySleeveTemplate(t.id)
      await load()
      if (r.sportMismatch) {
        setNotice({ kind: 'warn', text: `"${t.name}" is a ${sportLabel(t.sport)} template but this event is ${sportLabel(r.eventSport)} — 0 slots tagged.` })
      } else {
        setNotice({ kind: 'good', text: `Applied "${t.name}" — tagged ${r.tagged} slot${r.tagged === 1 ? '' : 's'} across ${r.breaksAffected} break${r.breaksAffected === 1 ? '' : 's'}.` })
      }
    } catch (e) {
      setNotice({ kind: 'bad', text: e.message || 'Could not apply template' })
    } finally {
      setBusy(false)
    }
  }

  const toggleDefault = async (t) => {
    setBusy(true); setNotice(null)
    try {
      await api.setDefaultSleeveTemplate(t.id, !t.isDefault)
      await load()
    } catch (e) {
      setNotice({ kind: 'bad', text: e.message || 'Could not update default' })
    } finally {
      setBusy(false)
    }
  }

  const remove = async (t) => {
    setBusy(true); setNotice(null)
    try {
      await api.deleteSleeveTemplate(t.id)
      setConfirmDeleteId(null)
      await load()
      setNotice({ kind: 'good', text: `Deleted "${t.name}".` })
    } catch (e) {
      setNotice({ kind: 'bad', text: e.message || 'Could not delete template' })
    } finally {
      setBusy(false)
    }
  }

  const clearTags = async () => {
    setBusy(true); setNotice(null)
    try {
      await api.clearSleeveTags()
      await load()
      setNotice({ kind: 'good', text: 'Cleared all top-sleeve tags.' })
    } catch (e) {
      setNotice({ kind: 'bad', text: e.message || 'Could not clear tags' })
    } finally {
      setBusy(false)
    }
  }

  // --- Render ---------------------------------------------------------------
  const NoticeBanner = () => notice ? (
    <div
      style={{
        padding: '10px 14px', borderRadius: 8, fontSize: 14,
        border: `1px solid ${NOTICE_COLOR[notice.kind]}`,
        color: NOTICE_COLOR[notice.kind],
        background: `color-mix(in srgb, ${NOTICE_COLOR[notice.kind]} 12%, transparent)`,
      }}
    >
      {notice.text}
    </div>
  ) : null

  if (loading) return <div className="muted">Loading templates…</div>
  if (error) return <div className="banner error" style={{ borderRadius: 8 }}>{error}</div>

  // ===== BUILDER =====
  if (mode === 'edit' && draft) {
    const teams = teamsForSport(draft.sport)
    const totalMarked = Object.values(draft.marks).reduce((sum, set) => sum + (set ? set.size : 0), 0)
    return (
      <div className="col" style={{ gap: 16 }}>
        <div className="row-between">
          <h2 style={{ margin: 0 }}>{draft.id ? 'Edit template' : 'New sleeve template'}</h2>
          <button className="btn btn-ghost" onClick={() => { setMode('list'); setNotice(null) }}>← Back</button>
        </div>

        <NoticeBanner />

        {/* Name + sport + break count */}
        <div className="card">
          <div className="row" style={{ gap: 14, flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <div className="col" style={{ gap: 4, flex: '1 1 240px' }}>
              <label className="muted small">Template name</label>
              <input
                className="input"
                placeholder="e.g. Rookies & autos"
                value={draft.name}
                onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
              />
            </div>
            <div className="col" style={{ gap: 4 }}>
              <label className="muted small">Sport</label>
              {draft.id ? (
                <span className="badge" style={{ height: 34, padding: '0 12px' }}>{sportLabel(draft.sport)}</span>
              ) : (
                <div className="row" style={{ gap: 6 }}>
                  {SPORT_CHOICES.map((s) => (
                    <button
                      key={s.code}
                      className={`btn btn-sm${draft.sport === s.code ? ' btn-primary' : ''}`}
                      onClick={() => setDraft((d) => ({ ...d, sport: s.code, marks: {} }))}
                    >
                      {s.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <div className="col" style={{ gap: 4 }}>
              <label className="muted small">Breaks in template</label>
              <div className="row" style={{ gap: 8, alignItems: 'center' }}>
                <button className="btn btn-sm" onClick={() => bumpBreaks(-1)} disabled={draft.numBreaks <= 1}>–</button>
                <span className="mono" style={{ minWidth: 20, textAlign: 'center' }}>{draft.numBreaks}</span>
                <button className="btn btn-sm" onClick={() => bumpBreaks(1)} disabled={draft.numBreaks >= MAX_BREAKS}>+</button>
              </div>
            </div>
          </div>
          <div className="muted small" style={{ marginTop: 10 }}>
            Tap teams that get a toploader/sleeve. {totalMarked} team{totalMarked === 1 ? '' : 's'} marked across {draft.numBreaks} breaks.
            Use <strong>Copy to all breaks</strong> to reuse one break's picks everywhere.
          </div>
        </div>

        {/* Per-break team grids */}
        {Array.from({ length: draft.numBreaks }, (_, i) => i + 1).map((n) => {
          const set = draft.marks[n] || new Set()
          return (
            <div key={n} className="panel" style={{ padding: 14 }}>
              <div className="row-between" style={{ marginBottom: 8, flexWrap: 'wrap', gap: 8 }}>
                <strong>Break #{n} <span className="muted small">· {set.size} marked</span></strong>
                <div className="row" style={{ gap: 6 }}>
                  <button className="btn btn-sm" onClick={() => setBreakAll(n, true)}>All</button>
                  <button className="btn btn-sm" onClick={() => setBreakAll(n, false)}>None</button>
                  <button className="btn btn-sm" onClick={() => copyToAll(n)} title="Copy this break's picks to every break">Copy to all breaks</button>
                </div>
              </div>
              <div className="row" style={{ flexWrap: 'wrap', gap: 0 }}>
                {teams.map((team) => (
                  <button
                    key={team}
                    className={`team-chip${set.has(team) ? ' checked' : ''}`}
                    onClick={() => toggleTeam(n, team)}
                    aria-pressed={set.has(team)}
                  >
                    {set.has(team) ? '✓ ' : ''}{team}
                  </button>
                ))}
              </div>
            </div>
          )
        })}

        <div className="row" style={{ gap: 10, position: 'sticky', bottom: 0, padding: '10px 0' }}>
          <button className="btn btn-primary btn-lg" onClick={save} disabled={busy}>
            {busy ? 'Saving…' : draft.id ? 'Save changes' : 'Save template'}
          </button>
          <button className="btn btn-ghost" onClick={() => { setMode('list'); setNotice(null) }}>Cancel</button>
        </div>
      </div>
    )
  }

  // ===== LIST =====
  return (
    <div className="col" style={{ gap: 18 }}>
      <div className="row-between">
        <div>
          <h2 style={{ margin: 0 }}>Sleeve Templates</h2>
          <div className="muted small">
            Mark which teams get a toploader per break, then apply it to an imported event in one click.
          </div>
        </div>
        <button className="btn btn-primary" onClick={startNew}>+ New template</button>
      </div>

      <NoticeBanner />

      {/* This-event status */}
      {summary && (
        <div className="card">
          <div className="row-between" style={{ flexWrap: 'wrap', gap: 10 }}>
            <div className="col" style={{ gap: 2 }}>
              <div className="section-title" style={{ margin: 0 }}>This event</div>
              <div className="row" style={{ gap: 8, alignItems: 'center' }}>
                <span>{(summary.event && summary.event.name) || 'No event imported'}</span>
                {eventSport && <span className="badge">{sportLabel(eventSport)}</span>}
              </div>
            </div>
            <div className="col" style={{ gap: 2, alignItems: 'flex-end' }}>
              <div className="mono">
                <span className="badge sleeve">🛡 {summary.topSleevedSlots || 0} top-sleeved</span>
              </div>
              {summary.appliedTemplate
                ? <div className="muted small">via “{summary.appliedTemplate.name}”</div>
                : <div className="muted small">no template applied</div>}
            </div>
          </div>
          {(summary.topSleevedSlots || 0) > 0 && (
            <div className="row" style={{ marginTop: 10 }}>
              <button className="btn btn-sm btn-danger" onClick={clearTags} disabled={busy}>Clear all tags</button>
            </div>
          )}
        </div>
      )}

      {/* Templates */}
      {templates.length === 0 ? (
        <div className="panel" style={{ padding: 24, textAlign: 'center' }}>
          <div className="muted">No templates yet.</div>
          <div className="muted small" style={{ marginTop: 6 }}>
            Create one to tag which teams get top-sleeved, then apply it after each PDF upload.
          </div>
          <button className="btn btn-primary" style={{ marginTop: 14 }} onClick={startNew}>+ New template</button>
        </div>
      ) : (
        <div className="panel">
          {templates.map((t) => (
            <div
              key={t.id}
              className="row-between"
              style={{ padding: '12px 16px', borderBottom: '1px solid var(--line)', gap: 12, flexWrap: 'wrap' }}
            >
              <div className="col" style={{ gap: 3, minWidth: 200, flex: 1 }}>
                <div className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <strong>{t.name}</strong>
                  <span className="badge">{sportLabel(t.sport)}</span>
                  {t.isDefault && <span className="badge sleeve" title="Auto-applies on every import">★ Default</span>}
                  {t.isApplied && <span className="badge green">Applied</span>}
                </div>
                <div className="muted small">
                  {t.teamCount} team{t.teamCount === 1 ? '' : 's'} across {t.breakCount} break{t.breakCount === 1 ? '' : 's'}
                </div>
              </div>
              <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                <button className="btn btn-sm btn-primary" onClick={() => apply(t)} disabled={busy}>Apply</button>
                <button className="btn btn-sm" onClick={() => toggleDefault(t)} disabled={busy}>
                  {t.isDefault ? 'Unset default' : 'Set default'}
                </button>
                <button className="btn btn-sm" onClick={() => startEdit(t.id)} disabled={busy}>Edit</button>
                {confirmDeleteId === t.id ? (
                  <>
                    <button className="btn btn-sm btn-danger" onClick={() => remove(t)} disabled={busy}>Confirm</button>
                    <button className="btn btn-sm btn-ghost" onClick={() => setConfirmDeleteId(null)}>Cancel</button>
                  </>
                ) : (
                  <button className="btn btn-sm btn-danger" onClick={() => setConfirmDeleteId(t.id)} disabled={busy}>Delete</button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
