import React from 'react';

/**
 * RM SPORTSCARDS brand mark.
 *
 * Inline SVG (no external asset import) so it scales crisply at any size and
 * ships in the bundle with zero extra requests. Mirrors the master asset at
 * renderer/src/assets/logo.svg: a royal-blue gradient circle with white "RM"
 * and (optionally) the "SPORTSCARDS" wordmark.
 *
 * @param {number}  [size=32]            width & height in px (square).
 * @param {boolean} [withWordmark=false] render the SPORTSCARDS wordmark band.
 * @param {string}  [className]          passed through to the root <svg>.
 */
export default function Logo({ size = 32, withWordmark = false, className }) {
  // Unique per-instance gradient id so two <Logo/> on the same page (e.g.
  // sidebar + login) never collide on a shared `url(#...)` reference.
  const gid = React.useId();
  // Bare mark uses a tighter viewBox so the circle is not letterboxed by the
  // empty wordmark band; full lockup keeps the master 512x512 canvas.
  const viewBox = withWordmark ? '0 0 512 512' : '0 0 512 400';

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox={viewBox}
      width={size}
      height={size}
      className={className}
      role="img"
      aria-label="RM SPORTSCARDS"
    >
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#4A7BC0" />
          <stop offset="1" stopColor="#3A64AB" />
        </linearGradient>
      </defs>
      <circle cx="256" cy="256" r="256" fill={`url(#${gid})`} />
      {/* "RM": bold white letters with a thin inner blue rule that echoes the
          brand's double-outline look while staying legible at small sizes. */}
      <text
        x="256"
        y="238"
        textAnchor="middle"
        dominantBaseline="middle"
        fontFamily="Arial, Helvetica, 'DejaVu Sans', sans-serif"
        fontWeight="800"
        fontSize="196"
        letterSpacing="-6"
        fill="#ffffff"
      >
        RM
      </text>
      <text
        x="256"
        y="238"
        textAnchor="middle"
        dominantBaseline="middle"
        fontFamily="Arial, Helvetica, 'DejaVu Sans', sans-serif"
        fontWeight="800"
        fontSize="196"
        letterSpacing="-6"
        fill="none"
        stroke="#3A64AB"
        strokeWidth="4"
      >
        RM
      </text>
      {withWordmark && (
        <text
          x="256"
          y="360"
          textAnchor="middle"
          dominantBaseline="middle"
          fontFamily="Arial, Helvetica, 'DejaVu Sans', sans-serif"
          fontWeight="700"
          fontSize="52"
          letterSpacing="7"
          fill="#ffffff"
        >
          SPORTSCARDS
        </text>
      )}
    </svg>
  );
}
