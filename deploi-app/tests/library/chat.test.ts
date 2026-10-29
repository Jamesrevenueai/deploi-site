import { describe, it, expect, beforeEach } from 'vitest'
import { prepareDb } from '../db/helpers'
import { NW, resetLibrary, actionsOf } from './helpers'
import { merchantActor, staffActor } from '../merchant/helpers'
import { setSwitch, teamView } from '../../lib/library/switches'
import { chat, chatHistory, setLibraryBrain } from '../../lib/library/chat'
import { runLibraryAgent } from '../../lib/library/actions'

const ready = await prepareDb()
const NOW = new Date('2026-10-29T12:00:00Z')

describe.skipIf(!ready)('chat with an agent (text and voice): answers from real data, never invents', () => {
  beforeEach(async () => { await resetLibrary(NW, 'pro'); await setSwitch(await merchantActor(NW), 'promo_manager', true) })

  it('"from now on" becomes a standing instruction the runner uses', async () => {
    const actor = await merchantActor(NW)
    const r = await chat(actor, 'promo_manager', 'From now on, propose 20% codes ending in two weeks.', 'voice')
    expect(r.agent.outcome.kind).toBe('instruction')
    expect(r.merchant.via).toBe('voice')
    expect((await teamView(actor)).agents.find(a => a.key === 'promo_manager')!.instructions).toMatch(/20%/)
    await runLibraryAgent({ orgId: NW.org, agentKey: 'promo_manager', trigger: 'test', actor: actor.label, now: NOW })
    expect((await actionsOf(NW, 'promo_manager')).find(a => a.action_type === 'create_discount')!.payload.code).toBe('MOVE20')
  })

  it('"run now" runs the agent and reports the real counts; "what is waiting" lists the queue; "approve everything" holds money actions', async () => {
    const actor = await merchantActor(NW)
    const run = await chat(actor, 'promo_manager', 'run now')
    expect(run.agent.outcome.kind).toBe('run')
    expect(run.agent.text).toMatch(/waiting for your approval/)
    const waiting = await chat(actor, 'promo_manager', "what's waiting?")
    expect(waiting.agent.outcome).toMatchObject({ kind: 'answer', detail: { waiting: expect.any(Number) } })
    expect(waiting.agent.text).toMatch(/MOVE15/)
    const approve = await chat(actor, 'promo_manager', 'approve everything')
    expect(approve.agent.outcome.kind).toBe('approved')
    expect(approve.agent.text).toMatch(/money or publishing actions, which you approve one by one/)
    const rows = await actionsOf(NW, 'promo_manager')
    expect(rows.filter(a => a.action_type === 'create_discount' || a.action_type === 'end_discount').every(a => a.status === 'draft')).toBe(true)
  })

  it('refuses what it cannot do and points to the right agent; a switched-off agent says so', async () => {
    const actor = await merchantActor(NW)
    const r = await chat(actor, 'promo_manager', 'Reply to my customers about late orders')
    expect(r.agent.outcome.kind).toBe('refused')
    expect(r.agent.text).toMatch(/Order Tracker|Customer Care/)
    await setSwitch(actor, 'promo_manager', false)
    const off = await chat(actor, 'promo_manager', 'run now')
    expect(off.agent.outcome.kind).toBe('off')
    const hist = await chatHistory(actor, 'promo_manager')
    expect(hist.map(m => m.role)).toEqual(['merchant', 'agent', 'merchant', 'agent'])
    await expect(chat(await staffActor(), 'promo_manager', 'hi')).rejects.toMatchObject({ code: 'forbidden' })
  })

  it('a model-written brain can be plugged in behind the same seam', async () => {
    const actor = await merchantActor(NW)
    setLibraryBrain(async ({ text }) => ({ text: `model says: ${text}`, outcome: { kind: 'answer' } }))
    try { expect((await chat(actor, 'promo_manager', 'hello')).agent.text).toBe('model says: hello') } finally { setLibraryBrain(null) }
  })
})
