/**
 * Payment adapter. There is NO live payment path in this build: every checkout is simulated and
 * is labelled so. A key alone never enables live payments; PAYMENTS_LIVE=true AND a provider key
 * are both required, and even then the live path is NotImplemented until it is built and authorised.
 * Mock results must never be recorded as real payments (see lib/credit/ledger.ts recordCreditPayment
 * and lib/website for the separate "mock_paid" state).
 */
const e = (k: string) => (process.env[k] ?? '').trim()

export type CheckoutRequest = { amountCents: number; purpose: 'assessment_fee' | 'setup_fee' | 'monthly_fee' | 'website_fee'; ref: string; description?: string }
export type CheckoutResult = { ok: boolean; mocked: true; id: string; status: 'simulated'; amountCents: number; purpose: CheckoutRequest['purpose']; ref: string; label: 'Simulated payment (no money moved)' }

export const mockPayments: CheckoutResult[] = []

export function paymentsMode(): 'mock' | 'live_not_implemented' {
  return e('PAYMENTS_LIVE') === 'true' && e('STRIPE_SECRET_KEY') ? 'live_not_implemented' : 'mock'
}

export async function createCheckout(req: CheckoutRequest): Promise<CheckoutResult> {
  if (!Number.isInteger(req.amountCents) || req.amountCents <= 0) throw new Error('amount must be a positive whole number of cents')
  if (paymentsMode() === 'live_not_implemented') throw new Error('Live payments are not implemented in this build; unset PAYMENTS_LIVE')
  const r: CheckoutResult = { ok: true, mocked: true, id: `mockpay_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, status: 'simulated', amountCents: req.amountCents, purpose: req.purpose, ref: req.ref, label: 'Simulated payment (no money moved)' }
  mockPayments.push(r)
  return r
}
