/** Stores a fake offline token for the synthetic Northwind store (local proof of the uninstall path only). */
import 'dotenv/config'
import { admin } from '../lib/db'
import { storeCredential } from '../lib/connectors/credentials'
import { uuidFrom } from '../lib/ids'
const url = process.env.DATABASE_URL ?? ''
if (!/@(127\.0\.0\.1|localhost)[:/]/.test(url)) { console.error('refusing: DATABASE_URL is not a local database'); process.exit(1) }
const conn = uuidFrom('connection:northwind'), org = uuidFrom('merchant:northwind')
admin(db => storeCredential(db, { connectionId: conn, orgId: org, secret: 'shpat_synthetic_test_token', tokenKind: 'offline', scopes: ['read_products', 'read_inventory', 'read_locations'], expiresAt: null, refreshSecret: null, refreshExpiresAt: null, actor: 'proof:dev-store-credential' }))
  .then(() => { console.log('credential stored for', conn); process.exit(0) }).catch(e => { console.error(e.message); process.exit(1) })
