import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import {
  BadgeCheck,
  Ban,
  CheckCircle2,
  Clock3,
  ExternalLink,
  LayoutDashboard,
  Package,
  RefreshCw,
  Search,
  ShieldCheck,
  ShoppingBag,
  Store,
  Trash2,
  TrendingUp,
  UserCheck,
  Users,
  Wallet,
  XCircle,
} from 'lucide-react'
import { useAuth } from '../hooks/useAuth'
import { supabase } from '../lib/supabase'
import { PLAN_BY_ID, SUPPORT_EMAIL } from '../lib/constants'
import {
  cn,
  formatDate,
  formatKES,
  friendlyError,
  LISTING_STATUS_META,
  SUBSCRIPTION_STATUS_META,
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
  { id: 'users', label: 'Users', icon: Users },
  { id: 'listings', label: 'Listings', icon: Package },
  { id: 'subscriptions', label: 'Subscriptions', icon: BadgeCheck },
]

const ROLE_STYLES = {
  admin: 'border-purple-400/25 bg-purple-400/10 text-purple-200',
  seller: 'border-emerald-400/25 bg-emerald-400/10 text-emerald-200',
  buyer: 'border-orange-400/25 bg-orange-400/10 text-orange-200',
}

const MONTH_MS = 30 * 24 * 60 * 60 * 1000

