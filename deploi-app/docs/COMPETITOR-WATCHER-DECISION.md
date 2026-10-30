# Which Competitor & Trend Watcher should survive

Two implementations were built in parallel on 2026-10-29 from the same base (`claude/agents-platform` @ `1f26871`):

| | `claude/platform-launch` ("PL") | `claude/retire-consulting` ("RC", the branch this run tested) |
|---|---|---|
| Commits | `636965f` engine, `86094a9` UI | `6158f47` engine, `adb37ed` UI, `481fe94` e2e + docs |
| Engine files (`lib/competitors`) | 9 files, 1,004 lines: `run`, `diff`, `insights`, `handoff`, `normalize`, `queries`, `types`, `alerts`, `sources/shopify-public` | 8 files, 804 lines: `run`, `collect`, `compare`, `fetch`, `robots`, `synthetic`, `url`, `queries` |
| Network guard | `lib/net/safe-fetch.ts` (235 lines): https:443 only, no IP literals or credentials, **every DNS answer must be public and the connection is pinned to the checked address (no rebinding)**, same-site redirects by hand (max 3, each re-checked), 6 MB / 15 s caps, content type checked; `lib/net/robots.ts` RFC 9309 | `fetch.ts` (62 lines): `assertApprovedHost` (https, public host, no IP) re-checked per redirect, no cookies, ≥ 1 s between requests per host, 10 s / 5 MB caps. **No DNS pinning** (a hostname that resolves to a private address after the check passes is not caught) |
| Collection budget | `maxRequestsPerStore` 12 (cap 20), `maxProductsPerStore` 1000, `Crawl-delay` honoured up to 10 s, checks ≥ 6 h apart, org cap `PLAN_MAX_COMPETITOR_STORES` 25 | up to 10 stores per agent, min interval 1 s, no per-check request or product budget |
| Completeness | `/meta.json` published count must match the feed, else the check is **partial** and produces no "new"/"removed" findings | first successful check is the baseline; no completeness check |
| Honesty rules in code | launch needs the store's own published date after baseline; "no longer listed" needs **two consecutive complete** checks; same-variant same-currency price comparison only; every insight carries basis `observed` / `inferred` / `unavailable` plus limitations; `insights.ts` 196 lines of pure rules | baseline then changes; findings are `observed` or `inference`; sales-claim wording is pattern-checked in tests; "possible opportunity" needs two public signals and no similar own product |
| Hand-off | `handoff.ts`: a finding becomes a sourcing-request **draft** for the merchant's Supplier Chaser (grants nothing, sends nothing; both work logs link) | none |
| Setup UX | `Competitors.tsx` 410 lines: setup, source health, findings with evidence, comparison, history, hand-off | `CompetitorSetup.tsx` 182 + `Competitors.tsx` 140: **"Check these stores"** (robots.txt + one product, says whether it can be monitored), URL normalisation (`url.ts`), findings |
| Offline demo | `tests/competitors/fake-store.ts` (49 lines, tests only) | `synthetic.ts` (119 lines): `.example` stores with numbered snapshots, used by the seed and the screenshot run |
| Tests | unit 23 + watcher 9 = **32** vitest, e2e 4 | merchant 18 vitest, e2e 3 |
| Migration | `20261029000033_competitor_watch.sql` (174 lines): `competitor_stores`, `_checks`, `_products`, `_observations` (change-only), `_changes`, `_insights`; plus `…34_store_eligibility.sql` | `20261029000033_competitor_watch.sql` (109 lines): `competitor_sources`, `_products`, `_checks`, `_findings` |
| Docs | `COMPETITOR-WATCHER.md`: can/cannot-know table, rules, sources, budgets, SSRF, storage | `COMPETITOR-WATCHER.md`: setup table, sources, baseline, inference rules, limits |
| Status on this branch | not present | present, verified in this run (vitest 200/200, e2e 29/29) |

Same file name, different schema: the two migration 33s cannot coexist. Neither has been applied to production.

## Recommendation: PL's watcher survives, ported onto the surviving branch

Reasons, in order of weight:

