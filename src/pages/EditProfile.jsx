import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  ArrowLeft,
  AtSign,
  Check,
  Loader2,
  Mail,
  MapPin,
  Phone,
  Save,
  ShieldCheck,
  UserRound,
} from 'lucide-react'
import { useAuth } from '../hooks/useAuth'
import { supabase } from '../lib/supabase'
import { HOSTELS } from '../lib/constants'
import { cn, friendlyError } from '../lib/utils'
import { Alert, Avatar, Spinner } from '../components/ui'

const USERNAME_RE = /^[a-zA-Z0-9_]{3,20}$/

export default function EditProfile() {
  const { profile, updateProfile } = useAuth()

  const [form, setForm] = useState({
    full_name: profile?.full_name ?? '',
    username: profile?.username ?? '',
    phone: profile?.phone ?? '',
    location: profile?.location ?? '',
  })
  const [usernameStatus, setUsernameStatus] = useState({ state: 'idle', message: '' })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')

  const update = (field) => (event) => {
    setForm((current) => ({ ...current, [field]: event.target.value }))
    setSuccess('')
  }

  useEffect(() => {
    const username = form.username.trim().toLowerCase()

    if (!username || username === profile?.username) {
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
      const { data, error: lookupError } = await supabase.rpc('is_username_available', {
        p_username: username,
      })

      if (cancelled) return

      if (lookupError) {
        setUsernameStatus({ state: 'error', message: 'Could not verify that username.' })
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
  }, [form.username, profile?.username])

  const onSubmit = async (event) => {
    event.preventDefault()
    setError('')
    setSuccess('')

    const fullName = form.full_name.trim()
    const username = form.username.trim().toLowerCase()
    const phone = form.phone.trim()

    if (fullName.length < 2) {
      setError('Enter your full name.')
      return
    }
    if (!USERNAME_RE.test(username)) {
      setError('Choose a username with 3–20 letters, numbers or underscores.')
      return
    }
    if (usernameStatus.state === 'checking') {
      setError('Give us a second while we check that username.')
      return
    }
    if (usernameStatus.state === 'taken') {
      setError('That username is already taken.')
      return
    }
    if (phone && !/^\+?[0-9]{9,15}$/.test(phone.replace(/\s+/g, ''))) {
      setError('Enter a valid phone number, for example 0712 345 678.')
      return
    }
    if (form.location && !HOSTELS.includes(form.location)) {
      setError('Choose a hostel from the list.')
      return
    }

    setSaving(true)
    const { error: saveError } = await updateProfile({
      full_name: fullName,
      username,
      phone: phone.replace(/\s+/g, '') || null,
      location: form.location || null,
    })
    setSaving(false)

    if (saveError) {
      setError(friendlyError(saveError, 'Your profile could not be saved.'))
      return
    }

    setSuccess('Profile updated.')
  }

  return (
    <div className="mx-auto max-w-3xl px-4 py-10 sm:px-6">
      <Link
        to="/"
        className="inline-flex items-center gap-1.5 text-xs text-gray-400 transition hover:text-white"
      >
        <ArrowLeft size={14} />
        Back to marketplace
      </Link>

      <div className="mt-5">
        <p className="eyebrow">Your account</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight text-white sm:text-4xl">
          Edit profile
        </h1>
        <p className="mt-2 text-sm leading-relaxed text-gray-400">
          Keep your name, username and hostel current so buyers know where to meet you.
        </p>
      </div>

      <form onSubmit={onSubmit} className="mt-7 space-y-5">
        {error ? <Alert variant="error">{error}</Alert> : null}
        {success ? <Alert variant="success">{success}</Alert> : null}

        <section className="glass rounded-3xl p-5 sm:p-7">
          <div className="flex flex-wrap items-center gap-4 border-b border-white/[0.07] pb-5">
            <Avatar profile={profile} size={56} />
            <div className="min-w-0 flex-1">
              <p className="text-base font-semibold text-white">{profile?.full_name}</p>
              <p className="text-xs text-gray-500">@{profile?.username}</p>
            </div>
            <span className="badge border-white/10 bg-white/[0.04] capitalize text-gray-300">
              <ShieldCheck size={12} className="text-emerald-400" />
              {profile?.role}
            </span>
          </div>

          <div className="mt-5 grid gap-4 sm:grid-cols-2">
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
                  value={form.full_name}
                  onChange={update('full_name')}
                  className="input pl-11"
                  maxLength={80}
                  required
                />
              </div>
            </div>

            <div>
              <label htmlFor="username" className="label">
                Username
              </label>
              <div className="relative">
                <AtSign
                  size={16}
                  className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-gray-500"
                />
                <input
                  id="username"
                  type="text"
                  value={form.username}
                  onChange={update('username')}
                  className={cn(
                    'input pl-10',
                    (usernameStatus.state === 'taken' ||
                      usernameStatus.state === 'invalid') &&
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
                  ) : null}
                </span>
              </div>
              {usernameStatus.message ? (
                <p
                  className={cn(
                    'mt-1.5 text-xs',
                    usernameStatus.state === 'available'
                      ? 'text-emerald-400'
                      : usernameStatus.state === 'taken' ||
                          usernameStatus.state === 'invalid'
                        ? 'text-red-400'
                        : 'text-gray-500',
                  )}
                >
                  {usernameStatus.message}
                </p>
              ) : (
                <p className="field-hint">Changing this changes how buyers find you.</p>
              )}
            </div>

            <div>
              <label htmlFor="phone" className="label">
                Phone
              </label>
              <div className="relative">
                <Phone
                  size={16}
                  className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-gray-500"
                />
                <input
                  id="phone"
                  type="tel"
                  value={form.phone}
                  onChange={update('phone')}
                  placeholder="0712 345 678"
                  className="input pl-11"
                  autoComplete="tel"
                />
              </div>
            </div>

            <div>
              <label htmlFor="location" className="label">
                Hostel / residence
              </label>
              <div className="relative">
                <MapPin
                  size={16}
                  className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-gray-500"
                />
                <select
                  id="location"
                  value={form.location}
                  onChange={update('location')}
                  className="select pl-11"
                >
                  <option value="">Select your hostel</option>
                  {HOSTELS.map((hostel) => (
                    <option key={hostel} value={hostel}>
                      {hostel}
                    </option>
                  ))}
                </select>
              </div>
              <p className="field-hint">Shown on your seller card to help with handover.</p>
            </div>

            <div className="sm:col-span-2">
              <label htmlFor="email" className="label">
                Email
              </label>
              <div className="relative">
                <Mail
                  size={16}
                  className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-gray-600"
                />
                <input
                  id="email"
                  type="email"
                  value={profile?.email ?? ''}
                  readOnly
                  className="input cursor-not-allowed pl-11 text-gray-500"
                />
              </div>
              <p className="field-hint">Email is managed by Supabase Auth and cannot change here.</p>
            </div>
          </div>

          <div className="mt-6 flex flex-wrap gap-2 border-t border-white/[0.07] pt-5">
            <button type="submit" disabled={saving} className="btn-primary">
              {saving ? (
                <>
                  <Spinner size={15} />
                  Saving…
                </>
              ) : (
                <>
                  <Save size={15} />
                  Save changes
                </>
              )}
            </button>
            <Link to="/" className="btn-secondary">
              Cancel
            </Link>
          </div>
        </section>
      </form>
    </div>
  )
}
