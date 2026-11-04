/**
 * Read-only smoke test against a real Shopify development store (scripts/shopify-devstore-check.ts).
 * It sends queries only: every document is checked before it is sent and anything containing a
 * mutation is refused. The first query asks Shopify whether the shop is a development store; any other
 * store stops the check before anything else is read. Nothing here writes to the database either.
 */
import { assertApprovedHost } from '../../net/outbound'
import { normalizeShop } from './auth'
import { Q_SHOP, Q_ACCESS_SCOPES, Q_VARIANTS, Q_PUBLICATIONS, docFor } from './queries'
import { REQUIRED_SCOPES, OPTIONAL_SCOPES } from './config'
import { normalizeVariant, type GqlVariant } from './normalize'
import type { QueryCost } from './client'

export type CheckLine = { name: string; ok: boolean; detail: string }
export type CheckReport = { shop: string; ok: boolean; refused: string | null; lines: CheckLine[] }

/** Refuse anything that is not a plain query (a mutation or subscription anywhere in the document). */
export function assertReadOnly(doc: string) {
  const code = doc.replace(/#.*$/gm, '')
  if (/\b(mutation|subscription)\b/i.test(code)) throw new Error('refused: the dev-store check sends queries only')
  if (!/^\s*(query\b|fragment\b|\{)/.test(code)) throw new Error('refused: not a query document')
}

type Gql = { data?: Record<string, unknown>; errors?: { message: string; extensions?: { code?: string } }[]; extensions?: { cost?: QueryCost } }

export async function runDevstoreCheck(input: { shop: string; accessToken: string; apiVersion: string; fetchImpl?: typeof fetch }): Promise<CheckReport> {
  const shop = normalizeShop(input.shop)
  const lines: CheckLine[] = []
  const report = (refused: string | null): CheckReport => ({ shop: shop ?? input.shop, ok: !refused && lines.every(l => l.ok), refused, lines })
  if (!shop) return report('not a valid *.myshopify.com shop domain')
  if (!input.accessToken) return report('no access token given')
  if (!/^\d{4}-\d{2}$/.test(input.apiVersion)) return report('the API version must look like 2026-10')
  const url = `https://${shop}/admin/api/${input.apiVersion}/graphql.json`
  assertApprovedHost(url, 'shopify')
  const fetchImpl = input.fetchImpl ?? fetch
  const gql = async (query: string, operationName: string, variables: Record<string, unknown> = {}): Promise<Gql> => {
    assertReadOnly(query)
    const res = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json', 'x-shopify-access-token': input.accessToken }, body: JSON.stringify({ query, operationName, variables }) })
    if (res.status === 401 || res.status === 403) throw new Error(`HTTP ${res.status}: the token was refused (expired, revoked, or the app is not installed)`)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return await res.json() as Gql
  }
  const step = async (name: string, fn: () => Promise<string>) => {
    try { lines.push({ name, ok: true, detail: await fn() }) } catch (e) { lines.push({ name, ok: false, detail: (e as Error).message.slice(0, 300) }) }
  }

  // 1. development store only, decided by Shopify, before anything else is read
  let shopJson: Gql
  try { shopJson = await gql(Q_SHOP, 'DeploiShop') } catch (e) { lines.push({ name: 'install status', ok: false, detail: (e as Error).message }); return report(null) }
  const s = shopJson.data?.shop as { name?: string; myshopifyDomain?: string; plan?: { partnerDevelopment?: boolean; publicDisplayName?: string } } | undefined
  if (!s) { lines.push({ name: 'install status', ok: false, detail: shopJson.errors?.map(e => e.message).join('; ') ?? 'no shop in the response' }); return report(null) }
  if (s.plan?.partnerDevelopment !== true) return report(`refused: ${shop} is not a development store (plan: ${s.plan?.publicDisplayName ?? 'unknown'}); this check only runs on development stores`)
  if (s.myshopifyDomain && s.myshopifyDomain.toLowerCase() !== shop) return report(`refused: the token belongs to ${s.myshopifyDomain}, not ${shop}`)
  lines.push({ name: 'install status', ok: true, detail: `installed on "${s.name}" (${s.plan.publicDisplayName ?? 'development store'}); token accepted` })

  // 2. granted scopes against what the app installs with
  let granted: string[] = []
  await step('scopes', async () => {
    const j = await gql(Q_ACCESS_SCOPES, 'DeploiAccessScopes')
    granted = ((j.data?.currentAppInstallation as { accessScopes?: { handle: string }[] } | undefined)?.accessScopes ?? []).map(x => x.handle).sort()
    const missing = REQUIRED_SCOPES.filter(x => !granted.includes(x) && !(x === 'read_products' && granted.includes('write_products')))
    const unexpected = granted.filter(x => ![...REQUIRED_SCOPES, ...OPTIONAL_SCOPES].includes(x))
    if (missing.length) throw new Error(`missing required scopes: ${missing.join(', ')} (granted: ${granted.join(', ') || 'none'})`)
    return `granted: ${granted.join(', ')}${unexpected.length ? `; not requested by the app: ${unexpected.join(', ')}` : ''}`
  })

  // 3. one page of variants, with the query cost Shopify reports
  await step('variants (one page)', async () => {
    const j = await gql(docFor(Q_VARIANTS, granted), 'DeploiVariants', { first: 25, after: null })
    if (j.errors?.length) throw new Error(j.errors.map(e => `${e.extensions?.code ?? 'ERROR'}: ${e.message}`).join('; '))
    const nodes = ((j.data?.productVariants as { nodes?: GqlVariant[] } | undefined)?.nodes ?? [])
    const at = new Date().toISOString()
    const records = nodes.map(n => normalizeVariant(n, at))
    const cost = j.extensions?.cost
    const tracked = records.filter(r => r.tracked).length
    return `${records.length} variant(s) read, ${tracked} tracked, ${records.filter(r => typeof r.totalAvailable === 'number' && r.totalAvailable <= 0).length} at or below zero available` +
      (cost ? `; query cost requested ${cost.requestedQueryCost ?? '?'}, actual ${cost.actualQueryCost ?? '?'}, bucket ${cost.throttleStatus?.currentlyAvailable ?? '?'}/${cost.throttleStatus?.maximumAvailable ?? '?'} restoring ${cost.throttleStatus?.restoreRate ?? '?'}/s` : '; no cost information returned')
  })

  // 4. sales channels (needs read_publications, an optional scope)
  if (granted.includes('read_publications')) await step('publications', async () => {
    const j = await gql(Q_PUBLICATIONS, 'DeploiPublications')
    if (j.errors?.length) throw new Error(j.errors.map(e => e.message).join('; '))
    const pubs = ((j.data?.publications as { nodes?: { id: string; catalog: { title: string } | null }[] } | undefined)?.nodes ?? [])
    return `${pubs.length} channel(s): ${pubs.map(p => p.catalog?.title ?? p.id).join(', ') || 'none listed for this app'}`
  })
  else lines.push({ name: 'publications', ok: true, detail: 'skipped: read_publications is not granted (optional; requested when a publication agent is widened)' })
  return report(null)
}

export function formatReport(r: CheckReport): string {
  const out = [`Shopify development-store check: ${r.shop}`, '']
  if (r.refused) out.push(`REFUSED  ${r.refused}`)
  for (const l of r.lines) out.push(`${l.ok ? 'PASS' : 'FAIL'}  ${l.name}: ${l.detail}`)
  out.push('', r.refused ? 'Result: refused (nothing was read beyond the shop details)' : r.ok ? 'Result: PASS (read only; nothing was changed)' : 'Result: FAIL (read only; nothing was changed)')
  return out.join('\n')
}
