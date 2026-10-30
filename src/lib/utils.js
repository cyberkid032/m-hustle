import { format, formatDistanceToNow, isToday, isYesterday } from 'date-fns'

/** Join conditional class names without pulling in another dependency. */
export function cn(...classes) {
  return classes.filter(Boolean).join(' ')
}

/** KES 12,500 — never "$" and never a bare number. */
export function formatKES(value, { compact = false } = {}) {
  const amount = Number(value ?? 0)
  if (!Number.isFinite(amount)) return 'KES 0'

  if (compact && Math.abs(amount) >= 1_000_000) {
    const millions = amount / 1_000_000
    return `KES ${trimZeros(millions.toFixed(1))}M`
  }
  if (compact && Math.abs(amount) >= 10_000) {
    const thousands = amount / 1_000
    return `KES ${trimZeros(thousands.toFixed(1))}K`
  }

  const hasCents = Math.round(amount * 100) % 100 !== 0
  return `KES ${new Intl.NumberFormat('en-KE', {
    minimumFractionDigits: hasCents ? 2 : 0,
    maximumFractionDigits: 2,
  }).format(amount)}`
}

function trimZeros(text) {
  return text.replace(/\.0$/, '')
}

/** "12 Mar 2025" */
export function formatDate(value) {
  if (!value) return '—'
  try {
    return format(new Date(value), 'd MMM yyyy')
  } catch {
    return '—'
  }
}

/** "12 Mar 2025, 14:08" */
export function formatDateTime(value) {
  if (!value) return '—'
  try {
    return format(new Date(value), 'd MMM yyyy, HH:mm')
  } catch {
    return '—'
  }
}

/** "3 hours ago" */
export function timeAgo(value) {
  if (!value) return ''
  try {
    return formatDistanceToNow(new Date(value), { addSuffix: true })
  } catch {
    return ''
  }
}

/** Chat timestamps: "14:08", "Yesterday", "12 Mar" */
export function chatTime(value) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  if (isToday(date)) return format(date, 'HH:mm')
  if (isYesterday(date)) return 'Yesterday'
  return format(date, 'd MMM')
}

export function initials(name = '') {
  return (
    name
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase() ?? '')
      .join('') || 'MH'
  )
}

export function truncate(text = '', length = 120) {
  if (text.length <= length) return text
  return `${text.slice(0, length).trimEnd()}…`
}

/** Returns the best live plan for a seller id, or null. */
export function planForSeller(badges, sellerId) {
  if (!badges || !sellerId) return null
  const badge = badges[sellerId]
  return badge ?? null
}

/** Paid plans always rank above free listings. */
export function planRank(plan) {
  if (plan === 'pro_max') return 2
  if (plan === 'pro') return 1
  return 0
}

export function sortListingsByPriority(listings, badges, ratings = {}) {
  return [...listings].sort((a, b) => {
    const rankDiff =
      planRank(badges?.[b.seller_id]?.plan) - planRank(badges?.[a.seller_id]?.plan)
    if (rankDiff !== 0) return rankDiff

    const ratingA = Number(ratings?.[a.seller_id]?.average_rating ?? 0)
    const ratingB = Number(ratings?.[b.seller_id]?.average_rating ?? 0)
    if (ratingB !== ratingA) return ratingB - ratingA

    const reviewsA = Number(ratings?.[a.seller_id]?.review_count ?? 0)
    const reviewsB = Number(ratings?.[b.seller_id]?.review_count ?? 0)
    if (reviewsB !== reviewsA) return reviewsB - reviewsA

    return new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
  })
}

export function groupBySeller(items) {
  const groups = new Map()
  for (const item of items) {
    if (!groups.has(item.seller_id)) {
      groups.set(item.seller_id, {
        sellerId: item.seller_id,
        sellerName: item.seller_name || 'Seller',
        items: [],
      })
    }
    groups.get(item.seller_id).items.push(item)
  }
  return [...groups.values()]
}

