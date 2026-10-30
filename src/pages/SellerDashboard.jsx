import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import {
  ArrowRight,
  BadgeCheck,
  Banknote,
  CheckCircle2,
  ChevronDown,
  Clock3,
  ImagePlus,
  LayoutDashboard,
  MessageSquare,
  Package,
  PackagePlus,
  Phone,
  Plus,
  RefreshCw,
  ShieldCheck,
  ShoppingBag,
  Sparkles,
  Star,
  Trash2,
  Upload,
  X,
  XCircle,
} from 'lucide-react'
import { useAuth } from '../hooks/useAuth'
import { supabase, LISTING_IMAGES_BUCKET } from '../lib/supabase'
import {
  ACCEPTED_IMAGE_TYPES,
  CATEGORIES,
  MAX_IMAGE_BYTES,
  MPESA_ACCOUNT,
  MPESA_PAYBILL,
  PLANS,
  PLAN_BY_ID,
  SUPPORT_EMAIL,
} from '../lib/constants'
import {
  cn,
  formatDate,
  formatDateTime,
  formatKES,
  friendlyError,
  LISTING_STATUS_META,
  ORDER_STATUS_META,
  SUBSCRIPTION_STATUS_META,
  timeAgo,
} from '../lib/utils'
import {
  Alert,
  Avatar,
  EmptyState,
  Modal,
  PageLoader,
  Spinner,
  StatCard,
  StatusPill,
} from '../components/ui'
import VerifiedBadge from '../components/VerifiedBadge'

const TABS = [
  { id: 'overview', label: 'Overview', icon: LayoutDashboard },
  { id: 'listings', label: 'Listings', icon: Package },
  { id: 'new', label: 'New listing', icon: PackagePlus },
  { id: 'orders', label: 'Orders', icon: ShoppingBag },
  { id: 'subscription', label: 'Subscription', icon: BadgeCheck },
]

const ORDER_SELECT = `
  id, status, total_amount, created_at, delivery_location, contact_phone, buyer_id,
  buyer:profiles!orders_buyer_id_fkey(id, username, full_name, avatar_url, created_at),
  items:order_items(id, quantity, price_at_purchase, listing:listings(id, title, image_url, status))
`

