# Aurora build report: agent library, tiers, pricing, website (branch `claude/aurora-agent-library`)

Base: `claude/retire-consulting` at 5ece2f0 (rebased from 365c3a7; the base merged `claude/agents-platform` meanwhile). Parallel session: `claude/jolly-ptolemy-kp7ljd` (dev-store test), untouched.
Nothing in this branch touched production, Vercel environment variables, deployments, the Shopify CLI, the
Shopify app configuration or the dev store. Email stays off. Every live Shopify read or write for the new
agents sits behind `lib/library/store-data.ts`, whose live implementation refuses with `not_wired`.

## Not delivered as specified, and why

- **The Aurora mockups zip was not attached.** `deploi-aurora-mockups.zip` was not in the session's upload
  folder, the attach folder, either repository or any branch. The Aurora theme here is my interpretation
  (night ground, aurora light in teal, violet, blue and rose, glass panels, bot characters), built in the
  existing stack. The screenshot pairs in `proof/aurora/` are **before (base branch) / after (this branch)**,
  not mockup / build. When the zip arrives, unzip it into `deploi-app/design/mockups/` and the theme tokens in
  `styles/tokens.css` (`--au-*`) and `app/globals.css` are the place to match it.
- **No language model is wired.** Chat replies and drafts are composed deterministically from store facts (so
  nothing can be invented); `setLibraryBrain` in `lib/library/chat.ts` is the seam for a model. Costs are
  therefore estimates (`measured = false` on every usage row).
- **The nine new agents run on the synthetic store only.** The three existing agents use the verified
  correction engine. A real store gets `blocked: not wired` from the new agents, and nothing is written.
- **Preview deployments** are created by Vercel from the GitHub push, not from this session; their IDs are
  listed below once they exist.

## Checks (pass / fail)