1. **It crawls other people's servers, so the network guard is the product's biggest liability.** PL's `safe-fetch`
   pins the connection to a checked public address and refuses DNS rebinding; RC checks the hostname and re-checks
   redirects but trusts whatever the name resolves to. PL also budgets requests and products per check and honours
   `Crawl-delay`; RC has only the 1 s pause. For an App Store listing that fetches third-party stores on a schedule,
   PL's is the one to defend.
2. **PL's findings are harder to get wrong.** Partial reads cannot produce "new" or "removed"; removal needs two
   consecutive complete checks; launches need the store's own date; price comparisons are same-variant,
   same-currency. RC is honest in wording but has none of these guards, so a flaky fetch can read as "sold out".
3. **PL turns a finding into work** (hand-off to the Supplier Chaser as a draft), which is the product's reason to
   have a watcher at all. RC stops at the finding.
4. **More tests** (32 + 4 vs 18 + 3), and PL's `insights`/`diff` are pure functions that the tests exercise directly.

What RC has that is worth keeping in the port:

- **"Check these stores"** (`/api/store/competitors/check`, `CompetitorSetup.tsx`, `url.ts`): the merchant learns
  before granting whether a store can be monitored. PL's "source health" shows this only after the first run.
  Port the endpoint and the setup component on top of PL's `CompetitorSource` interface (one afternoon).
- **Synthetic `.example` stores** for the seed and screenshot run. PL's fake store is tests-only; the local demo and
  `capture-screens.mjs` on this branch depend on RC's synthetic stores. Keep `synthetic.ts` behind
  `COMPETITOR_SYNTHETIC=on`, adapted to PL's source interface.

## What the port costs (from the merge simulation in `MERGE-PLAN-TEMPLATES-TO-MAIN.md`)

Merging PL into RC conflicts in 38 files. By kind:

| Kind | Files | What to do |
|---|---|---|
| Consulting routes PL still edits, RC deleted | 4 (`cron/morning-*`, `cron/workers`, `webhooks/resend-inbound`) | keep deleted (as done for the `395f37c` cherry-pick) |
| Template plumbing both sides touched | `lib/agents/{policy,run,templates,weekly}.ts`, `components/store/{Agents,AgentNew,AgentDetail,types,format}.tsx`, `app/api/store/agents/route.ts`, `agents/[id]/competitors/route.ts` | take PL's side, re-apply RC's consulting removals and this branch's optional-scope changes (`missing_scopes`, `ScopeNotice`) |
| Engine | `lib/competitors/*` (both), `components/store/Competitors.tsx` | PL's wholesale; then re-add RC's `url.ts`, `synthetic.ts`, `CompetitorSetup.tsx` and the check route on PL's interface |
| Migration 33 + rollback, `launch-migrations.ts`, `test-launch-migrations.sh`, its test | 5 | PL's files wholesale; PL's 34 stays 34 |
| Tests | `tests/merchant/platform.test.ts`, `tests/api/lead.test.ts`, `tests/security/launch-migrations.test.ts`; RC's `tests/merchant/competitors.test.ts` (rewrite against PL's engine or drop in favour of `tests/competitors/*`) | run both suites; expect ~230 vitest |
| Website | `src/pages/Home.tsx`, `src/__tests__/forms.test.tsx` | PL's template card text, RC's consulting removal |
| Docs and proof | `COMPETITOR-WATCHER.md`, `PRODUCTION-SAFETY.md`, 8 proof PNGs | PL's doc plus RC's setup table; regenerate PNGs with `capture-screens.mjs` |

Estimate: one focused session. Everything else PL carries that is not watcher code (`3c02065` store eligibility,
`dd5d6cd` free-beta limits, `6c96747` cron auth, `9bd7b24` bounce handling and launch migrations 33–34) comes
along in the same port, which is also what the merge plan's step 3 needs.

## If you prefer the cheaper path

Keep RC's watcher (already on the surviving branch and verified), and port only PL's `safe-fetch` into RC's
`fetch.ts` (the DNS pinning is the one safety gap that matters) plus the two-complete-checks rule for removals.
That is a day less work and loses the hand-off and the per-check budgets. It is a defensible choice for early
access; it is not the one I would make for the App Store listing.

Nothing is merged or changed by this document. The decision is yours.
