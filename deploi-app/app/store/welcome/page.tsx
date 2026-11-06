import { redirect } from 'next/navigation'
import { SETUP_PATH } from '@/lib/store/nav'

/** The discovery first run is a step of the setup now (/store/setup). */
export default function WelcomePage() { redirect(SETUP_PATH) }
