import { setSmsConsent } from '@/lib/consent/actions'

/** One-tap SMS consent switch for a contact row. */
export function ConsentToggle({ kind, id, consent, back }: { kind: 'aide' | 'applicant' | 'client'; id: string; consent: boolean; back: string }) {
  return (
    <form action={setSmsConsent} className="inline-flex">
      <input type="hidden" name="kind" value={kind} />
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="consent" value={consent ? 'false' : 'true'} />
      <input type="hidden" name="back" value={back} />
      <button type="submit" className={`badge ${consent ? 'ok' : 'muted'}`} aria-pressed={consent} title={consent ? 'Withdraw SMS consent' : 'Record SMS consent'}>
        SMS {consent ? 'consent on' : 'consent off'}
      </button>
    </form>
  )
}
