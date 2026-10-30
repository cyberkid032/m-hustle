import { Link } from 'react-router-dom'
import { ArrowUpRight, Mail, ShieldCheck } from 'lucide-react'
import { Brand } from './Navbar'
import { ORGANISATION, SUPPORT_EMAIL } from '../lib/constants'

export default function Footer() {
  return (
    <footer className="mt-20 border-t border-white/[0.06] bg-ink-950/40">
      <div className="mx-auto grid max-w-7xl gap-10 px-4 py-12 sm:px-6 md:grid-cols-[1.4fr_1fr_1fr] lg:px-8">
        <div>
          <Brand />
          <p className="mt-5 max-w-sm text-sm leading-relaxed text-gray-400">
            The premium campus marketplace built for Maseno University. Buy from verified
            students, sell what you no longer need, and keep every shilling on campus.
          </p>
          <div className="mt-5 inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.03] px-3 py-1.5 text-[11px] text-gray-400">
            <ShieldCheck size={13} className="text-emerald-400" />
            Student-verified sellers · Secure campus handover
          </div>
          <p className="mt-3 text-[10px] uppercase tracking-[0.18em] text-gray-600">
            A product of {ORGANISATION}
          </p>
        </div>

        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-gray-500">
            Marketplace
          </p>
          <ul className="mt-4 space-y-2.5 text-sm">
            <li>
              <Link to="/" className="text-gray-400 transition hover:text-white">
                Browse listings
              </Link>
            </li>
            <li>
              <Link to="/register?role=seller" className="text-gray-400 transition hover:text-white">
                Start selling
              </Link>
            </li>
            <li>
              <Link to="/orders" className="text-gray-400 transition hover:text-white">
                My orders
              </Link>
            </li>
            <li>
              <Link to="/cart" className="text-gray-400 transition hover:text-white">
                Cart
              </Link>
            </li>
          </ul>
        </div>

        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-gray-500">
            Campus desk
          </p>
          <ul className="mt-4 space-y-2.5 text-sm">
            <li className="flex items-center gap-2 text-gray-400">
              <Mail size={14} className="text-gray-600" />
              <a href={`mailto:${SUPPORT_EMAIL}`} className="transition hover:text-white">
                {SUPPORT_EMAIL}
              </a>
            </li>
            <li className="text-gray-500">Maseno University, Kisumu</li>
            <li className="text-gray-500">Mon–Sat · 08:00–20:00 EAT</li>
            <li>
              <a
                href="#top"
                className="inline-flex items-center gap-1 text-orange-300 transition hover:text-orange-200"
              >
                Back to top
                <ArrowUpRight size={13} />
              </a>
            </li>
          </ul>
        </div>
      </div>

      <div className="border-t border-white/[0.06]">
        <div className="mx-auto flex max-w-7xl flex-col gap-2 px-4 py-5 text-[11px] text-gray-500 sm:flex-row sm:items-center sm:justify-between sm:px-6 lg:px-8">
          <p>© {new Date().getFullYear()} M-Hustle. Built by {ORGANISATION} for Maseno University.</p>
          <p className="flex items-center gap-2">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
            All prices in Kenyan Shillings
          </p>
        </div>
      </div>
    </footer>
  )
}
