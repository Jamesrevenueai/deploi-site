/**
 * One runner per library agent. A runner reads the store through StoreData, applies the agent's job
 * and the merchant's standing instructions, and returns the actions it wants to take. It never
 * writes: the library (actions.ts) decides, from the merchant's permission level and auto-run grants,
 * whether each action is only noted, drafted for approval, or executed, and records the proof.
 * Everything here is deterministic. No model is called in this build; the drafts are template text
 * filled from store facts, and the hook for a model-written draft is `polish` in brain.ts.
 */
import type { StoreData, ProductSummary, Order } from './store-data'
import { agentByKey } from './config'

export type ActionDraft = {
  actionType: string
  title: string
  summary: string
  evidence: Record<string, unknown>
  /** the exact thing to do; dedupeKey keeps one open draft per record */
  payload: Record<string, unknown> & { dedupeKey?: string }
}
export type RunnerContext = { data: StoreData; instructions: string; settings: Record<string, unknown>; now: Date }
export type Runner = (ctx: RunnerContext) => Promise<ActionDraft[]>

const day = 864e5
const daysBetween = (a: string, now: Date) => Math.floor((now.getTime() - new Date(a).getTime()) / day)
const money = (n: number | string) => `$${Number(n).toFixed(2)}`
const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d)
/** "under 120 words" / "max 100 words" in the standing instructions */
const wordLimit = (instructions: string, d: number) => { const m = /(?:under|max(?:imum)?|at most|no more than)\s+(\d{2,3})\s+words/i.exec(instructions); return m ? Number(m[1]) : d }
const clip = (text: string, words: number) => { const w = text.split(/\s+/); return w.length <= words ? text : w.slice(0, words).join(' ') + '.' }
const tone = (instructions: string) => /\b(warm|friendly)\b/i.test(instructions) ? 'warm' : /\b(formal|professional)\b/i.test(instructions) ? 'formal' : 'plain'
const greeting = (name: string, t: string) => (t === 'formal' ? `Dear ${name},` : `Hi ${name},`)
const signoff = (t: string) => (t === 'formal' ? 'Kind regards,' : t === 'warm' ? 'Warmly,' : 'Thanks,')

// ---------------------------------------------------------------- Order Tracker
const orderTracker: Runner = async ({ data, instructions, settings, now }) => {
  const lateAfter = num(settings.lateAfterDays, (/(\d+)\s+days?\s+late/i.exec(instructions)?.[1] ? Number(/(\d+)\s+days?\s+late/i.exec(instructions)![1]) : 2))
  const out: ActionDraft[] = []
  for (const o of await data.orders()) {
    if (o.status === 'cancelled') continue
    const age = daysBetween(o.createdAt, now)
    let reason: string | null = null
    if (o.status === 'unfulfilled' && age > o.promisedDispatchDays + lateAfter - 2 && age >= lateAfter) reason = `not dispatched ${age} days after the order; you promise dispatch within ${o.promisedDispatchDays}`
    else if (o.status === 'fulfilled' && !o.trackingNumber) reason = `marked fulfilled ${daysBetween(o.shippedAt ?? o.createdAt, now)} days ago with no tracking number`
    else if (o.status === 'fulfilled' && o.lastTrackingEvent && o.lastTrackingEvent !== 'Delivered' && o.lastTrackingAt && daysBetween(o.lastTrackingAt, now) >= 5) reason = `tracking has not moved since "${o.lastTrackingEvent}" ${daysBetween(o.lastTrackingAt, now)} days ago`
    if (!reason) continue
    const evidence = { orderId: o.id, orderName: o.name, createdAt: o.createdAt, status: o.status, trackingNumber: o.trackingNumber, lastTrackingEvent: o.lastTrackingEvent, lastTrackingAt: o.lastTrackingAt, promisedDispatchDays: o.promisedDispatchDays, reason }
    out.push({ actionType: 'flag_late_order', title: `${o.name} looks stuck`, summary: `${o.name} (${money(o.totalPrice)}) is ${reason}.`, evidence, payload: { dedupeKey: `${o.id}:flag`, suggestedStep: o.status === 'unfulfilled' ? 'Dispatch it or tell the customer when it will ship.' : 'Check with the carrier and tell the customer.' } })
    const t = tone(instructions)
    const body = `${greeting(o.customerFirstName, t)}\n\nThank you for your order ${o.name}. It is taking longer than we promised, and I am sorry about that. ${o.status === 'unfulfilled' ? 'It has not left us yet; we will dispatch it as soon as we can and send you the tracking number the moment it ships.' : `The carrier shows "${o.lastTrackingEvent}" and nothing since. We are chasing them now and will update you as soon as we know more.`}\n\nIf you would rather cancel, reply to this email and we will refund you in full.\n\n${signoff(t)}\n{{store_name}}`
    out.push({ actionType: 'draft_customer_update', title: `Delay update for ${o.name}`, summary: `A ${t} note to ${o.customerFirstName} about ${o.name}, ready for you to send.`, evidence, payload: { dedupeKey: `${o.id}:update`, to: o.email, subject: `Your order ${o.name}: an update`, body } })
  }
  return out
}

