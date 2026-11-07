/**
 * The twelve commerce agents as rules and templates (no model is called). Each agent's `find` reads the store and
 * returns the problems it sees; each problem knows how to re-check itself (the loop's detect), what to do (act),
 * how to confirm it with a fresh read (verify), and how to undo it where that is possible.
 *
 * Problem keys are shared across agents for the same thing (e.g. 'product:<id>:promoted_oos' for Campaign and
 * Promo Manager), so two agents never act on the same product or order twice.
 * Templates use only facts read from the store; nothing is invented (no claims, no dates, no amounts not read).
 */
import type { ProofItem } from '../../notify'
import { notifyCrew } from '../../notify'
import { CommerceError, plainText, wordCount, type CommerceStore, type COrder, type CProduct, type CReturn, type CMail, type CrewMember, type Supplier, type StorePolicy } from './store'

export type PackSettings = StorePolicy & {
  /** never act on a best seller with more than this many units */
  lowStockUnits: number
  /** best sellers: the top N products by units sold in the last 30 days, with at least bestSellerMinUnits */
  bestSellerTop: number
  bestSellerMinUnits: number
  stalledTrackingDays: number
  supplierFollowUpDays: number
  minDescriptionWords: number
  /** hard limit on one automatic refund, in the store currency (applies in both modes) */
  refundCap: number
  suppliers: Supplier[]
  packers: CrewMember[]
}
export const DEFAULT_SETTINGS: PackSettings = {
  returnWindowDays: 30, promisedDispatchDays: 2, feeRatePct: 2.9, feeFixed: 0.3,
  lowStockUnits: 5, bestSellerTop: 3, bestSellerMinUnits: 3, stalledTrackingDays: 5, supplierFollowUpDays: 3, minDescriptionWords: 15, refundCap: 200,
  suppliers: [], packers: [],
}

export type Ctx = { orgId: string; agentKey: string; store: CommerceStore; settings: PackSettings; now: Date; shopName: string }
export type Undo = { kind: string; payload: Record<string, unknown> }
export type ActResult = { proof: ProofItem[]; undo?: Undo | null; facts?: Record<string, unknown> }
export type Problem = {
  /** stable and shared across agents for the same thing */
  key: string
  /** short name of the rule that found it, e.g. 'stuck_order' */
  kind: string
  /** autonomy action type (lib/autonomy): money actions are 'refund', 'discount', 'payout_dispute' */
  actionType: string
  recordIds: string[]
  title: string
  whatHappened: string
  whatIDid: string[]
  evidence: Record<string, unknown>
  /** re-read the store: is the problem still there? */
  stillThere: (c: Ctx) => Promise<boolean>
  act: (c: Ctx) => Promise<ActResult>
  verify: (c: Ctx, done: ActResult) => Promise<{ ok: boolean; proof: ProofItem[] }>
  /** the owner must choose: the agent did only the safe part; each option is the exact action to take */
  ownerDecision?: { question: string; options: Record<string, { label: string; run: (c: Ctx) => Promise<{ ok: boolean; proof: ProofItem[] }> }> }
}
export type CommerceAgent = { key: string; name: string; job: string; triggers: string[]; actions: string[]; scoped: boolean; find: (c: Ctx) => Promise<Problem[]> }

// ---------------------------------------------------------------- helpers
const DAY = 864e5
const days = (from: string | null | undefined, now: Date) => (from ? (now.getTime() - new Date(from).getTime()) / DAY : 0)
const money = (n: number | string) => `$${Number(n).toFixed(2)}`
const p = (label: string, value: string | number, url?: string | null): ProofItem => ({ label, value: String(value), ...(url ? { url } : {}) })
const isoWeek = (d: Date) => {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
  const dayNum = t.getUTCDay() || 7
  t.setUTCDate(t.getUTCDate() + 4 - dayNum)
  const y = t.getUTCFullYear()
  return `${y}-W${String(Math.ceil(((t.getTime() - Date.UTC(y, 0, 1)) / DAY + 1) / 7)).padStart(2, '0')}`
}
const EXEMPT = /pre-?order|backorder|made-?to-?order/i
const sold = (o: COrder) => !o.cancelled
const email = (shop: string, name: string, lines: string[]) => `Hi ${name},\n\n${lines.join('\n\n')}\n\nThanks,\n${shop}`
const sentWith = async (c: Ctx, id: string, mustContain: string[]) => {
  const m = (await c.store.sent()).find(x => x.id === id)
  return { ok: Boolean(m) && mustContain.every(s => m!.text.includes(s)), proof: [p('Fresh read of sent mail', m ? `found ${m.id} to ${m.to}: "${m.subject}"` : `message ${id} not found`)] }
}
/** facts per product: units sold in 30 days and the daily rate */
async function salesByProduct(c: Ctx) {
  const units = new Map<string, number>()
  for (const o of (await c.store.orders()).filter(sold)) if (days(o.createdAt, c.now) <= 30) for (const i of o.items) units.set(i.productId, (units.get(i.productId) ?? 0) + i.quantity)
  return units
}
const variantOf = async (c: Ctx, variantId: string) => {
  for (const pr of await c.store.products()) { const v = pr.variants.find(x => x.id === variantId); if (v) return { product: pr, variant: v } }
  return null
}
const productOf = async (c: Ctx, id: string) => (await c.store.products()).find(x => x.id === id) ?? null
const orderOf = async (c: Ctx, id: string) => (await c.store.orders()).find(x => x.id === id) ?? null
const outOfStock = (pr: CProduct) => pr.variants.length > 0 && pr.variants.every(v => v.tracked && (v.available ?? 0) <= 0 && v.inventoryPolicy === 'DENY')

