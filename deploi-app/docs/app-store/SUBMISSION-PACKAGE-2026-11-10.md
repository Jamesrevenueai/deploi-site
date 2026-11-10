# Submission package: Deploi (production app), 2026-11-10

Only the screenshots are missing (they come from the in-store test, STOP #2). Everything here matches what the embedded app shows today
(`lib/shopify/embedded.ts`). Counts are characters, recount in the form. Replaces the older "Deploi AI" copy in `LISTING.md`.

## 1. Identity
| Field | Value |
|---|---|
| App name (max 30) | **Deploi** (6) |
| Subtitle (max 62) | **Agents that catch stock problems and fix them with your OK** (58) |
| Introduction (max 100) | **Deploi agents watch your inventory, draft the fix, and change your store only after you approve it.** (99) |
| Icon | `docs/app-store/icon-1200.jpg`, 1200×1200, no text (you approve it) |
| Categories | Primary: Store management → Operations. Secondary: Inventory management (confirm names in the picker) |
| Languages | English |
| Search terms (5) | inventory, overselling, out of stock, store automation, restock |
| Pricing | **Free** (Partner Dashboard → Pricing). `BILLING_REQUIRED=false` |
| Distribution | Public (App Store), set on the production app only |
| Protected customer data | Request nothing (no customer or order scope) |
| Support email | support@getdeploi.com |
| Privacy / Terms / Support URLs | https://getdeploi.com/privacy · /terms · /support (live, 200, 2026-11-10) |
| Operator (Terms and Privacy) | Deploi is operated by James Investments and real estate holdings LLC, Columbus, Ohio, USA |
| App URL | https://app.getdeploi.com/shopify |

## 2. Description (max 500)
> Describe a job in plain English or start from a template, and Deploi turns it into an agent with a written authorization: which products, which single setting, which limits and schedule. Nothing runs until you grant it. Agents start at drafts only. Widen one to "after my approval" and each change waits in Approvals. Every change is re-read from your store to confirm it took effect, and every action is kept in a work log with the permission that allowed it. Pause or revoke an agent at any time.

## 3. Features (max 80 each)
1. Finds products that keep selling when out of stock, skipping pre-orders
2. Agents from templates or plain English, each with an authorization you grant
3. Drafts first: approve each change, or let an agent act within your limits
4. Every change re-read from your store and kept in a work log
5. Optional supplier restock emails drafted for you to review before sending

## 4. Permissions text (paste where the form asks how access is used)
> Deploi asks for these permissions when you install it:
> - **View products, inventory and locations** (`read_products`, `read_inventory`, `read_locations`): to find products that keep selling when out of stock, and to re-read each one after a change to confirm it.
> - **Edit products** (`write_products`): so an agent can fix what it finds. It changes one setting at a time, "Continue selling when out of stock" (and a price or SKU correction when you turn that on), only the way you set each action. Agents at drafts only change nothing. Deploi never changes stock quantities.
> - **View discounts** (`read_discounts`): to notice discount changes.
>
> Deploi does not ask for customer, order, fulfillment or return data. Showing a product on a sales channel (`read_publications`, `write_publications`) is asked for separately, only if you turn that correction on.

## 5. What the embedded app really offers (the listing must not promise more)
Shown inside Shopify: Overview, Agents (templates **Inventory Watcher, Supplier Chaser, Store Health Checker**, or plain English), Approvals, Issues, Activity, Rules, Connections, Privacy requests, Weekly summary.
**Not shown inside Shopify, on purpose** (`lib/shopify/embedded.ts`): the other 9 library agents (Order Tracker, Returns, Customer Care, Weekly Insights, Payout and Fees Checker, Listing Writer, Campaign, Promo Manager, AI Visibility). Their live store reader refuses (`not_wired`), and 5 of them need orders or payouts, which means protected customer data or scopes we do not request. The listing therefore names only the three templates.
Email: agent emails are held during review (`EMAIL_LIVE_SENDS=off`): reviewers see drafts and "would send".

## 6. Reviewer test instructions (paste into the form; verify each step in STOP #2 first)
> Deploi opens inside your Shopify admin after you approve its permissions. No separate login or password is needed.
>
> **Setup (2 minutes).** In your development store: pick a product with tracked inventory, set available quantity to 0 and turn on "Continue selling when out of stock". Optionally do the same for a second product tagged `pre-order`.
>
> 1. **Overview:** click Run scan. The product appears as an issue with its evidence.
> 2. **Inventory Watcher** (Agents → template): enter an email for alerts → Review authorization → Grant → Run now. At "drafts only" it shows the change (On → Off) and changes nothing. Check the product in your admin: unchanged.
> 3. **Make a change:** on the agent click Edit → "After my approval" → Save → Grant the new version → Run now → Approvals → Approve. Status becomes Verified and the product no longer sells when out of stock. The pre-order product is left alone.
> 4. **Work log:** on the agent page, every run and change with the permission that allowed it.
> 5. **Store Health Checker** (template): Run now. It produces a read-only report of listing and stock problems. Nothing changes.
> 6. **Supplier Chaser** (template): enter a supplier email, Run now. It drafts a restock email for you to review. Nothing is sent during review.
> 7. **Pause / Revoke:** on any agent, Pause then Revoke. Queued changes stop too.
> 8. **Privacy requests:** lists customer data requests Shopify sends (empty on a new store).
> 9. **Uninstall / reinstall:** uninstall from Settings → Apps. Access stops at once. Reinstall and the app opens again; your store data is erased when Shopify sends `shop/redact`.
>
> Email to real recipients is held during review. Support: support@getdeploi.com.

## 7. Pre-submission checklist (status 2026-11-10; PASS only with proof)
| # | Item | Status | Proof / what remains |
|---|---|---|---|
| 1 | Privacy, Terms, Support load, no draft banner, operator named, no street address | **PASS** | Live render 2026-11-10 (Phase 1 report §D): LLC name, "Columbus, Ohio, USA" and support@ present; "DRAFT" / "pending legal" absent; `deploi-site` production `dpl_3VocEzdHgSm9a1w6Eghmdiiogri3` @ 9441dff |
| 2 | Support email works (round trip) | **FAIL (unproven)** | Forwarding via Squarespace set up; first test bounced "550 5.7.1 Relaying denied" minutes after setup. Retest after propagation, then forward me the headers |
| 3 | Sending from @getdeploi.com does not fail DMARC | **FAIL** | DMARC `p=reject` with strict alignment, and Resend DKIM records are not in DNS. Mail from the app would be rejected. Needed before turning on live sends (not needed for review: sends stay off) |
| 4 | App Store registration | **PASS** (your report: Registered) | |
| 5 | Production app exists, public distribution, Free | **PENDING** | Click list §G |
| 6 | App config deployed (URLs, scopes, 3 compliance topics) | **PASS for dev** (`deploi-dev-5` active); **PENDING for prod** | |
| 7 | Compliance webhooks answer 401 on a bad signature | **FAIL on prod today** (503, `SHOPIFY_API_SECRET` unset in Production) | Passes after Production vars + deploy. On dev: 401 from the app is shown after Vercel Authentication is off |
| 8 | Session tokens, no third-party cookies, App Bridge first | PASS (local, unit + browser) | Re-run in STOP #2 |
| 9 | Only Shopify billing; Free listing | PASS | `BILLING_REQUIRED=false` |
| 10 | Minimal scopes, no protected customer data | PASS | toml scopes; no `read_orders` |
| 11 | TLS, expiring offline tokens | PASS | |
| 12 | Live in-store run, every flow | **PENDING** | STOP #2 |
| 13 | 3–6 screenshots 1600×900, icon approved, screencast | **PENDING** | After STOP #2; script in `LISTING.md` §7 |
| 14 | Emergency contact (email + phone) in Partner Dashboard | **PENDING (you)** | |
| 15 | `STORE_ACCESS_MODE=open` in Production | **FAIL (missing)** | Add (setup list). Without it reviewers see the beta card and cannot make changes |
| 16 | IP allowlist enforcement on both apps (before Nov 20) | PENDING (you) | Test result on dev: 0 of 76 blocked |
