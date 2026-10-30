import { useId } from 'react'

/**
 * Meta-style scalloped verification seal.
 *
 * The 12-lobe path is generated from a smooth Catmull-Rom curve through
 * alternating radii, which produces the familiar "seal" silhouette without
 * any raster assets. Blue = Pro, gold = Pro Max.
 */
const SEAL_PATH =
  'M12 1.8 C12.74 1.8 13.38 3.47 14.23 3.69 C15.08 3.92 16.46 2.8 17.1 3.17 C17.74 3.54 17.46 5.3 18.08 5.92 C18.7 6.54 20.46 6.26 20.83 6.9 C21.2 7.54 20.08 8.92 20.31 9.77 C20.53 10.62 22.2 11.26 22.2 12 C22.2 12.74 20.53 13.38 20.31 14.23 C20.08 15.08 21.2 16.46 20.83 17.1 C20.46 17.74 18.7 17.46 18.08 18.08 C17.46 18.7 17.74 20.46 17.1 20.83 C16.46 21.2 15.08 20.08 14.23 20.31 C13.38 20.53 12.74 22.2 12 22.2 C11.26 22.2 10.62 20.53 9.77 20.31 C8.92 20.08 7.54 21.2 6.9 20.83 C6.26 20.46 6.54 18.7 5.92 18.08 C5.3 17.46 3.54 17.74 3.17 17.1 C2.8 16.46 3.92 15.08 3.69 14.23 C3.47 13.38 1.8 12.74 1.8 12 C1.8 11.26 3.47 10.62 3.69 9.77 C3.92 8.92 2.8 7.54 3.17 6.9 C3.54 6.26 5.3 6.54 5.92 5.92 C6.54 5.3 6.26 3.54 6.9 3.17 C7.54 2.8 8.92 3.92 9.77 3.69 C10.62 3.47 11.26 1.8 12 1.8 Z'

const PLAN_THEME = {
  pro: {
    label: 'Pro seller',
    from: '#93c5fd',
    to: '#2563eb',
    stroke: 'rgba(37, 99, 235, 0.55)',
  },
  pro_max: {
    label: 'Pro Max seller',
    from: '#fde68a',
    to: '#d97706',
    stroke: 'rgba(217, 119, 6, 0.55)',
  },
}

export default function VerifiedBadge({
  plan = 'pro',
  size = 16,
  className = '',
  withLabel = false,
  labelClassName = '',
}) {
  const reactId = useId().replace(/[:]/g, '')
  const theme = PLAN_THEME[plan] ?? PLAN_THEME.pro
  const gradientId = `mh-badge-${plan}-${reactId}`

  const seal = (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      role="img"
      aria-label={theme.label}
      className={className}
      style={{ flexShrink: 0 }}
    >
      <defs>
        <linearGradient
          id={gradientId}
          x1="0"
          y1="0"
          x2="24"
          y2="24"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0%" stopColor={theme.from} />
          <stop offset="100%" stopColor={theme.to} />
        </linearGradient>
      </defs>
      <path
        d={SEAL_PATH}
        fill={`url(#${gradientId})`}
        stroke={theme.stroke}
        strokeWidth="0.7"
      />
      <path
        d="M7.45 12.25 10.4 15.2 16.6 8.85"
        fill="none"
        stroke="#ffffff"
        strokeWidth="2.15"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )

  if (!withLabel) return seal

  return (
    <span className={`inline-flex items-center gap-1.5 ${labelClassName}`}>
      {seal}
      <span className="text-[11px] font-semibold uppercase tracking-[0.12em]">
        {theme.label.replace(' seller', '')}
      </span>
    </span>
  )
}