// ---------------------------------------------------------------- Inventory Watcher (+ hand-off to Supplier Chaser)
const inventoryWatcher: CommerceAgent = {
  key: 'inventory_watcher', name: 'Inventory Watcher', scoped: false,
  job: 'Watches stock on every sale and stock change; asks the supplier to restock a best seller before it runs out and stops products selling past zero.',
  triggers: ['inventory_levels/update', 'orders/create', 'products/update', 'sweep'], actions: ['reorder', 'update_inventory_policy'],
  async find(c) {
    const out: Problem[] = []
    const units = await salesByProduct(c)
    const ranked = [...units.entries()].filter(([, u]) => u >= c.settings.bestSellerMinUnits).sort((a, b) => b[1] - a[1]).slice(0, c.settings.bestSellerTop).map(([id]) => id)
    const suppliers = [...c.settings.suppliers, ...(await c.store.suppliers())]
    for (const pr of (await c.store.products()).filter(x => x.status === 'ACTIVE')) {
      for (const v of pr.variants) {
        if (!v.tracked || v.available === null) continue
        // selling past zero: out of stock but still sold (not a pre-order or backorder product)
        if (v.available <= 0 && v.inventoryPolicy === 'CONTINUE' && !pr.tags.some(t => EXEMPT.test(t))) {
          out.push({
            key: `variant:${v.id}:selling_past_zero`, kind: 'selling_past_zero', actionType: 'update_inventory_policy', recordIds: [pr.id, v.id],
            title: `${pr.title} was selling with no stock; I stopped it`, whatHappened: `${pr.title}${v.title !== 'Default Title' ? ` (${v.title})` : ''} has ${v.available} in stock and was set to keep selling when out of stock, so customers could buy what you do not have.`,
            whatIDid: ['Set the variant to stop selling at zero (Shopify: "Continue selling when out of stock" off).', 'It sells again as soon as stock arrives.'],
            evidence: { productId: pr.id, variantId: v.id, available: v.available, inventoryPolicy: v.inventoryPolicy, tags: pr.tags },
            stillThere: async cc => { const f = await variantOf(cc, v.id); return Boolean(f && f.variant.inventoryPolicy === 'CONTINUE' && (f.variant.available ?? 1) <= 0) },
            act: async cc => { const ch = await cc.store.setInventoryPolicy(v.id, 'DENY'); return { proof: [p('Inventory policy', `${ch.before} -> ${ch.after}`)], undo: { kind: 'commerce.restore_inventory_policy', payload: { variantId: v.id, policy: ch.before } } } },
            verify: async cc => { const f = await variantOf(cc, v.id); return { ok: f?.variant.inventoryPolicy === 'DENY', proof: [p('Fresh read: inventory policy', f?.variant.inventoryPolicy ?? 'not found')] } },
          })
        }
        if (!ranked.includes(pr.id) || v.available < 0) continue
        const rate = (units.get(pr.id) ?? 0) / 30
        const supplier = suppliers.find(s => s.vendor.toLowerCase() === (pr.vendor ?? '').toLowerCase()) ?? null
        const lead = supplier?.leadTimeDays ?? 14
        const threshold = Math.max(c.settings.lowStockUnits, Math.ceil(rate * lead))
        if (v.available > threshold) continue
        const qty = Math.max(10, Math.ceil(rate * (lead + 30)) - v.available)
        const subject = `Restock request: ${pr.title}`
        const text = `Hello,\n\nCould you confirm availability and lead time for:\n\n- ${pr.title}${v.title !== 'Default Title' ? ` (${v.title})` : ''}${v.sku ? `, SKU ${v.sku}` : ''}: ${qty} units\n\nWe have ${v.available} left and sell about ${(rate * 7).toFixed(1)} a week.\n\nThanks,\n${c.shopName}`
        const base = {
          key: `restock:${v.id}:${isoWeek(c.now)}`, kind: 'best_seller_low_stock', actionType: 'reorder', recordIds: [pr.id, v.id],
          evidence: { productId: pr.id, variantId: v.id, available: v.available, threshold, unitsSold30d: units.get(pr.id) ?? 0, rank: ranked.indexOf(pr.id) + 1, supplier: supplier?.email ?? null, leadTimeDays: lead, quantity: qty },
          stillThere: async (cc: Ctx) => { const f = await variantOf(cc, v.id); return Boolean(f && (f.variant.available ?? Infinity) <= threshold) },
        }
        if (!supplier) {
          out.push({ ...base, title: `${pr.title} is running low and has no supplier on file`, whatHappened: `${pr.title} is a best seller (${units.get(pr.id)} sold in 30 days) with ${v.available} left.`,
            whatIDid: [`I could not ask for a restock: no supplier is set for the vendor "${pr.vendor ?? 'unknown'}". Add the supplier's email in Supplier Chaser and I will send the request.`],
            act: async () => ({ proof: [p('Stock', v.available ?? 0)] }), verify: async () => ({ ok: true, proof: [p('Supplier on file', 'none')] }),
            ownerDecision: { question: `Who supplies ${pr.title}?`, options: {} } })
          continue
        }
        out.push({ ...base, title: `${pr.title} is running low; Supplier Chaser asked ${supplier.name} for ${qty} more`,
          whatHappened: `${pr.title} is your #${ranked.indexOf(pr.id) + 1} best seller (${units.get(pr.id)} sold in 30 days) and has ${v.available} left, about ${rate > 0 ? Math.floor(v.available / rate) : 'many'} days of stock against a ${lead}-day lead time.`,
          whatIDid: [`Supplier Chaser emailed ${supplier.name} (${supplier.email}) for ${qty} units and will follow up if there is no reply in ${c.settings.supplierFollowUpDays} days.`],
          act: async cc => { const m = await cc.store.sendEmail({ to: supplier.email, subject, text, inReplyTo: null, agentKey: 'supplier_chaser' }); return { proof: [p('Restock request sent', `${m.id} to ${supplier.email}`), p('Quantity asked for', qty)], facts: { messageId: m.id } } },
          verify: async (cc, done) => sentWith(cc, String(done.facts?.messageId), [pr.title, String(qty)]),
        })
      }
    }
    return out
  },
}

// ---------------------------------------------------------------- Supplier Chaser
const supplierChaser: CommerceAgent = {
  key: 'supplier_chaser', name: 'Supplier Chaser', scoped: false,
  job: 'Sends restock requests for Inventory Watcher, follows up when a supplier goes quiet and tells you what they replied.',
  triggers: ['mail.received', 'sweep'], actions: ['send_supplier_email'],
  async find(c) {
    const out: Problem[] = []
    const sent = await c.store.sent(), inbox = await c.store.inbox()
    const suppliers = [...c.settings.suppliers, ...(await c.store.suppliers())]
    const known = new Set(suppliers.map(s => s.email.toLowerCase()))
    for (const m of sent.filter(x => x.agentKey === 'supplier_chaser' && x.subject.startsWith('Restock request'))) {
      const replied = inbox.some(r => r.from.toLowerCase() === m.to.toLowerCase() && new Date(r.receivedAt) > new Date(m.sentAt))
      const chased = sent.some(x => x.inReplyTo === m.id)
      if (replied || chased || days(m.sentAt, c.now) < c.settings.supplierFollowUpDays) continue
      const text = `Hello,\n\nFollowing up on our restock request of ${m.sentAt.slice(0, 10)} (below). Could you confirm availability and a ship date?\n\nThanks,\n${c.shopName}\n\n> ${m.text.split('\n').join('\n> ')}`
      out.push({
        key: `followup:${m.id}`, kind: 'restock_no_reply', actionType: 'send_supplier_email', recordIds: [m.id],
        title: `No reply from ${m.to} in ${Math.floor(days(m.sentAt, c.now))} days; I followed up`, whatHappened: `The restock request "${m.subject}" sent ${m.sentAt.slice(0, 10)} has had no reply.`,
        whatIDid: [`Sent a follow-up to ${m.to} quoting the original request.`], evidence: { messageId: m.id, to: m.to, sentAt: m.sentAt },
        stillThere: async cc => !(await cc.store.sent()).some(x => x.inReplyTo === m.id) && !(await cc.store.inbox()).some(r => r.from.toLowerCase() === m.to.toLowerCase() && new Date(r.receivedAt) > new Date(m.sentAt)),
        act: async cc => { const s = await cc.store.sendEmail({ to: m.to, subject: `Following up: ${m.subject}`, text, inReplyTo: m.id, agentKey: 'supplier_chaser' }); return { proof: [p('Follow-up sent', `${s.id} to ${m.to}`)], facts: { messageId: s.id } } },
        verify: async (cc, done) => sentWith(cc, String(done.facts?.messageId), ['Following up']),
      })
    }
    for (const r of inbox.filter(x => known.has(x.from.toLowerCase()))) {
      const eta = /(?:ship|dispatch|deliver)\w*\s+(?:on|by)\s+([A-Z][a-z]+ \d{1,2}|\d{4}-\d{2}-\d{2})/i.exec(r.text)?.[1] ?? /(\d+)\s+(working\s+)?(days|weeks)/i.exec(r.text)?.[0] ?? null
      out.push({
        key: `supplier_reply:${r.id}`, kind: 'supplier_replied', actionType: 'notify_owner', recordIds: [r.id],
        title: `${r.from} replied${eta ? `: ${eta}` : ''}`, whatHappened: `Your supplier replied to a restock request ("${r.subject}").`,
        whatIDid: [eta ? `Read the date from their reply: ${eta}.` : 'Their reply has no date I can read for certain; it is in your mailbox.', 'No reply sent; nothing changed in the store.'],
        evidence: { mailId: r.id, from: r.from, eta },
        stillThere: async () => true, act: async () => ({ proof: [p('Supplier reply', `${r.id} from ${r.from}`)] }), verify: async cc => ({ ok: (await cc.store.inbox()).some(x => x.id === r.id), proof: [p('Fresh read of mailbox', `reply ${r.id} present`)] }),
      })
    }
    return out
  },
}

