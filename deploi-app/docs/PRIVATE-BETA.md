# Private beta (up to five stores, unlisted app)

What is built on this branch, and what is still needed from the founder, to let up to five real stores use the
app as an unlisted Shopify app. **No Shopify app configuration, Vercel environment variable, deployment or dev
store was changed by this branch**: those belong to the parallel session.

## Built

- **Onboarding** (`/store/onboarding`): connect the store (the existing install flow), choose the plan to trial
  (free; nothing is charged; prices "coming soon"), switch on the first agents, done. State persists per
  organization in `agencies.onboarding`.
- **Tier selection** (`/store/plan`): Starter, Growth, Pro with their agents and allowances. A downgrade switches
  off the agents the new plan does not include and closes their drafts.
- **Feedback button** on every merchant screen: page, mood and message, stored in `beta_feedback`, read by staff
  at `GET /api/store/feedback`.
- **Usage tracking** per action so the allowance is right on day one.
- **Live store reads are a stub** (`lib/library/store-data.ts`): every live call refuses with `not_wired`. The
  three engine-backed agents (Inventory Watcher, Supplier Chaser, Store Health Checker) use the existing verified
  engine; the nine new agents run on the synthetic store only.

## Still needed before a real store can use the nine new agents

1. Wire each `StoreData` read against the Admin API, with a verified fixture per read (orders, fulfilments,
   returns, payouts, discounts, publications, the Agentic channel), under the scopes in `AGENT-SCOPES.md`.
2. Add the per-agent optional scopes to the app configuration (the other session's optional-scope flow).
3. Decide where customer messages come from for Customer Care (forward/copy to the agent address, as designed).
4. Turn on email for the agents that send (Supplier Chaser, the drafted customer updates) once the domain is live.

## Unlisted distribution steps (founder)

1. In the Partner Dashboard, keep the app's distribution as "Custom" or "Unlisted" and add each beta store by its
   `.myshopify.com` domain.
2. Set `ALLOW_DEV_LOGIN=false` and Supabase auth on the preview the stores will use (production is untouched).
3. Invite one owner email per store; they sign in with a magic link and land on `/store/onboarding`.
4. Review `beta_feedback` weekly; the weekly summary email stays off until `EMAIL_LIVE_SENDS` is set.