// ---------------------------------------------------------------- Returns
const returns: Runner = async ({ data, instructions, settings }) => {
  const windowDays = num(settings.returnWindowDays, Number(/(\d+)\s+days/i.exec(instructions)?.[1] ?? 30))
  const out: ActionDraft[] = []
  for (const r of await data.returns()) {
    if (r.status !== 'requested') continue
    const inWindow = r.daysSinceDelivery <= windowDays
    const damaged = /damaged|broken|faulty/i.test(r.reason)
    const fits = (inWindow && !r.worn) || damaged
    const decision = fits ? 'approve' : !inWindow ? 'decline_window' : 'decline_worn'
    const evidence = { returnId: r.id, orderName: r.orderName, reason: r.reason, worn: r.worn, daysSinceDelivery: r.daysSinceDelivery, returnWindowDays: windowDays, policyResult: decision }
    const t = tone(instructions)
    const body = decision === 'approve'
      ? `${greeting(r.customerFirstName, t)}\n\nThanks for letting us know about the ${r.itemTitle} from order ${r.orderName}. Your return is approved. ${damaged ? 'I am sorry it arrived damaged; no need to send it back, we will refund you once you reply with a photo.' : 'A prepaid return label is attached; drop the parcel at any collection point and the refund goes out when it reaches us.'}\n\n${signoff(t)}\n{{store_name}}`
      : decision === 'decline_window'
        ? `${greeting(r.customerFirstName, t)}\n\nThanks for getting in touch about the ${r.itemTitle} from order ${r.orderName}. Our returns window is ${windowDays} days from delivery and this request arrived at ${r.daysSinceDelivery} days, so I am not able to approve a return. If something is wrong with the item itself, reply with a photo and I will look again.\n\n${signoff(t)}\n{{store_name}}`
        : `${greeting(r.customerFirstName, t)}\n\nThanks for getting in touch about the ${r.itemTitle} from order ${r.orderName}. We can only accept unworn items back, and your note says it has been worn, so I am not able to approve this one. If I have misread that, reply and tell me.\n\n${signoff(t)}\n{{store_name}}`
    out.push({ actionType: 'draft_return_reply', title: `${decision === 'approve' ? 'Approve' : 'Decline'} return on ${r.orderName}`, summary: `${r.customerFirstName} asked to return the ${r.itemTitle} (${r.reason}). Policy says ${decision === 'approve' ? 'approve' : 'decline'}: ${inWindow ? 'inside' : 'outside'} the ${windowDays}-day window${r.worn ? ', worn' : ''}${damaged ? ', damaged' : ''}.`, evidence, payload: { dedupeKey: `${r.id}:reply`, decision, subject: `Your return request for ${r.orderName}`, body } })
    if (decision === 'approve') out.push({ actionType: 'approve_return', title: `Mark return ${r.orderName} approved in the store`, summary: `Sets the return request on ${r.orderName} to approved. It clearly fits your policy.`, evidence, payload: { dedupeKey: `${r.id}:approve`, returnId: r.id, from: 'requested', to: 'approved' } })
  }
  return out
}