export default function AdminDashboard() {
  const { user, profile } = useAuth()
  const [searchParams, setSearchParams] = useSearchParams()

  const [stats, setStats] = useState(null)
  const [users, setUsers] = useState([])
  const [listings, setListings] = useState([])
  const [subscriptions, setSubscriptions] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const [action, setAction] = useState(null)
  const [actionError, setActionError] = useState('')
  const [actionWorking, setActionWorking] = useState(false)

  const tabParam = searchParams.get('tab')
  const tab = TABS.some((item) => item.id === tabParam) ? tabParam : 'overview'

  const changeTab = (nextTab) => {
    const params = new URLSearchParams(searchParams)
    if (nextTab === 'overview') params.delete('tab')
    else params.set('tab', nextTab)
    setSearchParams(params, { replace: true })
    setSuccess('')
  }

  const refreshStats = useCallback(async () => {
    const { data } = await supabase.rpc('admin_stats')
    if (data?.[0]) setStats(data[0])
  }, [])

  const load = useCallback(async () => {
    setLoading(true)
    setError('')

    const [statsResult, usersResult, listingsResult, subscriptionResult] = await Promise.all([
      supabase.rpc('admin_stats'),
      supabase.rpc('admin_list_users'),
      supabase
        .from('listings')
        .select(
          'id, title, price, category, image_url, status, created_at, seller_id, seller:profiles!listings_seller_id_fkey(id, username, full_name, avatar_url, role)',
        )
        .order('created_at', { ascending: false }),
      supabase
        .from('subscriptions')
        .select(
          '*, seller:profiles!subscriptions_seller_id_fkey(id, username, full_name, avatar_url)',
        )
        .order('created_at', { ascending: false }),
    ])

    const loadError =
      statsResult.error ||
      usersResult.error ||
      listingsResult.error ||
      subscriptionResult.error

    if (loadError) {
      setError(loadError.message)
    } else {
      setStats(statsResult.data?.[0] ?? null)
      setUsers(usersResult.data ?? [])
      setListings(listingsResult.data ?? [])
      setSubscriptions(subscriptionResult.data ?? [])
    }

    setLoading(false)
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const pendingSubscriptions = useMemo(
    () => subscriptions.filter((subscription) => subscription.status === 'pending'),
    [subscriptions],
  )

  const openUserAction = (targetUser, type) => {
    setActionError('')
    setAction({
      kind: `user-${type}`,
      user: targetUser,
      title:
        type === 'delete'
          ? 'Delete this account?'
          : type === 'suspend'
            ? 'Suspend this account?'
            : 'Restore this account?',
      description:
        type === 'delete'
          ? 'This permanently removes the auth user and cascades their profile, listings, orders, messages and subscriptions. This cannot be undone.'
          : type === 'suspend'
            ? 'The member keeps their data but cannot create listings, place orders or send messages. They can still sign in and see the suspension notice.'
            : 'The member regains full buying, selling and messaging access immediately.',
      confirm:
        type === 'delete' ? 'Delete permanently' : type === 'suspend' ? 'Suspend' : 'Restore',
      tone: type === 'delete' || type === 'suspend' ? 'danger' : 'primary',
    })
  }

  const openListingAction = (listing, nextStatus) => {
    setActionError('')
    setAction({
      kind: 'listing',
      listing,
      nextStatus,
      title:
        nextStatus === 'deleted'
          ? 'Remove this listing from the marketplace?'
          : 'Restore this listing?',
      description:
        nextStatus === 'deleted'
          ? 'The listing disappears from the public feed and search. Existing order history is preserved because this is a soft delete.'
          : 'The listing will be visible on the public feed again, unless it belongs to a suspended seller.',
      confirm: nextStatus === 'deleted' ? 'Remove listing' : 'Restore listing',
      tone: nextStatus === 'deleted' ? 'danger' : 'primary',
    })
  }

  const openSubscriptionAction = (subscription, decision) => {
    setActionError('')
    setAction({
      kind: 'subscription',
      subscription,
      decision,
      title:
        decision === 'approve'
          ? `Approve ${PLAN_BY_ID[subscription.plan]?.name} for @${subscription.seller?.username ?? 'seller'}?`
          : 'Reject this payment request?',
      description:
        decision === 'approve'
          ? `The seller gets the ${subscription.plan === 'pro_max' ? 'gold' : 'blue'} verified badge and feed priority for 30 days. Confirm the M-Pesa code has been reconciled first.`
          : 'The request is marked expired and no badge is issued. The seller can submit a new code.',
      confirm: decision === 'approve' ? 'Approve payment' : 'Reject request',
      tone: decision === 'approve' ? 'primary' : 'danger',
    })
  }

  const runAction = async () => {
    if (!action) return
    setActionWorking(true)
    setActionError('')

    try {
      if (action.kind === 'user-suspend' || action.kind === 'user-activate') {
        const suspended = action.kind === 'user-suspend'
        const { error: rpcError } = await supabase.rpc('admin_set_suspension', {
          p_user_id: action.user.id,
          p_suspended: suspended,
        })
        if (rpcError) throw rpcError

        setUsers((current) =>
          current.map((row) =>
            row.id === action.user.id ? { ...row, is_suspended: suspended } : row,
          ),
        )
        setSuccess(`${action.user.username} was ${suspended ? 'suspended' : 'restored'}.`)
        await refreshStats()
      }

      if (action.kind === 'user-delete') {
        const { error: rpcError } = await supabase.rpc('admin_delete_user', {
          p_user_id: action.user.id,
        })
        if (rpcError) throw rpcError

        setUsers((current) => current.filter((row) => row.id !== action.user.id))
        setListings((current) => current.filter((row) => row.seller_id !== action.user.id))
        setSubscriptions((current) =>
          current.filter((row) => row.seller_id !== action.user.id),
        )
        setSuccess(`${action.user.username}'s account and marketplace data were deleted.`)
        await refreshStats()
        await load()
      }

      if (action.kind === 'listing') {
        const { error: updateError } = await supabase
          .from('listings')
          .update({ status: action.nextStatus })
          .eq('id', action.listing.id)
        if (updateError) throw updateError

        setListings((current) =>
          current.map((row) =>
            row.id === action.listing.id ? { ...row, status: action.nextStatus } : row,
          ),
        )
        setSuccess(
          action.nextStatus === 'deleted' ? 'Listing removed from the feed.' : 'Listing restored.',
        )
        await refreshStats()
      }

      if (action.kind === 'subscription') {
        const approve = action.decision === 'approve'
        const now = new Date()

        const { error: updateError } = await supabase
          .from('subscriptions')
          .update({
            status: approve ? 'active' : 'expired',
            expires_at: approve ? new Date(now.getTime() + MONTH_MS).toISOString() : now.toISOString(),
            approved_at: now.toISOString(),
          })
          .eq('id', action.subscription.id)
        if (updateError) throw updateError

        const nextStatus = approve ? 'active' : 'expired'
        const nextExpiry = approve
          ? new Date(now.getTime() + MONTH_MS).toISOString()
          : now.toISOString()

        setSubscriptions((current) =>
          current.map((row) =>
            row.id === action.subscription.id
              ? {
                  ...row,
                  status: nextStatus,
                  expires_at: nextExpiry,
                  approved_at: now.toISOString(),
                }
              : row,
          ),
        )
        setSuccess(
          approve
            ? `${PLAN_BY_ID[action.subscription.plan]?.name} badge activated for @${action.subscription.seller?.username}.`
            : 'Payment request rejected.',
        )
        await refreshStats()
      }

      setAction(null)
    } catch (actionFailure) {
      setActionError(friendlyError(actionFailure, 'The action could not be completed.'))
    } finally {
      setActionWorking(false)
    }
  }

  if (loading) {
    return <PageLoader label="Opening the admin console…" />
  }

  const pendingCount = pendingSubscriptions.length
  const activeListingCount = listings.filter((listing) => listing.status === 'active').length

  return (
    <div className="mx-auto max-w-7xl px-4 py-10 sm:px-6 lg:px-8">
      {/* ------------------------------------------------------------ header */}
      <div className="relative overflow-hidden rounded-4xl border border-purple-400/15 bg-[radial-gradient(circle_at_10%_0%,rgba(139,92,246,0.18),transparent_55%),radial-gradient(circle_at_95%_100%,rgba(59,130,246,0.14),transparent_55%)] p-6 sm:p-8">
        <div className="relative flex flex-wrap items-start justify-between gap-6">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-purple-300/80">
              Admin console
            </p>
            <div className="mt-3 flex items-center gap-3">
              <span className="grid h-11 w-11 place-items-center rounded-2xl border border-white/10 bg-white/[0.05] text-purple-200">
                <ShieldCheck size={22} />
              </span>
              <div>
                <h1 className="text-3xl font-semibold tracking-tight text-white sm:text-4xl">
                  Platform control
                </h1>
                <p className="mt-1 text-xs text-gray-400">
                  Signed in as @{profile?.username} · full read and write access
                </p>
              </div>
            </div>
            <p className="mt-3 max-w-2xl text-sm leading-relaxed text-gray-400">
              Moderate listings, verify M-Pesa upgrades, manage accounts and watch the health of
              the Maseno marketplace.
            </p>
          </div>

          <div className="flex flex-wrap gap-2">
            {pendingCount > 0 ? (
              <button
                type="button"
                onClick={() => changeTab('subscriptions')}
                className="btn-secondary btn-sm border-amber-400/25 bg-amber-400/[0.06] text-amber-200"
              >
                <Clock3 size={14} />
                {pendingCount} pending approval{pendingCount === 1 ? '' : 's'}
              </button>
            ) : null}
            <button type="button" onClick={() => void load()} className="btn-secondary btn-sm">
              <RefreshCw size={13} />
              Refresh
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
        <Alert variant="error" className="mt-5" title="Admin data could not load">
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
          const count =
            id === 'users'
              ? users.length
              : id === 'listings'
                ? listings.length
                : id === 'subscriptions'
                  ? pendingCount
                  : 0

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
              <Icon size={15} className={active ? 'text-purple-300' : 'text-gray-500'} />
              {label}
              {count > 0 ? (
                <span
                  className={cn(
                    'rounded-full px-1.5 py-0.5 text-[10px] font-semibold',
                    active ? 'bg-purple-400/15 text-purple-200' : 'bg-white/[0.06] text-gray-500',
                  )}
                >
                  {count}
                </span>
              ) : null}
            </button>
          )
        })}
      </div>

      <div className="mt-6">
        {tab === 'overview' ? (
          <OverviewTab
            stats={stats}
            users={users}
            listings={listings}
            subscriptions={subscriptions}
            pendingSubscriptions={pendingSubscriptions}
            activeListingCount={activeListingCount}
            onTab={changeTab}
          />
        ) : null}

        {tab === 'users' ? (
          <UsersTab
            users={users}
            currentUserId={user?.id}
            onAction={openUserAction}
          />
        ) : null}

        {tab === 'listings' ? (
          <ListingsTab listings={listings} onAction={openListingAction} />
        ) : null}

        {tab === 'subscriptions' ? (
          <SubscriptionsTab
            subscriptions={subscriptions}
            pendingSubscriptions={pendingSubscriptions}
            onAction={openSubscriptionAction}
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
              Cancel
            </button>
            <button
              type="button"
              onClick={runAction}
              disabled={actionWorking}
              className={action?.tone === 'danger' ? 'btn-danger' : 'btn-admin'}
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

        {action?.kind === 'user-delete' ? (
          <div className="rounded-2xl border border-red-500/20 bg-red-500/[0.06] p-4 text-xs leading-relaxed text-red-200">
            Deleting <span className="font-semibold">@{action.user.username}</span> cannot be
            undone. Consider suspending the account instead if you only need to stop activity.
          </div>
        ) : null}

        {action?.kind === 'subscription' ? (
          <div className="rounded-2xl border border-white/10 bg-black/20 p-4 text-xs">
            <div className="flex items-center justify-between gap-3">
              <span className="flex items-center gap-2 text-white">
                <VerifiedBadge plan={action.subscription.plan} size={16} />
                {PLAN_BY_ID[action.subscription.plan]?.name}
              </span>
              <span className="text-gray-400">{formatKES(action.subscription.amount)}</span>
            </div>
            <p className="mt-2 font-mono text-[11px] text-gray-500">
              Code {action.subscription.mpesa_code} · requested{' '}
              {formatDate(action.subscription.created_at)}
            </p>
          </div>
        ) : null}

        {action?.kind === 'listing' ? (
          <div className="rounded-2xl border border-white/10 bg-black/20 p-4 text-xs">
            <p className="text-sm font-medium text-white">{action.listing.title}</p>
            <p className="mt-1 text-gray-500">
              {formatKES(action.listing.price)} · @{action.listing.seller?.username} ·{' '}
              {LISTING_STATUS_META[action.listing.status]?.label}
            </p>
          </div>
        ) : null}
      </Modal>
    </div>
  )
}

