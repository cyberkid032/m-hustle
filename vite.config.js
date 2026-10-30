import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// M-Hustle is a static SPA: no custom backend, no server middleware.
// Everything talks directly to Supabase through the anon key + RLS.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: true,
  },
  preview: {
    port: 4173,
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          'vendor-react': ['react', 'react-dom', 'react-router-dom'],
          'vendor-supabase': ['@supabase/supabase-js'],
        },
      },
    },
  },
})
