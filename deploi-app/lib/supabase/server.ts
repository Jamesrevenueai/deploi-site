import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { env } from '../env'

/** Supabase client bound to the request cookies (auth only; data goes through lib/db). */
export async function supabaseServer() {
  const store = await cookies()
  return createServerClient(env.supabaseUrl, env.supabaseAnonKey, {
    cookies: {
      getAll() { return store.getAll() },
      setAll(all) {
        try { all.forEach(({ name, value, options }) => store.set(name, value, options)) } catch { /* server component: read-only */ }
      },
    },
  })
}
