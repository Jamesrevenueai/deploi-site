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
| `deploi-app` Playwright, `DEMO_CONTROLS=true` | see below | |
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

Playwright, SHAs, preview deployment IDs and the screenshot index are at the end of this file.

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
