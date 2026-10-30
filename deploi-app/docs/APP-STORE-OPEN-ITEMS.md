# Shopify App Store: what is still open

As of 2026-10-28. The full listing checklist and draft copy are in `APP-STORE-CHECKLIST.md`. This page covers only the five open decisions and assets. Shopify's own figures (fees, limits) change; check them in the Partner Dashboard before relying on them.

## 1. Pricing: options and a recommendation

Billing runs through Shopify (App Pricing in the Partner Dashboard). The app already has `BILLING_REQUIRED`, which stays `false` until a plan exists.

| Option | Shape | For | Against |
|---|---|---|---|
| A. Free during early access | $0, invite-only, convert later | Lowest friction for the first stores; honest while live verification is thin | No price signal; converting later needs a clear notice |
| B. Trial plus one plan | 14-day free trial, then one flat plan (for example $49/month) | Simplest to explain and to review; one billing path to test | Small stores pay the same as large ones |
| C. Trial plus two tiers | 14-day trial. **Starter**, about $29/month: up to 3 agents, drafts only and after-approval. **Growth**, about $99/month: unlimited agents, "without asking, within limits", agent email sending | Prices the riskiest, most valuable permission (acting without asking) higher; natural upgrade path | Two plans to test and support; plan limits must be enforced in code (not built yet) |

**Recommendation: A now, then B at public listing.**

- Start with A for the private beta (custom-distribution installs; see `APP-STORE-CHECKLIST.md` §2), because live verification on a real store is still missing.
- List publicly with B: one plan, a 14-day trial, a price chosen from beta feedback.
- Move to C only when there is evidence that stores want "without asking" enough to pay more for it.
- B needs no new code beyond turning on `BILLING_REQUIRED` with one plan handle. C needs per-plan limits, which are **not built**.

The numbers above are placeholders for you to decide, not research.

## 2. App icon

- **Shopify's requirements:** 1200×1200 px, JPG or PNG, no text, no screenshots, no Shopify trademarks, and it must read clearly at small sizes.
- **Proposed concept:** the Deploi mark (the rounded "d" form from the wordmark, without the "ai" text) in white on a black square, centred, with about 20% padding.
- **Status: not made.** It needs a designer, or your approval of an export of the existing wordmark glyph. Upload it in Partner Dashboard → App listing → App icon.

## 3. Demo video script (about 3 minutes, recorded on the development store)

| Time | On screen | Say |
|---|---|---|
| 0:00 | Shopify admin → Apps → Deploi AI (embedded) | "Deploi AI gives your store agents that find stock and listing problems, and only act with your permission." |
| 0:15 | Agents page, three templates | "Start from a template or describe the job in your own words. Every agent starts at drafts only." |
| 0:30 | Inventory Watcher → add email → Review authorization | "Before anything runs, you read exactly what it may do, its limits, and what it never does." |
| 0:50 | Grant → Run now → Drafted changes | "At drafts only it shows the exact change, here 'Continue selling when out of stock' from On to Off, and changes nothing." |
| 1:10 | Shopify product page: the setting is unchanged | "The store is untouched." |
| 1:20 | Edit → After my approval → Save → new grant banner → Grant | "Giving it more needs a new grant. Until then, the old rules keep running." |
| 1:40 | Run now → Approvals → Approve → "Verified" | "Approving makes that one change, then re-reads the store to confirm it." |
| 2:00 | Shopify product page: setting now off; pre-order product unchanged | "Only that variant changed. Pre-order products are skipped." |
| 2:15 | Agent → Work log | "Every action: what, when, why, and which permission allowed it." |
| 2:30 | Tasks: "Delete products…" → Refused | "Ask for something it can't do, and it refuses. Nothing runs." |
| 2:40 | Pause → Revoke | "Pause or revoke at any time. Both stop queued changes too." |
| 2:50 | Weekly summary page | "Every Monday, a summary of what each agent did. Time saved is shown as an estimate." |

Record it at 1080p or higher, with no real merchant data. Use the demo data in the dev store only.

## 4. Reviewer access

- The app signs in through Shopify (embedded, session tokens), so **reviewers need no Deploi username or password**. They install it on their own development store.
- In the review submission, give them:
  1. The steps in the video script above, as written test instructions.
  2. A note that agents start at drafts only, so they must widen one agent to "after my approval" to see a change made.
  3. A note that agent email sending is off in review. They will see drafts and "would send" states, not delivered mail.
  4. A note that price, SKU and publication corrections need a reference file. Attach the samples in `docs/reviewer-samples/` (to be exported from `lib/connectors/shopify/demo-store.ts`; not created yet).
- **Open:** the production app must run with migrations 28–32 applied, Supabase sign-in on, and `LIVE_WRITE_STORES` covering reviewer stores. Review stores are not known in advance, so a review-mode setting that allows writes to development stores only is needed. **This is not built**; today writes are allowed only for stores listed by name.

## 5. Privacy policy: items for legal review

The draft is at `https://getdeploi.com/privacy`. It shows "Draft, pending legal review" until `VITE_LEGAL_REVIEWED=true`. Points for counsel:

1. **Data collected from Shopify:** products, variants, prices, SKUs, barcodes, inventory levels, locations and publications. Confirm the "no customer or order data" statement matches the scopes requested.
2. **Agent email:** messages sent from agent addresses, and replies received (encrypted at rest, shown to the merchant only), including supplier names and addresses. Who is controller and who is processor for supplier personal data?
3. **Retention:** how long work logs, audit records, sent messages and received mail are kept, and what happens on uninstall (`shop/redact` within 48 hours).
4. **Sub-processors:** Vercel (hosting), Supabase (database and sign-in), Resend (email), and an LLM provider if task drafting uses one in production. List each with its region.
5. **International transfers:** US hosting for EU and UK merchants. Are SCCs or the DPF needed?
6. **Automated actions:** liability language for changes made "without asking, within limits", and the merchant's responsibility for the permissions they grant.
7. **Estimates:** the weekly "time saved" figure is an estimate, not a guarantee. Check the wording in the policy and the terms.
8. **Contact and requests:** a working privacy contact address. Mail to `hello@getdeploi.com` fails DMARC until `LAUNCH-STEPS.md` step 2 is done for the root domain.
9. **Children's data, cookies and analytics** on the public site. Confirm what the site sets.
