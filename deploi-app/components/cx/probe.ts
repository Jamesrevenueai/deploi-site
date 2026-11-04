'use client'
/**
 * Feature detection for parts of Deploi that other workstreams deliver (WooCommerce connect, Deploi Office,
 * the unified approvals API, legal and billing pages). A route that answers 404 (or 405 for a POST-only
 * path) is "not available yet"; anything else means it exists. Nothing here assumes a response shape.
 */
import { useEffect, useState } from 'react'

export type Availability = 'checking' | 'available' | 'missing'

/** Probe a page or API path with a GET that sends cookies and follows no redirects. */
export async function probe(path: string): Promise<{ availability: Exclude<Availability, 'checking'>; status: number; json: unknown }> {
  try {
    const res = await fetch(path, { method: 'GET', credentials: 'same-origin', cache: 'no-store', redirect: 'manual', headers: { accept: path.startsWith('/api/') ? 'application/json' : 'text/html' } })
    if (res.status === 404 || res.status === 405) return { availability: 'missing', status: res.status, json: null }
    let json: unknown = null
    if (path.startsWith('/api/')) { try { json = await res.json() } catch { json = null } }
    return { availability: 'available', status: res.status, json }
  } catch {
    return { availability: 'missing', status: 0, json: null }
  }
}

/** Probe several paths once; returns their availability by path. */
export function useProbes(paths: string[]): Record<string, Availability> {
  const key = paths.join('|')
  const [state, setState] = useState<Record<string, Availability>>(() => Object.fromEntries(paths.map(p => [p, 'checking' as Availability])))
  useEffect(() => {
    let live = true
    const list = key ? key.split('|') : []
    void Promise.all(list.map(async p => [p, (await probe(p)).availability] as const)).then(r => { if (live) setState(Object.fromEntries(r)) })
    return () => { live = false }
  }, [key])
  return state
}

/** Routes owned by other workstreams that the customer screens link to or read when they exist. */
export const ROUTES = {
  woocommerceConnect: '/store/connect/woocommerce',
  officeConnections: '/office/connections',
  office: '/office',
  legal: '/store/legal',
  legalApi: '/api/store/legal',
  billing: '/store/billing',
  approvalsApi: '/api/store/approvals',
  /** organization-wide stop owned by the approvals workstream; the Control Room falls back to its own route */
  orgStopApi: '/api/store/stop-all',
  officeConnectionsApi: '/api/office/connections',
} as const
