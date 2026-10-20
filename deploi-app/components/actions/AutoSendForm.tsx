import { WORKER_LABELS, WORKER_NAMES, type WorkerName } from '@/lib/workers/types'
import { Button } from '@/components/ui/Button'

const DESC: Record<WorkerName, string> = {
  authorization_watch: 'Re-auth reminder emails to the scheduler.',
  credential_tracking: 'Expiry texts to aides and emails to the admin.',
  open_shift_fill: 'Shift offers to aides, family confirmations, still-open alerts.',
  referral_response: 'Replies and 7/30-day follow-ups to referral sources.',
  applicant_screening: 'Screening questions and interview invitations to applicants.',
  retention_checkins: '30/60/90-day check-in texts to aides.',
}

export function AutoSendForm({ agencyId, autoSend, action }: { agencyId: string; autoSend: Partial<Record<WorkerName, boolean>>; action: (fd: FormData) => void }) {
  return (
    <form action={action} className="flex flex-col gap-3">
      <input type="hidden" name="agency_id" value={agencyId} />
      {WORKER_NAMES.map(w => (
        <label key={w} className="flex items-start gap-4 rounded-2xl border border-line p-4 cursor-pointer">
          <input type="checkbox" name={`auto_${w}`} defaultChecked={autoSend?.[w] === true} className="mt-1 h-6 w-6 accent-white" />
          <span>
            <span className="block text-ink font-medium">{WORKER_LABELS[w]}</span>
            <span className="block text-[14px] text-grey">{DESC[w]}</span>
            <span className="block text-[13px] text-grey-h">{autoSend?.[w] ? 'Auto-send ON' : 'Auto-send OFF (default): staff approves each message'}</span>
          </span>
        </label>
      ))}
      <div><Button type="submit">Save toggles</Button></div>
    </form>
  )
}
