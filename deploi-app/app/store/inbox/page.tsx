import { redirect } from 'next/navigation'
import { LEGACY_REDIRECTS } from '@/lib/store/nav'

/** Approvals moved to Needs My Approval (/store/approvals); the customer inbox is /store/inbox/mail. */
export default function StoreInboxPage() {
  redirect(LEGACY_REDIRECTS['/store/inbox'])
}
