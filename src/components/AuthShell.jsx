import { Link } from 'react-router-dom'
import { ArrowLeft, BadgeCheck, ShieldCheck, Smartphone } from 'lucide-react'
import { Brand } from './Navbar'
import { ORGANISATION } from '../lib/constants'

const FEATURES = [
  {
    icon: BadgeCheck,
    title: 'Verified campus sellers',
    body: 'Pro and Pro Max badges separate trusted hustlers from the noise.',
  },
  {
    icon: ShieldCheck,
    title: 'Built on real accounts',
    body: 'Every buyer and seller is backed by a Supabase-authenticated identity.',
  },
  {
    icon: Smartphone,
    title: 'M-Pesa native',
    body: 'Upgrade visibility with a transaction code reviewed by the campus desk.',
  },
]

export default function AuthShell({ title, subtitle, children, footer }) {
  return (
    <div className="mx-auto grid w-full max-w-6xl gap-8 px-4 py-10 sm:px-6 lg:grid-cols-[1.02fr_1fr] lg:items-center lg:gap-12 lg:py-16">
      <aside className="relative hidden overflow-hidden rounded-4xl border border-white/[0.08] bg-[radial-gradient(circle_at_20%_0%,rgba(249,115,22,0.22),transparent_55%),radial-gradient(circle_at_90%_85%,rgba(236,72,153,0.18),transparent_55%)] p-10 lg:block">
        <div className="absolute -right-16 -top-16 h-52 w-52 rounded-full bg-orange-500/10 blur-3xl" />
        <div className="absolute -bottom-20 -left-10 h-56 w-56 rounded-full bg-pink-500/10 blur-3xl" />

        <div className="relative">
          <Brand />

          <p className="eyebrow mt-14">Maseno University · Campus marketplace</p>
          <h1 className="mt-4 max-w-md text-balance font-display text-4xl font-semibold leading-[1.08] tracking-tight text-white">
            Your campus.
            <br />
            <span className="gradient-text">Your hustle.</span>
          </h1>
          <p className="mt-5 max-w-sm text-sm leading-relaxed text-gray-400">
            The premium marketplace for Maseno students. Textbooks, tech, hostel essentials
            and services — all from people you already share a campus with.
          </p>

          <div className="mt-10 space-y-5">
            {FEATURES.map(({ icon: Icon, title: featureTitle, body }) => (
              <div key={featureTitle} className="flex gap-3.5">
                <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl border border-white/10 bg-white/[0.04] text-orange-300">
                  <Icon size={16} />
                </span>
                <div>
                  <p className="text-sm font-medium text-white">{featureTitle}</p>
                  <p className="mt-0.5 text-xs leading-relaxed text-gray-500">{body}</p>
                </div>
              </div>
            ))}
          </div>

          <div className="mt-12 flex items-center gap-2 text-[11px] text-gray-500">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
            Live marketplace · real listings, real sellers · built by {ORGANISATION}
          </div>
        </div>
      </aside>

      <section className="glass relative w-full rounded-4xl p-6 shadow-card sm:p-9">
        <div className="mb-7 flex items-center justify-between gap-4 lg:hidden">
          <Brand />
          <Link to="/" className="btn-ghost btn-sm">
            <ArrowLeft size={14} />
            Home
          </Link>
        </div>

        <div>
          <p className="eyebrow">M-Hustle account</p>
          <h2 className="mt-3 text-2xl font-semibold tracking-tight text-white sm:text-3xl">
            {title}
          </h2>
          {subtitle ? (
            <p className="mt-2 text-sm leading-relaxed text-gray-400">{subtitle}</p>
          ) : null}
        </div>

        <div className="mt-7">{children}</div>

        {footer ? <div className="mt-7 border-t border-white/[0.07] pt-6">{footer}</div> : null}
      </section>
    </div>
  )
}
