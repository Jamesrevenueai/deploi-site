import { StaffSupport } from './StaffSupport'

export const metadata = { title: 'Support · Staff' }

/** Staff only (app/staff/layout.tsx requires a staff session; the API refuses everyone else). */
export default function StaffSupportPage() { return <StaffSupport /> }
