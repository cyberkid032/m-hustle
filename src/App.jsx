import { lazy, Suspense } from 'react'
import { Link, Route, Routes } from 'react-router-dom'
import {
  ArrowRight,
  Database,
  KeyRound,
  LogOut,
  ShieldAlert,
  Terminal,
} from 'lucide-react'
import Navbar from './components/Navbar'
import Footer from './components/Footer'
import ScrollToTop from './components/ScrollToTop'
import ProtectedRoute from './components/ProtectedRoute'
import { PageLoader } from './components/ui'
import { useAuth } from './hooks/useAuth'
import { isSupabaseConfigured } from './lib/supabase'
import { SUPPORT_EMAIL } from './lib/constants'

import Home from './pages/Home'
import Login from './pages/Login'
import Register from './pages/Register'

// Route-level code splitting keeps the first marketplace paint light.
const ProductDetail = lazy(() => import('./pages/ProductDetail'))
const Cart = lazy(() => import('./pages/Cart'))
const Checkout = lazy(() => import('./pages/Checkout'))
const BuyerOrders = lazy(() => import('./pages/BuyerOrders'))
const Messages = lazy(() => import('./pages/Messages'))
const EditProfile = lazy(() => import('./pages/EditProfile'))
const SellerDashboard = lazy(() => import('./pages/SellerDashboard'))
const AdminDashboard = lazy(() => import('./pages/AdminDashboard'))
const NotFound = lazy(() => import('./pages/NotFound'))

export default function App() {
  const { isSuspended, signOut } = useAuth()

  if (!isSupabaseConfigured) {
    return <SetupScreen />
  }

  return (
    <div id="top" className="flex min-h-screen flex-col">
      <ScrollToTop />
      <Navbar />

      <main className="flex-1">
        <Suspense fallback={<PageLoader label="Loading M-Hustle…" />}>
          {isSuspended ? (
            <SuspendedScreen onSignOut={signOut} />
          ) : (
            <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/login" element={<Login />} />
            <Route path="/register" element={<Register />} />
            <Route path="/product/:id" element={<ProductDetail />} />
            <Route path="/cart" element={<Cart />} />
            <Route
              path="/checkout"
              element={
                <ProtectedRoute>
                  <Checkout />
                </ProtectedRoute>
              }
            />
            <Route
              path="/orders"
              element={
                <ProtectedRoute>
                  <BuyerOrders />
                </ProtectedRoute>
              }
            />
            <Route
              path="/messages"
              element={
                <ProtectedRoute>
                  <Messages />
                </ProtectedRoute>
              }
            />
            <Route
              path="/profile"
              element={
                <ProtectedRoute>
                  <EditProfile />
                </ProtectedRoute>
              }
            />
            <Route
              path="/seller"
              element={
                <ProtectedRoute roles={['seller']}>
                  <SellerDashboard />
                </ProtectedRoute>
              }
            />
            <Route
              path="/admin"
              element={
                <ProtectedRoute roles={['admin']}>
                  <AdminDashboard />
                </ProtectedRoute>
              }
            />
            <Route path="*" element={<NotFound />} />
          </Routes>
          )}
        </Suspense>
      </main>

      <Footer />
    </div>
  )
}

function SuspendedScreen({ onSignOut }) {
  return (
    <div className="mx-auto flex min-h-[70vh] max-w-lg flex-col items-center justify-center px-4 text-center">
      <span className="grid h-16 w-16 place-items-center rounded-3xl border border-red-500/25 bg-red-500/10 text-red-300">
        <ShieldAlert size={30} />
      </span>
      <h1 className="mt-6 text-2xl font-semibold text-white">Account suspended</h1>
      <p className="mt-3 text-sm leading-relaxed text-gray-400">
        Buy, sell and messaging are paused on this account. If you believe this is a mistake,
        contact the M-Hustle campus desk at{' '}
        <a href={`mailto:${SUPPORT_EMAIL}`} className="link">
          {SUPPORT_EMAIL}
        </a>
        .
      </p>
      <div className="mt-7 flex flex-wrap justify-center gap-2">
        <button type="button" onClick={onSignOut} className="btn-secondary">
          <LogOut size={16} />
          Sign out
        </button>
        <Link to="/" className="btn-primary">
          Back to marketplace
          <ArrowRight size={16} />
        </Link>
      </div>
    </div>
  )
}

function SetupScreen() {
  return (
    <div className="mx-auto flex min-h-screen max-w-3xl flex-col justify-center px-4 py-16 sm:px-6">
      <div className="flex items-center gap-3">
        <span className="grid h-11 w-11 place-items-center rounded-2xl bg-gradient-to-br from-orange-500 to-pink-500 font-display text-lg font-extrabold text-white">
          M
        </span>
        <div>
          <p className="font-display text-lg font-bold text-white">M-Hustle</p>
          <p className="text-[10px] uppercase tracking-[0.22em] text-gray-500">
            A HartTech product · setup required
          </p>
        </div>
      </div>

      <h1 className="mt-10 text-3xl font-semibold tracking-tight text-white sm:text-4xl">
        Connect your Supabase project
      </h1>
      <p className="mt-3 max-w-xl text-sm leading-relaxed text-gray-400">
        M-Hustle talks to Supabase directly from the browser. Add your project credentials,
        apply the schema, and this screen will be replaced by the marketplace.
      </p>

      <div className="mt-8 space-y-3">
        <Step
          icon={Terminal}
          title="1 · Create the environment file"
          body="Duplicate .env.example as .env in the project root, then paste your Project URL and anon public key."
        />
        <Step
          icon={Database}
          title="2 · Run the schema"
          body="Open the Supabase SQL Editor and run supabase/schema.sql. It creates the tables, RLS policies, RPCs, storage bucket and realtime publication."
        />
        <Step
          icon={KeyRound}
          title="3 · Restart the dev server"
          body="Vite only reads environment variables on boot. Stop the server, run npm run dev again, and sign up your first account."
        />
      </div>

      <div className="mt-8 rounded-2xl border border-white/10 bg-black/40 p-4 font-mono text-xs leading-relaxed text-gray-300">
        <p className="text-gray-500"># .env</p>
        <p>VITE_SUPABASE_URL=https://your-project-ref.supabase.co</p>
        <p>VITE_SUPABASE_ANON_KEY=your-anon-public-key</p>
      </div>

      <p className="mt-6 text-xs text-gray-500">
        Never place the service-role key in this app. The browser only needs the anon key;
        Row Level Security protects every table.
      </p>
      <p className="mt-3 text-xs text-gray-600">
        M-Hustle is designed and maintained by HartTech. Support:{' '}
        <a href={`mailto:${SUPPORT_EMAIL}`} className="link">
          {SUPPORT_EMAIL}
        </a>
      </p>
    </div>
  )
}

function Step({ icon: Icon, title, body }) {
  return (
    <div className="flex gap-4 rounded-2xl border border-white/[0.08] bg-white/[0.02] p-4">
      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl border border-white/10 bg-white/[0.04] text-orange-300">
        <Icon size={16} />
      </span>
      <div>
        <p className="text-sm font-semibold text-white">{title}</p>
        <p className="mt-1 text-xs leading-relaxed text-gray-400">{body}</p>
      </div>
    </div>
  )
}
