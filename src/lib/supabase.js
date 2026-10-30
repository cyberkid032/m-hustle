import { createClient } from '@supabase/supabase-js'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

const looksLikePlaceholder =
  !supabaseUrl ||
  !supabaseAnonKey ||
  /your-project|your-anon|example\.supabase\.co|public-anon-key-not-configured/i.test(
    `${supabaseUrl} ${supabaseAnonKey}`,
  )

/**
 * True only when both environment variables are present and do not contain the
 * shipped placeholder values. The UI renders a setup screen instead of a
 * broken marketplace when this is false.
 */
export const isSupabaseConfigured = Boolean(
  supabaseUrl && supabaseAnonKey && !looksLikePlaceholder,
)

if (supabaseUrl && supabaseAnonKey && looksLikePlaceholder) {
  console.warn(
    '[M-Hustle] Supabase credentials still contain placeholder text. Update .env and restart the dev server.',
  )
}

// The fallback values keep module evaluation safe so the configuration screen
// can render. No request is ever made until Supabase is configured.
export const supabase = createClient(
  supabaseUrl || 'http://localhost:54321',
  supabaseAnonKey || 'public-anon-key-not-configured',
  {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
      storageKey: 'm-hustle-auth',
    },
    global: {
      headers: {
        'x-application-name': 'm-hustle',
      },
    },
  },
)

export const LISTING_IMAGES_BUCKET = 'listing-images'
