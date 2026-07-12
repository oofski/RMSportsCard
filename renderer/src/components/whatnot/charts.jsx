// =============================================================================
// charts.jsx — tiny dependency-free SVG charts for the Sales Dashboard.
// -----------------------------------------------------------------------------
// Exports two presentational components:
//
//   • <BarChart />  — vertical bar chart with nice-ceiling y-axis, gridlines,
//     rounded-top bars and a hover tooltip.
//   • <Donut />     — donut/ring chart (top N slices + "Other"), center total,
//     legend and a hover tooltip.
//
// Both components are defensive: every division is guarded so NaN / Infinity
// can never reach an SVG attribute, and empty data renders a friendly
// "No data" state instead of a broken chart. Colors come from the app's design
// tokens (var(--accent), var(--line), var(--text), …) so both themes work.
// =============================================================================

import React, { useEffect, useRef, useState } from 'react'

/** Default value formatter: whole-dollar USD, e.g. 1234.5 → "$1,235". */
const defaultFormatValue = (v) =>
  '$' + Number(v || 0).toLocaleString('en-US', { maximumFractionDigits: 0 })

/** Coerce to a finite number ≥ 0 (never NaN / Infinity / negative). */
function safeNonNeg(n) {
  const v = Number(n)
  return Number.isFinite(v) && v > 0 ? v : 0
}

/**
 * Nice ceiling for an axis maximum: the smallest 1 / 2 / 2.5 / 5 × 10^k that
 * is ≥ max. Returns 100 when max is zero/invalid so the axis always has scale.
 */
function niceMaxOf(max) {
  const m = safeNonNeg(max)
  if (m <= 0) return 100
  const exp = Math.floor(Math.log10(m))
  const pow = Math.pow(10, exp)
  const frac = m / pow
  let nice
  if (frac <= 1) nice = 1
  else if (frac <= 2) nice = 2
  else if (frac <= 2.5) nice = 2.5
  else if (frac <= 5) nice = 5
  else nice = 10
  return nice * pow
}

/** Shared tooltip <div> styling (position is supplied by the caller). */
const TOOLTIP_STYLE = {
  position: 'absolute',
  background: 'var(--bg-3)',
  border: '1px solid var(--line)',
  borderRadius: 6,
  padding: '6px 10px',
  fontSize: 12,
  pointerEvents: 'none',
  whiteSpace: 'nowrap',
  zIndex: 5,
}

const GRID_STROKE = 'color-mix(in srgb, var(--line) 60%, transparent)'

