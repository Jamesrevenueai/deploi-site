/**
 * Embedded Shopify admin app. App Bridge is loaded from Shopify's CDN as the first script in <head>
 * (root layout, for requests the middleware marks as embedded); it provides id tokens and the admin navigation menu.
 * Pages are client-rendered and call /api/store/* with `Authorization: Bearer <id token>`.
 * No Deploi session cookie is involved, so this layout does not require a Deploi sign-in.
 */
import Link from 'next/link'
import { EMBEDDED_HOME, EMBEDDED_NAV } from '@/lib/store/nav'
import { ShopifyFrame } from '@/components/store/ShopifyFrame'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Deploi for Shopify' }

export default function ShopifyLayout({ children }: { children: React.ReactNode }) {
  const apiKey = (process.env.SHOPIFY_API_KEY ?? '').trim()
  return (
    <>
      {/* App Bridge itself is loaded first in <head> by the root layout (see app/layout.tsx). */}
      {apiKey && (
        <ui-nav-menu>
          {/* the home route first (rel="home"), then the menu entries in order, Agents first */}
          <Link href={EMBEDDED_HOME} rel="home">Overview</Link>
          {EMBEDDED_NAV.filter(n => n.href !== EMBEDDED_HOME).map(n => (
            <Link key={n.href} href={n.href}>{n.label}</Link>
          ))}
        </ui-nav-menu>
      )}
      <main className="mx-auto w-full max-w-[1120px] px-4 pb-16 pt-6 md:px-8 md:pt-8">
        <ShopifyFrame configured={Boolean(apiKey)}>{children}</ShopifyFrame>
      </main>
    </>
  )
}
