/** The words of billing notices and banners (pure; one place, so e-mail, banner and page agree). */
import { formatPrice } from './plans'

const day = (iso: string | null | undefined) => (iso ? iso.slice(0, 10) : null)

export function trialEndingNotice(i: { planName: string; trialEnd: string; daysLeft: number; link: string }) {
  return {
    subject: `Your Deploi trial ends in ${i.daysLeft} day${i.daysLeft === 1 ? '' : 's'}`,
    body: `Your ${i.planName} trial ends on ${day(i.trialEnd)}. To keep your AI team working after that, add a payment method: ${i.link}\n\n`
      + 'Without one, the first invoice cannot be paid: your agents keep full service through a short grace period, then pause changes and sends (everything stays visible) until payment succeeds.',
    link: i.link,
  }
}

export function paymentFailedNotice(i: { amountDueCents: number | null; currency: string | null; attempt: number; nextAttemptAt: string | null; graceEndsAt: string | null; link: string; hostedInvoiceUrl: string | null }) {
  const amount = i.amountDueCents !== null ? `${formatPrice(i.amountDueCents, i.currency ?? 'usd')} ` : ''
  const retry = i.nextAttemptAt ? `Stripe will try again on ${day(i.nextAttemptAt)}.` : 'Stripe will not retry automatically.'
  return {
    subject: 'Your Deploi payment did not go through',
    body: `We could not collect your ${amount}payment (attempt ${i.attempt}). ${retry}\n\nUpdate your payment method: ${i.link}\n`
      + (i.hostedInvoiceUrl ? `Pay the invoice now: ${i.hostedInvoiceUrl}\n` : '')
      + (i.graceEndsAt ? `\nYour agents keep full service until ${day(i.graceEndsAt)}. After that they pause changes and sends until payment succeeds; nothing is deleted.` : ''),
    link: i.link,
  }
}

export const paymentRecoveredNotice = (link: string) => ({ subject: 'Payment received: your Deploi plan is in good standing', body: `Thanks: the payment went through and your AI team has full service. Billing: ${link}`, link })

export const cancelScheduledNotice = (i: { periodEnd: string | null; link: string }) => ({
  subject: 'Your Deploi subscription is set to end',
  body: `Your subscription ends on ${day(i.periodEnd) ?? 'the end of the period'}. Until then everything works as now. After it, the account is read-only: your data stays, agents pause changes and sends. Changed your mind? Reactivate before then: ${i.link}`,
  link: i.link,
})

export const canceledNotice = (link: string) => ({
  subject: 'Your Deploi subscription has ended',
  body: `Your subscription has ended and the account is now read-only: every page and record stays visible; agents do not change your store or send email. Choose a plan any time to switch them back on: ${link}\n\nDeleting the account is a separate step in Settings.`,
  link,
})

export const readOnlyNotice = (link: string) => ({
  subject: 'Your Deploi account is read-only until payment succeeds',
  body: `The subscription is unpaid, so your agents have paused changes and sends. Everything stays visible. Update your payment method to resume: ${link}`,
  link,
})

export const planChangedNotice = (i: { planName: string; link: string }) => ({ subject: `You are now on the ${i.planName} plan`, body: `Stripe confirmed the change: the ${i.planName} limits apply from now. Billing: ${i.link}`, link: i.link })

export type BannerInput = {
  mode: 'off' | 'test' | 'live'; provider: 'stripe' | 'shopify'; status: string; readOnly: boolean; reason: string | null
  graceEndsAt: string | null; trialEnd: string | null; cancelAtPeriodEnd: boolean; currentPeriodEnd: string | null; openFailures: number
}
export type Banner = { tone: 'warn' | 'danger' | 'info'; message: string; cta: string } | null

/** The in-app billing banner (null: nothing to say). Shopify-billed stores have their own banner. */
export function billingBanner(b: BannerInput, now = new Date()): Banner {
  if (b.mode === 'off' || b.provider !== 'stripe') return null
  if (b.status === 'past_due' && !b.readOnly) return { tone: 'warn', message: `Payment failed. Update your payment method before ${day(b.graceEndsAt)} to keep your agents running.`, cta: 'Update payment method' }
  if (b.readOnly && ['past_due', 'unpaid'].includes(b.status)) return { tone: 'danger', message: 'Payment has not gone through, so your account is read-only: agents pause changes and sends. Everything stays visible.', cta: 'Update payment method' }
  if (b.readOnly && b.status === 'canceled') return { tone: 'danger', message: 'Your subscription has ended, so the account is read-only. Your data is kept.', cta: 'Choose a plan' }
  if (b.status === 'trialing' && b.trialEnd) {
    const days = Math.max(0, Math.ceil((new Date(b.trialEnd).getTime() - now.getTime()) / 86400e3))
    if (days <= 3) return { tone: 'info', message: `Your trial ends in ${days} day${days === 1 ? '' : 's'} (${day(b.trialEnd)}). Add a payment method to keep your agents running.`, cta: 'Add payment method' }
  }
  if (b.cancelAtPeriodEnd && b.currentPeriodEnd) return { tone: 'info', message: `Your subscription ends on ${day(b.currentPeriodEnd)}; after that the account is read-only.`, cta: 'Reactivate' }
  return null
}
