import { Suspense } from 'react'
import { WooConnectScreen } from './WooConnect'

export const metadata = { title: 'Connect WooCommerce' }

export default function WooCommerceConnectPage() {
  return <Suspense fallback={null}><WooConnectScreen /></Suspense>
}
