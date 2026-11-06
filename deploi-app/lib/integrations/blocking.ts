/**
 * Why an agent cannot work on a connection, in the customer's words. A connection that needs reconnecting
 * says so (with the provider's reason) and that the agent's waiting work resumes once it is reconnected on
 * the Integrations page; the reconnection keeps the connection's id (lib/integrations/events.ts).
 */
import { admin } from '../db'

export async function officeBlockReason(orgId: string, connectionId: string | null, label: string): Promise<string> {
  if (!connectionId) return `${label} is not connected`
  const row = await admin(db => db.one<{ status: string; status_reason: string | null }>('select status, status_reason from office_connections where id = $1 and org_id = $2', [connectionId, orgId]))
  if (row?.status === 'needs_reauth') return `${label} needs to be reconnected${row.status_reason ? ` (${row.status_reason.slice(0, 160)})` : ''}; reconnect it on the Integrations page and the agent resumes its waiting work`
  return `${label} is not connected`
}

/** Store agents: the connection's own reason when it is not active (null when it is). */
export function storeBlockReason(platformLabel: string, status: string | null, reason: string | null): string | null {
  if (!status || status === 'active') return null
  if (status === 'error' && /^needs_reauth/.test(reason ?? '')) return `${platformLabel} needs to be reconnected (${(reason ?? '').replace(/^needs_reauth:\s*/, '').slice(0, 160)}); the agent resumes once it is reconnected on the Integrations page`
  if (status === 'error') return `${platformLabel} is not working${reason ? ` (${reason.slice(0, 160)})` : ''}; the agent waits until it works again`
  if (status === 'uninstalled' || status === 'disconnected') return `${platformLabel} is disconnected; the agent does not run`
  return `${platformLabel} is not ready (${status})`
}
