# Shopify platform research: inventory/listing fixer app

- Researched: 2026-10-28
- Sources: official documentation only, on shopify.dev and help.shopify.com. No accounts, credentials or sign-ups were used.
- API version read: **GraphQL Admin API `2026-10`** (latest stable). Each reference page fetched from `.../admin-graphql/latest/...` reported `api_version: 2026-10` in its front matter.
- How the pages were read:
  - shopify.dev pages were fetched as Markdown by adding `.md` to the URL, for example `https://shopify.dev/docs/api/usage/versioning.md`.
  - help.shopify.com returned a bot check to plain HTTP clients. Those pages were read through a summarising web-fetch tool, so the quotes from them are as that tool returned them. Re-check them by hand before quoting them externally.
- Convention: anything not confirmed in official docs is marked **UNVERIFIED**.

---

## 1. API versioning

- **Release cadence.** "Shopify releases a new API version every three months at 5pm UTC on the first day of the quarter. Version names are date-based … Each stable version is supported for a minimum of 12 months, with at least nine months of overlap between consecutive versions." [versioning](https://shopify.dev/docs/api/usage/versioning)
- **Version table as published today:**

  | Version | Status | Accessible until |
  | - | - | - |
  | `2026-01` | Stable | 16 Jan 2027 15:00 UTC |
  | `2026-04` | Stable | 16 Apr 2027 15:00 UTC |
  | `2026-07` | Stable | 16 Jul 2027 15:00 UTC |
  | **`2026-10`** | **Latest stable** (released 1 Oct 2026) | 16 Oct 2027 15:00 UTC |
  | `2027-01` | Release candidate | — |

  `2025-10` and older are "Unsupported". [versioning](https://shopify.dev/docs/api/usage/versioning)
- **Fall-forward.** If an app targets an inaccessible version, "Shopify falls forward and responds using the oldest accessible stable version". The response header `X-Shopify-API-Version` reports the version that was actually used. [versioning](https://shopify.dev/docs/api/usage/versioning)
- **Version types:** Stable, Release candidate and Unstable. Unstable is "for early testing only". [versioning](https://shopify.dev/docs/api/usage/versioning)
- **Delisting risk.** "If your app continues to use unsupported resources after the upgrade deadline, it's delisted from the Shopify App Store." [versioning](https://shopify.dev/docs/api/usage/versioning)
- **Endpoint.** `POST https://{store_name}.myshopify.com/admin/api/2026-10/graphql.json`. Requests carry the header `X-Shopify-Access-Token`. [Admin GraphQL reference](https://shopify.dev/docs/api/admin-graphql/latest)
  - The bulk-operations and idempotency pages show `POST https://{shop}.myshopify.com/api/{api_version}/graphql.json`, without `/admin`. This looks like a documentation inconsistency, so use the `/admin/api/...` form. [bulk ops](https://shopify.dev/docs/apps/build/apis/graphql-admin/bulk-operations/queries)
- **REST is legacy.** "The REST Admin API is a legacy API as of October 1, 2024. Starting April 1, 2025, all new public apps must be built exclusively with the GraphQL Admin API." [REST reference](https://shopify.dev/docs/api/admin-rest)
  - The same rule is App Store requirement 2.2.4. [App Store requirements](https://shopify.dev/docs/apps/launch/shopify-app-store/app-store-requirements)
- **OAuth endpoints are unversioned.** OAuth endpoints, including `AccessScope`, may change at any time. [versioning](https://shopify.dev/docs/api/usage/versioning)

## 2. Rate limits and bulk operations

### Cost-based limits

- Limits are per app and store pair: "Calls from one app don't affect the rate limits of another app, even on the same store." [GraphQL rate limits](https://shopify.dev/docs/apps/build/apis/graphql-admin/rate-limits)
- **Restore rate by plan** [GraphQL rate limits](https://shopify.dev/docs/apps/build/apis/graphql-admin/rate-limits):

  | Plan | Restore rate |
  | - | - |
  | Standard | 100 points/second |
  | Advanced Shopify | 200 points/second |
  | Shopify Plus | 1000 points/second |
  | Shopify for enterprise (Commerce Components) | 2000 points/second |

- **Bucket size by plan: UNVERIFIED.** The current page gives only these rates and does not list a maximum bucket size for each plan.
  - The documented response example shows `"maximumAvailable": 1000` and `"restoreRate": 50`, which does not match "Standard 100 points/second". Read the live values from `extensions.cost.throttleStatus` instead of hard-coding them.
- **Default field costs:**
  - Scalar and Enum: 0
  - Object: 1
  - Connection: sized by `first`/`last`
  - Mutation: 10

  Before execution the bucket must hold the *requested* cost. Afterwards the difference between requested and *actual* cost is refunded. [GraphQL rate limits](https://shopify.dev/docs/apps/build/apis/graphql-admin/rate-limits)
- **Single-query cap.** "A single query may not exceed a cost of 1,000 points, regardless of plan limits." Exceeding it returns the error code `MAX_COST_EXCEEDED`. [rate limits](https://shopify.dev/docs/apps/build/apis/graphql-admin/rate-limits), [Admin reference](https://shopify.dev/docs/api/admin-graphql/latest)
- **Cost debugging.** The response carries `extensions.cost.{requestedQueryCost, actualQueryCost, throttleStatus{maximumAvailable,currentlyAvailable,restoreRate}}`. The request header `Shopify-GraphQL-Cost-Debug=1` adds a per-field breakdown. [rate limits](https://shopify.dev/docs/apps/build/apis/graphql-admin/rate-limits)
- **How throttling is reported.** The response is HTTP `200` with `errors[n].extensions.code = "THROTTLED"` ("Similar to 429 Too Many Requests"). Other codes are `ACCESS_DENIED`, `SHOP_INACTIVE` and `INTERNAL_SERVER_ERROR`. [Admin reference](https://shopify.dev/docs/api/admin-graphql/latest)
  - The recommended backoff is one second. [API limits](https://shopify.dev/docs/api/usage/limits)
- **Resource-based throttle.** On stores with 500,000 or more variants, at most 10,000 new variants can be created per day. Exceeding it returns `429`. It does not apply to Plus. This does not affect us, because we only update variants. [rate limits](https://shopify.dev/docs/apps/build/apis/graphql-admin/rate-limits)
- **General limits** [API limits](https://shopify.dev/docs/api/usage/limits), [pagination](https://shopify.dev/docs/api/usage/pagination-graphql):
  - Input arrays are limited to 250 items.
  - Pagination is capped at 25,000 objects, and count queries return `25001` above that.
  - A page holds at most 250 resources.

### Bulk operations (large catalogs)

Source for this section: [bulk ops](https://shopify.dev/docs/apps/build/apis/graphql-admin/bulk-operations/queries).

- **Submitting.** Run `bulkOperationRunQuery(query: """…""") { bulkOperation { id status } userErrors { field message } }`.
- **Limits:**
  - Bulk operations "don't have the max cost limits or rate limits that single queries have". [rate limits](https://shopify.dev/docs/apps/build/apis/graphql-admin/rate-limits)
  - In `2026-01` and later, up to **five** bulk query operations can run per shop at the same time. Earlier versions allowed one of each type.
  - A query must finish within 10 days.
  - At most five connections in a query, and at most two levels of nested connections.
  - The top-level `node`/`nodes` fields can't be used.
- **Knowing when it finishes.** Subscribe to the `bulk_operations/finish` webhook topic, which is recommended. Alternatively, poll:
  - `2026-01` and later: `bulkOperation(id:)`.
  - Earlier versions: `currentBulkOperation`, which is deprecated.
  - Webhook delivery "isn't always guaranteed", so polling may still be needed.
- **Results.** The output is JSONL, available at `url` (or `partialDataUrl` on failure). The URL expires after one week.
  - Child connection rows carry `__parentId`.

## 3. Reading the data

### ProductVariant (2026-10)

Source for this subsection unless noted: [ProductVariant](https://shopify.dev/docs/api/admin-graphql/latest/objects/ProductVariant).

- **Scope.** The object "Requires `read_products` access scope."
- **`inventoryPolicy: ProductVariantInventoryPolicy!`.** "Whether customers are allowed to place an order for the product variant when it's out of stock." [ProductVariantInventoryPolicy](https://shopify.dev/docs/api/admin-graphql/latest/enums/ProductVariantInventoryPolicy)
  - `CONTINUE`: "Customers can buy this product variant after it's out of stock."
  - `DENY`: "Customers can't buy this product variant after it's out of stock."
  - The POS UI extension docs describe the same values more specifically. `CONTINUE`: "Sales are allowed even when inventory is zero or negative." `DENY`: "Sales are prevented when inventory reaches zero." [POS Product Search API](https://shopify.dev/docs/api/pos-ui-extensions/latest/target-apis/standard-apis/product-search-api)
- **`inventoryQuantity: Int`.** "The total sellable quantity of the variant." It is listed under Fields, not "Deprecated fields", so it is **not deprecated in 2026-10**.
  - Also available: `sellableOnlineQuantity: Int!`, "The total sellable quantity of the variant for online channels".
- **Other fields used:**
  - `sku: String`: "case-sensitive identifier".
  - `title: String!`, `availableForSale: Boolean!`, `updatedAt`, `inventoryItem: InventoryItem!`, `product: Product!`.
  - `sellingPlanGroups` (connection) and `sellingPlanGroupsCount: Count`.
  - `sellingPlanGroupCount: Int!` is **deprecated**, so use `sellingPlanGroupsCount`.
  - `barcode` is **deprecated in 2026-10** in favour of `barcodes`.
- **Gift card:** there is no `isGiftCard` or `giftCard` field on ProductVariant. Gift-card status lives on `Product.isGiftCard: Boolean!`. [Product](https://shopify.dev/docs/api/admin-graphql/latest/objects/Product)
  - The `productVariants` query filter `gift_card:true` filters by the product's `isGiftCard`. [productVariants](https://shopify.dev/docs/api/admin-graphql/latest/queries/productVariants)
- **`requiresSellingPlan` is on Product, not ProductVariant:** `Product.requiresSellingPlan: Boolean!`, "Whether the product can only be purchased with a selling plan". [Product](https://shopify.dev/docs/api/admin-graphql/latest/objects/Product)
- **Other Product fields used** [Product](https://shopify.dev/docs/api/admin-graphql/latest/objects/Product):
  - `status: ProductStatus!`
  - `tags: [String!]!`
  - `tracksInventory: Boolean!`
  - `totalInventory: Int!`
  - `hasOutOfStockVariants: Boolean!`
  - `sellingPlanGroups`, `sellingPlanGroupsCount: Count`
  - `variants`, `variantsCount`
  - `giftCardSettings`, which is "Only available on gift card products"
- **`ProductStatus` values** [ProductStatus](https://shopify.dev/docs/api/admin-graphql/latest/enums/ProductStatus):
  - `ACTIVE`, `ARCHIVED`, `DRAFT`.
  - `UNLISTED`: "only visible from 2025-10 and up, is translated to active in older versions".
- **Paging.**
  - The `productVariants(first/after/last/before, query, sortKey, reverse, savedSearchId)` query returns `edges`/`nodes`/`pageInfo`. [productVariants](https://shopify.dev/docs/api/admin-graphql/latest/queries/productVariants)
  - `pageInfo { hasNextPage endCursor }`. Pass `endCursor` as `after`. [pagination](https://shopify.dev/docs/api/usage/pagination-graphql)
  - Documented `query` filters include `gift_card`, `inventory_quantity` ("aggregate of inventory across all locations"), `location_id`, `managed`, `managed_by`, `product_status` (for example `product_status:ACTIVE,DRAFT`), `sku`, `tag`, `tag_not`, `updated_at` and `product_ids`.
  - **There is no documented `inventory_policy` filter**, so filter on the client side.
- **SellingPlanGroup** [SellingPlanGroup](https://shopify.dev/docs/api/admin-graphql/latest/objects/SellingPlanGroup):
  - Requires `read_products`.
  - Has `appId: String` ("The ID for app"), `name`, `sellingPlans`, `productVariants`, `appliesToProductVariant(...)`.
- **SellingPlan** [SellingPlan](https://shopify.dev/docs/api/admin-graphql/latest/objects/SellingPlan):
  - `category: SellingPlanCategory`, with values `PRE_ORDER`, `SUBSCRIPTION`, `TRY_BEFORE_YOU_BUY` and `OTHER`. [SellingPlanCategory](https://shopify.dev/docs/api/admin-graphql/latest/enums/SellingPlanCategory)
  - `inventoryPolicy: SellingPlanInventoryPolicy`, with `reserve: SellingPlanReserve!` being `ON_SALE` or `ON_FULFILLMENT`. [SellingPlanReserve](https://shopify.dev/docs/api/admin-graphql/latest/enums/SellingPlanReserve)
  - Selling plans are "automatically deleted 48 hours after a merchant uninstalls the App that created them". [SellingPlan](https://shopify.dev/docs/api/admin-graphql/latest/objects/SellingPlan)
- **Scope conflict on SellingPlan.**
  - The SellingPlan reference page says it "Requires `read_products`".
  - The access-scopes table says `SellingPlan` "also requires `read_purchase_options` or `read_own_subscription_contracts` for queries". [access scopes](https://shopify.dev/docs/api/usage/access-scopes)
  - Which applies is **UNVERIFIED** and needs testing on a dev store. Reading only `sellingPlanGroupsCount` may avoid the issue.

### InventoryItem / InventoryLevel / quantities

- **InventoryItem** "Requires `read_inventory` access scope or `read_products` access scope." [InventoryItem](https://shopify.dev/docs/api/admin-graphql/latest/objects/InventoryItem)
  - `tracked: Boolean!`: "Whether inventory levels are tracked for the item."
  - Also `trackedEditable`, `sku` and `inventoryLevel(locationId:)`.
  - `inventoryLevels(first, after, includeInactive=false, query, reverse)`.
  - `variants` (connection). **`InventoryItem.variant` is deprecated in 2026-10.**
- **1:1 claim conflicts with the 2026-10 schema.** The inventory guide still says "All product variants have a 1:1 relationship with their associated inventory item". The 2026-10 schema replaced `variant` with a `variants` connection. [manage quantities](https://shopify.dev/docs/apps/build/inventory-management-apps/manage-quantities-states)
- **InventoryLevel** "Requires `read_inventory` access scope." [InventoryLevel](https://shopify.dev/docs/api/admin-graphql/latest/objects/InventoryLevel)
  - `quantities(names: [String!]!): [InventoryQuantity!]!`
  - Also `isActive`, `location`, `item`, `updatedAt`.
  - `scheduledChanges` is deprecated.
- **InventoryQuantity** has `name: String!`, `quantity: Int!` and `updatedAt`. [InventoryQuantity](https://shopify.dev/docs/api/admin-graphql/latest/objects/InventoryQuantity)
- **Documented quantity names (inventory states)** [inventory management apps](https://shopify.dev/docs/apps/build/inventory-management-apps):

  | State | Meaning |
  | - | - |
  | `incoming` | On its way to a location; the only state not physically present |
  | `on_hand` | Physically at a location. Equals the sum of `available`, `committed`, `reserved`, `damaged`, `safety_stock` and `quality_control` |
  | `available` | "The inventory that a merchant can sell" |
  | `committed` | Set aside for unfulfilled orders, reserved draft orders, and transfers or shipments marked ready to ship |
  | `reserved`, `damaged`, `safety_stock`, `quality_control` | Shown to merchants as **Unavailable** |

  - `committed` can't be adjusted through the API.
  - "Changes to `committed`, `reserved`, `damaged`, `safety_stock`, and `quality_control` inventory states don't trigger webhooks."
- **Can `available` be negative? Yes, when the variant is oversold.**
  - The Shopify Help Center inventory reports page says:
    - "Overselling reduces the Available quantity below 0."
    - "You have inventory tracking checked and you oversell a variant."
    - "While the orders are unfulfilled, the oversold units are Committed and offset the negative Available quantity … so the On hand quantity doesn't drop below 0 until the orders are fulfilled."

    [Help Center: inventory reports](https://help.shopify.com/en/manual/reports-and-analytics/shopify-reports/report-types/default-reports/inventory-reports)
  - Overselling happens under `CONTINUE`. POS can also sell at zero or below regardless of the setting: "Continue selling when out of stock doesn't apply to orders placed from Shopify POS". POS warns staff first. [Help Center: selling out of stock](https://help.shopify.com/en/manual/products/inventory/getting-started-with-inventory/selling-when-out-of-stock)
  - The Admin API reference pages do not themselves state a sign constraint on `quantity`. It is typed `Int!`, so negative values are representable.
- **Scopes** [access scopes](https://shopify.dev/docs/api/usage/access-scopes), [Location](https://shopify.dev/docs/api/admin-graphql/latest/objects/Location):
  - `read_products` covers `Product`, `ProductVariant` and `Collection`.
  - `read_inventory` covers `InventoryItem` and `InventoryLevel`.
  - `read_locations` covers `Location`. The Location object accepts `read_locations`, `read_inventory` *or* `read_markets_home`.
  - "Any scope that writes a resource also grants read access to it."

## 4. Writing the correction

### `productVariantsBulkUpdate` (sets `inventoryPolicy`)

Source for this subsection unless noted: [productVariantsBulkUpdate](https://shopify.dev/docs/api/admin-graphql/latest/mutations/productVariantsBulkUpdate).

- **Scope.** "Requires `write_products` access scope. Also: The user must have a permission to update product variants."
- **Arguments:**
  - `productId: ID!` (required). The variants must belong to that one product.
  - `variants: [ProductVariantsBulkInput!]!` (required).
  - `allowPartialUpdates: Boolean`, default `false`. With the default, "any error will prevent all variants from updating".
  - `media: [CreateMediaInput!]`.
- **`ProductVariantsBulkInput` fields we need** [ProductVariantsBulkInput](https://shopify.dev/docs/api/admin-graphql/latest/input-objects/ProductVariantsBulkInput):
  - `id: ID`
  - `inventoryPolicy: ProductVariantInventoryPolicy`: "Whether customers are allowed to place an order for the variant when it's out of stock. Defaults to `DENY`."
  - `inventoryQuantities` is for create only. On update it errors with `NO_INVENTORY_QUANTITIES_ON_VARIANTS_UPDATE`, whose message says "use inventoryAdjustQuantities".
  - `quantityAdjustments: [InventoryAdjustmentInput!]` adjusts stock by deltas.
- **Unclear default on update: UNVERIFIED.** The docs don't say whether omitting `inventoryPolicy` on an update leaves it unchanged or resets it to `DENY`. To be safe, send only `id` and `inventoryPolicy`, then read the value back.
- **Payload (`ProductVariantsBulkUpdatePayload`):**
  - `product: Product`
  - `productVariants: [ProductVariant!]`, the updated variants
  - `userErrors: [ProductVariantsBulkUpdateUserError!]!`, each with `code`, `field: [String!]` and `message: String!` [user error](https://shopify.dev/docs/api/admin-graphql/latest/objects/ProductVariantsBulkUpdateUserError)
- **Relevant `ProductVariantsBulkUpdateUserErrorCode` values** [error codes](https://shopify.dev/docs/api/admin-graphql/latest/enums/ProductVariantsBulkUpdateUserErrorCode):
  - `PRODUCT_DOES_NOT_EXIST`
  - `PRODUCT_VARIANT_DOES_NOT_EXIST`
  - `PRODUCT_VARIANT_ID_MISSING`
  - `MUST_BE_FOR_THIS_PRODUCT`
  - `PRODUCT_SUSPENDED`
  - `INVALID_INPUT`
  - `NO_INVENTORY_QUANTITIES_ON_VARIANTS_UPDATE`
  - `UNSUPPORTED_COMBINED_LISTING_PARENT_OPERATION`
  - `SUBSCRIPTION_VIOLATION`

  The full list has about 40 codes.
- **Does the response reflect the new value immediately? UNVERIFIED.** The docs say only that `productVariants` returns "The updated variants". They make no read-after-write or consistency guarantee. Verify with a separate `productVariant(id:)` read. [productVariant](https://shopify.dev/docs/api/admin-graphql/latest/queries/productVariant)
- **Idempotency.** No `@idempotent` directive is documented for this mutation. Setting a policy to an absolute value is naturally idempotent.

### Stock-count mutations (not needed for a policy fix, but related)

- **`inventorySetQuantities(input: InventorySetQuantitiesInput!)`**: "Requires `write_inventory`." [inventorySetQuantities](https://shopify.dev/docs/api/admin-graphql/latest/mutations/inventorySetQuantities)
  - `name` must be `available` or `on_hand`. [InventorySetQuantitiesInput](https://shopify.dev/docs/api/admin-graphql/latest/input-objects/InventorySetQuantitiesInput)
  - Other input fields: `reason` (for example `correction`), `referenceDocumentUri`, and `quantities: [InventoryQuantityInput!]!`.
  - `InventoryQuantityInput` has `inventoryItemId`, `locationId`, `quantity` and `changeFromQuantity`. [InventoryQuantityInput](https://shopify.dev/docs/api/admin-graphql/latest/input-objects/InventoryQuantityInput)
  - **Compare-and-swap, from `2026-04`.** "each quantity in `quantities` must include a `changeFromQuantity` value." A mismatch returns the error `CHANGE_FROM_QUANTITY_STALE`. Pass `null` explicitly to opt out; omitting the field returns an error.
  - Before 2026-04 the equivalents were `compareQuantity` and `ignoreCompareQuantity`.
  - **Idempotency.** "As of 2026-01, this mutation supports an optional idempotency key using the `@idempotent` directive. As of 2026-04, the idempotency key is required." Usage: `inventorySetQuantities(input: $input) @idempotent(key: $idempotencyKey)`.
  - Payload: `inventoryAdjustmentGroup { reason referenceDocumentUri changes { name delta quantityAfterChange } }` and `userErrors { code field message }`.
- **`inventoryAdjustQuantities(input: InventoryAdjustQuantitiesInput!)`**: "Requires `write_inventory`." It applies delta changes. [inventoryAdjustQuantities](https://shopify.dev/docs/api/admin-graphql/latest/mutations/inventoryAdjustQuantities)
  - It takes the same `@idempotent` rule as `inventorySetQuantities`: optional from 2026-01, required from 2026-04.
  - The guide's examples include `changeFromQuantity` for compare-and-swap. [manage quantities](https://shopify.dev/docs/apps/build/inventory-management-apps/manage-quantities-states)
- **`referenceDocumentUri`.** The preferred format is a GID such as `gid://<your-app>/<Entity>/<id>`. It appears in merchant inventory history. [InventorySetQuantitiesInput](https://shopify.dev/docs/api/admin-graphql/latest/input-objects/InventorySetQuantitiesInput)
- **Idempotency keys.** A UUID is recommended. [idempotent requests](https://shopify.dev/docs/api/usage/idempotent-requests)

## 5. Pre-orders and backorders (avoid flagging intentional setups)

- **Help Center: "Continue selling when out of stock".**
  - "You can select the **Continue selling when out of stock** option only when you turn on the **Inventory tracked** setting." [Help Center: selling out-of-stock products](https://help.shopify.com/en/manual/products/inventory/setup/selling-when-out-of-stock)
  - The reasons it lists for using it:
    - "You have products available for preorder."
    - "You have stock coming soon and you want to continue selling before it arrives."
    - "You want to sell first and then order supplies later."
    - "You aren't tracking the actual inventory quantity in Shopify."
  - It "doesn't apply to orders placed from Shopify POS".
  - For multiple locations: if the location that fulfills online orders is at zero or below, the item still shows as out of stock online.
- **Initial inventory setup page** [Help Center: initial inventory setup](https://help.shopify.com/en/manual/products/inventory/setup/initial-inventory-setup):
  - It lists "Pre-orders for upcoming products" as a reason.
  - With the default stop-selling setting, "When a product reaches zero inventory, customers can't add it to their cart".
- **How apps implement pre-orders.** Pre-order and Try Before You Buy (TBYB) apps build options with `sellingPlanGroupCreate`. [pre-order and TBYB](https://shopify.dev/docs/apps/build/purchase-options/deferred)
  - "There's no single API to create a specific pre-order or TBYB option."
  - Each option combines pricing, delivery, inventory and billing policies, with `category` set to `PRE_ORDER` or `TRY_BEFORE_YOU_BUY`.
  - The inventory policy is `ON_SALE` or `ON_FULFILLMENT`.
  - Delivery and billing policies must be `fixed` for pre-orders.
  - Pre-orders and TBYB "can't be used through Shopify POS", draft orders or B2B.
  - Example configurations use `inventoryPolicy: {reserve: ON_FULFILLMENT}` / `{reserve: ON_SALE}`. [build deferment solution](https://shopify.dev/docs/apps/build/purchase-options/deferred/build-deferment-solution)
- **Selling plans vs. `CONTINUE`: UNVERIFIED.** The docs don't say whether a selling-plan pre-order also needs the variant's `inventoryPolicy` set to `CONTINUE` before an out-of-stock variant can be sold. Our app should **treat any of the following as signals of intentional overselling**:
  - a `PRE_ORDER` (or `TRY_BEFORE_YOU_BUY`) selling plan on the variant or product
  - `requiresSellingPlan: true`
  - a non-zero `sellingPlanGroupsCount`
  - merchant tags such as "preorder" or "backorder" (heuristic; not a Shopify convention)
- **Identifying which pre-order app owns a selling plan group.** `SellingPlanGroup.appId` can help. [SellingPlanGroup](https://shopify.dev/docs/api/admin-graphql/latest/objects/SellingPlanGroup)

## 6. Webhooks

### Topics

All scopes and descriptions below come from [WebhookSubscriptionTopic](https://shopify.dev/docs/api/admin-graphql/latest/enums/WebhookSubscriptionTopic).

| Topic | When it fires | Scope |
| - | - | - |
| `products/update` | "whenever a product is updated, ordered, or variants are added, removed or updated" | `read_products` |
| `inventory_levels/update` | Inventory level updated | `read_inventory` |
| `inventory_items/update` | Inventory item updated | `read_inventory` or `read_products` |
| `app/uninstalled` | App uninstalled | none stated |
| `variants/out_of_stock`, `variants/in_stock` | Variant goes out of / back into stock | `read_products` |
| `selling_plan_groups/create`, `selling_plan_groups/update`, `selling_plan_groups/delete` | Selling plan group changes | `read_products` |
| `app/scopes_update` | Granted scopes change | none stated |
| `bulk_operations/finish` | Bulk operation finishes | none stated |
| `products/create`, `products/delete` | Product created / deleted | `read_products` |

- **Sample payloads** [webhooks reference](https://shopify.dev/docs/api/webhooks/latest):
  - `products/update` carries REST-shaped variants including `inventory_policy`, `inventory_quantity` and `old_inventory_quantity`.
  - `inventory_levels/update` carries `inventory_item_id`, `location_id`, `available`, `updated_at` and `admin_graphql_api_id`.
- **Newer equivalent: Events.** Shopify calls Events its "next-generation subscription mechanism". [Events and webhooks](https://shopify.dev/docs/apps/build/events-webhooks)
  - Configured in `shopify.app.toml` only, with `[[events.subscription]]`, `topic = "Product"`, `actions`, `triggers` (for example `product.variants.price`) and a custom `query`.
  - The versioning page says Events "is currently available in the `unstable` version". [versioning](https://shopify.dev/docs/api/usage/versioning)
  - Treat Events as optional and non-GA. **UNVERIFIED for production use.**

### Delivery headers

Sources: [delivery structure](https://shopify.dev/docs/apps/build/webhooks/delivery-structure), [webhooks reference](https://shopify.dev/docs/api/webhooks/latest).

| Header | Meaning |
| - | - |
| `X-Shopify-Topic` | Topic name |
| `X-Shopify-Hmac-Sha256` | Base64 HMAC signature (HTTPS deliveries only) |
| `X-Shopify-Shop-Domain` | The shop's `myshopify.com` domain |
| `X-Shopify-API-Version` | Version used to serialise the payload |
| `X-Shopify-Webhook-Id` | "unique composite key per delivery"; use for de-duplication |
| `X-Shopify-Triggered-At` | When Shopify triggered the delivery |
| `X-Shopify-Event-Id` | "shared across all deliveries produced by the same merchant action" |
| `X-Shopify-Name` | Optional subscription name |

Treat header names as case-insensitive.

### HMAC verification

Source: [verify deliveries](https://shopify.dev/docs/apps/build/webhooks/verify-deliveries).

- Compute "HMAC-SHA256 of the raw request body using your app's client secret as the key". Compare it, base64-encoded, to the header in constant time.
- Parse the raw body; JSON middleware must not run first.
- After a client-secret rotation, it "can take up to an hour" for signatures to use the new secret.
- Pub/Sub and EventBridge deliveries don't need HMAC verification.

### Retries, timeouts and ordering

- **Response and timeouts.** Return `200`. Anything outside the 2xx range, including 3xx, is treated as an error. Shopify has a "one-second connection timeout and a five-second timeout for the entire request". [verify deliveries](https://shopify.dev/docs/apps/build/webhooks/verify-deliveries)
- **Retries.** Shopify "retries 8 times over the next 4 hours".
  - After 8 consecutive failures, an *Admin-API-created* subscription is deleted. [verify deliveries](https://shopify.dev/docs/apps/build/webhooks/verify-deliveries)
  - App-specific (TOML) subscriptions "will **not** be deleted". [subscribe](https://shopify.dev/docs/apps/build/webhooks/subscribe)
- **Ordering.** "Shopify doesn't guarantee ordering within a topic, or across different topics". Order deliveries by `X-Shopify-Triggered-At` or the payload's `updated_at`. [about webhooks](https://shopify.dev/docs/apps/build/webhooks)
- **Reconciliation.** Delivery "isn't always guaranteed", so build reconciliation jobs. [about webhooks](https://shopify.dev/docs/apps/build/webhooks)

### Subscribing: TOML vs API

Source: [subscribe](https://shopify.dev/docs/apps/build/webhooks/subscribe).

- **App-specific subscriptions** are recommended. They live in `shopify.app.toml` under `[webhooks] api_version = "2026-10"` and `[[webhooks.subscriptions]] topics = [...]`, `uri = "/webhooks"`.
  - Optional fields: `filter`, `include_fields`, `name`, `compliance_topics`.
- **Shop-specific subscriptions** use `webhookSubscriptionCreate(topic:, webhookSubscription:)`.
  - Compliance topics "**Cannot** be subscribed to using the Admin API".
- **Debouncing with `include_fields`.** Shopify debounces deliveries with identical payloads, so include `updated_at` in the field list. [delivery structure](https://shopify.dev/docs/apps/build/webhooks/delivery-structure)

## 7. Mandatory compliance (privacy) webhooks

Source for this section: [privacy law compliance](https://shopify.dev/docs/apps/build/compliance/privacy-law-compliance).

- **Topics:**

  | Topic | Purpose / timing |
  | - | - |
  | `customers/data_request` | Requests to view stored customer data |
  | `customers/redact` | Requests to delete customer data; sent "10 days after the deletion request" |
  | `shop/redact` | Sent "48 hours after a store owner uninstalls your app" |

- **They apply even if we store no personal data.** "Any app that you distribute through the Shopify App Store must respond to data subject requests, regardless of whether the app collects personal data."
- **Requirements:**
  - Handle `POST` requests with a JSON body and `Content-Type: application/json`.
  - Respond with a 2xx status code.
  - Complete the action within 30 days.
  - Return **`401 Unauthorized` if the HMAC header is invalid**.
  - Missing URLs or wrong responses mean the app "will be rejected".
- **Configuration** in `shopify.app.toml`:

  ```toml
  [[webhooks.subscriptions]]
  compliance_topics = ["customers/data_request", "customers/redact", "shop/redact"]
  uri = "https://app.example.com/webhooks"
  ```

  Dev Dashboard is an alternative. [subscribe](https://shopify.dev/docs/apps/build/webhooks/subscribe)

## 8. Authentication and installation (embedded app)

- **Shopify managed installation.** "Shopify installs your app and updates its access scopes without calling your app. You declare the scopes your app needs in its `shopify.app.toml` … Apps built with Shopify CLI use managed installation by default." [about app authentication](https://shopify.dev/docs/apps/build/authentication-authorization)
  - TOML keys: `[access_scopes] scopes = "read_products,..."`, `optional_scopes = [...]`, and `use_legacy_install_flow`. With `false` or omitted you get managed installation. [app configuration](https://shopify.dev/docs/apps/build/cli-for-apps/app-configuration)
  - Changes deploy with `shopify app deploy`. They are applied automatically to the dev store during `app dev`.
- **Token exchange is the grant for embedded apps.** The grant table maps "Runs in the Shopify admin" to "Token exchange". [about app authentication](https://shopify.dev/docs/apps/build/authentication-authorization)
- **Token endpoint and parameters** [access tokens](https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens):
  - Endpoint: `POST https://{shop}.myshopify.com/admin/oauth/access_token`.
  - `client_id`, `client_secret`.
  - `grant_type=urn:ietf:params:oauth:grant-type:token-exchange`.
  - `subject_token=<ID token>`.
  - `subject_token_type=urn:ietf:params:oauth:token-type:id_token`.
  - `requested_token_type`: `urn:shopify:params:oauth:token-type:offline-access-token` (the default) or `urn:shopify:params:oauth:token-type:online-access-token`.
  - `expiring`: `1` for an expiring offline token; `0` is the default.
  - An invalid or expired ID token returns `400`.
- **Expiring offline tokens and refresh tokens exist.**
  - "New public apps already can't use [non-expiring offline tokens] for GraphQL Admin API requests, and existing public apps can't after January 1, 2027." [access tokens](https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens)
  - Lifetimes:
    - expiring offline token: 1 hour (`expires_in` `3600`)
    - refresh token: 90 days (`refresh_token_expires_in` `7776000`)
    - online token: 24 hours or until logout
  - Refresh request: `grant_type=refresh_token` with `client_id`, `client_secret` and `refresh_token`. It returns a new access token *and* a new refresh token, because refresh tokens rotate.
  - A terminal failure returns `401` with `{"error":"invalid_request"}`.
  - Don't acquire and refresh a token for the same store at the same time.

  [implement token exchange](https://shopify.dev/docs/apps/build/authentication-authorization/implement-token-exchange)
- **Token format.** Offline and online tokens start with `shpat_`. [access tokens](https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens)
- **Authorization code grant (non-embedded apps)** [standalone apps](https://shopify.dev/docs/apps/build/authentication-authorization/authenticate-standalone-apps):
  - Redirect to `https://{shop}/admin/oauth/authorize?client_id=…&scope=…&redirect_uri=…&state=…`.
  - Add `&grant_options[]=per-user` for an online token.
  - On callback, verify `state`, then the HMAC: remove `hmac`, sort the remaining params, HMAC-SHA256 with the client secret (hex digest in the sample code), and compare in constant time.
  - Validate `shop` against `^[a-zA-Z0-9][a-zA-Z0-9\-]*\.myshopify\.com$`.
  - Exchange `code` (with `expiring=1`) at the same token endpoint.
- **ID tokens (formerly "session tokens")** [ID tokens](https://shopify.dev/docs/apps/build/authentication-authorization/id-tokens):
  - **Signature:** "check the token's signature against your client secret using HS256 (HMAC-SHA256)".
  - **Claims to validate:**
    - `exp` must be in the future
    - `nbf` must be in the past
    - `aud` must equal the client ID
    - `iss` and `dest` hostnames must match
  - **Informational claims:** `sub` (user), `sid` (session ID), `jti` (UUID), `iat`.
  - **Lifetime:** tokens "expire one minute after they're issued", and App Bridge may return a cached one.
  - Embedded apps "must authenticate with ID tokens, because third-party cookies aren't reliably available".
  - The shop domain comes from `dest`. [implement token exchange](https://shopify.dev/docs/apps/build/authentication-authorization/implement-token-exchange)
- **Authorization header behaviour.** App Bridge's fetch interceptor "automatically adds an OpenID Connect ID Token in the `Authorization` header" for requests to the app's domain and subdomains. [resource fetching API](https://shopify.dev/docs/api/app-home/apis/authentication-and-data/resource-fetching-api)
  - Or call `shopify.idToken()` and send `Authorization: Bearer <token>` yourself.
  - On a `401`, set the `X-Shopify-Retry-Invalid-Session-Request` header so App Bridge fetches a fresh token and retries once. [implement token exchange](https://shopify.dev/docs/apps/build/authentication-authorization/implement-token-exchange)
- **Bounce page and `id_token` URL parameter.**
  - Only the legacy App Bridge 2.0 page describes the bounce pattern: "If your app doesn't have a valid offline or online access token, redirect to a bounce page that loads the App Bridge script before redirecting back to the requested path." It adds: don't embed protected data in unauthenticated HTML. [legacy App Bridge 2 setup](https://shopify.dev/docs/apps/build/authentication-authorization/legacy/app-bridge-2-setup)
  - The current docs I read do not describe an `id_token` query parameter on document requests. **UNVERIFIED.** Prefer the template's `authenticate.admin(request)` or the documented fetch pattern.

## 9. Embedded app requirements

- **App Bridge script and meta tag** [App Bridge APIs](https://shopify.dev/docs/api/app-home/apis):

  ```html
  <meta name="shopify-api-key" content="%SHOPIFY_API_KEY%" />
  <script src="https://cdn.shopify.com/shopifycloud/app-bridge.js"></script>
  ```

  - App Store requirement 2.2.3 says to add the `app-bridge.js` script tag "before any other script tags". [App Store requirements](https://shopify.dev/docs/apps/launch/shopify-app-store/app-store-requirements)
- **CSP.** Set `frame-ancestors` on every HTML route. [iframe protection](https://shopify.dev/docs/apps/build/security/set-up-iframe-protection)
  - Embedded apps: `Content-Security-Policy: frame-ancestors https://{shop}.myshopify.com https://admin.shopify.com;`, which is per shop.
  - Non-embedded apps: `frame-ancestors 'none'`.
  - A missing or wildcard directive gets the app rejected. The related security checks are `MISSING_EMBEDDED_CSP` and `STATIC_FRAME_ANCESTORS`.
- **Must new App Store apps be embedded?** Not stated as a hard rule.
  - The App Store requirements say:
    - "Your embedded app must function properly without relying on third-party cookies or local storage" (1.1.1).
    - "Provide a consistent embedded experience" (2.2.2).
    - "Use the latest version of Shopify App Bridge" (2.2.3).

    [App Store requirements](https://shopify.dev/docs/apps/launch/shopify-app-store/app-store-requirements)
  - Built for Shopify says apps "should be embedded", with exceptions. [Built for Shopify requirements](https://shopify.dev/docs/apps/launch/built-for-shopify/requirements)
  - An explicit "must be embedded" rule is **UNVERIFIED**. In practice, embed.

## 10. Billing

- **Shopify billing is mandatory.** "All apps published on the Shopify App Store are required to use a Shopify provided billing solution." [billing](https://shopify.dev/docs/apps/launch/billing)
  - App Store requirement 1.2 says the same: "Bill through the Shopify Billing API or Shopify App Pricing". [App Store requirements](https://shopify.dev/docs/apps/launch/shopify-app-store/app-store-requirements)
- **Managed Pricing is renamed and is now the default.** "Managed Pricing has been renamed to **Shopify App Pricing**." It is "the default way to charge merchants" for new public apps. [Shopify App Pricing](https://shopify.dev/docs/apps/launch/billing/shopify-app-pricing)
  - Plans are defined in the **Partner Dashboard** app submission form.
  - Shopify hosts the plan page at `https://admin.shopify.com/store/:store_handle/charges/:app_handle/pricing_plans`.
  - "Don't call the Billing API's `appSubscriptionCreate` mutation" with App Pricing.
  - **Status checks moved to the Partner API.** Query `activeSubscription(appId:, shopId:)` there.
  - After approval, the redirect URL receives `plan_handle` (and `shop` for external URLs).
  - **Since April 28, 2026, App Pricing no longer sends `APP_SUBSCRIPTIONS_UPDATE` webhooks or appends `charge_id`.**
  - Dev-store testing: plans for an app in the same Partner organisation are free. There is also a $0 private test plan. Don't use `test` with App Pricing. [pass app review](https://shopify.dev/docs/apps/launch/app-store-review/pass-app-review)
- **Billing API ("Manual Pricing", legacy).** It "remains supported" and is required for one-time purchases. [billing](https://shopify.dev/docs/apps/launch/billing)
  - `appSubscriptionCreate` arguments [appSubscriptionCreate](https://shopify.dev/docs/api/admin-graphql/latest/mutations/appSubscriptionCreate):
    - `name` (required)
    - `returnUrl` (required)
    - `lineItems` (required); each has `plan.appRecurringPricingDetails { price { amount currencyCode } interval }` or a usage plan
    - `test` (default `false`)
    - `trialDays`
    - `replacementBehavior` (default `STANDARD`)
  - It returns `appSubscription`, `confirmationUrl` and `userErrors`.
  - `AppPricingInterval` values are `EVERY_30_DAYS` and `ANNUAL`. [AppPricingInterval](https://shopify.dev/docs/api/admin-graphql/latest/enums/AppPricingInterval)
  - Status: `currentAppInstallation.activeSubscriptions: [AppSubscription!]!`. [AppInstallation](https://shopify.dev/docs/api/admin-graphql/latest/objects/AppInstallation)
  - Webhook: `APP_SUBSCRIPTIONS_UPDATE`. [manual pricing](https://shopify.dev/docs/apps/launch/billing/manual-pricing)
  - Test charges: set `test: true` and Shopify "creates a test charge when you install the app on your development store". Set it back to `false` afterwards. [pass app review](https://shopify.dev/docs/apps/launch/app-store-review/pass-app-review)
- **Plan changes.** Merchants must be able to upgrade and downgrade without contacting support (requirement 1.2.3). [App Store requirements](https://shopify.dev/docs/apps/launch/shopify-app-store/app-store-requirements)

## 11. App Store submission requirements

Main source: [App Store requirements](https://shopify.dev/docs/apps/launch/shopify-app-store/app-store-requirements).

- **Code requirements:**
  - 1.1.1: ID/session-token auth, with no third-party cookies or local storage.
  - 1.2: Shopify billing.
  - 2.1: no 404, 500 or 300 errors; UI operational; "Synchronize data accurately".
  - 2.2.3: App Bridge.
  - 2.2.4: GraphQL only.
  - 2.3: install only from Shopify surfaces, no myshopify URL entry, authenticate immediately after install and reinstall, redirect to the app UI.
  - 3.1: valid TLS.
  - 3.2: request only necessary scopes; use optional scopes where possible.
  - Compliance webhooks (section 7).
  - CSP `frame-ancestors` (section 9).
- **Listing and submission requirements:**
  - 4.x: unique name; pricing only in Pricing details; no stats, claims or testimonials.
  - 4.5.3: demo screencast in English or with English subtitles.
  - 4.5.4 and 4.5.5: working test credentials.
  - 4.5.6: an emergency developer contact (email and phone) is required. [submit for review](https://shopify.dev/docs/apps/launch/app-store-review/submit-app-for-review)
  - App icon 1200 x 1200 px, JPEG or PNG. URLs and API contact email must not contain "Shopify". [submit for review](https://shopify.dev/docs/apps/launch/app-store-review/submit-app-for-review)
  - Privacy policy: "Include a privacy policy (required)" (listing best practices). [best practices](https://shopify.dev/docs/apps/launch/shopify-app-store/best-practices)
- **Protected customer data.** "Level 0: No customer data → No action required." [protected customer data](https://shopify.dev/docs/apps/launch/protected-customer-data)
  - The product query is explicitly not protected data.
  - On the review page you can "choose to opt out" if you don't need it. [submit for review](https://shopify.dev/docs/apps/launch/app-store-review/submit-app-for-review)
  - Our product and inventory-only app is Level 0, provided we request no order or customer scopes.
- **Built for Shopify (optional badge, not required for listing)** [Built for Shopify requirements](https://shopify.dev/docs/apps/launch/built-for-shopify/requirements):
  - At least 50 net installs from paid-plan shops.
  - At least 5 reviews and a minimum rating.
  - Admin Web Vitals at p75: LCP at most 2.5 s, CLS at most 0.1, INP at most 200 ms. Each needs at least 100 calls in 28 days.
  - Embedded with App Bridge; primary workflows inside the admin.
- **Review process.** Status moves Draft → Submitted → (Paused) → Reviewed → Published. Automated checks run first. Repeated failures can trigger "cooldown" periods. [review process](https://shopify.dev/docs/apps/launch/app-store-review/review-process), [submit for review](https://shopify.dev/docs/apps/launch/app-store-review/submit-app-for-review)
- **Review timelines: UNVERIFIED.** None of the pages I read gives a duration.

## 12. Development stores and test setup

Sources: [dev stores](https://shopify.dev/docs/apps/build/stores/development-stores), [scaffold an app](https://shopify.dev/docs/apps/build/scaffold-app), [app dev](https://shopify.dev/docs/api/shopify-cli/app/app-dev).

1. **Account.** You need a Partner account, or a merchant store with developer permissions.
2. **Create a dev store.** Either:
   - Run `shopify store create dev --name "<name>" --plan basic|grow|advanced|plus --demo-data`.
   - Or use the Dev Dashboard (https://dev.shopify.com/dashboard): Stores → Create store → Dev.

   Limits: 250 dev stores per organisation. The myshopify URL is permanent. The store is always password protected and can't process real transactions.
3. **Create the app.** Run `shopify app init` and choose "Build a React Router app". The CLI creates the app in the Dev Dashboard and links it.
4. **Run it.** `cd <app>` then `shopify app dev`. Optionally pass `-s/--store <store>`. This starts a Cloudflare tunnel. Press `p` to open the preview, then click "Install app".
5. **Seed test data.** Optionally use `--demo-data` or the template's "Generate a product".
6. **Deploy configuration.** Run `shopify app deploy` to push TOML (scopes, webhooks) to production. During `app dev`, changes apply to the dev store automatically. [app configuration](https://shopify.dev/docs/apps/build/cli-for-apps/app-configuration)
7. **Test webhooks.** Run `shopify app webhook trigger --topic=<topic> --address=<destination> --api-version=<v>`. This does not test the subscription itself. [subscribe](https://shopify.dev/docs/apps/build/webhooks/subscribe), [privacy law compliance](https://shopify.dev/docs/apps/build/compliance/privacy-law-compliance)

---

## Implications for our implementation

### Required scopes (`shopify.app.toml`)

```toml
[access_scopes]
scopes = "read_products,write_products,read_inventory,read_locations"
```

- **`write_products`** is needed for `productVariantsBulkUpdate`. It also grants `read_products`. [access scopes](https://shopify.dev/docs/api/usage/access-scopes)
- **`read_inventory`** is needed for `InventoryLevel` and `InventoryQuantity`.
- **`read_locations`** is optional, because Location also accepts `read_inventory`. [Location](https://shopify.dev/docs/api/admin-graphql/latest/objects/Location)
- **`write_inventory`** only if we ever change stock counts; it is not needed for a policy fix.
- **`read_purchase_options`**: might be needed to read `SellingPlan` details. This is **UNVERIFIED**; test it on a dev store, and if needed add it as an optional scope.
- **No customer or order scopes**, which keeps us at protected-customer-data Level 0.

### Recommended read query (adapted from the 2026-10 reference)

```graphql
query VariantsToAudit($cursor: String) {
  productVariants(first: 25, after: $cursor, query: "product_status:ACTIVE,DRAFT gift_card:false") {
    pageInfo { hasNextPage endCursor }
    nodes {
      id
      title
      sku
      inventoryPolicy            # CONTINUE | DENY
      inventoryQuantity          # total sellable; not deprecated in 2026-10
      updatedAt
      sellingPlanGroupsCount { count }
      product {
        id title status tags isGiftCard requiresSellingPlan tracksInventory
        sellingPlanGroupsCount { count }
      }
      inventoryItem {
        id
        tracked
        inventoryLevels(first: 10) {
          nodes {
            location { id name }
            quantities(names: ["available", "on_hand", "committed", "incoming", "reserved"]) { name quantity }
          }
        }
      }
    }
  }
}
```

- **Query cost: UNVERIFIED.** Measure it with `extensions.cost.requestedQueryCost` and the `Shopify-GraphQL-Cost-Debug=1` header, and lower `first` if it nears the 1,000-point cap.
- **Large catalogs.** Run the same selection through `bulkOperationRunQuery`. It has one nested connection level, within the documented two-level limit. Then wait on `bulk_operations/finish` or poll `bulkOperation(id:)`.
- **Pre-order detail.** To see what kind of selling plan is attached, query `sellingPlanGroups(first: 5) { nodes { appId name sellingPlans(first: 5) { nodes { category inventoryPolicy { reserve } } } } }` on flagged variants only.

### Recommended write mutation and verification

```graphql
mutation SetInventoryPolicy($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
  productVariantsBulkUpdate(productId: $productId, variants: $variants, allowPartialUpdates: false) {
    product { id }
    productVariants { id inventoryPolicy updatedAt }
    userErrors { field message code }
  }
}
# variables: { "productId": "gid://shopify/Product/…",
#              "variants": [{ "id": "gid://shopify/ProductVariant/…", "inventoryPolicy": "DENY" }] }
```

1. Before applying, re-read the variant to make sure it has not changed since approval; this is our own optimistic check.
2. Send only `id` and `inventoryPolicy`.
3. Treat a non-empty `userErrors` or a top-level `errors[].extensions.code` (for example `THROTTLED` or `ACCESS_DENIED`) as a failure.
4. Verify with `query { productVariant(id: $id) { inventoryPolicy updatedAt } }`.
5. If the app ever edits stock, use `inventorySetQuantities` / `inventoryAdjustQuantities`. These require `@idempotent(key:)`, and `inventorySetQuantities` also requires `changeFromQuantity`, from 2026-04.

### Webhook topics to subscribe (app-specific, `api_version = "2026-10"`)

- `products/update`, `inventory_levels/update`, `inventory_items/update`, `app/uninstalled`.
- Optional: `variants/out_of_stock`, `selling_plan_groups/create|update|delete`, `app/scopes_update`, `bulk_operations/finish`.
- Compliance: `customers/data_request`, `customers/redact`, `shop/redact`, via `compliance_topics`.
- Handlers must:
  - verify `X-Shopify-Hmac-Sha256` on the raw body
  - return `401` on a bad HMAC for compliance topics
  - respond 2xx within 5 s and queue the work
  - de-duplicate by `X-Shopify-Webhook-Id`
  - order by `X-Shopify-Triggered-At` / `updated_at`
  - run periodic reconciliation

### Checks against our assumptions

- **(a) `productVariantsBulkUpdate` can set `inventoryPolicy`: CONFIRMED.** `ProductVariantsBulkInput.inventoryPolicy` exists, and the mutation requires `write_products`. One caveat: the field says "Defaults to `DENY`", and its behaviour when omitted on update is UNVERIFIED.
- **(b) The available quantity can be negative: CONFIRMED** through Help Center reports ("Overselling reduces the Available quantity below 0"). The POS UI extension docs also describe `CONTINUE` as allowing sales at "zero or negative" inventory. The Admin API reference itself does not state this explicitly.
- **(c) Token exchange is the recommended auth for embedded apps: CONFIRMED.** New for us:
  - **expiring offline tokens (1 h) with rotating 90-day refresh tokens are mandatory for new public apps**
  - send `expiring=1` on the exchange
- **(d) Session tokens are HS256 JWTs signed with the client secret: CONFIRMED.** They are now called "ID tokens" and expire after 1 minute.

### Other contradictions and changes to plan around

- **Billing.** "Managed Pricing" is now **Shopify App Pricing**:
  - It is the default for new public apps.
  - Subscription status comes from the **Partner API** (`activeSubscription`), not `currentAppInstallation`.
  - **No `APP_SUBSCRIPTIONS_UPDATE` webhooks** are sent for App Pricing after 2026-04-28.
- **Bulk operations.** Use `bulkOperation(id:)` rather than `currentBulkOperation`. Up to five concurrent bulk queries are allowed.
- **Deprecations in 2026-10.**
  - `InventoryItem.variant` is deprecated in favour of `variants`. One inventory item can now list several variants, despite the guide's "1:1" wording.
  - `ProductVariant.barcode` → `barcodes`.
  - `sellingPlanGroupCount` → `sellingPlanGroupsCount`.
- **No `inventory_policy` search filter** exists on `productVariants`, so filter on the client side.
- **Rate-limit figures are inconsistent.** The bucket size per plan isn't documented, and the documented example (1000/50) conflicts with the plan table (Standard 100 points/second). Read `throttleStatus` at runtime.
- **Other UNVERIFIED items:**
  - the `id_token` URL parameter
  - the bounce page in the current (non-legacy) docs
  - App Store review timelines
  - an explicit "must be embedded" rule
  - whether selling-plan pre-orders require the variant to be set to `CONTINUE`
