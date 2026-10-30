import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { supabase } from '../lib/supabase'

const AuthContext = createContext(null)

const PROFILE_COLUMNS =
  'id, username, full_name, role, avatar_url, location, is_suspended, created_at'

/**
 * Loads the signed-in user's full profile through a SECURITY DEFINER RPC.
 * Email and phone are not readable from a broad `profiles` table read, so
 * this is the only path for the owner's private fields.
 *
 * The profile row is created by an auth trigger. The short retry loop covers
 * the small window between the auth insert and the trigger commit.
 */
async function fetchOwnProfile(userId) {
  if (!userId) return null

  let lastError = null

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const { data, error } = await supabase.rpc('get_my_profile')

    if (error) {
      lastError = error
      // PGRST202 = function not found (schema.sql not applied yet).
      if (error.code === 'PGRST202') break
    } else {
      const row = Array.isArray(data) ? data[0] : data
      if (row) return row
    }

    await new Promise((resolve) => setTimeout(resolve, 350))
  }

  // Defensive fallback for projects where the RPC is not installed yet.
  const { data, error } = await supabase
    .from('profiles')
    .select(PROFILE_COLUMNS)
    .eq('id', userId)
    .maybeSingle()

  if (error) throw lastError || error
  if (!data) return null

  return { ...data, email: null, phone: null }
}

export function AuthProvider({ children }) {
  const [session, setSession] = useState(null)
  const [profile, setProfile] = useState(null)
  const [loading, setLoading] = useState(true)
  const [profileError, setProfileError] = useState(null)

  const activeRef = useRef(true)
  const requestRef = useRef(0)

  const loadProfile = useCallback(async (userId) => {
    if (!userId) {
      setProfile(null)
      return null
    }

    const requestId = requestRef.current + 1
    requestRef.current = requestId
    setProfileError(null)

    try {
      const row = await fetchOwnProfile(userId)
      if (activeRef.current && requestRef.current === requestId) {
        setProfile(row)
        if (!row) setProfileError('Your profile could not be loaded.')
      }
      return row
    } catch (error) {
      if (activeRef.current && requestRef.current === requestId) {
        setProfile(null)
        setProfileError(error?.message || 'Your profile could not be loaded.')
      }
      return null
    }
  }, [])

  useEffect(() => {
    activeRef.current = true
    let active = true

    const bootstrap = async () => {
      const {
        data: { session: initialSession },
      } = await supabase.auth.getSession()

      if (!active) return

      setSession(initialSession)

      if (initialSession?.user) {
        await loadProfile(initialSession.user.id)
      }

      if (active) setLoading(false)
    }

    void bootstrap()

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event, nextSession) => {
      if (!active) return

      setSession(nextSession)

      if (!nextSession?.user || event === 'SIGNED_OUT') {
        setProfile(null)
        setProfileError(null)
        setLoading(false)
        return
      }

      if (event === 'SIGNED_IN' || event === 'USER_UPDATED') {
        void loadProfile(nextSession.user.id)
      }

      setLoading(false)
    })

    return () => {
      active = false
      activeRef.current = false
      subscription.unsubscribe()
    }
  }, [loadProfile])

  const signIn = useCallback(
    async (identifier, password) => {
      const handle = identifier.trim()
      let loginEmail = handle

      // A value without "@" is treated as a username. Resolve it to the
      // account email that Supabase Auth expects, then use the normal
      // password grant. Usernames are unique and case-insensitive.
      if (!handle.includes('@')) {
        const { data: resolved, error: lookupError } = await supabase.rpc(
          'login_email_for_username',
          { p_username: handle },
        )

        if (lookupError) {
          if (lookupError.code === 'PGRST202') {
            return {
              data: null,
              profile: null,
              error: new Error('USERNAME_LOGIN_UNAVAILABLE'),
            }
          }
          return { data: null, profile: null, error: lookupError }
        }

        const resolvedEmail = Array.isArray(resolved)
          ? resolved[0]?.email ?? resolved[0]
          : resolved

        if (!resolvedEmail) {
          return {
            data: null,
            profile: null,
            error: new Error('Invalid login credentials'),
          }
        }

        loginEmail = resolvedEmail
      }

      const { data, error } = await supabase.auth.signInWithPassword({
        email: loginEmail,
        password,
      })

      if (error) return { data: null, profile: null, error }

      const nextProfile = data.user ? await loadProfile(data.user.id) : null
      return { data, profile: nextProfile, error: null }
    },
    [loadProfile],
  )

  const signUp = useCallback(
    async ({ email, password, fullName, username, role, phone }) => {
      const { data, error } = await supabase.auth.signUp({
        email: email.trim(),
        password,
        options: {
          data: {
            full_name: fullName.trim(),
            username: username.trim().toLowerCase(),
            role: role === 'seller' ? 'seller' : 'buyer',
            phone: phone?.trim() || null,
          },
        },
      })

      if (error) return { data: null, profile: null, error }

      if (data.session?.user) {
        const nextProfile = await loadProfile(data.session.user.id)
        return { data, profile: nextProfile, error: null }
      }

      return { data, profile: null, error: null }
    },
    [loadProfile],
  )

  const signOut = useCallback(async () => {
    await supabase.auth.signOut()
    setSession(null)
    setProfile(null)
    setProfileError(null)
  }, [])

  const updateProfile = useCallback(
    async (patch) => {
      const userId = session?.user?.id
      if (!userId) return { error: new Error('Not signed in') }

      const { error } = await supabase
        .from('profiles')
        .update(patch)
        .eq('id', userId)

      if (error) return { error }

      await loadProfile(userId)
      return { error: null }
    },
    [loadProfile, session?.user?.id],
  )

  const refreshProfile = useCallback(async () => {
    if (!session?.user?.id) return null
    return loadProfile(session.user.id)
  }, [loadProfile, session?.user?.id])

  const value = useMemo(() => {
    const user = session?.user ?? null
    return {
      session,
      user,
      profile,
      loading,
      profileError,
      isAdmin: profile?.role === 'admin',
      isSeller: profile?.role === 'seller',
      isSuspended: Boolean(profile?.is_suspended),
      signIn,
      signUp,
      signOut,
      updateProfile,
      refreshProfile,
    }
  }, [
    session,
    profile,
    loading,
    profileError,
    signIn,
    signUp,
    signOut,
    updateProfile,
    refreshProfile,
  ])

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth() {
  const context = useContext(AuthContext)
  if (!context) {
    throw new Error('useAuth must be used inside <AuthProvider>')
  }
  return context
}