// ---------------------------------------------------------------- Listing Writer
const listingWriter: Runner = async ({ data, instructions, settings }) => {
  const limit = wordLimit(instructions, 120)
  const maxProducts = num(settings.maxProducts, Number(/(\d+)\s+(?:weakest|worst|listings|products)/i.exec(instructions)?.[1] ?? 10))
  const out: ActionDraft[] = []
  const t = tone(instructions)
  const titleExtra = (p: ProductSummary) => p.tags[0] ?? (p.variants.length > 1 ? p.variants.map(v => v.title).join(' / ') : null)
  const weak = (await data.products()).filter(p => p.status === 'ACTIVE').map(p => ({ p, score: (p.description.split(/\s+/).filter(Boolean).length < 15 ? 2 : 0) + (p.title.length < 16 && titleExtra(p) ? 1 : 0) })).filter(x => x.score > 0).sort((a, b) => b.score - a.score).slice(0, maxProducts)
  for (const { p } of weak) {
    const evidence = { productId: p.id, title: p.title, descriptionWords: p.description.split(/\s+/).filter(Boolean).length, tags: p.tags, variants: p.variants.map(v => v.title) }
    const extra = titleExtra(p)
    if (p.title.length < 16 && extra) {
      const to = `${p.title} (${extra})`
      out.push({ actionType: 'draft_title', title: `Better title for ${p.title}`, summary: `"${p.title}" is short; the draft adds what the product is.`, evidence, payload: { dedupeKey: `${p.id}:title`, field: 'title', from: p.title, to } })
    }
    if (p.description.split(/\s+/).filter(Boolean).length < 15) {
      const facts = [p.variants.length > 1 ? `Available in ${p.variants.map(v => v.title).join(', ')}.` : '', p.tags.length ? `Part of our ${p.tags.join(', ')} range.` : ''].filter(Boolean).join(' ')
      const open = t === 'warm' ? `Meet the ${p.title}, made to be used every day and loved for years.` : t === 'formal' ? `The ${p.title} is made to a high standard for daily use.` : `${p.title}: made well, for everyday use.`
      const to = clip(`${open} ${facts} Ships within two working days. Returns accepted within 30 days.`.replace(/\s+/g, ' ').trim(), limit)
      out.push({ actionType: 'draft_description', title: `Description for ${p.title}`, summary: `${p.description ? 'A one-line description' : 'No description'} today; the draft uses only facts already in the listing, ${t} tone, under ${limit} words.`, evidence, payload: { dedupeKey: `${p.id}:description`, field: 'description', from: p.description, to } })
    }
  }
  return out
}

// ---------------------------------------------------------------- Inventory Watcher (library view; the engine template does the same job with its own policy)
const EXEMPT = /pre-?order|backorder|made-?to-?order/i
const oversold = (p: ProductSummary) => p.status === 'ACTIVE' && !p.tags.some(t => EXEMPT.test(t))
const inventoryWatcher: Runner = async ({ data }) => {
  const out: ActionDraft[] = []
  for (const p of await data.products()) {
    if (!oversold(p)) continue
    for (const v of p.variants) {
      if (!v.tracked || v.available === null) continue
      if (v.available < 0) out.push({ actionType: 'flag_oversold', title: `${p.title} is oversold`, summary: `${p.title} (${v.title}) shows ${v.available} available: more has been sold than you have.`, evidence: { productId: p.id, variantId: v.id, available: v.available, inventoryPolicy: v.inventoryPolicy }, payload: { dedupeKey: `${v.id}:oversold`, suggestedStep: 'Count the shelf, then adjust the quantity or contact the customers whose orders cannot ship.' } })
      if (v.available <= 0 && v.inventoryPolicy === 'CONTINUE') out.push({ actionType: 'draft_inventory_policy_fix', title: `Stop ${p.title} selling at zero`, summary: `${p.title} (${v.title}) has ${v.available} available and keeps selling when out of stock.`, evidence: { productId: p.id, variantId: v.id, available: v.available, inventoryPolicy: v.inventoryPolicy, tags: p.tags }, payload: { dedupeKey: `${v.id}:policy`, field: 'inventoryPolicy', from: 'CONTINUE', to: 'DENY' } })
    }
  }
  return out
}

