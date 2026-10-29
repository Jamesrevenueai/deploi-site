# Competitor & Trend Watcher

The fourth agent template. It tells a merchant what **other** stores publicly launch, discount, mark
available or unavailable, and feature in their own bestseller collections, and where several watched
stores move the same way. It is competitor intelligence from public pages, not an analysis of the merchant's
own sales, and it never claims anyone's sales.

## What it can and cannot know

| | Status | Why |
|---|---|---|
| Products a store lists, their titles, types, tags, store-stated published date | **Observed** | public product feed |
| Prices and compare-at ("sale") prices, in the store's default currency | **Observed** | public feed + the store's own `meta.json` currency |
| Whether each variant is shown as available | **Observed** | public feed; it is not a stock count |
| Order of the store's own bestseller collection | **Observed** (when the store publishes one) | the store chooses that order; it may be manual |
| "Several stores you follow added X this week" | **Inferred** | a pattern among watched stores only, with the reasoning shown |
| Sales, revenue, units, profit, sales rankings | **Unavailable**, never claimed | public pages do not show them; a stockout, sale or launch is not evidence of sales |
| Wider market or search trends | **Unavailable** | no trend or market-data provider is connected (the UI says so) |
| Prices in other regions, checkout or discount-code prices | **Unavailable** | the feed shows the default market |

## Honesty rules enforced in code (`lib/competitors/diff.ts`, tests in `tests/competitors`)

- The first **complete** check of a store is its **baseline**: everything is recorded, nothing is "new". A
  partial first check does not become the baseline.
- A **launch** needs the store's own published date after the baseline. A product simply not seen before is
  "newly observed (dated before monitoring)", and only after two complete checks.
- A product missing from a check is never treated as removed. "No longer listed" needs **two consecutive
  complete** checks without it. Failed and partial checks change nothing about missing products, and a
  store that could not be read produces one "could not be checked" finding (basis Unavailable), not product
  findings.
- Prices are compared for the **same variant in the same currency** only; a currency change suppresses the
  comparison; the comparison view never converts or mixes currencies and warns when stores differ.
- Every insight has: headline, facts, stores and products, source links with observation times, comparison
  period, the inference (if any), limitations (always including "sales are not visible"), and a suggested
  next step written by Deploi (never text from a page).

## Sources and collection (`lib/competitors/sources`, `lib/net`)

- **Interface:** `CompetitorSource.collect({ origin, bestsellerHandle, budget })` → a timestamped snapshot or an
  honest status (`unsupported`, `blocked`, `rate_limited`, `error`). Other sources (licensed feeds, search
  trends) plug in by key; none is connected, and the UI lists them as Unavailable.
- **Working source: public Shopify storefront.** `robots.txt` first and obeyed for every path (RFC 9309);
  `/meta.json` for currency and the published product count (a read is "complete" only if it matches);
  `/products.json?limit=250&page=N`; `/collections/<handle>/products.json` for the store's bestseller
  collection. Never `sort_by` (Shopify's default robots.txt disallows it), carts, logins or checkouts.
  A 401/403, 429, password page or bot challenge stops immediately with that reason; nothing is retried
  around a block.
- **Budgets:** per store per check, `maxRequestsPerStore` (default 12, plan cap 20) and
  `maxProductsPerStore` (default 1000); a pause between requests (`COMPETITOR_REQUEST_DELAY_MS`, default 1 s,
  or the store's `Crawl-delay` up to 10 s); checks at most every 6 hours; organization-wide cap on watched
  stores (`PLAN_MAX_COMPETITOR_STORES`, default 25).
- **SSRF protection (`lib/net/safe-fetch.ts`):** https on port 443 only; no IP literals, credentials or
  internal names; every DNS answer must be public (private, loopback, link-local, CGNAT, multicast,
  reserved, IPv4-mapped, NAT64, 6to4, Teredo and unique-local ranges refused); the connection is pinned to
  the checked address (no DNS rebinding); redirects followed by hand, same site only, at most 3, each one
  re-checked; 6 MB and 15 s caps; content type checked.
- **Untrusted content:** page text is parsed as data, stripped of markup and control characters, capped,
  rendered escaped, and never given to an LLM or used as instructions. Insight wording is Deploi's own.
- **Storage:** `competitor_stores` (health, last success, baseline), `competitor_checks` (each attempt),
  `competitor_products`, change-only `competitor_observations` (first seen / last confirmed, so history shows
  observed states and gaps), `competitor_changes`, `competitor_insights`. All org-read under RLS; writes by
  the server only.

## Permissions and handoff

- The template is drafts only, has **no access to the merchant's store** (no scan, no write; the policy
  refuses correction types and non-draft modes) and may only email the merchant's own alert address, as drafts.
- Adding stores or raising the budget is an expansion that needs a new grant; removing stores applies at once.
- **Handoff:** "Draft a sourcing request" creates a message from a chosen Supplier Chaser to its supplier,
  carrying the finding's products, links, times and limitations. It is never queued automatically: it is a
  draft (drafts-only Supplier Chaser) or waits for approval of the exact text. Both agents' work logs record
  the link. Monitoring never authorizes supplier contact, purchases, inventory or price changes.

## Evidence

- **Synthetic/local:** `tests/competitors/units.test.ts` (SSRF, robots, normalization, source states, baseline
  and change rules, insight basis and limits, entitlements), `tests/competitors/watcher.test.ts` (end to end on
  the database: template, baseline, launches, outage, delisting after two complete checks, cross-store
  pattern, currency separation, alerts, handoff, tenant isolation, pause, plan limits),
  `e2e/competitor.spec.ts` (browser, 1440 and 390 px, no horizontal scroll), screenshots in
  `proof/screens/competitor-*.png`.
- **Live public store (read only, 2026-10-29, through this sandbox's proxy):**
  `npx tsx scripts/competitor-live-check.ts https://www.allbirds.com https://www.gymshark.com https://example.org`
  - `www.allbirds.com`: complete read of **356 products** (the store reports 356), currency USD, 6 requests
    including robots.txt; bestseller collection not reached within the 6-request demo budget.
  - `www.gymshark.com`: **blocked**: "the store refused access (403); Deploi does not bypass access controls".
  - `example.org`: **unsupported**: "this store does not publish a Shopify product feed Deploi can read".
- **Not verified:** a deployed run on Vercel (needs migrations 33–34 in production), and any store's terms
  of use beyond robots.txt (legal review item in `APP-STORE-OPEN-ITEMS.md` §5).
