/**
 * Shared email connector contract. Provider adapters (Gmail, Microsoft Graph, synthetic) implement
 * OAuth, identity, sending and, when the merchant granted it, reading. The engine owns everything
 * else: who may send what, approvals, queueing, duplicate prevention, reconciliation and statuses.
 */
export type EmailProvider = 'gmail' | 'microsoft' | 'synthetic'

export type TokenSet = { accessToken: string; refreshToken: string | null; expiresIn: number | null; scopes: string[] }
export type Identity = { address: string; displayName: string | null }

export type Attachment = { filename: string; contentType: string; contentBase64: string }
/** Exactly what is shown for approval and what is sent. */
export type MessageContent = { subject: string; bodyText: string; attachments: Attachment[] }

export type OutgoingMessage = {
  /** our own RFC 5322 Message-ID, used to find the message again after an uncertain outcome */
  internetMessageId: string
  from: string
  fromName: string | null
  to: string[]
  cc: string[]
  content: MessageContent
  /** Deploi message id, also sent as an X-Deploi-Message header */
  deploiId: string
}

export type SendResult =
  /** the provider accepted the message for delivery (not proof of delivery) */
  | { outcome: 'accepted'; providerMessageId: string | null; providerThreadId: string | null; evidence: string }
  /** definite refusal: nothing was sent */
  | { outcome: 'rejected'; code: string; message: string; auth?: boolean }
  /** definite "not now" (rate limit): nothing was sent; retry after the delay */
  | { outcome: 'throttled'; retryAfterSec: number; code: string }
  /** no definite answer (timeout, connection lost, 5xx): the message may or may not have been sent */
  | { outcome: 'uncertain'; code: string; message: string }

export type FindResult = { found: true; providerMessageId: string | null; providerThreadId: string | null } | { found: false }

export type AccountRef = { id: string; orgId: string; provider: EmailProvider; address: string; scopes: string[] }

export interface EmailAdapter {
  provider: EmailProvider
  label: string
  /** OAuth client configured in this environment */
  configured(): boolean
  scopesFor(opts: { read: boolean }): string[]
  canSend(scopes: string[]): boolean
  canRead(scopes: string[]): boolean
  /**
   * true only when "not found in Sent" is proof that a message was not sent (then one automatic resend is
   * allowed). False where the lookup itself is unverified, so an unknown outcome waits for the merchant.
   */
  reliableNotFound: boolean
  authorizeUrl(input: { state: string; codeChallenge: string; scopes: string[]; loginHint?: string | null }): string
  exchangeCode(code: string, codeVerifier: string, scopes: string[]): Promise<TokenSet>
  refresh(refreshToken: string, scopes: string[]): Promise<TokenSet>
  identity(accessToken: string): Promise<Identity>
  send(account: AccountRef, accessToken: string, msg: OutgoingMessage): Promise<SendResult>
  /** null when the granted permissions cannot look the message up (no read access) */
  findSent(account: AccountRef, accessToken: string, internetMessageId: string): Promise<FindResult | null>
  /** reply senders and times in the thread of a message we sent (never the content); needs read access */
  listReplies(account: AccountRef, accessToken: string, ref: { internetMessageId: string; providerThreadId: string | null }): Promise<{ from: string; receivedAt: string }[] | null>
  revoke(tokens: { accessToken: string | null; refreshToken: string | null }): Promise<'revoked' | 'not_supported' | 'failed'>
}

export class EmailHttpError extends Error {
  constructor(public status: number, public code: string, message: string, public retryAfterSec: number | null = null) { super(message); this.name = 'EmailHttpError' }
}