// ---------------------------------------------------------------- Supplier Chaser
const supplierChaser: Runner = async ({ data, instructions, settings }) => {
  const threshold = num(settings.thresholdAvailable, Number(/(\d+)\s+or fewer/i.exec(instructions)?.[1] ?? 2))
  const supplier = typeof settings.supplierAddress === 'string' ? settings.supplierAddress : (/[\w.+-]+@[\w-]+(\.[\w-]+)+/.exec(instructions)?.[0] ?? null)
  const out: ActionDraft[] = []
  const low = (await data.products()).filter(p => p.status === 'ACTIVE').flatMap(p => p.variants.filter(v => v.tracked && v.available !== null && v.available <= threshold && v.available >= 0).map(v => ({ p, v })))
  if (!low.length) return out
  const lines = low.map(({ p, v }) => `- ${p.title}${v.title !== 'Default Title' ? ` (${v.title})` : ''}${v.sku ? `, SKU ${v.sku}` : ''}: ${v.available} left`).join('\n')
  out.push({ actionType: 'draft_restock_request', title: `Restock request: ${low.length} product${low.length === 1 ? '' : 's'} at ${threshold} or fewer`, summary: supplier ? `A restock request to ${supplier} listing ${low.length} low product${low.length === 1 ? '' : 's'}.` : `A restock request is drafted, but no supplier address is set yet: add one in this agent's settings.`,
    evidence: { threshold, products: low.map(({ p, v }) => ({ productId: p.id, variantId: v.id, available: v.available })) },
    payload: { dedupeKey: `restock:${low.map(x => x.v.id).join(',')}`, to: supplier, subject: 'Restock request', body: `Hello,\n\nCould you confirm availability and lead time for the following?\n\n${lines}\n\nThanks,\n{{store_name}}` } })
  return out
}

// ---------------------------------------------------------------- Customer Care
const customerCare: Runner = async ({ data, instructions }) => {
  const t = tone(instructions)
  const out: ActionDraft[] = []
  const orders = await data.orders()
  for (const m of await data.customerMessages()) {
    const o = m.orderName ? orders.find(x => x.name === m.orderName) ?? null : null
    let body: string
    if (m.kind === 'where_is_my_order' && o) body = `${greeting(o.customerFirstName, t)}\n\nThanks for checking in on ${o.name}. ${o.trackingNumber ? `It shipped on ${o.shippedAt?.slice(0, 10)} and the tracking number is ${o.trackingNumber}; the carrier last reported "${o.lastTrackingEvent ?? 'label created'}".` : 'It has not shipped yet, and I am sorry it is taking longer than we promised. It will go out as soon as we can get it to you, and you will get the tracking number the moment it ships.'}\n\n${signoff(t)}\n{{store_name}}`
    else if (m.kind === 'product_question') body = `${greeting('there', t)}\n\nThanks for asking. I have checked the product details and will confirm the exact care instructions with the team today; you will have a definite answer by tomorrow.\n\n${signoff(t)}\n{{store_name}}`
    else if (m.kind === 'return') body = `${greeting(o?.customerFirstName ?? 'there', t)}\n\nI am sorry the item arrived damaged. Please reply with a photo and we will sort out a replacement or a refund straight away; you will not need to send it back.\n\n${signoff(t)}\n{{store_name}}`
    else body = `${greeting('there', t)}\n\nThanks for your message. I am looking into it and will come back to you today.\n\n${signoff(t)}\n{{store_name}}`
    out.push({ actionType: 'draft_customer_reply', title: `Reply to ${m.from}${m.orderName ? ` about ${m.orderName}` : ''}`, summary: `${m.summary}. Drafted in a ${t} tone with the order facts filled in.`, evidence: { messageId: m.id, kind: m.kind, orderName: m.orderName, orderStatus: o?.status ?? null, trackingNumber: o?.trackingNumber ?? null }, payload: { dedupeKey: `${m.id}:reply`, to: m.from, subject: m.orderName ? `About your order ${m.orderName}` : 'Your question', body, replyKind: m.kind } })
  }
  return out
}

