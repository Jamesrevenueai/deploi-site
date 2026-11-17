import { redirect } from 'next/navigation'
import { SETUP_PATH } from '@/lib/store/nav'

/** The setup wizard moved to /store/setup (one path with discovery). */
export default function StoreOnboardingPage() { redirect(SETUP_PATH) }
