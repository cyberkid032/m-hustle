import { Link } from 'react-router-dom'
import { ArrowLeft, Compass } from 'lucide-react'

export default function NotFound() {
  return (
    <div className="mx-auto flex min-h-[70vh] max-w-lg flex-col items-center justify-center px-4 text-center">
      <span className="grid h-16 w-16 place-items-center rounded-3xl border border-white/10 bg-white/[0.04] text-orange-300">
        <Compass size={30} />
      </span>
      <p className="mt-6 font-display text-5xl font-bold gradient-text">404</p>
      <h1 className="mt-3 text-2xl font-semibold text-white">This page is off campus</h1>
      <p className="mt-2 text-sm leading-relaxed text-gray-400">
        The link may be broken, or the listing was sold and taken down. Head back to the
        marketplace to keep browsing.
      </p>
      <Link to="/" className="btn-primary mt-7">
        <ArrowLeft size={16} />
        Back to marketplace
      </Link>
    </div>
  )
}
