/** Transactional email. Resend when RESEND_API_KEY is set, otherwise a mock that records sends. */
import { env, COMPANY_EMAIL, COMPANY_NAME } from '../env'
import { log } from '../log'

export type EmailMessage = { to: string | string[]; subject: string; html?: string; text?: string; replyTo?: string }
export type SendResult = { ok: boolean; id?: string; mocked: boolean; error?: string }

export const FROM = `${COMPANY_NAME} <${COMPANY_EMAIL}>`
export const mockOutbox: EmailMessage[] = []

export async function sendEmail(msg: EmailMessage): Promise<SendResult> {
  const to = Array.isArray(msg.to) ? msg.to : [msg.to]
  if (!env.resendKey) {
    mockOutbox.push(msg)
    log.info('email.mock', { recipients: to.length, subjectLength: msg.subject.length })
    return { ok: true, id: `mock_${Date.now()}`, mocked: true }
  }
  try {
    const { Resend } = await import('resend')
    const resend = new Resend(env.resendKey)
    const r = await resend.emails.send({ from: FROM, to, subject: msg.subject, html: msg.html, text: msg.text ?? ' ', replyTo: msg.replyTo })
    if (r.error) return { ok: false, mocked: false, error: r.error.message }
    log.info('email.sent', { recipients: to.length })
    return { ok: true, id: r.data?.id, mocked: false }
  } catch (e) {
    log.error('email.failed', { error: (e as Error).message })
    return { ok: false, mocked: false, error: (e as Error).message }
  }
}
