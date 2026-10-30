import { useEffect } from 'react'
import {
  AlertCircle,
  CheckCircle2,
  Info,
  Inbox,
  Loader2,
  Minus,
  Plus,
  Star,
  X,
} from 'lucide-react'
import { cn, initials } from '../lib/utils'

/* ------------------------------------------------------------------ spinner */
export function Spinner({ size = 18, className = '' }) {
  return (
    <Loader2
      size={size}
      className={cn('animate-spin', className)}
      aria-hidden="true"
    />
  )
}

export function PageLoader({ label = 'Loading M-Hustle…' }) {
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4 px-6 text-center">
      <span className="grid h-12 w-12 place-items-center rounded-2xl border border-white/10 bg-white/[0.04]">
        <Spinner size={22} className="text-orange-300" />
      </span>
      <p className="text-sm text-gray-400">{label}</p>
    </div>
  )
}

/* -------------------------------------------------------------------- alert */
const ALERT_STYLES = {
  error: {
    wrapper: 'border-red-500/25 bg-red-500/[0.08] text-red-200',
    icon: AlertCircle,
    iconClass: 'text-red-400',
  },
  success: {
    wrapper: 'border-emerald-500/25 bg-emerald-500/[0.08] text-emerald-200',
    icon: CheckCircle2,
    iconClass: 'text-emerald-400',
  },
  info: {
    wrapper: 'border-sky-500/25 bg-sky-500/[0.08] text-sky-200',
    icon: Info,
    iconClass: 'text-sky-400',
  },
  warning: {
    wrapper: 'border-amber-500/25 bg-amber-500/[0.08] text-amber-200',
    icon: AlertCircle,
    iconClass: 'text-amber-400',
  },
}

export function Alert({ variant = 'error', title, children, className, onClose }) {
  const styles = ALERT_STYLES[variant] ?? ALERT_STYLES.error
  const Icon = styles.icon

  return (
    <div
      role="alert"
      className={cn(
        'flex items-start gap-3 rounded-2xl border px-4 py-3.5 text-sm leading-relaxed',
        styles.wrapper,
        className,
      )}
    >
      <Icon size={18} className={cn('mt-0.5 shrink-0', styles.iconClass)} />
      <div className="min-w-0 flex-1">
        {title ? <p className="font-semibold text-white">{title}</p> : null}
        {children ? <div className={title ? 'mt-1 opacity-90' : ''}>{children}</div> : null}
      </div>
      {onClose ? (
        <button
          type="button"
          onClick={onClose}
          className="shrink-0 rounded-full p-1 text-white/60 transition hover:bg-white/10 hover:text-white"
          aria-label="Dismiss message"
        >
          <X size={15} />
        </button>
      ) : null}
    </div>
  )
}

/* --------------------------------------------------------------- empty state */
export function EmptyState({
  icon: Icon = Inbox,
  title,
  description,
  action,
  className,
}) {
  return (
    <div
      className={cn(
        'glass flex flex-col items-center justify-center rounded-3xl px-6 py-14 text-center',
        className,
      )}
    >
      <span className="grid h-14 w-14 place-items-center rounded-2xl border border-white/10 bg-white/[0.04] text-gray-400">
        <Icon size={24} />
      </span>
      <h3 className="mt-5 text-lg font-semibold text-white">{title}</h3>
      {description ? (
        <p className="mt-2 max-w-md text-sm leading-relaxed text-gray-400">{description}</p>
      ) : null}
      {action ? <div className="mt-6">{action}</div> : null}
    </div>
  )
}

/* ------------------------------------------------------------------- avatar */
export function Avatar({ profile, size = 40, className = '' }) {
  const name = profile?.full_name || profile?.username || 'M-Hustle'
  const dimension = typeof size === 'number' ? `${size}px` : size

  if (profile?.avatar_url) {
    return (
      <img
        src={profile.avatar_url}
        alt={name}
        width={size}
        height={size}
        loading="lazy"
        referrerPolicy="no-referrer"
        className={cn('shrink-0 rounded-full border border-white/10 object-cover', className)}
        style={{ width: dimension, height: dimension }}
      />
    )
  }

  return (
    <span
      className={cn(
        'grid shrink-0 place-items-center rounded-full border border-white/10 bg-gradient-to-br from-orange-500/25 to-pink-500/25 font-display font-semibold text-orange-100',
        className,
      )}
      style={{
        width: dimension,
        height: dimension,
        fontSize: `calc(${dimension} * 0.36)`,
      }}
      aria-hidden="true"
    >
      {initials(name)}
    </span>
  )
}

/* -------------------------------------------------------------- status pill */
export function StatusPill({ meta, className }) {
  if (!meta) return null
  return (
    <span className={cn('badge', meta.className, className)}>
      {meta.dot ? <span className={cn('h-1.5 w-1.5 rounded-full', meta.dot)} /> : null}
      {meta.label}
    </span>
  )
}

