/**
 * CLI: run workers against DATABASE_URL.
 *   npx tsx workers/run.ts --all --dry-run            # every nightly worker, every agency, proposals only
 *   npx tsx workers/run.ts --worker open_shift_fill --agency <id> --send
 */
import 'dotenv/config'
import { admin } from '@/lib/db'
import { runWorker, listWorkers, WORKER_NAMES, type WorkerName } from './index'

async function main() {
  const args = process.argv.slice(2)
  const get = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined }
  const dryRun = !args.includes('--send')
  const worker = get('--worker') as WorkerName | undefined
  const agencyArg = get('--agency')
  const agencies = agencyArg ? [agencyArg] : (await admin(db => db.query<{ id: string }>('select id from agencies order by name'))).map(a => a.id)
  const names = worker ? [worker] : listWorkers().filter(w => w.nightly).map(w => w.name)
  if (worker && !WORKER_NAMES.includes(worker)) throw new Error(`unknown worker ${worker}`)
  for (const a of agencies) for (const n of names) {
    const s = await runWorker(n, a, { dryRun })
    console.log(`${n} ${a.slice(0, 8)} proposed=${s.proposed} inserted=${s.inserted} sent=${s.sent} errors=${s.errors}${dryRun ? ' (dry-run)' : ''}`)
  }
  process.exit(0)
}
main().catch(e => { console.error(e); process.exit(1) })
