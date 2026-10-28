/** Minimal typings for Shopify App Bridge (loaded from cdn.shopify.com in app/shopify/layout.tsx). */
import type { DetailedHTMLProps, HTMLAttributes } from 'react'

declare global {
  interface Window {
    shopify?: {
      idToken: () => Promise<string>
      config?: { apiKey?: string; shop?: string; host?: string }
      toast?: { show: (message: string, opts?: { duration?: number; isError?: boolean }) => void }
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
