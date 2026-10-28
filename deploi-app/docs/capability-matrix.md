# Capability matrix

What each platform allows with that platform alone, the evidence each problem needs, and whether a supported
correction exists. Sources: `docs/platform-research/*.md`. A merchant never needs a second platform for any row.

| Platform | Problem | Evidence | Supported correction | Status |
|---|---|---|---|---|
| Shopify | Active, tracked variant keeps selling with no stock, against the merchant's rule | `inventoryPolicy`, `inventoryItem.tracked`, product status, tags, selling plan counts, inventory levels (`available`, `on_hand`, `committed`) | Yes: `productVariantsBulkUpdate` `inventoryPolicy: DENY` (`write_products`) | **Built, synthetic-verified** |
| Shopify | Oversold although set to stop selling (available < 0 under `DENY`) | Same fields, per location | No: stock counts need a physical count or receiving record | **Built (needs a person)** |
| Shopify | Untracked inventory on physical products | `tracked = false` | No safe automatic fix: enabling tracking needs a real count | Not built |
| Shopify | Sold-out product still published | status, levels, publications | Possible (`productUpdate` status / unpublish) but changes visibility; needs a merchant rule | Not built |
| WooCommerce | Backorders allowed with managed stock at or below zero, against the merchant's rule | `manage_stock`, `stock_quantity`, `backorders`, `status`, tags, store-wide manage-stock setting | Yes: `PUT /products/{id}` or `/variations/{id}` `{"backorders":"no"}`; response and a fresh read must both show it | **Planned** (detection logic written and tested) |
| WooCommerce | Stock below zero with backorders off | `stock_quantity`, `backorders` | No (stock count) | **Planned** (detection logic written and tested) |
| Amazon | Listing has an ERROR issue (possibly suppressed / not buyable) | `getListingsItem` `issues` (severity, enforcements), `summaries.status` | Usually needs seller data; `patchListingsItem` exists for attribute fixes once data is supplied | **Planned** (detection logic written and tested) |
| Amazon | Seller-fulfilled quantity wrong | Seller-configured authoritative stock source required | Yes, `patchListingsItem` `fulfillment_availability`, but only from that source, never guessed | Planned, needs an extra record |
| Any | Cross-channel stock comparison | Two connected platforms | n/a | Optional later add-on; not part of onboarding |

## Shared engine contract

Every connector implements `Connector` in `lib/engine/types.ts`: `listResources`, `readResources` (fresh reads
for prechecks, verification and webhook-driven rescans) and `applyAction`. Checks implement `CheckDef`
(`detect` is pure and testable). Planned connectors are registered but refuse every call (`NotOperational`).
