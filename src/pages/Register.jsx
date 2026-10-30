import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import {
  ArrowRight,
  Check,
  CircleAlert,
  Eye,
  EyeOff,
  Loader2,
  Lock,
  Mail,
  MailCheck,
  Phone,
  ShoppingBag,
  Store,
  UserRound,
} from 'lucide-react'
import AuthShell from '../components/AuthShell'
import { Alert, Spinner } from '../components/ui'
import { useAuth } from '../hooks/useAuth'
import { supabase } from '../lib/supabase'
import { cn, friendlyError } from '../lib/utils'

const USERNAME_RE = /^[a-zA-Z0-9_]{3,20}$/

function scorePassword(password) {
  const checks = [
    password.length >= 8,
    /[A-Z]/.test(password),
    /[0-9]/.test(password),
    /[^A-Za-z0-9]/.test(password),
  ]
  return checks.filter(Boolean).length
}

function destinationFor(role) {
  return role === 'seller' ? '/seller' : '/'
}

export default function Register() {
  const { signUp } = useAuth()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()

  const [form, setForm] = useState({
    fullName: '',
    username: '',
    email: '',
    phone: '',
    password: '',
    confirmPassword: '',
    role: searchParams.get('role') === 'seller' ? 'seller' : 'buyer',
  })
  const [showPassword, setShowPassword] = useState(false)
  const [usernameStatus, setUsernameStatus] = useState({ state: 'idle', message: '' })
  const [accepted, setAccepted] = useState(false)
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [awaitingConfirmation, setAwaitingConfirmation] = useState(false)

  const strength = useMemo(() => scorePassword(form.password), [form.password])

  const update = (field) => (event) => {
    const value = event.target.value
    setForm((current) => ({ ...current, [field]: value }))
  }

  useEffect(() => {
    const username = form.username.trim().toLowerCase()

    if (!username) {
      setUsernameStatus({ state: 'idle', message: '' })
      return undefined
    }

    if (!USERNAME_RE.test(username)) {
      setUsernameStatus({
        state: 'invalid',
        message: '3–20 characters: letters, numbers and underscores only.',
      })
      return undefined
    }

    setUsernameStatus({ state: 'checking', message: 'Checking availability…' })
    let cancelled = false

    const timer = setTimeout(async () => {
      const { data, error: rpcError } = await supabase.rpc('is_username_available', {
        p_username: username,
      })

      if (cancelled) return

      if (rpcError) {
        setUsernameStatus({
          state: 'error',
          message: 'Availability check unavailable — you can still try.',
        })
        return
      }

      setUsernameStatus(
        data
          ? { state: 'available', message: 'Username is available.' }
          : { state: 'taken', message: 'That username is already taken.' },
      )
    }, 450)

    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [form.username])

  const onSubmit = async (event) => {
    event.preventDefault()
    setError('')

    const fullName = form.fullName.trim()
    const username = form.username.trim().toLowerCase()
    const email = form.email.trim()

    if (fullName.length < 2) {
      setError('Enter your full name as it appears on your student ID.')
      return
    }
    if (!USERNAME_RE.test(username)) {
      setError('Choose a username with 3–20 letters, numbers or underscores.')
      return
    }
    if (usernameStatus.state === 'taken') {
      setError('That username is already taken. Try another one.')
      return
    }
    if (usernameStatus.state === 'checking') {
      setError('Give us a second while we check that username.')
      return
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setError('Enter a valid email address.')
      return
    }
    if (form.phone.trim() && !/^\+?[0-9]{9,15}$/.test(form.phone.trim())) {
      setError('Enter a valid phone number, for example 0712 345 678.')
      return
    }
    if (form.password.length < 8) {
      setError('Your password must be at least 8 characters long.')
      return
    }
    if (form.password !== form.confirmPassword) {
      setError('The two passwords do not match.')
      return
    }
    if (!accepted) {
      setError('Accept the campus trading rules to continue.')
      return
    }

    setSubmitting(true)
    const { data, error: signUpError } = await signUp({
      email,
      password: form.password,
      fullName,
      username,
      role: form.role,
      phone: form.phone.trim(),
    })
    setSubmitting(false)

    if (signUpError) {
      const message = signUpError.message || ''
      if (message.toLowerCase().includes('already registered')) {
        setError('An account with this email already exists. Sign in instead.')
      } else if (message.toLowerCase().includes('duplicate') && message.includes('username')) {
        setError('That username was just taken. Choose another.')
      } else if (message.toLowerCase().includes('password')) {
        setError('That password does not meet the project security requirements.')
      } else {
        setError(friendlyError(signUpError, 'We could not create your account. Try again.'))
      }
      return
    }

    if (!data?.session) {
      setAwaitingConfirmation(true)
      return
    }

    navigate(destinationFor(form.role), { replace: true })
  }

  if (awaitingConfirmation) {
    return (
      <AuthShell
        title="Check your inbox"
        subtitle="One last step before you enter the marketplace."
        footer={
          <p className="text-center text-sm text-gray-400">
            Already confirmed?{' '}
            <Link to="/login" className="link font-medium">
              Sign in
            </Link>
          </p>
        }
      >
        <div className="rounded-3xl border border-emerald-400/20 bg-emerald-400/[0.06] p-6 text-center">
          <span className="mx-auto grid h-14 w-14 place-items-center rounded-2xl border border-emerald-400/25 bg-emerald-400/10 text-emerald-300">
            <MailCheck size={26} />
          </span>
          <h3 className="mt-5 text-lg font-semibold text-white">Confirm {form.email.trim()}</h3>
          <p className="mt-2 text-sm leading-relaxed text-gray-400">
            We sent a confirmation link to your email. Open it, then return here to sign in.
            Check spam if it has not arrived within a few minutes.
          </p>
          <Link to="/login" className="btn-primary mt-6">
            Go to sign in
            <ArrowRight size={16} />
          </Link>
        </div>
      </AuthShell>
    )
  }

  return (
    <AuthShell
      title="Create your account"
      subtitle="Join the marketplace in under a minute. Buy, sell, or do both."
      footer={
        <p className="text-center text-sm text-gray-400">
          Already have an account?{' '}
          <Link to="/login" className="link font-medium">
            Sign in
          </Link>
        </p>
      }
    >
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        {error ? <Alert variant="error">{error}</Alert> : null}

        <div>
          <span className="label">I am joining as</span>
          <div className="grid grid-cols-2 gap-2.5">
            <RoleOption
              active={form.role === 'buyer'}
              icon={ShoppingBag}
              title="Buyer"
              description="Shop campus deals"
              onClick={() => setForm((current) => ({ ...current, role: 'buyer' }))}
              accent="orange"
            />
            <RoleOption
              active={form.role === 'seller'}
              icon={Store}
              title="Seller"
              description="List and earn"
              onClick={() => setForm((current) => ({ ...current, role: 'seller' }))}
              accent="emerald"
            />
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor="fullName" className="label">
              Full name
            </label>
            <div className="relative">
              <UserRound
                size={16}
                className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-gray-500"
              />
              <input
                id="fullName"
                type="text"
                autoComplete="name"
                value={form.fullName}
                onChange={update('fullName')}
                placeholder="Amina Otieno"
                className="input pl-11"
                required
              />
            </div>
          </div>

          <div>
            <label htmlFor="username" className="label">
              Username
            </label>
            <div className="relative">
              <span className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-sm text-gray-500">
                @
              </span>
              <input
                id="username"
                type="text"
                autoComplete="username"
                value={form.username}
                onChange={update('username')}
                placeholder="amina_maseno"
                className={cn(
                  'input pl-9 pr-10',
                  (usernameStatus.state === 'taken' || usernameStatus.state === 'invalid') &&
                    'input-error',
                )}
                maxLength={20}
                required
              />
              <span className="absolute right-3 top-1/2 -translate-y-1/2">
                {usernameStatus.state === 'checking' ? (
                  <Loader2 size={15} className="animate-spin text-gray-500" />
                ) : usernameStatus.state === 'available' ? (
                  <Check size={16} className="text-emerald-400" />
                ) : usernameStatus.state === 'taken' ? (
                  <CircleAlert size={15} className="text-red-400" />
                ) : null}
              </span>
            </div>
            {usernameStatus.message ? (
              <p
                className={cn(
                  'mt-1.5 text-xs',
                  usernameStatus.state === 'available'
                    ? 'text-emerald-400'
                    : usernameStatus.state === 'taken' || usernameStatus.state === 'invalid'
                      ? 'text-red-400'
                      : 'text-gray-500',
                )}
              >
                {usernameStatus.message}
              </p>
            ) : (
              <p className="field-hint">This is how buyers will see you.</p>
            )}
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor="email" className="label">
              Email
            </label>
            <div className="relative">
              <Mail
                size={16}
                className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-gray-500"
              />
              <input
                id="email"
                type="email"
                autoComplete="email"
                value={form.email}
                onChange={update('email')}
                placeholder="you@maseno.ac.ke"
                className="input pl-11"
                required
              />
            </div>
          </div>

          <div>
            <label htmlFor="phone" className="label">
              Phone <span className="normal-case tracking-normal text-gray-600">(optional)</span>
            </label>
            <div className="relative">
              <Phone
                size={16}
                className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-gray-500"
              />
              <input
                id="phone"
                type="tel"
                autoComplete="tel"
                value={form.phone}
                onChange={update('phone')}
                placeholder="0712 345 678"
                className="input pl-11"
              />
            </div>
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor="password" className="label">
              Password
            </label>
            <div className="relative">
              <Lock
                size={16}
                className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-gray-500"
              />
              <input
                id="password"
                type={showPassword ? 'text' : 'password'}
                autoComplete="new-password"
                value={form.password}
                onChange={update('password')}
                placeholder="At least 8 characters"
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
            <div className="mt-2 flex gap-1" aria-hidden="true">
              {[1, 2, 3, 4].map((level) => (
                <span
                  key={level}
                  className={cn(
                    'h-1 flex-1 rounded-full transition',
                    strength >= level
                      ? strength <= 2
                        ? 'bg-orange-400'
                        : 'bg-emerald-400'
                      : 'bg-white/10',
                  )}
                />
              ))}
            </div>
          </div>

          <div>
            <label htmlFor="confirmPassword" className="label">
              Confirm password
            </label>
            <div className="relative">
              <Lock
                size={16}
                className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-gray-500"
              />
              <input
                id="confirmPassword"
                type={showPassword ? 'text' : 'password'}
                autoComplete="new-password"
                value={form.confirmPassword}
                onChange={update('confirmPassword')}
                placeholder="Repeat password"
                className={cn(
                  'input pl-11',
                  form.confirmPassword &&
                    form.confirmPassword !== form.password &&
                    'input-error',
                )}
                required
              />
            </div>
            {form.confirmPassword && form.confirmPassword !== form.password ? (
              <p className="field-error">Passwords do not match.</p>
            ) : (
              <p className="field-hint">Use a mix of letters, numbers and a symbol.</p>
            )}
          </div>
        </div>

        <label className="flex cursor-pointer items-start gap-2.5 rounded-xl border border-white/[0.07] bg-white/[0.02] p-3">
          <input
            type="checkbox"
            checked={accepted}
            onChange={(event) => setAccepted(event.target.checked)}
            className="mt-0.5 h-4 w-4 rounded border-white/20 bg-black/40 accent-orange-500"
          />
          <span className="text-xs leading-relaxed text-gray-400">
            I agree to meet in public campus spaces, inspect items before paying, and follow
            the M-Hustle trading rules.
          </span>
        </label>

        <button type="submit" disabled={submitting} className="btn-primary w-full py-3">
          {submitting ? (
            <>
              <Spinner size={16} />
              Creating your account…
            </>
          ) : (
            <>
              Create account
              <ArrowRight size={16} />
            </>
          )}
        </button>
      </form>
    </AuthShell>
  )
}

function RoleOption({ active, icon: Icon, title, description, onClick, accent }) {
  const activeStyles =
    accent === 'emerald'
      ? 'border-emerald-400/45 bg-emerald-400/10'
      : 'border-orange-400/45 bg-orange-400/10'

  const iconStyles =
    accent === 'emerald'
      ? 'text-emerald-300 border-emerald-400/25 bg-emerald-400/10'
      : 'text-orange-300 border-orange-400/25 bg-orange-400/10'

  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'flex items-center gap-3 rounded-2xl border p-3.5 text-left transition',
        active ? activeStyles : 'border-white/10 bg-white/[0.02] hover:border-white/20',
      )}
    >
      <span className={cn('grid h-9 w-9 shrink-0 place-items-center rounded-xl border', iconStyles)}>
        <Icon size={16} />
      </span>
      <span className="min-w-0">
        <span className="block text-sm font-semibold text-white">{title}</span>
        <span className="block truncate text-[11px] text-gray-500">{description}</span>
      </span>
    </button>
  )
}
