/** Wait for `p` at most `ms`; a late result is dropped (the work itself cannot be cancelled, it just stops being waited for). */
export class DiscoveryTimeout extends Error { constructor(public ms: number) { super(`did not answer within ${Math.round(ms / 1000)} s`); this.name = 'DiscoveryTimeout' } }

export function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined
  const timer = new Promise<never>((_, reject) => { t = setTimeout(() => reject(new DiscoveryTimeout(ms)), Math.max(1, ms)) })
  p.catch(() => undefined) // a rejection after the timeout is not an unhandled rejection
  return Promise.race([p, timer]).finally(() => clearTimeout(t))
}
