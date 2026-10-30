/** Runs once when the server starts: refuse to serve production with dev auth configured. */
export async function register() {
  const { assertProductionAuth } = await import('./lib/auth-guard')
  assertProductionAuth(process.env)
}