const ERROR_MESSAGES = {
  LISTING_UNAVAILABLE: 'One of these items was just sold. Remove it from your cart and try again.',
  LISTING_NOT_FOUND: 'One of these listings no longer exists.',
  INSUFFICIENT_STOCK: 'One of these items no longer has enough stock. Reduce the quantity and try again.',
  SELLER_MISMATCH: 'This cart contains items from a different seller.',
  INVALID_QUANTITY: 'One item has an invalid quantity.',
  EMPTY_CART: 'Your cart is empty.',
  TOO_MANY_ITEMS: 'You can order at most 20 different items from one seller at a time.',
  AUTH_REQUIRED: 'Please sign in to continue.',
  ACCOUNT_SUSPENDED: 'This account is suspended. Contact the M-Hustle team.',
  INVALID_SELLER: 'You cannot buy from this seller.',
  SELLER_UNAVAILABLE: 'This seller is not accepting orders right now.',
  USERNAME_LOGIN_UNAVAILABLE:
    'Username sign-in is not enabled in the database yet. Run the latest schema update, or sign in with your email.',
  ROLE_CHANGE_FORBIDDEN: 'You are not allowed to change your role.',
  SUSPENSION_CHANGE_FORBIDDEN: 'You are not allowed to change account status.',
  EMAIL_CHANGE_FORBIDDEN: 'Email addresses cannot be changed here.',
  INVALID_ORDER_TRANSITION: 'That order status change is not allowed.',
  ORDER_FIELDS_IMMUTABLE: 'Order totals and parties cannot be edited.',
  MESSAGE_IMMUTABLE: 'Messages can only be marked as read.',
  CANNOT_SUSPEND_SELF: 'You cannot suspend your own admin account.',
  CANNOT_DELETE_SELF: 'You cannot delete your own account from the console.',
  FORBIDDEN: 'You do not have permission to perform this action.',
  USER_NOT_FOUND: 'That user no longer exists.',
}

/** Turn Postgres / Supabase errors into copy a student can act on. */
export function friendlyError(error, fallback = 'Something went wrong. Please try again.') {
  if (!error) return fallback
  const message = typeof error === 'string' ? error : error.message || ''

  for (const [key, copy] of Object.entries(ERROR_MESSAGES)) {
    if (message.includes(key)) return copy
  }

  if (message.includes('duplicate key') && message.includes('reviews_order_id')) {
    return 'You have already reviewed this order.'
  }
  if (message.includes('duplicate key') && message.includes('mpesa')) {
    return 'That M-Pesa code has already been submitted.'
  }
  if (message.includes('duplicate key') && message.includes('username')) {
    return 'That username is already taken.'
  }
  if (message.includes('duplicate key')) {
    return 'That record already exists.'
  }
  if (message.includes('row-level security') || message.includes('permission denied')) {
    return 'Your account does not have permission for that action.'
  }
  if (message.includes('Failed to fetch') || message.includes('NetworkError')) {
    return 'Cannot reach the server. Check your connection and try again.'
  }
  if (message.includes('JWT') || message.includes('session')) {
    return 'Your session expired. Please sign in again.'
  }

  return message || fallback
}

export const ORDER_STATUS_META = {
  pending: {
    label: 'Pending',
    className: 'border-amber-400/25 bg-amber-400/10 text-amber-300',
    dot: 'bg-amber-400',
  },
  delivered: {
    label: 'Delivered',
    className: 'border-sky-400/25 bg-sky-400/10 text-sky-300',
    dot: 'bg-sky-400',
  },
  completed: {
    label: 'Completed',
    className: 'border-emerald-400/25 bg-emerald-400/10 text-emerald-300',
    dot: 'bg-emerald-400',
  },
  cancelled: {
    label: 'Cancelled',
    className: 'border-red-400/25 bg-red-400/10 text-red-300',
    dot: 'bg-red-400',
  },
}

export const LISTING_STATUS_META = {
  active: {
    label: 'Active',
    className: 'border-emerald-400/25 bg-emerald-400/10 text-emerald-300',
  },
  sold: {
    label: 'Sold',
    className: 'border-sky-400/25 bg-sky-400/10 text-sky-300',
  },
  deleted: {
    label: 'Removed',
    className: 'border-red-400/25 bg-red-400/10 text-red-300',
  },
}

export const SUBSCRIPTION_STATUS_META = {
  pending: {
    label: 'Awaiting approval',
    className: 'border-amber-400/25 bg-amber-400/10 text-amber-300',
  },
  active: {
    label: 'Active',
    className: 'border-emerald-400/25 bg-emerald-400/10 text-emerald-300',
  },
  expired: {
    label: 'Expired',
    className: 'border-white/15 bg-white/5 text-gray-400',
  },
}
