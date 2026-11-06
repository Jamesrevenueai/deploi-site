import { redirect } from 'next/navigation'
import { LEGACY_REDIRECTS } from '@/lib/store/nav'

/** The Control Room is Home now. */
export default function ControlRoomPage() {
  redirect(LEGACY_REDIRECTS['/store/control-room'])
}
