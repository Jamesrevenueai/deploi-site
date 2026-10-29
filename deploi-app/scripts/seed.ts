/**
 * Idempotent seed for the Deploi agent platform: the two staff logins and two synthetic merchants
 * (Northwind Goods and Harbor Supply), each with an owner login, a synthetic Shopify store,
 * reference files and demo agents. All names are synthetic. Every row has a deterministic id, so
 * `npm run seed` can run any number of times.
 */
import 'dotenv/config'
import { Client } from 'pg'
import { uuidFrom } from '../lib/ids'
import { runSeedParts } from './seed-parts'

export async function seed(databaseUrl = process.env.DATABASE_URL, opts: { client?: Client } = {}) {
  if (!databaseUrl && !opts.client) throw new Error('DATABASE_URL required')
  const c = opts.client ?? new Client({ connectionString: databaseUrl, ssl: databaseUrl!.includes('supabase.co') ? { rejectUnauthorized: false } : undefined })
  await c.connect()
  const counts: Record<string, number> = {}

  // ---------------------------------------------------------------- staff logins
  const users = [
    { key: 'user:hello', email: 'hello@getdeploi.com', full_name: 'Deploi Staff' },
    { key: 'user:ojae', email: 'ojae@getdeploi.com', full_name: 'Ojae' },
  ]
  const hasSupabaseAdmin = Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY)
  for (const u of users) {
    let id: string | null = (await c.query('select id from auth.users where lower(email) = lower($1)', [u.email])).rows[0]?.id ?? null
    if (!id) {
      if (hasSupabaseAdmin) {
        const { createClient } = await import('@supabase/supabase-js')
        const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
        const { data, error } = await sb.auth.admin.createUser({ email: u.email, email_confirm: true, user_metadata: { full_name: u.full_name } })
        if (error) throw error
        id = data.user.id
      } else {
        id = uuidFrom(u.key)
        await c.query('insert into auth.users (id, email) values ($1, $2) on conflict (id) do nothing', [id, u.email])
      }
    }
    await c.query(
      `insert into profiles (id, email, full_name, role, agency_id) values ($1,$2,$3,'staff',null)
       on conflict (id) do update set email = excluded.email, full_name = excluded.full_name, role = 'staff', agency_id = null`,
      [id, u.email, u.full_name])
  }
  counts.profiles = users.length

  await runSeedParts({ c, counts })

  await c.end()
  return counts
}

if (process.argv[1] && /seed\.ts$/.test(process.argv[1])) {
  seed().then(counts => { console.log('seed complete:', counts) }).catch(e => { console.error(e); process.exit(1) })
}
