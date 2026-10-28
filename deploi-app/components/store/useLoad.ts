'use client'
import { useCallback, useEffect, useRef, useState } from 'react'
import { asApiError, type StoreApiError } from './api'

/** Load data on mount (and when `key` changes); `reload()` refetches without clearing what is shown. */
export function useLoad<T>(load: () => Promise<T>, key: string) {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<StoreApiError | null>(null)
  const [loading, setLoading] = useState(true)
  const loader = useRef(load)
  loader.current = load
  const seq = useRef(0)

  const run = useCallback(async () => {
    const n = ++seq.current
    setLoading(true)
    try {
      const d = await loader.current()
      if (n === seq.current) { setData(d); setError(null) }
    } catch (e) {
      if (n === seq.current) setError(asApiError(e))
    } finally {
      if (n === seq.current) setLoading(false)
    }
  }, [])

  useEffect(() => { void run() }, [run, key])
  return { data, error, loading, reload: run, setData }
}
