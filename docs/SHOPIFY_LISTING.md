# Shopify App Store listing: Deploi (paste-ready)

Written 2026-11-22. Every feature named here is one the **embedded app actually shows today**: the three store
templates in `deploi-app/lib/shopify/embedded.ts` (`EMBEDDED_TEMPLATES`: Inventory Watcher, Supplier Chaser, Store
Health Checker), Approvals, the work log, Connections, the weekly summary and Privacy requests. The library Team,
custom agents and the Office suite are hidden inside Shopify (`shopifyLibraryAgentKeys()` is empty), so they are
**not** listed. Shopify reviewers check that every listed feature exists.

Rules this copy follows (Shopify App Store requirements §4): no statistics, no "best/first/only", no guarantees, no
testimonials, no prices outside the pricing section, no Shopify trademarks in images, English only.

## 1. Identity

| Field (limit) | Paste |
|---|---|
| App name (30) | **Deploi** |
| App icon | `deploi-app/docs/app-store/icon-1200.jpg` (1200×1200, no text) |
| App card subtitle (62) | **Agents that find stock problems and fix them with your OK** (57) |
| Primary language | English |
| Category | Store management → Operations (secondary: Inventory management). Confirm the exact names in the picker |
| Online Store required | No |
| Integrations (6) | Microsoft Outlook, Gmail (optional mailbox for alert and supplier emails) |

## 2. Text

**Tagline / app introduction (100):**
> Deploi agents watch your inventory, draft the fix, and change your store only the way you allow.

**App details / description (500):**
> Choose an agent from a template and read exactly what it may do before you grant it: which products, which one
> setting, which limits. Agents start at drafts only. Let one act after your approval and each change waits in
> Approvals, or let it fix and tell you. Every change is re-read from your store to confirm it took effect, and kept
> in a work log with the permission that allowed it. A weekly summary shows what each agent did. Pause or revoke an
> agent at any time.

**Feature bullets (80 each):**
1. Finds products that keep selling when out of stock, and skips pre-orders
2. Read each agent's exact permissions before you grant them
3. Drafts first: approve each change, or let an agent fix and tell you
4. Every change re-read from your store and kept in a work log
5. Restock emails to your supplier, drafted for you to review

**How the app uses its access (paste where the form asks):**
> - View products, inventory and locations (`read_products`, `read_inventory`, `read_locations`): to find products
>   that keep selling when out of stock, and to re-read each one after a change.
> - Edit products (`write_products`): so an agent can change one setting, "Continue selling when out of stock", and
>   only the way you set it ("ask me first" or "do it and tell me"). Deploi never changes stock quantities.
> - View discounts (`read_discounts`): to notice discount changes.
> Deploi does not ask for customer, order, fulfillment or return data. Showing a product on a sales channel
> (`read_publications`, `write_publications`) is asked for separately, only if you turn that on.

**Search terms (5):** inventory, overselling, out of stock, store automation, restock

## 3. Pricing

**Free to install. Free plan only at launch** (founder decision, 2026-11-23). Pricing in the Partner/Dev Dashboard: **Free**.
No charges, no Billing API calls: `BILLING_REQUIRED` is off in Production, and the app refuses to start a Shopify
subscription while it is off (`app/api/billing/subscribe/route.ts`, tests `tests/billing/free-at-launch.test.ts`).
The paid Store plans in `deploi-app/lib/pricing/catalog.json` ($79 / $199 / $499) are for later: they go into the listing
only when billing is switched on, and the listing pricing must then be updated in the same change.

## 4. URLs and contact (all checked live 2026-11-22: HTTP 200)

| Field | URL |
|---|---|
| Privacy policy | https://getdeploi.com/privacy |
| Terms of service | https://getdeploi.com/terms |
| Support / FAQ | https://getdeploi.com/support |
| Developer website | https://getdeploi.com |
| App URL | https://app.getdeploi.com/shopify |
| Support email | support@getdeploi.com |
| Operator shown on the legal pages | James Investments and real estate holdings LLC, Columbus, Ohio (casing: see FOUNDER_ACTIONS.md) |

## 5. Screenshots (1600×900, 3–6, real UI, no browser frame, no personal data)

The drafts below were captured on 2026-11-22 from the embedded app at 1600×900 against a local build with a stubbed
Shopify admin (synthetic store). They are in `docs/listing-screenshots/`. **The final images must be retaken from
the development store james-jwtftl1e inside the real admin**: the app has not been installed there from this session
(FOUNDER_ACTIONS.md step 4).

| # | File | Caption (alt text) |
|---|---|---|
| 1 | `listing-overview.png` | Overview listing products that keep selling when out of stock, each with its evidence |
| 2 | `listing-agents.png` | Agent templates: choose one and read exactly what it may do before you grant it |
| 3 | `listing-issues.png` | An issue with the drafted change, before and after, waiting for your approval |
| 4 | `listing-connections.png` | Your store and an optional mailbox, with what each agent may use |

## 6. Testing instructions for the reviewer (paste into the submission form)

> Deploi opens inside your Shopify admin after you approve its permissions. There is no separate login.
>
> Setup (2 minutes): in your development store, pick a product with tracked inventory, set its available quantity
> to 0 and turn on "Continue selling when out of stock". Optionally do the same for a second product tagged
> `pre-order`.
>
> 1. **Overview:** click **Run scan**. The product appears as an issue with its evidence.
> 2. **Agents:** choose **Inventory Watcher**. Enter an email address for alerts, click **Review authorization**,
>    then **Grant**, then **Run now**. At "drafts only" the change is shown and nothing in your store changes.
> 3. **Make a change:** on the agent click **Edit**, choose **After my approval**, save and **Grant** the new
>    version. Click **Run now**, open **Approvals** and **Approve**. The change shows **Verified** and the product
>    no longer sells when out of stock. The pre-order product is left alone.
> 4. **Work log:** the agent page lists every run and change with the permission that allowed it.
> 5. **Other templates:** Store Health Checker (weekly report) and Supplier Chaser (drafts a restock email to the
>    supplier address you enter; nothing is sent without your approval).
> 6. **Privacy:** lists customer data requests Shopify sends (empty on a new store).
>
> During review, agents can change development stores only; email to real recipients is held, so you see drafts and
> "would send" states. To remove the app, uninstall it from Settings → Apps: access stops at once, agents are paused,
> and store data is erased when Shopify sends `shop/redact`.

Before you paste: run every step above once on a development store with the **production** app, and remove any
step that does not work.

## 7. Demo screencast (required, 2–3 min, English)

Use the script in `deploi-app/docs/app-store/LISTING.md` §7, replacing "Deploi AI" with "Deploi".
