import type { EmailAdapter, EmailProvider } from '../types'
import { gmailAdapter } from './gmail'
import { microsoftAdapter } from './microsoft'
import { syntheticAdapter } from './synthetic'
import { deploiMailAdapter } from './deploi'
import { countWorkflow } from '../../ai/meter'

/**
 * Workflow cost (lib/ai/meter.ts): every Gmail API / Microsoft Graph call made for an account (each adapter
 * method that takes the account first) is counted for the account's organization. Synthetic accounts and
 * agent mailboxes are not counted here (agent mail is counted as email_sent when the provider accepts it).
 */
function metered(a: EmailAdapter, connector: 'gmail' | 'microsoft_graph'): EmailAdapter {
  return new Proxy(a, {
    get(target, prop, receiver) {
      const v = Reflect.get(target, prop, receiver)
      if (typeof v !== 'function') return v
      return function (this: unknown, ...args: unknown[]) {
        const acc = args[0] as { orgId?: unknown; provider?: unknown } | null
        if (acc && typeof acc === 'object' && !Array.isArray(acc) && typeof acc.orgId === 'string' && acc.provider === target.provider) countWorkflow(acc.orgId, 'provider_call', connector)
        return (v as (...x: unknown[]) => unknown).apply(this, args)
      }
    },
  })
}

const ADAPTERS: Record<EmailProvider, EmailAdapter> = { gmail: metered(gmailAdapter, 'gmail'), microsoft: metered(microsoftAdapter, 'microsoft_graph'), synthetic: syntheticAdapter, deploi: deploiMailAdapter }
export const emailAdapter = (p: EmailProvider): EmailAdapter => ADAPTERS[p]
export const EMAIL_PROVIDERS = Object.keys(ADAPTERS) as EmailProvider[]
