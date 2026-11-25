/**
 * Discovery as a durable job (`discovery.run`). Queued after a connection is made (store install or
 * connect, HubSpot or Calendar connect, a mailbox) with an idempotency key per organization, connection
 * and hour, so repeated callbacks queue it once. Discovery only reads and records: it is not agent work,
 * so an organization's "stop all agents" does not cancel it (it never acts on anything).
 */
import { enqueue, registerJobHandler, type EnqueueResult } from '../jobs/queue'
import { log } from '../log'
import { runDiscovery } from './run'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

registerJobHandler('discovery.run', async payload => {
  const orgId = String(payload.orgId ?? '')
  if (!UUID.test(orgId)) return { skipped: true, reason: 'invalid organization id' }
  const { run, started } = await runDiscovery(orgId, { trigger: payload.trigger === 'manual' ? 'manual' : 'connection', source: typeof payload.source === 'string' ? payload.source : null, actor: 'system:jobs' })
  return { runId: run.id, status: run.status, started, findings: run.findings_count, casesOpened: run.cases_opened }
}, { leaseMs: 5 * 60_000, maxAttempts: 2, agentWork: false })

/** The idempotency key: one run per organization, connection and hour. */
export const discoveryKey = (source: string, at = new Date()) => `${source}@${new Date(Math.floor(at.getTime() / 3600e3) * 3600e3).toISOString()}`

/**
 * Queue discovery after a connection was made (`source`: e.g. shopify:<connection id>). Never throws:
 * a connection must not fail because discovery could not be queued (the owner can start it on demand).
 */
export async function requestDiscovery(orgId: string | null | undefined, source: string, opts: { at?: Date; trigger?: 'manual' | 'connection' } = {}): Promise<EnqueueResult | null> {
  if (!orgId || !UUID.test(orgId)) return null
  try {
    return await enqueue({ kind: 'discovery.run', orgId, payload: { orgId, source: source.slice(0, 200), trigger: opts.trigger ?? 'connection' }, idempotencyKey: discoveryKey(source.slice(0, 200), opts.at) })
  } catch (e) {
    log.warn('discovery.enqueue_failed', { org_id: orgId, source, error: (e as Error).message.slice(0, 200) })
    return null
  }
}
