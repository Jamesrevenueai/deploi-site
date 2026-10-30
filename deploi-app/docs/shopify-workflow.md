# The first Shopify workflow and why it is an actual error

Facts below come from `docs/platform-research/shopify.md` (Admin GraphQL 2026-10, cited there).

## What it does

**Check:** `shopify.oversell_policy` ("Selling with no stock against your rule").
**Correction:** `shopify.variant.set_inventory_policy`, switching one variant's `inventoryPolicy` from
`CONTINUE` ("Continue selling when out of stock") to `DENY` ("Stop selling when out of stock") through
`productVariantsBulkUpdate(productId, variants: [{ id, inventoryPolicy: DENY }], allowPartialUpdates: false)`
(scope `write_products`).

1. **Detect.** Read every variant with its product, inventory item and inventory levels (`available`,
   `on_hand`, `committed` per location).
2. **Evidence.** Store the policy, tracking flag, product status, tags, selling-plan counts, per-location
   quantities, read time and the rule version that applied.
3. **Propose.** One exact change per variant, with preconditions (policy still `CONTINUE`, still tracked,
   product still active, same parent product) and a SHA-256 hash of connection, action, target, change,
   parameters, preconditions and rule version. Proposals expire (`PROPOSAL_TTL_HOURS`, default 24).
4. **Approve.** A merchant user approves the hash they were shown. Staff cannot approve. A different hash,
   an expired proposal or a changed rule refuses the approval.
5. **Execute.** One approval allows at most one execution (the approval id is the idempotency key; the
   claim is a single-winner database update). Gates run first: connection active, permission granted,
   subscription (when required), live-store writes allowed. Then the variant is re-read: if a precondition
   no longer holds, if the check would no longer propose this exact change, or if the variant is already
   `DENY`, nothing is written and the outcome is **Stale**.
6. **Verify.** After the write, the variant is re-read (up to `VERIFY_ATTEMPTS`). Only a fresh read showing
   `DENY` produces **Verified**. A lost response is settled by the read (Verified, or Failed "not applied").
   A write that does not hold is **Failed** ("a fresh read does not show the change"). Every step is in the
   audit trail.

## Why a match is an actual error, not an intentional configuration

Shopify lets merchants sell past zero on purpose: pre-orders, backorders, made-to-order goods, and
subscription or pre-order apps that work through selling plans. The setting alone proves nothing. The check
therefore only calls something an error when it contradicts the merchant's own stated policy:

- **The merchant states the policy.** The check is off by default. It runs only after the merchant answers
  one question: "Should products stop selling when they run out, except the ones you mark as pre-order or
  backorder?" The answer is stored as a versioned rule; changing it supersedes open proposals.
- **Intentional setups are excluded by evidence, not guesswork:**
  - products tagged `preorder`, `pre-order`, `backorder`, `made-to-order` or `made to order` (editable, case-insensitive);
  - variants or products with selling plan groups, or products that require a selling plan (how pre-order
    and subscription apps implement selling before stock exists);
  - gift cards; untracked inventory (Shopify never enforces stock there, and turning tracking on would need a
    real count); products that are not `ACTIVE`;
  - products the merchant exempts from the issue page (stored in the rule).
- **The remaining case is a direct contradiction:** an active, tracked variant that the merchant's rule says
  must stop at zero is set to keep selling. When its available quantity is at or below zero, it is accepting
  orders with no stock right now (high priority). When stock remains, it will oversell once stock runs out
  (medium priority, can be switched off in the rule).
- **The correction is the least-invasive one.** It changes one documented setting, is reversible by the
  merchant in the Shopify admin, and never touches stock quantities. Existing oversold orders are reported
  for a person to handle.
- **No physical stock is guessed.** The second check, `shopify.oversold_stop_selling`, flags variants set to
  `DENY` whose available quantity is below zero (Shopify documents that overselling and POS sales can drive
  available below zero). It proposes nothing; a person counts or receives stock.

## Loop and conflict protection

Shopify sends `products/update` and `inventory_levels/update` after Deploi's own write; the targeted re-read
simply confirms the fix. If a verified fix is later changed back (by the merchant, staff or another app), the
next scan marks the issue **Needs review** instead of proposing the same change again within
`LOOP_GUARD_HOURS` (default 72). The merchant can exempt the product, or confirm that Deploi may propose again.

## What is not verified live

Everything above runs against a synthetic store that answers the same GraphQL operations. It has not run
against a Shopify development store, because no Shopify app credentials exist in this environment. Open items
to confirm on a development store: the read query's cost, the `InventoryItem.variants` lookup used for
`inventory_levels/update`, whether reading selling plan details needs `read_purchase_options`, and whether the
mutation response already reflects the new value (verification re-reads either way).
