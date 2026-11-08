/**
 * "Your team" never shows two rows that look the same (2026-11-08 preview finding: Inventory Watcher and Store Health
 * Checker were listed twice). Both rows were real agents: the library agent and a custom agent built from the template
 * of the same name. Both stay; the custom one is labelled a custom agent and told apart in its name.
 */
import '../merchant/env'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import { prepareDb } from '../db/helpers'
import { admin } from '../../lib/db'
import type { Actor } from '../../lib/engine/actor'
import { team } from '../../lib/app/contract'
import { NW, merchantActor } from '../merchant/helpers'

const ready = await prepareDb()
const ids = [randomUUID(), randomUUID()]

describe.skipIf(!ready)('Your team: same-named agents', () => {
  let owner: Actor
  beforeAll(async () => {
    owner = await merchantActor(NW)
    await admin(async db => {
      await db.query(`insert into library_switches (org_id, agent_key, enabled, permission, switched_by) values ($1, 'inventory_watcher', true, 'draft', 'test')
        on conflict (org_id, agent_key) do update set enabled = true`, [NW.org])
      await db.query(`insert into agents (id, org_id, connection_id, name, status, created_by) values ($1,$2,$3,'Inventory Watcher','paused','test'), ($4,$2,$3,'Restock Helper','paused','test')`, [ids[0], NW.org, NW.conn, ids[1]])
    })
  })
  afterAll(() => admin(db => db.query('delete from agents where id = any($1)', [ids])))

  it('lists both, the custom one as "(custom)", with no two rows of the same name', async () => {
    const store = await team(owner, 'store')
    const names = store.map(a => a.name)
    expect(names).toContain('Inventory Watcher')
    expect(store.find(a => a.id === `store:${ids[0]}`)).toMatchObject({ name: expect.stringMatching(/^Inventory Watcher \(custom( \d+)?\)$/), area: 'Custom agent' })
    // a custom agent whose name is its own keeps it
    expect(store.find(a => a.id === `store:${ids[1]}`)).toMatchObject({ name: 'Restock Helper', area: 'Custom agent' })
    expect(new Set(names.map(n => n.toLowerCase())).size).toBe(names.length)
  })
})
