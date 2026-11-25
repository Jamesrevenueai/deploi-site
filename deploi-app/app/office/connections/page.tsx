import { Suspense } from 'react'
import { ConnectionsScreen } from '../_components/Connections'

export const metadata = { title: 'Connections' }

export default function OfficeConnectionsPage() { return <Suspense><ConnectionsScreen /></Suspense> }
