# Shopify App Store listing: Deploi AI (draft for the submission form)

Written 2026-11-06 against shopify.dev "App Store requirements" §4 and "Best practices → App listing" (read the
same day). Field limits come from those pages. **Founder approval needed** wherever it says so. Every feature
below is one the embedded app actually shows today (`lib/shopify/embedded.ts`). Hidden features (library Team,
build-your-own agents, Office suite, Supplier Coordinator, Competitor & Trend Watcher) are left out on purpose.

Rules this copy follows: no statistics, no "best/first/only", no guarantees, no testimonials. No prices outside the
pricing section, including images and the icon. No Shopify trademarks in graphics. English only.

## 1. Identity

| Field | Value | Note |
|---|---|---|
| App name (max 30) | **Deploi AI** (9 chars) | Same as `name` in `shopify.app.toml.example` (requirement 4.1.1). Brand-led. |
| App icon | `docs/app-store/icon-1200.jpg` (1200×1200, no text) | **Founder: approve the icon.** |
| App card subtitle (max 62) | **Agents that catch stock problems and fix them with your OK** (58) | Benefit-led, no keywords or stats. |
| Primary language | English | The UI is English only. |
| Categories | Primary: **Store management → Operations**. Secondary: **Inventory management** | Confirm the exact names in the form's category picker (they change). |
| Sales channel requirement | **Online Store not required** | The app never touches the storefront or theme. |
| Geographic requirements | None | |
| Integrations (max 6) | Gmail, Microsoft Outlook | Optional mailbox connection under Connections. QuickBooks is **not** shown in the Shopify app, so don't list it. |

## 2. Text

**App introduction (max 100):**

> Deploi agents watch your inventory, draft the fix, and change your store only after you approve it.

(99 characters)

**App details (max 500):**

> Describe a job in plain English or start from a template, and Deploi turns it into an agent with a written
> authorization: which products, which single setting, which limits and schedule. Nothing runs until you grant it.
> Agents start at drafts only. Widen one to "after my approval" and each change waits in Approvals. Every change is
> re-read from your store to confirm it took effect, and every action is kept in a work log with the permission
> that allowed it. Pause or revoke an agent at any time.

(498 characters; recount in the form)

**Feature list (max 80 each, up to 5 recommended):**

1. Finds products that keep selling when out of stock, skipping pre-orders
2. Agents from templates or plain English, each with an authorization you grant
3. Drafts first: approve each change, or let an agent act within your limits
4. Every change re-read from your store and kept in a work log
5. Optional supplier restock emails drafted for you to review before sending

**Search terms (max 5, whole words, one idea each):** inventory, overselling, out of stock, store automation, restock

## 3. Pricing (pricing section only)

`lib/plans` holds the plans. Every seeded plan is a **hypothesis**, so nothing below is approved.

**Recommendation for Saturday: list as "Free to install" with one Free plan, and keep `BILLING_REQUIRED=false`.**
Why:
- The Shopify App Pricing path (Partner API read, hosted plan page, plan → entitlements) is built and tested
  locally only (`tests/merchant/app-store.test.ts`). It has not run against Shopify.
- A paid plan must show its exact features. Today the commerce plans are defined by library agents that the
  Shopify app hides.
- Free avoids requirement 1.2.2 ("accept, decline, request approval again on reinstall") until billing is
  verified on a development store.

If you choose paid plans instead (**founder approval required for every number**):

| Plan handle (must equal `plans.key`) | Shown name | Price (hypothesis) | Trial | Listing features (only Shopify-visible ones) |
|---|---|---|---|---|
| `starter` | Starter | $29 / month (`plans.monthly_price_cents` 2900) | recommend 14 days (seed says 0) | up to 5 agents · 150 agent actions a month · email drafts |
| `growth` | Growth | $79 / month (7900) | 14 days | up to 12 agents · 500 actions a month |
| `pro` | Pro | $199 / month (19900) | 14 days | up to 30 agents · 1,500 actions a month |

Then do all of the following:
1. Create the same plans in Partner Dashboard → App → **Pricing** (Shopify App Pricing). The plan handles must be
   exactly `starter`, `growth`, `pro`: `recordSubscription` maps a handle to a plan key.
2. Set `BILLING_REQUIRED=true`, `SHOPIFY_APP_HANDLE`, `SHOPIFY_PARTNER_ID`, `SHOPIFY_PARTNER_APP_ID`,
   `SHOPIFY_PARTNER_API_TOKEN` in production.
3. On a development store (charges there are test charges), check: choose, upgrade, downgrade, cancel, then
   uninstall and reinstall to confirm the plan is asked for again.

## 4. URLs

| Field | URL | Status today |
|---|---|---|
| Privacy policy (required) | `https://getdeploi.com/privacy` | **Not live.** getdeploi.com serves a parking page ("Coming Soon", checked 2026-11-06). The page exists in this repo (`src/pages/Legal.tsx`) and shows "Draft, pending legal review". |
| Terms of service | `https://getdeploi.com/terms` | Same: not live; draft. |
| Support / FAQ | `https://getdeploi.com/support` | Same: not live. The page (`src/pages/Support.tsx`) covers install, permissions, uninstall and data deletion. |
| Pricing details link | `https://getdeploi.com/pricing` | Not live. Leave the field empty if you list as Free. |
| Developer website | `https://getdeploi.com` | Not live. |
| App URL | `https://app.getdeploi.com/shopify` | Live (health check 200). |
| Changelog, tutorial | none | Optional. Leave empty. |

**Blocker:** point getdeploi.com at the new site (`docs/LAUNCH-DNS.md`) before you submit. Shopify opens the
privacy policy link during review.

