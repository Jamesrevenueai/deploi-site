import { describe, it, expect } from 'vitest'
import {
  emailWords, EMAIL_STATUS_WORDS, EMAIL_ACCEPTED_EXPLAINER, emailAccountWords, EMAIL_PROVIDER_STATUS_WORDS,
  AGENT_EMAIL_TASKS, AGENT_EMAIL_TASK_LABEL, AGENT_EMAIL_PERMISSIONS, AGENT_EMAIL_PERMISSION_LABEL,
} from '../../components/store/format'
import { EMAIL_TASKS, EMAIL_TASK_LABEL, EMAIL_PERMISSIONS, EMAIL_PERMISSION_LABEL } from '../../lib/agents/policy'

describe('truthful merchant email status labels', () => {
  it('maps every email engine status to its merchant label', () => {
    expect(emailWords('draft').label).toBe('Draft')
    expect(emailWords('awaiting_approval').label).toBe('Awaiting approval')
    expect(emailWords('queued').label).toBe('Queued')
    expect(emailWords('sending').label).toBe('Sending')
    expect(emailWords('accepted').label).toBe('Accepted by provider')
    expect(emailWords('failed').label).toBe('Failed')
    expect(emailWords('delivery_unknown').label).toBe('Delivery unknown')
    expect(emailWords('cancelled').label).toBe('Cancelled')
    expect(Object.keys(EMAIL_STATUS_WORDS).sort()).toEqual(['accepted', 'awaiting_approval', 'cancelled', 'delivery_unknown', 'draft', 'failed', 'queued', 'sending'])
  })

  it('shows success only for "Accepted by provider" and never claims delivery', () => {
    const ok = Object.entries(EMAIL_STATUS_WORDS).filter(([, w]) => w.tone === 'ok').map(([k]) => k)
    expect(ok).toEqual(['accepted'])
    expect(emailWords('something_new').tone).not.toBe('ok')
    expect(emailWords('accepted').hint).toBe(EMAIL_ACCEPTED_EXPLAINER)
    expect(EMAIL_ACCEPTED_EXPLAINER).toBe('The provider accepted it for delivery. Deploi cannot confirm it reached the inbox.')
    for (const w of Object.values(EMAIL_STATUS_WORDS)) {
      expect(w.label).not.toMatch(/delivered|sent successfully/i)
      expect(w.hint).not.toMatch(/\bwas delivered|sent successfully/i)
    }
  })

  it('labels account health and provider availability honestly', () => {
    expect(emailAccountWords('active').label).toBe('Connected')
    expect(emailAccountWords('needs_reauth').label).toBe('Needs reconnect')
    expect(emailAccountWords('error').label).toBe('Error')
    expect(emailAccountWords('disconnected').label).toBe('Disconnected')
    expect(EMAIL_PROVIDER_STATUS_WORDS.configured_unverified.hint).toBe('Available: not yet verified by the provider for public use')
    expect(EMAIL_PROVIDER_STATUS_WORDS.not_configured.hint).toBe('Not available yet (needs setup)')
    expect(EMAIL_PROVIDER_STATUS_WORDS.test_only.hint).toBe('Synthetic mailbox: test only, nothing is ever emailed')
  })

  it('keeps the browser copies of email tasks and permissions in step with the policy', () => {
    expect([...AGENT_EMAIL_TASKS]).toEqual([...EMAIL_TASKS])
    expect(AGENT_EMAIL_TASK_LABEL).toEqual(EMAIL_TASK_LABEL)
    expect([...AGENT_EMAIL_PERMISSIONS]).toEqual([...EMAIL_PERMISSIONS])
    expect(AGENT_EMAIL_PERMISSION_LABEL).toEqual(EMAIL_PERMISSION_LABEL)
  })
})
