/**
 * Entry point for `shopify app dev` (see shopify.web.toml). The CLI sets PORT (and SHOPIFY_API_KEY,
 * SHOPIFY_API_SECRET, SHOPIFY_APP_URL, SCOPES) in this process's environment; it does not expand $PORT in the
 * command line, so this script reads it and starts the production build on that port.
 */
import { spawn } from 'node:child_process'
const port = process.env.PORT || '3000'
const child = spawn('npx', ['next', 'start', '-p', port], { stdio: 'inherit', env: process.env })
child.on('exit', code => process.exit(code ?? 1))
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig))
