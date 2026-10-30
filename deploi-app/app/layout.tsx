import type { Metadata, Viewport } from 'next'
import { headers } from 'next/headers'
import { Inter } from 'next/font/google'
import './globals.css'

const inter = Inter({ subsets: ['latin'], weight: ['400', '500', '600', '700'], variable: '--font-inter', display: 'swap' })

export const metadata: Metadata = {
  title: { default: 'Deploi AI', template: '%s · Deploi AI' },
  description: 'Deploi operating system',
  robots: { index: false, follow: false },
}
export const viewport: Viewport = { themeColor: '#000000', width: 'device-width', initialScale: 1 }

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Embedded Shopify pages (/shopify/*, marked by the middleware) load App Bridge from Shopify's CDN as
  // the first script in <head>, synchronously, with the app's client id in the meta tag.
  const apiKey = (process.env.SHOPIFY_API_KEY ?? '').trim()
  const embedded = Boolean(apiKey) && (await headers()).get('x-deploi-embedded') === '1'
  return (
    <html lang="en" className={inter.variable}>
      <head>
        {embedded && <meta name="shopify-api-key" content={apiKey} />}
        {/* eslint-disable-next-line @next/next/no-sync-scripts */}
        {embedded && <script src="https://cdn.shopify.com/shopifycloud/app-bridge.js"></script>}
      </head>
      <body>{children}</body>
    </html>
  )
}
