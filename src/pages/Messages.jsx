import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import {
  ArrowLeft,
  Check,
  CheckCheck,
  ChevronRight,
  MessageSquare,
  RefreshCw,
  Send,
  ShoppingBag,
  Store,
} from 'lucide-react'
import { useAuth } from '../hooks/useAuth'
import { supabase } from '../lib/supabase'
import { Alert, Avatar, EmptyState, PageLoader, Spinner } from '../components/ui'
import VerifiedBadge from '../components/VerifiedBadge'
import {
  chatTime,
  cn,
  formatDate,
  formatKES,
  friendlyError,
} from '../lib/utils'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MESSAGE_SELECT =
  'id, sender_id, receiver_id, listing_id, content, is_read, created_at'
const PROFILE_SELECT = 'id, username, full_name, avatar_url, role'

export default function Messages() {
  const { user, profile, isSuspended } = useAuth()
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()

  const [messages, setMessages] = useState([])
  const [profiles, setProfiles] = useState({})
  const [badges, setBadges] = useState({})
  const [contextListing, setContextListing] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)

  const bottomRef = useRef(null)
  const inputRef = useRef(null)
  const profilesRef = useRef({})
  const requestedRef = useRef(new Set())
  const activeIdRef = useRef(null)

  const rawActive = searchParams.get('user')
  const activeId =
    rawActive && UUID_RE.test(rawActive) && rawActive !== user?.id ? rawActive : null
  const listingParam = searchParams.get('listing')

  activeIdRef.current = activeId

  useEffect(() => {
    profilesRef.current = profiles
  }, [profiles])

  const hydrateProfiles = useCallback(async (ids) => {
    const unique = [...new Set(ids.filter((id) => id && UUID_RE.test(id)))]
    const missing = unique.filter(
      (id) => !profilesRef.current[id] && !requestedRef.current.has(id),
    )
    if (missing.length === 0) return

    for (const id of missing) requestedRef.current.add(id)

    const { data, error: profileError } = await supabase
      .from('profiles')
      .select(PROFILE_SELECT)
      .in('id', missing)

    if (profileError) {
      for (const id of missing) requestedRef.current.delete(id)
      return
    }

    if (data?.length) {
      const next = { ...profilesRef.current }
      for (const row of data) next[row.id] = row
      profilesRef.current = next
      setProfiles(next)
    }
  }, [])

  const load = useCallback(async () => {
    if (!user?.id) return

    setLoading(true)
    setError('')

    const [messageResult, badgeResult] = await Promise.all([
      supabase
        .from('messages')
        .select(MESSAGE_SELECT)
        .or(`sender_id.eq.${user.id},receiver_id.eq.${user.id}`)
        .order('created_at', { ascending: false })
        .limit(500),
      supabase.rpc('get_seller_badges'),
    ])

    if (messageResult.error) {
      setError(messageResult.error.message)
      setLoading(false)
      return
    }

    const rows = messageResult.data ?? []
    setMessages((current) => {
      const merged = new Map(rows.map((message) => [message.id, message]))
      for (const message of current) merged.set(message.id, message)
      return [...merged.values()].sort(
        (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
      )
    })

    const badgeMap = {}
    for (const row of badgeResult.data ?? []) badgeMap[row.seller_id] = row
    setBadges(badgeMap)

    const counterpartIds = rows.map((row) =>
      row.sender_id === user.id ? row.receiver_id : row.sender_id,
    )
    await hydrateProfiles(counterpartIds)

    setLoading(false)
  }, [user?.id, hydrateProfiles])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    if (activeId) void hydrateProfiles([activeId])
  }, [activeId, hydrateProfiles])

  useEffect(() => {
    if (!user?.id) return undefined

    const channel = supabase
      .channel(`mh-thread-${user.id}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'messages' },
        (payload) => {
          const row = payload.new
          if (!row || (row.sender_id !== user.id && row.receiver_id !== user.id)) return

          setMessages((current) =>
            current.some((message) => message.id === row.id) ? current : [...current, row],
          )

          const counterpart = row.sender_id === user.id ? row.receiver_id : row.sender_id
          void hydrateProfiles([counterpart])

          if (row.receiver_id === user.id && row.sender_id === activeIdRef.current) {
            void supabase
              .from('messages')
              .update({ is_read: true })
              .eq('id', row.id)
              .then(() => {
                setMessages((current) =>
                  current.map((message) =>
                    message.id === row.id ? { ...message, is_read: true } : message,
                  ),
                )
                window.dispatchEvent(new Event('mh-messages-read'))
              })
          }
        },
      )
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'messages' },
        (payload) => {
          const row = payload.new
          if (!row) return
          setMessages((current) =>
            current.map((message) => (message.id === row.id ? { ...message, ...row } : message)),
          )
        },
      )
      .subscribe()

    return () => {
      supabase.removeChannel(channel)
    }
  }, [user?.id, hydrateProfiles])

  // Load the listing referenced by a "Chat with seller" deep link.
  useEffect(() => {
    let active = true

    if (!listingParam || !UUID_RE.test(listingParam)) {
      setContextListing(null)
      return undefined
    }

    const fetchListing = async () => {
      const { data } = await supabase
        .from('listings')
        .select('id, title, price, image_url, status, seller_id')
        .eq('id', listingParam)
        .maybeSingle()

      if (active) setContextListing(data ?? null)
    }

    void fetchListing()
    return () => {
      active = false
    }
  }, [listingParam])

  // Mark the open thread as read.
  useEffect(() => {
    if (!user?.id || !activeId) return

    const unread = messages.filter(
      (message) =>
        message.sender_id === activeId &&
        message.receiver_id === user.id &&
        !message.is_read,
    )
    if (unread.length === 0) return

    const ids = unread.map((message) => message.id)

    setMessages((current) =>
      current.map((message) =>
        ids.includes(message.id) ? { ...message, is_read: true } : message,
      ),
    )

    void (async () => {
      const { error: readError } = await supabase
        .from('messages')
        .update({ is_read: true })
        .in('id', ids)
        .eq('receiver_id', user.id)
        .select('id')

      if (readError) {
        setError(friendlyError(readError, 'Messages could not be marked as read.'))
        return
      }

      window.dispatchEvent(new Event('mh-messages-read'))
    })()
  }, [activeId, messages, user?.id])

  const threadMessages = useMemo(() => {
    if (!activeId) return []
    return messages.filter(
      (message) =>
        (message.sender_id === user?.id && message.receiver_id === activeId) ||
        (message.receiver_id === user?.id && message.sender_id === activeId),
    )
  }, [messages, activeId, user?.id])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end', behavior: 'smooth' })
  }, [activeId, threadMessages.length])

  useEffect(() => {
    if (activeId) {
      const timer = setTimeout(() => inputRef.current?.focus(), 120)
      return () => clearTimeout(timer)
    }
    return undefined
  }, [activeId])

  const conversations = useMemo(() => {
    if (!user?.id) return []

    const map = new Map()

    for (const message of messages) {
      const otherId =
        message.sender_id === user.id ? message.receiver_id : message.sender_id
      const entry = map.get(otherId) ?? {
        otherId,
        lastMessage: null,
        unread: 0,
      }

      if (
        !entry.lastMessage ||
        new Date(message.created_at) >= new Date(entry.lastMessage.created_at)
      ) {
        entry.lastMessage = message
      }
      if (message.receiver_id === user.id && !message.is_read) entry.unread += 1
      map.set(otherId, entry)
    }

    if (activeId && !map.has(activeId)) {
      map.set(activeId, { otherId: activeId, lastMessage: null, unread: 0 })
    }

    return [...map.values()].sort((a, b) => {
      const aTime = a.lastMessage ? new Date(a.lastMessage.created_at).getTime() : 0
      const bTime = b.lastMessage ? new Date(b.lastMessage.created_at).getTime() : 0
      return bTime - aTime
    })
  }, [messages, user?.id, activeId])

  const activeProfile = activeId ? profiles[activeId] : null
  const activeBadge = activeId ? badges[activeId] : null

  const openConversation = (id) => {
    setSearchParams({ user: id })
  }

  const sendMessage = async (event) => {
    event?.preventDefault()
    const content = draft.trim()
    if (!content || !activeId || sending || isSuspended) return

    setSending(true)
    setError('')

    const { data, error: sendError } = await supabase
      .from('messages')
      .insert({
        sender_id: user.id,
        receiver_id: activeId,
        listing_id: contextListing?.id ?? null,
        content,
      })
      .select(MESSAGE_SELECT)
      .single()

    setSending(false)

    if (sendError) {
      setError(friendlyError(sendError, 'Your message could not be sent.'))
      return
    }

    setMessages((current) =>
      current.some((message) => message.id === data.id) ? current : [...current, data],
    )
    setDraft('')

    if (listingParam) {
      setSearchParams({ user: activeId }, { replace: true })
    }
  }

  const onKeyDown = (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      void sendMessage()
    }
  }

  if (loading) {
    return <PageLoader label="Opening your messages…" />
  }

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="eyebrow">Direct messages</p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight text-white sm:text-4xl">
            Messages
          </h1>
          <p className="mt-1.5 text-sm text-gray-400">
            Real-time conversations with buyers and sellers. Keep every deal inside M-Hustle.
          </p>
        </div>
        <button type="button" onClick={() => void load()} className="btn-secondary btn-sm">
          <RefreshCw size={13} className="text-gray-400" />
          Refresh
        </button>
      </div>

      {error ? (
        <Alert variant="error" className="mt-6" onClose={() => setError('')}>
          {error}
        </Alert>
      ) : null}

      <div className="mt-7 grid overflow-hidden rounded-3xl border border-white/[0.08] bg-[rgba(15,15,24,0.65)] backdrop-blur-xl lg:grid-cols-[320px_1fr]">
        {/* --------------------------------------------------- conversations */}
        <aside
          className={cn(
            'border-b border-white/[0.07] lg:border-b-0 lg:border-r',
            activeId ? 'hidden lg:block' : 'block',
          )}
        >
          <div className="flex items-center justify-between border-b border-white/[0.07] px-4 py-3.5">
            <h2 className="text-xs font-semibold uppercase tracking-[0.16em] text-gray-400">
              Conversations
            </h2>
            <span className="text-[10px] text-gray-600">{conversations.length}</span>
          </div>

          {conversations.length === 0 ? (
            <div className="px-5 py-10 text-center">
              <MessageSquare size={24} className="mx-auto text-gray-600" />
              <p className="mt-3 text-sm font-medium text-white">No conversations yet</p>
              <p className="mt-1 text-xs leading-relaxed text-gray-500">
                Open a listing and tap “Chat with seller” to start one.
              </p>
              <Link to="/" className="btn-secondary btn-sm mt-4">
                Browse listings
              </Link>
            </div>
          ) : (
            <ul className="max-h-[560px] overflow-y-auto lg:max-h-[calc(100vh-240px)]">
              {conversations.map((conversation) => {
                const other = profiles[conversation.otherId]
                const isActive = conversation.otherId === activeId
                const last = conversation.lastMessage
                const badge = badges[conversation.otherId]

                return (
                  <li key={conversation.otherId}>
                    <button
                      type="button"
                      onClick={() => openConversation(conversation.otherId)}
                      className={cn(
                        'flex w-full items-start gap-3 border-b border-white/[0.05] px-4 py-3.5 text-left transition',
                        isActive
                          ? 'bg-orange-500/[0.07]'
                          : 'hover:bg-white/[0.04]',
                      )}
                    >
                      <Avatar profile={other} size={38} />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          <p className="truncate text-sm font-medium text-white">
                            {other?.full_name || other?.username || 'M-Hustle member'}
                          </p>
                          {badge ? <VerifiedBadge plan={badge.plan} size={13} /> : null}
                          <span className="ml-auto shrink-0 text-[10px] text-gray-600">
                            {last ? chatTime(last.created_at) : 'New'}
                          </span>
                        </div>
                        <p className="mt-0.5 line-clamp-1 text-xs text-gray-500">
                          {last
                            ? `${last.sender_id === user.id ? 'You: ' : ''}${last.content}`
                            : 'Start the conversation'}
                        </p>
                      </div>
                      {conversation.unread > 0 ? (
                        <span className="mt-1 grid h-5 min-w-5 shrink-0 place-items-center rounded-full bg-gradient-to-r from-orange-500 to-pink-500 px-1 text-[10px] font-bold text-white">
                          {conversation.unread}
                        </span>
                      ) : null}
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </aside>

        {/* --------------------------------------------------------- thread */}
        <section className={cn('flex min-h-[540px] flex-col lg:min-h-[calc(100vh-240px)]', !activeId && 'hidden lg:flex')}>
          {!activeId ? (
            <div className="flex flex-1 flex-col items-center justify-center px-6 py-16 text-center">
              <span className="grid h-16 w-16 place-items-center rounded-3xl border border-white/10 bg-white/[0.03] text-gray-500">
                <MessageSquare size={28} />
              </span>
              <h3 className="mt-5 text-lg font-semibold text-white">Select a conversation</h3>
              <p className="mt-2 max-w-sm text-sm leading-relaxed text-gray-500">
                Chat about price, condition or a handover spot. Messages update in real time,
                so you never need to refresh.
              </p>
            </div>
          ) : (
            <>
              <header className="flex flex-wrap items-center gap-3 border-b border-white/[0.07] px-4 py-3.5 sm:px-5">
                <button
                  type="button"
                  onClick={() => navigate('/messages')}
                  className="icon-btn h-8 w-8 lg:hidden"
                  aria-label="Back to conversations"
                >
                  <ArrowLeft size={15} />
                </button>

                <Avatar profile={activeProfile} size={38} />

                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <p className="truncate text-sm font-semibold text-white">
                      {activeProfile?.full_name ||
                        activeProfile?.username ||
                        'Loading conversation…'}
                    </p>
                    {activeBadge ? <VerifiedBadge plan={activeBadge.plan} size={14} /> : null}
                  </div>
                  <p className="truncate text-[11px] text-gray-500">
                    @{activeProfile?.username || 'member'}
                    {activeBadge
                      ? ` · ${activeBadge.plan === 'pro_max' ? 'Pro Max' : 'Pro'} seller`
                      : ' · M-Hustle member'}
                  </p>
                </div>

                {contextListing ? (
                  <Link
                    to={`/product/${contextListing.id}`}
                    className="hidden items-center gap-2 rounded-full border border-white/10 bg-white/[0.03] px-3 py-1.5 text-[11px] text-gray-300 transition hover:border-white/20 sm:flex"
                  >
                    <ShoppingBag size={12} className="text-orange-300" />
                    <span className="max-w-[180px] truncate">{contextListing.title}</span>
                    <ChevronRight size={12} className="text-gray-600" />
                  </Link>
                ) : null}
              </header>

              <div className="flex-1 space-y-4 overflow-y-auto px-4 py-5 sm:px-5 lg:max-h-[calc(100vh-390px)]">
                {contextListing ? (
                  <div className="mx-auto flex max-w-md items-center gap-3 rounded-2xl border border-orange-400/15 bg-orange-400/[0.05] p-3">
                    <div className="h-12 w-12 shrink-0 overflow-hidden rounded-xl bg-ink-800">
                      {contextListing.image_url ? (
                        <img
                          src={contextListing.image_url}
                          alt={contextListing.title}
                          className="h-full w-full object-cover"
                        />
                      ) : (
                        <div className="grid h-full w-full place-items-center text-gray-600">
                          <Store size={16} />
                        </div>
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="text-[10px] uppercase tracking-[0.14em] text-orange-300/80">
                        Chatting about
                      </p>
                      <p className="truncate text-xs font-medium text-white">
                        {contextListing.title}
                      </p>
                      <p className="text-[11px] text-gray-500">
                        {formatKES(contextListing.price)}
                      </p>
                    </div>
                    <Link
                      to={`/product/${contextListing.id}`}
                      className="shrink-0 rounded-full p-1.5 text-gray-500 transition hover:bg-white/10 hover:text-white"
                      aria-label="Open listing"
                    >
                      <ChevronRight size={15} />
                    </Link>
                  </div>
                ) : null}

                {threadMessages.length === 0 ? (
                  <div className="flex flex-col items-center justify-center py-12 text-center">
                    <Avatar profile={activeProfile} size={52} />
                    <p className="mt-4 text-sm font-medium text-white">
                      Say hello to {activeProfile?.full_name?.split(' ')[0] || 'your seller'}
                    </p>
                    <p className="mt-1 max-w-xs text-xs leading-relaxed text-gray-500">
                      Ask about condition, price, or where to meet on campus. Be clear and
                      keep it respectful.
                    </p>
                  </div>
                ) : (
                  threadMessages.map((message, index) => {
                    const mine = message.sender_id === user.id
                    const previous = threadMessages[index - 1]
                    const showDate =
                      !previous ||
                      new Date(previous.created_at).toDateString() !==
                        new Date(message.created_at).toDateString()

                    return (
                      <div key={message.id}>
                        {showDate ? (
                          <div className="my-4 flex items-center gap-3">
                            <span className="h-px flex-1 bg-white/[0.06]" />
                            <span className="text-[10px] uppercase tracking-[0.14em] text-gray-600">
                              {formatDate(message.created_at)}
                            </span>
                            <span className="h-px flex-1 bg-white/[0.06]" />
                          </div>
                        ) : null}

                        <div className={cn('flex gap-2.5', mine ? 'justify-end' : 'justify-start')}>
                          {!mine ? <Avatar profile={activeProfile} size={26} /> : null}
                          <div className={cn('max-w-[82%] sm:max-w-[70%]', mine && 'items-end')}>
                            <div
                              className={cn(
                                'rounded-2xl px-4 py-2.5 text-sm leading-relaxed',
                                mine
                                  ? 'rounded-br-md bg-gradient-to-br from-orange-500/90 to-pink-500/90 text-white'
                                  : 'rounded-bl-md border border-white/[0.08] bg-white/[0.05] text-gray-200',
                              )}
                            >
                              <p className="whitespace-pre-wrap break-words">{message.content}</p>
                            </div>
                            <div
                              className={cn(
                                'mt-1 flex items-center gap-1 text-[10px] text-gray-600',
                                mine ? 'justify-end' : 'justify-start',
                              )}
                            >
                              {chatTime(message.created_at)}
                              {mine ? (
                                message.is_read ? (
                                  <CheckCheck size={12} className="text-sky-400" />
                                ) : (
                                  <Check size={12} />
                                )
                              ) : null}
                            </div>
                          </div>
                        </div>
                      </div>
                    )
                  })
                )}
                <div ref={bottomRef} />
              </div>

              {isSuspended ? (
                <div className="border-t border-red-500/15 bg-red-500/[0.05] px-4 py-3 text-center text-xs text-red-200">
                  Messaging is disabled while your account is suspended.
                </div>
              ) : (
                <form
                  onSubmit={sendMessage}
                  className="border-t border-white/[0.07] bg-ink-900/40 p-3 sm:p-4"
                >
                  <div className="flex items-end gap-2 rounded-2xl border border-white/10 bg-black/30 p-2 transition focus-within:border-orange-400/50">
                    <textarea
                      ref={inputRef}
                      value={draft}
                      onChange={(event) => setDraft(event.target.value.slice(0, 2000))}
                      onKeyDown={onKeyDown}
                      rows={1}
                      placeholder="Write a message…"
                      aria-label="Message"
                      className="max-h-32 min-h-[38px] flex-1 resize-none bg-transparent px-2 py-2 text-sm text-white placeholder-gray-500 focus:outline-none"
                    />
                    <button
                      type="submit"
                      disabled={!draft.trim() || sending}
                      className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-gradient-to-r from-orange-500 to-pink-500 text-white transition hover:brightness-110 disabled:opacity-40"
                      aria-label="Send message"
                    >
                      {sending ? <Spinner size={15} /> : <Send size={15} />}
                    </button>
                  </div>
                  <div className="mt-1.5 flex items-center justify-between px-1 text-[10px] text-gray-600">
                    <span>Enter to send · Shift + Enter for a new line</span>
                    {draft.length > 1800 ? <span>{draft.length}/2000</span> : null}
                  </div>
                </form>
              )}
            </>
          )}
        </section>
      </div>

      {conversations.length === 0 ? (
        <div className="mt-6">
          <EmptyState
            icon={ShoppingBag}
            title="No messages yet"
            description="Conversations start from a listing. Find something you like, open it, and tap Chat with seller."
            action={
              <Link to="/" className="btn-primary">
                Explore the marketplace
              </Link>
            }
          />
        </div>
      ) : null}

      <p className="mt-6 text-center text-[10px] uppercase tracking-[0.14em] text-gray-700">
        Messages are delivered in real time · stay respectful
      </p>
    </div>
  )
}
