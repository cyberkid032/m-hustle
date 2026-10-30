import { useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import {
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  MapPin,
  Phone,
  ShieldCheck,
  ShoppingBag,
  Store,
  Truck,
} from 'lucide-react'
import { useCart } from '../context/CartContext'
import { useAuth } from '../hooks/useAuth'
import { Alert, EmptyState, Spinner } from '../components/ui'
import { supabase } from '../lib/supabase'
import { formatKES, friendlyError, groupBySeller } from '../lib/utils'

export default function Checkout() {
  const { items, subtotal, removeItem, clearCart } = useCart()
  const { profile, isSuspended } = useAuth()
  const navigate = useNavigate()

  const [location, setLocation] = useState('')
  const [phone, setPhone] = useState(profile?.phone ?? '')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const groups = useMemo(() => groupBySeller(items), [items])
  const orderCount = groups.length

  if (items.length === 0) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-16 sm:px-6">
        <EmptyState
          icon={ShoppingBag}
          title="Nothing to check out"
          description="Your cart is empty. Add a listing from the feed, then come back to place the order."
          action={
            <Link to="/" className="btn-primary">
              <ArrowLeft size={16} />
              Browse the marketplace
            </Link>
          }
        />
      </div>
    )
  }

  const onPlaceOrder = async (event) => {
    event.preventDefault()
    setError('')

    const cleanPhone = phone.replace(/\s+/g, '').trim()
    const cleanLocation = location.trim()

    if (cleanLocation.length < 3) {
      setError('Tell the seller where to meet you — hostel, room or a campus pickup point.')
      return
    }
    if (!/^\+?[0-9]{9,15}$/.test(cleanPhone)) {
      setError('Enter a reachable phone number, for example 0712 345 678.')
      return
    }
    if (isSuspended) {
      setError('Your account is suspended. Checkout is disabled.')
      return
    }

    setSubmitting(true)

    const succeeded = []
    const failures = []

    for (const group of groups) {
      const { error: rpcError } = await supabase.rpc('create_order', {
        p_seller_id: group.sellerId,
        p_items: group.items.map((item) => ({
          listing_id: item.id,
          quantity: item.quantity,
        })),
        p_delivery_location: cleanLocation,
        p_contact_phone: cleanPhone,
      })

      if (rpcError) {
        failures.push({ seller: group.sellerName, message: friendlyError(rpcError) })
      } else {
        succeeded.push(group)
      }
    }

    if (failures.length === 0) {
      clearCart()
      navigate(`/orders?success=${groups.length}`, { replace: true })
      return
    }

    for (const group of succeeded) {
      for (const item of group.items) removeItem(item.id)
    }

    setSubmitting(false)

    if (succeeded.length > 0) {
      setError(
        `${succeeded.length} of ${groups.length} orders were placed and removed from your cart. ` +
          `${failures[0].seller}: ${failures[0].message} Review the remaining items and try again.`,
      )
      return
    }

    setError(failures[0].message)
  }

  return (
    <div className="mx-auto max-w-7xl px-4 py-10 sm:px-6 lg:px-8">
      <Link to="/cart" className="inline-flex items-center gap-1.5 text-xs text-gray-400 transition hover:text-white">
        <ArrowLeft size={14} />
        Back to cart
      </Link>

      <div className="mt-5">
        <p className="eyebrow">Final step</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight text-white sm:text-4xl">
          Checkout
        </h1>
        <p className="mt-1.5 max-w-xl text-sm leading-relaxed text-gray-400">
          Confirm where and how to meet. M-Hustle creates one order per seller, and each seller
          sees your handover details.
        </p>
      </div>

      <form onSubmit={onPlaceOrder} className="mt-8 grid gap-6 lg:grid-cols-[1fr_380px] lg:items-start">
        <div className="space-y-5">
          {error ? <Alert variant="error">{error}</Alert> : null}

          <section className="glass rounded-3xl p-5 sm:p-6">
            <div className="flex items-center gap-2">
              <MapPin size={16} className="text-orange-300" />
              <h2 className="text-sm font-semibold text-white">Handover details</h2>
            </div>

            <div className="mt-5 grid gap-4 sm:grid-cols-2">
              <div className="sm:col-span-2">
                <label htmlFor="location" className="label">
                  Where should you meet?
                </label>
                <div className="relative">
                  <MapPin
                    size={16}
                    className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-gray-500"
                  />
                  <input
                    id="location"
                    type="text"
                    value={location}
                    onChange={(event) => setLocation(event.target.value)}
                    placeholder="e.g. Library steps, Hostel B reception"
                    className="input pl-11"
                    maxLength={160}
                    required
                  />
                </div>
                <p className="field-hint">
                  Choose a busy, public campus spot. The seller receives this with the order.
                </p>
              </div>

              <div>
                <label htmlFor="phone" className="label">
                  Phone number
                </label>
                <div className="relative">
                  <Phone
                    size={16}
                    className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-gray-500"
                  />
                  <input
                    id="phone"
                    type="tel"
                    value={phone}
                    onChange={(event) => setPhone(event.target.value)}
                    placeholder="0712 345 678"
                    className="input pl-11"
                    autoComplete="tel"
                    required
                  />
                </div>
              </div>

              <div>
                <span className="label">Buyer</span>
                <div className="rounded-2xl border border-white/10 bg-black/20 px-4 py-3 text-sm text-gray-300">
                  {profile?.full_name}
                  <span className="block text-[11px] text-gray-500">@{profile?.username}</span>
                </div>
              </div>
            </div>
          </section>

          <section className="space-y-4">
            {groups.map((group) => {
              const groupTotal = group.items.reduce(
                (sum, item) => sum + Number(item.price) * item.quantity,
                0,
              )

              return (
                <div key={group.sellerId} className="glass overflow-hidden rounded-3xl">
                  <div className="flex items-center gap-2 border-b border-white/[0.07] px-5 py-3.5">
                    <Store size={14} className="text-orange-300" />
                    <p className="text-xs text-gray-400">
                      Order from <span className="font-medium text-white">{group.sellerName}</span>
                    </p>
                    <span className="ml-auto text-xs font-semibold text-white">
                      {formatKES(groupTotal)}
                    </span>
                  </div>

                  <ul className="divide-y divide-white/[0.06]">
                    {group.items.map((item) => (
                      <li key={item.id} className="flex items-center gap-3.5 px-4 py-3.5 sm:px-5">
                        <div className="h-14 w-14 shrink-0 overflow-hidden rounded-xl border border-white/[0.08] bg-ink-800">
                          {item.image_url ? (
                            <img
                              src={item.image_url}
                              alt={item.title}
                              className="h-full w-full object-cover"
                              loading="lazy"
                            />
                          ) : (
                            <div className="grid h-full w-full place-items-center text-gray-600">
                              <ShoppingBag size={18} />
                            </div>
                          )}
                        </div>
                        <div className="min-w-0 flex-1">
                          <p className="line-clamp-1 text-sm font-medium text-white">{item.title}</p>
                          <p className="mt-0.5 text-[11px] text-gray-500">
                            Qty {item.quantity} · {formatKES(item.price)} each
                          </p>
                        </div>
                        <p className="shrink-0 text-sm font-medium text-white">
                          {formatKES(item.price * item.quantity)}
                        </p>
                      </li>
                    ))}
                  </ul>
                </div>
              )
            })}
          </section>

          <section className="glass rounded-3xl p-5 sm:p-6">
            <div className="flex items-center gap-2">
              <Truck size={16} className="text-orange-300" />
              <h2 className="text-sm font-semibold text-white">Payment</h2>
            </div>

            <div className="mt-4 flex items-start gap-3 rounded-2xl border border-emerald-400/20 bg-emerald-400/[0.05] p-4">
              <CheckCircle2 size={17} className="mt-0.5 shrink-0 text-emerald-400" />
              <div>
                <p className="text-sm font-medium text-white">Pay on handover</p>
                <p className="mt-1 text-xs leading-relaxed text-gray-400">
                  Inspect the item, then pay the seller directly in cash or M-Pesa. M-Hustle
                  never collects the item price.
                </p>
              </div>
            </div>
          </section>
        </div>

        {/* ------------------------------------------------------- summary */}
        <aside className="glass sticky top-24 rounded-3xl p-5 sm:p-6">
          <h2 className="text-base font-semibold text-white">Order summary</h2>
          <p className="mt-1 text-xs text-gray-500">
            {items.length} item{items.length === 1 ? '' : 's'} · {orderCount} order
            {orderCount === 1 ? '' : 's'}
          </p>

          <div className="mt-5 space-y-3 border-y border-white/[0.07] py-4 text-sm">
            <div className="flex justify-between gap-3">
              <span className="text-gray-400">Subtotal</span>
              <span className="font-medium text-white">{formatKES(subtotal)}</span>
            </div>
            <div className="flex justify-between gap-3">
              <span className="text-gray-400">Handover</span>
              <span className="font-medium text-emerald-300">Free</span>
            </div>
            <div className="flex justify-between gap-3">
              <span className="text-gray-400">Platform fee</span>
              <span className="font-medium text-gray-300">KES 0</span>
            </div>
          </div>

          <div className="mt-4 flex items-end justify-between">
            <span className="text-sm text-gray-300">Total due</span>
            <span className="font-display text-2xl font-semibold text-white">
              {formatKES(subtotal)}
            </span>
          </div>

          <button type="submit" disabled={submitting} className="btn-primary mt-5 w-full py-3">
            {submitting ? (
              <>
                <Spinner size={16} />
                Placing {orderCount === 1 ? 'order' : 'orders'}…
              </>
            ) : (
              <>
                Place {orderCount === 1 ? 'order' : `${orderCount} orders`}
                <ArrowRight size={16} />
              </>
            )}
          </button>

          <p className="mt-3 text-center text-[10px] leading-relaxed text-gray-500">
            This notifies each seller with your phone number and meeting point. Do not close
            this page while orders are being created.
          </p>

          <div className="mt-5 flex items-center gap-2 rounded-xl border border-white/10 bg-white/[0.02] px-3 py-2.5">
            <ShieldCheck size={14} className="text-emerald-400" />
            <p className="text-[10px] leading-relaxed text-gray-500">
              You can cancel a pending order and confirm receipt after delivery.
            </p>
          </div>
        </aside>
      </form>
    </div>
  )
}
