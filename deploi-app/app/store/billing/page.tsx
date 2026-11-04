import { Suspense } from 'react'
import { BillingScreen } from './BillingScreen'

export const metadata = { title: 'Billing' }

export default function StoreBillingPage() { return <Suspense fallback={null}><BillingScreen /></Suspense> }