// =============================================================================
// BarChart
// -----------------------------------------------------------------------------
// data: [{ label, value (>= 0), sub? }]. Width tracks the container via a
// ResizeObserver (fallback 640). Bars are drawn as paths with 3px-rounded top
// corners; a transparent full-height hit rect per bar drives the tooltip.
// =============================================================================
export function BarChart({
  data,
  height = 260,
  ariaLabel,
  formatValue = defaultFormatValue,
  maxXLabels = 12,
}) {
  const wrapRef = useRef(null)
  const [width, setWidth] = useState(640) // fallback until measured
  const [hover, setHover] = useState(null) // { i, left, top }

  // Track the wrapper's width so the chart fills its card responsively.
  useEffect(() => {
    const el = wrapRef.current
    if (!el || typeof ResizeObserver === 'undefined') return undefined
    const ro = new ResizeObserver((entries) => {
      const w = entries[0] && entries[0].contentRect && entries[0].contentRect.width
      if (Number.isFinite(w) && w > 0) setWidth(w)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Sanitize rows: labels stringified, values clamped to finite ≥ 0.
  const rows = (Array.isArray(data) ? data : []).map((d) => ({
    label: String((d && d.label) ?? ''),
    value: safeNonNeg(d && d.value),
    sub: d && d.sub,
  }))
  const n = rows.length

  // Plot geometry. Left gutter holds the $ tick labels; bottom holds x labels.
  const pad = { top: 10, right: 8, bottom: 22, left: 52 }
  const plotW = Math.max(0, width - pad.left - pad.right)
  const plotH = Math.max(0, height - pad.top - pad.bottom)

  const maxVal = rows.reduce((m, r) => Math.max(m, r.value), 0)
  const niceMax = niceMaxOf(maxVal) // always > 0, so divisions below are safe

  // 4 horizontal gridlines at 1/4 … 4/4 of niceMax (baseline drawn separately).
  const gridTicks = [1, 2, 3, 4].map((i) => {
    const frac = i / 4
    return { y: pad.top + plotH - frac * plotH, value: niceMax * frac }
  })

  // Bar slots. Guard n > 0 so slotWidth never divides by zero.
  const slotWidth = n > 0 ? plotW / n : 0
  const gap = Math.max(2, slotWidth * 0.25)
  const barW = Math.max(1, slotWidth - gap)
  const labelStep = n > 0 ? Math.max(1, Math.ceil(n / Math.max(1, maxXLabels))) : 1

  /** Build a bar path with rounded TOP corners, flat at the baseline. */
  function barPath(x, yTop, w, h) {
    if (h <= 0 || w <= 0) return ''
    const r = Math.max(0, Math.min(3, w / 2, h)) // 3px, clipped for tiny bars
    const yBase = yTop + h
    return [
      `M ${x} ${yBase}`,
      `L ${x} ${yTop + r}`,
      `Q ${x} ${yTop} ${x + r} ${yTop}`,
      `L ${x + w - r} ${yTop}`,
      `Q ${x + w} ${yTop} ${x + w} ${yTop + r}`,
      `L ${x + w} ${yBase}`,
      'Z',
    ].join(' ')
  }

  const hovered = hover != null && rows[hover.i] ? rows[hover.i] : null

  return (
    <div ref={wrapRef} style={{ position: 'relative', width: '100%' }}>
      <svg
        role="img"
        aria-label={ariaLabel || 'Bar chart'}
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        style={{ display: 'block', maxWidth: '100%' }}
      >
        {/* Gridlines + $ tick labels */}
        {gridTicks.map((t, i) => (
          <g key={i}>
            <line x1={pad.left} x2={pad.left + plotW} y1={t.y} y2={t.y} stroke={GRID_STROKE} />
            <text
              x={pad.left - 6}
              y={t.y + 3.5}
              textAnchor="end"
              fontSize={11}
              fill="var(--text-dim)"
            >
              {formatValue(t.value)}
            </text>
          </g>
        ))}
        {/* Baseline */}
        <line
          x1={pad.left}
          x2={pad.left + plotW}
          y1={pad.top + plotH}
          y2={pad.top + plotH}
          stroke={GRID_STROKE}
        />

        {/* Bars */}
        {rows.map((r, i) => {
          const x = pad.left + i * slotWidth + gap / 2
          const h = (r.value / niceMax) * plotH
          const yTop = pad.top + plotH - h
          const d = barPath(x, yTop, barW, h)
          return d ? (
            <path key={i} d={d} fill="var(--accent)" opacity={hover && hover.i === i ? 0.85 : 1} />
          ) : null
        })}

        {/* X labels: every labelStep-th bar */}
        {rows.map((r, i) =>
          i % labelStep === 0 ? (
            <text
              key={`xl-${i}`}
              x={pad.left + i * slotWidth + slotWidth / 2}
              y={height - 6}
              textAnchor="middle"
              fontSize={10}
              fill="var(--text-dim)"
            >
              {r.label}
            </text>
          ) : null
        )}

        {/* Transparent full-height hit rects (hover targets) */}
        {rows.map((r, i) => {
          const slotX = pad.left + i * slotWidth
          const h = (r.value / niceMax) * plotH
          const yTop = pad.top + plotH - h
          return (
            <rect
              key={`hit-${i}`}
              x={slotX}
              y={pad.top}
              width={Math.max(0, slotWidth)}
              height={plotH}
              fill="transparent"
              onMouseEnter={() =>
                setHover({
                  i,
                  // Tooltip anchors above the bar top, clamped inside the chart.
                  left: Math.min(Math.max(slotX + slotWidth / 2, 48), Math.max(48, width - 48)),
                  top: Math.max(pad.top, yTop) - 8,
                })
              }
              onMouseLeave={() => setHover(null)}
            />
          )
        })}
      </svg>

      {/* Empty state: keep the grid frame, center a muted message over it. */}
      {n === 0 && (
        <div
          className="muted"
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          No data
        </div>
      )}

      {/* Tooltip */}
      {hovered && (
        <div
          style={{
            ...TOOLTIP_STYLE,
            left: hover.left,
            top: hover.top,
            transform: 'translate(-50%, -100%)',
          }}
        >
          <div className="muted small">{hovered.label}</div>
          <div className="mono">{formatValue(hovered.value)}</div>
          {hovered.sub ? <div className="muted small">{hovered.sub}</div> : null}
        </div>
      )}
    </div>
  )
}

// =============================================================================
// Donut
// -----------------------------------------------------------------------------
// slices: [{ label, value }]. Sorted desc, top `maxSlices` kept, the remainder
// folded into an "Other" slice (var(--text-dim)). Segments are filled annular
// sectors stroked with var(--bg-2) so the surface shows through as gaps. A
// single ~100% slice renders as a stroked circle (full ring) — arc paths can't
// represent a 360° sweep.
// =============================================================================
export function Donut({
  slices,
  centerValue,
  centerLabel,
  size = 200,
  thickness = 30,
  maxSlices = 5,
  formatValue = defaultFormatValue,
}) {
  const wrapRef = useRef(null)
  const [hover, setHover] = useState(null) // { label, value, pct, left, top }

  // Theme-aware series palette; "Other" always uses the dim text token.
  const dark =
    typeof document === 'undefined' || document.documentElement.dataset.theme !== 'light'
  const palette = dark
    ? ['#3987e5', '#199e70', '#c98500', '#9085e9', '#e66767']
    : ['#2a78d6', '#1baf7a', '#eda100', '#4a3aa7', '#e34948']

  // Sanitize (clamp to ≥ 0, drop zero slices), sort desc, fold tail → "Other".
  const clean = (Array.isArray(slices) ? slices : [])
    .map((s) => ({ label: String((s && s.label) ?? ''), value: safeNonNeg(s && s.value), title: s && s.title }))
    .filter((s) => s.value > 0)
    .sort((a, b) => b.value - a.value)
  const kept = clean.slice(0, maxSlices)
  const rest = clean.slice(maxSlices)
  if (rest.length > 0) {
    kept.push({ label: 'Other', value: rest.reduce((sum, s) => sum + s.value, 0), isOther: true })
  }
  const total = kept.reduce((sum, s) => sum + s.value, 0)

  const cx = size / 2
  const cy = size / 2
  const R = size / 2 - 1 // outer radius (leave room for the 2px surface stroke)
  const rIn = Math.max(1, R - Math.max(1, thickness)) // inner radius, always < R

  /** Point on a circle of radius `radius` at angle `a` (radians). */
  const pt = (radius, a) => [cx + radius * Math.cos(a), cy + radius * Math.sin(a)]

  /** Annular sector path from angle a0 → a1 (a1 > a0, sweep < 2π). */
  function sectorPath(a0, a1) {
    const large = a1 - a0 > Math.PI ? 1 : 0
    const [ox0, oy0] = pt(R, a0)
    const [ox1, oy1] = pt(R, a1)
    const [ix1, iy1] = pt(rIn, a1)
    const [ix0, iy0] = pt(rIn, a0)
    return [
      `M ${ox0} ${oy0}`,
      `A ${R} ${R} 0 ${large} 1 ${ox1} ${oy1}`,
      `L ${ix1} ${iy1}`,
      `A ${rIn} ${rIn} 0 ${large} 0 ${ix0} ${iy0}`,
      'Z',
    ].join(' ')
  }

  /** Color for the slice at index i ("Other" is always dim). */
  const colorOf = (s, i) => (s.isOther ? 'var(--text-dim)' : palette[i % palette.length])

  // Tooltip positioning: mouse coords relative to the wrapper div.
  const moveTooltip = (e, s) => {
    const rect = wrapRef.current ? wrapRef.current.getBoundingClientRect() : null
    const left = rect ? e.clientX - rect.left : 0
    const top = rect ? e.clientY - rect.top : 0
    const pct = total > 0 ? Math.round((s.value / total) * 100) : 0
    setHover({ label: s.label, value: s.value, pct, left, top })
  }

  // Build segment descriptors (angles start at 12 o'clock, clockwise).
  const segments = []
  if (total > 0) {
    let angle = -Math.PI / 2
    for (let i = 0; i < kept.length; i++) {
      const s = kept[i]
      const frac = s.value / total // total > 0 guarded above
      const sweep = frac * Math.PI * 2
      segments.push({ slice: s, i, a0: angle, a1: angle + sweep, frac })
      angle += sweep
    }
  }

  const midRadius = (R + rIn) / 2

  return (
    <div
      ref={wrapRef}
      style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}
    >
      <svg
        role="img"
        aria-label={centerLabel ? `Donut chart: ${centerLabel}` : 'Donut chart'}
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        style={{ display: 'block', flex: '0 0 auto' }}
      >
        {total <= 0 ? (
          // Empty state: a single muted ring + "No data" in the center.
          <g>
            <circle
              cx={cx}
              cy={cy}
              r={midRadius}
              fill="none"
              stroke={GRID_STROKE}
              strokeWidth={Math.max(1, R - rIn)}
            />
            <text x={cx} y={cy + 4} textAnchor="middle" fontSize={12} fill="var(--text-dim)">
              No data
            </text>
          </g>
        ) : (
          <g>
            {segments.map((seg) => {
              const { slice: s, i, a0, a1, frac } = seg
              const fill = colorOf(s, i)
              const shared = {
                onMouseEnter: (e) => moveTooltip(e, s),
                onMouseMove: (e) => moveTooltip(e, s),
                onMouseLeave: () => setHover(null),
              }
              // Full-circle edge case: a ~360° slice cannot be drawn with a
              // single arc command — render a stroked circle (complete ring).
              if (frac >= 0.9995) {
                return (
                  <circle
                    key={i}
                    cx={cx}
                    cy={cy}
                    r={midRadius}
                    fill="none"
                    stroke={fill}
                    strokeWidth={Math.max(1, R - rIn)}
                    {...shared}
                  />
                )
              }
              return (
                <path
                  key={i}
                  d={sectorPath(a0, a1)}
                  fill={fill}
                  stroke="var(--bg-2)"
                  strokeWidth={2}
                  {...shared}
                />
              )
            })}
            {/* Center total. Fill is set directly to var(--text) — SVG text
                works with CSS custom properties in modern Chromium. */}
            <text
              x={cx}
              y={cy - 1}
              textAnchor="middle"
              fontSize={18}
              fontWeight={650}
              fill="var(--text)"
            >
              {formatValue(centerValue)}
            </text>
            {centerLabel ? (
              <text x={cx} y={cy + 15} textAnchor="middle" fontSize={11} fill="var(--text-dim)">
                {centerLabel}
              </text>
            ) : null}
          </g>
        )}
      </svg>

      {/* Legend */}
      <div style={{ flex: 1, minWidth: 0 }}>
        {kept.map((s, i) => {
          const pct = total > 0 ? Math.round((s.value / total) * 100) : 0
          return (
            <div key={`${s.label}-${i}`} className="row" style={{ gap: 8, padding: '3px 0', minWidth: 0 }}>
              <span
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: '50%',
                  background: colorOf(s, i),
                  flex: '0 0 auto',
                }}
              />
              <span
                className="small"
                style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                title={s.title || s.label}
              >
                {s.label}
              </span>
              <span className="mono small nowrap">{formatValue(s.value)}</span>
              <span className="muted small nowrap">{pct}%</span>
            </div>
          )
        })}
        {kept.length === 0 && <div className="muted small">No data</div>}
      </div>

      {/* Tooltip */}
      {hover && (
        <div
          style={{
            ...TOOLTIP_STYLE,
            left: hover.left,
            top: hover.top,
            transform: 'translate(-50%, calc(-100% - 10px))',
          }}
        >
          <div className="muted small">{hover.label}</div>
          <div className="mono">
            {formatValue(hover.value)} <span className="muted">· {hover.pct}%</span>
          </div>
        </div>
      )}
    </div>
  )
}
