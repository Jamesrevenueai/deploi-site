/**
 * Synthetic mailbox for demos and tests: nothing leaves Deploi. "Sent" messages are recorded in
 * synthetic_email_state with their sender, recipients and subject, so tests can see exactly what
 * would have gone out and inject the provider outcomes the engine must handle (refusals, rate
 * limits, revoked access, and answers lost before or after the provider accepted the message).
 */
import { randomBytes } from 'node:crypto'
import { admin } from '../../db'
import type { AccountRef, EmailAdapter, OutgoingMessage } from '../types'

export type SynthMailFault = {
  op: 'send' | 'find' | 'refresh'
  mode: 'reject_recipient' | 'auth_revoked' | 'rate_limited' | 'timeout_before_accept' | 'timeout_after_accept' | 'server_error_after_accept' | 'error'
  remaining: number
}
export type SynthMailState = {
  sent: { id: string; threadId: string; internetMessageId: string; from: string; to: string[]; cc: string[]; subject: string; attachments: number; at: string }[]
  replies: { threadId: string; from: string; at: string }[]
  faults: SynthMailFault[]
}
export const SYNTH_SEND = 'synthetic.send'
export const SYNTH_READ = 'synthetic.read'
const empty = (): SynthMailState => ({ sent: [], replies: [], faults: [] })

export async function getSynthMail(accountId: string): Promise<SynthMailState> {
  return admin(async db => (await db.one<{ state: SynthMailState }>('select state from synthetic_email_state where account_id = $1', [accountId]))?.state ?? empty())
}
export async function mutateSynthMail(accountId: string, fn: (s: SynthMailState) => void) {
  await admin(async db => {
    const row = await db.one<{ state: SynthMailState }>('select state from synthetic_email_state where account_id = $1 for update', [accountId])
    const s = row?.state ?? empty()
    fn(s)
    await db.query(`insert into synthetic_email_state (account_id, state) values ($1,$2) on conflict (account_id) do update set state = excluded.state, updated_at = now()`, [accountId, JSON.stringify(s)])
  })
}
export const injectMailFault = (accountId: string, f: Omit<SynthMailFault, 'remaining'> & { remaining?: number }) =>
  mutateSynthMail(accountId, s => { s.faults.push({ remaining: 1, ...f }) })
export const addSynthReply = (accountId: string, threadId: string, from: string) =>
  mutateSynthMail(accountId, s => { s.replies.push({ threadId, from: from.toLowerCase(), at: new Date().toISOString() }) })

function takeFault(s: SynthMailState, op: SynthMailFault['op']): SynthMailFault | null {
  const f = s.faults.find(x => x.op === op && x.remaining > 0)
  if (!f) return null
  f.remaining--
  s.faults = s.faults.filter(x => x.remaining > 0)
  return f
}

/** Synthetic consent: the "code" carries the address the tester typed on the synthetic consent page. */
export const syntheticCode = (address: string, scopes: string[]) => `syn.${Buffer.from(JSON.stringify({ address, scopes })).toString('base64url')}`
export const isSyntheticAddress = (a: string) => /@[a-z0-9-]+(\.[a-z0-9-]+)*\.(example|test|invalid)$/i.test(a)

export const syntheticAdapter: EmailAdapter = {
  provider: 'synthetic',
  label: 'Synthetic mailbox (test only)',
  configured: () => true,
  scopesFor: ({ read }) => [SYNTH_SEND, ...(read ? [SYNTH_READ] : [])],
  canSend: s => s.includes(SYNTH_SEND),
  canRead: s => s.includes(SYNTH_READ),
  reliableNotFound: true,
  authorizeUrl: ({ state, scopes }) => `/api/email/oauth/synthetic?state=${encodeURIComponent(state)}${scopes.includes(SYNTH_READ) ? '&want_read=1' : ''}`,
  async exchangeCode(code) {
    if (!code.startsWith('syn.')) throw new Error('invalid synthetic code')
    const { address, scopes } = JSON.parse(Buffer.from(code.slice(4), 'base64url').toString()) as { address: string; scopes: string[] }
    if (!isSyntheticAddress(address)) throw new Error('synthetic accounts use .example, .test or .invalid addresses')
    return { accessToken: `synthetic:${address}:${randomBytes(8).toString('hex')}`, refreshToken: `synthetic-refresh:${address}`, expiresIn: 3600, scopes }
  },
  async refresh(refreshToken, scopes) {
    const address = refreshToken.replace(/^synthetic-refresh:/, '')
    return { accessToken: `synthetic:${address}:${randomBytes(8).toString('hex')}`, refreshToken, expiresIn: 3600, scopes }
  },
  async identity(accessToken) {
    const address = accessToken.split(':')[1] ?? ''
    return { address, displayName: `${address.split('@')[0]} (synthetic)` }
  },
  async send(account: AccountRef, _token: string, msg: OutgoingMessage) {
    let result: Awaited<ReturnType<EmailAdapter['send']>> | null = null
    await mutateSynthMail(account.id, s => {
      const f = takeFault(s, 'send')
      const record = () => {
        const id = `syn-msg-${randomBytes(6).toString('hex')}`
        const threadId = `syn-thread-${randomBytes(6).toString('hex')}`
        s.sent.push({ id, threadId, internetMessageId: msg.internetMessageId, from: msg.from, to: msg.to, cc: msg.cc, subject: msg.content.subject, attachments: msg.content.attachments.length, at: new Date().toISOString() })
        return { id, threadId }
      }
      if (f?.mode === 'reject_recipient') result = { outcome: 'rejected', code: 'http_400', message: 'the provider refused the message: invalid recipient (synthetic)' }
      else if (f?.mode === 'auth_revoked') result = { outcome: 'rejected', code: 'auth', message: 'the provider rejected the connection; reconnect the account', auth: true }
      else if (f?.mode === 'rate_limited') result = { outcome: 'throttled', retryAfterSec: 30, code: 'rate_limited' }
      else if (f?.mode === 'timeout_before_accept') result = { outcome: 'uncertain', code: 'timeout', message: 'no response from the provider' }
      else if (f?.mode === 'timeout_after_accept') { record(); result = { outcome: 'uncertain', code: 'timeout', message: 'no response from the provider' } }
      else if (f?.mode === 'server_error_after_accept') { record(); result = { outcome: 'uncertain', code: 'http_503', message: 'the provider had an error; the message may or may not have been sent' } }
      else { const r = record(); result = { outcome: 'accepted', providerMessageId: r.id, providerThreadId: r.threadId, evidence: 'the synthetic mailbox recorded the message' } }
    })
    return result!
  },
  async findSent(account, _token, internetMessageId) {
    if (!account.scopes.includes(SYNTH_READ)) return null
    const s = await getSynthMail(account.id)
    let fault: SynthMailFault | null = null
    await mutateSynthMail(account.id, st => { fault = takeFault(st, 'find') })
    if (fault) throw new Error('lookup failed (synthetic)')
    const m = s.sent.find(x => x.internetMessageId === internetMessageId)
    return m ? { found: true, providerMessageId: m.id, providerThreadId: m.threadId } : { found: false }
  },
  async listReplies(account, _token, ref) {
    if (!account.scopes.includes(SYNTH_READ) || !ref.providerThreadId) return null
    const s = await getSynthMail(account.id)
    return s.replies.filter(r => r.threadId === ref.providerThreadId).map(r => ({ from: r.from, receivedAt: r.at }))
  },
  revoke: async () => 'revoked',
}