// ---------------------------------------------------------------- Campaign
const campaign: Runner = async ({ data, instructions, settings }) => {
  const t = tone(instructions)
  const products = (await data.products()).filter(p => p.status === 'ACTIVE' && p.channels.length)
  const wanted = num(settings.productCount, Number(/(\d+)\s+products?/i.exec(instructions)?.[1] ?? 3))
  const focus = /\b(?:for|about|around)\s+(?:the\s+)?(?:new\s+)?([a-z][a-z\s-]{2,30}?)\s+(?:range|collection|launch)/i.exec(instructions)?.[1]?.trim() ?? null
  const picked = (focus ? products.filter(p => p.title.toLowerCase().includes(focus.toLowerCase()) || p.tags.some(x => x.toLowerCase().includes(focus.toLowerCase()))) : []).concat(products).filter((p, i, a) => a.indexOf(p) === i).slice(0, wanted)
  const discount = (await data.discounts()).find(d => d.status === 'active' && (!d.endsAt || new Date(d.endsAt).getTime() > Date.now())) ?? null
  if (!picked.length) return []
  const subject = focus ? `New: the ${focus} range` : `${picked.length} things worth a look this week`
  const text = `${t === 'formal' ? 'Dear customer,' : 'Hello,'}\n\n${focus ? `The ${focus} range is here.` : 'A few things we think you will like:'}\n\n${picked.map(p => `- ${p.title}: ${p.description || 'see the listing'} (${money(p.variants[0].price)})`).join('\n')}\n\n${discount ? `Use code ${discount.code} for ${discount.percent}% off${discount.endsAt ? ` until ${discount.endsAt.slice(0, 10)}` : ''}.` : ''}\n\n${signoff(t)}\n{{store_name}}`.replace(/\n{3,}/g, '\n\n')
  const html = `<p>${focus ? `The ${focus} range is here.` : 'A few things we think you will like:'}</p><ul>${picked.map(p => `<li><strong>${p.title}</strong> ${money(p.variants[0].price)}</li>`).join('')}</ul>${discount ? `<p>Use code <strong>${discount.code}</strong> for ${discount.percent}% off.</p>` : ''}`
  return [{ actionType: 'draft_campaign_email', title: subject, summary: `A ${t} marketing email featuring ${picked.map(p => p.title).join(', ')}${discount ? ` with code ${discount.code}` : ''}. Never sent by Deploi; copy it into your email tool.`, evidence: { products: picked.map(p => p.id), discountCode: discount?.code ?? null, focus }, payload: { dedupeKey: `campaign:${focus ?? 'weekly'}:${picked.map(p => p.id).join(',')}`, subject, text, html } }]
}

// ---------------------------------------------------------------- Promo Manager
const promoManager: Runner = async ({ data, instructions, settings, now }) => {
  const percent = num(settings.percent, Number(/(\d{1,2})\s*%/i.exec(instructions)?.[1] ?? 15))
  const slowStockDays = num(settings.slowStockDays, Number(/(\d+)\s+days of stock/i.exec(instructions)?.[1] ?? 90))
  const endInDays = num(settings.endInDays, /two weeks/i.test(instructions) ? 14 : Number(/ending in (\d+) days/i.exec(instructions)?.[1] ?? 14))
  const out: ActionDraft[] = []
  const sales = await data.sales()
  const slow = (await data.products()).filter(p => p.status === 'ACTIVE').flatMap(p => p.variants.filter(v => v.tracked && (v.available ?? 0) > 0).map(v => ({ p, v, weeklyRate: sales.thisWeek.byProduct[p.title] ?? 0 }))).filter(({ v, weeklyRate }) => (weeklyRate === 0 ? (v.available ?? 0) >= 5 : ((v.available ?? 0) / weeklyRate) * 7 > slowStockDays))
  if (slow.length) {
    const code = `MOVE${percent}`
    const endsAt = new Date(now.getTime() + endInDays * day).toISOString()
    const evidence = { percent, slowStockDays, products: slow.map(({ p, v, weeklyRate }) => ({ productId: p.id, title: p.title, available: v.available, soldThisWeek: weeklyRate })) }
    out.push({ actionType: 'propose_discount', title: `Propose ${percent}% off ${slow.length} slow product${slow.length === 1 ? '' : 's'}`, summary: `${slow.map(x => x.p.title).slice(0, 4).join(', ')}${slow.length > 4 ? ` and ${slow.length - 4} more` : ''} have more than ${slowStockDays} days of stock at this week's rate.`, evidence, payload: { dedupeKey: `propose:${code}`, code, percent, endsAt, products: slow.map(x => x.p.id) } })
    out.push({ actionType: 'create_discount', title: `Create code ${code} (${percent}% off, ends ${endsAt.slice(0, 10)})`, summary: `Creates the discount code in your store with an end date ${endInDays} days out.`, evidence, payload: { dedupeKey: `create:${code}`, code, percent, endsAt } })
  }
  for (const d of await data.discounts()) {
    if (d.status === 'active' && d.endsAt && new Date(d.endsAt).getTime() < now.getTime()) out.push({ actionType: 'end_discount', title: `End ${d.code}: it is past its end date`, summary: `${d.code} (${d.percent}% off) was due to end ${d.endsAt.slice(0, 10)} and is still active.`, evidence: { discountId: d.id, code: d.code, endsAt: d.endsAt }, payload: { dedupeKey: `${d.id}:end`, discountId: d.id, from: 'active', to: 'expired' } })
    if (d.status === 'active' && !d.endsAt && daysBetween(d.startsAt, now) > 90) out.push({ actionType: 'propose_discount', title: `${d.code} has run for ${daysBetween(d.startsAt, now)} days with no end date`, summary: `A permanent ${d.percent}% code stops being a promotion. Consider ending it or giving it an end date.`, evidence: { discountId: d.id, code: d.code, startsAt: d.startsAt }, payload: { dedupeKey: `${d.id}:review`, discountId: d.id, suggestion: 'set an end date' } })
  }
  return out
}

