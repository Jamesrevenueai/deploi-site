import { requireRole } from '@/lib/auth'
import { withUser } from '@/lib/db'
import { PageHeader } from '@/components/ui/PageHeader'
import { Badge } from '@/components/ui/Badge'
import { Empty } from '@/components/ui/Empty'

export const metadata = { title: 'Early access' }
export const dynamic = 'force-dynamic'

type Row = { id: string; created_at: string; owner_name: string | null; email: string; store: string; store_url: string | null; platforms: string[] | null; catalog_size: string | null; message: string | null }

const SIZE: Record<string, string> = { under_100: 'Under 100', '100_1000': '100 to 1,000', '1000_10000': '1,000 to 10,000', over_10000: 'Over 10,000' }
const PLATFORM: Record<string, string> = { shopify: 'Shopify', woocommerce: 'WooCommerce', amazon: 'Amazon' }

/** Early access applications from getdeploi.com, newest first. Read only. */
export default async function EarlyAccessPage() {
  const session = await requireRole('staff')
  const rows = await withUser(session, db => db.query<Row>(
    `select p.id, p.created_at, p.owner_name, p.email, p.agency_name as store, p.website_url as store_url,
       array(select jsonb_array_elements_text(coalesce(p.website_details->'platforms', '[]'::jsonb))) as platforms,
       p.website_details->>'catalog_size' as catalog_size,
       (select t.body from touches t where t.prospect_id = p.id and t.subject = 'Early access application' order by t.at desc limit 1) as message
     from prospects p where p.service_interest = 'early_access' order by p.created_at desc limit 500`))
  return (
    <>
      <PageHeader title="Early access" sub="Applications from the early access form on getdeploi.com, newest first. Shopify stores come first; WooCommerce and Amazon applicants are kept for when those integrations are ready." />
      {rows.length === 0 ? <Empty title="No applications yet">Applications appear here as soon as someone submits the form.</Empty> : (
        <ul className="flex flex-col gap-3" aria-label="Early access applications">
          {rows.map(r => (
            <li key={r.id} className="rounded-[16px] border border-line p-4 text-[14px] text-grey">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium text-ink">{r.store || '(no store name)'}</span>
                {(r.platforms ?? []).map(p => <Badge key={p} tone={p === 'shopify' ? 'ok' : 'muted'}>{PLATFORM[p] ?? p}</Badge>)}
                {r.catalog_size && <Badge tone="muted">{SIZE[r.catalog_size] ?? r.catalog_size} products</Badge>}
                <span className="text-[13px] text-grey-h">{new Date(r.created_at).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' })} UTC</span>
              </div>
              <p className="pt-1">{r.owner_name ?? '—'} · <a className="text-ink underline" href={`mailto:${r.email}`}>{r.email}</a>{r.store_url && <> · <a className="break-all text-ink underline" href={r.store_url} target="_blank" rel="noopener noreferrer nofollow">{r.store_url}</a></>}</p>
              {r.message && <p className="pt-2 whitespace-pre-wrap text-ink">{r.message}</p>}
            </li>
          ))}
        </ul>
      )}
    </>
  )
}
