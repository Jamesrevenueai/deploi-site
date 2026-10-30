import type { NextConfig } from 'next'
import path from 'node:path'
import { assertProductionAuth } from './lib/auth-guard'

// A production build with dev auth configured fails here, so the previous deployment stays live.
assertProductionAuth(process.env)

const nextConfig: NextConfig = {
  reactStrictMode: true,
  distDir: process.env.NEXT_DIST_DIR || '.next',
  outputFileTracingRoot: path.join(__dirname),
  serverExternalPackages: ['pg', '@react-pdf/renderer'],
  experimental: { serverActions: { bodySizeLimit: '8mb' } },
  headers: async () => [{
    // Every page except the embedded Shopify app refuses framing. /shopify must load inside the Shopify
    // admin; its framing is limited per shop by the Content-Security-Policy set in middleware.ts.
    source: '/((?!shopify(?:/|$)).*)',
    headers: [{ key: 'X-Frame-Options', value: 'DENY' }],
  }, {
    source: '/(.*)',
    headers: [
      { key: 'X-Content-Type-Options', value: 'nosniff' },
      { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
      { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains' },
    ],
  }],
}

export default nextConfig