/* ========================================================================== */
/* OVERVIEW                                                                   */
/* ========================================================================== */
function OverviewTab({
  stats,
  users,
  listings,
  subscriptions,
  pendingSubscriptions,
  activeListingCount,
  onTab,
}) {
  const recentUsers = users.slice(0, 5)
  const recentListings = listings.slice(0, 5)

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          icon={Wallet}
          label="Gross sales"
          value={formatKES(stats?.total_revenue ?? 0)}
          hint="Delivered and completed orders"
          accent="green"
        />
        <StatCard
          icon={ShoppingBag}
          label="Total orders"
          value={Number(stats?.total_orders ?? 0).toLocaleString('en-KE')}
          hint="All statuses, all time"
          accent="orange"
        />
        <StatCard
          icon={Users}
          label="Active users"
          value={Number(stats?.active_users ?? 0).toLocaleString('en-KE')}
          hint="Members not suspended"
          accent="purple"
        />
        <StatCard
          icon={Store}
          label="Active listings"
          value={Number(stats?.active_listings ?? activeListingCount).toLocaleString('en-KE')}
          hint={`${listings.filter((listing) => listing.status === 'sold').length} sold all-time`}
          accent="amber"
        />
      </div>

      <div className="grid gap-5 lg:grid-cols-[1.3fr_1fr]">
        <section className="glass overflow-hidden rounded-3xl">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/[0.07] px-5 py-4">
            <div>
              <h2 className="text-sm font-semibold text-white">Subscription approvals</h2>
              <p className="mt-0.5 text-[11px] text-gray-500">
                {pendingSubscriptions.length} request
                {pendingSubscriptions.length === 1 ? '' : 's'} waiting for review
              </p>
            </div>
            <button
              type="button"
              onClick={() => onTab('subscriptions')}
              className="text-[11px] font-medium text-purple-300 transition hover:text-purple-200"
            >
              Open queue
            </button>
          </div>

          {pendingSubscriptions.length === 0 ? (
            <div className="px-5 py-10 text-center">
              <CheckCircle2 size={22} className="mx-auto text-emerald-400" />
              <p className="mt-3 text-sm text-gray-300">No pending payments</p>
              <p className="mt-1 text-xs text-gray-600">
                Every M-Pesa code has been reviewed.
              </p>
            </div>
          ) : (
            <ul className="divide-y divide-white/[0.06]">
              {pendingSubscriptions.slice(0, 5).map((subscription) => (
                <li key={subscription.id} className="flex items-center gap-3 px-5 py-3.5">
                  <Avatar profile={subscription.seller} size={32} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-xs font-medium text-white">
                      {subscription.seller?.full_name || 'Seller'}
                    </p>
                    <p className="mt-0.5 text-[11px] text-gray-500">
                      {PLAN_BY_ID[subscription.plan]?.name} · {formatKES(subscription.amount)} ·{' '}
                      {formatDate(subscription.created_at)}
                    </p>
                  </div>
                  <span className="rounded-full border border-amber-400/20 bg-amber-400/10 px-2 py-1 text-[10px] font-medium text-amber-200">
                    Pending
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="glass rounded-3xl p-5">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-white">Platform snapshot</h2>
            <TrendingUp size={16} className="text-purple-300" />
          </div>

          <dl className="mt-4 space-y-3 text-xs">
            <div className="flex items-center justify-between gap-3">
              <dt className="text-gray-500">Pending subscriptions</dt>
              <dd className="font-semibold text-amber-300">
                {Number(stats?.pending_subscriptions ?? pendingSubscriptions.length)}
              </dd>
            </div>
            <div className="flex items-center justify-between gap-3">
              <dt className="text-gray-500">Suspended accounts</dt>
              <dd className="font-semibold text-white">
                {users.filter((row) => row.is_suspended).length}
              </dd>
            </div>
            <div className="flex items-center justify-between gap-3">
              <dt className="text-gray-500">Sellers</dt>
              <dd className="font-semibold text-white">
                {users.filter((row) => row.role === 'seller').length}
              </dd>
            </div>
            <div className="flex items-center justify-between gap-3">
              <dt className="text-gray-500">Paid subscriptions</dt>
              <dd className="font-semibold text-white">
                {subscriptions.filter((row) => row.status === 'active').length}
              </dd>
            </div>
            <div className="flex items-center justify-between gap-3">
              <dt className="text-gray-500">Removed listings</dt>
              <dd className="font-semibold text-white">
                {listings.filter((row) => row.status === 'deleted').length}
              </dd>
            </div>
          </dl>

          <div className="mt-5 grid gap-2">
            <button
              type="button"
              onClick={() => onTab('users')}
              className="flex items-center gap-2 rounded-xl border border-white/[0.07] bg-white/[0.02] px-3 py-2.5 text-left text-xs text-gray-300 transition hover:border-white/15 hover:text-white"
            >
              <Users size={14} className="text-purple-300" />
              Manage accounts
              <ExternalLink size={12} className="ml-auto text-gray-600" />
            </button>
            <button
              type="button"
              onClick={() => onTab('listings')}
              className="flex items-center gap-2 rounded-xl border border-white/[0.07] bg-white/[0.02] px-3 py-2.5 text-left text-xs text-gray-300 transition hover:border-white/15 hover:text-white"
            >
              <Package size={14} className="text-orange-300" />
              Moderate listings
              <ExternalLink size={12} className="ml-auto text-gray-600" />
            </button>
          </div>
        </section>
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <section className="glass overflow-hidden rounded-3xl">
          <div className="flex items-center justify-between border-b border-white/[0.07] px-5 py-3.5">
            <h2 className="text-sm font-semibold text-white">Newest members</h2>
            <button
              type="button"
              onClick={() => onTab('users')}
              className="text-[11px] text-purple-300 hover:text-purple-200"
            >
              All users
            </button>
          </div>
          <ul className="divide-y divide-white/[0.06]">
            {recentUsers.map((member) => (
              <li key={member.id} className="flex items-center gap-3 px-5 py-3">
                <Avatar profile={member} size={30} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-xs font-medium text-white">
                    {member.full_name}
                    {member.is_suspended ? (
                      <span className="ml-1.5 text-[10px] text-red-300">suspended</span>
                    ) : null}
                  </p>
                  <p className="truncate text-[11px] text-gray-500">@{member.username}</p>
                </div>
                <span className={cn('badge', ROLE_STYLES[member.role])}>{member.role}</span>
              </li>
            ))}
          </ul>
        </section>

        <section className="glass overflow-hidden rounded-3xl">
          <div className="flex items-center justify-between border-b border-white/[0.07] px-5 py-3.5">
            <h2 className="text-sm font-semibold text-white">Latest listings</h2>
            <button
              type="button"
              onClick={() => onTab('listings')}
              className="text-[11px] text-purple-300 hover:text-purple-200"
            >
              Moderate
            </button>
          </div>
          <ul className="divide-y divide-white/[0.06]">
            {recentListings.map((listing) => (
              <li key={listing.id} className="flex items-center gap-3 px-5 py-3">
                <div className="h-9 w-9 shrink-0 overflow-hidden rounded-lg border border-white/[0.08] bg-ink-800">
                  {listing.image_url ? (
                    <img
                      src={listing.image_url}
                      alt=""
                      className="h-full w-full object-cover"
                      loading="lazy"
                    />
                  ) : (
                    <div className="grid h-full w-full place-items-center text-gray-600">
                      <Package size={14} />
                    </div>
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-xs font-medium text-white">{listing.title}</p>
                  <p className="truncate text-[11px] text-gray-500">
                    @{listing.seller?.username} · {formatKES(listing.price)}
                  </p>
                </div>
                <StatusPill meta={LISTING_STATUS_META[listing.status]} />
              </li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  )
}

/* ========================================================================== */
/* USERS                                                                      */
/* ========================================================================== */
function UsersTab({ users, currentUserId, onAction }) {
  const [query, setQuery] = useState('')
  const [role, setRole] = useState('all')

  const visible = useMemo(() => {
    const term = query.trim().toLowerCase()
    return users.filter((member) => {
      const matchesRole = role === 'all' || member.role === role
      const matchesQuery =
        !term ||
        member.full_name?.toLowerCase().includes(term) ||
        member.username?.toLowerCase().includes(term) ||
        member.email?.toLowerCase().includes(term) ||
        member.phone?.toLowerCase().includes(term)
      return matchesRole && matchesQuery
    })
  }, [users, query, role])

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold text-white">Users</h2>
          <p className="mt-1 text-sm text-gray-500">
            {users.length} accounts · {users.filter((row) => row.is_suspended).length} suspended
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          <div className="relative">
            <Search
              size={14}
              className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-gray-500"
            />
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search name, email, phone…"
              className="input h-10 w-64 py-2 pl-9 text-xs"
            />
          </div>
          <select
            value={role}
            onChange={(event) => setRole(event.target.value)}
            className="select h-10 w-32 py-2 text-xs"
            aria-label="Filter by role"
          >
            <option value="all">All roles</option>
            <option value="admin">Admin</option>
            <option value="seller">Seller</option>
            <option value="buyer">Buyer</option>
          </select>
        </div>
      </div>

      <div className="mt-3 flex items-start gap-2.5 rounded-2xl border border-white/[0.07] bg-white/[0.02] p-4 text-[11px] leading-relaxed text-gray-500">
        <ShieldCheck size={15} className="mt-0.5 shrink-0 text-purple-300" />
        Suspension blocks new listings, purchases and messages without deleting data. Deleting an
        account removes the auth user and cascades all marketplace records — use it only for
        serious violations.
      </div>

      <div className="glass mt-5 overflow-x-auto rounded-2xl">
        {visible.length === 0 ? (
          <EmptyState
            icon={Users}
            title="No matching members"
            description="Adjust the search or role filter to find the account you need."
            className="border-0 bg-transparent"
          />
        ) : (
          <table className="w-full min-w-[860px] text-left text-xs">
            <thead className="border-b border-white/[0.07] text-[10px] uppercase tracking-[0.14em] text-gray-600">
              <tr>
                <th className="px-4 py-3 font-medium">Member</th>
                <th className="px-4 py-3 font-medium">Role</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 font-medium">Joined</th>
                <th className="px-4 py-3 font-medium">Last sign-in</th>
                <th className="px-4 py-3 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/[0.06]">
              {visible.map((member) => {
                const isSelf = member.id === currentUserId
                return (
                  <tr key={member.id} className="transition hover:bg-white/[0.02]">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-3">
                        <Avatar profile={member} size={34} />
                        <div className="min-w-0">
                          <p className="flex items-center gap-1.5 text-xs font-medium text-white">
                            <span className="truncate">{member.full_name}</span>
                            {isSelf ? (
                              <span className="rounded-full bg-white/[0.06] px-1.5 py-0.5 text-[9px] text-gray-400">
                                You
                              </span>
                            ) : null}
                          </p>
                          <p className="truncate text-[11px] text-gray-500">
                            @{member.username} · {member.email}
                          </p>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <span className={cn('badge capitalize', ROLE_STYLES[member.role])}>
                        {member.role}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      {member.is_suspended ? (
                        <span className="badge border-red-400/25 bg-red-400/10 text-red-300">
                          <Ban size={11} />
                          Suspended
                        </span>
                      ) : (
                        <span className="badge border-emerald-400/25 bg-emerald-400/10 text-emerald-300">
                          <UserCheck size={11} />
                          Active
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-gray-500">{formatDate(member.created_at)}</td>
                    <td className="px-4 py-3 text-gray-500">
                      {member.last_sign_in_at ? formatDate(member.last_sign_in_at) : 'Never'}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex justify-end gap-1.5">
                        {!isSelf ? (
                          <>
                            <button
                              type="button"
                              onClick={() =>
                                onAction(
                                  member,
                                  member.is_suspended ? 'activate' : 'suspend',
                                )
                              }
                              className="btn-secondary btn-sm"
                            >
                              {member.is_suspended ? (
                                <>
                                  <UserCheck size={12} />
                                  Restore
                                </>
                              ) : (
                                <>
                                  <Ban size={12} />
                                  Suspend
                                </>
                              )}
                            </button>
                            <button
                              type="button"
                              onClick={() => onAction(member, 'delete')}
                              className="grid h-8 w-8 place-items-center rounded-full border border-red-500/20 bg-red-500/[0.06] text-red-300 transition hover:border-red-500/40 hover:bg-red-500/15"
                              aria-label={`Delete ${member.username}`}
                            >
                              <Trash2 size={13} />
                            </button>
                          </>
                        ) : (
                          <span className="text-[10px] text-gray-600">Protected</span>
                        )}
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}

/* ========================================================================== */
/* LISTINGS                                                                   */
/* ========================================================================== */
function ListingsTab({ listings, onAction }) {
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState('all')

  const visible = useMemo(() => {
    const term = query.trim().toLowerCase()
    return listings.filter((listing) => {
      const matchesStatus = status === 'all' || listing.status === status
      const matchesQuery =
        !term ||
        listing.title?.toLowerCase().includes(term) ||
        listing.category?.toLowerCase().includes(term) ||
        listing.seller?.username?.toLowerCase().includes(term) ||
        listing.seller?.full_name?.toLowerCase().includes(term)
      return matchesStatus && matchesQuery
    })
  }, [listings, query, status])

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold text-white">Listings</h2>
          <p className="mt-1 text-sm text-gray-500">
            {listings.filter((listing) => listing.status === 'active').length} active ·{' '}
            {listings.filter((listing) => listing.status === 'deleted').length} removed
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          <div className="relative">
            <Search
              size={14}
              className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-gray-500"
            />
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search listings or sellers…"
              className="input h-10 w-64 py-2 pl-9 text-xs"
            />
          </div>
          <select
            value={status}
            onChange={(event) => setStatus(event.target.value)}
            className="select h-10 w-32 py-2 text-xs"
            aria-label="Filter by listing status"
          >
            <option value="all">All statuses</option>
            <option value="active">Active</option>
            <option value="sold">Sold</option>
            <option value="deleted">Removed</option>
          </select>
        </div>
      </div>

      <div className="glass mt-5 overflow-x-auto rounded-2xl">
        {visible.length === 0 ? (
          <EmptyState
            icon={Package}
            title="No listings match"
            description="Try another search or status filter."
            className="border-0 bg-transparent"
          />
        ) : (
          <table className="w-full min-w-[880px] text-left text-xs">
            <thead className="border-b border-white/[0.07] text-[10px] uppercase tracking-[0.14em] text-gray-600">
              <tr>
                <th className="px-4 py-3 font-medium">Listing</th>
                <th className="px-4 py-3 font-medium">Seller</th>
                <th className="px-4 py-3 font-medium">Category</th>
                <th className="px-4 py-3 font-medium">Price</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 font-medium">Listed</th>
                <th className="px-4 py-3 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/[0.06]">
              {visible.map((listing) => (
                <tr key={listing.id} className="transition hover:bg-white/[0.02]">
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-3">
                      <div className="h-10 w-10 shrink-0 overflow-hidden rounded-lg border border-white/[0.08] bg-ink-800">
                        {listing.image_url ? (
                          <img
                            src={listing.image_url}
                            alt=""
                            className="h-full w-full object-cover"
                            loading="lazy"
                          />
                        ) : (
                          <div className="grid h-full w-full place-items-center text-gray-600">
                            <Package size={14} />
                          </div>
                        )}
                      </div>
                      <Link
                        to={`/product/${listing.id}`}
                        className="max-w-[220px] truncate text-xs font-medium text-white transition hover:text-purple-200"
                      >
                        {listing.title}
                      </Link>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-gray-400">
                    @{listing.seller?.username ?? 'unknown'}
                  </td>
                  <td className="px-4 py-3 text-gray-500">{listing.category}</td>
                  <td className="px-4 py-3 font-medium text-white">
                    {formatKES(listing.price)}
                  </td>
                  <td className="px-4 py-3">
                    <StatusPill meta={LISTING_STATUS_META[listing.status]} />
                  </td>
                  <td className="px-4 py-3 text-gray-500">{formatDate(listing.created_at)}</td>
                  <td className="px-4 py-3">
                    <div className="flex justify-end gap-1.5">
                      <Link to={`/product/${listing.id}`} className="btn-ghost btn-sm">
                        View
                      </Link>
                      {listing.status !== 'deleted' ? (
                        <button
                          type="button"
                          onClick={() => onAction(listing, 'deleted')}
                          className="btn-danger btn-sm"
                        >
                          <Trash2 size={12} />
                          Remove
                        </button>
                      ) : (
                        <button
                          type="button"
                          onClick={() => onAction(listing, 'active')}
                          className="btn-secondary btn-sm"
                        >
                          <RefreshCw size={12} />
                          Restore
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}

/* ========================================================================== */
/* SUBSCRIPTIONS                                                              */
/* ========================================================================== */
function SubscriptionsTab({ subscriptions, pendingSubscriptions, onAction }) {
  const [historyFilter, setHistoryFilter] = useState('all')

  const history =
    historyFilter === 'all'
      ? subscriptions
      : subscriptions.filter((subscription) => subscription.status === historyFilter)

  return (
    <div className="space-y-6">
      <div>
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="text-xl font-semibold text-white">Approval queue</h2>
            <p className="mt-1 text-sm text-gray-500">
              Confirm each M-Pesa code against your statement before approving.
            </p>
          </div>
          <span className="badge border-amber-400/25 bg-amber-400/10 text-amber-200">
            <Clock3 size={12} />
            {pendingSubscriptions.length} pending
          </span>
        </div>

        {pendingSubscriptions.length === 0 ? (
          <div className="mt-4 flex items-center gap-3 rounded-3xl border border-emerald-400/15 bg-emerald-400/[0.04] p-5">
            <span className="grid h-10 w-10 place-items-center rounded-xl border border-emerald-400/20 bg-emerald-400/10 text-emerald-300">
              <CheckCircle2 size={18} />
            </span>
            <div>
              <p className="text-sm font-medium text-white">The queue is clear</p>
              <p className="mt-0.5 text-xs text-gray-500">
                New Pro and Pro Max payments will appear here instantly.
              </p>
            </div>
          </div>
        ) : (
          <div className="mt-4 grid gap-3">
            {pendingSubscriptions.map((subscription) => {
              const plan = PLAN_BY_ID[subscription.plan]
              return (
                <div
                  key={subscription.id}
                  className="glass flex flex-col gap-4 rounded-3xl p-5 lg:flex-row lg:items-center"
                >
                  <div className="flex items-center gap-3 lg:w-64">
                    <Avatar profile={subscription.seller} size={40} />
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-white">
                        {subscription.seller?.full_name || 'Seller'}
                      </p>
                      <p className="truncate text-[11px] text-gray-500">
                        @{subscription.seller?.username} · requested{' '}
                        {formatDate(subscription.created_at)}
                      </p>
                    </div>
                  </div>

                  <div className="flex flex-1 flex-wrap items-center gap-3">
                    <span
                      className={cn(
                        'inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-semibold',
                        subscription.plan === 'pro_max'
                          ? 'border-amber-400/25 bg-amber-400/10 text-amber-200'
                          : 'border-blue-400/25 bg-blue-400/10 text-blue-200',
                      )}
                    >
                      <VerifiedBadge plan={subscription.plan} size={15} />
                      {plan?.name}
                    </span>
                    <div>
                      <p className="text-[10px] uppercase tracking-[0.12em] text-gray-600">
                        Amount
                      </p>
                      <p className="text-sm font-semibold text-white">
                        {formatKES(subscription.amount)}
                      </p>
                    </div>
                    <div>
                      <p className="text-[10px] uppercase tracking-[0.12em] text-gray-600">
                        M-Pesa code
                      </p>
                      <p className="font-mono text-sm text-gray-200">
                        {subscription.mpesa_code}
                      </p>
                    </div>
                  </div>

                  <div className="flex flex-wrap gap-2 lg:justify-end">
                    <button
                      type="button"
                      onClick={() => onAction(subscription, 'reject')}
                      className="btn-danger btn-sm"
                    >
                      <XCircle size={13} />
                      Reject
                    </button>
                    <button
                      type="button"
                      onClick={() => onAction(subscription, 'approve')}
                      className="btn-admin btn-sm"
                    >
                      <CheckCircle2 size={13} />
                      Approve
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      <section>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-sm font-semibold text-white">All payment requests</h2>
          <select
            value={historyFilter}
            onChange={(event) => setHistoryFilter(event.target.value)}
            className="select h-9 w-40 py-1.5 text-xs"
            aria-label="Filter subscriptions by status"
          >
            <option value="all">All statuses</option>
            <option value="pending">Pending</option>
            <option value="active">Active</option>
            <option value="expired">Expired</option>
          </select>
        </div>

        <div className="glass mt-3 overflow-x-auto rounded-2xl">
          {history.length === 0 ? (
            <EmptyState
              icon={BadgeCheck}
              title="No payment requests"
              description="When a seller submits an M-Pesa code it will appear here."
              className="border-0 bg-transparent"
            />
          ) : (
            <table className="w-full min-w-[820px] text-left text-xs">
              <thead className="border-b border-white/[0.07] text-[10px] uppercase tracking-[0.14em] text-gray-600">
                <tr>
                  <th className="px-4 py-3 font-medium">Seller</th>
                  <th className="px-4 py-3 font-medium">Plan</th>
                  <th className="px-4 py-3 font-medium">Amount</th>
                  <th className="px-4 py-3 font-medium">M-Pesa code</th>
                  <th className="px-4 py-3 font-medium">Requested</th>
                  <th className="px-4 py-3 font-medium">Expires</th>
                  <th className="px-4 py-3 font-medium">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/[0.06]">
                {history.map((subscription) => (
                  <tr key={subscription.id} className="transition hover:bg-white/[0.02]">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2.5">
                        <Avatar profile={subscription.seller} size={26} />
                        <span className="text-gray-300">
                          @{subscription.seller?.username ?? 'unknown'}
                        </span>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <span className="inline-flex items-center gap-1.5 text-white">
                        <VerifiedBadge plan={subscription.plan} size={13} />
                        {PLAN_BY_ID[subscription.plan]?.name}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-gray-300">
                      {formatKES(subscription.amount)}
                    </td>
                    <td className="px-4 py-3 font-mono text-gray-500">
                      {subscription.mpesa_code}
                    </td>
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
          )}
        </div>
      </section>

      <div className="flex items-start gap-2.5 rounded-2xl border border-white/[0.07] bg-white/[0.02] p-4 text-[11px] leading-relaxed text-gray-500">
        <ShieldCheck size={15} className="mt-0.5 shrink-0 text-purple-300" />
        Badges are issued for 30 days from approval. Expired subscriptions stop granting feed
        priority immediately. Questions about reconciliation? {SUPPORT_EMAIL}
      </div>
    </div>
  )
}
