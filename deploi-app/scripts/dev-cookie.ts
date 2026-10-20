/** Prints a signed dev-session cookie for a seeded profile (used by Lighthouse/e2e helpers). */
import { config } from 'dotenv'
config({ quiet: true })
config({ path: '.env.local', override: true, quiet: true })
import { admin } from '../lib/db'
import { encodeDevSession, DEV_COOKIE_NAME } from '../lib/auth'

const email = (process.argv[2] ?? 'hello@getdeploi.com').toLowerCase()
admin(db => db.one<{ id: string; email: string; role: 'staff' | 'client'; agency_id: string | null }>('select id, email, role, agency_id from profiles where lower(email) = $1', [email]))
  .then(p => {
    if (!p) throw new Error('no such profile')
    process.stdout.write(`${DEV_COOKIE_NAME}=${encodeDevSession({ uid: p.id, email: p.email, role: p.role, agencyId: p.agency_id })}\n`)
    process.exit(0)
  })
  .catch(e => { console.error(e.message); process.exit(1) })
