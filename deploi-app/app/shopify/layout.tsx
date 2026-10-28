/**
 * Embedded Shopify admin app. App Bridge is loaded from Shopify's CDN with the app's client id in a
 * meta tag (React hoists <meta> into <head>); it provides id tokens and the admin navigation menu.
 * Pages are client-rendered and call /api/store/* with `Authorization: Bearer <id token>`.
 * No Deploi session cookie is involved, so this layout does not require a Deploi sign-in.
 */
import Link from 'next/link'
import { EMBEDDED_NAV } from '@/lib/store/nav'
import { ShopifyFrame } from '@/components/store/ShopifyFrame'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Deploi for Shopify' }

export default function ShopifyLayout({ children }: { children: React.ReactNode }) {
  const apiKey = (process.env.SHOPIFY_API_KEY ?? '').trim()
  return (
    <>
      {apiKey && <meta name="shopify-api-key" content={apiKey} />}
      {/* App Bridge must load synchronously from Shopify's CDN (no async/defer) so window.shopify exists before the app runs. */}
      {/* eslint-disable-next-line @next/next/no-sync-scripts */}
      {apiKey && <script src="https://cdn.shopify.com/shopifycloud/app-bridge.js"></script>}
      {apiKey && (
        <ui-nav-menu>
          {EMBEDDED_NAV.map((n, i) => (
            <Link key={n.href} href={n.href} rel={i === 0 ? 'home' : undefined}>{n.label}</Link>
          ))}
        </ui-nav-menu>
      )}
      <main className="mx-auto w-full max-w-[1120px] px-4 pb-16 pt-6 md:px-8 md:pt-8">
        <ShopifyFrame configured={Boolean(apiKey)}>{children}</ShopifyFrame>
      </main>
    </>
  )
}
