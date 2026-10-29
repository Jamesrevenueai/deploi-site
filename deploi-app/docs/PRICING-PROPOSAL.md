# Agent library: proposed tier prices (for approval)

Nothing here is published or charged. The site and the app show **"coming soon"** until `pricingStatus` in
`lib/library/agent-library.json` is set to `published`. The numbers live in that file (`proposedPriceUsd`,
`proposedOverageUsd`, `monthlyActions`) and in `lib/library/pricing.ts` (model prices and tokens per action), so
changing them is a config edit.

## Cost per action

An action is one thing an agent reports, drafts or does. The model cost of an action is estimated from the tokens
one action of that kind reads (store data) and writes (the draft), at Anthropic list prices (2026-10), times an
overhead factor of 1.5 for retries, the verification read and the engine's own reads.

| Model costed | Input $/MTok | Output $/MTok |
|---|---|---|
| Claude Sonnet 5.5 (default: drafting quality matters) | 2.00 | 10.00 |
| Claude Haiku 5.5 (if a cheaper tier of actions is wanted) | 0.10 | 0.50 |

Estimated model cost per action on Sonnet 5.5 (from `tests/library/config.test.ts` numbers):

| Action kind | Tokens in / out | Cost |
|---|---|---|
| Flag an oversold product | 2,000 / 100 | $0.0075 |
| Draft a title | 2,500 / 120 | $0.0093 |
| Draft a customer reply | 4,500 / 400 | $0.0195 |
| Draft a marketing email | 6,000 / 900 | $0.0315 |
| Weekly summary | 12,000 / 900 | $0.0495 |
| Reconcile a payout | 8,000 / 300 | $0.0285 |
| Average across all 22 action types | | **about $0.019** |

**No model is called in this build**: drafts are deterministic templates filled from store facts, and the hook for
a model-written draft is `setLibraryBrain` in `lib/library/chat.ts`. Usage rows are marked `measured = false`
until real token counts replace the estimates.

## Proposed tiers

| Tier | Agents | Included actions / month | Base price | Overage / action | Model cost at full allowance | Gross margin at full allowance | Overage margin |
|---|---|---|---|---|---|---|---|
| Starter | 4 | 150 | **$29** | $0.25 | about $2.90 | about 90% | about 92% |
| Growth | 8 | 500 | **$79** | $0.20 | about $9.60 | about 88% | about 90% |
| Pro | 12 + build your own | 1,500 | **$199** | $0.15 | about $29 | about 85% | about 87% |

(`npx tsx -e "import('./lib/library/pricing.ts').then(m => console.table(m.allTierEconomics()))"` prints the live figures.)

The margins cover the model only. Hosting, Shopify's revenue share (where the app is billed through Shopify),
support and the email provider are not in the cost line; at these prices they fit comfortably inside the margin.

## Why these numbers

- A Starter store with four reporting agents uses well under 150 actions a month (one weekly summary, one weekly
  health report, a few flags and drafts a day).
- Growth adds Order Tracker and Promo Manager, which act on every stuck order and every slow product: 500 covers a
  store doing 10 to 20 orders a day.
- Pro adds customer-facing drafts (one per message) and returns, which scale with order volume: 1,500 covers about
  50 messages a day plus everything else.
- Overage falls with the tier so a busy store is never punished for being on the right plan.

## What you decide

1. The three base prices and the three overage prices (or the allowances).
2. Whether billing goes through Shopify Billing (revenue share, simplest review) or Stripe.
3. Whether the private-beta stores stay free after prices go live.

When approved: set `pricingStatus` to `published` and the figures in `agent-library.json`; the pricing page, the
plan page and the usage meter switch from "coming soon" to the numbers with no other change.
