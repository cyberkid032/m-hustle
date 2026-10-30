import {
  BedDouble,
  BookOpen,
  Dumbbell,
  Laptop,
  Package,
  PenLine,
  Shirt,
  Sparkles,
  UtensilsCrossed,
  Wrench,
} from 'lucide-react'

/** Exact Maseno hostel list used by the Edit Profile location dropdown. */
export const HOSTELS = [
  'Kilimanjaro',
  'Niles',
  'Nyabundi',
  'ACV',
  'Equator',
  'Elgon',
  'Mara 1',
  'Mara 2',
  'Mara 3',
  'Mara 4',
  'Rusinga',
  'Ndeere',
  'Victoria',
]

/** Category values are stored as plain text in public.listings.category. */
export const CATEGORIES = [
  { value: 'Electronics', icon: Laptop },
  { value: 'Textbooks', icon: BookOpen },
  { value: 'Fashion', icon: Shirt },
  { value: 'Food', icon: UtensilsCrossed },
  { value: 'Hostel & Living', icon: BedDouble },
  { value: 'Services', icon: Wrench },
  { value: 'Stationery', icon: PenLine },
  { value: 'Sports & Fitness', icon: Dumbbell },
  { value: 'Other', icon: Package },
]

export function categoryIcon(category) {
  return CATEGORIES.find((item) => item.value === category)?.icon ?? Sparkles
}

export const PLANS = [
  {
    id: 'pro',
    name: 'Pro',
    price: 100,
    tagline: 'Stand out from the crowd',
    description: 'A blue verified badge on every listing and priority placement above free sellers.',
    accent: 'from-blue-500 to-cyan-400',
    ring: 'border-blue-400/30',
    glow: 'shadow-[0_0_60px_-18px_rgba(59,130,246,0.65)]',
    badge: 'pro',
    features: [
      'Blue verified badge',
      'Priority above free listings',
      '30 days of visibility',
      'Unlimited active listings',
    ],
  },
  {
    id: 'pro_max',
    name: 'Pro Max',
    price: 300,
    tagline: 'The top of the feed',
    description: 'The gold badge, first position in search, and the strongest seller presence on campus.',
    accent: 'from-amber-400 to-yellow-500',
    ring: 'border-amber-400/40',
    glow: 'shadow-[0_0_60px_-18px_rgba(245,158,11,0.7)]',
    badge: 'pro_max',
    features: [
      'Gold verified badge',
      'Top priority in search and feed',
      '30 days of visibility',
      'Unlimited active listings',
    ],
  },
]

export const PLAN_BY_ID = Object.fromEntries(PLANS.map((plan) => [plan.id, plan]))

// Live M-Pesa collection details for subscription upgrades.
export const MPESA_PAYBILL = '400200'
export const MPESA_ACCOUNT = '1211964'
export const ORGANISATION = 'HartTech'
export const SUPPORT_EMAIL = 'helloharttech@gmail.com'

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024
export const ACCEPTED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/avif']
