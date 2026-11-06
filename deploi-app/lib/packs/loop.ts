/**
 * Every pack agent runs through the shared agent loop (lib/events/loop.ts: detect -> mode check -> act ->
 * verify with a fresh read -> proof -> owner update). runPackLoop adds what the pack dashboards show: one
 * pack_activity row per agent and problem (what happened, what the agent did, the proof, the outcome), and
 * an owner update when the agent could not finish (missing data, a provider that refused).
 */
import type { Db } from '../db'
import { runAgentLoop, type LoopOutcome, type LoopSpec } from '../events/loop'
import { notifyOwner, type ProofItem } from '../notify'
import type { PackKey } from './registry'

/** Thrown from act when the agent cannot finish without the owner (missing data, nobody to send to ...). */
export class PackBlocked extends Error { constructor(message: string) { super(`blocked: ${message}`); this.name = 'PackBlocked' } }

export type PackOutcome = LoopOutcome | { status: 'already_done' }

export async function runPackLoop<P>(db: Db, pack: PackKey, spec: LoopSpec<P>): Promise<PackOutcome> {
  const prior = await db.one<{ status: string }>('select status from pack_activity where org_id = $1 and agent_key = $2 and problem_key = $3', [spec.orgId, spec.agentKey, spec.problemKey])
  if (prior?.status === 'done') return { status: 'already_done' }
  let described: ReturnType<LoopSpec<P>['describe']> | null = null
  // a failed act leaves nothing half-written in this transaction
  const act: LoopSpec<P>['act'] = async (d, p) => {
    await d.query('savepoint pack_act')
    try { const r = await spec.act(d, p); await d.query('release savepoint pack_act'); return r } catch (e) { await d.query('rollback to savepoint pack_act'); throw e }
  }
  const out = await runAgentLoop(db, { ...spec, act, describe: p => (described = spec.describe(p)) })
  if (out.status === 'nothing_to_do') return out
  const d = described as ReturnType<LoopSpec<P>['describe']> | null
  const blocked = out.status === 'failed' && out.error.startsWith('blocked: ')
  const status = blocked ? 'blocked' : out.status
  const proof: ProofItem[] = out.status === 'done' || out.status === 'not_verified' ? out.proof : []
  const error = out.status === 'failed' ? out.error.replace(/^blocked: /, '').slice(0, 1000) : null
  await db.query(`insert into pack_activity (org_id, pack, agent_key, problem_key, status, mode, title, what_happened, what_i_did, proof, error)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
    on conflict (org_id, agent_key, problem_key) do update set status = excluded.status, mode = excluded.mode, title = excluded.title, what_happened = excluded.what_happened,
      what_i_did = excluded.what_i_did, proof = excluded.proof, error = excluded.error, runs = pack_activity.runs + 1`,
    [spec.orgId, pack, spec.agentKey, spec.problemKey.slice(0, 300), status, out.status === 'done' ? out.mode : null, (d?.title ?? spec.agentName).slice(0, 300),
      (d?.whatHappened ?? '').slice(0, 2000), JSON.stringify(d?.whatIDid ?? []), JSON.stringify(proof), error])
  if (out.status === 'failed') {
    await notifyOwner({ orgId: spec.orgId, agentKey: spec.agentKey, agentName: spec.agentName, headline: blocked ? `${spec.agentName} needs you` : `${spec.agentName} could not finish`,
      whatHappened: d?.whatHappened ?? spec.agentName, whatIDid: [blocked ? `I stopped: ${error}` : `It stopped on an error: ${error}`], proof: [], severity: 'warning',
      detailsPath: spec.detailsPath ?? `/store/packs/${pack}`, dedupeKey: `${spec.agentKey}:${spec.problemKey}:${blocked ? 'blocked' : 'failed'}` })
  }
  return out
}