// ---------------------------------------------------------------- Order Tracker
const orderTracker: CommerceAgent = {
  key: 'order_tracker', name: 'Order Tracker', scoped: true,
  job: 'Spots orders that have not shipped on time or whose tracking stopped moving; tells the customer and gets the packer on it.',
  triggers: ['orders/create', 'orders/updated', 'orders/fulfilled', 'fulfillments/create', 'fulfillments/update', 'crew.done', 'sweep'], actions: ['send_customer_email', 'crew_message'],
  async find(c) {
    const out: Problem[] = []
    // packers come from the one crew roster (crew_members); a packer named in the agent's settings counts only when it
    // is on that roster (matched by id, address or name), so every message goes to someone notifyCrew can reach
    const roster = await c.store.crew()
    const named = c.settings.packers.map(k => roster.find(r => r.id === k?.id || (Boolean(k?.address) && r.address.toLowerCase() === String(k.address).toLowerCase()) || (Boolean(k?.name) && r.name.toLowerCase() === String(k.name).toLowerCase()))).filter((x): x is CrewMember => Boolean(x))
    const packers = [...new Map([...named, ...roster.filter(x => x.role === 'packer')].map(x => [x.id, x])).values()]
    for (const o of (await c.store.orders()).filter(x => !x.cancelled)) {
      const age = days(o.createdAt, c.now)
      if (o.fulfillmentStatus !== 'fulfilled' && age > c.settings.promisedDispatchDays) {
        const late = Math.floor(age)
        const body = email(c.shopName, o.customerFirstName, [
          `Thank you for your order ${o.name}. It has not left us yet: we promise to dispatch within ${c.settings.promisedDispatchDays} days and this one is late. I am sorry about that.`,
          'It is with our packing team now. You will get the tracking number by email the moment it ships.',
        ])
        const lines = o.items.map(i => `- ${i.quantity} x ${i.title}`).join('\n')
        out.push({
          key: `order:${o.id}:stuck`, kind: 'stuck_order', actionType: 'send_customer_email', recordIds: [o.id],
          title: `${o.name} is ${late} days old and not shipped; I told ${o.customerFirstName} and the packer`, whatHappened: `${o.name} (${money(o.total)}) was placed ${late} days ago and is still ${o.fulfillmentStatus}; you promise dispatch within ${c.settings.promisedDispatchDays} days.`,
          whatIDid: [`Emailed ${o.customerFirstName} (${o.email}) an apology and what happens next.`, packers.length ? `Asked ${packers.map(x => x.name).join(', ')} to pack it today.` : 'No packer is on file, so nobody was messaged: add one in Settings, Crew (role Packer).'],
          evidence: { orderId: o.id, orderName: o.name, createdAt: o.createdAt, ageDays: late, fulfillmentStatus: o.fulfillmentStatus, promisedDispatchDays: c.settings.promisedDispatchDays },
          stillThere: async cc => { const f = await orderOf(cc, o.id); return Boolean(f && !f.cancelled && f.fulfillmentStatus !== 'fulfilled') },
          act: async cc => {
            // a retry (e.g. after a packer message failed) must not email the customer a second time: reuse the delay email already sent
            const subject = `Your order ${o.name}: an update`
            const m = (await cc.store.sent()).find(x => x.agentKey === 'order_tracker' && x.to === o.email && x.subject === subject)
              ?? await cc.store.sendEmail({ to: o.email, subject, text: body, inReplyTo: null, agentKey: 'order_tracker' })
            const proof = [p('Delay email sent', `${m.id} to ${o.email}`)]
            const crew: string[] = []
            for (const k of packers) {
              const r = await notifyCrew({ orgId: cc.orgId, crewMemberId: k.id, jobRef: o.name, subject: `Please pack ${o.name} today`, body: `${o.name} for ${o.customerFirstName} is ${late} days old and not shipped.\n\n${lines}\n\nReply "done" when it is packed.`, dedupeKey: `order_tracker:${o.id}:pack:${k.id}` })
              proof.push(p(`Packer message to ${k.name}`, r.status)); crew.push(r.status)
            }
            return { proof, facts: { messageId: m.id, crew } }
          },
          verify: async (cc, done) => {
            const v = await sentWith(cc, String(done.facts?.messageId), [o.name])
            const crewOk = ((done.facts?.crew as string[]) ?? []).every(s => s !== 'failed')
            return { ok: v.ok && crewOk, proof: [...v.proof, p('Packer messages', crewOk ? 'accepted' : 'one or more failed')] }
          },
        })
      }
      const t = o.tracking
      if (o.fulfillmentStatus === 'fulfilled' && t && !t.deliveredAt && t.lastEventAt && days(t.lastEventAt, c.now) >= c.settings.stalledTrackingDays) {
        const body = email(c.shopName, o.customerFirstName, [
          `Your order ${o.name} shipped on ${t.shippedAt.slice(0, 10)}${t.carrier ? ` with ${t.carrier}` : ''}${t.number ? `, tracking number ${t.number}` : ''}.`,
          `The carrier's last update was "${t.lastEvent}" on ${t.lastEventAt.slice(0, 10)}, which is longer than usual. We are checking with them and will write again within two working days.${t.url ? `\n\nTrack it here: ${t.url}` : ''}`,
        ])
        out.push({
          key: `order:${o.id}:tracking_stalled`, kind: 'tracking_stalled', actionType: 'send_customer_email', recordIds: [o.id],
          title: `${o.name}: tracking has not moved in ${Math.floor(days(t.lastEventAt, c.now))} days; I updated ${o.customerFirstName}`, whatHappened: `${o.name} shipped ${t.shippedAt.slice(0, 10)}; the last carrier event was "${t.lastEvent}" on ${t.lastEventAt.slice(0, 10)}.`,
          whatIDid: [`Emailed ${o.customerFirstName} the tracking details and that you are checking with the carrier.`, 'You may want to open a trace with the carrier.'],
          evidence: { orderId: o.id, trackingNumber: t.number, lastEvent: t.lastEvent, lastEventAt: t.lastEventAt },
          stillThere: async cc => { const f = await orderOf(cc, o.id); return Boolean(f?.tracking && !f.tracking.deliveredAt && f.tracking.lastEventAt === t.lastEventAt) },
          act: async cc => { const m = await cc.store.sendEmail({ to: o.email, subject: `Your order ${o.name}: tracking update`, text: body, inReplyTo: null, agentKey: 'order_tracker' }); return { proof: [p('Tracking update sent', `${m.id} to ${o.email}`)], facts: { messageId: m.id } } },
          verify: async (cc, done) => sentWith(cc, String(done.facts?.messageId), [t.number ?? o.name]),
        })
      }
    }
    return out
  },
}

