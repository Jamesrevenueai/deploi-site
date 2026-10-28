'use client'
/**
 * Hand the provider's answer back to the window that started the connection (the embedded app), which
 * completes it with its own verified session. Only the app's own origin can receive it.
 */
import { useEffect, useState } from 'react'

export default function OAuthReturn() {
  const [msg, setMsg] = useState('Finishing the connection…')
  useEffect(() => {
    const q = new URLSearchParams(window.location.search)
    const payload = { type: 'deploi-email-oauth', state: q.get('state'), code: q.get('code'), error: q.get('error') }
    if (window.opener) {
      window.opener.postMessage(payload, window.location.origin)
      setMsg('Connected. You can close this window.')
      setTimeout(() => window.close(), 800)
    } else setMsg('Open Deploi and sign in, then connect the account again from Connections.')
  }, [])
  return <main style={{ padding: 32, fontFamily: 'system-ui, sans-serif' }}><p>{msg}</p></main>
}
