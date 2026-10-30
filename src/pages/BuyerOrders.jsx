import { useCallback, useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import {
  AlertCircle,
  ArrowLeft,
  CheckCircle2,
  Clock3,
  MapPin,
  MessageSquare,
  Package,
  Phone,
  RefreshCw,
  ShoppingBag,
  Star,
  XCircle,
} from 'lucide-react'
import { useAuth } from '../hooks/useAuth'
import { supabase } from '../lib/supabase'
import {
  Alert,
  Avatar,
  EmptyState,
  Modal,
  PageLoader,
  RatingStars,
  Spinner,
  StatusPill,
} from '../components/ui'
import {
  cn,
  formatDate,
  formatDateTime,
  formatKES,
  friendlyError,
  ORDER_STATUS_META,
} from '../lib/utils'

const FILTERS = [
  { value: 'all', label: 'All orders' },
  { value: 'pending', label: 'Pending' },
  { value: 'delivered', label: 'Delivered' },
  { value: 'completed', label: 'Completed' },
  { value: 'cancelled', label: 'Cancelled' },
]

export default function BuyerOrders() {
  const { user } = useAuth()
  const [searchParams, setSearchParams] = useSearchParams()

  const [orders, setOrders] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [filter, setFilter] = useState('all')
  const [actionOrder, setActionOrder] = useState(null)
  const [actionType, setActionType] = useState(null)
  const [working, setWorking] = useState(false)
  const [actionError, setActionError] = useState('')
  const [reviews, setReviews] = useState({})
  const [reviewOrder, setReviewOrder] = useState(null)
  const [reviewRating, setReviewRating] = useState(5)
  const [reviewComment, setReviewComment] = useState('')
  const [reviewSaving, setReviewSaving] = useState(false)
  const [reviewError, setReviewError] = useState('')

  const [banner, setBanner] = useState(() => {
    const count = Number(searchParams.get('success') ?? 0)
    return count > 0
      ? `${count} order${count === 1 ? '' : 's'} placed. The seller has your handover details.`
      : ''
  })

  useEffect(() => {
    if (searchParams.has('success')) {
      const params = new URLSearchParams(searchParams)
      params.delete('success')
      setSearchParams(params, { replace: true })
    }
    // Intentionally runs once for the arrival banner.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const load = useCallback(async () => {
    if (!user?.id) return

    setLoading(true)
    setError('')

    const { data: orderRows, error: orderError } = await supabase
      .from('orders')
      .select(
        'id, status, total_amount, created_at, delivery_location, contact_phone, seller_id',
      )
      .eq('buyer_id', user.id)
      .order('created_at', { ascending: false })

    if (orderError) {
      setError(orderError.message)
      setLoading(false)
      return
    }

    const rows = orderRows ?? []
    const orderIds = rows.map((order) => order.id)
    const sellerIds = [...new Set(rows.map((order) => order.seller_id).filter(Boolean))]

    let itemRows = []
    let sellerRows = []
    let reviewRows = []

    if (orderIds.length > 0) {
      const [itemResult, sellerResult, reviewResult] = await Promise.all([
        supabase
          .from('order_items')
          .select('id, order_id, listing_id, quantity, price_at_purchase')
          .in('order_id', orderIds),
        supabase
          .from('profiles')
          .select('id, username, full_name, avatar_url')
          .in('id', sellerIds),
        supabase.from('reviews').select('order_id, rating').eq('buyer_id', user.id),
      ])

      itemRows = itemResult.data ?? []
      sellerRows = sellerResult.data ?? []

      if (!reviewResult.error) {
        reviewRows = reviewResult.data ?? []
      }
    }

    const listingIds = [
      ...new Set(itemRows.map((item) => item.listing_id).filter(Boolean)),
    ]

    let listingRows = []
    if (listingIds.length > 0) {
      const { data } = await supabase
        .from('listings')
        .select('id, title, image_url, status')
        .in('id', listingIds)
      listingRows = data ?? []
    }

    const sellerMap = {}
    for (const seller of sellerRows) sellerMap[seller.id] = seller

    const listingMap = {}
    for (const listing of listingRows) listingMap[listing.id] = listing

    const itemsByOrder = new Map()
    for (const item of itemRows) {
      if (!itemsByOrder.has(item.order_id)) itemsByOrder.set(item.order_id, [])
      itemsByOrder.get(item.order_id).push({
        ...item,
        listing: item.listing_id ? listingMap[item.listing_id] ?? null : null,
      })
    }

    const reviewMap = {}
    for (const review of reviewRows) reviewMap[review.order_id] = review
    setReviews(reviewMap)

    setOrders(
      rows.map((order) => ({
        ...order,
        seller: sellerMap[order.seller_id] ?? null,
        items: itemsByOrder.get(order.id) ?? [],
      })),
    )
    setLoading(false)
  }, [user?.id])

  useEffect(() => {
    void load()
  }, [load])

  const openAction = (order, type) => {
    setActionError('')
    setActionOrder(order)
    setActionType(type)
  }

  const closeAction = () => {
    if (working) return
    setActionOrder(null)
    setActionType(null)
  }

  const confirmAction = async () => {
    if (!actionOrder || !actionType) return

    const nextStatus = actionType === 'confirm' ? 'completed' : 'cancelled'
    setWorking(true)
    setActionError('')

    const { error: updateError } = await supabase
      .from('orders')
      .update({ status: nextStatus })
      .eq('id', actionOrder.id)

    setWorking(false)

    if (updateError) {
      setActionError(friendlyError(updateError))
      return
    }

    setOrders((current) =>
      current.map((order) =>
        order.id === actionOrder.id ? { ...order, status: nextStatus } : order,
      ),
    )
    setActionOrder(null)
    setActionType(null)
  }

  const openReview = (order) => {
    setReviewOrder(order)
    setReviewRating(5)
    setReviewComment('')
    setReviewError('')
  }

  const closeReview = () => {
    if (reviewSaving) return
    setReviewOrder(null)
  }

  const submitReview = async () => {
    if (!reviewOrder || reviewSaving) return

    setReviewSaving(true)
    setReviewError('')

    const { error: insertError } = await supabase.from('reviews').insert({
      order_id: reviewOrder.id,
      buyer_id: user.id,
      seller_id: reviewOrder.seller_id,
      rating: reviewRating,
      comment: reviewComment.trim() || null,
    })

    setReviewSaving(false)

    if (insertError) {
      setReviewError(friendlyError(insertError, 'Your review could not be submitted.'))
      return
    }

    setReviews((current) => ({
      ...current,
      [reviewOrder.id]: { order_id: reviewOrder.id, rating: reviewRating },
    }))
    setReviewOrder(null)
  }

  const visibleOrders =
    filter === 'all' ? orders : orders.filter((order) => order.status === filter)

  const counts = orders.reduce(
    (acc, order) => {
      acc[order.status] = (acc[order.status] ?? 0) + 1
      return acc
    },
    {},
  )

  if (loading && orders.length === 0) {
    return <PageLoader label="Loading your orders…" />
  }

  return (
    <div className="mx-auto max-w-5xl px-4 py-10 sm:px-6 lg:px-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="eyebrow">Purchase history</p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight text-white sm:text-4xl">
            My orders
          </h1>
          <p className="mt-1.5 text-sm text-gray-400">
            Confirm receipt once an item is in your hands. Until then, the seller keeps the
            order open.
          </p>
        </div>
        <div className="flex gap-2">
          <button type="button" onClick={() => void load()} className="btn-secondary btn-sm">
            <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
            Refresh
          </button>
          <Link to="/" className="btn-primary btn-sm">
            <ShoppingBag size={14} />
            Keep shopping
          </Link>
        </div>
      </div>

      {banner ? (
        <Alert variant="success" className="mt-6" onClose={() => setBanner('')}>
          {banner}
        </Alert>
      ) : null}

      {error ? (
        <Alert variant="error" className="mt-6" title="Orders could not load">
          {error}
        </Alert>
      ) : null}

      <div className="no-scrollbar mt-7 flex gap-2 overflow-x-auto pb-1">
        {FILTERS.map((option) => (
          <button
            key={option.value}
            type="button"
            onClick={() => setFilter(option.value)}
            className={cn('chip shrink-0', filter === option.value && 'chip-active')}
          >
            {option.label}
            <span className="text-[10px] opacity-60">
              {option.value === 'all' ? orders.length : counts[option.value] ?? 0}
            </span>
          </button>
        ))}
      </div>

      <div className="mt-6 space-y-5">
        {visibleOrders.length === 0 ? (
          <EmptyState
            icon={Package}
            title={orders.length === 0 ? 'No orders yet' : `No ${filter} orders`}
            description={
              orders.length === 0
                ? 'When you check out, every order appears here with its status, seller and handover details.'
                : 'Try a different status filter to see the rest of your purchase history.'
            }
            action={
              orders.length === 0 ? (
                <Link to="/" className="btn-primary">
                  <ArrowLeft size={16} />
                  Browse listings
                </Link>
              ) : (
                <button type="button" onClick={() => setFilter('all')} className="btn-secondary">
                  Show all orders
                </button>
              )
            }
          />
        ) : (
          visibleOrders.map((order) => {
            const meta = ORDER_STATUS_META[order.status]
            const itemCount = (order.items ?? []).reduce((sum, item) => sum + item.quantity, 0)

            return (
              <article key={order.id} className="glass overflow-hidden rounded-3xl">
                <div className="flex flex-wrap items-center gap-3 border-b border-white/[0.07] px-5 py-4">
                  <div className="min-w-0">
                    <p className="text-[10px] uppercase tracking-[0.16em] text-gray-600">
                      Order MH-{order.id.slice(0, 8).toUpperCase()}
                    </p>
                    <p className="mt-0.5 text-xs text-gray-400">
                      {formatDateTime(order.created_at)}
                    </p>
                  </div>
                  <div className="ml-auto flex items-center gap-2">
                    <StatusPill meta={meta} />
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-3 border-b border-white/[0.06] px-5 py-3">
                  <Avatar profile={order.seller} size={26} />
                  <p className="text-xs text-gray-400">
                    Sold by{' '}
                    <Link
                      to={`/messages?user=${order.seller_id}`}
                      className="font-medium text-white hover:text-orange-200"
                    >
                      {order.seller?.full_name || order.seller?.username || 'Campus seller'}
                    </Link>
                  </p>
                  <Link
                    to={`/messages?user=${order.seller_id}`}
                    className="ml-auto inline-flex items-center gap-1.5 text-[11px] text-orange-300 transition hover:text-orange-200"
                  >
                    <MessageSquare size={13} />
                    Message seller
                  </Link>
                </div>

                <ul className="divide-y divide-white/[0.06]">
                  {(order.items ?? []).map((item) => (
                    <li key={item.id} className="flex items-center gap-3.5 px-5 py-3.5">
                      <div className="h-14 w-14 shrink-0 overflow-hidden rounded-xl border border-white/[0.08] bg-ink-800">
                        {item.listing?.image_url ? (
                          <img
                            src={item.listing.image_url}
                            alt={item.listing.title || 'Ordered item'}
                            loading="lazy"
                            className="h-full w-full object-cover"
                          />
                        ) : (
                          <div className="grid h-full w-full place-items-center text-gray-600">
                            <ShoppingBag size={18} />
                          </div>
                        )}
                      </div>
                      <div className="min-w-0 flex-1">
                        {item.listing ? (
                          <Link
                            to={`/product/${item.listing.id}`}
                            className="line-clamp-1 text-sm font-medium text-white transition hover:text-orange-100"
                          >
                            {item.listing.title}
                          </Link>
                        ) : (
                          <p className="text-sm text-gray-400">Listing no longer available</p>
                        )}
                        <p className="mt-0.5 text-[11px] text-gray-500">
                          {item.quantity} × {formatKES(item.price_at_purchase)}
                        </p>
                      </div>
                      <p className="shrink-0 text-sm font-medium text-white">
                        {formatKES(Number(item.price_at_purchase) * item.quantity)}
                      </p>
                    </li>
                  ))}
                </ul>

                <div className="flex flex-wrap items-end justify-between gap-4 border-t border-white/[0.07] bg-white/[0.015] px-5 py-4">
                  <div className="space-y-1.5 text-[11px] text-gray-500">
                    {order.delivery_location ? (
                      <p className="flex items-center gap-1.5">
                        <MapPin size={12} className="text-orange-300" />
                        {order.delivery_location}
                      </p>
                    ) : null}
                    {order.contact_phone ? (
                      <p className="flex items-center gap-1.5">
                        <Phone size={12} className="text-gray-600" />
                        {order.contact_phone}
                      </p>
                    ) : null}
                    <p className="flex items-center gap-1.5">
                      <Clock3 size={12} className="text-gray-600" />
                      {itemCount} item{itemCount === 1 ? '' : 's'} · {formatDate(order.created_at)}
                    </p>
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    <div className="mr-1 text-right">
                      <p className="text-[10px] uppercase tracking-[0.14em] text-gray-600">
                        Total
                      </p>
                      <p className="font-display text-lg font-semibold text-white">
                        {formatKES(order.total_amount)}
                      </p>
                    </div>

                    {order.status === 'pending' ? (
                      <button
                        type="button"
                        onClick={() => openAction(order, 'cancel')}
                        className="btn-danger btn-sm"
                      >
                        <XCircle size={14} />
                        Cancel
                      </button>
                    ) : null}

                    {order.status === 'delivered' ? (
                      <button
                        type="button"
                        onClick={() => openAction(order, 'confirm')}
                        className="btn-primary btn-sm"
                      >
                        <CheckCircle2 size={14} />
                        Confirm receipt
                      </button>
                    ) : null}

                    {order.status === 'completed' ? (
                      <>
                        <span className="badge border-emerald-400/20 bg-emerald-400/10 text-emerald-300">
                          <CheckCircle2 size={12} />
                          Received
                        </span>
                        {reviews[order.id] ? (
                          <span className="badge border-amber-400/20 bg-amber-400/10 text-amber-300">
                            <Star size={12} fill="currentColor" />
                            Rated {reviews[order.id].rating}/5
                          </span>
                        ) : (
                          <button
                            type="button"
                            onClick={() => openReview(order)}
                            className="btn-secondary btn-sm"
                          >
                            <Star size={13} />
                            Rate seller
                          </button>
                        )}
                      </>
                    ) : null}

                    {order.status === 'cancelled' ? (
                      <span className="badge border-red-400/20 bg-red-400/10 text-red-300">
                        <AlertCircle size={12} />
                        Closed
                      </span>
                    ) : null}
                  </div>
                </div>
              </article>
            )
          })
        )}
      </div>

      <Modal
        open={Boolean(actionOrder && actionType)}
        onClose={closeAction}
        title={actionType === 'confirm' ? 'Confirm you received this order?' : 'Cancel this order?'}
        description={
          actionType === 'confirm'
            ? 'This marks the order completed and tells the seller the handover is done. Only confirm after you have inspected the item.'
            : 'The seller will see the order as cancelled. You can always order the item again if it is still available.'
        }
        footer={
          <>
            <button type="button" onClick={closeAction} disabled={working} className="btn-secondary">
              Keep order
            </button>
            <button
              type="button"
              onClick={confirmAction}
              disabled={working}
              className={actionType === 'confirm' ? 'btn-primary' : 'btn-danger'}
            >
              {working ? (
                <>
                  <Spinner size={15} />
                  Updating…
                </>
              ) : actionType === 'confirm' ? (
                <>
                  <CheckCircle2 size={15} />
                  Confirm receipt
                </>
              ) : (
                <>
                  <XCircle size={15} />
                  Cancel order
                </>
              )}
            </button>
          </>
        }
      >
        {actionError ? <Alert variant="error">{actionError}</Alert> : null}
        {actionOrder ? (
          <div className="rounded-2xl border border-white/10 bg-black/20 p-4 text-sm">
            <p className="text-gray-400">
              Order <span className="text-white">MH-{actionOrder.id.slice(0, 8).toUpperCase()}</span>
            </p>
            <p className="mt-1 text-xs text-gray-500">
              {actionOrder.seller?.full_name || actionOrder.seller?.username} ·{' '}
              {formatKES(actionOrder.total_amount)}
            </p>
          </div>
        ) : null}
      </Modal>

      <Modal
        open={Boolean(reviewOrder)}
        onClose={closeReview}
        title="Rate this seller"
        description="Your rating helps good campus sellers rise to the top of the feed."
        footer={
          <>
            <button
              type="button"
              onClick={closeReview}
              disabled={reviewSaving}
              className="btn-secondary"
            >
              Not now
            </button>
            <button
              type="button"
              onClick={submitReview}
              disabled={reviewSaving}
              className="btn-primary"
            >
              {reviewSaving ? (
                <>
                  <Spinner size={15} />
                  Submitting…
                </>
              ) : (
                <>
                  <Star size={15} />
                  Submit rating
                </>
              )}
            </button>
          </>
        }
      >
        {reviewError ? <Alert variant="error">{reviewError}</Alert> : null}
        {reviewOrder ? (
          <div className="space-y-4">
            <div className="rounded-2xl border border-white/10 bg-black/20 p-4">
              <p className="text-sm font-medium text-white">
                {reviewOrder.seller?.full_name || reviewOrder.seller?.username}
              </p>
              <p className="mt-1 text-xs text-gray-500">
                Order MH-{reviewOrder.id.slice(0, 8).toUpperCase()} ·{' '}
                {formatKES(reviewOrder.total_amount)}
              </p>
            </div>

            <div>
              <p className="label">Your rating</p>
              <div className="flex justify-center rounded-2xl border border-white/10 bg-black/20 py-4">
                <RatingStars
                  value={reviewRating}
                  onChange={setReviewRating}
                  size={32}
                />
              </div>
              <p className="mt-2 text-center text-xs text-gray-500">
                {reviewRating} out of 5
              </p>
            </div>

            <div>
              <label htmlFor="reviewComment" className="label">
                Comment <span className="normal-case tracking-normal text-gray-600">(optional)</span>
              </label>
              <textarea
                id="reviewComment"
                value={reviewComment}
                onChange={(event) => setReviewComment(event.target.value.slice(0, 1000))}
                placeholder="How was the item and the handover?"
                rows={3}
                className="textarea"
              />
            </div>
          </div>
        ) : null}
      </Modal>
    </div>
  )
}
