import { InboxScreen } from '@/components/store/Inbox'

export const metadata = { title: 'Detailed review' }

/** The detailed review of store changes and emails (edit an email before approving it). */
export default function ApprovalReviewPage() {
  return <InboxScreen />
}
