/** Minimal typings for Shopify App Bridge (loaded from cdn.shopify.com in app/shopify/layout.tsx). */
import type { DetailedHTMLProps, HTMLAttributes } from 'react'

declare global {
  interface Window {
    shopify?: {
      idToken: () => Promise<string>
      config?: { apiKey?: string; shop?: string; host?: string }
      toast?: { show: (message: string, opts?: { duration?: number; isError?: boolean }) => void }
      /** App Bridge Scopes API: optional scopes declared in shopify.app.toml can be asked for at runtime */
      scopes?: {
        query: () => Promise<{ granted: string[]; required: string[]; optional: string[] }>
        request: (scopes: string[]) => Promise<{ result: 'granted-all' | 'declined-all'; detail: { granted: string[]; required: string[]; optional: string[] } }>
        revoke: (scopes: string[]) => Promise<{ detail: { granted: string[]; required: string[]; optional: string[] } }>
      }
    }
  }
}

declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
      'ui-nav-menu': DetailedHTMLProps<HTMLAttributes<HTMLElement>, HTMLElement>
    }
  }
}

export {}
