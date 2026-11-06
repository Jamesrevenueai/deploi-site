/** Runs once when the server starts: refuse to serve production with dev auth configured. */
export async function register() {
  const { assertProductionAuth } = await import('./lib/auth-guard')
  assertProductionAuth(process.env)
  ;(await import('./lib/billing/config')).assertBillingStartup(process.env) // BILLING_MODE=live needs production and a live key; test mode refuses a live key
}
