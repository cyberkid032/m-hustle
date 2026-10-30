import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import {
  ArrowLeft,
  Check,
  ChevronRight,
  Clock3,
  ImageOff,
  MapPin,
  MessageSquare,
  RefreshCw,
  Share2,
  ShieldCheck,
  ShoppingBag,
  Store,
  Tag,
} from 'lucide-react'
import ListingCard from '../components/ListingCard'
import VerifiedBadge from '../components/VerifiedBadge'
import { Alert, Avatar, EmptyState, PageLoader, QuantityStepper, SellerRating } from '../components/ui'
import { useAuth } from '../hooks/useAuth'
import { useCart } from '../context/CartContext'
import { supabase } from '../lib/supabase'
import {
  categoryIcon,
} from '../lib/constants'
import { formatDate, formatKES, timeAgo, cn } from '../lib/utils'

const DETAIL_SELECT = `
  id, title, description, price, category, image_url, quantity, status, created_at, seller_id,
  seller:profiles!listings_seller_id_fkey(id, username, full_name, role, avatar_url, location, created_at)
`

export default function ProductDetail() {
  const { id } = useParams()
  const navigate = useNavigate()
  const { user, profile, isSuspended } = useAuth()
  const { addItem } = useCart()

  const [listing, setListing] = useState(null)
  const [badge, setBadge] = useState(null)
  const [rating, setRating] = useState(null)
  const [ratings, setRatings] = useState({})
  const [related, setRelated] = useState([])
  const [quantity, setQuantity] = useState(1)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [notFound, setNotFound] = useState(false)
  const [added, setAdded] = useState(false)
  const [copied, setCopied] = useState(false)
  const [imageFailed, setImageFailed] = useState(false)

  const addedTimer = useRef(null)
  const copiedTimer = useRef(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    setNotFound(false)
    setImageFailed(false)

    const { data, error: fetchError } = await supabase
      .from('listings')
      .select(DETAIL_SELECT)
      .eq('id', id)
      .maybeSingle()

    if (fetchError) {
      setError(fetchError.message)
      setLoading(false)
      return
    }

    if (!data) {
      setNotFound(true)
      setLoading(false)
      return
    }

    setListing(data)
    setQuantity(1)

    const [badgeResult, ratingResult, relatedResult] = await Promise.all([
      supabase.rpc('get_seller_badges'),
      supabase.rpc('get_seller_ratings'),
      supabase
        .from('listings')
        .select(
          'id, title, price, category, image_url, quantity, created_at, status, seller_id, seller:profiles!listings_seller_id_fkey(id, username, full_name, avatar_url)',
        )
        .eq('status', 'active')
        .eq('category', data.category)
        .neq('id', data.id)
        .order('created_at', { ascending: false })
        .limit(4),
    ])

    const badgeRows = badgeResult.data ?? []
    setBadge(badgeRows.find((row) => row.seller_id === data.seller_id) ?? null)

    const ratingMap = {}
    for (const row of ratingResult.data ?? []) ratingMap[row.seller_id] = row
    setRatings(ratingMap)
    setRating(ratingMap[data.seller_id] ?? null)

    setRelated(relatedResult.data ?? [])
    setLoading(false)
  }, [id])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    return () => {
      if (addedTimer.current) clearTimeout(addedTimer.current)
      if (copiedTimer.current) clearTimeout(copiedTimer.current)
    }
  }, [])

  if (loading) {
    return <PageLoader label="Opening this listing…" />
  }

  if (notFound) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-20">
        <EmptyState
          icon={ShoppingBag}
          title="This listing is not available"
          description="It may have been sold, removed by the seller, or the link is incorrect. The rest of the campus feed is still open."
          action={
            <Link to="/" className="btn-primary">
              <ArrowLeft size={16} />
              Back to marketplace
            </Link>
          }
        />
      </div>
    )
  }

  if (error || !listing) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-20">
        <Alert variant="error" title="Could not load this listing">
          {error}
          <button type="button" onClick={() => void load()} className="btn-secondary btn-sm mt-3">
            <RefreshCw size={13} />
            Try again
          </button>
        </Alert>
      </div>
    )
  }

  const seller = listing.seller
  const isOwner = user?.id === listing.seller_id
  const stock = Math.max(0, Number(listing.quantity ?? 1))
  const isSold = listing.status !== 'active' || stock <= 0
  const Icon = categoryIcon(listing.category)
  const canBuy = !isSold && !isOwner && !isSuspended

  const flashAdded = () => {
    setAdded(true)
    if (addedTimer.current) clearTimeout(addedTimer.current)
    addedTimer.current = setTimeout(() => setAdded(false), 2200)
  }

  const onAddToCart = () => {
    if (!canBuy) return
    addItem(listing, quantity, seller?.full_name || seller?.username)
    flashAdded()
  }

  const onBuyNow = () => {
    if (!canBuy) return
    addItem(listing, quantity, seller?.full_name || seller?.username)
    if (!user) {
      navigate('/login', { state: { from: '/checkout' } })
      return
    }
    navigate('/checkout')
  }

  const onChat = () => {
    if (!user) {
      navigate('/login', {
        state: { from: `/messages?user=${listing.seller_id}&listing=${listing.id}` },
      })
      return
    }
    navigate(`/messages?user=${listing.seller_id}&listing=${listing.id}`)
  }

  const onShare = async () => {
    const url = window.location.href
    try {
      if (navigator.share) {
        await navigator.share({ title: listing.title, text: `Available on M-Hustle: ${listing.title}`, url })
        return
      }
      await navigator.clipboard.writeText(url)
      setCopied(true)
      if (copiedTimer.current) clearTimeout(copiedTimer.current)
      copiedTimer.current = setTimeout(() => setCopied(false), 2000)
    } catch {
      // User dismissed the share sheet — nothing to do.
    }
  }

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
      <nav className="flex flex-wrap items-center gap-1.5 text-xs text-gray-500">
        <Link to="/" className="transition hover:text-white">
          Marketplace
        </Link>
        <ChevronRight size={12} />
        <Link
          to={`/?category=${encodeURIComponent(listing.category)}`}
          className="transition hover:text-white"
        >
          {listing.category}
        </Link>
        <ChevronRight size={12} />
        <span className="max-w-[220px] truncate text-gray-400">{listing.title}</span>
      </nav>

      <div className="mt-6 grid gap-8 lg:grid-cols-[1.05fr_0.95fr] lg:gap-12">
        {/* ---------------------------------------------------------- media */}
        <div>
          <div className="glass relative overflow-hidden rounded-4xl p-2.5">
            <div className="relative aspect-[4/3] overflow-hidden rounded-3xl bg-ink-800">
              {listing.image_url && !imageFailed ? (
                <img
                  src={listing.image_url}
                  alt={listing.title}
                  onError={() => setImageFailed(true)}
                  className="h-full w-full object-cover"
                />
              ) : (
                <div className="flex h-full w-full flex-col items-center justify-center gap-3 bg-[radial-gradient(circle_at_50%_30%,rgba(249,115,22,0.18),transparent_65%)] text-gray-600">
                  {imageFailed ? <ImageOff size={40} /> : <Icon size={44} />}
                  <span className="text-[10px] uppercase tracking-[0.2em]">
                    {listing.category}
                  </span>
                </div>
              )}

              {isSold ? (
                <div className="absolute inset-0 flex items-center justify-center bg-ink-950/70 backdrop-blur-[2px]">
                  <span className="rounded-full border border-white/15 bg-black/60 px-4 py-2 text-xs font-semibold uppercase tracking-[0.18em] text-white">
                    No longer available
                  </span>
                </div>
              ) : null}
            </div>
          </div>

          <div className="mt-4 grid gap-3 sm:grid-cols-3">
            <TrustItem icon={ShieldCheck} title="Campus handover" body="Meet in a public place" />
            <TrustItem icon={MessageSquare} title="Chat first" body="Ask every question" />
            <TrustItem icon={Tag} title="Fair pricing" body="Listed in KES" />
          </div>
        </div>

        {/* --------------------------------------------------------- details */}
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Link
              to={`/?category=${encodeURIComponent(listing.category)}`}
              className="badge border-orange-400/25 bg-orange-400/10 text-orange-200"
            >
              <Icon size={12} />
              {listing.category}
            </Link>
            <span className="text-[11px] text-gray-500">
              {isSold ? 'Listing closed' : `Listed ${timeAgo(listing.created_at)}`}
            </span>
          </div>

          <h1 className="mt-4 text-balance font-display text-3xl font-semibold leading-tight tracking-tight text-white sm:text-4xl">
            {listing.title}
          </h1>

          <div className="mt-4 flex flex-wrap items-baseline gap-3">
            <p className="font-display text-3xl font-semibold tracking-tight text-white">
              {formatKES(listing.price)}
            </p>
            <span className="text-xs text-gray-500">Price is fixed by the seller</span>
          </div>

          <div className="mt-2 flex flex-wrap items-center gap-2">
            <span
              className={cn(
                'badge',
                stock > 0
                  ? 'border-emerald-400/20 bg-emerald-400/10 text-emerald-300'
                  : 'border-red-400/20 bg-red-400/10 text-red-300',
              )}
            >
              {stock > 0 ? `${stock} in stock` : 'Sold out'}
            </span>
            {stock > 0 && stock <= 3 ? (
              <span className="text-[11px] text-amber-300">Only a few left</span>
            ) : null}
          </div>

          {isSold ? (
            <Alert variant="warning" className="mt-5">
              {stock <= 0
                ? 'This item is sold out. Browse the related listings below for something similar.'
                : 'This item has been sold or removed. Browse the related listings below for something similar.'}
            </Alert>
          ) : null}

          <div className="mt-6 border-y border-white/[0.07] py-5">
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-gray-500">
              About this item
            </p>
            <p className="mt-3 whitespace-pre-line text-sm leading-relaxed text-gray-300">
              {listing.description?.trim() || 'The seller has not added a description yet.'}
            </p>
          </div>

          {canBuy ? (
            <div className="mt-6">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <span className="text-xs font-medium uppercase tracking-[0.14em] text-gray-500">
                  Quantity
                </span>
                <QuantityStepper
                  value={quantity}
                  onChange={setQuantity}
                  max={Math.min(99, stock)}
                />
              </div>

              <div className="mt-4 grid gap-2.5 sm:grid-cols-2">
                <button
                  type="button"
                  onClick={onAddToCart}
                  className={cn('btn-secondary py-3', added && 'border-emerald-400/40 text-emerald-300')}
                >
                  {added ? (
                    <>
                      <Check size={16} />
                      Added to cart
                    </>
                  ) : (
                    <>
                      <ShoppingBag size={16} />
                      Add to cart
                    </>
                  )}
                </button>
                <button type="button" onClick={onBuyNow} className="btn-primary py-3">
                  Buy now
                  <ChevronRight size={16} />
                </button>
              </div>

              <button type="button" onClick={onChat} className="btn-ghost mt-2 w-full py-3">
                <MessageSquare size={16} />
                Chat with seller
              </button>
            </div>
          ) : null}

          {isOwner ? (
            <div className="mt-6 rounded-2xl border border-white/10 bg-white/[0.03] p-4">
              <p className="text-sm font-medium text-white">This is your listing</p>
              <p className="mt-1 text-xs leading-relaxed text-gray-400">
                Manage price, status and incoming offers from your seller studio.
              </p>
              <Link to="/seller?tab=listings" className="btn-secondary btn-sm mt-3">
                <Store size={14} />
                Manage listing
              </Link>
            </div>
          ) : null}

          {isSuspended ? (
            <Alert variant="warning" className="mt-6">
              Your account is suspended, so buying and messaging are disabled.
            </Alert>
          ) : null}

          {/* ------------------------------------------------------- seller */}
          <div className="mt-7 rounded-3xl border border-white/[0.08] bg-white/[0.025] p-5">
            <div className="flex items-start gap-3.5">
              <Avatar profile={seller} size={48} />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <p className="truncate text-sm font-semibold text-white">
                    {seller?.full_name || seller?.username || 'Campus seller'}
                  </p>
                  {badge ? <VerifiedBadge plan={badge.plan} size={17} /> : null}
                </div>
                <p className="mt-0.5 text-xs text-gray-500">
                  @{seller?.username || 'seller'}
                  {badge
                    ? ` · ${badge.plan === 'pro_max' ? 'Pro Max' : 'Pro'} seller`
                    : ' · Campus seller'}
                </p>
                {rating ? <SellerRating rating={rating} className="mt-1.5" size={13} /> : null}
                <p className="mt-2 flex items-center gap-1.5 text-[11px] text-gray-500">
                  <Clock3 size={12} className="text-gray-600" />
                  Joined {formatDate(seller?.created_at)}
                </p>
                {seller?.location ? (
                  <p className="mt-1 flex items-center gap-1.5 text-[11px] text-gray-500">
                    <MapPin size={12} className="text-orange-300" />
                    Based in {seller.location}
                  </p>
                ) : null}
              </div>
              <button
                type="button"
                onClick={onShare}
                className="icon-btn shrink-0"
                aria-label="Share listing"
              >
                {copied ? <Check size={17} className="text-emerald-400" /> : <Share2 size={17} />}
              </button>
            </div>

            {seller && !isOwner ? (
              <button type="button" onClick={onChat} className="btn-secondary mt-4 w-full">
                <MessageSquare size={15} />
                Message {seller.full_name?.split(' ')[0] || seller.username}
              </button>
            ) : null}
          </div>

          <div className="mt-4 flex items-start gap-2.5 rounded-2xl border border-amber-400/15 bg-amber-400/[0.05] p-4">
            <MapPin size={16} className="mt-0.5 shrink-0 text-amber-300" />
            <p className="text-[11px] leading-relaxed text-amber-100/80">
              <span className="font-semibold text-amber-200">Stay safe on campus.</span> Meet
              in a busy public area, inspect the item before paying, and never send money to
              someone you have not met.
            </p>
          </div>
        </div>
      </div>

      {/* --------------------------------------------------------- related */}
      {related.length > 0 ? (
        <section className="mt-16">
          <div className="flex items-end justify-between gap-4">
            <div>
              <p className="eyebrow">Keep browsing</p>
              <h2 className="mt-2 text-2xl font-semibold tracking-tight text-white">
                More in {listing.category}
              </h2>
            </div>
            <Link
              to={`/?category=${encodeURIComponent(listing.category)}`}
              className="hidden text-xs font-medium text-orange-300 transition hover:text-orange-200 sm:inline-flex sm:items-center sm:gap-1"
            >
              View all
              <ChevronRight size={13} />
            </Link>
          </div>

          <div className="mt-6 grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-4">
            {related.map((item) => (
              <ListingCard
                key={item.id}
                listing={item}
                rating={ratings[item.seller_id] ?? null}
              />
            ))}
          </div>
        </section>
      ) : (
        <div className="mt-16 rounded-3xl border border-white/[0.07] bg-white/[0.02] p-5 text-center">
          <p className="text-xs text-gray-500">
            No other {listing.category} listings right now.{' '}
            <Link to="/" className="link">
              Browse the full feed
            </Link>
            .
          </p>
        </div>
      )}
    </div>
  )
}

function TrustItem({ icon: Icon, title, body }) {
  return (
    <div className="flex items-start gap-2 rounded-2xl border border-white/[0.07] bg-white/[0.02] px-3 py-2.5">
      <Icon size={15} className="mt-0.5 shrink-0 text-orange-300" />
      <div>
        <p className="text-[11px] font-medium text-white">{title}</p>
        <p className="text-[10px] text-gray-500">{body}</p>
      </div>
    </div>
  )
}