// ---------------------------------------------------------------- Returns
const DAMAGED = /DEFECTIVE|DAMAGED|damaged|broken|cracked|faulty/
const WORN = /\b(worn|used|washed)\b/i
function returnDecision(r: CReturn, s: PackSettings, now: Date): { fits: boolean; damaged: boolean; why: string } {
  const since = r.deliveredAt ? Math.floor(days(r.deliveredAt, now)) : null
  const damaged = DAMAGED.test(r.reason) || DAMAGED.test(r.note)
  if (since === null) return { fits: false, damaged, why: 'there is no delivery date on the order' }
  if (damaged && since <= s.returnWindowDays && Number(r.amount) <= s.refundCap) return { fits: true, damaged, why: `arrived damaged, reported ${since} days after delivery` }
  if (since > s.returnWindowDays) return { fits: false, damaged, why: `requested ${since} days after delivery; your window is ${s.returnWindowDays} days` }
  if (WORN.test(r.note) && !/unused|unworn|not (been )?(worn|used)/i.test(r.note)) return { fits: false, damaged, why: 'the customer says it has been used' }
  if (Number(r.amount) > s.refundCap) return { fits: false, damaged, why: `the refund of ${money(r.amount)} is above your automatic limit of ${money(s.refundCap)}` }
  return { fits: true, damaged, why: `requested ${since} days after delivery, inside your ${s.returnWindowDays}-day window` }
}
const returnsAgent: CommerceAgent = {
  key: 'returns', name: 'Returns', scoped: true,
  job: 'Approves return and refund requests that fit your policy, refunds damaged items, and brings you the rest with both replies ready.',
  triggers: ['returns/request', 'returns/update', 'refunds/create', 'sweep'], actions: ['refund', 'send_customer_email'],
  async find(c) {
    const out: Problem[] = []
    for (const r of (await c.store.returns()).filter(x => x.status === 'requested')) {
      const d = returnDecision(r, c.settings, c.now)
      const evidence = { returnId: r.id, orderId: r.orderId, orderName: r.orderName, reason: r.reason, amount: r.amount, deliveredAt: r.deliveredAt, policy: d.why, returnWindowDays: c.settings.returnWindowDays }
      const stillThere = async (cc: Ctx) => (await cc.store.returns()).some(x => x.id === r.id && x.status === 'requested')
      const approve = async (cc: Ctx): Promise<ActResult> => {
        const ch = await cc.store.approveReturn(r.id)
        const proof = [p('Return status', `${ch.before} -> ${ch.after}`)]
        let refundId: string | null = null
        if (d.damaged) { const f = await cc.store.refund({ orderId: r.orderId, lineItemId: r.lineItemId, quantity: r.quantity, amount: r.amount, note: `Damaged on arrival (${r.reason}); refunded under the returns policy` }); refundId = f.id; proof.push(p('Refund issued', `${money(f.amount)} (${f.id})`)) }
        const m = await cc.store.sendEmail({ to: r.email, subject: `Your return for ${r.orderName}`, inReplyTo: null, agentKey: 'returns', text: email(cc.shopName, r.customerFirstName, [
          `Your return of the ${r.itemTitle} from ${r.orderName} is approved.`,
          d.damaged ? `I am sorry it arrived damaged. There is no need to send it back: I have refunded ${money(r.amount)} to your original payment method.` : `You will receive the return label from Shopify by email. Your refund of ${money(r.amount)} is issued as soon as the item is back with us.`,
        ]) })
        proof.push(p('Customer told', `${m.id} to ${r.email}`))
        return { proof, facts: { refundId, messageId: m.id } }
      }
      const checkApproved = async (cc: Ctx, done: ActResult) => {
        const fresh = (await cc.store.returns()).find(x => x.id === r.id)
        const refunds = d.damaged ? await cc.store.refunds(r.orderId) : []
        const refundOk = !d.damaged || refunds.some(f => f.id === done.facts?.refundId && Math.abs(Number(f.amount) - Number(r.amount)) < 0.005)
        const mail = await sentWith(cc, String(done.facts?.messageId), [r.orderName])
        return { ok: fresh?.status === 'open' && refundOk && mail.ok, proof: [p('Fresh read: return status', fresh?.status ?? 'not found'), ...(d.damaged ? [p('Fresh read: refunds on the order', refunds.map(f => `${f.id} ${money(f.amount)}`).join(', ') || 'none')] : []), ...mail.proof] }
      }
      if (d.fits) {
        out.push({
          key: `return:${r.id}`, kind: d.damaged ? 'return_damaged' : 'return_in_policy', actionType: 'refund', recordIds: [r.id, r.orderId], evidence, stillThere,
          title: `Return on ${r.orderName} approved${d.damaged ? ` and ${money(r.amount)} refunded` : ''}`, whatHappened: `${r.customerFirstName} asked to return the ${r.itemTitle} from ${r.orderName} (${r.reason.toLowerCase().replace(/_/g, ' ')}${r.note ? `: "${r.note}"` : ''}). It fits your policy: ${d.why}.`,
          whatIDid: ['Approved the return in Shopify.', d.damaged ? `Refunded ${money(r.amount)} without asking for the item back.` : `The refund of ${money(r.amount)} is due when the item is back.`, `Emailed ${r.customerFirstName}.`],
          act: approve, verify: checkApproved,
        })
        continue
      }
      // outside the policy: acknowledge the customer, and bring the owner both options ready to go
      const holding = email(c.shopName, r.customerFirstName, [`Thanks for your return request for the ${r.itemTitle} from ${r.orderName}. We are looking at it and will reply within one working day.`])
      out.push({
        key: `return:${r.id}`, kind: 'return_outside_policy', actionType: 'send_customer_email', recordIds: [r.id, r.orderId], evidence, stillThere,
        title: `Return on ${r.orderName} needs your decision`, whatHappened: `${r.customerFirstName} asked to return the ${r.itemTitle} (${money(r.amount)}) from ${r.orderName}. It is outside your policy: ${d.why}.`,
        whatIDid: [`Told ${r.customerFirstName} we will reply within one working day.`, 'Nothing approved or refunded. Choose: approve (return label, refund when it is back) or decline (a polite reply citing your policy).'],
        act: async cc => { const m = await cc.store.sendEmail({ to: r.email, subject: `Your return request for ${r.orderName}`, text: holding, inReplyTo: null, agentKey: 'returns' }); return { proof: [p('Holding reply sent', `${m.id} to ${r.email}`)], facts: { messageId: m.id } } },
        verify: async (cc, done) => sentWith(cc, String(done.facts?.messageId), [r.orderName]),
        ownerDecision: {
          question: `Approve or decline the return on ${r.orderName}?`,
          options: {
            approve: { label: 'Approve the return', run: async cc => { const done = await approve(cc); const v = await checkApproved(cc, done); return { ok: v.ok, proof: [...done.proof, ...v.proof] } } },
            decline: { label: 'Decline with a reply citing the policy', run: async cc => {
              const ch = await cc.store.declineReturn(r.id, d.why)
              const m = await cc.store.sendEmail({ to: r.email, subject: `Your return request for ${r.orderName}`, inReplyTo: null, agentKey: 'returns', text: email(cc.shopName, r.customerFirstName, [`Thanks for your patience. I am not able to accept this return: ${d.why}.`, 'If something is wrong with the item, reply with a photo and we will look again.']) })
              const fresh = (await cc.store.returns()).find(x => x.id === r.id)
              return { ok: fresh?.status === 'declined', proof: [p('Return status', `${ch.before} -> ${ch.after}`), p('Decline reply sent', m.id), p('Fresh read: return status', fresh?.status ?? 'not found')] }
            } },
          },
        },
      })
    }
    return out
  },
}

