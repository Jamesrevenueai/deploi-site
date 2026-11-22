/**
 * Screenshots of the owner update, action-needed, crew job and morning report emails as rendered HTML
 * (sample data, no database, nothing sent) at 1440 and 390 px: proof/notify/. Run: npx tsx scripts/notify-proof.ts
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { renderUpdate, renderCrew, renderMorning } from '../lib/notify/templates'
import { estimate } from '../lib/notify/morning'

const APP = 'https://app.getdeploi.com'
const OUT = join(process.cwd(), 'proof', 'notify')
const update = {
  agentName: 'Refund Agent', headline: 'Refunded a double charge on order #1001', caseRef: 'DC-000123', severity: 'info' as const, detailsPath: '/store/work/DC-000123', orgName: 'Northwind Goods',
  whatHappened: 'Order #1001 was charged twice ($42.00 each) when the customer\'s first payment timed out. They emailed asking why.',
  whatIDid: ['Refunded the duplicate $42.00 charge to the original card', 'Checked the order again: one charge left, refund status "succeeded"', 'Replied to the customer with the refund details'],
  proof: [{ label: 'Order', value: '#1001', url: 'https://admin.shopify.com/store/northwind/orders/1001' }, { label: 'Refund', value: '$42.00 · succeeded' }, { label: 'Verified', value: 'Nov 7, 6:02 AM, fresh read from Shopify' }, { label: 'Customer email', value: 'Sent, delivered' }],
}
const pages: Record<string, string> = {
  'owner-update': renderUpdate(update, APP, `${APP}/undo/example-token`).html,
  'owner-action-needed': renderUpdate({ ...update, severity: 'action', headline: 'Refund $380 for a damaged sofa?', whatHappened: 'The customer sent photos of a torn sofa (order #1044). This is above your $250 auto-refund limit.', whatIDid: ['Refund $380.00 to the original card', 'Ask the carrier for a damage claim'], proof: [{ label: 'Order', value: '#1044' }, { label: 'Photos', value: '3 attached', url: 'https://cdn.example.com/claims/1044' }] }, APP, '').html,
  'owner-warning': renderUpdate({ ...update, severity: 'warning', headline: 'A listing fix did not hold', whatHappened: 'I set "Linen Throw" back to in stock, but Shopify still shows it sold out 2 minutes later.', whatIDid: ['Updated the inventory to 14', 'Read the product again: still 0'] }, APP, '').html,
  'crew-jobs': renderCrew({
    crewName: 'Sam', orgName: 'Northwind Goods', dateLabel: 'Saturday, November 7', intro: 'Two deliveries and a pickup today. The second address changed.',
    jobs: [
      { jobRef: 'J-1042', address: '12 Main St, Springfield, IL', details: 'Deliver 2 boxes (order #1001).\nRing the side door; ask for Dana.', photos: ['https://cdn.example.com/j1042-1.jpg', 'https://cdn.example.com/j1042-2.jpg'], status: 'sent', doneParam: 'done_0', changes: [] },
      { jobRef: 'J-1043', address: '88 Oak Ave, Unit 4, Springfield, IL', details: 'Assemble the shelf. Bring the 6 mm hex key.', photos: [], status: 'sent', doneParam: 'done_1', changes: ['Address changed', '1 new photo'] },
      { jobRef: 'J-1040', address: '5 Depot Rd', details: 'Pick up returns.', photos: [], status: 'done', doneParam: null, changes: [] },
    ],
  }, { done_0: `${APP}/crew/done/example-1`, done_1: `${APP}/crew/done/example-2` }).html,
  'morning-report': renderMorning({
    orgName: 'Northwind Goods', dateLabel: 'Saturday, November 7', since: 'Nov 6, 12:11 PM UTC',
    did: [
      { agentName: 'Refund Agent', headline: 'Refunded a double charge on order #1001', severity: 'info', detailsPath: '/store/work/DC-000123', at: 'Nov 6, 9:14 PM UTC' },
      { agentName: 'Order Watcher', headline: 'Told 3 customers their orders ship Monday', severity: 'info', detailsPath: '/store/work', at: 'Nov 6, 11:02 PM UTC' },
      { agentName: 'Refund Agent', headline: 'Refund $380 for a damaged sofa?', severity: 'action', detailsPath: '/store/approvals', at: 'Nov 7, 2:40 AM UTC' },
    ],
    resolved: [{ ref: 'DC-000118', title: 'Linen Throw showed sold out with 14 in stock' }], crew: { done: 4, open: 2 },
    estimate: estimate({ updates: 2, resolved: 1, crewDone: 4 }, 30),
    unfinished: [{ ref: 'DC-000121', title: 'Supplier has not sent tracking for PO-88', status: 'waiting_external', why: 'asked twice; I will ask again at 9 AM' }],
    waiting: [{ count: 1, label: 'refund waiting for your decision' }],
  }, APP).html,
}

async function main() {
  mkdirSync(OUT, { recursive: true })
  const browser = await chromium.launch(process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {})
  try {
    for (const [name, html] of Object.entries(pages)) {
      writeFileSync(join(OUT, `${name}.html`), html)
      for (const width of [1440, 390]) {
        const page = await browser.newPage({ viewport: { width, height: 900 } })
        await page.setContent(html, { waitUntil: 'load' })
        await page.screenshot({ path: join(OUT, `${name}-${width}.png`), fullPage: true })
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)
        if (overflow) throw new Error(`${name} scrolls sideways at ${width}px`)
        await page.close()
      }
    }
  } finally { await browser.close() }
  console.log(`wrote ${Object.keys(pages).length * 2} screenshots to ${OUT}`)
}
void main()
