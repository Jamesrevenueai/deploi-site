# Shopify research: publication, price and SKU workflows

- Researched: 2026-10-28
- Companion to [`shopify.md`](./shopify.md), which already covers versioning, rate limits, bulk queries, inventory policy, auth, webhooks delivery and billing. This file does not repeat that material.
- Sources: official documentation only, on shopify.dev and help.shopify.com. No accounts, credentials or sign-ups were used.
- API version read: **GraphQL Admin API `2026-10`** (latest stable).
  - Every Admin GraphQL reference page cited below was fetched from `https://shopify.dev/docs/api/admin-graphql/latest/<type>/<Name>.md` and reported `api_version: 2026-10` in its front matter.
  - Guide pages (`/docs/apps/build/...`) have no `api_version` front matter. The product-publishing guide's examples are labelled `POST /api/2026-07/graphql.json`, so they were written against 2026-07. Where a guide and a 2026-10 reference page disagree, this file follows the reference page.
  - The `webhooks/latest` reference reported `api_version: 2026-10`.
- How pages were read:
  - shopify.dev pages were fetched as Markdown by adding `.md` to the URL. Deprecation reasons, which the Markdown omits, were read from the HTML page's embedded data.
  - help.shopify.com blocks plain HTTP clients. Those pages were read through a summarising web-fetch tool, so the quotes are as that tool returned them. Re-check them by hand before quoting them externally.
- Convention: anything not confirmed in official docs is marked **UNVERIFIED**.

---

## 1. Product publication (sales channels)

### 1.1 Model

