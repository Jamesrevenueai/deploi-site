/**
 * The customer inbox shows where mail comes from and why a message is quarantined, and the owner can release
 * it (dev auth, seed applied). The rows are written straight into the e2e database (DATABASE_URL) the way the
 * inbox sync stores them, because a real Gmail inbox cannot be reached from this environment; the content is
 * left undecryptable, so the subject shows as hidden. Skipped without DATABASE_URL.
 */
import { test, expect, type Page } from '@playwright/test'
import { Client } from 'pg'
import { randomUUID } from 'node:crypto'

test.describe.configure({ mode: 'serial' })
const DB = process.env.DATABASE_URL
const NORTHWIND = 'owner@northwind-goods.example'
const GMAIL = 'e2e-owner@northwind-gmail.example'

async function signIn(page: Page, email: string) {
  await page.request.post('/logout')
  await page.goto('/login')
  await page.selectOption('select[name=email]', email)
  await Promise.all([page.waitForURL(u => !u.pathname.startsWith('/login')), page.click('button[type=submit]')])
}

test.skip(!DB, 'needs DATABASE_URL of the e2e database')

test('a quarantined Gmail message shows its source and reason; the owner releases it', async ({ page }) => {
  const c = new Client({ connectionString: DB })
  await c.connect()
  const id = randomUUID()
  try {
    const org = (await c.query<{ agency_id: string }>('select agency_id from profiles where lower(email) = $1', [NORTHWIND])).rows[0].agency_id
    await c.query(`delete from email_accounts where org_id = $1 and address = $2`, [org, GMAIL])
    const acc = (await c.query<{ id: string }>(`insert into email_accounts (org_id, provider, address, status, granted_scopes, can_send, can_read, connected_by)
      values ($1,'gmail',$2,'active',$3,true,true,'e2e') returning id`, [org, GMAIL, ['https://www.googleapis.com/auth/gmail.readonly']])).rows[0].id
    await c.query(`insert into email_inbound (id, org_id, account_id, provider_email_id, internet_message_id, from_address, classification, status, status_reason, quarantine_code, key_id, content_ciphertext, received_at, provider_thread_id)
      values ($1,$2,$3,'g-e2e-1','<e2e-1@new-sender.example>','stranger@new-sender.example','other','quarantined',
        'a new sender whose SPF, DKIM and DMARC did not all pass (spf=pass, dkim=pass, dmarc=gray)','auth_unverified','x','x', now() - interval '1 hour','th-e2e-1')`, [id, org, acc])

    await signIn(page, NORTHWIND)
    await page.goto('/store/inbox/mail')
    const row = page.locator('li', { hasText: 'stranger@new-sender.example' }).first()
    await expect(row.getByText('Gmail', { exact: true })).toBeVisible()
    await expect(row.getByText('Quarantined', { exact: true })).toBeVisible()
    await row.getByRole('button').first().click()
    await expect(page.getByText(/Why quarantined: a new sender whose SPF, DKIM and DMARC did not all pass/)).toBeVisible()
    await page.getByRole('button', { name: 'Release' }).click()
    await expect(page.getByText(/Released: Email Operations can see it now/)).toBeVisible()
    await expect(page.getByText(`Released by user:${NORTHWIND}`)).toBeVisible()
    await expect(page.getByText(/This conversation is in your Gmail inbox/)).toBeVisible()
    const r = (await c.query<{ status: string; first_contact: boolean; released_by: string }>('select status, first_contact, released_by from email_inbound where id = $1', [id])).rows[0]
    expect(r).toMatchObject({ status: 'accepted', first_contact: true, released_by: `user:${NORTHWIND}` })
  } finally {
    await c.query('delete from email_accounts where address = $1', [GMAIL])
    await c.end()
  }
})
