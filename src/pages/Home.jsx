import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import {
  ArrowRight,
  BadgeCheck,
  ChevronRight,
  MapPin,
  RefreshCw,
  Search,
  ShieldCheck,
  ShoppingBag,
  Smartphone,
  Store,
  X,
} from 'lucide-react'
import ListingCard from '../components/ListingCard'
import VerifiedBadge from '../components/VerifiedBadge'
import { Alert, EmptyState, Spinner } from '../components/ui'
import { CATEGORIES } from '../lib/constants'
import { supabase } from '../lib/supabase'
import { cn, formatKES, sortListingsByPriority, timeAgo } from '../lib/utils'
import { useAuth } from '../hooks/useAuth'

const PAGE_SIZE = 24

const LISTING_SELECT = `
  id, title, description, price, category, image_url, quantity, status, created_at, seller_id,
  seller:profiles!listings_seller_id_fkey(id, username, full_name, role, avatar_url)
`

export default function Home() {
  const { user, isSeller, isAdmin } = useAuth()
  const [searchParams, setSearchParams] = useSearchParams()

  const q = searchParams.get('q')?.trim() ?? ''
  const category = searchParams.get('category') ?? 'All'

  const [searchInput, setSearchInput] = useState(q)
  const [listings, setListings] = useState([])
  const [badges, setBadges] = useState({})
  const [ratings, setRatings] = useState({})
  const [total, setTotal] = useState(0)
  const [sellerCount, setSellerCount] = useState(null)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState('')

  const requestRef = useRef(0)
  const badgesRef = useRef({})
  const ratingsRef = useRef({})

  useEffect(() => {
    setSearchInput(q)
  }, [q])

  useEffect(() => {
    let active = true

    const loadSellerCount = async () => {
      const { count } = await supabase
        .from('profiles')
        .select('id', { count: 'exact', head: true })
        .eq('role', 'seller')
        .eq('is_suspended', false)

      if (active) setSellerCount(count ?? 0)
    }

    void loadSellerCount()
    return () => {
      active = false
    }
  }, [])

  const fetchFeed = useCallback(
    async ({ append = false, offset = 0 } = {}) => {
      const requestId = requestRef.current + 1
      requestRef.current = requestId

      if (append) setLoadingMore(true)
      else setLoading(true)
      setError('')

      let query = supabase
        .from('listings')
        .select(LISTING_SELECT, { count: 'exact' })
        .eq('status', 'active')

      const term = q.replace(/[%,()]/g, ' ').replace(/\s+/g, ' ').trim()
      if (term) {
        query = query.or(`title.ilike.%${term}%,description.ilike.%${term}%`)
      }
      if (category !== 'All') {
        query = query.eq('category', category)
      }

      const [feedResult, badgeResult, ratingResult] = await Promise.all([
        query.order('created_at', { ascending: false }).range(offset, offset + PAGE_SIZE - 1),
        supabase.rpc('get_seller_badges'),
        supabase.rpc('get_seller_ratings'),
      ])

      if (requestRef.current !== requestId) return

      if (feedResult.error) {
        setError(feedResult.error.message)
        if (!append) setListings([])
        setLoading(false)
        setLoadingMore(false)
        return
      }

      const badgeMap = {}
      for (const row of badgeResult.data ?? []) {
        badgeMap[row.seller_id] = row
      }

      const nextBadges = append ? { ...badgesRef.current, ...badgeMap } : badgeMap
      badgesRef.current = nextBadges
      setBadges(nextBadges)

      const ratingMap = {}
      for (const row of ratingResult.data ?? []) {
        ratingMap[row.seller_id] = row
      }
      const nextRatings = append ? { ...ratingsRef.current, ...ratingMap } : ratingMap
      ratingsRef.current = nextRatings
      setRatings(nextRatings)

      const rows = feedResult.data ?? []
      setListings((current) => {
        const base = append ? current : []
        const seen = new Set(base.map((item) => item.id))
        const merged = [...base, ...rows.filter((item) => !seen.has(item.id))]
        return sortListingsByPriority(merged, nextBadges, nextRatings)
      })
      setTotal(feedResult.count ?? rows.length)
      setLoading(false)
      setLoadingMore(false)
    },
    [q, category],
  )

  useEffect(() => {
    void fetchFeed()
  }, [fetchFeed])

  const updateParams = (nextQuery, nextCategory) => {
    const params = new URLSearchParams(searchParams)
    if (nextQuery?.trim()) params.set('q', nextQuery.trim())
    else params.delete('q')

    if (nextCategory && nextCategory !== 'All') params.set('category', nextCategory)
    else params.delete('category')

    setSearchParams(params, { replace: true })
  }

  const onSearch = (event) => {
    event.preventDefault()
    updateParams(searchInput, category)
  }

  const clearFilters = () => {
    setSearchInput('')
    setSearchParams({}, { replace: true })
  }

  const featured = listings[0] ?? null
  const hasFilters = Boolean(q) || category !== 'All'

  return (
    <div className="pb-8">
      {/* ------------------------------------------------------------- hero */}
      <section className="relative overflow-hidden">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_top,rgba(249,115,22,0.09),transparent_55%)]" />
        <div className="relative mx-auto grid max-w-7xl gap-10 px-4 pb-14 pt-12 sm:px-6 sm:pt-16 lg:grid-cols-[1.08fr_0.92fr] lg:items-center lg:gap-14 lg:px-8 lg:pb-20 lg:pt-20">
          <div className="animate-fade-up">
            <div className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.03] px-3 py-1.5 text-[11px] text-gray-300">
              <span className="relative flex h-1.5 w-1.5">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />
                <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-400" />
              </span>
              Maseno University · campus marketplace
            </div>

            <h1 className="mt-6 text-balance font-display text-4xl font-semibold leading-[1.04] tracking-tight text-white sm:text-5xl lg:text-6xl">
              The campus marketplace,
              <br />
              <span className="gradient-text">properly done.</span>
            </h1>

            <p className="mt-6 max-w-xl text-pretty text-sm leading-relaxed text-gray-400 sm:text-base">
              Textbooks, tech, hostel essentials, food and services from verified Maseno
              students. Fair prices in KES, real sellers, and a handover that happens right
              on campus.
            </p>

            <form onSubmit={onSearch} className="mt-8 max-w-xl">
              <div className="group flex items-center gap-2 rounded-2xl border border-white/10 bg-black/30 p-1.5 backdrop-blur-xl transition focus-within:border-orange-400/50 focus-within:ring-2 focus-within:ring-orange-500/10">
                <Search size={18} className="ml-3 shrink-0 text-gray-500" />
                <input
                  type="search"
                  value={searchInput}
                  onChange={(event) => setSearchInput(event.target.value)}
                  placeholder="What are you looking for today?"
                  aria-label="Search listings"
                  className="h-11 min-w-0 flex-1 bg-transparent px-1 text-sm text-white placeholder-gray-500 focus:outline-none"
                />
                {searchInput ? (
                  <button
                    type="button"
                    onClick={() => {
                      setSearchInput('')
                      updateParams('', category)
                    }}
                    className="rounded-full p-2 text-gray-500 transition hover:bg-white/10 hover:text-white"
                    aria-label="Clear search"
                  >
                    <X size={15} />
                  </button>
                ) : null}
                <button type="submit" className="btn-primary h-11 shrink-0 px-5">
                  Search
                </button>
              </div>
            </form>

            <div className="mt-6 flex flex-wrap items-center gap-x-6 gap-y-3 text-xs text-gray-500">
              <span className="inline-flex items-center gap-1.5">
                <BadgeCheck size={14} className="text-blue-400" />
                Verified Pro sellers
              </span>
              <span className="inline-flex items-center gap-1.5">
                <ShieldCheck size={14} className="text-emerald-400" />
                Student-verified accounts
              </span>
              <span className="inline-flex items-center gap-1.5">
                <Smartphone size={14} className="text-orange-300" />
                M-Pesa upgrades
              </span>
            </div>

            <div className="mt-10 flex flex-wrap gap-3">
              <a href="#feed" className="btn-primary">
                Explore the feed
                <ArrowRight size={16} />
              </a>
              {isSeller ? (
                <Link to="/seller?tab=new" className="btn-secondary">
                  <Store size={16} />
                  List an item
                </Link>
              ) : isAdmin ? null : user ? (
                <Link to="/orders" className="btn-secondary">
                  <ShoppingBag size={16} />
                  View my orders
                </Link>
              ) : (
                <Link to="/register?role=seller" className="btn-secondary">
                  <ShoppingBag size={16} />
                  Become a seller
                </Link>
              )}
            </div>
          </div>

          {/* editorial featured card */}
          <div className="relative mx-auto w-full max-w-[430px] animate-fade-up lg:max-w-none">
            <div className="pointer-events-none absolute -inset-8 rounded-[3rem] bg-gradient-to-br from-orange-500/20 via-pink-500/10 to-transparent blur-3xl" />

            <div className="glass relative rounded-4xl p-3 shadow-card">
              <div className="flex items-center justify-between px-2 pb-2.5 pt-1">
                <span className="inline-flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.18em] text-gray-500">
                  <span className="h-1.5 w-1.5 rounded-full bg-orange-400" />
                  From the feed
                </span>
                <span className="text-[10px] uppercase tracking-[0.14em] text-gray-600">
                  {total > 0 ? `${total} live listings` : 'Fresh finds'}
                </span>
              </div>

              {loading && !featured ? (
                <div className="space-y-3">
                  <div className="skeleton aspect-[4/3] w-full rounded-3xl" />
                  <div className="skeleton h-4 w-2/3" />
                  <div className="skeleton h-5 w-1/3" />
                </div>
              ) : featured ? (
                <Link
                  to={`/product/${featured.id}`}
                  className="group block overflow-hidden rounded-3xl border border-white/[0.06] bg-ink-800"
                >
                  <div className="relative aspect-[4/3] overflow-hidden">
                    {featured.image_url ? (
                      <img
                        src={featured.image_url}
                        alt={featured.title}
                        className="h-full w-full object-cover transition duration-700 group-hover:scale-[1.04]"
                      />
                    ) : (
                      <div className="grid h-full w-full place-items-center bg-[radial-gradient(circle_at_50%_30%,rgba(249,115,22,0.2),transparent_65%)]">
                        <ShoppingBag size={36} className="text-orange-300/60" />
                      </div>
                    )}
                    <div className="absolute inset-0 bg-gradient-to-t from-ink-950/80 via-transparent to-transparent" />
                    <span className="absolute left-3 top-3 rounded-full border border-white/10 bg-black/40 px-2.5 py-1 text-[10px] uppercase tracking-[0.14em] text-gray-200 backdrop-blur-md">
                      {featured.category}
                    </span>
                    {badges[featured.seller_id]?.plan ? (
                      <span className="absolute right-3 top-3 flex items-center gap-1.5 rounded-full border border-white/15 bg-black/40 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-white backdrop-blur-md">
                        <VerifiedBadge plan={badges[featured.seller_id].plan} size={13} />
                        {badges[featured.seller_id].plan === 'pro_max' ? 'Pro Max' : 'Pro'}
                      </span>
                    ) : null}
                    <div className="absolute bottom-3 left-3 right-3 flex items-end justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-white">{featured.title}</p>
                        <p className="mt-1 text-[10px] uppercase tracking-[0.14em] text-gray-400">
                          {featured.seller?.full_name || featured.seller?.username || 'Campus seller'}
                        </p>
                      </div>
                      <span className="shrink-0 rounded-full bg-white px-3 py-1 text-xs font-bold text-ink-950">
                        {formatKES(featured.price)}
                      </span>
                    </div>
                  </div>
                </Link>
              ) : (
                <div className="grid aspect-[4/3] place-items-center rounded-3xl border border-dashed border-white/10 bg-white/[0.02] px-8 text-center">
                  <div>
                    <ShoppingBag size={30} className="mx-auto text-gray-600" />
                    <p className="mt-3 text-sm font-medium text-white">No listings yet</p>
                    <p className="mt-1 text-xs leading-relaxed text-gray-500">
                      Be the first seller to put something on the feed.
                    </p>
                  </div>
                </div>
              )}

              <div className="flex items-center justify-between gap-3 px-2 pb-1 pt-3.5">
                <div className="flex items-center gap-1.5 text-[11px] text-gray-500">
                  <MapPin size={12} className="text-orange-300" />
                  Campus handover
                </div>
                <span className="inline-flex items-center gap-1 text-[11px] text-gray-500">
                  {featured ? timeAgo(featured.created_at) : 'Updated in real time'}
                </span>
              </div>
            </div>

            <div className="glass absolute -left-3 bottom-20 hidden rounded-2xl px-3.5 py-2.5 shadow-card sm:block">
              <div className="flex items-center gap-2">
                <span className="grid h-8 w-8 place-items-center rounded-xl border border-blue-400/20 bg-blue-400/10 text-blue-300">
                  <BadgeCheck size={15} />
                </span>
                <div>
                  <p className="text-[11px] font-semibold text-white">Verified sellers</p>
                  <p className="text-[10px] text-gray-500">Blue and gold badges</p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ------------------------------------------------------------- feed */}
      <section id="feed" className="mx-auto max-w-7xl scroll-mt-24 px-4 sm:px-6 lg:px-8">
        <div className="glass-soft rounded-4xl border border-white/[0.06] px-4 py-6 sm:px-6">
          <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <p className="eyebrow">Browse the marketplace</p>
              <h2 className="mt-2 text-2xl font-semibold tracking-tight text-white sm:text-3xl">
                {q ? (
                  <>
                    Results for <span className="gradient-text">“{q}”</span>
                  </>
                ) : (
                  'Fresh on campus'
                )}
              </h2>
              <p className="mt-1.5 text-sm text-gray-500">
                {loading
                  ? 'Loading listings…'
                  : `${total} listing${total === 1 ? '' : 's'}${
                      category !== 'All' ? ` in ${category}` : ''
                    }`}
                {sellerCount !== null ? ` · ${sellerCount} sellers` : ''}
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => void fetchFeed()}
                disabled={loading}
                className="btn-secondary btn-sm"
              >
                <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
                Refresh
              </button>
              {hasFilters ? (
                <button type="button" onClick={clearFilters} className="btn-ghost btn-sm">
                  <X size={13} />
                  Clear filters
                </button>
              ) : null}
            </div>
          </div>

          <div className="no-scrollbar mt-6 flex gap-2 overflow-x-auto pb-1">
            <button
              type="button"
              onClick={() => updateParams(q, 'All')}
              className={cn('chip shrink-0', category === 'All' && 'chip-active')}
            >
              All items
            </button>
            {CATEGORIES.map(({ value, icon: Icon }) => (
              <button
                key={value}
                type="button"
                onClick={() => updateParams(q, value)}
                className={cn('chip shrink-0', category === value && 'chip-active')}
              >
                <Icon size={13} />
                {value}
              </button>
            ))}
          </div>
        </div>

        <div className="mt-8">
          {error ? (
            <Alert variant="error" title="The feed could not load">
              {error}
              <button
                type="button"
                onClick={() => void fetchFeed()}
                className="btn-secondary btn-sm mt-3"
              >
                <RefreshCw size={13} />
                Try again
              </button>
            </Alert>
          ) : loading && listings.length === 0 ? (
            <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {Array.from({ length: 8 }).map((_, index) => (
                <div key={index} className="glass overflow-hidden rounded-3xl">
                  <div className="skeleton aspect-[4/3] rounded-none" />
                  <div className="space-y-3 p-4">
                    <div className="skeleton h-4 w-5/6" />
                    <div className="skeleton h-5 w-1/3" />
                    <div className="flex items-center gap-2 pt-2">
                      <div className="skeleton h-6 w-6 rounded-full" />
                      <div className="skeleton h-3 w-1/2" />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ) : listings.length === 0 ? (
            <EmptyState
              icon={Search}
              title={q ? 'No matches on campus yet' : 'The feed is waiting for its first listing'}
              description={
                q
                  ? 'Try a broader search, remove the category filter, or check back soon — new items land every day.'
                  : 'Everything here comes from real Maseno sellers. If you have something to sell, create the first listing.'
              }
              action={
                hasFilters ? (
                  <button type="button" onClick={clearFilters} className="btn-primary">
                    Clear filters
                  </button>
                ) : (
                  <Link to="/register?role=seller" className="btn-primary">
                    <Store size={16} />
                    Start selling
                  </Link>
                )
              }
            />
          ) : (
            <>
              <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                {listings.map((listing) => (
                  <ListingCard
                    key={listing.id}
                    listing={listing}
                    badge={badges[listing.seller_id] ?? null}
                    rating={ratings[listing.seller_id] ?? null}
                  />
                ))}
              </div>

              <div className="mt-10 flex flex-col items-center gap-3">
                {listings.length < total ? (
                  <button
                    type="button"
                    onClick={() => void fetchFeed({ append: true, offset: listings.length })}
                    disabled={loadingMore}
                    className="btn-secondary"
                  >
                    {loadingMore ? (
                      <>
                        <Spinner size={15} />
                        Loading more…
                      </>
                    ) : (
                      <>
                        Load more listings
                        <ChevronRight size={15} />
                      </>
                    )}
                  </button>
                ) : (
                  <p className="text-xs text-gray-600">
                    You have reached the end of the feed.
                  </p>
                )}
                <p className="text-[10px] uppercase tracking-[0.14em] text-gray-700">
                  Pro Max listings appear first · then Pro · then newest
                </p>
              </div>
            </>
          )}
        </div>
      </section>

      {/* --------------------------------------------------------- seller CTA */}
      {!user || isSeller ? (
        <section className="mx-auto mt-16 max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="relative overflow-hidden rounded-4xl border border-white/[0.08] bg-[radial-gradient(circle_at_15%_10%,rgba(249,115,22,0.16),transparent_50%),radial-gradient(circle_at_90%_90%,rgba(236,72,153,0.13),transparent_55%)] p-8 sm:p-10">
            <div className="relative flex flex-col gap-6 sm:flex-row sm:items-center sm:justify-between">
              <div className="max-w-xl">
                <p className="eyebrow">For student hustlers</p>
                <h2 className="mt-2 text-2xl font-semibold tracking-tight text-white sm:text-3xl">
                  Turn what you know into income.
                </h2>
                <p className="mt-2 text-sm leading-relaxed text-gray-400">
                  List in minutes, chat directly with buyers, and upgrade to Pro or Pro Max for
                  a verified badge and top placement in the feed.
                </p>
              </div>
              <div className="flex shrink-0 flex-wrap gap-2">
                {isSeller ? (
                  <Link to="/seller?tab=new" className="btn-primary">
                    Open seller studio
                    <ArrowRight size={16} />
                  </Link>
                ) : (
                  <Link to="/register?role=seller" className="btn-primary">
                    Open a seller account
                    <ArrowRight size={16} />
                  </Link>
                )}
                <Link
                  to={isSeller ? '/seller?tab=subscription' : '/register?role=seller'}
                  className="btn-secondary"
                >
                  <BadgeCheck size={16} />
                  See plans
                </Link>
              </div>
            </div>
          </div>
        </section>
      ) : null}
    </div>
  )
}
