import { Suspense } from 'react'
import { PlanScreen } from '@/components/team/PlanScreen'
export const metadata = { title: 'Plan' }
export default function ShopifyPlanPage() { return <Suspense fallback={null}><PlanScreen /></Suspense> }