- **How publishing is built.** "The publishing framework is built on **catalogs** and **publications**." [product publishing guide](https://shopify.dev/docs/apps/build/sales-channels/product-publishing)
  - `AppCatalog` "represents sales channels like the Online Store, Point of Sale, or custom channels".
  - `MarketCatalog` represents international markets.
  - `CompanyLocationCatalog` represents B2B company locations.
  - "Each catalog can have an associated **publication**, which is the group of products and collections visible to buyers in that context."
- **Who implements `Publishable`.** The interface is implemented by `Product`, `ProductVariant` and `Collection`. [product publishing guide](https://shopify.dev/docs/apps/build/sales-channels/product-publishing), [Publishable](https://shopify.dev/docs/api/admin-graphql/latest/interfaces/Publishable)
- **Requirements stated by the guide:**
  - "Your app has the `read_publications` and `write_publications` access scopes. You also need `read_products` to query products."
  - "Your store has at least one active sales channel. Most stores have the Online Store by default."

  [product publishing guide](https://shopify.dev/docs/apps/build/sales-channels/product-publishing)
- **What the publication scopes cover.** `read_publications` / `write_publications` cover "Publication fields on `Product`, `Collection`, and `ProductVariant`, such as `publications` and `resourcePublications`, and publishing mutations such as `productPublish` and `publicationCreate`. Also accepted as `read_channels` and `write_channels`." [access scopes](https://shopify.dev/docs/api/usage/access-scopes)

### 1.2 Listing publications

- **`publications` query.** "Requires `read_publications` access scope." [publications](https://shopify.dev/docs/api/admin-graphql/latest/queries/publications)
  - Arguments: `first`, `last`, `after`, `before`, `reverse`, and `catalogType: CatalogType`.
  - `CatalogType` values are `APP`, `COMPANY_LOCATION`, `MARKET` and `NONE`. [CatalogType](https://shopify.dev/docs/api/admin-graphql/latest/enums/CatalogType)
- **`Publication` fields in 2026-10** [Publication](https://shopify.dev/docs/api/admin-graphql/latest/objects/Publication):
  - `id: ID!`
  - `autoPublish: Boolean!`: "Whether new products are automatically published to this publication."
  - `supportsFuturePublishing: Boolean!`
  - `catalog: Catalog`: "The catalog associated with the publication."
  - `channels: ChannelConnection`
  - `products`: "published to the publication"
  - `includedProducts`: "included, but not necessarily published"
  - `includedProductsCount`
  - `productPublicationsV3`
  - `hasCollection(id:)`
  - `operation: PublicationOperation`: "A background operation associated with this publication."
- **Deprecated `Publication` fields.** These are listed under "Deprecated fields" on the [Publication](https://shopify.dev/docs/api/admin-graphql/latest/objects/Publication) page. The reasons below were read from the page's HTML data.
  - `name: String!`: "Use [Catalog.title] instead."
  - `app: App!`: "Use [AppCatalog.apps] instead."
- **`Catalog` interface** [Catalog](https://shopify.dev/docs/api/admin-graphql/latest/interfaces/Catalog):
  - Fields: `id`, `title: String!`, `status: CatalogStatus!`, `priceList: PriceList`, `publication: Publication`, `operations`.
  - `AppCatalog` adds `apps: AppConnection!` and `channels: ChannelConnection!`. [AppCatalog](https://shopify.dev/docs/api/admin-graphql/latest/objects/AppCatalog)
  - `AppCatalog` "Requires `read_products` access scope or `read_product_listings` access scope. Also: The app owning the catalog needs either products or product listing rights."
  - `App` has `id`, `title`, `handle` and `apiKey`. [App](https://shopify.dev/docs/api/admin-graphql/latest/objects/App)
- **Guide example.** The guide's `publications` example selects `id autoPublish supportsFuturePublishing catalog { id title }`. The sample response shows `"catalog": {"id": "gid://shopify/AppCatalog/1", "title": "Online Store"}`. [product publishing guide](https://shopify.dev/docs/apps/build/sales-channels/product-publishing)
- **`channels` query.** "When the calling application supports multi-channel, only channels established by the calling application are returned." It is therefore not a reliable way for a non-channel app to discover the Online Store. [channels](https://shopify.dev/docs/api/admin-graphql/latest/queries/channels)

#### Identifying "Online Store" reliably

There is **no documented stable identifier** for the Online Store publication. **UNVERIFIED**:
- No `isOnlineStore` flag exists on `Publication`.
- The Online Store app handle is not documented.
- It is not documented whether `Catalog.title` is localized or merchant-editable.

Documented signals we can combine:
1. **Catalog title.** `Publication.catalog` is an `AppCatalog` whose `title` is "Online Store" in the guide example. This is a **heuristic only**. [product publishing guide](https://shopify.dev/docs/apps/build/sales-channels/product-publishing)
2. **Future publishing.** "Only online store channels support scheduled publishing", so `supportsFuturePublishing: true` points to an online-store-type publication. It is not proof, because a shop could have more than one. [publishablePublish](https://shopify.dev/docs/api/admin-graphql/latest/mutations/publishablePublish), [PublicationInput](https://shopify.dev/docs/api/admin-graphql/latest/input-objects/PublicationInput)
3. **`onlineStoreUrl`.** `Product.onlineStoreUrl`: "If `null`, then the product isn't published to the online store sales channel." This is a channel-specific ground truth independent of publication IDs. [Product](https://shopify.dev/docs/api/admin-graphql/latest/objects/Product)
4. **Search filter.** The products search filter `published_status:published` "Returns resources that are published to the online store". `published_status:unpublished` returns those that are not. `online_store_channel` "Returns all resources in the online store channel, regardless of publication status." [products query](https://shopify.dev/docs/api/admin-graphql/latest/queries/products)

**Recommended:**
- Pick the candidate publication by (1) and (2).
- Then cross-check it on a few products: `publishedOnPublication(candidate)` must agree with `onlineStoreUrl != null` and with the `published_status:published` result set.
- If there is no exact match, or more than one candidate, ask the merchant to choose the publication. Never guess.

### 1.3 Reading whether a product is published

- **`publishedOnPublication(publicationId: ID!): Boolean!`**: "Whether the resource is published to a specified publication." It is on `Product`, `ProductVariant` and `Collection`. [Publishable](https://shopify.dev/docs/api/admin-graphql/latest/interfaces/Publishable), [Product](https://shopify.dev/docs/api/admin-graphql/latest/objects/Product)
- **`resourcePublicationsV2`** [Publishable](https://shopify.dev/docs/api/admin-graphql/latest/interfaces/Publishable):
  - Takes `first`/`after`/…, `catalogType`, and `onlyPublished: Boolean = true`.
  - Returns `ResourcePublicationV2 { isPublished: Boolean!, publication: Publication!, publishable, publishDate: DateTime }`.
  - "By default, only publications to `APP` catalog types are returned. For `Product` and `ProductVariant`, use the `catalogType` argument to retrieve publications for other catalog types, such as `COMPANY_LOCATION` (B2B) or `MARKET`."
  - `catalogType`: "When not specified, defaults to APP."
  - `onlyPublished`: "If false, then also returns the resources that are scheduled or staged to be published."
  - `ResourcePublicationV2.isPublished`: "If true, then the resource publication is published to the publication. If false, then the resource publication is staged to be published." [ResourcePublicationV2](https://shopify.dev/docs/api/admin-graphql/latest/objects/ResourcePublicationV2)
- **`resourcePublications` (V1): do not use it for "is it live?" checks.** `ResourcePublication.isPublished` "Also returns true if the resource publication is scheduled to be published." Its `publishDate: DateTime!` returns "an epoch timestamp" if the resource isn't published. `ResourcePublication.channel` is deprecated. [ResourcePublication](https://shopify.dev/docs/api/admin-graphql/latest/objects/ResourcePublication)
- **Other Publishable fields:** `unpublishedPublications`, `availablePublicationsCount` (excludes feedback errors) and `resourcePublicationsCount` (includes them). [Publishable](https://shopify.dev/docs/api/admin-graphql/latest/interfaces/Publishable)
- **Deprecated Publishable fields:** `publishedOnChannel`, `publishedOnCurrentChannel`, `publishedOnCurrentPublication`, `publicationCount` and `unpublishedChannels`. [Publishable](https://shopify.dev/docs/api/admin-graphql/latest/interfaces/Publishable)
- **`Product.publishedAt: DateTime`**: "The date and time when the product was published to the online store." [Product](https://shopify.dev/docs/api/admin-graphql/latest/objects/Product)
- **`Product.onlineStoreUrl: URL`**: see §1.2 (3).
- **Detecting a scheduled publication.** "Request `resourcePublicationsV2` with `onlyPublished: false` … If that node has a `publishDate` in the future and `isPublished` is `false`, then the product is scheduled." [scheduled publishing](https://shopify.dev/docs/apps/build/sales-channels/scheduled-product-publishing)
- **Variant-level publishing:**
  - "By default, all variants are published on all channels and catalogs where their parent product is published."
  - A variant is visible only when all of the following hold:
    - "The product has an Active status (or Unlisted on supported channels)."
    - "The product is published to that channel or catalog."
    - "The variant is published to that channel or catalog."
  - "Publishing or unpublishing a product doesn't change any variant's publication state."

  So a product can be published while some variants are hidden. [product publishing guide](https://shopify.dev/docs/apps/build/sales-channels/product-publishing)

### 1.4 Status vs publication

- **`Product.status: ProductStatus!`** "controls visibility across all sales channels". [Product](https://shopify.dev/docs/api/admin-graphql/latest/objects/Product)
- **`ProductStatus` values** [ProductStatus](https://shopify.dev/docs/api/admin-graphql/latest/enums/ProductStatus):
  - `ACTIVE`: "ready to sell and can be published to sales channels and apps. Products with an active status aren't automatically published to sales channels, such as the online store, or apps."
  - `ARCHIVED`: "no longer being sold and isn't available to customers on sales channels and apps."
  - `DRAFT`: "isn't ready to sell and is unavailable to customers on sales channels and apps. By default, duplicated and unarchived products are set to draft."
  - `UNLISTED`: "active but you need a direct link to view it. The product doesn't show up in search, collections, or product recommendations." This status "is only visible from 2025-10 and up, is translated to active in older versions and can't be changed from unlisted in older versions."
- **Unlisted products in more detail.** They are hidden from storefront search, collections, recommendations, the sitemap (`noindex,nofollow`) and Shopify Catalog. "In cart, checkout, orders, and other post-purchase surfaces, unlisted products behave like active products." [unlisted products](https://shopify.dev/docs/apps/build/product-merchandising/unlisted-products)
  - Help Center: "You can't publish unlisted products to any third-party sales channels." Unlisted products can be published to POS. [Help: product details page](https://help.shopify.com/en/manual/products/details/product-details-page)
- **Publishing does not change status, and status gates visibility.**
  - `publishablePublish`: "For products to be visible in a channel, they must have an active `ProductStatus`." [publishablePublish](https://shopify.dev/docs/api/admin-graphql/latest/mutations/publishablePublish)
  - The products search filter `status` says: "Shopify only displays products with an `ACTIVE` status in online stores, sales channels, and apps." [products query](https://shopify.dev/docs/api/admin-graphql/latest/queries/products)
- **Can a DRAFT product be published?**
  - The Help Center describes selecting channels while a product is Draft: "To publish the duplicate product to only specific sales channels, firstly set the product status to Draft, [select the sales channels…, then set the product status to Active]". [Help: add/update products](https://help.shopify.com/en/manual/products/add-update-products)
  - So a Draft product can hold publication records, but it is not visible until it is Active.
  - Whether `publishablePublish` on a DRAFT product returns a `userError` or succeeds silently is **UNVERIFIED**; test it on a dev store.
  - Help Center on scheduling: "Products must be in Active status for future publishing to work. If a product is in Draft status at the scheduled publish time, then the product won't be published." [Help: future publishing](https://help.shopify.com/en/manual/shopify-admin/productivity-tools/future-publishing)
- **Consequence for us.** "Published on publication X" is not the same as "visible to buyers on X". Visible means:
  - `status == ACTIVE` (or `UNLISTED` where supported),
  - `publishedOnPublication(X)` is true,
  - and, for variants, the variant is also published.

### 1.5 Publish / unpublish mutations

- **`publishablePublish(id: ID!, input: [PublicationInput!]!)`** [publishablePublish](https://shopify.dev/docs/api/admin-graphql/latest/mutations/publishablePublish)
  - "Requires `write_publications` access scope. Also: The user must have permission to create and edit products or create and edit catalogs."
  - Returns `PublishablePublishPayload { publishable: Publishable, shop: Shop!, userErrors: [UserError!]! }`.
  - `UserError` has only `field` and `message`. There is **no `code`**.
  - "Products sold exclusively on subscription (`requiresSellingPlan: true`) can only be published to online stores."
- **`publishableUnpublish(id: ID!, input: [PublicationInput!]!)`**: same scope and permission, same payload shape. "The resource remains in your store but becomes unavailable to customers." [publishableUnpublish](https://shopify.dev/docs/api/admin-graphql/latest/mutations/publishableUnpublish)
- **`PublicationInput`** [PublicationInput](https://shopify.dev/docs/api/admin-graphql/latest/input-objects/PublicationInput):
  - `publicationId: ID`
  - `publishDate: DateTime`: "Setting this to a date in the future will schedule the resource to be published. Only online store channels support future publishing. This field has no effect if you include it in the `publishableUnpublish` mutation."
  - `channelId` is deprecated.
- **Idempotent by design.** "If the product is already published to a given publication, the mutation succeeds with no change." The `input` array allows several publications per call. [product publishing guide](https://shopify.dev/docs/apps/build/sales-channels/product-publishing)
- **`publishablePublishToCurrentChannel` and `publishableUnpublishToCurrentChannel` are deprecated in 2026-10.**
  - The reference says "Deprecated. Use publishablePublish instead." and "Use publishableUnpublish instead."
  - They publish "to the current Channel associated with the requesting app. The system determines the current channel by the app's API client ID", so they are only meaningful for sales-channel apps.
  - The guide confirms: "The `publishablePublishToCurrentChannel` and `publishableUnpublishToCurrentChannel` convenience mutations, which took no publication ID, are deprecated."

  [publishablePublishToCurrentChannel](https://shopify.dev/docs/api/admin-graphql/latest/mutations/publishablePublishToCurrentChannel), [publishableUnpublishToCurrentChannel](https://shopify.dev/docs/api/admin-graphql/latest/mutations/publishableUnpublishToCurrentChannel), [guide](https://shopify.dev/docs/apps/build/sales-channels/product-publishing)
- **Bulk alternative:** `publicationUpdate(id:, input: { publishablesToAdd, publishablesToRemove })`, "with a maximum of 50 items per operation". [Publication (mutations list)](https://shopify.dev/docs/api/admin-graphql/latest/objects/Publication), [guide](https://shopify.dev/docs/apps/build/sales-channels/product-publishing)
- **Synchronous or asynchronous: UNVERIFIED.**
  - The guide's example payload returns updated `resourcePublicationsCount` in the same response, which suggests the change is reflected synchronously.
  - However `Publication.operation` exists for "background" operations.
  - Always verify with a separate read (see §5).
- **Which publications an app may publish to: partly UNVERIFIED.**
  - The docs show a non-channel app publishing to any publication ID it can read, given `write_publications`.
  - Restrictions that are documented:
    - `requiresSellingPlan` products go to online stores only.
    - Scheduling applies to online stores only.
    - Unlisted products can't go to third-party channels (Help Center).
    - Products need ACTIVE status to be visible.
  - Whether `publications` lists every publication to a third-party app, and whether some channels reject third-party publishing, is UNVERIFIED.

### 1.6 Webhooks for publication changes

Sources: [WebhookSubscriptionTopic](https://shopify.dev/docs/api/admin-graphql/latest/enums/WebhookSubscriptionTopic), [webhooks reference](https://shopify.dev/docs/api/webhooks/latest).

- **`product_publications/create`, `/update` and `/delete` (`read_publications`): not usable for Online Store monitoring by our app.** The reference says: "a webhook is only emitted when there are publishing changes to the app that is subscribed to the topic (ie. no webhook will be emitted if there is a publishing change to the online store and the webhook subscriber of the topic is a third-party app)."
- **`product_listings/add|remove|update` and `scheduled_product_listings/*` (`read_product_listings`)** are sales-channel-app topics. [scheduled publishing](https://shopify.dev/docs/apps/build/sales-channels/scheduled-product-publishing)
- **`products/update` (`read_products`)** "Occurs whenever a product is updated, ordered, or variants are added, removed or updated."
  - The sample payload includes `published_at`, `published_scope` (`"web"`) and `status`, plus per-variant `price`, `compare_at_price`, `sku` and `barcodes`.
  - Whether a pure publish or unpublish on a non-Online-Store channel triggers `products/update` is **UNVERIFIED**.
  - **Plan:** treat webhooks as hints only, and run a periodic reconciliation read.

### 1.7 Status changes need a person

- **`productChangeStatus(productId:, status:)` is deprecated.** "Use productUpdate instead." It "Requires `write_products` access scope. Also: The user must have a permission to change products status." [productChangeStatus](https://shopify.dev/docs/api/admin-graphql/latest/mutations/productChangeStatus)
- **`productUpdate(product: ProductUpdateInput)`** with `ProductUpdateInput.status: ProductStatus` ("controls visibility across all sales channels"). "Requires `write_products` … The user must have a permission to update products." [productUpdate](https://shopify.dev/docs/api/admin-graphql/latest/mutations/productUpdate), [ProductUpdateInput](https://shopify.dev/docs/api/admin-graphql/latest/input-objects/ProductUpdateInput)
- **Why status is a separate decision.** Status and publication are different authorizations:
  - Status uses scope `write_products` plus the user permission "change products status".
  - Publishing uses scope `write_publications` plus "create and edit products or create and edit catalogs".
  - Status also changes visibility on **every** channel at once.
  - Moving a product from DRAFT or ARCHIVED to ACTIVE is a lifecycle decision: "isn't ready to sell" / "no longer being sold".
  - **The app must never change `status` as a side effect of a publication fix. Route it to a person.**
- **Throttle conflict.**
  - `productUpdate` says: "a throttle that takes effect when a store has 50,000 product variants. After this threshold is reached, no more than 1,000 new product variants can be updated per day." [productUpdate](https://shopify.dev/docs/api/admin-graphql/latest/mutations/productUpdate)
  - The rate-limits page instead says 500,000 variants and 10,000 new variants per day, listing `productCreate`, `productUpdate` and `productVariantCreate`, and exempting Plus. [rate limits](https://shopify.dev/docs/apps/build/apis/graphql-admin/rate-limits)
  - The two pages disagree, so which figure applies is UNVERIFIED.

---

## 2. Price

### 2.1 Reading

- **`ProductVariant.price: Money!`**: "The price of the product variant in the default shop currency." [ProductVariant](https://shopify.dev/docs/api/admin-graphql/latest/objects/ProductVariant)
- **`ProductVariant.compareAtPrice: Money`**: nullable, "The compare-at price of the variant in the default shop currency." [ProductVariant](https://shopify.dev/docs/api/admin-graphql/latest/objects/ProductVariant)
- **`Money` scalar**: "A monetary value string without a currency symbol or code. Example value: `"100.57"`." [Money](https://shopify.dev/docs/api/admin-graphql/latest/scalars/Money)
  - Responses return strings, for example `"price": "15.99"` and `"compareAtPrice": null`. [productVariantsBulkCreate example](https://shopify.dev/docs/api/admin-graphql/latest/mutations/productVariantsBulkCreate)
- **`Decimal` scalar**: "A signed decimal number, which supports arbitrary precision and is serialized as a string. Example values: `"29.99"`, `"29.999"`." It is used in `MoneyV2.amount`. [Decimal](https://shopify.dev/docs/api/admin-graphql/latest/scalars/Decimal), [MoneyV2](https://shopify.dev/docs/api/admin-graphql/latest/objects/MoneyV2)
- **Shop currency**: `shop { currencyCode }`, where `currencyCode: CurrencyCode!` is "The three letter code for the currency that the shop sells in." [Shop](https://shopify.dev/docs/api/admin-graphql/latest/objects/Shop)
  - `enabledPresentmentCurrencies: [CurrencyCode!]!` lists other buyer-facing currencies.
  - `ProductVariant.presentmentPrices` is **deprecated**. [ProductVariant](https://shopify.dev/docs/api/admin-graphql/latest/objects/ProductVariant)
- **Product-level ranges.** `Product.priceRangeV2` and `compareAtPriceRange` are "in the shop's default currency". `Product.priceRange` is deprecated. [Product](https://shopify.dev/docs/api/admin-graphql/latest/objects/Product)

### 2.2 Markets, catalogs and price lists override the variant price for some buyers

- **Price lists override the variant price.** `PriceList`: "Price lists override default product prices with either fixed prices or percentage-based adjustments. Each price list associates with a `Catalog` to determine which customers see the pricing." [PriceList](https://shopify.dev/docs/api/admin-graphql/latest/objects/PriceList)
  - It "Requires `read_products` access scope. Also: The user must have a permission to view catalogs."
  - Fields: `currency: CurrencyCode!` ("currency for fixed prices"), `fixedPricesCount: Int!`, `parent: PriceListParent` (relative adjustments), `catalog`, and `prices(originType:, query:)`.
  - The `prices` query filters are `product_id` and `variant_id`.
- **`PriceListPrice`**: `price: MoneyV2!`, `compareAtPrice: MoneyV2`, `originType: PriceListPriceOriginType!` and `variant`. [PriceListPrice](https://shopify.dev/docs/api/admin-graphql/latest/objects/PriceListPrice)
  - `PriceListPriceOriginType` values: `FIXED` ("defined on the price list") and `RELATIVE`. [PriceListPriceOriginType](https://shopify.dev/docs/api/admin-graphql/latest/enums/PriceListPriceOriginType)
- **Fixed prices win.** From [Markets catalogs guide](https://shopify.dev/docs/apps/build/markets/catalogs):
  - "If you use the `PriceListPrice` field to configure a fixed price for a product variant, then the fixed price takes precedence over any other adjustments that are defined at the price list level."
  - "Fixed price list prices are defined in the price list currency."
  - "Relative price list prices are returned in the store currency from the APIs and don't have rounding rules and foreign exchange rates applied. Rounding rules and foreign exchange rates are applied in the online store and checkout."
  - `PriceListParent` `settings.compareAtMode` can be `ADJUSTED` (the default) or `NULLIFY`, which returns `null` for `compareAtPrice`.
  - Precedence order: catalogs directly connected to a company location → company location markets → region markets → app catalogs (Online Store).
  - "In the case of a tie the lowest price is used."
  - "When the market has multiple catalogs, the user receives the lowest price that's associated with those catalogs."
  - "If the customer doesn't match a catalog's context, then the given price is the initial price (the product variant price) in the original currency."
- **Help Center** [Help: sale pricing](https://help.shopify.com/en/manual/products/details/product-pricing/sale-pricing):
  - "Fixed prices override prices and compare-at prices set in your Shopify admin."
  - For international markets, "Sale prices can't be created within the Shopify admin".
- **Seeing the effective price for a context.** `ProductVariant.contextualPricing(context: ContextualPricingContext!)` returns `ProductVariantContextualPricing { price: MoneyV2!, compareAtPrice: MoneyV2, unitPrice, quantityPriceBreaks, quantityRule, auditTrail: PricingAuditTrail! }`. [ProductVariant](https://shopify.dev/docs/api/admin-graphql/latest/objects/ProductVariant), [ProductVariantContextualPricing](https://shopify.dev/docs/api/admin-graphql/latest/objects/ProductVariantContextualPricing)
  - "As of API version 2025-04, only active markets are considered in the price resolution."
  - `ContextualPricingContext` fields: `country: CountryCode`, `companyLocationId: ID` and `locationId: ID`. [ContextualPricingContext](https://shopify.dev/docs/api/admin-graphql/latest/input-objects/ContextualPricingContext)
  - `PricingAuditTrail.priceAdjustments: [AuditTrailAdjustment!]!` holds `type` (`ADDITION`, `MULTIPLICATION` or `REPLACEMENT`), `value: Decimal!`, `price: MoneyV2!` and `label`. [PricingAuditTrail](https://shopify.dev/docs/api/admin-graphql/latest/objects/PricingAuditTrail), [AuditTrailAdjustment](https://shopify.dev/docs/api/admin-graphql/latest/objects/AuditTrailAdjustment), [AuditTrailAdjustmentType](https://shopify.dev/docs/api/admin-graphql/latest/enums/AuditTrailAdjustmentType)
  - Shopify warns that `label` "is **localized display text** and **not a stable contract**". Do not parse it.
- **Discovering catalogs and price lists.**
  - The `catalogs` query returns app, market and B2B catalogs. [catalogs](https://shopify.dev/docs/api/admin-graphql/latest/queries/catalogs)
  - The `priceLists` query is "All price lists for a shop". [priceLists](https://shopify.dev/docs/api/admin-graphql/latest/queries/priceLists)
  - `MarketCatalog` and `CompanyLocationCatalog` require `read_products`. [MarketCatalog](https://shopify.dev/docs/api/admin-graphql/latest/objects/MarketCatalog), [CompanyLocationCatalog](https://shopify.dev/docs/api/admin-graphql/latest/objects/CompanyLocationCatalog)
  - `Market` requires `read_markets`. [Market](https://shopify.dev/docs/api/admin-graphql/latest/objects/Market)
- **What an app must not assume:**
  - that `ProductVariant.price` is what every buyer pays;
  - that a merchant's reference file in another currency maps to `price`;
  - that a relative price-list price equals the storefront amount, since FX and rounding are applied later;
  - that `compareAtPrice` shown to a market buyer equals the variant's `compareAtPrice`.

### 2.3 Writing

- **`productVariantsBulkUpdate`.** Requires `write_products` plus the user permission "update product variants". See `shopify.md` §4. [productVariantsBulkUpdate](https://shopify.dev/docs/api/admin-graphql/latest/mutations/productVariantsBulkUpdate)
- **`ProductVariantsBulkInput` price fields.** `price: Money` ("The price of the variant") and `compareAtPrice: Money` ("The compare-at price of the variant"). [ProductVariantsBulkInput](https://shopify.dev/docs/api/admin-graphql/latest/input-objects/ProductVariantsBulkInput)
  - Doc examples pass numbers (`"price": 15.99`) or strings (`"price": "29.99"`). **Send strings** to avoid float drift; the `Money` scalar is a string. [productVariantsBulkCreate](https://shopify.dev/docs/api/admin-graphql/latest/mutations/productVariantsBulkCreate), [publishing guide](https://shopify.dev/docs/apps/build/sales-channels/product-publishing)
- **Clearing `compareAtPrice`.**
  - The `productVariantsBulkCreate` example sets `"compareAtPrice": null` and gets `null` back. [productVariantsBulkCreate](https://shopify.dev/docs/api/admin-graphql/latest/mutations/productVariantsBulkCreate)
  - That `null` on **update** clears an existing value is **UNVERIFIED**; test it.
  - Help Center: "A compare-at price of $0.00 USD isn't the same as an empty compare-at price." [Help: sale pricing](https://help.shopify.com/en/manual/products/details/product-pricing/sale-pricing)
- **Compare-at vs price.**
  - The API does **not** document a validation that `compareAtPrice > price`. No such `ProductVariantsBulkUpdateUserErrorCode` exists.
  - Help Center: "Make sure that the value in the Compare-at price field is higher than the value in the Price field to display the sale price." [Help: sale pricing](https://help.shopify.com/en/manual/products/details/product-pricing/sale-pricing)
  - So a compare-at price at or below the price is accepted but shows no sale. Treat it as a data-quality finding, not an API error.
- **Price-related `ProductVariantsBulkUpdateUserErrorCode` values** [enum](https://shopify.dev/docs/api/admin-graphql/latest/enums/ProductVariantsBulkUpdateUserErrorCode):
  - `GREATER_THAN_OR_EQUAL_TO`: "The price of the variant must be greater than or equal to zero."
  - `NEGATIVE_PRICE_VALUE`: "Price cannot take a negative value."
  - `LOCAL_CURRENCY_GIFT_CARD_PRICE_MUST_BE_ZERO`
  - `INVALID_INPUT`
  - `PRODUCT_SUSPENDED`
  - `UNSUPPORTED_COMBINED_LISTING_PARENT_OPERATION`
  - `MUST_BE_FOR_THIS_PRODUCT`
  - `PRODUCT_VARIANT_DOES_NOT_EXIST`
- **Rounding and precision: UNVERIFIED.**
  - `Money` examples show 2 decimals and `Decimal` "supports arbitrary precision".
  - Whether Shopify rounds or rejects more decimals than the currency's minor unit is not documented.
  - Compare amounts as decimals, never as floats or raw strings: `"20"` vs `"20.00"` formatting is UNVERIFIED.
- **Fixed price-list prices are written elsewhere.** They use `priceListFixedPricesAdd` / `priceListFixedPricesUpdate`, not the variant. [PriceListPrice](https://shopify.dev/docs/api/admin-graphql/latest/objects/PriceListPrice)
  - Scopes for those mutations were not researched. Out of scope: route to a person.

---

## 3. SKU

- **Read: `ProductVariant.sku: String`.** "A case-sensitive identifier for the product variant in the shop. Required in order to connect to a fulfillment service." [ProductVariant](https://shopify.dev/docs/api/admin-graphql/latest/objects/ProductVariant)
- **`InventoryItem.sku: String`.** "Inventory item SKU. Case-sensitive string." [InventoryItem](https://shopify.dev/docs/api/admin-graphql/latest/objects/InventoryItem)
  - The `InventoryItem` description says it "holds the stock keeping unit (SKU)".
  - Both fields expose the same underlying value. This is inferred from the input design below; that they are always byte-identical is **UNVERIFIED**.
- **Write path in 2026-10:** `ProductVariantsBulkInput.inventoryItem: InventoryItemInput { sku: String }`, where `sku` is "The SKU (stock keeping unit) of the inventory item". [ProductVariantsBulkInput](https://shopify.dev/docs/api/admin-graphql/latest/input-objects/ProductVariantsBulkInput), [InventoryItemInput](https://shopify.dev/docs/api/admin-graphql/latest/input-objects/InventoryItemInput)
  - `ProductVariantsBulkInput` in 2026-10 has **no `sku` field**, not even a deprecated one. Its only deprecated field is `barcode`.
  - The input field description says the inventory item is "used for unit cost". It nonetheless carries `sku`, `tracked`, `cost` and so on.
- **Scopes for the write.**
  - `productVariantsBulkUpdate` requires `write_products`.
  - Whether setting `inventoryItem.sku` through it additionally needs `write_inventory` is **UNVERIFIED**; test it, and if needed request `write_inventory`.
  - The alternative `inventoryItemUpdate(id:, input: InventoryItemInput!)` "Requires `write_inventory` access scope. Also: The user must have a permission to update an inventory item." Its payload has plain `userErrors { field message }`. [inventoryItemUpdate](https://shopify.dev/docs/api/admin-graphql/latest/mutations/inventoryItemUpdate)
- **Uniqueness is NOT enforced.**
  - Help Center: "SKUs within your Shopify admin must be unique and no two product variants should include the same SKU in their details."
  - Then: "If a duplicate SKU is detected, then a warning message displays … If you need to duplicate SKUs for bundles or specific workflows, then ignore the warning. Duplicate SKUs can cause issues with third-party integrations and inventory tracking." [Help: SKU](https://help.shopify.com/en/manual/products/details/sku)
  - API: `InventoryItem.duplicateSkuCount: Int!` is "The number of inventory items that share the same SKU with this item." This is an official, cheap duplicate detector. [InventoryItem](https://shopify.dev/docs/api/admin-graphql/latest/objects/InventoryItem)
- **Length and characters.**
  - The Help Center gives only guidance: "Keep your SKUs as short as possible, such as no more than 16 characters"; "Don't use special characters, symbols, or spaces"; "Dashes and underscores are useful". [Help: SKU](https://help.shopify.com/en/manual/products/details/sku)
  - The API maximum length and allowed characters are **UNVERIFIED**. Generic codes `TOO_LONG` ("The input value is too long") and `BLANK` exist in `ProductVariantsBulkUpdateUserErrorCode`. [enum](https://shopify.dev/docs/api/admin-graphql/latest/enums/ProductVariantsBulkUpdateUserErrorCode)
  - `SUBSCRIPTION_VIOLATION` means "You reached the limit of available SKUs in your current plan."
- **Searching by SKU.**
  - The `sku:` filter exists on `products`, `productVariants` and `inventoryItems`, for example `sku:XYZ-12345`. [productVariants](https://shopify.dev/docs/api/admin-graphql/latest/queries/productVariants), [inventoryItems](https://shopify.dev/docs/api/admin-graphql/latest/queries/inventoryItems)
  - Search syntax: "For tokenized fields, equality exists if the term is found anywhere in the field. For non-tokenized fields, the search query string must match the searched field exactly." Default search is case-insensitive. [search syntax](https://shopify.dev/docs/api/usage/search-syntax)
  - Whether `sku` is tokenized is **UNVERIFIED**. **Always re-filter results client-side with an exact, case-sensitive comparison.**
- **Barcodes as a matching key** [ProductVariant](https://shopify.dev/docs/api/admin-graphql/latest/objects/ProductVariant), [ProductVariantBarcode](https://shopify.dev/docs/api/admin-graphql/latest/objects/ProductVariantBarcode), [BarcodeInput](https://shopify.dev/docs/api/admin-graphql/latest/input-objects/BarcodeInput):
  - `ProductVariant.barcode` is deprecated. Use `barcodes: ProductVariantBarcodeConnection!`, "up to 20 barcodes", each `{ value: String! (max 255), type: BarcodeType }`.
  - On write, `barcodes` "Replaces the entire barcode set", and an input "can't set both `barcode` and `barcodes`".
  - Barcode error codes: `INVALID_BARCODE_TYPE` ("Allowed barcode types are: upc, ean, isbn, gtin, asin, ns-pid"), `DUPLICATE_BARCODE_VALUE` ("within the same variant"), `TOO_MANY_BARCODES`, `INCOMPATIBLE_BARCODE_FIELDS` and the `BARCODE_*` / `INVALID_BARCODE_*` codes. [enum](https://shopify.dev/docs/api/admin-graphql/latest/enums/ProductVariantsBulkUpdateUserErrorCode)
  - Shop-wide barcode uniqueness is **not documented**; only the per-variant rule is. Treat barcodes as non-unique.

---

## 4. Shared

- **Atomicity of `productVariantsBulkUpdate`.**
  - `allowPartialUpdates` defaults to `false`: "When partial updates are not allowed, any error will prevent all variants from updating." [productVariantsBulkUpdate](https://shopify.dev/docs/api/admin-graphql/latest/mutations/productVariantsBulkUpdate)
  - The guide adds: "Each mutation modifies only what you specify, and everything else remains unchanged." [update data guide](https://shopify.dev/docs/apps/build/product-merchandising/products-and-collections/update-data)
  - That a single variant's `price`, `compareAtPrice` and `inventoryItem.sku` are committed atomically together is implied but **not stated explicitly: UNVERIFIED**. Verify every field by re-reading.
  - "You can update up to 250 variants in a single operation." [update data guide](https://shopify.dev/docs/apps/build/product-merchandising/products-and-collections/update-data)
  - "By default, stores have a limit of 2048 product variants for each product." [productVariantsBulkUpdate](https://shopify.dev/docs/api/admin-graphql/latest/mutations/productVariantsBulkUpdate)
- **Fields to request in the payload for verification.** `productVariants { id price compareAtPrice sku inventoryItem { id sku duplicateSkuCount } updatedAt }` and `userErrors { field message code }`. Then do an independent re-read with `productVariant(id:)` or `nodes(ids:)`, because no read-after-write guarantee is documented (see `shopify.md`).
- **Cost of reading publications per product** [rate limits](https://shopify.dev/docs/apps/build/apis/graphql-admin/rate-limits):
  - Default costs are: scalar 0, object 1, connection sized by `first`/`last`.
  - `publishedOnPublication(publicationId:)` is a `Boolean!` scalar with an argument, so by the default table it adds about 0 to the cost. Selecting it once per known publication on each product in a page of `products(first: N)` is the cheapest pattern.
  - `resourcePublicationsV2(first: k)` is a nested connection costing about k per product.
  - Actual per-field costs can differ: "Every field in the schema has an integer cost value assigned to it … Running a query is the best way to find out its true cost."
  - "Some fields, such as totals and nested connections, might require Shopify to process all of an object's related records … a large page … can return an `INTERNAL_SERVER_ERROR`."
  - Measure with `extensions.cost` (see `shopify.md`). The exact cost of `publishedOnPublication` and `contextualPricing` is **UNVERIFIED**.
  - For whole-catalog audits, prefer filters: `products(query: "published_status:unpublished status:active")` for the Online Store, or `published_status:<channel_id_or_handle>-hidden`. [products query](https://shopify.dev/docs/api/admin-graphql/latest/queries/products)
  - Alternatively, use `bulkOperationRunQuery`, which is covered in `shopify.md`.
- **Bulk price or SKU updates** ([bulk imports](https://shopify.dev/docs/apps/build/apis/graphql-admin/bulk-operations/imports), [bulkOperationRunMutation](https://shopify.dev/docs/api/admin-graphql/latest/mutations/bulkOperationRunMutation)):
  - `productVariantsBulkUpdate` "can run … as part of a bulk operation for large-scale catalog updates". [productVariantsBulkUpdate](https://shopify.dev/docs/api/admin-graphql/latest/mutations/productVariantsBulkUpdate)
  - `bulkOperationRunMutation(mutation: String!, stagedUploadPath: String!, clientIdentifier: String)`. `groupObjects` is deprecated.
  - Upload the JSONL through `stagedUploadsCreate` with `mimeType: "text/jsonl"`.
  - Limits:
    - up to five bulk mutation operations per shop at once (2026-01+);
    - must finish within 24 h or it is marked `failed`;
    - JSONL file at most 100 MB;
    - the mutation may have only one connection field.
  - Not rate-limited: "the `bulkOperationRunMutation` request isn't" subject to rate limits.
  - "The GraphQL Admin API doesn't serially process the contents of the JSONL file. Avoid relying on a particular sequence."
  - Per-line errors, including "Access denied errors", appear in the output JSONL with the line number. The whole operation fails only for critical errors such as `INTERNAL_SERVER_ERROR`.
  - Don't modify the staged file while it runs, or the operation fails with `INTERNAL_SERVER_ERROR`.
  - The reference says it "Requires Only accessible by supported access tokens". The linked "access token considerations" section was not found on the current page, so which tokens qualify is **UNVERIFIED**.

---

## Implications for our implementation

### Full scope list (all four workflows)

```toml
[access_scopes]
scopes = "read_products,write_products,read_inventory,read_locations,read_publications,write_publications"
# conditional / to test on a dev store:
#   write_inventory  – only if productVariantsBulkUpdate refuses inventoryItem.sku without it (UNVERIFIED),
#                      or if we use inventoryItemUpdate for SKU
#   read_markets     – only if we read Market objects (catalogs/price lists themselves need read_products)
```

- `read_publications` / `write_publications`: [access scopes](https://shopify.dev/docs/api/usage/access-scopes), [publishablePublish](https://shopify.dev/docs/api/admin-graphql/latest/mutations/publishablePublish)
- Price and SKU writes use `write_products`: [productVariantsBulkUpdate](https://shopify.dev/docs/api/admin-graphql/latest/mutations/productVariantsBulkUpdate)
- `PriceList` and `contextualPricing` reads use `read_products`, plus the user permission to view catalogs for `PriceList`: [PriceList](https://shopify.dev/docs/api/admin-graphql/latest/objects/PriceList), [ProductVariantContextualPricing](https://shopify.dev/docs/api/admin-graphql/latest/objects/ProductVariantContextualPricing)
- **User permissions.** Mutations also check staff permissions: "permission to create and edit products or create and edit catalogs" for publishing, and "update product variants" for price and SKU. How these apply to offline tokens is UNVERIFIED.

### Workflow A: publication

**Read (once per shop, cache):**
```graphql
query Publications($after: String) {
  shop { currencyCode }
  publications(first: 50, after: $after, catalogType: APP) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id autoPublish supportsFuturePublishing
      catalog { __typename id title status ... on AppCatalog { apps(first: 5) { nodes { id handle title } } } }
    }
  }
}
```

**Read (per page of products):**
```graphql
query ProductsOnPublication($pub: ID!, $after: String, $q: String) {
  products(first: 100, after: $after, query: $q) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id title handle status publishedAt onlineStoreUrl requiresSellingPlan updatedAt
      publishedOnPublication(publicationId: $pub)
      resourcePublicationsV2(first: 10, onlyPublished: false) { nodes { publication { id } isPublished publishDate } }
    }
  }
}
```
Drop `resourcePublicationsV2` once cost is measured, if `publishedOnPublication` is enough.

**Write:**
```graphql
mutation Publish($id: ID!, $pubId: ID!, $input: [PublicationInput!]!) {
  publishablePublish(id: $id, input: $input) {
    publishable { ... on Product { id status publishedOnPublication(publicationId: $pubId) } }
    userErrors { field message }
  }
}
# $input: [{ "publicationId": $pubId }]   (same GID as $pubId)
# unpublish: publishableUnpublish(id:, input:) with the same shape
```

- **Evidence of an actual error:**
  - The merchant's explicit instruction or reference file says product P must be on, or off, publication X.
  - A fresh read shows `publishedOnPublication(X)` disagreeing.
  - For the Online Store, `onlineStoreUrl` nullness agrees with the read.
  - The product `status` is `ACTIVE`; the product is not "missing" merely because it is DRAFT.
  - There is no future-dated `ResourcePublicationV2` (`isPublished: false` with a future `publishDate`), which is an intentional schedule.
- **Verify:** re-read `publishedOnPublication(X)` and, for the Online Store, `onlineStoreUrl`/`publishedAt`. An empty `userErrors` is not proof.
- **Block or route to a person:**
  - any `status` change (DRAFT, ARCHIVED or UNLISTED ↔ ACTIVE);
  - DRAFT or ARCHIVED products (publishing them has no buyer effect, so ask);
  - UNLISTED products targeted at third-party channels;
  - `requiresSellingPlan` products targeted at non-online-store channels;
  - ambiguous Online Store identification;
  - variant-level publication differences;
  - MARKET or COMPANY_LOCATION publications (catalog edits);
  - any `userErrors`.

### Workflow B: price

**Read:**
```graphql
query VariantPrice($id: ID!) {
  shop { currencyCode }
  productVariant(id: $id) {
    id sku price compareAtPrice updatedAt
    product { id status }
  }
}
# override check (per flagged variant):
query Overrides($v: String!) {
  priceLists(first: 50) {
    nodes { id name currency catalog { __typename title status }
      prices(first: 1, originType: FIXED, query: $v) { nodes { price { amount currencyCode } compareAtPrice { amount currencyCode } } } }
  }
}
# $v = "variant_id:<numeric id>"; optionally contextualPricing(context: { country: XX }) { price { amount currencyCode } auditTrail { priceAdjustments { type value } } }
```

**Write:**
```graphql
mutation SetPrice($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
  productVariantsBulkUpdate(productId: $productId, variants: $variants, allowPartialUpdates: false) {
    productVariants { id price compareAtPrice updatedAt }
    userErrors { field message code }
  }
}
# $variants: [{ "id": "gid://shopify/ProductVariant/…", "price": "24.99", "compareAtPrice": "29.99" }]
```

- **Evidence of an actual error:**
  - The instruction or reference file states a price **in `shop.currencyCode`** for an exactly identified variant.
  - A fresh `price` (compared as decimals) differs.
  - A compare-at at or below the price is a "no sale shown" data-quality finding only, per the Help Center.
- **Verify:** re-read `price` and `compareAtPrice` and compare them as decimals.
- **Block or route to a person:**
  - reference prices in any other currency;
  - variants with FIXED price-list prices, or any catalog price lists (fixing the base price won't change what those buyers pay, and changing it does change relative prices for them);
  - large relative changes beyond a merchant-set threshold;
  - compare-at clearing (behaviour of `null` on update is UNVERIFIED);
  - gift cards (`LOCAL_CURRENCY_GIFT_CARD_PRICE_MUST_BE_ZERO`);
  - combined-listing parents;
  - DRAFT or ARCHIVED products, by merchant policy;
  - any `userErrors`.

### Workflow C: SKU

**Read:**
```graphql
query BySku($q: String!) {
  productVariants(first: 10, query: $q) {
    nodes { id sku barcodes(first: 20) { nodes { value type } } product { id title status }
      inventoryItem { id sku duplicateSkuCount } }
  }
}
# $q = "sku:'ABC-123'"; then keep only nodes where sku === reference (exact, case-sensitive)
```

**Write:**
```graphql
mutation SetSku($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
  productVariantsBulkUpdate(productId: $productId, variants: $variants, allowPartialUpdates: false) {
    productVariants { id sku inventoryItem { id sku duplicateSkuCount } updatedAt }
    userErrors { field message code }
  }
}
# $variants: [{ "id": "gid://shopify/ProductVariant/…", "inventoryItem": { "sku": "ABC-123" } }]
# fallback (needs write_inventory): inventoryItemUpdate(id: $inventoryItemId, input: { sku: "ABC-123" }) { inventoryItem { id sku } userErrors { field message } }
```

- **Evidence of an actual error:**
  - The reference row maps to exactly one variant by a key other than SKU, or by a SKU that the merchant confirms. That key is the variant GID, or a barcode that matches exactly one variant.
  - The variant's fresh `sku` differs, using exact case-sensitive comparison.
- **Verify:** re-read `sku` and `inventoryItem.sku`, and check `duplicateSkuCount` on the new value: 0 is expected unless the merchant allows duplicates.
- **Block or route to a person:**
  - **Ambiguous mapping**: a reference key that matches 0 or more than 1 variant;
  - a target SKU already in use elsewhere (`duplicateSkuCount > 0` after a dry-run search);
  - barcodes shared by several variants;
  - variants whose inventory item lists several variants (`InventoryItem.variants`, see `shopify.md`);
  - SKUs that fail Help Center guidance (spaces or symbols), which are allowed but should be flagged;
  - any `userErrors` such as `TOO_LONG` or `BLANK`;
  - variants linked to a fulfillment service (SKU "Required in order to connect to a fulfillment service"), where a change could break the integration.

### Workflow D: inventory policy

Unchanged from `shopify.md`. It shares the same `productVariantsBulkUpdate` call, so **do not batch an inventory-policy fix with price or SKU fixes in one mutation** unless the merchant approved both. Keep one fix type per call so that the audit trail and rollback stay clean.

### Cross-cutting

- **Before every write:** re-read the target and compare it with the value approved by the merchant (our own optimistic check). Abort if it changed.
- **Treat as failure:** a non-empty `userErrors`, or any top-level `errors[].extensions.code`.
- **Webhooks:**
  - `products/update` is a change hint for price, SKU, status and Online Store `published_at`.
  - `product_publications/*` won't fire for third-party apps on Online Store changes.
  - Run a scheduled reconciliation read.

### Open items to test on a dev store (all UNVERIFIED)

1. `publishablePublish` on DRAFT, ARCHIVED and UNLISTED products: does it error, succeed, or succeed with no visibility?
2. Whether `publications` lists every channel's publication to a non-channel app, and how to identify the Online Store robustly (app handle, title localisation).
3. Whether `productVariantsBulkUpdate` with `inventoryItem.sku` requires `write_inventory`.
4. Whether `compareAtPrice: null` on update clears the value.
5. Price precision and rounding beyond the currency minor unit; whether `sku` search is exact or tokenized; the maximum SKU length.
6. Whether publish and unpublish results are immediately visible on re-read; whether `products/update` fires on publish changes.
7. Query cost of `publishedOnPublication`, `resourcePublicationsV2` and `contextualPricing` in paginated reads.
8. The variant-update throttle threshold: 50,000 / 1,000 on the `productUpdate` page vs 500,000 / 10,000 on the rate-limits page.