export default function SellerDashboard() {
  const { profile } = useAuth()
  const [searchParams, setSearchParams] = useSearchParams()

  const [listings, setListings] = useState([])
  const [orders, setOrders] = useState([])
  const [subscriptions, setSubscriptions] = useState([])
  const [rating, setRating] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const [action, setAction] = useState(null)
  const [actionError, setActionError] = useState('')
  const [actionWorking, setActionWorking] = useState(false)
  const [stockEdit, setStockEdit] = useState(null)
  const [stockValue, setStockValue] = useState('1')
  const [stockError, setStockError] = useState('')
  const [stockSaving, setStockSaving] = useState(false)

  const tabParam = searchParams.get('tab')
  const tab = TABS.some((item) => item.id === tabParam) ? tabParam : 'overview'

  const changeTab = (nextTab) => {
    const params = new URLSearchParams(searchParams)
    if (nextTab === 'overview') params.delete('tab')
    else params.set('tab', nextTab)
    setSearchParams(params, { replace: true })
    setSuccess('')
  }

  const load = useCallback(async () => {
    if (!profile?.id) return

    setLoading(true)
    setError('')

    const [listingResult, orderResult, subscriptionResult, ratingResult] = await Promise.all([
      supabase
        .from('listings')
        .select('*')
        .eq('seller_id', profile.id)
        .order('created_at', { ascending: false }),
      supabase
        .from('orders')
        .select(ORDER_SELECT)
        .eq('seller_id', profile.id)
        .order('created_at', { ascending: false }),
      supabase
        .from('subscriptions')
        .select('*')
        .eq('seller_id', profile.id)
        .order('created_at', { ascending: false }),
      supabase.rpc('get_seller_ratings'),
    ])

    if (listingResult.error || orderResult.error || subscriptionResult.error) {
      setError(
        listingResult.error?.message ||
          orderResult.error?.message ||
          subscriptionResult.error?.message ||
          'Dashboard data could not load.',
      )
    }

    setListings(listingResult.data ?? [])
    setOrders(orderResult.data ?? [])
    setSubscriptions(subscriptionResult.data ?? [])
    setRating(
      (ratingResult.data ?? []).find((row) => row.seller_id === profile.id) ?? null,
    )
    setLoading(false)
  }, [profile?.id])

  useEffect(() => {
    void load()
  }, [load])

  const activeSubscription = useMemo(
    () =>
      subscriptions.find(
        (subscription) =>
          subscription.status === 'active' &&
          subscription.expires_at &&
          new Date(subscription.expires_at) > new Date(),
      ) ?? null,
    [subscriptions],
  )

  const pendingSubscription = useMemo(
    () => subscriptions.find((subscription) => subscription.status === 'pending') ?? null,
    [subscriptions],
  )

  const metrics = useMemo(() => {
    const paidOrders = orders.filter(
      (order) => order.status === 'delivered' || order.status === 'completed',
    )
    return {
      totalSales: paidOrders.reduce((sum, order) => sum + Number(order.total_amount), 0),
      activeListings: listings.filter((listing) => listing.status === 'active').length,
      pendingOrders: orders.filter((order) => order.status === 'pending').length,
      completedOrders: orders.filter((order) => order.status === 'completed').length,
      deliveredOrders: orders.filter((order) => order.status === 'delivered').length,
    }
  }, [listings, orders])

  const onListingCreated = (listing) => {
    setListings((current) => [listing, ...current])
    changeTab('listings')
    setSuccess('Listing published. It is live on the campus feed now.')
  }

  const onSubscriptionCreated = (subscription) => {
    setSubscriptions((current) => [subscription, ...current])
    setSuccess(
      'M-Pesa code submitted. Your badge activates as soon as the campus desk approves it.',
    )
  }

  const openListingAction = (listing, nextStatus) => {
    const labels = {
      sold: {
        title: 'Mark this listing as sold?',
        description:
          'It will disappear from the public feed immediately. You can relist it later if the deal falls through.',
        confirm: 'Mark as sold',
      },
      active: {
        title: 'Put this listing back on the feed?',
        description: 'Buyers will be able to find and order it again.',
        confirm: 'Relist',
      },
      deleted: {
        title: 'Remove this listing?',
        description:
          'This hides the listing permanently from the feed. Order history keeps its record.',
        confirm: 'Remove listing',
      },
    }

    setActionError('')
    setAction({
      kind: 'listing',
      id: listing.id,
      nextStatus,
      title: labels[nextStatus].title,
      description: labels[nextStatus].description,
      confirm: labels[nextStatus].confirm,
      tone: nextStatus === 'deleted' ? 'danger' : 'primary',
    })
  }

  const openOrderAction = (order, nextStatus) => {
    const delivered = nextStatus === 'delivered'
    setActionError('')
    setAction({
      kind: 'order',
      id: order.id,
      nextStatus,
      order,
      title: delivered ? 'Mark this order as delivered?' : 'Cancel this order?',
      description: delivered
        ? 'This confirms handover. Stock was reserved at checkout; a listing that sold out stays out of the public feed. The buyer can then confirm receipt.'
        : 'The buyer will see the order as cancelled. Any reserved quantity returns to the listing automatically.',
      confirm: delivered ? 'Mark delivered' : 'Cancel order',
      tone: delivered ? 'primary' : 'danger',
    })
  }

  const openStock = (listing) => {
    setStockEdit(listing)
    setStockValue(String(listing.quantity ?? 1))
    setStockError('')
  }

  const saveStock = async () => {
    if (!stockEdit) return

    const quantity = Number(stockValue)
    if (!Number.isInteger(quantity) || quantity < 0 || quantity > 9999) {
      setStockError('Enter a whole number between 0 and 9,999.')
      return
    }

    setStockSaving(true)
    setStockError('')

    const nextStatus =
      stockEdit.status === 'deleted' ? 'deleted' : quantity <= 0 ? 'sold' : 'active'

    const { error: updateError } = await supabase
      .from('listings')
      .update({ quantity, status: nextStatus })
      .eq('id', stockEdit.id)

    setStockSaving(false)

    if (updateError) {
      setStockError(friendlyError(updateError))
      return
    }

    setListings((current) =>
      current.map((row) =>
        row.id === stockEdit.id
          ? { ...row, quantity, status: nextStatus }
          : row,
      ),
    )
    setSuccess(
      quantity === 0
        ? 'Stock set to zero — the listing is now marked sold.'
        : `Stock updated to ${quantity}.`,
    )
    setStockEdit(null)
  }

  const runAction = async () => {
    if (!action) return

    setActionWorking(true)
    setActionError('')

    if (action.kind === 'listing') {
      const { error: updateError } = await supabase
        .from('listings')
        .update({ status: action.nextStatus })
        .eq('id', action.id)

      if (updateError) {
        setActionError(friendlyError(updateError))
        setActionWorking(false)
        return
      }

      setListings((current) =>
        current.map((listing) =>
          listing.id === action.id ? { ...listing, status: action.nextStatus } : listing,
        ),
      )
    }

    if (action.kind === 'order') {
      const { error: updateError } = await supabase
        .from('orders')
        .update({ status: action.nextStatus })
        .eq('id', action.id)

      if (updateError) {
        setActionError(friendlyError(updateError))
        setActionWorking(false)
        return
      }

      setOrders((current) =>
        current.map((order) =>
          order.id === action.id ? { ...order, status: action.nextStatus } : order,
        ),
      )

      if (action.nextStatus === 'delivered' && action.order?.items?.length) {
        const soldIds = new Set(
          action.order.items.map((item) => item.listing?.id).filter(Boolean),
        )
        setListings((current) =>
          current.map((listing) =>
            soldIds.has(listing.id) ? { ...listing, status: 'sold' } : listing,
          ),
        )
      }
    }

    setActionWorking(false)
    setAction(null)
  }

  if (loading) {
    return <PageLoader label="Opening your seller studio…" />
  }

  const firstName = profile?.full_name?.split(' ')[0] || profile?.username || 'there'

  return (
    <div className="mx-auto max-w-7xl px-4 py-10 sm:px-6 lg:px-8">
      {/* ------------------------------------------------------------ header */}
      <div className="relative overflow-hidden rounded-4xl border border-emerald-400/10 bg-[radial-gradient(circle_at_10%_0%,rgba(16,185,129,0.16),transparent_55%),radial-gradient(circle_at_95%_100%,rgba(20,184,166,0.10),transparent_55%)] p-6 sm:p-8">
        <div className="relative flex flex-wrap items-start justify-between gap-6">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-emerald-300/80">
              Seller studio
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <h1 className="text-3xl font-semibold tracking-tight text-white sm:text-4xl">
                Hi, {firstName}
              </h1>
              {activeSubscription ? (
                <span className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.04] px-2.5 py-1.5">
                  <VerifiedBadge plan={activeSubscription.plan} size={17} />
                  <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-gray-300">
                    {PLAN_BY_ID[activeSubscription.plan]?.name ?? 'Pro'}
                  </span>
                </span>
              ) : null}
            </div>
            <p className="mt-2 max-w-xl text-sm leading-relaxed text-gray-400">
              Manage listings, fulfil orders and grow your reputation across Maseno. Every
              completed order builds trust.
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-3 text-[11px] text-gray-500">
              <span>@{profile?.username}</span>
              <span className="h-1 w-1 rounded-full bg-gray-700" />
              <span>{listings.length} listings</span>
              <span className="h-1 w-1 rounded-full bg-gray-700" />
              <span>{formatKES(metrics.totalSales)} in sales</span>
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            <Link to="/" className="btn-secondary btn-sm">
              View storefront
            </Link>
            <button type="button" onClick={() => changeTab('new')} className="btn-seller btn-sm">
              <Plus size={14} />
              New listing
            </button>
          </div>
        </div>
      </div>

      {success ? (
        <Alert variant="success" className="mt-5" onClose={() => setSuccess('')}>
          {success}
        </Alert>
      ) : null}

      {error ? (
        <Alert variant="error" className="mt-5" title="Some dashboard data did not load">
          {error}
          <button type="button" onClick={() => void load()} className="btn-secondary btn-sm mt-3">
            <RefreshCw size={13} />
            Retry
          </button>
        </Alert>
      ) : null}

      {/* -------------------------------------------------------------- tabs */}
      <div className="no-scrollbar mt-6 flex gap-1.5 overflow-x-auto rounded-2xl border border-white/[0.07] bg-white/[0.025] p-1.5">
        {TABS.map(({ id, label, icon: Icon }) => {
          const active = tab === id
          const badgeCount =
            id === 'orders' ? metrics.pendingOrders : id === 'listings' ? listings.length : 0

          return (
            <button
              key={id}
              type="button"
              onClick={() => changeTab(id)}
              className={cn(
                'flex shrink-0 items-center gap-2 rounded-xl px-3.5 py-2 text-xs font-medium transition',
                active
                  ? 'bg-white/[0.09] text-white shadow-sm'
                  : 'text-gray-400 hover:bg-white/[0.04] hover:text-white',
              )}
            >
              <Icon size={15} className={active ? 'text-emerald-300' : 'text-gray-500'} />
              {label}
              {badgeCount > 0 ? (
                <span
                  className={cn(
                    'rounded-full px-1.5 py-0.5 text-[10px] font-semibold',
                    active ? 'bg-emerald-400/15 text-emerald-300' : 'bg-white/[0.06] text-gray-500',
                  )}
                >
                  {badgeCount}
                </span>
              ) : null}
            </button>
          )
        })}
      </div>

      <div className="mt-6">
        {tab === 'overview' ? (
          <OverviewTab
            profile={profile}
            metrics={metrics}
            orders={orders}
            listings={listings}
            activeSubscription={activeSubscription}
            pendingSubscription={pendingSubscription}
            rating={rating}
            onTab={changeTab}
          />
        ) : null}

        {tab === 'listings' ? (
          <ListingsTab
            listings={listings}
            onNew={() => changeTab('new')}
            onAction={openListingAction}
            onStock={openStock}
          />
        ) : null}

        {tab === 'new' ? (
          <NewListingForm profile={profile} onCreated={onListingCreated} />
        ) : null}

        {tab === 'orders' ? <OrdersTab orders={orders} onAction={openOrderAction} /> : null}

        {tab === 'subscription' ? (
          <SubscriptionTab
            profile={profile}
            subscriptions={subscriptions}
            activeSubscription={activeSubscription}
            pendingSubscription={pendingSubscription}
            onCreated={onSubscriptionCreated}
          />
        ) : null}
      </div>

      <Modal
        open={Boolean(action)}
        onClose={() => {
          if (!actionWorking) setAction(null)
        }}
        title={action?.title}
        description={action?.description}
        footer={
          <>
            <button
              type="button"
              onClick={() => setAction(null)}
              disabled={actionWorking}
              className="btn-secondary"
            >
              Keep as is
            </button>
            <button
              type="button"
              onClick={runAction}
              disabled={actionWorking}
              className={action?.tone === 'danger' ? 'btn-danger' : 'btn-seller'}
            >
              {actionWorking ? (
                <>
                  <Spinner size={15} />
                  Working…
                </>
              ) : (
                action?.confirm
              )}
            </button>
          </>
        }
      >
        {actionError ? <Alert variant="error">{actionError}</Alert> : null}
      </Modal>

      <Modal
        open={Boolean(stockEdit)}
        onClose={() => {
          if (!stockSaving) setStockEdit(null)
        }}
        title="Update stock"
        description={
          stockEdit
            ? `How many units of "${stockEdit.title}" do you have available? Setting this to zero marks the listing sold.`
            : ''
        }
        footer={
          <>
            <button
              type="button"
              onClick={() => setStockEdit(null)}
              disabled={stockSaving}
              className="btn-secondary"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={saveStock}
              disabled={stockSaving}
              className="btn-seller"
            >
              {stockSaving ? (
                <>
                  <Spinner size={15} />
                  Saving…
                </>
              ) : (
                <>
                  <Package size={15} />
                  Save stock
                </>
              )}
            </button>
          </>
        }
      >
        {stockError ? <Alert variant="error">{stockError}</Alert> : null}
        <div className="mt-3">
          <label htmlFor="stockQuantity" className="label">
            Quantity available
          </label>
          <input
            id="stockQuantity"
            type="number"
            min="0"
            max="9999"
            step="1"
            value={stockValue}
            onChange={(event) => setStockValue(event.target.value)}
            className="input"
            autoFocus
          />
          <p className="field-hint">
            Stock is reserved when a buyer checks out and restored if the order is cancelled.
          </p>
        </div>
      </Modal>
    </div>
  )
}

