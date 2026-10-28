import type { EmailAdapter, EmailProvider } from '../types'
import { gmailAdapter } from './gmail'
import { microsoftAdapter } from './microsoft'
import { syntheticAdapter } from './synthetic'
import { deploiMailAdapter } from './deploi'

const ADAPTERS: Record<EmailProvider, EmailAdapter> = { gmail: gmailAdapter, microsoft: microsoftAdapter, synthetic: syntheticAdapter, deploi: deploiMailAdapter }
export const emailAdapter = (p: EmailProvider): EmailAdapter => ADAPTERS[p]
export const EMAIL_PROVIDERS = Object.keys(ADAPTERS) as EmailProvider[]
