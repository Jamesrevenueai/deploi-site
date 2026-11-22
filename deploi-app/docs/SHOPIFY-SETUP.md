# Shopify app: setup, permissions, billing and submission

Sources: `docs/platform-research/shopify.md` and `docs/platform-research/shopify-app-store.md` (official
Shopify documentation, Admin API 2026-10). Submission package: `docs/APP-STORE-SUBMISSION.md`.
Marketplace approval is a separate step from implementation. The app has not been submitted, reviewed
or approved.

## 1. Local synthetic demonstration (no Shopify account needed)

```bash
cd deploi-app
npm install
npm run db:migrate && npm run seed      # local Postgres; seeds two synthetic merchants with synthetic stores
npm run dev                              # http://localhost:3000/login (dev sign-in lists seeded users)
```

Sign in as `owner@northwind-goods.example` and open **Agents**. Four synthetic agents are seeded, each with an
authorization marked as granted by the seeded demo owner:

| Agent | Correction | Mode | What a run shows |
|---|---|---|---|
| Stock Guardian | overselling settings, all products | authorized, every 6 h | 5 changes **Verified**; pre-order, backorder and selling-plan products untouched |
| Price Keeper | price from "Northwind price list" | review, daily | 3 changes **Awaiting approval**; EUR row and duplicate rows **Need a person** |
| Channel Keeper | publication on Online Store from "Online Store product list" | review, manual | walnut board to publish; draft and conflicting rows go to a person; scheduled product left alone |
| SKU Filler | SKU from "Northwind SKU mapping", fill only | authorized, manual | coasters filled and **Verified**; shared barcode, SKU in use and overwrite go to a person |

Approving the pour-over set's price change ends **Blocked**: it has a fixed wholesale price, so changing the base
price would not reach those buyers. **Create agent** walks through plain English, then the structured review, then the
readable authorization, then the grant. The demo store and reference files are invented (see
`lib/connectors/shopify/demo-store.ts`). `owner@harbor-supply.example` sees none of Northwind's data.

### Agent platform walkthrough (templates, tiers, tasks, work log, weekly summary)

Set `AGENT_MAIL_DOMAIN=agents.getdeploi.test` in `.env.local` so templates can give each agent an address; with `EMAIL_LIVE_SENDS=off` nothing is ever emailed.