// ---------------------------------------------------------------- Listing Writer
/** A description from the product's own facts only. Null when there are not enough facts to write anything true. */
export function descriptionFromFacts(pr: CProduct): string | null {
  const options = pr.variants.map(v => v.title).filter(t => t && t !== 'Default Title')
  const facts = [pr.vendor, pr.productType, pr.material, pr.care, pr.dimensions, options.length ? 'options' : null].filter(Boolean)
  if (facts.length < 2) return null
  const s: string[] = []
  s.push(`The ${pr.title}${pr.vendor ? ` from ${pr.vendor}` : ''}${pr.productType ? ` is part of our ${pr.productType.toLowerCase()} range` : ''}.`)
  if (pr.material) s.push(`Made from ${pr.material.charAt(0).toLowerCase()}${pr.material.slice(1)}.`)
  if (pr.dimensions) s.push(`Size: ${pr.dimensions}.`)
  if (options.length) s.push(`Available in ${options.join(', ')}.`)
  if (pr.care) s.push(`Care: ${pr.care}.`)
  return s.map(x => `<p>${x.replace(/[<>&]/g, ch => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[ch]!)}</p>`).join('')
}
const listingWriter: CommerceAgent = {
  key: 'listing_writer', name: 'Listing Writer', scoped: true,
  job: 'Rewrites thin or missing product descriptions from the facts already in the listing; never adds a claim that is not there.',
  triggers: ['products/create', 'products/update', 'sweep'], actions: ['update_listing'],
  async find(c) {
    const out: Problem[] = []
    for (const pr of (await c.store.products()).filter(x => x.status === 'ACTIVE')) {
      const words = wordCount(pr.description)
      if (words >= c.settings.minDescriptionWords) continue
      const html = descriptionFromFacts(pr)
      const evidence = { productId: pr.id, title: pr.title, descriptionWords: words, before: pr.descriptionHtml, facts: { vendor: pr.vendor, productType: pr.productType, material: pr.material, care: pr.care, dimensions: pr.dimensions } }
      const stillThere = async (cc: Ctx) => { const f = await productOf(cc, pr.id); return Boolean(f && wordCount(f.description) < cc.settings.minDescriptionWords) }
      if (!html) {
        out.push({ key: `product:${pr.id}:description`, kind: 'thin_facts_description', actionType: 'update_listing', recordIds: [pr.id], evidence, stillThere,
          title: `${pr.title} needs a description, and I need facts to write it`, whatHappened: `${pr.title} has ${words ? `a ${words}-word description` : 'no description'}, and the listing has no vendor, type, material or options I could write from.`,
          whatIDid: ['Nothing changed: I only write what the listing already says. Add the material, size or product type and I will write it.'],
          act: async () => ({ proof: [p('Description words', words)] }), verify: async () => ({ ok: true, proof: [p('Listing unchanged', pr.id)] }),
          ownerDecision: { question: `What is ${pr.title} made of, and what size is it?`, options: {} } })
        continue
      }
      out.push({ key: `product:${pr.id}:description`, kind: 'weak_description', actionType: 'update_listing', recordIds: [pr.id], evidence, stillThere,
        title: `Rewrote the description of ${pr.title}`, whatHappened: `${pr.title} had ${words ? `a ${words}-word description ("${pr.description.slice(0, 80)}")` : 'no description'}, which is too thin for shoppers and search.`,
        whatIDid: [`Wrote a ${wordCount(plainText(html))}-word description from the listing's own facts (${[pr.vendor && 'vendor', pr.productType && 'type', pr.material && 'material', pr.care && 'care', pr.dimensions && 'size'].filter(Boolean).join(', ')}).`, 'No claims added. Undo puts the old text back.'],
        act: async cc => { const ch = await cc.store.setDescription(pr.id, html); return { proof: [p('New description', plainText(ch.after))], undo: { kind: 'commerce.restore_description', payload: { productId: pr.id, html: ch.before } } } },
        verify: async cc => { const f = await productOf(cc, pr.id); return { ok: f?.descriptionHtml === html, proof: [p('Fresh read: description', f ? plainText(f.descriptionHtml).slice(0, 200) : 'not found')] } },
      })
    }
    return out
  },
}

// ---------------------------------------------------------------- promoted out of stock (Campaign and Promo Manager share the key)
async function promotedOutOfStock(c: Ctx): Promise<Problem[]> {
  const out: Problem[] = []
  const products = await c.store.products()
  for (const col of (await c.store.collections()).filter(x => x.promoted)) for (const pid of col.productIds) {
    const pr = products.find(x => x.id === pid)
    if (!pr || pr.status !== 'ACTIVE' || !outOfStock(pr)) continue
    const evidence = { productId: pr.id, collectionId: col.id, collection: col.title, available: pr.variants.map(v => v.available) }
    const base = { key: `product:${pr.id}:promoted_oos`, kind: 'promoted_out_of_stock', actionType: 'update_collection', recordIds: [pr.id, col.id], evidence,
      stillThere: async (cc: Ctx) => { const f = await productOf(cc, pr.id); const k = (await cc.store.collections()).find(x => x.id === col.id); return Boolean(f && outOfStock(f) && k?.productIds.includes(pr.id)) } }
    if (col.smart) {
      out.push({ ...base, title: `${pr.title} is out of stock but still in ${col.title}`, whatHappened: `${pr.title} cannot be bought (out of stock) and is promoted in ${col.title}, an automated collection I cannot edit.`,
        whatIDid: ['Nothing changed: change the collection conditions, or add an in-stock condition.'], act: async () => ({ proof: [p('Collection', `${col.title} (automated)`)] }), verify: async () => ({ ok: true, proof: [p('Unchanged', col.title)] }), ownerDecision: { question: `Change the conditions of ${col.title}?`, options: {} } })
      continue
    }
    out.push({ ...base, title: `${pr.title} is out of stock; I took it out of ${col.title}`, whatHappened: `${pr.title} has no stock and cannot be bought, but it was promoted in ${col.title}, where shoppers land and leave.`,
      whatIDid: [`Removed it from ${col.title}. The product page stays live.`, 'Undo puts it back; do that when stock arrives.'],
      act: async cc => { const ch = await cc.store.removeFromCollection(col.id, pr.id); return { proof: [p(col.title, `${ch.before} -> ${ch.after}`)], undo: { kind: 'commerce.readd_to_collection', payload: { collectionId: col.id, productId: pr.id } } } },
      verify: async cc => { const k = (await cc.store.collections()).find(x => x.id === col.id); return { ok: Boolean(k && !k.productIds.includes(pr.id)), proof: [p(`Fresh read: ${col.title}`, k ? (k.productIds.includes(pr.id) ? 'still contains the product' : 'product removed') : 'not found')] } },
    })
  }
  return out
}
const campaign: CommerceAgent = {
  key: 'campaign', name: 'Campaign', scoped: true,
  job: 'Keeps what you promote buyable: takes sold-out products out of featured collections and puts them back when you undo.',
  triggers: ['inventory_levels/update', 'products/update', 'collections/update', 'sweep'], actions: ['update_collection'],
  find: promotedOutOfStock,
}

