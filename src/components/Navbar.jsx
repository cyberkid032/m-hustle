import { useEffect, useRef, useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import {
  ChevronDown,
  LayoutDashboard,
  LogOut,
  Menu,
  MessageSquare,
  Package,
  Search,
  ShoppingBag,
  Store,
  UserRound,
  X,
} from 'lucide-react'
import { useAuth } from '../hooks/useAuth'
import { useCart } from '../context/CartContext'
import { supabase } from '../lib/supabase'
import { cn } from '../lib/utils'
import { Avatar } from './ui'

export function Brand({ compact = false }) {
  return (
    <Link to="/" className="group flex items-center gap-2.5" aria-label="M-Hustle home">
      <span className="relative grid h-10 w-10 place-items-center overflow-hidden rounded-2xl bg-gradient-to-br from-orange-500 to-pink-500 shadow-[0_10px_30px_-12px_rgba(236,72,153,0.9)] transition group-hover:brightness-110">
        <span className="absolute inset-0 bg-[radial-gradient(circle_at_30%_20%,rgba(255,255,255,0.35),transparent_55%)]" />
        <span className="relative font-display text-lg font-extrabold text-white">M</span>
      </span>
      {!compact ? (
        <span className="leading-none">
          <span className="block font-display text-[17px] font-bold tracking-tight text-white">
            M-Hustle
          </span>
          <span className="mt-1 hidden text-[9px] font-medium uppercase tracking-[0.24em] text-gray-500 sm:block">
            Maseno Marketplace
          </span>
        </span>
      ) : null}
    </Link>
  )
}

const NAV_LINKS = [
  { to: '/', label: 'Marketplace', icon: Store },
  { to: '/orders', label: 'Orders', icon: Package, auth: true },
  { to: '/messages', label: 'Messages', icon: MessageSquare, auth: true },
]

export default function Navbar() {
  const { user, profile, signOut, isAdmin, isSeller } = useAuth()
  const { count } = useCart()
  const location = useLocation()
  const navigate = useNavigate()

  const [search, setSearch] = useState('')
  const [menuOpen, setMenuOpen] = useState(false)
  const [mobileOpen, setMobileOpen] = useState(false)
  const [unread, setUnread] = useState(0)
  const menuRef = useRef(null)

  const username = profile?.username
  const role = profile?.role

  useEffect(() => {
    const params = new URLSearchParams(location.search)
    setSearch(params.get('q') ?? '')
    setMobileOpen(false)
    setMenuOpen(false)
  }, [location.pathname, location.search])

  useEffect(() => {
    if (!user) {
      setUnread(0)
      return undefined
    }

    let cancelled = false

    const loadUnread = async () => {
      const { count: unreadCount } = await supabase
        .from('messages')
        .select('id', { count: 'exact', head: true })
        .eq('receiver_id', user.id)
        .eq('is_read', false)

      if (!cancelled) setUnread(unreadCount ?? 0)
    }

    void loadUnread()

    const onMessagesRead = () => void loadUnread()
    const onFocus = () => void loadUnread()
    window.addEventListener('mh-messages-read', onMessagesRead)
    window.addEventListener('focus', onFocus)

    const channel = supabase
      .channel(`navbar-unread-${user.id}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'messages' },
        () => void loadUnread(),
      )
      .subscribe()

    return () => {
      cancelled = true
      window.removeEventListener('mh-messages-read', onMessagesRead)
      window.removeEventListener('focus', onFocus)
      supabase.removeChannel(channel)
    }
  }, [user])

  useEffect(() => {
    if (!menuOpen) return undefined

    const handler = (event) => {
      if (!menuRef.current?.contains(event.target)) setMenuOpen(false)
    }

    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [menuOpen])

  const onSearch = (event) => {
    event.preventDefault()
    const term = search.trim()
    navigate(term ? `/?q=${encodeURIComponent(term)}` : '/')
  }

  const workspace = isSeller
    ? { to: '/seller', label: 'Seller studio', icon: LayoutDashboard }
    : null

  const roleLabel = isAdmin ? 'Admin' : isSeller ? 'Seller' : 'Buyer'

  const closeAll = () => {
    setMobileOpen(false)
    setMenuOpen(false)
  }

  return (
    <header className="sticky top-0 z-50 border-b border-white/[0.06] bg-ink-900/75 backdrop-blur-2xl">
      <div className="mx-auto flex h-16 max-w-7xl items-center gap-3 px-4 sm:px-6 lg:px-8">
        <Brand />

        <nav className="ml-4 hidden items-center gap-1 lg:flex">
          {NAV_LINKS.filter((link) => !link.auth || user).map(({ to, label }) => {
            const active = to === '/' ? location.pathname === '/' : location.pathname.startsWith(to)
            return (
              <Link
                key={to}
                to={to}
                className={cn(
                  'rounded-full px-3.5 py-2 text-sm font-medium transition',
                  active
                    ? 'bg-white/[0.07] text-white'
                    : 'text-gray-400 hover:bg-white/[0.04] hover:text-white',
                )}
              >
                {label}
              </Link>
            )
          })}
        </nav>

        <form onSubmit={onSearch} className="ml-auto hidden max-w-md flex-1 md:block lg:ml-6">
          <div className="group relative">
            <Search
              size={16}
              className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-gray-500 transition group-focus-within:text-orange-300"
            />
            <input
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search textbooks, tech, food…"
              aria-label="Search listings"
              className="h-10 w-full rounded-full border border-white/10 bg-black/25 pl-10 pr-4 text-sm text-white placeholder-gray-500 transition focus:border-orange-400/50 focus:bg-black/40 focus:outline-none focus:ring-2 focus:ring-orange-500/10"
            />
          </div>
        </form>

        <div className="ml-auto flex items-center gap-1.5 md:ml-2">
          {user ? (
            <Link
              to="/messages"
              className="icon-btn relative hidden sm:inline-flex"
              aria-label={`Messages${unread ? `, ${unread} unread` : ''}`}
            >
              <MessageSquare size={18} />
              {unread > 0 ? (
                <span className="absolute -right-0.5 -top-0.5 grid h-4 min-w-4 place-items-center rounded-full bg-gradient-to-r from-orange-500 to-pink-500 px-1 text-[10px] font-bold text-white">
                  {unread > 9 ? '9+' : unread}
                </span>
              ) : null}
            </Link>
          ) : null}

          <Link
            to="/cart"
            className="icon-btn relative"
            aria-label={`Cart${count ? `, ${count} items` : ''}`}
          >
            <ShoppingBag size={18} />
            {count > 0 ? (
              <span className="absolute -right-0.5 -top-0.5 grid h-4 min-w-4 place-items-center rounded-full bg-gradient-to-r from-orange-500 to-pink-500 px-1 text-[10px] font-bold text-white">
                {count > 9 ? '9+' : count}
              </span>
            ) : null}
          </Link>

          {user ? (
            <div ref={menuRef} className="relative">
              <button
                type="button"
                onClick={() => setMenuOpen((open) => !open)}
                className="flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] p-1 pr-2 transition hover:border-white/20 hover:bg-white/[0.07]"
                aria-haspopup="menu"
                aria-expanded={menuOpen}
              >
                <Avatar profile={profile} size={30} />
                <ChevronDown
                  size={14}
                  className={cn('text-gray-400 transition', menuOpen && 'rotate-180')}
                />
              </button>

              {menuOpen ? (
                <div
                  role="menu"
                  className="glass absolute right-0 mt-2 w-64 animate-fade-up overflow-hidden rounded-2xl p-2 shadow-card"
                >
                  <div className="flex items-center gap-3 rounded-xl px-2.5 py-2.5">
                    <Avatar profile={profile} size={38} />
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold text-white">
                        {profile?.full_name ?? 'M-Hustle member'}
                      </p>
                      <p className="truncate text-xs text-gray-500">
                        @{username ?? 'member'} · {roleLabel}
                      </p>
                    </div>
                  </div>

                  <div className="my-1 h-px bg-white/[0.07]" />

                  <MenuLink to="/orders" icon={Package} onClick={closeAll} label="My orders" />
                  <MenuLink to="/messages" icon={MessageSquare} onClick={closeAll} label="Messages">
                    {unread > 0 ? (
                      <span className="ml-auto rounded-full bg-orange-500/15 px-2 py-0.5 text-[10px] font-semibold text-orange-300">
                        {unread}
                      </span>
                    ) : null}
                  </MenuLink>
                  {workspace ? (
                    <MenuLink
                      to={workspace.to}
                      icon={workspace.icon}
                      onClick={closeAll}
                      label={workspace.label}
                    />
                  ) : null}
                  <MenuLink
                    to="/profile"
                    icon={UserRound}
                    onClick={closeAll}
                    label="Edit profile"
                  />

                  <div className="my-1 h-px bg-white/[0.07]" />

                  <button
                    type="button"
                    role="menuitem"
                    onClick={async () => {
                      closeAll()
                      await signOut()
                      navigate('/')
                    }}
                    className="flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-sm text-gray-300 transition hover:bg-white/[0.06] hover:text-white"
                  >
                    <LogOut size={16} className="text-gray-500" />
                    Sign out
                  </button>
                </div>
              ) : null}
            </div>
          ) : (
            <div className="hidden items-center gap-2 sm:flex">
              <Link to="/login" className="btn-ghost px-4 py-2 text-sm">
                Sign in
              </Link>
              <Link to="/register" className="btn-primary btn-sm">
                Join M-Hustle
              </Link>
            </div>
          )}

          <button
            type="button"
            className="icon-btn lg:hidden"
            onClick={() => setMobileOpen((open) => !open)}
            aria-label="Toggle navigation menu"
            aria-expanded={mobileOpen}
          >
            {mobileOpen ? <X size={18} /> : <Menu size={18} />}
          </button>
        </div>
      </div>

      {mobileOpen ? (
        <div className="animate-fade-in border-t border-white/[0.06] bg-ink-900/95 px-4 pb-5 pt-4 backdrop-blur-2xl lg:hidden">
          <form onSubmit={onSearch} className="relative">
            <Search
              size={16}
              className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-gray-500"
            />
            <input
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search the marketplace…"
              aria-label="Search listings"
              className="h-11 w-full rounded-2xl border border-white/10 bg-black/30 pl-10 pr-4 text-sm text-white placeholder-gray-500 focus:border-orange-400/50 focus:outline-none"
            />
          </form>

          <nav className="mt-4 grid gap-1">
            {NAV_LINKS.filter((link) => !link.auth || user).map(({ to, label, icon: Icon }) => (
              <Link
                key={to}
                to={to}
                onClick={closeAll}
                className="flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm text-gray-300 transition hover:bg-white/[0.06] hover:text-white"
              >
                <Icon size={17} className="text-gray-500" />
                {label}
                {to === '/messages' && unread > 0 ? (
                  <span className="ml-auto rounded-full bg-orange-500/15 px-2 py-0.5 text-[10px] font-semibold text-orange-300">
                    {unread}
                  </span>
                ) : null}
              </Link>
            ))}
            {workspace ? (
              <Link
                to={workspace.to}
                onClick={closeAll}
                className="flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm text-gray-300 transition hover:bg-white/[0.06] hover:text-white"
              >
                <span className="text-gray-500">
                  <LayoutDashboard size={17} />
                </span>
                {workspace.label}
              </Link>
            ) : null}
            <Link
              to="/profile"
              onClick={closeAll}
              className="flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm text-gray-300 transition hover:bg-white/[0.06] hover:text-white"
            >
              <UserRound size={17} className="text-gray-500" />
              Edit profile
            </Link>
          </nav>

          <div className="mt-4 flex items-center gap-2 border-t border-white/[0.07] pt-4">
            {user ? (
              <button
                type="button"
                onClick={async () => {
                  closeAll()
                  await signOut()
                  navigate('/')
                }}
                className="btn-secondary w-full"
              >
                <LogOut size={16} />
                Sign out
              </button>
            ) : (
              <>
                <Link to="/login" onClick={closeAll} className="btn-secondary flex-1">
                  Sign in
                </Link>
                <Link to="/register" onClick={closeAll} className="btn-primary flex-1">
                  Join M-Hustle
                </Link>
              </>
            )}
          </div>
        </div>
      ) : null}

      {user && profile?.is_suspended ? (
        <div className="border-t border-red-500/20 bg-red-500/10 px-4 py-2 text-center text-xs text-red-200">
          Your account is suspended. Listing, buying and messaging are disabled.
        </div>
      ) : null}
    </header>
  )
}

function MenuLink({ to, icon: Icon, label, onClick, children }) {
  return (
    <Link
      to={to}
      role="menuitem"
      onClick={onClick}
      className="flex items-center gap-2.5 rounded-xl px-2.5 py-2 text-sm text-gray-300 transition hover:bg-white/[0.06] hover:text-white"
    >
      <Icon size={16} className="text-gray-500" />
      {label}
      {children}
    </Link>
  )
}
