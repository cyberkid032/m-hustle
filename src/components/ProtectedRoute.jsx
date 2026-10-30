import { Navigate, useLocation } from 'react-router-dom'
import { LogOut, RefreshCw, ShieldAlert } from 'lucide-react'
import { useAuth } from '../hooks/useAuth'
import { PageLoader } from './ui'

/**
 * Route guard. Waits for the session + profile, redirects unauthenticated
 * visitors to /login (remembering where they were going), and enforces roles.
 */
export default function ProtectedRoute({ children, roles }) {
  const { user, profile, loading, profileError, refreshProfile, signOut } = useAuth()
  const location = useLocation()

  if (loading) {
    return <PageLoader label="Checking your session…" />
  }

  if (!user) {
    return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />
  }

  if (!profile && profileError) {
    return (
      <div className="mx-auto flex min-h-[60vh] max-w-lg flex-col items-center justify-center px-4 text-center">
        <span className="grid h-14 w-14 place-items-center rounded-2xl border border-amber-400/20 bg-amber-400/10 text-amber-300">
          <ShieldAlert size={26} />
        </span>
        <h1 className="mt-5 text-xl font-semibold text-white">We could not load your profile</h1>
        <p className="mt-2 text-sm leading-relaxed text-gray-400">
          {profileError} This usually means the Supabase schema has not been applied yet, or
          your session needs a refresh.
        </p>
        <div className="mt-6 flex flex-wrap justify-center gap-2">
          <button type="button" onClick={() => refreshProfile()} className="btn-primary">
            <RefreshCw size={16} />
            Try again
          </button>
          <button type="button" onClick={() => signOut()} className="btn-secondary">
            <LogOut size={16} />
            Sign out
          </button>
        </div>
      </div>
    )
  }

  if (!profile) {
    return <PageLoader label="Preparing your account…" />
  }

  if (roles && !roles.includes(profile.role)) {
    return <Navigate to={profile.role === 'admin' ? '/admin' : '/'} replace />
  }

  return children
}
