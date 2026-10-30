# Competitor & Trend Watcher

A Deploi agent template that watches other stores, not yours. It records what they show in public (products, prices, advertised discounts, availability, and the collections they name as best sellers or featured), compares each check with the last one, and points out similar products appearing on several of them. It is not an analytics dashboard for your own sales.

## What the merchant sets up

| Setting | Notes |
|---|---|
| Name | Any name. |
| Competitor stores | Up to 10. Any page of a store can be pasted; Deploi keeps only `https://<host>`. IP addresses, private or local hosts, ports and credentials in the address are refused with the reason. "Check these stores" reads each store's robots.txt and one product (two requests) and says whether Deploi can monitor it. |
| Categories or keywords | Optional. Only products whose name, type or tags mention one are recorded. Empty means every product. |
| How often | Daily (07:30 in the store's time zone) or weekly. |
| Alerts | New products; price changes, with a minimum %, default 5; advertised discounts starting or ending; sold out or back in stock; best-seller list changes; newly featured products; similar products on several stores and possible opportunities. |
| In-app alerts | Always on: the agent's Competitor findings section, plus a "new competitor findings" count on the Agents page and in the weekly summary. |
| Email summary | Optional. The agent gets its own address and writes to your address only, as a draft (drafts only by default). It is written only when there are new findings. |

The competitor installs nothing. Reading a merchant's own Shopify connection never shows another merchant's data, and nothing in the product claims it does.

## Sources: what is supported

- **Supported:** Shopify storefronts that publish Shopify's public product feed (`/products.json`), which most do. From it Deploi reads titles, handles, product type, vendor, tags, publish date, the lowest variant price, the compare-at ("was") price shown with it, and whether any variant can be bought.
- **Supported:** the store's own public collections whose handle names them as best sellers (`best-sellers`, `bestsellers`, `best-selling`, `top-sellers`, `most-popular`, `trending`) or as featured, new or on sale (`featured`, `new-arrivals`, `new-in`, `sale`, `deals`, `clearance`, `offers`…), in the order the store shows them.
- **Not supported:** every other platform. The store is listed as "Skipped: not supported" and nothing is guessed from page layouts.
- **Never read:** a store whose robots.txt disallows the product feed, or disallows everything. It is skipped, and only robots.txt is requested.

## How Deploi reads a store (`lib/competitors/`)

- **robots.txt first**, matched as RFC 9309 describes:
  - the group for `DeploiBot` if the file has one, otherwise `*`;
  - the longest matching rule wins, and Allow wins a tie;
  - `*` and `$` work.
- **If robots.txt can't be read:** a server error or network failure means do not crawl. A missing file (4xx) means everything is allowed.
- **Each check, per store:** robots.txt, at most 4 feed pages of 250 products, the collection list, and at most 3 collections (about 9 requests).
- **Spacing:** at least 1 second between requests to the same store (`COMPETITOR_MIN_INTERVAL_MS`). Stores are checked one at a time.
- **Every request:**
  - identifies itself as `DeploiBot/1.0 (+https://getdeploi.com; …)`, and sends no cookies or credentials;
  - stops after 10 seconds and reads at most 5 MB;
  - must pass the outbound guard (`competitor_public`): https only, a public host, no IP address, and never one of Deploi's own providers.
- **Redirects** are followed by hand and re-checked at every hop, so a redirect can never lead to a private address.
- **Pausing, revoking or deleting** the agent stops it between stores.

## Baseline, then changes

- **First successful check of a store:** recorded as its **starting point**, stored as already seen.
- **Every later check** is compared with the previous observation.

| Finding | Basis | When |
|---|---|---|
| New product | observed | the product was not listed at the previous check. The feed's publish date is shown as a fact, not as a launch date. |
| Price down / up | observed | the lowest variant price moved by at least the merchant's minimum %. Before and after values are shown, each with the time it was seen. |
| Discount advertised / ended | observed | a compare-at price appears above the price, or disappears. A reduction advertised against the old price is reported once, as a discount, not also as a price drop. |
| Sold out / back in stock | observed | whether any variant can be bought changed. Deploi cannot see unit counts. |
| Best-seller list: entered, moved (by 2 or more places), left | observed | Always worded as "the order the store chose to show, not a sales figure". |
| Featured | observed | newly in a featured, new or sale collection. |
| No longer listed | observed | only when the whole feed was read this time. Otherwise absence proves nothing. |
| Similar products on N stores | inference | similar product names (at least two shared words covering 60% of the shorter name) on two or more stores, at least one new, featured or in a best-seller collection. |
| Possible opportunity | inference | as above, with at least two public signals, and none of the merchant's own product names is similar. Worded as "a lead to research, not a forecast". |

Every finding stores its evidence: the page address, the time it was seen and, for a change, the before and after values with the earlier time. Findings are deduplicated, so a repeat check with nothing new adds nothing.

Deploi never states or estimates a competitor's sales, revenue, units sold, conversion rate or exact sales ranking. The tests check every finding's wording against a pattern for sales claims. A task asking for those figures ("Estimate my competitors' sales") is **refused** with the reason.

## Permissions, and where they apply

- **Public web: read only.** It can never change the merchant's store. Its rules say so in one line instead of the store-editing list.
- **Granting:** nothing is read until the authorization is granted.
- **Widening needs a new grant:** a new store, more keywords, or dropping all keywords (which means every product). Until then, only the granted stores are read.
- **Narrowing** (removing a store) takes effect at once.
- **Own catalog:** comparing with the merchant's own product names reads their store's titles only (read only). It can be turned off, and then the store is not read at all.
- **Work log:**
  - each store checked or skipped, with the reason, as "authorization vN (public pages of other stores: read only)";
  - trend inferences as their own entry.
- **Tasks:**
  - "Check my competitors now" runs the agent.
  - The same request to an agent without competitor monitoring needs a wider grant.
- **Pause, revoke, delete:** the existing controls. Deleting the agent also removes what it recorded about other stores; the audit trail keeps the record of what was done.

## Data model (migration `20261029000033_competitor_watch.sql`)

| Table | Holds |
|---|---|
| `competitor_sources` | one row per agent and store: platform, status, reason, starting point, last checked |
| `competitor_products` | the latest public state of each product seen |
| `competitor_checks` | every check, including skipped ones: status, requests, products read, exact URLs |
| `competitor_findings` | kind, basis (observed or inference), title, summary, evidence, status (new, seen, dismissed) |

All four use the same row-level security model as the rest of the engine:
- members of the organization can read its rows (staff can read too);
- writes are server-side only;
- another organization gets "not found".

The migration is in `scripts/launch-migrations.ts` with a rollback in `supabase/rollback/`. It has **not** been applied to production.

## Synthetic stores for tests and demos

`lib/competitors/synthetic.ts` serves five stores on the reserved `.example` domain:
- three Shopify-like stores with two snapshots each;
- one store with no feed;
- one store that disallows crawling.

They are used only in tests, or when `DEMO_CONTROLS=true` / `COMPETITOR_SYNTHETIC=on`, and never on a production deployment. Seed the demo with `npx tsx --env-file=.env.local scripts/seed-platform-demo.ts`.

## Not verified

- **No real competitor store has been read.** Every test and screenshot uses the synthetic stores. Real Shopify feeds vary: some stores disable `/products.json` or cap pages, and collection handles differ.
- **Bot blocking:** Deploi can't control how real stores and CDNs treat an unknown crawler; some will refuse it. Deploi reports that store as unreachable or skipped and never tries to get around it.
- **DNS rebinding:** a store host that resolves to a private address is not caught. The guard checks the name, not the resolved IP. Production on Vercel has no private network to reach, but this is noted for any other host.
- **Legal review:** reading public storefront data is common practice, but each store's terms of service differ. Have counsel confirm the approach and the `DeploiBot` identification (and publish a page for its `+https://getdeploi.com` contact) before launch.