// ---------------------------------------------------------------- Weekly Insights
const weeklyInsights: Runner = async ({ data, instructions, now }) => {
  const s = await data.sales()
  const n = Number(/(\d+)\s+products/i.exec(instructions)?.[1] ?? 3)
  const ranked = Object.entries(s.thisWeek.byProduct).sort((a, b) => b[1] - a[1])
  const products = (await data.products()).filter(p => p.status === 'ACTIVE')
  const didNotMove = products.filter(p => !s.thisWeek.byProduct[p.title]).map(p => p.title).slice(0, n)
  const change = s.lastWeek.revenue ? Math.round(((s.thisWeek.revenue - s.lastWeek.revenue) / s.lastWeek.revenue) * 100) : null
  const text = [`Week to ${now.toISOString().slice(0, 10)}`, `Orders: ${s.thisWeek.orders} (last week ${s.lastWeek.orders}). Revenue: ${money(s.thisWeek.revenue)} (last week ${money(s.lastWeek.revenue)}${change === null ? '' : `, ${change >= 0 ? '+' : ''}${change}%`}).`,
    `Moved most: ${ranked.slice(0, n).map(([t, q]) => `${t} (${q})`).join(', ') || 'nothing sold this week'}.`, `Did not move: ${didNotMove.join(', ') || 'everything sold at least once'}.`, `Ran out: ${s.ranOut.join(', ') || 'nothing'}.`].join('\n')
  return [{ actionType: 'weekly_summary', title: `Weekly insights, week to ${now.toISOString().slice(0, 10)}`, summary: `${s.thisWeek.orders} orders, ${money(s.thisWeek.revenue)}${change === null ? '' : ` (${change >= 0 ? '+' : ''}${change}% on last week)`}. Best: ${ranked[0]?.[0] ?? 'none'}. Ran out: ${s.ranOut.length}.`, evidence: { thisWeek: s.thisWeek, lastWeek: s.lastWeek, ranOut: s.ranOut, source: 'orders and inventory read from the store; nothing estimated' }, payload: { dedupeKey: `week:${now.toISOString().slice(0, 10)}`, text } }]
}

