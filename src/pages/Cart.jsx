import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import {
  ArrowRight,
  ArrowLeft,
  ShieldCheck,
  ShoppingBag,
  Store,
  Trash2,
  MapPin,
} from 'lucide-react'
import { useCart } from '../context/CartContext'
import { useAuth } from '../hooks/useAuth'
import { Alert, EmptyState, Modal, QuantityStepper } from '../components/ui'
import { formatKES, groupBySeller } from '../lib/utils'

export default function Cart() {
  const { items, count, subtotal, setQuantity, removeItem, clearCart } = useCart()
  const { user, isSuspended } = useAuth()
  const navigate = useNavigate()

  const [confirmClear, setConfirmClear] = useState(false)
  const [removing, setRemoving] = useState(null)

  if (items.length === 0) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-16 sm:px-6">
        <EmptyState
          icon={ShoppingBag}
          title="Your cart is empty"
          description="Browse the campus feed and add something you actually need. Your cart is saved on this device."
          action={
            <Link to="/" className="btn-primary">
              <ArrowLeft size={16} />
              Explore the marketplace
            </Link>
          }
        />
      </div>
    )
  }

  const groups = groupBySeller(items)

  const onRemove = (item) => {
    setRemoving(item.id)
    removeItem(item.id)
    setRemoving(null)
  }

  const goToCheckout = () => {
    if (!user) {
      navigate('/login', { state: { from: '/checkout' } })
      return
    }
    navigate('/checkout')
  }

  return (
    <div className="mx-auto max-w-7xl px-4 py-10 sm:px-6 lg:px-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="eyebrow">Your selection</p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight text-white sm:text-4xl">
            Cart
          </h1>
          <p className="mt-1.5 text-sm text-gray-400">
            {count} item{count === 1 ? '' : 's'} from {groups.length} seller
            {groups.length === 1 ? '' : 's'}
          </p>
        </div>
        <button type="button" onClick={() => setConfirmClear(true)} className="btn-ghost btn-sm">
          <Trash2 size={14} />
          Clear cart
        </button>
      </div>

      {isSuspended ? (
        <Alert variant="warning" className="mt-6">
          Your account is suspended. Checkout is disabled until the campus desk restores it.
        </Alert>
      ) : null}

      <div className="mt-8 grid gap-6 lg:grid-cols-[1fr_360px] lg:items-start">
        <div className="space-y-5">
          {groups.map((group) => (
            <div key={group.sellerId} className="glass overflow-hidden rounded-3xl">
              <div className="flex items-center gap-2 border-b border-white/[0.07] px-5 py-3.5">
                <Store size={14} className="text-orange-300" />
                <p className="text-xs font-medium text-gray-300">
                  Sold by{' '}
                  <span className="text-white">{group.sellerName}</span>
                </p>
                <span className="ml-auto text-[10px] uppercase tracking-[0.14em] text-gray-600">
                  {group.items.length} item{group.items.length === 1 ? '' : 's'}
                </span>
              </div>

              <ul className="divide-y divide-white/[0.06]">
                {group.items.map((item) => (
                  <li key={item.id} className="flex gap-4 p-4 sm:p-5">
                    <Link
                      to={`/product/${item.id}`}
                      className="relative h-24 w-24 shrink-0 overflow-hidden rounded-2xl border border-white/[0.08] bg-ink-800 sm:h-28 sm:w-28"
                    >
                      {item.image_url ? (
                        <img
                          src={item.image_url}
                          alt={item.title}
                          loading="lazy"
                          className="h-full w-full object-cover"
                        />
                      ) : (
                        <div className="grid h-full w-full place-items-center text-gray-600">
                          <ShoppingBag size={22} />
                        </div>
                      )}
                    </Link>

                    <div className="flex min-w-0 flex-1 flex-col">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <Link
                            to={`/product/${item.id}`}
                            className="line-clamp-2 text-sm font-semibold leading-snug text-white transition hover:text-orange-100"
                          >
                            {item.title}
                          </Link>
                          <p className="mt-1 text-[10px] uppercase tracking-[0.14em] text-gray-600">
                            {item.category}
                          </p>
                        </div>
                        <button
                          type="button"
                          onClick={() => onRemove(item)}
                          disabled={removing === item.id}
                          className="shrink-0 rounded-full p-1.5 text-gray-500 transition hover:bg-red-500/10 hover:text-red-300"
                          aria-label={`Remove ${item.title} from cart`}
                        >
                          <Trash2 size={15} />
                        </button>
                      </div>

                      <div className="mt-auto flex flex-wrap items-end justify-between gap-3 pt-3">
                        <QuantityStepper
                          value={item.quantity}
                          onChange={(next) => setQuantity(item.id, next)}
                          max={Math.min(99, Math.max(1, Number(item.stock ?? 99)))}
                        />
                        <div className="text-right">
                          <p className="text-sm font-semibold text-white">
                            {formatKES(item.price * item.quantity)}
                          </p>
                          <p className="text-[10px] text-gray-500">
                            {formatKES(item.price)} each
                          </p>
                        </div>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          ))}

          <div className="flex items-start gap-2.5 rounded-2xl border border-white/[0.07] bg-white/[0.02] p-4 text-xs leading-relaxed text-gray-500">
            <MapPin size={15} className="mt-0.5 shrink-0 text-orange-300" />
            M-Hustle does not take online payments. Pay the seller on handover after you have
            inspected the item. Checkout creates a separate order for each seller.
          </div>
        </div>

        {/* -------------------------------------------------------- summary */}
        <aside className="glass sticky top-24 rounded-3xl p-5 sm:p-6">
          <h2 className="text-base font-semibold text-white">Order summary</h2>

          <dl className="mt-5 space-y-3 text-sm">
            <div className="flex items-center justify-between gap-3">
              <dt className="text-gray-400">Subtotal</dt>
              <dd className="font-medium text-white">{formatKES(subtotal)}</dd>
            </div>
            <div className="flex items-center justify-between gap-3">
              <dt className="text-gray-400">Campus handover</dt>
              <dd className="font-medium text-emerald-300">Free</dd>
            </div>
            <div className="flex items-center justify-between gap-3">
              <dt className="text-gray-400">M-Hustle fee</dt>
              <dd className="font-medium text-gray-300">KES 0</dd>
            </div>
          </dl>

          <div className="mt-5 flex items-end justify-between border-t border-white/[0.08] pt-4">
            <span className="text-sm font-medium text-gray-300">Total</span>
            <span className="font-display text-2xl font-semibold text-white">
              {formatKES(subtotal)}
            </span>
          </div>

          <button
            type="button"
            onClick={goToCheckout}
            disabled={isSuspended}
            className="btn-primary mt-5 w-full py-3"
          >
            {user ? 'Proceed to checkout' : 'Sign in to checkout'}
            <ArrowRight size={16} />
          </button>

          <p className="mt-3 text-center text-[10px] leading-relaxed text-gray-500">
            By continuing you agree to inspect items before paying and to communicate through
            M-Hustle.
          </p>

          <div className="mt-5 flex items-center gap-2 rounded-xl border border-emerald-400/15 bg-emerald-400/[0.04] px-3 py-2.5">
            <ShieldCheck size={14} className="text-emerald-400" />
            <p className="text-[10px] leading-relaxed text-emerald-100/70">
              Orders are protected by campus trading rules and visible to both parties.
            </p>
          </div>
        </aside>
      </div>

      <Modal
        open={confirmClear}
        onClose={() => setConfirmClear(false)}
        title="Clear your cart?"
        description="This removes every item from this device. You can add them again from the feed."
        footer={
          <>
            <button type="button" onClick={() => setConfirmClear(false)} className="btn-secondary">
              Keep cart
            </button>
            <button
              type="button"
              onClick={() => {
                clearCart()
                setConfirmClear(false)
              }}
              className="btn-danger"
            >
              <Trash2 size={15} />
              Clear cart
            </button>
          </>
        }
      />
    </div>
  )
}
