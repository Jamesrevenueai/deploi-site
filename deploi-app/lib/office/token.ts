/** Token sources for provider clients, and the refresh-once-on-401 wrapper every new client uses. */
import { OfficeHttpError } from './http'

/** What a provider client asks for a token: the current one, or a new one after the provider refused `rejected`. */
export type TokenSource = { get(): Promise<string>; refresh(rejected: string): Promise<string> }

/** A fixed token (tests, and the identity read right after the code exchange): a refusal is final. */
export const fixedToken = (t: string): TokenSource => ({ get: async () => t, refresh: async () => { throw new OfficeHttpError(401, 'auth', 'the provider refused the authorization', 'hubspot') } })

/**
 * One provider call with the connection's token. A 401 refreshes the token once and repeats the call
 * (a 401 means the provider did not act on the request, so repeating a write is safe). A second 401 is final.
 */
export async function withOfficeToken<T>(src: TokenSource, call: (token: string) => Promise<T>): Promise<T> {
  const t = await src.get()
  try { return await call(t) } catch (e) {
    if (!(e instanceof OfficeHttpError) || e.code !== 'auth') throw e
    return call(await src.refresh(t))
  }
}
