import type { Metadata, Viewport } from 'next'
import { headers } from 'next/headers'
// self-hosted fonts (@fontsource, latin only): bundled at build time, nothing is fetched from Google
import '@fontsource/inter/latin-400.css'
import '@fontsource/inter/latin-500.css'
import '@fontsource/inter/latin-600.css'
import '@fontsource/inter/latin-700.css'
import '@fontsource/space-grotesk/latin-500.css'
import '@fontsource/space-grotesk/latin-600.css'
import '@fontsource/space-grotesk/latin-700.css'
import './globals.css'
import '../styles/app-tokens.css'
import '../styles/app.css'


export const metadata: Metadata = {
  title: { default: 'Deploi AI', template: '%s · Deploi AI' },
  description: 'Deploi operating system',
  robots: { index: false, follow: false },
}
export const viewport: Viewport = { themeColor: '#F6F7F9', width: 'device-width', initialScale: 1 }

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Embedded Shopify pages (/shopify/*, marked by the middleware) load App Bridge from Shopify's CDN as
  // the first script in <head>, synchronously, with the app's client id in the meta tag.
  // The script nonce of this response (middleware.ts, lib/security/csp.ts): Next.js adds it to its own
  // scripts; App Bridge needs it too, since the policy allows only nonced scripts ('strict-dynamic').
  const apiKey = (process.env.SHOPIFY_API_KEY ?? '').trim()
  const h = await headers()
  const embedded = Boolean(apiKey) && h.get('x-deploi-embedded') === '1'
  const nonce = h.get('x-nonce') ?? undefined
  return (
    <html lang="en">
      <head>
        {embedded && <meta name="shopify-api-key" content={apiKey} />}
        {/* eslint-disable-next-line @next/next/no-sync-scripts */}
        {embedded && <script src="https://cdn.shopify.com/shopifycloud/app-bridge.js" nonce={nonce}></script>}
      </head>
      <body>{children}</body>
    </html>
  )
}