// ---------------------------------------------------------------- Promo Manager
const promoManager: CommerceAgent = {
  key: 'promo_manager', name: 'Promo Manager', scoped: true,
  job: 'Ends discounts that are past their end date or point only at sold-out products, and takes expired codes off the storefront banner.',
  triggers: ['discounts/create', 'discounts/update', 'inventory_levels/update', 'products/update', 'sweep'], actions: ['discount', 'update_collection'],
  async find(c) {
    const out: Problem[] = [...await promotedOutOfStock(c)]
    let banner: string | null = null, bannerReadable = true
    try { banner = await c.store.announcement() } catch (e) { if (e instanceof CommerceError && e.code === 'not_wired') bannerReadable = false; else throw e }
    const products = await c.store.products()
    for (const d of await c.store.discounts()) {
      const ended = d.endsAt && new Date(d.endsAt).getTime() < c.now.getTime()
      const advertised = Boolean(banner && d.code && banner.toUpperCase().includes(d.code.toUpperCase()))
      if (ended && (d.status === 'active' || advertised)) {
        out.push({
          key: `discount:${d.id}:expired_advertised`, kind: 'expired_discount_advertised', actionType: 'discount', recordIds: [d.id],
          title: `${d.code} ended ${d.endsAt!.slice(0, 10)}${advertised ? ' but was still on your banner' : ' but was still active'}; I switched it off`,
          whatHappened: `${d.code} (${d.percent}% off) was due to end on ${d.endsAt!.slice(0, 10)}.${d.status === 'active' ? ' It was still active, so customers could keep using it.' : ''}${advertised ? ` Your storefront banner still said "${banner}".` : ''}`,
          whatIDid: [...(d.status === 'active' ? [`Deactivated ${d.code} in Shopify.`] : []), ...(advertised ? ['Removed the banner text that advertised it.'] : []), ...(!bannerReadable ? ['I cannot read your storefront banner on a live store: check it does not still mention the code.'] : []), 'Undo turns the code back on and restores the banner.'],
          evidence: { discountId: d.id, code: d.code, endsAt: d.endsAt, status: d.status, banner },
          stillThere: async cc => { const f = (await cc.store.discounts()).find(x => x.id === d.id); let b: string | null = null; try { b = await cc.store.announcement() } catch { b = null } return Boolean(f && (f.status === 'active' || (b && b.toUpperCase().includes(d.code.toUpperCase())))) },
          act: async cc => {
            const proof: ProofItem[] = []
            let wasActive = false
            if (d.status === 'active') { const ch = await cc.store.deactivateDiscount(d.id); wasActive = true; proof.push(p(d.code, `${ch.before} -> ${ch.after}`)) }
            if (advertised) { const ch = await cc.store.setAnnouncement(null); proof.push(p('Banner', `"${ch.before}" -> "${ch.after}"`)) }
            return { proof, undo: { kind: 'commerce.restore_discount', payload: { discountId: d.id, reactivate: wasActive, announcement: advertised ? banner : null } } }
          },
          verify: async cc => {
            const f = (await cc.store.discounts()).find(x => x.id === d.id)
            let b: string | null = null; try { b = await cc.store.announcement() } catch { b = null }
            const still = Boolean(b && b.toUpperCase().includes(d.code.toUpperCase()))
            return { ok: f?.status !== 'active' && !still, proof: [p(`Fresh read: ${d.code}`, f?.status ?? 'not found'), ...(bannerReadable ? [p('Fresh read: banner', b ?? '(none)')] : [])] }
          },
        })
        continue
      }
      // a code for specific products that are all sold out
      const targets = d.productIds.map(id => products.find(x => x.id === id)).filter((x): x is CProduct => Boolean(x))
      if (d.status === 'active' && targets.length && targets.every(outOfStock)) {
        out.push({
          key: `discount:${d.id}:all_out_of_stock`, kind: 'discount_on_sold_out', actionType: 'discount', recordIds: [d.id, ...targets.map(x => x.id)],
          title: `Paused ${d.code}: everything it applies to is sold out`, whatHappened: `${d.code} applies only to ${targets.map(x => x.title).join(', ')}, and none of it is in stock.`,
          whatIDid: [`Deactivated ${d.code}. Undo turns it back on.`], evidence: { discountId: d.id, code: d.code, products: targets.map(x => x.id) },
          stillThere: async cc => { const f = (await cc.store.discounts()).find(x => x.id === d.id); return f?.status === 'active' },
          act: async cc => { const ch = await cc.store.deactivateDiscount(d.id); return { proof: [p(d.code, `${ch.before} -> ${ch.after}`)], undo: { kind: 'commerce.restore_discount', payload: { discountId: d.id, reactivate: true, announcement: null } } } },
          verify: async cc => { const f = (await cc.store.discounts()).find(x => x.id === d.id); return { ok: f?.status !== 'active', proof: [p(`Fresh read: ${d.code}`, f?.status ?? 'not found')] } },
        })
      }
    }
    return out
  },
}

