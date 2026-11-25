# Capability matrix

What each platform allows with that platform alone, the evidence each problem needs, and whether a supported
correction exists. Sources: `docs/platform-research/*.md`. A merchant never needs a second platform for any row.

| Platform | Problem | Evidence | Supported correction | Status |
|---|---|---|---|---|
| Shopify | Active, tracked variant keeps selling with no stock, against the merchant's rule | `inventoryPolicy`, `inventoryItem.tracked`, product status, tags, selling plan counts, inventory levels (`available`, `on_hand`, `committed`) | Yes: `productVariantsBulkUpdate` `inventoryPolicy: DENY` (`write_products`) | **Built, synthetic-verified** |
| Shopify | Oversold although set to stop selling (available < 0 under `DENY`) | Same fields, per location | No: stock counts need a physical count or receiving record | **Built (needs a person)** |
| Shopify | Publication differs from the merchant's publication list or publish-tag rule (one authorized channel) | `resourcePublicationsV2` (published, publish date), `onlineStoreUrl`, status, list row | Yes: `publishablePublish` / `publishableUnpublish` (`write_publications`); drafts, archived, scheduled and selling-plan products go to a person | **Built, synthetic-verified** |
| Shopify | Price or compare-at price differs from the merchant's price list | `price`, `compareAtPrice`, shop currency, list row (variant id or unique SKU), Markets fixed prices | Yes: `productVariantsBulkUpdate` `price` / `compareAtPrice`; other currencies, conflicting rows, sale prices (optional) and fixed Markets prices are blocked | **Built, synthetic-verified** |
| Shopify | SKU missing or different from the merchant's SKU mapping | `sku`, barcodes, handle and option title, store-wide SKU and barcode lookups, `duplicateSkuCount` | Yes: `productVariantsBulkUpdate` `inventoryItem.sku`; ambiguous matches, shared barcodes, SKUs in use and duplicate targets go to a person | **Built, synthetic-verified** |
| Shopify | Untracked inventory on physical products | `tracked = false` | No safe automatic fix: enabling tracking needs a real count | Not built |
| WooCommerce | Backorders allowed with managed stock at or below zero, against the merchant's rule | `manage_stock`, `stock_quantity`, `backorders`, `status`, tags, store-wide `woocommerce_manage_stock` | Yes: `PUT /products/{id}` or `/products/{id}/variations/{vid}` `{"backorders":"no"}` on the stock-owning object (variations with `manage_stock: "parent"` are corrected on the parent); response and a fresh read must both show it | **Built, synthetic-verified; live verification blocked** (needs a WooCommerce store with HTTPS + an admin to approve keys) |
| WooCommerce | Stock below zero with backorders off | `stock_quantity`, `backorders` | No (stock count) | **Built (needs a person)** |
| WooCommerce | Low stock (at or below the item's or the store's low-stock threshold) | `stock_quantity`, `low_stock_amount`, `woocommerce_notify_low_stock_amount` | No (restock); feeds the Supplier Chaser reorder list | **Built (needs a person)** |
| WooCommerce | Published or draft differently from the merchant's publication list or publish-tag rule | `status`, slug, tags, list row | Yes: `PUT /products/{id}` `{"status":"publish"}` or `{"status":"draft"}` only; status re-read right before the write; pending, private, scheduled and trashed products go to a person; unpublishing only when the agent allows it | **Built, synthetic-verified; live verification blocked** |
| WooCommerce | Price differs from the merchant's price list | `regular_price`, `sale_price`, `on_sale`, store currency (`woocommerce_currency`), list row (variant id or unique SKU) | Yes: one field per write: `regular_price` (no sale running) or `sale_price` (sale running); compare-at = `regular_price` while on sale; starting a sale, scheduled sales, other currencies, >2-decimal prices and conflicting rows go to a person | **Built, synthetic-verified; live verification blocked** |
| WooCommerce | SKU missing or different from the merchant's SKU mapping | `sku`, `global_unique_id` (GTIN, WC 9.2+), slug and variation attributes, catalogue-wide SKU lookup | Yes: `PUT` `{"sku":"..."}`; ambiguous matches, SKUs in use and duplicate targets go to a person; WooCommerce also refuses duplicates (`product_invalid_sku`) | **Built, synthetic-verified; live verification blocked** |
| Amazon | Listing has an ERROR issue (possibly suppressed / not buyable) | `getListingsItem` `issues` (severity, enforcements), `summaries.status` | Usually needs seller data; `patchListingsItem` exists for attribute fixes once data is supplied | **Planned** (detection logic written and tested) |
| Amazon | Seller-fulfilled quantity wrong | Seller-configured authoritative stock source required | Yes, `patchListingsItem` `fulfillment_availability`, but only from that source, never guessed | Planned, needs an extra record |
| Email (Gmail / Microsoft 365) | Supplier restock requests, run summaries, needs-a-person alerts from an agent | Store records and the agent's own run results; recipients only from the agent's policy | Send through the merchant's connected mailbox (`gmail.send` / `Mail.Send`); drafts kept in Deploi | **Built, synthetic-verified; not live-verified** (see `docs/EMAIL-SETUP.md`) |
| Any | Cross-channel stock comparison | Two connected platforms | n/a | Optional later add-on; not part of onboarding |

## Shared engine contract

WooCommerce details (connection, key approval, webhooks, live-test steps): `docs/WOOCOMMERCE-SETUP.md`.

Every connector implements `Connector` in `lib/engine/types.ts`: `listResources`, `readResources` (fresh reads
for prechecks, verification and webhook-driven rescans) and `applyAction`. Checks implement `CheckDef`
(`detect` is pure and testable). Planned connectors are registered but refuse every call (`NotOperational`).
