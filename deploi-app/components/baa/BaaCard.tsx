import { markBaaSigned } from '@/app/staff/assessments/[id]/baa-actions'
import { Field, Input } from '@/components/ui/Field'
import { Badge } from '@/components/ui/Badge'
import { Banner } from '@/components/ui/Banner'

type Props = { assessmentId: string; agencyId: string; signedAt: string | null; documentUrl: string | null; error?: string; justSigned?: boolean }

const ERRORS: Record<string, string> = {
  'baa-invalid': 'Enter the signed-on date.',
  'baa-file-required': 'Attach the signed PDF.',
  'baa-file-too-large': 'The PDF must be under 10 MB.',
  'baa-not-pdf': 'Only PDF files are accepted.',
}

/** Business Associate Agreement status + "Mark BAA signed" form. Gates every data-ingest path. */
export function BaaCard({ assessmentId, agencyId, signedAt, documentUrl, error, justSigned }: Props) {
  const signedOn = signedAt ? new Date(signedAt).toLocaleDateString('en-US', { timeZone: 'UTC', year: 'numeric', month: 'short', day: 'numeric' }) : null
  return (
    <section id="baa" className="rounded-[20px] border border-line p-5 md:p-6 flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg">Business Associate Agreement</h2>
        {signedOn ? <Badge tone="ok">BAA signed on {signedOn}</Badge> : <Badge tone="warn">not signed</Badge>}
      </div>
      <p className="text-grey text-[15px] max-w-[60ch]">
        Nothing from this agency&rsquo;s systems (roster, referrals, applicants, visit or claim files) enters the app until a signed BAA is on file. The assessment walkthrough above is not gated.
      </p>
      {justSigned && <Banner icon="check"><strong>BAA recorded.</strong> Data imports for this agency are now open.</Banner>}
      {error && ERRORS[error] && <Banner tone="warn"><strong>Could not save.</strong> {ERRORS[error]}</Banner>}
      {signedOn && documentUrl && (
        <div><a className="btn ghost xs" href={`/api/baa/${agencyId}`} target="_blank" rel="noopener noreferrer">Open signed BAA</a></div>
      )}
      <form action={markBaaSigned} className="grid gap-3 md:grid-cols-[1fr_1fr_auto] md:items-end">
        <input type="hidden" name="assessment_id" value={assessmentId} />
        <input type="hidden" name="agency_id" value={agencyId} />
        <Field label="Signed PDF" htmlFor="baa-file" hint="PDF, up to 10 MB">
          <Input id="baa-file" name="file" type="file" accept="application/pdf" required />
        </Field>
        <Field label="Signed on" htmlFor="baa-date">
          <Input id="baa-date" name="signed_on" type="date" required defaultValue={signedAt ? new Date(signedAt).toISOString().slice(0, 10) : ''} />
        </Field>
        <button type="submit" className="btn ghost sm">{signedOn ? 'Replace signed BAA' : 'Mark BAA signed'}</button>
      </form>
    </section>
  )
}
