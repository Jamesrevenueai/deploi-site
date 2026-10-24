import { requireRole, requestIp } from '@/lib/auth'
import { withUser } from '@/lib/db'
import { loadRates } from '@/lib/economics/queries'
import { RATE_LABELS, dollars } from '@/lib/economics/calc'
import { PageHeader } from '@/components/ui/PageHeader'
import { Banner } from '@/components/ui/Banner'
import { Button } from '@/components/ui/Button'
import { Field, Input } from '@/components/ui/Field'
import { saveRates } from '../actions'

export const metadata = { title: 'Internal rates' }
export const dynamic = 'force-dynamic'

export default async function RatesPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams
  const session = await requireRole('staff')
  const { rows } = await withUser(session, db => loadRates(db), { ip: await requestIp() })

  return (
    <>
      <PageHeader title="Internal rates" eyebrow="Internal · staff only" sub="Hourly rates used to value logged labor. Synthetic defaults until you change them. Never shown to clients."
        actions={<Button variant="ghost" size="sm" href="/staff/economics">Back to economics</Button>} />
      {sp.saved && <div className="mb-4"><Banner icon="check"><strong>Saved.</strong> New rates apply to every contribution figure from now on.</Banner></div>}
      {sp.error && <div className="mb-4"><Banner tone="warn"><strong>Could not save.</strong> {sp.error.replace(/-/g, ' ')}.</Banner></div>}
      <form action={saveRates} className="flex max-w-xl flex-col gap-4 rounded-[20px] border border-line p-5">
        {rows.map(r => (
          <Field key={r.key} label={`${RATE_LABELS[r.key] ?? r.label} ($ per hour)`} htmlFor={`rate_${r.key}`} hint={`Now ${dollars(r.hourly_cents)}/h · effective ${r.effective_from}`}>
            <Input id={`rate_${r.key}`} name={`rate_${r.key}`} type="number" min={0} step="0.01" defaultValue={(r.hourly_cents / 100).toFixed(2)} inputMode="decimal" />
          </Field>
        ))}
        {rows.length === 0 && <p className="text-grey">No rates seeded. Run the migrations.</p>}
        <div><Button type="submit" size="sm">Save rates</Button></div>
      </form>
    </>
  )
}
