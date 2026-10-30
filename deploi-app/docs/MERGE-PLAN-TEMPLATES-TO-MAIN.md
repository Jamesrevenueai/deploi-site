# Getting the three templates onto `main`: diff, conflicts, merge order

As of 2026-10-29. `main` is at `b8aad24` and carries none of the agent platform: no templates, no email, no competitor
watcher, no production auth guard. Nothing below is merged; this is the plan and the approvals needed.

## 1. Where everything is

| Branch | Head | Commits ahead of `main` | Files vs `main` | Holds | Draft PR |
|---|---|---|---|---|---|
| `subscription-product` | `286203a` | 28 | 204 | merchant engine, four Shopify corrections, email connector, App Store readiness | #1 (base `main`) |
| `claude/prod-auth-guard` | `3419c2e` | 2 | 10 | production auth guard + per-project Vercel `ignoreCommand` + PRODUCTION-SAFETY runbook | #2 (base `main`) |
| `claude/agents-platform` | `1f26871` | 36 | — | templates, tiers, tasks, work log, weekly summary, agent mailboxes (on top of #1) | #3 (base `subscription-product`) |
| `claude/platform-launch` | `9bd7b24` | 48 | 388 | #3 + security fixes (`395f37c`), its own Competitor & Trend Watcher, store eligibility (migration 34), free-beta limits, release docs | #4 (base `claude/agents-platform`) |
| `claude/retire-consulting` | `365c3a7` | 41 | 858 | #3 + a *second* Competitor & Trend Watcher implementation (migration 33), then removal of the whole home-care consulting product | #5 (base `claude/agents-platform`) |
| `claude/jolly-ptolemy-kp7ljd` | this branch | 41 + 4 | — | `claude/retire-consulting` + cherry-pick of `395f37c` + optional write scopes + this run's proof and docs | #6 (base `claude/retire-consulting`) |

`claude/agents-platform` already contains `6085c28`, the same guard as `f516a8b` on `claude/prod-auth-guard`, so the
guard reaches `main` with either #2 or #5/#6.

### The fork

`claude/platform-launch` and `claude/retire-consulting` both start from `claude/agents-platform` (`1f26871`) and
diverge:

| | `platform-launch` only | `retire-consulting` only |
|---|---|---|
| Commits | 12 (`f516a8b`, `3419c2e`, `395f37c`, `636965f`, `86094a9`, `3c02065`, `77cc0b2`, `a5c1e40`, `dd5d6cd`, `13425bb`, `6c96747`, `9bd7b24`) | 5 (`6158f47`, `adb37ed`, `481fe94`, `1f26871`→ build-skip, `365c3a7`) |
| Files different between the two | 714 | |
| Lines | +26,055 / −2,726 | +2,726 / −26,055 |
| Competitor watcher | own engine + UI, **migration 34** for eligibility | own engine + UI, **migration 33** `competitor_watch` |
| Consulting product (home-care pages, crons, workers, EVV, imports) | still present | deleted (that is the −22k lines against `main`) |

Merging `claude/platform-launch` into `claude/retire-consulting` (simulated with `git merge --no-commit`) conflicts in
**38 files**: 7 under `app/api` (deleted consulting routes that `platform-launch` still edits, plus
`store/agents/route.ts` and `agents/[id]/competitors/route.ts`), 6 `components/store` (Agents, AgentNew,
AgentDetail, Competitors, format, types), 4 `lib/agents` (policy, run, templates, weekly), 2 `lib/competitors`,
the competitor migration and its rollback, the launch-migration scripts and their test, three test files, two
docs, the website home page and its test, and 8 proof PNGs. The two competitor watchers are not reconcilable by
merge: one has to be chosen and the other dropped.

Merging `claude/retire-consulting` into `main`: **0 conflicts** (verified). Merging `claude/prod-auth-guard` into
`claude/retire-consulting`: 4 conflicts (PRODUCTION-SAFETY.md, middleware.ts, both `vercel.json`), all of them the
same change made twice.

## 2. Recommended merge order (ends with templates + uninstall fix + this run on `main`)

1. **Merge PR #6 into `claude/retire-consulting`** (this branch; 0 conflicts by construction). It adds the uninstall
   fix (`9c92c90`, cherry-picked from `395f37c`), the optional write scope, the dev-store proof and the docs.
2. **Re-base PR #5 onto `main`** (change its base in GitHub from `claude/agents-platform` to `main`; no git
   rewrite needed, 0 conflicts verified) and **merge it**. `main` then has the merchant engine, the three templates,
   the weekly summary, agent mail, the production auth guard, the uninstall fix and the dev-store work, and no
   consulting product. PRs #1 and #3 become redundant (their commits are all contained) and can be closed.
3. **Decide the competitor watcher** (recommendation and diff summary in `COMPETITOR-WATCHER-DECISION.md`). Either keep the one on `main` after step 2 (migration 33) and close PR #4
   after cherry-picking from `claude/platform-launch` the parts that are not competitor code and not consulting
   code: `3c02065` store eligibility (migration 34, which would have to be renumbered after 33), `dd5d6cd`
   free-beta limits, `6c96747` cron auth, `9bd7b24` bounce handling and launch migrations; or take
   `platform-launch`'s watcher instead, which means reverting `6158f47`/`adb37ed`/`481fe94` first and resolving
   the 38 conflicts. The first is less work and keeps the branch that was tested in this run.
4. **Close PR #2.** Its guard is already on `main` via step 2; its `vercel.json` build-skip rule is also there
   (`1f26871`). Nothing in it is lost.
5. **Apply the launch migrations** (28 to 33, then 34 once renumbered) to the Supabase project with
   `scripts/launch-migrations.ts` before the first production deploy that contains them, as `LAUNCH-STEPS.md`
   describes; `main` deploys production, so protect `main` first (step 1 of `LAUNCH-STEPS.md`).

## 3. What you approve

- PR #6 → `claude/retire-consulting` (step 1).
- PR #5 with its base changed to `main` (step 2). This is the one that puts the templates on `main`.
- The competitor-watcher decision in step 3, and the follow-up PR that ports the four non-watcher commits.
- Closing #1, #2, #3 as superseded.

Nothing merges to `main` until you say so; production still serves `fd0e89e`.