/* ------------------------------------------------------------------- stats */
export function StatCard({ icon: Icon, label, value, hint, accent = 'orange' }) {
  const accents = {
    orange: 'from-orange-500/20 to-pink-500/10 text-orange-300',
    green: 'from-emerald-500/20 to-teal-500/10 text-emerald-300',
    purple: 'from-purple-500/20 to-blue-500/10 text-purple-300',
    amber: 'from-amber-500/20 to-yellow-500/10 text-amber-300',
  }

  return (
    <div className="card glass-hover p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[11px] font-medium uppercase tracking-[0.16em] text-gray-500">
            {label}
          </p>
          <p className="mt-2 truncate font-display text-2xl font-semibold text-white">{value}</p>
        </div>
        <span
          className={cn(
            'grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-white/10 bg-gradient-to-br',
            accents[accent] ?? accents.orange,
          )}
        >
          {Icon ? <Icon size={18} /> : null}
        </span>
      </div>
      {hint ? <p className="mt-3 text-xs leading-relaxed text-gray-500">{hint}</p> : null}
    </div>
  )
}

/* ------------------------------------------------------------------- modal */
export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = 'md',
}) {
  useEffect(() => {
    if (!open) return undefined

    const onKeyDown = (event) => {
      if (event.key === 'Escape') onClose?.()
    }

    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    document.addEventListener('keydown', onKeyDown)

    return () => {
      document.body.style.overflow = previousOverflow
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open, onClose])

  if (!open) return null

  const sizes = {
    sm: 'max-w-sm',
    md: 'max-w-md',
    lg: 'max-w-lg',
    xl: 'max-w-2xl',
  }

  return (
    <div className="fixed inset-0 z-[70] flex items-end justify-center px-4 pb-4 sm:items-center sm:pb-0">
      <button
        type="button"
        className="absolute inset-0 bg-black/70 backdrop-blur-sm"
        onClick={onClose}
        aria-label="Close dialog"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title || 'Dialog'}
        className={cn(
          'glass relative w-full animate-fade-up rounded-3xl p-6 shadow-card sm:p-7',
          sizes[size] ?? sizes.md,
        )}
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            {title ? <h3 className="text-lg font-semibold text-white">{title}</h3> : null}
            {description ? (
              <p className="mt-1.5 text-sm leading-relaxed text-gray-400">{description}</p>
            ) : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full p-1.5 text-gray-500 transition hover:bg-white/10 hover:text-white"
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </div>
        {children ? <div className="mt-5">{children}</div> : null}
        {footer ? <div className="mt-6 flex flex-wrap justify-end gap-2">{footer}</div> : null}
      </div>
    </div>
  )
}

/* ------------------------------------------------------------ section header */
export function SectionHeading({ eyebrow, title, description, action }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div className="max-w-2xl">
        {eyebrow ? <p className="eyebrow">{eyebrow}</p> : null}
        <h2 className="mt-2 text-2xl font-semibold tracking-tight text-white sm:text-3xl">
          {title}
        </h2>
        {description ? (
          <p className="mt-2 text-sm leading-relaxed text-gray-400">{description}</p>
        ) : null}
      </div>
      {action}
    </div>
  )
}

/* ---------------------------------------------------------------- quantity */
export function QuantityStepper({ value, onChange, min = 1, max = 99, disabled = false }) {
  const decrement = () => onChange(Math.max(min, value - 1))
  const increment = () => onChange(Math.min(max, value + 1))

  return (
    <div className="inline-flex items-center rounded-full border border-white/10 bg-black/30">
      <button
        type="button"
        onClick={decrement}
        disabled={disabled || value <= min}
        className="grid h-9 w-9 place-items-center rounded-full text-gray-300 transition hover:bg-white/10 hover:text-white disabled:opacity-30"
        aria-label="Decrease quantity"
      >
        <Minus size={14} />
      </button>
      <span className="w-8 text-center text-sm font-semibold tabular-nums text-white">
        {value}
      </span>
      <button
        type="button"
        onClick={increment}
        disabled={disabled || value >= max}
        className="grid h-9 w-9 place-items-center rounded-full text-gray-300 transition hover:bg-white/10 hover:text-white disabled:opacity-30"
        aria-label="Increase quantity"
      >
        <Plus size={14} />
      </button>
    </div>
  )
}

/* ------------------------------------------------------------------ ratings */
export function RatingStars({
  value = 0,
  onChange = null,
  size = 14,
  className = '',
}) {
  const active = Math.round(Number(value) || 0)

  return (
    <div className={cn('inline-flex items-center gap-0.5', className)}>
      {[1, 2, 3, 4, 5].map((star) => {
        const filled = star <= active
        const icon = (
          <Star
            size={size}
            className={filled ? 'text-amber-400' : 'text-gray-700'}
            fill={filled ? 'currentColor' : 'none'}
          />
        )

        if (!onChange) {
          return <span key={star}>{icon}</span>
        }

        return (
          <button
            key={star}
            type="button"
            onClick={() => onChange(star)}
            className="rounded p-0.5 transition hover:scale-110"
            aria-label={`Rate ${star} out of 5`}
          >
            {icon}
          </button>
        )
      })}
    </div>
  )
}

export function SellerRating({ rating, size = 12, className = '' }) {
  if (!rating || !Number(rating.review_count)) return null

  return (
    <span
      className={cn('inline-flex items-center gap-1 text-[11px] text-gray-400', className)}
      title={`${Number(rating.average_rating).toFixed(1)} from ${rating.review_count} review${Number(rating.review_count) === 1 ? '' : 's'}`}
    >
      <Star size={size} className="text-amber-400" fill="currentColor" />
      {Number(rating.average_rating).toFixed(1)}
      <span className="text-gray-600">({rating.review_count})</span>
    </span>
  )
}