| Check | Result | Count |
|---|---|---|
| `deploi-app` typecheck (`tsc --noEmit`) | pass | |
| `deploi-app` lint (`eslint .`) | pass | 0 problems |
| `deploi-app` vitest | pass | 262 / 262 in 37 files (base 202 after its merge; 60 new) |
| `deploi-app` build (`next build`) | pass | |
| `deploi-app` Playwright, `DEMO_CONTROLS=true`, rebased build | pass | 36 / 36: the full run was 35 / 36 (the capture script had left Listing Writer at "act" and the spec's reset step did not restore "draft"); after fixing the reset step the spec passed 7 / 7, and the earlier full run before the rebase was 36 / 36 |
| `deploi-app` launch migrations 28–34 (now 8 files with the base's store access) apply / rollback / re-apply on a production-shaped copy | pass (run before the rebase; the list and the script were updated for the base's extra migration) | |
| `deploi-site` typecheck | pass | |
| `deploi-site` lint | pass | 0 problems |
| `deploi-site` vitest | pass | 41 / 41 in 4 files (base 37 after its merge; 4 new) |
| `deploi-site` build (`vite build`) | pass | |
| Trial merge with `claude/jolly-ptolemy-kp7ljd` (`git merge-tree`) | 3 conflicts, none caused by this branch (see below) | |

## Conflicts with the other session's branch

`git merge-tree` of this branch against `claude/jolly-ptolemy-kp7ljd` reports three conflicting files:
`deploi-app/docs/SHOPIFY-SETUP.md`, `deploi-app/lib/connectors/shopify/install.ts` and
`deploi-app/shopify.app.toml.example`. The same three files conflict when the other branch is merged against the
**base** alone (`origin/claude/retire-consulting` at 5ece2f0, which merged `claude/agents-platform` after both
sessions branched). This branch does not touch any of the three, so it adds no conflicts of its own; the other
session will meet those three when it rebases on the current base, whatever happens to this PR. Before the base
moved, the trial merge of the two branches was clean.

The files both branches change in different places (auto-merged, no conflict): none. The files this branch
shares with the base's own merge and that were resolved during the rebase: `lib/engine/audit.ts` (two new
entity types, `access` and `library`), `scripts/launch-migrations.ts` and its test and script (eight launch
migrations), `src/pages/Home.tsx` (the base's agent illustrations kept beside the library grid) and
`src/styles.css` (both appended blocks kept). The eight `proof/platform-*.png` images the base regenerated are
the base's versions.



## What the tests cover (new, `tests/library/`, 60 cases)

- config: 12 agents, nested tiers, config-driven membership (moving an agent is a JSON edit), every agent
  has a runner, a character, an example task, scopes, costed and timed action types; pricing margins > 80%.
- runners: every one of the 12 agents produces work on the synthetic store, each action of a declared type
  with evidence; per-agent behaviour (late orders, return policy, word limits and tone, pre-order skips,
  fee anomalies, Agentic channel gaps, promo codes); the live stub refuses every read and write.
- tiers: 8 locked on Starter with the unlocking tier; a locked agent cannot be switched on, raised or
  granted; upgrading unlocks; downgrading switches off and expires drafts; staff and other stores.
- permission levels: read (reports only), draft (queue, nothing changes), act without grant = draft,
  act with grant = done with proof from a fresh read, daily cap, revoke, lowering revokes grants; money
  and publishing actions approval-only even with a forced grant; approve/decline with proof and log.
- switches: engine-backed agents create and grant their engine agent at drafts only, pause/resume;
  Supplier Chaser needs its supplier address; standing instructions; the scheduler.
- chat: instructions, run now, what's waiting, approve everything (holds money actions), refusal with a
  pointer to the right agent, switched-off reply, pluggable brain.
- build your own: defaults to read, Pro only, runs matched capabilities under its own permission.
- usage and allowance, onboarding, feedback, weekly time and money saved in the summary email.

## SHAs, previews, screenshots

| Item | Value |
|---|---|
| Branch | `claude/aurora-agent-library` on `Jamesrevenueai/deploi-site`, base `claude/retire-consulting` (5ece2f0) |
| Commits | f5f9576 (library, theme, screens, site, tests, docs) · 372780a · 9d4ea4d · 2ebd7a0 · 9a0bb28 · 13ae5a2 (website reconciled with the base's illustrations) · 4e08451 · 0014532 (screenshot pairs) · the commit carrying this section (site title and description) |
| Vercel preview, `deploi-app`, commit 0014532 | `dpl_E9Z3Ea35oTSfr7XoC63Yf8x72g3e` (https://vercel.com/james-ai/deploi-app/E9Z3Ea35oTSfr7XoC63Yf8x72g3e), created by Vercel from the GitHub push; state at the time of writing: building. It runs with whatever Preview environment variables the project already has; none were changed. The team screens there need a signed-in merchant, so the synthetic walk-through is in the screenshots below. |
| Vercel preview, `deploi-site`, commit 0014532 | `dpl_BXWffqm5f8wrWG7iQe5GhHp8zvag`: **cancelled by the site's own ignore rule**, because that commit changed only app files. The commit carrying this section changes the site's title and description, so Vercel builds a new site preview from it; its ID is in the final message, not here. |
| Screenshot pairs | `deploi-app/proof/aurora/index.html`: 17 pairs, each at 1440 and 390 (68 images). Before = the base branch (5ece2f0) built in a second checkout; after = this branch. 13 screens did not exist on the base (the left side says so); 4 (weekly summary, overview, engine agents page, website home) compare the same route. |

Screens captured: team dashboard (Pro) · team dashboard (Starter, eight locks) · agent chat with a spoken instruction · approval queue · activity log with proof · standing instructions · auto-run grants · a locked agent · plan and usage · onboarding · feedback sheet · weekly summary · overview · engine agents page · website home · website /agents · website /pricing.

## Proposed tier prices (for approval; shown as "coming soon" until approved)

| Tier | Agents | Included actions / month | Base | Overage / action | Model cost at full allowance | Margin |
|---|---|---|---|---|---|---|
| Starter | 4 | 150 | $29 | $0.25 | $2.75 | 91% |
| Growth | 8 | 500 | $79 | $0.20 | $9.18 | 88% |
| Pro | 12 + build your own | 1,500 | $199 | $0.15 | $27.53 | 86% |

Cost per action: $0.0184 on average (Claude Sonnet 5.5 list prices, 1.5× overhead); details and the per-action table in `PRICING-PROPOSAL.md`.

## Revised launch date estimate

Counting from 2026-10-30, with one engineer:

- **Private beta, five stores, unlisted app: 2 to 3 weeks.** Needs the live `StoreData` reads for the nine new agents (orders, fulfilments, returns, payouts, discounts, publications, the Agentic channel), each verified against a fixture; the per-agent optional scopes added to the app configuration (the other session's optional-scope flow); and the live store to stop answering `not_wired`. The three existing agents can go to beta stores as soon as the other session's dev-store run is green.
- **Prices live: when you approve the numbers** (a one-line config change, same day).
- **App Store submission with the Growth and Pro agents: 5 to 7 weeks.** The protected customer data scopes (`read_orders`, `read_customers`, `read_returns`) need the data protection questionnaire, the per-field justifications drafted in `AGENT-SCOPES.md`, and a real-store run of each customer-data agent. Shopify's review of protected data typically adds two to three weeks of elapsed time on top of a clean submission. A Starter-only listing (no customer data scopes) could be submitted in 3 to 4 weeks.

## What is still needed from you

1. **The Aurora mockups zip.** Unzip it into `deploi-app/design/mockups/`; the theme tokens are `--au-*` in `styles/tokens.css` (both copies) and `app/globals.css`.
2. **Approve or change the tier prices and allowances** (`PRICING-PROPOSAL.md`), then set `pricingStatus` to `published` in `agent-library.json`.
3. **Confirm the tier membership** in `agent-library.json` (it matches the brief; moving an agent is a JSON edit).
4. **Decide the model** for drafts and chat (costed on Sonnet 5.5) and provide the key as a Preview environment variable when the brain is wired; nothing in this build calls a model.
5. **Choose Shopify Billing or Stripe** for the base fee and overage.
6. **Approve the scope list** per tier in `AGENT-SCOPES.md` before the other session adds the optional scopes to the app configuration.
7. **Name the five beta stores** and confirm the Customer Care message source (forward or copy to the agent's address).