// ---------------------------------------------------------------- Payout and Fees Checker
const payoutFeesChecker: Runner = async ({ data, instructions, settings }) => {
  const ratePct = num(settings.feeRatePct, Number(/(\d+(?:\.\d+)?)\s*%/.exec(instructions)?.[1] ?? 2.9))
  const fixed = num(settings.feeFixed, Number(/(\d+)\s*cents/.exec(instructions)?.[1] ?? 30) / 100)
  const out: ActionDraft[] = []
  const orders = await data.orders()
  for (const p of await data.payouts()) {
    const covered = orders.filter(o => p.orderIds.includes(o.id))
    const expectedGross = covered.reduce((s, o) => s + Number(o.totalPrice), 0)
    const expectedFees = expectedGross * (ratePct / 100) + covered.length * fixed
    const evidence = { payoutId: p.id, date: p.date, amount: p.amount, orders: p.orderIds.length, grossSales: p.grossSales, expectedGross: expectedGross.toFixed(2), feesCharged: p.feesCharged, expectedFees: expectedFees.toFixed(2), refundsNetted: p.refundsNetted, status: p.status }
    if (p.status === 'missing') { out.push({ actionType: 'reconcile_payout', title: `Payout due ${p.date.slice(0, 10)} has not arrived`, summary: `${covered.length} orders worth ${money(expectedGross)} have no payout against them.`, evidence, payload: { dedupeKey: `${p.id}:missing`, suggestedStep: 'Check the payouts page and your bank; if it is more than 3 business days late, contact support.' } }); continue }
    const gap = Number(p.feesCharged) - expectedFees
    out.push({ actionType: 'reconcile_payout', title: `Payout ${p.date.slice(0, 10)}: ${money(p.amount)} ${Math.abs(Number(p.grossSales) - expectedGross) < 0.01 ? 'matches' : 'does not match'} its ${covered.length} orders`, summary: `Gross ${money(p.grossSales)}, fees ${money(p.feesCharged)}, refunds ${money(p.refundsNetted)}, paid ${money(p.amount)}.`, evidence, payload: { dedupeKey: `${p.id}:reconcile` } })
    if (gap > 0.5) out.push({ actionType: 'flag_fee_anomaly', title: `Fees on payout ${p.date.slice(0, 10)} are ${money(gap)} above your rate`, summary: `Charged ${money(p.feesCharged)}; at ${ratePct}% + ${money(fixed)} per order they should be about ${money(expectedFees)}.`, evidence, payload: { dedupeKey: `${p.id}:fees`, overchargeUsd: Math.round(gap * 100) / 100, suggestedStep: 'Compare the rate on each order; international cards and currency conversion carry higher fees.' } })
  }
  return out
}

// ---------------------------------------------------------------- Store Health Checker
const storeHealthChecker: Runner = async ({ data, now }) => {
  const products = await data.products()
  const oversoldList = products.flatMap(p => p.variants.filter(v => v.tracked && (v.available ?? 0) < 0).map(v => `${p.title} (${v.title}): ${v.available}`))
  const sellingAtZero = products.filter(oversold).flatMap(p => p.variants.filter(v => v.tracked && (v.available ?? 1) <= 0 && v.inventoryPolicy === 'CONTINUE').map(v => `${p.title} (${v.title})`))
  const noDescription = products.filter(p => p.status === 'ACTIVE' && !p.description).map(p => p.title)
  const noImages = products.filter(p => p.status === 'ACTIVE' && p.imageCount === 0).map(p => p.title)
  const text = [`Store health, ${now.toISOString().slice(0, 10)}`, `Oversold (${oversoldList.length}): ${oversoldList.join('; ') || 'none'}`, `Selling past zero (${sellingAtZero.length}): ${sellingAtZero.join('; ') || 'none'}`, `No description (${noDescription.length}): ${noDescription.join('; ') || 'none'}`, `No images (${noImages.length}): ${noImages.join('; ') || 'none'}`].join('\n')
  return [{ actionType: 'health_report', title: `Store health report, ${now.toISOString().slice(0, 10)}`, summary: `${oversoldList.length} oversold, ${sellingAtZero.length} selling past zero, ${noDescription.length} without a description, ${noImages.length} without images. Nothing changed.`, evidence: { oversold: oversoldList, sellingAtZero, noDescription, noImages }, payload: { dedupeKey: `health:${now.toISOString().slice(0, 10)}`, text } }]
}