1. **Agents** shows three templates (Inventory Watcher, Supplier Chaser, Store Health Checker), each at **drafts only** for Shopify and email, and the **Weekly summary** for this week with time saved labelled **Estimate**.
2. **Use this template** → add your email (or the supplier's) → **Review authorization**: the agent's own address, what it may do, its limits and what it never does → **Grant**.
3. On the agent: **Run now** fills **Drafted changes (not made)**; there is no Approve button, because a drafts-only agent cannot make changes.
4. **Tasks**: "Check overselling on all products now" runs and ends *Waiting on you* (drafts to read). "Fix prices automatically" is *Needs your approval* (outside the rules). "make it better" is *Refused* (nothing runs).
5. **Edit** → "After my approval" → Save: a new version waits for your grant, listing what it adds; the drafts-only version keeps running until you grant it. Granting re-queues tasks that the wider rules now cover.
6. **Work log**: every action with what, when, why and *Allowed by* (authorization version and tier, your approval, or "none").
7. **Pause**, **Revoke** and **Delete** stop everything at once, including queued writes, queued email and queued tasks; deleting also closes the agent's address.

New agents and new email permissions always start at drafts only. Acting without asking needs an end date at most one year away, and widening anything needs a new grant.

## 2. Development store (live verification, not yet done)

Nothing below has run against Shopify: this repository has no Shopify credentials. Every step is for the founder,
in order. Each one names what proves it worked.

1. **Store.** Partner Dashboard → Stores → Create store → Development (or `shopify store create dev --name "<name>" --plan basic --demo-data`).
   Development stores cannot take real payments.
2. **App.** Dev Dashboard → Apps → Create app ("Deploi (dev)"). Then, in `deploi-app`:
   `shopify app config link --client-id <client id> --file-name shopify.app.deploi-dev.toml`, merge
   `shopify.app.deploi-dev.toml.example` into it (scopes, optional scopes, webhooks, compliance topics), and
   `shopify app deploy --config deploi-dev`. Proof: Dev Dashboard → Versions shows the scopes and the three compliance topics.
3. **Environment** on the app host (names only; values from the Dev Dashboard and a key generator):
   - `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`, `SHOPIFY_API_VERSION=2026-10`, `SHOPIFY_APP_URL`
   - `CREDENTIALS_ENCRYPTION_KEY` (base64 of 32 random bytes), `CREDENTIALS_KEY_ID`
   - `STORE_ACCESS_MODE=beta` (default): development stores are enabled automatically (Shopify's
     `shop.plan.partnerDevelopment`); other stores need an invite or staff approval (`/staff/store-access`).
     Use `open` for the App Store submission and listing (see §5).
   - `LIVE_WRITES=off` pauses writes to every real store (incident switch); leave unset otherwise
   - `CRON_SECRET` so `/api/cron/agents` (hourly, `vercel.json`) runs scheduled agents and flushes leftover webhook rescans
   - optional: `SHOPIFY_WEBHOOK_DEBOUNCE_MS` (default 15000) and `SHOPIFY_WEBHOOK_MAX_DELAY_MS` (default 120000)
   - keep `BILLING_REQUIRED` unset (off)
4. **Database.** Apply migrations through `20261104000037_shopify_ops.sql` (`npm run db:migrate:prod`; rollback
   `supabase/rollback/20261104000037_shopify_ops.down.sql`).
5. **Install** from the store admin (Apps → Deploi (dev)). The embedded app loads `/shopify`, calls
   `/api/shopify/session` with the App Bridge id token, and the server exchanges it for an expiring offline token.
   Proof: `store_connections` row `active`; `store_credentials.expires_at` about one hour ahead and `refresh_expires_at` about 90 days.
6. **Read-only smoke check** (sends queries only; refuses any store that is not a development store):
   `SHOPIFY_DEVSTORE_SHOP=<store>.myshopify.com npx tsx scripts/shopify-devstore-check.ts --from-db` (with that
   environment's `DATABASE_URL` and `CREDENTIALS_ENCRYPTION_KEY`), or pass `SHOPIFY_DEVSTORE_TOKEN` directly.
   Proof: `Result: PASS`; paste the variant query cost line into `docs/platform-research/shopify-workflows.md` (READINESS §3 item 6).
7. **Token refresh.** Wait more than an hour, then open the app or press **Run now**. Proof: the audit trail shows
   `credential.stored` by `system:token-refresh` and a new `refresh_expires_at`. If Shopify refuses the refresh the
   connection shows `status = 'error'`, `status_reason = 'needs_reauth: …'`; reopening the app clears it.
8. **Webhooks.** `shopify app webhook trigger --topic=<topic> --address=https://<app>/api/shopify/webhooks --api-version=2026-10`
   for `inventory_levels/update`, `products/update`, `customers/data_request`, `customers/redact`, `shop/redact`.
   Proof: `webhook_receipts` rows `processed`; compliance topics also in `shopify_compliance_requests`.
9. **Corrections.** Upload the three demo CSVs (adapted to the store's products), create one agent per correction,
   run each in review mode then authorized mode, and confirm **Verified** in Deploi and in the Shopify admin. Record:
   whether the SKU write needs `write_inventory` (below), whether an unpublished channel disappears from
   `resourcePublicationsV2` (handled either way, below), price precision, SKU search exactness.
10. **Supplier Chaser.** Connect an agent mailbox, upload a supplier mapping (`sku,supplier_email,reorder_qty,lead_time_days,supplier_name`)
    pointing at an address you control, set an item to 0 available, run the agent, approve the request, reply
    from that address with a date. Proof: the request shows **Supplier replied; a date is mentioned: …** and no follow-up is sent.
11. **Uninstall**, then reinstall within 48 hours (data kept; a later `shop/redact` is recorded as deferred), then uninstall
    for good (after 48 hours `shop/redact` erases the shop).

### What the code does where live behaviour is unconfirmed

- **SKU writes and `write_inventory`.** Shopify documents `productVariantsBulkUpdate` as needing `write_products`, and
  names no extra scope for `ProductVariantsBulkInput.inventoryItem.sku`; `inventoryItemUpdate` is the mutation that
  needs `write_inventory` (`docs/platform-research/shopify-app-store.md` §5, `shopify-workflows.md` §3). Decision:
  do **not** request `write_inventory`. If a live store refuses the SKU part for missing access, the execution ends
  **Blocked** with "it may need the write_inventory scope"; the fix is adding `write_inventory` to `OPTIONAL_SCOPES`,
  `ACTION_SCOPES['shopify.variant.set_sku']` and both TOML files.
- **Unpublish verification.** The verifying read fills every known channel that is missing from a complete
  `resourcePublicationsV2` list (no next page) as not published, so an unpublish verifies whether Shopify returns
  `isPublished: false` or drops the channel. An incomplete list is not read that way.
- **Throttling.** Every response's `extensions.cost.throttleStatus` is kept per connection; the next request waits
  for the bucket, and a `THROTTLED` error waits `(requested − available) / restoreRate` (0.25 to 10 s). A throttled
  mutation is retried (it did not run); a mutation with a lost response never is.
- **Webhook bursts** collapse into one targeted rescan per record after a quiet period (`shopify_rescan_queue`).

## 3. Permissions

Installed with the app (`[access_scopes].scopes`, `config.ts#REQUIRED_SCOPES`): **`read_products, read_inventory,
read_locations`**, read only. That is everything the three starter templates need at "drafts only". No customer or
order scopes, which keeps the app at protected customer data Level 0 (no access request needed).

Optional, declared in `optional_scopes` and asked for at runtime (`config.ts#OPTIONAL_SCOPES`): **`write_products,
read_publications, write_publications`**. The embedded app asks Shopify for the write scope an agent needs
(App Bridge `shopify.scopes.request`) only when a merchant widens that agent past drafts only; Shopify shows its
own grant screen; the server re-reads `currentAppInstallation.accessScopes` (`POST /api/store/scopes/sync`) and
also receives `app/scopes_update`. A store that only ever drafts never grants a write scope.

| Scope | When | Used for |
|---|---|---|
| `read_products`, `read_inventory`, `read_locations` | install | variants, prices, SKUs, barcodes, inventory levels, locations; Markets price lists (fixed-price preflight) |
| `write_products` | first agent widened past drafts only with an overselling, price or SKU correction | `productVariantsBulkUpdate`: inventory policy, price, compare-at price, SKU (one field per call) |
| `read_publications` | first publication correction | which sales channels a product is on; the channel list for agent setup. Publication fields are left out of the scan query until it is granted. |
| `write_publications` | first publication correction widened past drafts only | `publishablePublish` / `publishableUnpublish` on the one channel the agent is authorized for |

Every execution re-checks the granted list and ends **blocked: missing permission: <scope>** rather than
writing.

`write_inventory` is not requested; see "SKU writes and `write_inventory`" in §2. Writes to a real store need store access (`lib/engine/access.ts`): open mode,
a development store, a redeemed beta invite or staff approval; a staff denial or `LIVE_WRITES=off` blocks
them. Each agent's writable fields are enforced again inside the connector.

## 4. Billing

App Store apps must bill through Shopify. Shopify App Pricing (formerly Managed Pricing) is the default for
new public apps: plans are set in the Partner Dashboard, Shopify hosts the plan page
(`lib/connectors/shopify/billing.ts#pricingPlansUrl`), and status is read from the Partner API
(`activeSubscription`, `lib/connectors/shopify/billing.ts#syncSubscription`, re-read on app open, after the
plan page redirects back with `plan_handle`, and at most every 5 minutes); App Pricing sends no subscription
webhooks. With `BILLING_REQUIRED=true` the Overview shows **View plans in Shopify** (opened at the top level)
and changes are blocked until a plan is active. **Blocked:** no plans or prices are decided, and Partner
API credentials (`SHOPIFY_PARTNER_API_TOKEN`, `SHOPIFY_PARTNER_ID` (the number in the Partner Dashboard
URL), `SHOPIFY_PARTNER_APP_ID`) do not exist. Set the plan's welcome link to `/shopify` so the plan is re-read
on return. Beta merchants can get private plans limited to their stores.

Decisions confirmed in code: the app never calls `appSubscriptionCreate` (App Pricing forbids it; that is Manual
Pricing, legacy), and cannot cancel a merchant's plan (the merchant does that in Shopify; uninstall cancels it, and
`markUninstalled` mirrors that locally). If an `app_subscriptions/update` webhook ever arrives it only triggers a
fresh Partner API read, never trusts the payload. `BILLING_REQUIRED` stays off.

## 4a. Privacy webhooks and uninstall

- `app/uninstalled`: credentials deleted, every agent paused, queued writes, email and rescans cancelled, live
  proposals blocked, subscriptions marked cancelled.
- Where a shopper can appear: the app reads no Shopify customers or orders (no customer or order scopes), but a
  shopper's address can still be in what Deploi holds once agents work with it: agent mail sent to or received from
  them, agent library drafts and reports (e.g. an order delay note), Resolution Engine cases and their history,
  Office leads, meetings and invoices with the same address, opt-outs. Purchase orders and restock requests hold
  suppliers only, never shoppers. The full list, with what each step does per table, is `PRIVACY_COVERAGE` in
  `lib/privacy/customer-data.ts`; `tests/privacy/customer-privacy.test.ts` fails when a new table with an email,
  address, customer, recipient, phone or contact column is neither covered nor exempt with a reason.
- `customers/data_request`: builds a JSON export of everything held for that customer (matched on the email in the
  payload, any case, and on the Shopify customer and order ids where a record carries them), within the shop's
  organization only, and stores it encrypted (`privacy_exports`, AES-256-GCM with the credentials key). Owners and
  admins download it from **Settings → Privacy requests** (`/store/privacy`, API `GET /api/store/privacy[/<id>]`) and
  send it to the customer themselves; Deploi sends nothing. The request is recorded as fulfilled with counts per
  table (never the address). Exports are kept 60 days (Shopify gives the merchant 30 days to answer), then purged.
- `customers/redact`: deletes the customer's mail; anonymizes what the business must keep (opt-outs kept as a
  one-way hash so they still block sending, invoice amounts kept without the name or address, leads stopped with
  the address replaced by a hash, the address erased from agent drafts, Office actions, cases and case history);
  withdraws waiting drafts and actions; deletes earlier exports for that customer; records what was done per table.
  The tamper-evident audit trail is retained unchanged for audit (it holds record ids, never addresses or content).
  Idempotent: the same delivery is answered once, and a repeat request finds nothing more to change. Deploi does
  not delete the contact from the merchant's own HubSpot or QuickBooks: those are the merchant's systems.
- `shop/redact` (48 hours after uninstall): erases the connection, its agents' mail and everything under it (issues,
  proposals, agents), the store's cases and their history, its purchase orders, the discovery profile, AI usage
  records and customer data exports, and the organization (with everything in it) when it has no other store. If the shop reinstalled, nothing is erased and the request is recorded as deferred.
- Every delivery is HMAC-checked (401 otherwise), de-duplicated by webhook id, recorded in
  `shopify_compliance_requests` with the customer as a one-way hash, and a failure returns 500 so Shopify retries.

## 4b. Supplier Chaser

Low stock (the agent's threshold) → each SKU's supplier from the agent's **supplier mapping** reference file
(`sku, supplier_email, reorder_qty, lead_time_days, supplier_name`), or the default supplier → **one consolidated
request per supplier per day** from the agent's mailbox (dedupe key `supplier_reorder:<supplier>:<day>`, plus a
per-variant cooldown) → decided by the agent's email tier (draft, approve each, or within limits) → sent by the email
engine. A supplier address outside the agent's recipient rules is never written to; a SKU listed twice is left out.
A reply is matched to the thread; a date in the supplier's own words (quoted history is ignored) is stored as an
ETA for the merchant to read and is never acted on. One follow-up after the set number of days without a reply; a
follow-up not yet sent is withdrawn when the supplier replies. Status per request: `supplier_requests`
(`lib/agents/supplier.ts#listSupplierRequests`).

## 5. App Store submission

See `docs/APP-STORE-SUBMISSION.md` for the listing draft, reviewer instructions, screencast script, the
submission checklist and every remaining blocker.