// ---------------------------------------------------------------- Customer Care
const WISMO = /where('?s| is) my (order|parcel|package)|has my order (shipped|been sent)|order status|tracking (number|info)|not (arrived|received)|hasn'?t arrived|when will (it|my order) (arrive|ship)|shipped yet/i
async function orderForMail(c: Ctx, m: CMail): Promise<COrder | null> {
  const orders = await c.store.orders()
  const num = /#\s?(\d{3,})/.exec(`${m.subject} ${m.text}`)?.[1]
  if (num) { const o = orders.find(x => x.name.replace('#', '') === num); if (o && o.email.toLowerCase() === m.from.toLowerCase()) return o }
  return orders.filter(x => x.email.toLowerCase() === m.from.toLowerCase() && !x.cancelled).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null
}
const customerCare: CommerceAgent = {
  key: 'customer_care', name: 'Customer Care', scoped: true,
  job: 'Answers "where is my order" emails with the real tracking from the order, and passes anything else to you.',
  triggers: ['mail.received', 'customers/create', 'customers/update', 'sweep'], actions: ['send_customer_email'],
  async find(c) {
    const out: Problem[] = []
    const suppliers = new Set([...c.settings.suppliers, ...(await c.store.suppliers())].map(s => s.email.toLowerCase()))
    const sent = await c.store.sent()
    for (const m of await c.store.inbox()) {
      if (suppliers.has(m.from.toLowerCase()) || sent.some(x => x.inReplyTo === m.id)) continue
      const stillThere = async (cc: Ctx) => !(await cc.store.sent()).some(x => x.inReplyTo === m.id)
      if (!WISMO.test(`${m.subject} ${m.text}`)) {
        out.push({ key: `mail:${m.id}:owner`, kind: 'customer_message_for_owner', actionType: 'notify_owner', recordIds: [m.id], evidence: { mailId: m.id, from: m.from, subject: m.subject }, stillThere,
          title: `A customer question for you from ${m.from}`, whatHappened: `${m.from} wrote "${m.subject}". It is not an order-status question, so I have not answered it.`,
          whatIDid: ['Left it in your mailbox unanswered; nothing sent.'], act: async () => ({ proof: [p('Message', m.id)] }), verify: async () => ({ ok: true, proof: [p('Not answered', m.id)] }),
          ownerDecision: { question: `Reply to ${m.from}?`, options: {} } })
        continue
      }
      const o = await orderForMail(c, m)
      let lines: string[]
      let must: string[]
      if (!o) { lines = ['Thanks for getting in touch. I could not find an order under this email address. Could you reply with your order number (it starts with #) and I will check it straight away?']; must = ['order number'] }
      else if (o.fulfillmentStatus !== 'fulfilled' || !o.tracking) { lines = [`Thanks for checking in on ${o.name}. It has not shipped yet: it was placed on ${o.createdAt.slice(0, 10)} and we dispatch within ${c.settings.promisedDispatchDays} days. You will get the tracking number by email as soon as it leaves us.`]; must = [o.name] }
      else {
        const t = o.tracking
        lines = [`Thanks for checking in on ${o.name}. It shipped on ${t.shippedAt.slice(0, 10)}${t.carrier ? ` with ${t.carrier}` : ''}${t.number ? `; the tracking number is ${t.number}` : ''}.`,
          t.deliveredAt ? `The carrier shows it as delivered on ${t.deliveredAt.slice(0, 10)}. If you cannot find it, reply and we will open a claim.` : `The carrier's latest update is "${t.lastEvent ?? 'label created'}"${t.lastEventAt ? ` on ${t.lastEventAt.slice(0, 10)}` : ''}.`,
          ...(t.url ? [`Track it here: ${t.url}`] : [])]
        must = [t.number ?? o.name]
      }
      const text = email(c.shopName, o?.customerFirstName ?? 'there', lines)
      out.push({ key: `mail:${m.id}:reply`, kind: o ? 'wismo_email' : 'wismo_email_unknown_order', actionType: 'send_customer_email', recordIds: [m.id, ...(o ? [o.id] : [])], stillThere,
        evidence: { mailId: m.id, from: m.from, orderId: o?.id ?? null, orderName: o?.name ?? null, trackingNumber: o?.tracking?.number ?? null },
        title: o ? `Answered ${m.from} about ${o.name}` : `Asked ${m.from} for their order number`, whatHappened: `${m.from} asked where their order is${o ? ` (${o.name}, ${o.fulfillmentStatus})` : '; no order matches their address'}.`,
        whatIDid: [o ? `Replied with ${o.tracking?.number ? `the tracking number ${o.tracking.number} and the carrier's latest update` : 'the order status and dispatch time'}, taken from the order.` : 'Replied asking for the order number.'],
        act: async cc => { const s = await cc.store.sendEmail({ to: m.from, subject: `Re: ${m.subject}`, text, inReplyTo: m.id, agentKey: 'customer_care' }); return { proof: [p('Reply sent', `${s.id} to ${m.from}`)], facts: { messageId: s.id } } },
        verify: async (cc, done) => sentWith(cc, String(done.facts?.messageId), must),
      })
    }
    return out
  },
}

// ---------------------------------------------------------------- Payout and Fees Checker
const payoutChecker: CommerceAgent = {
  key: 'payout_fees_checker', name: 'Payout and Fees Checker', scoped: true,
  job: 'Checks every payout against its orders and your fee rate; flags a mismatch and prepares the dispute with the figures.',
  triggers: ['refunds/create', 'payouts/update', 'sweep'], actions: ['payout_dispute'],
  async find(c) {
    const out: Problem[] = []
    for (const po of await c.store.payouts()) {
      const n = po.orderIds.length
      const expectedFees = Number(po.gross) * (c.settings.feeRatePct / 100) + n * c.settings.feeFixed
      const feeGap = Number(po.fees) - expectedFees
      const netGap = Number(po.net) - (Number(po.gross) - Number(po.fees) - Number(po.refunds) + Number(po.adjustments))
      const figures = { payoutId: po.id, issuedAt: po.issuedAt, status: po.status, gross: po.gross, fees: po.fees, expectedFees: expectedFees.toFixed(2), refunds: po.refunds, adjustments: po.adjustments, net: po.net, orders: n, feeRatePct: c.settings.feeRatePct, feeFixed: c.settings.feeFixed }
      const same = async (cc: Ctx) => { const f = (await cc.store.payouts()).find(x => x.id === po.id); return f ? f.fees === po.fees && f.net === po.net && f.status === po.status : false }
      const packet = (what: string) => [`Payout ${po.id.split('/').pop()} issued ${po.issuedAt.slice(0, 10)}: ${what}`, `Gross ${money(po.gross)}, fees ${money(po.fees)} (expected ${money(expectedFees)} at ${c.settings.feeRatePct}% + ${money(c.settings.feeFixed)} on ${n} orders), refunds ${money(po.refunds)}, adjustments ${money(po.adjustments)}, net ${money(po.net)}.`, `Orders: ${po.orderIds.map(x => x.split('/').pop()).join(', ')}`].join('\n')
      let kind: string | null = null, what = ''
      if (po.status === 'failed') { kind = 'missing_payout'; what = `the payout of ${money(po.net)} failed and has not reached your bank` }
      else if (feeGap > 0.5) { kind = 'payout_mismatch'; what = `fees are ${money(feeGap)} above your rate` }
      else if (Math.abs(netGap) > 0.01) { kind = 'payout_mismatch'; what = `the net is ${money(Math.abs(netGap))} ${netGap < 0 ? 'less' : 'more'} than gross minus fees and refunds` }
      if (!kind) continue
      const text = packet(what)
      out.push({
        key: `payout:${po.id}:${kind}`, kind, actionType: 'payout_dispute', recordIds: [po.id], evidence: figures, stillThere: same,
        title: `Payout of ${po.issuedAt.slice(0, 10)}: ${what}; dispute prepared`, whatHappened: `I checked payout ${po.id.split('/').pop()} against its ${n} orders: ${what}.`,
        whatIDid: ['Prepared the dispute with the figures and the order list (below), ready to send to Shopify Payments support from your admin (Settings > Payments > Payouts > Contact support).', 'Nothing was sent; Shopify has no API for fee disputes.'],
        act: async () => ({ proof: [p('Dispute prepared', text)], facts: { packet: text } }),
        verify: async cc => { const ok = await same(cc); return { ok, proof: [p('Fresh read: payout figures', ok ? 'match the dispute' : 'changed since; the dispute was not used')] } },
      })
    }
    return out
  },
}

// ---------------------------------------------------------------- weekly reports
async function healthFacts(c: Ctx) {
  const products = (await c.store.products()).filter(x => x.status === 'ACTIVE')
  const discounts = await c.store.discounts()
  return {
    oversold: products.flatMap(pr => pr.variants.filter(v => v.tracked && (v.available ?? 0) < 0).map(v => `${pr.title}: ${v.available}`)),
    sellingPastZero: products.flatMap(pr => pr.variants.filter(v => v.tracked && (v.available ?? 1) <= 0 && v.inventoryPolicy === 'CONTINUE' && !pr.tags.some(t => EXEMPT.test(t))).map(() => pr.title)),
    thinDescriptions: products.filter(pr => wordCount(pr.description) < c.settings.minDescriptionWords).map(pr => pr.title),
    noImages: products.filter(pr => pr.imageCount === 0).map(pr => pr.title),
    missingSku: products.filter(pr => pr.variants.some(v => !v.sku)).map(pr => pr.title),
    expiredButActive: discounts.filter(d => d.status === 'active' && d.endsAt && new Date(d.endsAt) < c.now).map(d => d.code),
    unshippedLate: (await c.store.orders()).filter(o => !o.cancelled && o.fulfillmentStatus !== 'fulfilled' && days(o.createdAt, c.now) > c.settings.promisedDispatchDays).map(o => o.name),
  }
}
const storeHealth: CommerceAgent = {
  key: 'store_health_checker', name: 'Store Health Checker', scoped: false,
  job: 'Once a week, checks the whole store and sends you one health report: stock, listings, discounts and late orders.',
  triggers: ['sweep'], actions: ['owner_report'],
  async find(c) {
    const f = await healthFacts(c)
    const count = Object.values(f).reduce((a, l) => a + l.length, 0)
    const lines = [`Oversold: ${f.oversold.join('; ') || 'none'}`, `Selling past zero: ${f.sellingPastZero.join('; ') || 'none'}`, `Thin descriptions: ${f.thinDescriptions.join('; ') || 'none'}`, `No images: ${f.noImages.join('; ') || 'none'}`, `Variants without a SKU: ${f.missingSku.join('; ') || 'none'}`, `Discounts past their end date and still active: ${f.expiredButActive.join('; ') || 'none'}`, `Orders late to ship: ${f.unshippedLate.join('; ') || 'none'}`]
    return [{
      key: `health:${isoWeek(c.now)}`, kind: 'weekly_health', actionType: 'owner_report', recordIds: [], evidence: f,
      title: count ? `Store health: ${count} thing${count === 1 ? '' : 's'} to look at` : 'Store health: all clear', whatHappened: `Weekly check of ${c.shopName}, week ${isoWeek(c.now)}.`,
      whatIDid: [...lines, 'The other agents fix what they can on their own; this report changes nothing.'],
      stillThere: async () => true, act: async () => ({ proof: lines.map(l => p(l.split(':')[0], l.split(': ').slice(1).join(': '))) }),
      verify: async cc => { const g = await healthFacts(cc); const again = Object.values(g).reduce((a, l) => a + l.length, 0); return { ok: again === count, proof: [p('Fresh re-check', `${again} finding${again === 1 ? '' : 's'}`)] } },
    }]
  },
}
async function insightFacts(c: Ctx) {
  const orders = (await c.store.orders()).filter(sold)
  const week = orders.filter(o => days(o.createdAt, c.now) < 7), prev = orders.filter(o => days(o.createdAt, c.now) >= 7 && days(o.createdAt, c.now) < 14)
  const sum = (l: COrder[]) => Math.round(l.reduce((a, o) => a + Number(o.total), 0) * 100) / 100
  const byTitle = new Map<string, number>()
  for (const o of week) for (const i of o.items) byTitle.set(i.title, (byTitle.get(i.title) ?? 0) + i.quantity)
  const top = [...byTitle.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3)
  const low = (await c.store.products()).filter(pr => pr.status === 'ACTIVE' && pr.variants.some(v => v.tracked && (v.available ?? 99) <= c.settings.lowStockUnits)).map(pr => pr.title)
  return { orders: week.length, revenue: sum(week), lastWeekOrders: prev.length, lastWeekRevenue: sum(prev), top, lowStock: low }
}
const weeklyInsights: CommerceAgent = {
  key: 'weekly_insights', name: 'Weekly Insights', scoped: false,
  job: 'Every week, a short note: orders and revenue against last week, what sold, what is running low.',
  triggers: ['sweep'], actions: ['owner_report'],
  async find(c) {
    const f = await insightFacts(c)
    const change = f.lastWeekRevenue ? Math.round(((f.revenue - f.lastWeekRevenue) / f.lastWeekRevenue) * 100) : null
    const lines = [`Orders: ${f.orders} (last week ${f.lastWeekOrders})`, `Revenue: ${money(f.revenue)} (last week ${money(f.lastWeekRevenue)}${change === null ? '' : `, ${change >= 0 ? '+' : ''}${change}%`})`, `Sold most: ${f.top.map(([t, q]) => `${t} (${q})`).join(', ') || 'nothing this week'}`, `Running low: ${f.lowStock.join(', ') || 'nothing'}`]
    return [{
      key: `insights:${isoWeek(c.now)}`, kind: 'weekly_insights', actionType: 'owner_report', recordIds: [], evidence: f,
      title: `Your week: ${f.orders} orders, ${money(f.revenue)}${change === null ? '' : ` (${change >= 0 ? '+' : ''}${change}%)`}`, whatHappened: `Week ${isoWeek(c.now)} at ${c.shopName}.`, whatIDid: lines,
      stillThere: async () => true, act: async () => ({ proof: lines.map(l => p(l.split(':')[0], l.split(': ').slice(1).join(': '))) }),
      verify: async cc => { const g = await insightFacts(cc); return { ok: g.orders === f.orders && g.revenue === f.revenue, proof: [p('Fresh re-read', `${g.orders} orders, ${money(g.revenue)}`)] } },
    }]
  },
}

// ---------------------------------------------------------------- AI Visibility
export const seoFromFacts = (pr: CProduct) => {
  const base = pr.description ? pr.description : `${pr.title}${pr.vendor ? ` from ${pr.vendor}` : ''}${pr.material ? `, ${pr.material.toLowerCase()}` : ''}.`
  return base.length <= 155 ? base : `${base.slice(0, 152).replace(/\s+\S*$/, '')}...`
}
const aiVisibility: CommerceAgent = {
  key: 'ai_visibility', name: 'AI Visibility', scoped: true,
  job: 'Makes each product readable by search and AI shopping assistants: fills the search description from the listing and lists what only you can add.',
  triggers: ['products/create', 'products/update', 'sweep'], actions: ['update_listing'],
  async find(c) {
    const out: Problem[] = []
    for (const pr of (await c.store.products()).filter(x => x.status === 'ACTIVE')) {
      // a thin description is Listing Writer's job; the search description is written from it once it is good
      if (wordCount(pr.description) < c.settings.minDescriptionWords || pr.seoDescription) continue
      const other = [pr.imagesMissingAlt ? `${pr.imagesMissingAlt} image${pr.imagesMissingAlt === 1 ? '' : 's'} without alt text` : null, pr.variants.some(v => !v.barcode) ? 'a variant without a barcode (GTIN)' : null, !pr.vendor ? 'no vendor' : null, !pr.productType ? 'no product type' : null].filter((x): x is string => Boolean(x))
      const seo = seoFromFacts(pr)
      out.push({
        key: `product:${pr.id}:ai_visibility`, kind: 'ai_visibility_gap', actionType: 'update_listing', recordIds: [pr.id], evidence: { productId: pr.id, seoDescription: pr.seoDescription, imagesMissingAlt: pr.imagesMissingAlt, otherGaps: other },
        title: `${pr.title} had no search description; I added one`, whatHappened: `${pr.title} had no search (SEO) description, which search engines and AI shopping assistants read first.${other.length ? ` It also has ${other.join(', ')}.` : ''}`,
        whatIDid: ['Set the search description from the product description.', ...(other.length ? [`Still needs you: ${other.join('; ')}.`] : []), 'Undo removes it.'],
        stillThere: async cc => { const f = await productOf(cc, pr.id); return Boolean(f && !f.seoDescription) },
        act: async cc => { const ch = await cc.store.setSeoDescription(pr.id, seo); return { proof: [p('Search description', ch.after)], undo: { kind: 'commerce.restore_seo', payload: { productId: pr.id, text: ch.before || null } } } },
        verify: async cc => { const f = await productOf(cc, pr.id); return { ok: f?.seoDescription === seo, proof: [p('Fresh read: search description', f?.seoDescription ?? '(empty)')] } },
      })
    }
    return out
  },
}

export const COMMERCE_AGENTS: CommerceAgent[] = [orderTracker, returnsAgent, listingWriter, inventoryWatcher, supplierChaser, customerCare, campaign, promoManager, weeklyInsights, payoutChecker, storeHealth, aiVisibility]
export const commerceAgent = (key: string) => COMMERCE_AGENTS.find(a => a.key === key) ?? null