// ---------------------------------------------------------------- AI Visibility
const aiVisibility: Runner = async ({ data }) => {
  const channels = await data.channels()
  const out: ActionDraft[] = []
  if (!channels.includes('Agentic')) return [{ actionType: 'check_ai_visibility', title: 'The Agentic sales channel is not installed', summary: 'Shopify lists AI shopping assistants under Sales channels > Agentic. Until it is added, no product is visible to them.', evidence: { channels }, payload: { dedupeKey: 'channel:agentic', suggestedStep: 'In Shopify admin, open Sales channels and add Agentic.' } }]
  for (const p of (await data.products()).filter(p => p.status === 'ACTIVE')) {
    const gaps: string[] = []
    if (!p.channels.includes('Agentic')) gaps.push('not published to the Agentic channel')
    if (p.description.split(/\s+/).filter(Boolean).length < 15) gaps.push('description too short for an assistant to describe it')
    if (p.imageCount === 0) gaps.push('no images')
    if (p.variants.every(v => v.tracked && (v.available ?? 0) <= 0)) gaps.push('out of stock, so assistants will not offer it')
    if (p.variants.some(v => !v.sku)) gaps.push('a variant has no SKU, which assistants use to identify it')
    const evidence = { productId: p.id, title: p.title, channels: p.channels, descriptionWords: p.description.split(/\s+/).filter(Boolean).length, imageCount: p.imageCount, gaps }
    out.push({ actionType: 'check_ai_visibility', title: `${p.title}: ${gaps.length ? `${gaps.length} gap${gaps.length === 1 ? '' : 's'}` : 'visible to AI shopping assistants'}`, summary: gaps.length ? gaps.join('; ') : 'Published to Agentic with a full description, images, price and stock.', evidence, payload: { dedupeKey: `${p.id}:ai-check`, visible: gaps.length === 0 } })
    if (gaps.length) out.push({ actionType: 'recommend_visibility_fix', title: `Fix for ${p.title}`, summary: gaps.map(g => g.startsWith('not published') ? 'Publish it to the Agentic channel.' : g.startsWith('description') ? 'Switch on the Listing Writer or write a fuller description.' : g.startsWith('no images') ? 'Add at least one product image.' : g.startsWith('out of stock') ? 'Restock it or hide it until it is back.' : 'Give every variant a SKU.').join(' '), evidence, payload: { dedupeKey: `${p.id}:ai-fix`, steps: gaps } })
  }
  return out
}

export const RUNNERS: Record<string, Runner> = {
  order_tracker: orderTracker, returns, listing_writer: listingWriter, inventory_watcher: inventoryWatcher, supplier_chaser: supplierChaser,
  customer_care: customerCare, campaign, promo_manager: promoManager, weekly_insights: weeklyInsights, payout_fees_checker: payoutFeesChecker,
  store_health_checker: storeHealthChecker, ai_visibility: aiVisibility,
}

export const runnerFor = (agentKey: string): Runner | null => RUNNERS[agentKey] ?? null

/** Every library agent has a runner, and every action a runner can produce is declared in the config. */
export function runnerCoverageProblems(): string[] {
  const problems: string[] = []
  for (const key of Object.keys(RUNNERS)) if (!agentByKey(key)) problems.push(`runner ${key} has no config entry`)
  return problems
}

/** For "build your own": which library capabilities a plain-English job touches. */
export const CAPABILITY_HINTS: { key: string; test: RegExp }[] = [
  { key: 'order_tracker', test: /\b(late|stuck|delayed?|unfulfilled|dispatch|shipping|orders?)\b/i },
  { key: 'returns', test: /\breturns?\b|\brefunds?\b/i },
  { key: 'listing_writer', test: /\b(titles?|descriptions?|listings?|copy|rewrite)\b/i },
  { key: 'inventory_watcher', test: /\b(oversold|inventory|stock|out of stock|selling at zero)\b/i },
  { key: 'supplier_chaser', test: /\b(supplier|restock|reorder|vendor)\b/i },
  { key: 'customer_care', test: /\b(customer|reply|replies|messages?|support)\b/i },
  { key: 'campaign', test: /\b(campaign|newsletter|marketing email|launch email)\b/i },
  { key: 'promo_manager', test: /\b(discount|promo(tion)?|coupon|code|sale)\b/i },
  { key: 'weekly_insights', test: /\b(weekly|insights?|trends?|summary|summar[iy]se|report on sales)\b/i },
  { key: 'payout_fees_checker', test: /\b(payouts?|fees?|reconcil\w*)\b/i },
  { key: 'store_health_checker', test: /\b(health|audit|check the (whole )?store)\b/i },
  { key: 'ai_visibility', test: /\b(ai (shopping|assistants?|visibility)|agentic|chatgpt|perplexity)\b/i },
]
export const matchCapabilities = (job: string): string[] => CAPABILITY_HINTS.filter(h => h.test.test(job)).map(h => h.key)

export type { Order }
