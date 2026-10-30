import { useEffect, useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { ArrowRight, Eye, EyeOff, Lock, UserRound } from 'lucide-react'
import AuthShell from '../components/AuthShell'
import { Alert, Spinner } from '../components/ui'
import { useAuth } from '../hooks/useAuth'
import { friendlyError } from '../lib/utils'

function destinationFor(role) {
  if (role === 'admin') return '/admin'
  if (role === 'seller') return '/seller'
  return '/'
}

export default function Login() {
  const { profile, signIn } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()

  const [identifier, setIdentifier] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const from = location.state?.from
  const redirectTo = from && from !== '/login' ? from : null

  useEffect(() => {
    if (profile) {
      navigate(redirectTo || destinationFor(profile.role), { replace: true })
    }
  }, [profile, navigate, redirectTo])

  const onSubmit = async (event) => {
    event.preventDefault()
    setError('')

    if (!identifier.trim() || !password) {
      setError('Enter your email or username and password to continue.')
      return
    }

    setSubmitting(true)
    const { error: authError, profile: nextProfile } = await signIn(identifier, password)
    setSubmitting(false)

    if (authError) {
      const message = authError.message || ''
      if (message.toLowerCase().includes('invalid login')) {
        setError('Email, username or password is incorrect. Check both and try again.')
      } else if (message.toLowerCase().includes('email not confirmed')) {
        setError(
          'This account still needs email confirmation. An admin can disable confirmation in Supabase, or confirm the email once.',
        )
      } else if (message.toLowerCase().includes('rate limit')) {
        setError('Too many attempts. Wait a minute, then try again.')
      } else {
        setError(friendlyError(authError, 'We could not sign you in. Please try again.'))
      }
      return
    }

    navigate(redirectTo || destinationFor(nextProfile?.role), { replace: true })
  }

  return (
    <AuthShell
      title="Welcome back"
      subtitle="Sign in with your email or username to pick up your cart, track orders and keep the hustle moving."
      footer={
        <p className="text-center text-sm text-gray-400">
          New to M-Hustle?{' '}
          <Link to="/register" className="link font-medium">
            Create an account
          </Link>
        </p>
      }
    >
      <form onSubmit={onSubmit} className="space-y-5" noValidate>
        {error ? <Alert variant="error">{error}</Alert> : null}

        <div>
          <label htmlFor="identifier" className="label">
            Email or username
          </label>
          <div className="relative">
            <UserRound
              size={16}
              className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-gray-500"
            />
            <input
              id="identifier"
              type="text"
              autoComplete="username"
              value={identifier}
              onChange={(event) => setIdentifier(event.target.value)}
              placeholder="you@maseno.ac.ke or amina_maseno"
              className="input pl-11"
              required
            />
          </div>
        </div>

        <div>
          <div className="flex items-center justify-between">
            <label htmlFor="password" className="label">
              Password
            </label>
            <span className="mb-1.5 text-[11px] text-gray-500">Minimum 8 characters</span>
          </div>
          <div className="relative">
            <Lock
              size={16}
              className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-gray-500"
            />
            <input
              id="password"
              type={showPassword ? 'text' : 'password'}
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="Enter your password"
              className="input px-11"
              required
            />
            <button
              type="button"
              onClick={() => setShowPassword((visible) => !visible)}
              className="absolute right-3 top-1/2 -translate-y-1/2 rounded-full p-1.5 text-gray-500 transition hover:bg-white/10 hover:text-white"
              aria-label={showPassword ? 'Hide password' : 'Show password'}
            >
              {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
            </button>
          </div>
        </div>

        <button type="submit" disabled={submitting} className="btn-primary w-full py-3">
          {submitting ? (
            <>
              <Spinner size={16} />
              Signing in…
            </>
          ) : (
            <>
              Sign in
              <ArrowRight size={16} />
            </>
          )}
        </button>

        <p className="text-center text-[11px] leading-relaxed text-gray-500">
          By signing in you agree to the M-Hustle campus trading rules. Meet in public,
          inspect before paying, and keep conversations inside the app.
        </p>
      </form>
    </AuthShell>
  )
}