/* ========================================================================== */
/* OVERVIEW                                                                   */
/* ========================================================================== */
function OverviewTab({
  profile,
  metrics,
  orders,
  listings,
  activeSubscription,
  pendingSubscription,
  rating,
  onTab,
}) {
  const recentOrders = orders.slice(0, 5)
  const activeListings = listings.filter((listing) => listing.status === 'active')
  const hasNoData = listings.length === 0 && orders.length === 0

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
        <StatCard
          icon={Banknote}
          label="Total sales"
          value={formatKES(metrics.totalSales)}
          hint={`${metrics.completedOrders} completed · ${metrics.deliveredOrders} awaiting receipt`}
          accent="green"
        />
        <StatCard
          icon={Package}
          label="Active listings"
          value={metrics.activeListings}
          hint={`${listings.filter((listing) => listing.status === 'sold').length} sold all-time`}
          accent="orange"
        />
        <StatCard
          icon={Clock3}
          label="Pending orders"
          value={metrics.pendingOrders}
          hint="Awaiting handover to the buyer"
          accent="amber"
        />
        <StatCard
          icon={CheckCircle2}
          label="Completed orders"
          value={metrics.completedOrders}
          hint="Confirmed received by buyers"
          accent="purple"
        />
        <StatCard
          icon={Star}
          label="Seller rating"
          value={
            rating && Number(rating.review_count) > 0
              ? `${Number(rating.average_rating).toFixed(1)} / 5`
              : 'New'
          }
          hint={
            rating && Number(rating.review_count) > 0
              ? `${rating.review_count} buyer review${Number(rating.review_count) === 1 ? '' : 's'}`
              : 'Complete a trade to earn reviews'
          }
          accent="amber"
        />
      </div>

      {hasNoData ? (
        <div className="relative overflow-hidden rounded-3xl border border-emerald-400/15 bg-[radial-gradient(circle_at_20%_0%,rgba(16,185,129,0.12),transparent_55%)] p-7 sm:p-9">
          <span className="grid h-12 w-12 place-items-center rounded-2xl border border-emerald-400/25 bg-emerald-400/10 text-emerald-300">
            <Sparkles size={22} />
          </span>
          <h2 className="mt-4 text-xl font-semibold text-white">Your shop starts here</h2>
          <p className="mt-2 max-w-lg text-sm leading-relaxed text-gray-400">
            Publish your first listing to appear on the Maseno feed. Add a clear photo, an
            honest description and a fair price. Pro sellers get a verified badge and higher
            placement.
          </p>
          <div className="mt-5 flex flex-wrap gap-2">
            <button type="button" onClick={() => onTab('new')} className="btn-seller">
              <PackagePlus size={16} />
              Create your first listing
            </button>
            <button type="button" onClick={() => onTab('subscription')} className="btn-secondary">
              <BadgeCheck size={16} />
              Explore plans
            </button>
          </div>
        </div>
      ) : null}

      <div className="grid gap-5 lg:grid-cols-[1.4fr_1fr]">
        <section className="glass overflow-hidden rounded-3xl">
          <div className="flex items-center justify-between gap-3 border-b border-white/[0.07] px-5 py-4">
            <div>
              <h2 className="text-sm font-semibold text-white">Recent orders</h2>
              <p className="mt-0.5 text-[11px] text-gray-500">Latest activity from buyers</p>
            </div>
            <button
              type="button"
              onClick={() => onTab('orders')}
              className="text-[11px] font-medium text-emerald-300 transition hover:text-emerald-200"
            >
              View all
            </button>
          </div>

          {recentOrders.length === 0 ? (
            <div className="px-5 py-10 text-center">
              <ShoppingBag size={22} className="mx-auto text-gray-600" />
              <p className="mt-3 text-sm text-gray-400">No orders yet</p>
              <p className="mt-1 text-xs text-gray-600">
                Share your listings with classmates to get the first one.
              </p>
            </div>
          ) : (
            <ul className="divide-y divide-white/[0.06]">
              {recentOrders.map((order) => (
                <li key={order.id} className="flex items-center gap-3 px-5 py-3.5">
                  <Avatar profile={order.buyer} size={32} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-xs font-medium text-white">
                      {order.buyer?.full_name || order.buyer?.username || 'Buyer'}
                    </p>
                    <p className="mt-0.5 truncate text-[11px] text-gray-500">
                      {order.items?.length ?? 0} item{order.items?.length === 1 ? '' : 's'} ·{' '}
                      {timeAgo(order.created_at)}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="text-xs font-semibold text-white">
                      {formatKES(order.total_amount)}
                    </p>
                    <StatusPill meta={ORDER_STATUS_META[order.status]} className="mt-1" />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        <div className="space-y-5">
          <section className="glass rounded-3xl p-5">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-white">Visibility</h2>
              <Link
                to="/seller?tab=subscription"
                className="text-[11px] text-emerald-300 hover:text-emerald-200"
              >
                Manage
              </Link>
            </div>

            {activeSubscription ? (
              <div className="mt-4">
                <div className="flex items-center gap-2">
                  <VerifiedBadge plan={activeSubscription.plan} size={24} />
                  <div>
                    <p className="text-sm font-semibold text-white">
                      {PLAN_BY_ID[activeSubscription.plan]?.name} seller
                    </p>
                    <p className="text-[11px] text-gray-500">
                      Active until {formatDate(activeSubscription.expires_at)}
                    </p>
                  </div>
                </div>
                <p className="mt-3 text-xs leading-relaxed text-gray-400">
                  Your listings are prioritised above free sellers and carry the verified
                  badge on every card.
                </p>
              </div>
            ) : pendingSubscription ? (
              <div className="mt-4">
                <StatusPill meta={SUBSCRIPTION_STATUS_META.pending} />
                <p className="mt-3 text-xs leading-relaxed text-gray-400">
                  {PLAN_BY_ID[pendingSubscription.plan]?.name} payment submitted with code{' '}
                  <span className="font-mono text-gray-200">{pendingSubscription.mpesa_code}</span>.
                  The campus desk is reviewing it.
                </p>
                <button
                  type="button"
                  onClick={() => onTab('subscription')}
                  className="btn-secondary btn-sm mt-3"
                >
                  View request
                </button>
              </div>
            ) : (
              <div className="mt-4">
                <p className="text-xs leading-relaxed text-gray-400">
                  Stand out with a blue Pro badge or go all-in with gold Pro Max and top feed
                  placement.
                </p>
                <button
                  type="button"
                  onClick={() => onTab('subscription')}
                  className="btn-secondary btn-sm mt-3"
                >
                  <BadgeCheck size={14} />
                  See plans
                </button>
              </div>
            )}
          </section>

          <section className="glass rounded-3xl p-5">
            <h2 className="text-sm font-semibold text-white">Quick actions</h2>
            <div className="mt-3 grid gap-2">
              <QuickAction icon={PackagePlus} label="Add a listing" onClick={() => onTab('new')} />
              <QuickAction
                icon={ShoppingBag}
                label={`Review ${metrics.pendingOrders} pending order${metrics.pendingOrders === 1 ? '' : 's'}`}
                onClick={() => onTab('orders')}
              />
              <QuickAction
                icon={BadgeCheck}
                label="Upgrade visibility"
                onClick={() => onTab('subscription')}
              />
            </div>
          </section>

          <section className="rounded-3xl border border-emerald-400/15 bg-emerald-400/[0.04] p-5">
            <div className="flex items-center gap-2 text-emerald-300">
              <ShieldCheck size={16} />
              <p className="text-xs font-semibold">Seller standard</p>
            </div>
            <p className="mt-2 text-[11px] leading-relaxed text-gray-400">
              Reply within a day, describe flaws honestly, and meet in public campus spots.
              Sellers who complete orders keep the verified marketplace trustworthy.
            </p>
            <p className="mt-3 text-[10px] text-gray-600">Signed in as @{profile?.username}</p>
          </section>
        </div>
      </div>

      {activeListings.length > 0 ? (
        <section>
          <div className="flex items-end justify-between gap-3">
            <h2 className="text-lg font-semibold text-white">Your live listings</h2>
            <button
              type="button"
              onClick={() => onTab('listings')}
              className="text-[11px] text-emerald-300 hover:text-emerald-200"
            >
              Manage all
            </button>
          </div>
          <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {activeListings.slice(0, 3).map((listing) => (
              <div key={listing.id} className="glass flex gap-3 overflow-hidden rounded-2xl p-3">
                <div className="h-16 w-16 shrink-0 overflow-hidden rounded-xl bg-ink-800">
                  {listing.image_url ? (
                    <img
                      src={listing.image_url}
                      alt={listing.title}
                      className="h-full w-full object-cover"
                      loading="lazy"
                    />
                  ) : (
                    <div className="grid h-full w-full place-items-center text-gray-600">
                      <Package size={18} />
                    </div>
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="line-clamp-2 text-xs font-medium text-white">{listing.title}</p>
                  <p className="mt-1 text-xs font-semibold text-emerald-300">
                    {formatKES(listing.price)}
                  </p>
                  <p className="mt-1 text-[10px] text-gray-600">{timeAgo(listing.created_at)}</p>
                </div>
              </div>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  )
}

function QuickAction({ icon: Icon, label, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-center gap-2.5 rounded-xl border border-white/[0.07] bg-white/[0.02] px-3 py-2.5 text-left text-xs text-gray-300 transition hover:border-white/15 hover:bg-white/[0.05] hover:text-white"
    >
      <Icon size={15} className="text-emerald-300" />
      {label}
      <ArrowRight size={13} className="ml-auto text-gray-600" />
    </button>
  )
}

/* ========================================================================== */
/* LISTINGS                                                                   */
/* ========================================================================== */
function ListingsTab({ listings, onNew, onAction, onStock }) {
  const [filter, setFilter] = useState('all')

  const counts = useMemo(
    () =>
      listings.reduce(
        (acc, listing) => {
          acc[listing.status] = (acc[listing.status] ?? 0) + 1
          return acc
        },
        {},
      ),
    [listings],
  )

  const visible =
    filter === 'all' ? listings : listings.filter((listing) => listing.status === filter)

  const filters = [
    { value: 'all', label: 'All', count: listings.length },
    { value: 'active', label: 'Active', count: counts.active ?? 0 },
    { value: 'sold', label: 'Sold', count: counts.sold ?? 0 },
    { value: 'deleted', label: 'Removed', count: counts.deleted ?? 0 },
  ]

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold text-white">Manage listings</h2>
          <p className="mt-1 text-sm text-gray-500">
            {counts.active ?? 0} live · {counts.sold ?? 0} sold · {counts.deleted ?? 0} removed
          </p>
        </div>
        <button type="button" onClick={onNew} className="btn-seller btn-sm">
          <Plus size={14} />
          New listing
        </button>
      </div>

      <div className="mt-5 flex flex-wrap gap-2">
        {filters.map((option) => (
          <button
            key={option.value}
            type="button"
            onClick={() => setFilter(option.value)}
            className={cn('chip', filter === option.value && 'chip-active')}
          >
            {option.label}
            <span className="text-[10px] opacity-60">{option.count}</span>
          </button>
        ))}
      </div>

      <div className="mt-5 space-y-3">
        {visible.length === 0 ? (
          <EmptyState
            icon={Package}
            title={listings.length === 0 ? 'No listings yet' : 'Nothing in this filter'}
            description={
              listings.length === 0
                ? 'Create your first listing and it will appear on the campus feed immediately.'
                : 'Switch filters to see the rest of your inventory.'
            }
            action={
              listings.length === 0 ? (
                <button type="button" onClick={onNew} className="btn-seller">
                  <PackagePlus size={16} />
                  Create a listing
                </button>
              ) : (
                <button type="button" onClick={() => setFilter('all')} className="btn-secondary">
                  Show all
                </button>
              )
            }
          />
        ) : (
          visible.map((listing) => (
            <div
              key={listing.id}
              className="glass flex flex-col gap-4 rounded-2xl p-4 sm:flex-row sm:items-center"
            >
              <div className="h-20 w-20 shrink-0 overflow-hidden rounded-xl border border-white/[0.08] bg-ink-800">
                {listing.image_url ? (
                  <img
                    src={listing.image_url}
                    alt={listing.title}
                    className="h-full w-full object-cover"
                    loading="lazy"
                  />
                ) : (
                  <div className="grid h-full w-full place-items-center text-gray-600">
                    <Package size={20} />
                  </div>
                )}
              </div>

              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <Link
                    to={`/product/${listing.id}`}
                    className="line-clamp-1 text-sm font-semibold text-white transition hover:text-emerald-200"
                  >
                    {listing.title}
                  </Link>
                  <StatusPill meta={LISTING_STATUS_META[listing.status]} />
                </div>
                <p className="mt-1 text-[11px] text-gray-500">
                  {listing.category} · {listing.quantity ?? 1} available · listed{' '}
                  {formatDate(listing.created_at)}
                </p>
                <p className="mt-1.5 font-display text-base font-semibold text-white">
                  {formatKES(listing.price)}
                </p>
              </div>

              <div className="flex flex-wrap gap-2 sm:justify-end">
                <Link to={`/product/${listing.id}`} className="btn-ghost btn-sm">
                  View
                </Link>

                {listing.status !== 'deleted' ? (
                  <button
                    type="button"
                    onClick={() => onStock(listing)}
                    className="btn-secondary btn-sm"
                  >
                    <Package size={13} />
                    Stock
                  </button>
                ) : null}

                {listing.status === 'active' ? (
                  <button
                    type="button"
                    onClick={() => onAction(listing, 'sold')}
                    className="btn-secondary btn-sm"
                  >
                    <CheckCircle2 size={13} />
                    Mark sold
                  </button>
                ) : null}

                {listing.status === 'sold' ? (
                  <button
                    type="button"
                    onClick={() => onAction(listing, 'active')}
                    className="btn-secondary btn-sm"
                  >
                    <RefreshCw size={13} />
                    Relist
                  </button>
                ) : null}

                {listing.status !== 'deleted' ? (
                  <button
                    type="button"
                    onClick={() => onAction(listing, 'deleted')}
                    className="btn-danger btn-sm"
                  >
                    <Trash2 size={13} />
                    Remove
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => onAction(listing, 'active')}
                    className="btn-secondary btn-sm"
                  >
                    <RefreshCw size={13} />
                    Restore
                  </button>
                )}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  )
}

/* ========================================================================== */
/* CREATE LISTING                                                            */
/* ========================================================================== */
function NewListingForm({ profile, onCreated }) {
  const [form, setForm] = useState({
    title: '',
    category: 'Electronics',
    price: '',
    quantity: '1',
    description: '',
  })
  const [imageFile, setImageFile] = useState(null)
  const [preview, setPreview] = useState('')
  const [dragging, setDragging] = useState(false)
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [stage, setStage] = useState('')

  const fileInputRef = useRef(null)
  const previewRef = useRef('')

  useEffect(
    () => () => {
      if (previewRef.current) URL.revokeObjectURL(previewRef.current)
    },
    [],
  )

  const update = (field) => (event) =>
    setForm((current) => ({ ...current, [field]: event.target.value }))

  const pickFile = (file) => {
    if (!file) return
    if (!ACCEPTED_IMAGE_TYPES.includes(file.type)) {
      setError('Use a JPG, PNG, WebP or AVIF image.')
      return
    }
    if (file.size > MAX_IMAGE_BYTES) {
      setError('The photo must be 5 MB or smaller.')
      return
    }

    if (previewRef.current) URL.revokeObjectURL(previewRef.current)
    const url = URL.createObjectURL(file)
    previewRef.current = url
    setPreview(url)
    setImageFile(file)
    setError('')
  }

  const onSubmit = async (event) => {
    event.preventDefault()
    setError('')

    const title = form.title.trim()
    const description = form.description.trim()
    const price = Number(form.price)
    const quantity = Number(form.quantity)

    if (title.length < 3) {
      setError('Give your listing a title of at least 3 characters.')
      return
    }
    if (!Number.isFinite(price) || price <= 0) {
      setError('Enter a price greater than zero.')
      return
    }
    if (price > 100000000) {
      setError('That price is above the marketplace limit.')
      return
    }
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 9999) {
      setError('Enter how many units you have available, between 1 and 9,999.')
      return
    }
    if (!imageFile) {
      setError('Add a clear photo — listings with photos sell far faster.')
      return
    }

    setSubmitting(true)

    try {
      setStage('Uploading photo…')

      const ext =
        {
          'image/jpeg': 'jpg',
          'image/png': 'png',
          'image/webp': 'webp',
          'image/avif': 'avif',
        }[imageFile.type] ?? 'jpg'

      const path = `${profile.id}/${crypto.randomUUID()}.${ext}`

      const { error: uploadError } = await supabase.storage
        .from(LISTING_IMAGES_BUCKET)
        .upload(path, imageFile, {
          cacheControl: '31536000',
          upsert: false,
          contentType: imageFile.type,
        })

      if (uploadError) throw uploadError

      const { data: publicData } = supabase.storage
        .from(LISTING_IMAGES_BUCKET)
        .getPublicUrl(path)

      setStage('Publishing listing…')

      const { data, error: insertError } = await supabase
        .from('listings')
        .insert({
          seller_id: profile.id,
          title,
          description,
          price,
          quantity,
          category: form.category,
          image_url: publicData.publicUrl,
          status: 'active',
        })
        .select('*')
        .single()

      if (insertError) throw insertError

      setForm({ title: '', category: form.category, price: '', quantity: '1', description: '' })
      setImageFile(null)
      if (previewRef.current) URL.revokeObjectURL(previewRef.current)
      previewRef.current = ''
      setPreview('')
      onCreated(data)
    } catch (submitError) {
      setError(friendlyError(submitError, 'The listing could not be published.'))
    } finally {
      setSubmitting(false)
      setStage('')
    }
  }

  return (
    <div>
      <div>
        <h2 className="text-xl font-semibold text-white">Create a listing</h2>
        <p className="mt-1 text-sm text-gray-500">
          A strong photo and an honest description are the difference between a browse and a
          sale.
        </p>
      </div>

      <form onSubmit={onSubmit} className="mt-5 grid gap-5 lg:grid-cols-[1fr_360px]">
        <div className="space-y-5">
          {error ? <Alert variant="error">{error}</Alert> : null}

          <section className="glass rounded-3xl p-5 sm:p-6">
            <div className="grid gap-4 sm:grid-cols-3">
              <div className="sm:col-span-3">
                <label htmlFor="title" className="label">
                  Listing title
                </label>
                <input
                  id="title"
                  type="text"
                  value={form.title}
                  onChange={update('title')}
                  placeholder="e.g. Engineering Mathematics by K.A. Stroud"
                  maxLength={120}
                  className="input"
                  required
                />
                <div className="mt-1.5 flex justify-between">
                  <span className="field-hint">Be specific: course, model, size or condition.</span>
                  <span className="text-[10px] text-gray-600">{form.title.length}/120</span>
                </div>
              </div>

              <div>
                <label htmlFor="price" className="label">
                  Price (KES)
                </label>
                <div className="relative">
                  <span className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-xs font-medium text-gray-500">
                    KES
                  </span>
                  <input
                    id="price"
                    type="number"
                    min="1"
                    step="1"
                    value={form.price}
                    onChange={update('price')}
                    placeholder="1500"
                    className="input pl-14"
                    required
                  />
                </div>
              </div>

              <div>
                <label htmlFor="category" className="label">
                  Category
                </label>
                <div className="relative">
                  <select
                    id="category"
                    value={form.category}
                    onChange={update('category')}
                    className="select"
                    required
                  >
                    {CATEGORIES.map((category) => (
                      <option key={category.value} value={category.value}>
                        {category.value}
                      </option>
                    ))}
                  </select>
                  <ChevronDown
                    size={16}
                    className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 text-gray-500"
                  />
                </div>
              </div>

              <div>
                <label htmlFor="quantity" className="label">
                  Quantity available
                </label>
                <input
                  id="quantity"
                  type="number"
                  min="1"
                  max="9999"
                  step="1"
                  value={form.quantity}
                  onChange={update('quantity')}
                  placeholder="1"
                  className="input"
                  required
                />
                <p className="field-hint">Units you can sell right now.</p>
              </div>

              <div className="sm:col-span-3">
                <label htmlFor="description" className="label">
                  Description
                </label>
                <textarea
                  id="description"
                  value={form.description}
                  onChange={update('description')}
                  placeholder="Condition, what is included, why you are selling, and the best handover spot…"
                  maxLength={4000}
                  rows={7}
                  className="textarea"
                />
                <div className="mt-1.5 flex justify-between">
                  <span className="field-hint">
                    Mention any flaws. Buyers trust listings that are specific.
                  </span>
                  <span className="text-[10px] text-gray-600">{form.description.length}/4000</span>
                </div>
              </div>
            </div>
          </section>

          <section className="glass rounded-3xl p-5 sm:p-6">
            <div className="grid gap-2 rounded-2xl border border-emerald-400/15 bg-emerald-400/[0.04] p-4 sm:grid-cols-3">
              <PublishStep number="1" title="Photo" body="Natural light, clean background." />
              <PublishStep number="2" title="Details" body="Honest condition and price." />
              <PublishStep number="3" title="Go live" body="Appears on the feed instantly." />
            </div>
          </section>
        </div>

        <aside className="space-y-4">
          <div className="glass rounded-3xl p-4">
            <p className="label mb-2">Listing photo</p>

            <div
              onDragOver={(event) => {
                event.preventDefault()
                setDragging(true)
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={(event) => {
                event.preventDefault()
                setDragging(false)
                pickFile(event.dataTransfer.files?.[0])
              }}
              className={cn(
                'relative overflow-hidden rounded-2xl border border-dashed transition',
                dragging
                  ? 'border-emerald-400/60 bg-emerald-400/[0.06]'
                  : 'border-white/15 bg-black/20',
              )}
            >
              {preview ? (
                <div className="relative aspect-[4/3]">
                  <img src={preview} alt="Listing preview" className="h-full w-full object-cover" />
                  <button
                    type="button"
                    onClick={() => {
                      if (previewRef.current) URL.revokeObjectURL(previewRef.current)
                      previewRef.current = ''
                      setPreview('')
                      setImageFile(null)
                      if (fileInputRef.current) fileInputRef.current.value = ''
                    }}
                    className="absolute right-2 top-2 grid h-8 w-8 place-items-center rounded-full bg-black/60 text-white backdrop-blur transition hover:bg-black/80"
                    aria-label="Remove photo"
                  >
                    <X size={15} />
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="flex aspect-[4/3] w-full flex-col items-center justify-center gap-2 px-5 text-center"
                >
                  <span className="grid h-11 w-11 place-items-center rounded-2xl border border-white/10 bg-white/[0.04] text-emerald-300">
                    <ImagePlus size={20} />
                  </span>
                  <span className="text-xs font-medium text-white">Click or drop a photo</span>
                  <span className="text-[10px] leading-relaxed text-gray-500">
                    JPG, PNG, WebP or AVIF · max 5 MB
                  </span>
                </button>
              )}
            </div>

            <input
              ref={fileInputRef}
              type="file"
              accept={ACCEPTED_IMAGE_TYPES.join(',')}
              onChange={(event) => pickFile(event.target.files?.[0])}
              className="hidden"
            />

            <p className="mt-2.5 text-[10px] leading-relaxed text-gray-600">
              Use your own photo. Clear, well-lit images get more messages and faster sales.
            </p>
          </div>

          <div className="glass rounded-3xl p-5">
            <p className="text-xs font-semibold text-white">Publishing checklist</p>
            <ul className="mt-3 space-y-2 text-[11px] text-gray-400">
              <li className="flex gap-2">
                <CheckCircle2 size={13} className="mt-0.5 shrink-0 text-emerald-400" />
                Real price in Kenyan Shillings
              </li>
              <li className="flex gap-2">
                <CheckCircle2 size={13} className="mt-0.5 shrink-0 text-emerald-400" />
                Clear handover location in your messages
              </li>
              <li className="flex gap-2">
                <CheckCircle2 size={13} className="mt-0.5 shrink-0 text-emerald-400" />
                No prohibited or counterfeit items
              </li>
            </ul>
          </div>

          <button type="submit" disabled={submitting} className="btn-seller w-full py-3">
            {submitting ? (
              <>
                <Spinner size={16} />
                {stage || 'Publishing…'}
              </>
            ) : (
              <>
                <Upload size={16} />
                Publish listing
              </>
            )}
          </button>
          <p className="text-center text-[10px] text-gray-600">
            You can mark it sold or remove it at any time.
          </p>
        </aside>
      </form>
    </div>
  )
}

function PublishStep({ number, title, body }) {
  return (
    <div className="flex gap-2.5">
      <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full border border-emerald-400/25 bg-emerald-400/10 text-[10px] font-bold text-emerald-300">
        {number}
      </span>
      <div>
        <p className="text-[11px] font-medium text-white">{title}</p>
        <p className="text-[10px] leading-relaxed text-gray-500">{body}</p>
      </div>
    </div>
  )
}

/* ========================================================================== */
/* ORDERS                                                                     */
/* ========================================================================== */
function OrdersTab({ orders, onAction }) {
  const [filter, setFilter] = useState('all')

  const filters = [
    { value: 'all', label: 'All' },
    { value: 'pending', label: 'Pending' },
    { value: 'delivered', label: 'Delivered' },
    { value: 'completed', label: 'Completed' },
    { value: 'cancelled', label: 'Cancelled' },
  ]

  const visible = filter === 'all' ? orders : orders.filter((order) => order.status === filter)

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold text-white">Incoming orders</h2>
          <p className="mt-1 text-sm text-gray-500">
            {orders.filter((order) => order.status === 'pending').length} pending handover
            {orders.filter((order) => order.status === 'pending').length === 1 ? '' : 's'}
          </p>
        </div>
        <span className="badge border-white/10 bg-white/[0.03] text-gray-400">
          <ShieldCheck size={12} className="text-emerald-400" />
          Buyer details are shared only for active orders
        </span>
      </div>

      <div className="mt-5 flex flex-wrap gap-2">
        {filters.map((option) => (
          <button
            key={option.value}
            type="button"
            onClick={() => setFilter(option.value)}
            className={cn('chip', filter === option.value && 'chip-active')}
          >
            {option.label}
            <span className="text-[10px] opacity-60">
              {option.value === 'all'
                ? orders.length
                : orders.filter((order) => order.status === option.value).length}
            </span>
          </button>
        ))}
      </div>

      <div className="mt-5 space-y-4">
        {visible.length === 0 ? (
          <EmptyState
            icon={ShoppingBag}
            title={orders.length === 0 ? 'No orders yet' : 'Nothing in this status'}
            description={
              orders.length === 0
                ? 'When a buyer checks out, their order lands here with handover details.'
                : 'Switch filters to review the rest of your orders.'
            }
            action={
              orders.length === 0 ? (
                <Link to="/seller?tab=new" className="btn-seller">
                  <PackagePlus size={16} />
                  Create a listing
                </Link>
              ) : (
                <button type="button" onClick={() => setFilter('all')} className="btn-secondary">
                  Show all
                </button>
              )
            }
          />
        ) : (
          visible.map((order) => {
            const items = order.items ?? []
            const itemCount = items.reduce((sum, item) => sum + item.quantity, 0)

            return (
              <article key={order.id} className="glass overflow-hidden rounded-3xl">
                <div className="flex flex-wrap items-center gap-3 border-b border-white/[0.07] px-5 py-4">
                  <Avatar profile={order.buyer} size={34} />
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-white">
                      {order.buyer?.full_name || order.buyer?.username || 'Buyer'}
                    </p>
                    <p className="mt-0.5 text-[10px] uppercase tracking-[0.12em] text-gray-600">
                      MH-{order.id.slice(0, 8).toUpperCase()} · {formatDateTime(order.created_at)}
                    </p>
                  </div>
                  <div className="ml-auto">
                    <StatusPill meta={ORDER_STATUS_META[order.status]} />
                  </div>
                </div>

                <ul className="divide-y divide-white/[0.06]">
                  {items.map((item) => (
                    <li key={item.id} className="flex items-center gap-3 px-5 py-3">
                      <div className="h-12 w-12 shrink-0 overflow-hidden rounded-lg border border-white/[0.08] bg-ink-800">
                        {item.listing?.image_url ? (
                          <img
                            src={item.listing.image_url}
                            alt={item.listing.title || 'Item'}
                            className="h-full w-full object-cover"
                            loading="lazy"
                          />
                        ) : (
                          <div className="grid h-full w-full place-items-center text-gray-600">
                            <Package size={16} />
                          </div>
                        )}
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="line-clamp-1 text-xs font-medium text-white">
                          {item.listing?.title || 'Listing removed'}
                        </p>
                        <p className="mt-0.5 text-[11px] text-gray-500">
                          {item.quantity} × {formatKES(item.price_at_purchase)}
                        </p>
                      </div>
                      <p className="text-xs font-medium text-white">
                        {formatKES(Number(item.price_at_purchase) * item.quantity)}
                      </p>
                    </li>
                  ))}
                </ul>

                <div className="grid gap-4 border-t border-white/[0.07] bg-white/[0.015] px-5 py-4 sm:grid-cols-[1fr_auto] sm:items-end">
                  <div className="space-y-1.5 text-[11px] text-gray-500">
                    {order.delivery_location ? (
                      <p className="flex items-center gap-1.5">
                        <Package size={12} className="text-emerald-300" />
                        {order.delivery_location}
                      </p>
                    ) : null}
                    {order.contact_phone ? (
                      <a
                        href={`tel:${order.contact_phone}`}
                        className="flex items-center gap-1.5 text-gray-400 transition hover:text-white"
                      >
                        <Phone size={12} className="text-gray-600" />
                        {order.contact_phone}
                      </a>
                    ) : null}
                    <p className="flex items-center gap-1.5">
                      <Clock3 size={12} className="text-gray-600" />
                      {itemCount} item{itemCount === 1 ? '' : 's'} · buyer joined{' '}
                      {formatDate(order.buyer?.created_at)}
                    </p>
                  </div>

                  <div className="flex flex-wrap items-center gap-2 sm:justify-end">
                    <div className="mr-1 text-right">
                      <p className="text-[10px] uppercase tracking-[0.14em] text-gray-600">Total</p>
                      <p className="font-display text-lg font-semibold text-white">
                        {formatKES(order.total_amount)}
                      </p>
                    </div>

                    <Link to={`/messages?user=${order.buyer_id}`} className="btn-ghost btn-sm">
                      <MessageSquare size={13} />
                      Message
                    </Link>

                    {order.status === 'pending' ? (
                      <>
                        <button
                          type="button"
                          onClick={() => onAction(order, 'cancelled')}
                          className="btn-danger btn-sm"
                        >
                          <XCircle size={13} />
                          Cancel
                        </button>
                        <button
                          type="button"
                          onClick={() => onAction(order, 'delivered')}
                          className="btn-seller btn-sm"
                        >
                          <CheckCircle2 size={13} />
                          Mark delivered
                        </button>
                      </>
                    ) : null}

                    {order.status === 'delivered' ? (
                      <span className="badge border-sky-400/20 bg-sky-400/10 text-sky-300">
                        Awaiting buyer confirmation
                      </span>
                    ) : null}
                  </div>
                </div>
              </article>
            )
          })
        )}
      </div>
    </div>
  )
}

/* ========================================================================== */
/* SUBSCRIPTION                                                               */
/* ========================================================================== */
function SubscriptionTab({
  profile,
  subscriptions,
  activeSubscription,
  pendingSubscription,
  onCreated,
}) {
  const [selectedPlan, setSelectedPlan] = useState(pendingSubscription?.plan ?? 'pro')
  const [mpesaCode, setMpesaCode] = useState('')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const selected = PLAN_BY_ID[selectedPlan]

  const onSubmit = async (event) => {
    event.preventDefault()
    setError('')

    const code = mpesaCode.trim().toUpperCase()
    if (!/^[A-Z0-9]{6,20}$/.test(code)) {
      setError('Enter the M-Pesa transaction code from your confirmation SMS.')
      return
    }

    setSubmitting(true)

    const { data, error: insertError } = await supabase
      .from('subscriptions')
      .insert({
        seller_id: profile.id,
        plan: selectedPlan,
        status: 'pending',
        amount: selected.price,
        mpesa_code: code,
      })
      .select('*')
      .single()

    setSubmitting(false)

    if (insertError) {
      setError(friendlyError(insertError, 'The payment could not be submitted.'))
      return
    }

    setMpesaCode('')
    onCreated(data)
  }

  return (
    <div className="space-y-6">
      {activeSubscription ? (
        <div className="relative overflow-hidden rounded-3xl border border-amber-400/20 bg-[radial-gradient(circle_at_15%_0%,rgba(245,158,11,0.16),transparent_55%),radial-gradient(circle_at_95%_100%,rgba(236,72,153,0.08),transparent_55%)] p-6">
          <div className="flex flex-wrap items-center gap-4">
            <span className="grid h-16 w-16 place-items-center rounded-2xl border border-white/10 bg-white/[0.04]">
              <VerifiedBadge plan={activeSubscription.plan} size={38} />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-[10px] uppercase tracking-[0.18em] text-amber-200/70">
                Current plan
              </p>
              <h2 className="mt-1 text-2xl font-semibold text-white">
                {PLAN_BY_ID[activeSubscription.plan]?.name ?? 'Pro'} seller
              </h2>
              <p className="mt-1 text-xs text-gray-400">
                Active until {formatDate(activeSubscription.expires_at)} ·{' '}
                {Math.max(
                  0,
                  Math.ceil(
                    (new Date(activeSubscription.expires_at).getTime() - Date.now()) /
                      (1000 * 60 * 60 * 24),
                  ),
                )}{' '}
                days remaining
              </p>
            </div>
            <StatusPill meta={SUBSCRIPTION_STATUS_META.active} />
          </div>
          <p className="mt-4 max-w-2xl text-xs leading-relaxed text-gray-400">
            Your listings rank above free sellers, and the badge appears on your product cards,
            listing detail, seller studio and chat threads. Keep it live by renewing before the
            expiry date.
          </p>
        </div>
      ) : null}

      {pendingSubscription ? (
        <Alert variant="info" title="Payment under review">
          Your {PLAN_BY_ID[pendingSubscription.plan]?.name} request with M-Pesa code{' '}
          <span className="font-mono">{pendingSubscription.mpesa_code}</span> is waiting for the
          campus desk. Badges activate only after approval. You can submit a new code if this
          one was wrong.
        </Alert>
      ) : null}

      <div className="grid gap-5 lg:grid-cols-[1.25fr_1fr] lg:items-start">
        <div>
          <h2 className="text-xl font-semibold text-white">Choose your visibility</h2>
          <p className="mt-1 text-sm text-gray-500">
            Paid plans put your hustle in front of more students and add a trusted seal.
          </p>

          <div className="mt-5 grid gap-3 sm:grid-cols-2">
            {PLANS.map((plan) => {
              const selectedPlanCard = selectedPlan === plan.id
              return (
                <button
                  key={plan.id}
                  type="button"
                  onClick={() => setSelectedPlan(plan.id)}
                  aria-pressed={selectedPlanCard}
                  className={cn(
                    'relative overflow-hidden rounded-3xl border p-5 text-left transition',
                    selectedPlanCard
                      ? cn(plan.ring, 'bg-white/[0.05]', plan.glow)
                      : 'border-white/10 bg-white/[0.02] hover:border-white/20',
                  )}
                >
                  <div className="flex items-start justify-between gap-3">
                    <span
                      className={cn(
                        'grid h-11 w-11 place-items-center rounded-2xl bg-gradient-to-br',
                        plan.accent,
                      )}
                    >
                      <VerifiedBadge plan={plan.id} size={24} />
                    </span>
                    {selectedPlanCard ? (
                      <span className="badge border-white/15 bg-white/[0.06] text-gray-200">
                        <CheckCircle2 size={11} />
                        Selected
                      </span>
                    ) : null}
                  </div>

                  <p className="mt-4 font-display text-lg font-semibold text-white">{plan.name}</p>
                  <p className="mt-0.5 text-[11px] text-gray-500">{plan.tagline}</p>

                  <p className="mt-3 flex items-baseline gap-1">
                    <span className="font-display text-2xl font-semibold text-white">
                      {formatKES(plan.price)}
                    </span>
                    <span className="text-[11px] text-gray-500">/ 30 days</span>
                  </p>

                  <ul className="mt-4 space-y-1.5">
                    {plan.features.map((feature) => (
                      <li key={feature} className="flex gap-1.5 text-[11px] text-gray-400">
                        <CheckCircle2 size={12} className="mt-0.5 shrink-0 text-emerald-400" />
                        {feature}
                      </li>
                    ))}
                  </ul>
                </button>
              )
            })}
          </div>

          <div className="mt-4 flex items-start gap-2.5 rounded-2xl border border-white/[0.07] bg-white/[0.02] p-4 text-[11px] leading-relaxed text-gray-500">
            <ShieldCheck size={15} className="mt-0.5 shrink-0 text-emerald-400" />
            Plans renew manually. M-Hustle does not auto-debit. Every payment is verified by the
            campus desk before a badge is issued.
          </div>
        </div>

        <div className="glass rounded-3xl p-5 sm:p-6">
          <div className="flex items-center gap-2">
            <Banknote size={16} className="text-emerald-300" />
            <h2 className="text-sm font-semibold text-white">Pay with M-Pesa</h2>
          </div>

          <ol className="mt-4 space-y-3">
            <li className="flex gap-3">
              <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full border border-white/10 bg-white/[0.04] text-[10px] font-bold text-emerald-300">
                1
              </span>
              <p className="text-xs leading-relaxed text-gray-400">
                Go to <span className="text-white">M-Pesa → Lipa na M-Pesa → Pay Bill</span>.
              </p>
            </li>
            <li className="flex gap-3">
              <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full border border-white/10 bg-white/[0.04] text-[10px] font-bold text-emerald-300">
                2
              </span>
              <p className="text-xs leading-relaxed text-gray-400">
                Business number{' '}
                <span className="font-mono text-white">{MPESA_PAYBILL}</span>, account{' '}
                <span className="font-mono text-white">{MPESA_ACCOUNT}</span>.
              </p>
            </li>
            <li className="flex gap-3">
              <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full border border-white/10 bg-white/[0.04] text-[10px] font-bold text-emerald-300">
                3
              </span>
              <p className="text-xs leading-relaxed text-gray-400">
                Enter <span className="text-white">{formatKES(selected.price)}</span> and paste
                the confirmation code below.
              </p>
            </li>
          </ol>

          <form onSubmit={onSubmit} className="mt-5 space-y-3">
            {error ? <Alert variant="error">{error}</Alert> : null}

            <div>
              <span className="label">Selected plan</span>
              <div className="flex items-center justify-between rounded-2xl border border-white/10 bg-black/20 px-4 py-3">
                <div className="flex items-center gap-2">
                  <VerifiedBadge plan={selectedPlan} size={18} />
                  <span className="text-sm font-medium text-white">{selected.name}</span>
                </div>
                <span className="text-sm font-semibold text-white">{formatKES(selected.price)}</span>
              </div>
            </div>

            <div>
              <label htmlFor="mpesaCode" className="label">
                M-Pesa transaction code
              </label>
              <input
                id="mpesaCode"
                type="text"
                value={mpesaCode}
                onChange={(event) => setMpesaCode(event.target.value.toUpperCase())}
                placeholder="e.g. SLK7X2Q9AB"
                maxLength={20}
                autoCapitalize="characters"
                className="input font-mono tracking-[0.12em]"
                required
              />
              <p className="field-hint">
                Found in the confirmation SMS. Each code can only be used once.
              </p>
            </div>

            <button type="submit" disabled={submitting} className="btn-seller w-full py-3">
              {submitting ? (
                <>
                  <Spinner size={16} />
                  Submitting…
                </>
              ) : (
                <>
                  <ShieldCheck size={16} />
                  Submit for approval
                </>
              )}
            </button>
          </form>

          <p className="mt-3 text-center text-[10px] leading-relaxed text-gray-600">
            Approval is usually same-day. Questions? {SUPPORT_EMAIL}
          </p>
        </div>
      </div>

      <section>
        <h2 className="text-sm font-semibold text-white">Payment history</h2>
        {subscriptions.length === 0 ? (
          <div className="mt-3 rounded-2xl border border-white/[0.07] bg-white/[0.02] p-6 text-center">
            <BadgeCheck size={22} className="mx-auto text-gray-600" />
            <p className="mt-2 text-xs text-gray-500">No subscription requests yet.</p>
          </div>
        ) : (
          <div className="glass mt-3 overflow-x-auto rounded-2xl">
            <table className="w-full min-w-[620px] text-left text-xs">
              <thead className="border-b border-white/[0.07] text-[10px] uppercase tracking-[0.14em] text-gray-600">
                <tr>
                  <th className="px-4 py-3 font-medium">Plan</th>
                  <th className="px-4 py-3 font-medium">M-Pesa code</th>
                  <th className="px-4 py-3 font-medium">Amount</th>
                  <th className="px-4 py-3 font-medium">Requested</th>
                  <th className="px-4 py-3 font-medium">Expires</th>
                  <th className="px-4 py-3 font-medium">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/[0.06]">
                {subscriptions.map((subscription) => (
                  <tr key={subscription.id}>
                    <td className="px-4 py-3">
                      <span className="inline-flex items-center gap-1.5 text-white">
                        <VerifiedBadge plan={subscription.plan} size={14} />
                        {PLAN_BY_ID[subscription.plan]?.name ?? subscription.plan}
                      </span>
                    </td>
                    <td className="px-4 py-3 font-mono text-gray-400">{subscription.mpesa_code}</td>
                    <td className="px-4 py-3 text-gray-300">{formatKES(subscription.amount)}</td>
                    <td className="px-4 py-3 text-gray-500">
                      {formatDate(subscription.created_at)}
                    </td>
                    <td className="px-4 py-3 text-gray-500">
                      {subscription.expires_at ? formatDate(subscription.expires_at) : '—'}
                    </td>
                    <td className="px-4 py-3">
                      <StatusPill meta={SUBSCRIPTION_STATUS_META[subscription.status]} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  )
}
