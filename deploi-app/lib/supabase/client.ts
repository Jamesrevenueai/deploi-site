'use client'
import { createBrowserClient } from '@supabase/ssr'

export function supabaseBrowser(url: string, anonKey: string) {
  return createBrowserClient(url, anonKey)
}