## 5. Support contact

- Recommended address: **support@getdeploi.com**. The site and app use `hello@getdeploi.com` today. The
  previous support address (another company's) must not be used anywhere.
- Steps: see `SUBMISSION-CHECKLIST.md` §C.4.

## 6. Screenshots and feature media

Requirements: 1600×900 (16:9), 3–6 desktop screenshots, real UI, no browser chrome or desktop, no PII, no
pricing, reviews or guarantees, each unique, with alt text.

Capture drafts with the stubbed admin (already 1600×900):
`E2E_SCREENS_DIR=proof/listing npx playwright test e2e/embedded.spec.ts` writes `listing-overview`,
`listing-agents`, `listing-issues` and `listing-connections`. **Final images:** capture from a development store
inside the real admin, then crop to the app frame. They must show no "synthetic" or "demo" labels.

| # | Screen (embedded path) | What must be visible | Alt text |
|---|---|---|---|
| 1 | Overview (`/shopify`) after a scan | open issues with evidence, "Run scan" | "Overview listing inventory issues found in the store, each with its evidence" |
| 2 | Create agent (`/shopify/agents/new?template=inventory_watcher`), authorization step | the readable authorization before Grant | "Readable authorization for a new agent, shown before it is granted" |
| 3 | Approvals (`/shopify/inbox`) | one drafted change: the setting from On to Off | "A drafted change waiting for approval, showing the setting before and after" |
| 4 | Agent detail, work log (`/shopify/agents/<id>`) | a Verified change and the permission that allowed it | "Work log entry for a verified change and the permission that allowed it" |
| 5 | Connections (`/shopify/connections`) | store and mailbox, with permissions | "Store and mailbox connections with what each agent may use" |
| 6 (optional) | Weekly summary (`/shopify/weekly`) | the in-app summary | "Weekly summary of what each agent did and what needs attention" |

Feature media: a 1600×900 image with one focal point (the agent card plus the authorization), a solid background,
and no text that repeats the subtitle. Or use the video in §7.

## 7. Demo screencast (required, English, 2–3 min). Record on a development store at 1080p or higher

Prepare: a development store with 5 products. Product A tracks inventory, has 0 available, and has "Continue
selling when out of stock" **on**. Product B is the same, tagged `pre-order`. App installed. `STORE_ACCESS_MODE=open`.

| Time | Click | Say |
|---|---|---|
| 0:00 | Shopify admin → Apps → **Deploi AI**: the permission screen, then the app opens | "Deploi installs from the Shopify admin and opens right inside it." |
| 0:15 | Overview → **Run scan** | "A scan finds products that keep selling with no stock. Each issue shows its evidence." |
| 0:35 | Agents → template **Inventory Watcher** → enter your email → **Review authorization** | "Every agent starts at drafts only. Before it runs, you read exactly what it may do and what it never does." |
| 0:55 | **Grant** → **Run now** → drafted change | "At drafts only it shows the exact change, from On to Off, and changes nothing." |
| 1:10 | Shopify product A: setting still on | "The store is untouched." |
| 1:20 | Agent → **Edit** → *After my approval* → Save → **Grant** the new version | "Giving it more needs a new grant." |
| 1:40 | **Run now** → Approvals → **Approve** → status *Verified* | "Approving makes that one change, then re-reads the store to confirm it." |
| 2:00 | Product A: setting now off. Product B (pre-order): unchanged | "Only that product changed. Pre-orders are skipped." |
| 2:15 | Agent → Work log | "Every action is logged: what, when and which permission allowed it." |
| 2:30 | **Pause** → **Revoke** | "Pause or revoke at any time. Queued changes stop too." |
| 2:40 | Privacy (menu) | "Customer data requests from Shopify are answered here." |

Keep screen recording to no more than about 25% of the promotional video, per Shopify's best practice. The
review screencast can be all screen recording. Record two cuts if you want a promotional video.

## 8. Testing instructions for the reviewer (paste into the submission form)

> Deploi AI opens inside your Shopify admin after you approve its permissions. It needs no separate login or
> password.
>
> Setup (2 minutes): in your development store, pick a product with tracked inventory, set its available quantity
> to 0, and turn on "Continue selling when out of stock". Optionally do the same for a second product tagged
> `pre-order`.
>
> 1. **Overview:** click **Run scan**. The product appears as an issue with its evidence.
> 2. **Agents:** choose the **Inventory Watcher** template. Enter an email address for alerts, click **Review
>    authorization**, then **Grant**. Click **Run now**. At "drafts only" the change is shown and nothing is
>    changed in your store.
> 3. **Make a change:** on the agent, click **Edit**, choose **After my approval**, save, and **Grant** the new
>    version. When asked, approve the extra product permission (Shopify shows its own prompt). Click **Run now**,
>    open **Approvals**, and **Approve**. The change shows **Verified**, and the product in your admin no longer
>    sells when out of stock. The pre-order product is left alone.
> 4. **Work log:** on the agent page, every run and change is listed with the permission that allowed it.
> 5. **Other templates:** Store Health Checker (weekly report) and Supplier Chaser (drafts a restock email to the
>    supplier address you enter; nothing is sent without approval).
> 6. **Connections:** shows the store and lets you connect a Gmail or Outlook mailbox (optional; your own account).
> 7. **Privacy:** lists customer data requests Shopify sends (empty on a new store).
>
> Email to real recipients is held during review: you see drafts and "would send" states, not delivered mail.
> To remove the app, uninstall it from Settings → Apps. Access stops at once, and store data is erased when
> Shopify sends `shop/redact`.

Before pasting: run every step above on a development store with the production app. Remove any step that does not work.
