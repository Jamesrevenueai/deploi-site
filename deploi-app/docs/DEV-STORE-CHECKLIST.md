# Shopify development-store test, in under 30 minutes

This test uses a **development store** and **test mailboxes** only. It runs the app on your own computer through the Shopify CLI tunnel, against a local database. It never touches production, the production database or a real store. Tick each box. If any step does not match what you see, stop and note the step number.

**Before you start (5 minutes):**

- [ ] Partner account, plus a development store created with demo data: Dev Dashboard → **Stores → Create store → Development**. Call it, say, `deploi-test`.
- [ ] A test mailbox you control that is used for nothing else (the "supplier").
- [ ] On your computer: Node 22, Postgres running, and the Shopify CLI (`npm i -g @shopify/cli`).

## 1. Start the app against the dev store (5 minutes)

- [ ] `cd deploi-app && cp shopify.app.toml.example shopify.app.toml`. Fill `client_id` and `handle` from Dev Dashboard → your app.
- [ ] In `.env.local`, set:
  - `DATABASE_URL` to a local database;
  - `SHOPIFY_API_KEY` and `SHOPIFY_API_SECRET` from the Dev Dashboard;
  - `CREDENTIALS_ENCRYPTION_KEY` (run `openssl rand -base64 32`) and `CREDENTIALS_KEY_ID=dev-k1`;
  - `LIVE_WRITE_STORES=deploi-test.myshopify.com`;
  - `EMAIL_LIVE_SENDS=off`;
  - `AGENT_MAIL_DOMAIN=agents.getdeploi.test`.
- [ ] `npm install && npm run db:migrate`
- [ ] `shopify app dev --store deploi-test.myshopify.com`. Press `p` to open the app. Approve the install screen. It asks only for products, inventory, locations and publications: no customers or orders.
- [ ] The embedded app opens on **Overview**, showing the store name and **Connected**.

## 2. Make a problem to find (2 minutes)

In the dev store admin → Products → pick one product → its variant:

- [ ] Inventory **tracked**, quantity **0**, and tick **Continue selling when out of stock**. Write down the product name.
- [ ] On a second product, add the tag `pre-order` and set the same setting. This one must be left alone.

## 3. Template agent at drafts only (5 minutes)

- [ ] **Agents → Inventory Watcher → Use this template.** Enter your test mailbox as the alert address. Click **Review authorization**.
- [ ] The rules say "drafts only" for Shopify and email, show the agent's own address, and list what it never does. Click **Grant this authorization**.
- [ ] **Open agent → Run now.** Under **Drafted changes (not made)**, the product from step 2 shows "Continue selling when out of stock: On → Off". The pre-order product is **not** listed.
- [ ] In the Shopify admin, that product **still** has Continue selling ticked. A drafts-only agent changed nothing.

## 4. Widen to "after my approval" and approve one change (5 minutes)

- [ ] On the agent: **Edit → How changes are approved → After my approval → Save changes.**
- [ ] A banner says the new version needs your grant and lists what it adds. Click **Grant this authorization** on version 2.
- [ ] **Run now.** The change now appears in **Approvals** with an **Approve** button.
- [ ] **Approve.** The result says **Verified (confirmed by a fresh read)**.
- [ ] Shopify admin, refresh the product: Continue selling is now **off**. The pre-order product is unchanged.
- [ ] **Work log** shows the approval with "Allowed by: your approval", plus the authorization version.

## 5. Tasks, refusal and stop controls (5 minutes)

- [ ] **Tasks → "Check overselling on all products now"** → it runs.
- [ ] **"Fix prices automatically on all products"** → **Needs your approval**, with the reason (price is not in its rules).
- [ ] **"Delete the products that have not sold this year"** → **Refused**: "Deploi cannot do this: deleting products".
- [ ] **Pause → Pause agent.** **Run now** is disabled. **Resume**, then **Revoke → Revoke authorization**: the agent says it can do nothing until a new grant.

## 6. Email stays off (3 minutes)

- [ ] **Use this template → Supplier Chaser**, supplier = your test mailbox. Grant, then edit email to **Send messages you approve one by one** and grant again.
- [ ] **Run now** → **Approvals → Emails to approve** shows the restock request. Approve it. Because `EMAIL_LIVE_SENDS=off`, it is held and **nothing arrives** in the test mailbox. That is the expected result for this test.
- [ ] Optional, only once `LAUNCH-STEPS.md` step 2 is verified: set `EMAIL_LIVE_SENDS=allowlist` and `EMAIL_TEST_RECIPIENTS=<your test mailbox>`, restart, and approve again. It arrives in the inbox (not spam), and your reply shows under it in **Agent mailbox**.

## 7. Competitor & Trend Watcher (5 minutes, read only)

- [ ] **Agents → Competitor & Trend Watcher → Use this template.** Add one public Shopify store you are allowed to monitor (your own second dev store with its password page off works), plus `example.org` as a non-Shopify site. Grant.
- [ ] **Run now.** The Shopify store shows **Readable**, a baseline and its currency; findings show only "Baseline recorded…"; `example.org` shows **Not supported** with the reason. Nothing is reported as a new launch.
- [ ] Add a product to the watched store with today's date, then **Run now** again: one "added 1 new product" finding, labelled **Observed**, with the product link and time.
- [ ] Your own dev store was not read or changed by this agent (Activity shows no scan for it).

## 8. Webhooks, reconnection and uninstall (5 minutes)

- [ ] Change a product in the dev store admin: within a minute **Activity** shows a targeted re-check (`products/update`).
- [ ] Duplicate delivery: Shopify retries with the same `X-Shopify-Webhook-Id`. To check live, run `shopify app webhook trigger --topic products/update --address <your tunnel URL>/api/shopify/webhooks` twice with the same `--delivery-method http` payload saved to a file, or replay one captured request with `curl` (same headers and body): the second answer is `{"ok":true,"duplicate":true}` and nothing runs twice. (Covered by tests: `tests/security/queued-work.test.ts`, "Shopify webhook retries".)
- [ ] Remove `write_publications` from `shopify.app.toml`, `shopify app deploy`, accept the scope change: a publication change is refused with "missing permission: write_publications". Put it back.
- [ ] Uninstall the app (Settings → Apps). Deploi shows the store **disconnected**, its agents **paused**, and queued email cancelled. Reinstall: the same organization comes back connected, agents stay paused until you resume them.
- [ ] (48 hours after uninstall, Shopify sends `shop/redact`.) Optional: trigger it with `shopify app webhook trigger --topic shop/redact` and check the store's data is erased.

## 9. Tenant isolation with a second store (3 minutes)

- [ ] Install on a second dev store. Signed in to the second store, no agent, finding, email or work-log entry of the first store is visible, and opening a first-store agent URL says **Agent not found**.

## 10. Clean up (1 minute)

- [ ] Delete the agents. Uninstall the app from the dev stores (Settings → Apps). The `app/uninstalled` webhook marks each store disconnected in Deploi.

## Notes for this release (2026-10-29)

- Writes to a real store need a `store_eligibility` row in production (`RELEASE-PLAN.md` §5). Locally, `LIVE_WRITE_STORES=<your dev store>` (section 1) still enables writes.
- **Status: not run.** No development store or Partner app credentials were available to this work, so every box above is unverified on a real store. The same flows pass against the synthetic store (`npx vitest run`, `npx playwright test`).

Record the time taken and any step that did not match. That list, with screenshots, is the live verification the readiness report still lacks.
