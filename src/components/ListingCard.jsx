import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { ImageOff } from 'lucide-react'
import { categoryIcon } from '../lib/constants'
import { cn, formatKES, timeAgo } from '../lib/utils'
import { Avatar, SellerRating } from './ui'
import VerifiedBadge from './VerifiedBadge'

export default function ListingCard({ listing, badge = null, rating = null, className = '' }) {
  const [imageFailed, setImageFailed] = useState(false)
  const Icon = categoryIcon(listing.category)
  const seller = listing.seller
  const plan = badge?.plan

  useEffect(() => {
    setImageFailed(false)
  }, [listing.image_url])

  return (
    <Link
      to={`/product/${listing.id}`}
      className={cn(
        'group glass glass-hover flex flex-col overflow-hidden rounded-3xl',
        className,
      )}
    >
      <div className="relative aspect-[4/3] overflow-hidden bg-ink-800">
        {listing.image_url && !imageFailed ? (
          <img
            src={listing.image_url}
            alt={listing.title}
            loading="lazy"
            onError={() => setImageFailed(true)}
            className="h-full w-full object-cover transition duration-700 ease-out group-hover:scale-[1.045]"
          />
        ) : (
          <div className="flex h-full w-full flex-col items-center justify-center gap-2 bg-[radial-gradient(circle_at_50%_20%,rgba(249,115,22,0.16),transparent_65%)] text-gray-600">
            {imageFailed ? <ImageOff size={28} /> : <Icon size={30} />}
            <span className="text-[10px] uppercase tracking-[0.2em] text-gray-600">
              {listing.category}
            </span>
          </div>
        )}

        <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-ink-950/75 via-transparent to-black/10" />

        <div className="absolute left-3 top-3 flex items-center gap-1.5 rounded-full border border-white/10 bg-black/45 px-2.5 py-1 text-[10px] font-medium uppercase tracking-[0.12em] text-gray-200 backdrop-blur-md">
          <Icon size={11} className="text-orange-300" />
          {listing.category}
        </div>

        {plan ? (
          <div
            className={cn(
              'absolute right-3 top-3 flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.1em] backdrop-blur-md',
              plan === 'pro_max'
                ? 'border-amber-300/30 bg-amber-500/15 text-amber-200'
                : 'border-blue-300/30 bg-blue-500/15 text-blue-200',
            )}
          >
            <VerifiedBadge plan={plan} size={13} />
            {plan === 'pro_max' ? 'Pro Max' : 'Pro'}
          </div>
        ) : null}
      </div>

      <div className="flex flex-1 flex-col p-4">
        <h3 className="line-clamp-2 min-h-[2.6rem] text-[15px] font-semibold leading-snug text-white transition group-hover:text-orange-100">
          {listing.title}
        </h3>

        <p className="mt-2 font-display text-lg font-semibold tracking-tight text-white">
          {formatKES(listing.price)}
        </p>

        <div className="mt-4 flex items-center gap-2 border-t border-white/[0.07] pt-3">
          <Avatar profile={seller} size={22} />
          <div className="min-w-0 flex-1">
            <p className="truncate text-xs text-gray-400">
              {seller?.full_name || seller?.username || 'M-Hustle seller'}
            </p>
            {rating ? (
              <SellerRating rating={rating} className="mt-0.5" />
            ) : (
              <p className="mt-0.5 text-[10px] text-gray-600">New seller</p>
            )}
          </div>
          {plan ? <VerifiedBadge plan={plan} size={14} /> : null}
        </div>

        <div className="mt-2 flex items-center justify-between gap-2 text-[10px] uppercase tracking-[0.12em] text-gray-600">
          <span>{timeAgo(listing.created_at)}</span>
          <span>
            {Number(listing.quantity) === 0
              ? 'Sold out'
              : `${listing.quantity ?? 1} available`}
          </span>
        </div>
      </div>
    </Link>
  )
}
