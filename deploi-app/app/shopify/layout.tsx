/**
 * Embedded Shopify admin app. App Bridge is loaded from Shopify's CDN as the first script in <head>
 * (root layout, for requests the middleware marks as embedded); it provides id tokens and the admin navigation menu.
 * Pages are client-rendered and call /api/store/* with `Authorization: Bearer <id token>`.
 * No Deploi session cookie is involved, so this layout does not require a Deploi sign-in.
 * The menu lists only features ready for Shopify review; every page also 404s when its feature is hidden.
 */
import Link from 'next/link'
import { headers } from 'next/headers'
import { notFound } from 'next/navigation'
import { EMBEDDED_HOME, embeddedNav, embeddedPathAllowed } from '@/lib/shopify/embedded'
import { ShopifyFrame } from '@/components/store/ShopifyFrame'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Deploi for Shopify' }

export default async function ShopifyLayout({ children }: { children: React.ReactNode }) {
  // Hidden features 404 here, before the frame renders (each page also checks its own feature). The path comes from
  // the middleware, which overwrites any value the client sends.
  const path = (await headers()).get('x-deploi-path')
  if (path && !embeddedPathAllowed(path)) notFound()
  const apiKey = (process.env.SHOPIFY_API_KEY ?? '').trim()
  return (
    <>
      {/* App Bridge itself is loaded first in <head> by the root layout (see app/layout.tsx). */}
      {apiKey && (
        <ui-nav-menu>
          {/* the home route first (rel="home"), then only the features ready for Shopify (lib/shopify/embedded.ts) */}
          <Link href={EMBEDDED_HOME} rel="home">Overview</Link>
          {embeddedNav().map(n => (
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
