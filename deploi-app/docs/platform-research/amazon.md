# Amazon Seller Central (SP-API) connector research

Researched 2026-10-28 from public official documentation only. Nothing was registered, no credentials were used, nobody was contacted.

**How to read this:**
- Every factual claim cites a URL. Lines marked **UNVERIFIED** could not be confirmed in official docs. Lines marked **Inference** are our reading of the docs, not something Amazon states.
- Official SP-API docs live at `https://developer-docs.amazon.com/sp-api/...`. As of today every URL there returns `301` to the same path on `https://developer-docs.amazon/sp-api/...` (observed with curl). Both hosts are Amazon's. Citations below use the `developer-docs.amazon.com` form, which still resolves. Most pages show `updatedAt` 2026-09 or 2026-10.
- Seller Central help pages (for example `https://sellercentral.amazon.com/help/hub/reference/external/G17781`, which the SP-API docs link for async error codes) were not readable without a login: the fetch returned a generic marketing page. Seller Central help content is therefore **UNVERIFIED** here.

---

## 1. Becoming a public SP-API developer

### 1.1 Public vs private developer
- **Public developers:**
  - build apps for other sellers or vendors;
  - get explicit authorization from each seller through OAuth;
  - "Must list their application in the Amazon Selling Partner Appstore, in accordance with the Solution Provider Portal Agreement."
  - Source: https://developer-docs.amazon.com/sp-api/docs/register-as-a-public-developer
- **Private developers** build apps only for their own organization. Those apps are self-authorized and limited to 10 self-authorizations. https://developer-docs.amazon.com/sp-api/docs/sp-api-registration-overview , https://developer-docs.amazon.com/sp-api/docs/application-authorization-limits
- **Conflict in Amazon's docs about listing:**
  - The Appstore page says: "Although you're not required to list your app on the Selling Partner Appstore, authorization limits apply to unlisted apps that serve sellers." https://developer-docs.amazon.com/sp-api/docs/list-your-app-on-the-selling-partner-appstore
  - The registration page says public developers *must* list (link above).
  - Plan to list.
- **Authorization limits:** https://developer-docs.amazon.com/sp-api/docs/application-authorization-limits

  | App type | OAuth authorizations | Self-authorizations (testing) |
  |---|---|---|
  | Public app for sellers, unlisted | max **25** | 10 |
  | Public app for sellers, listed | unlimited | 10 |

### 1.2 Solution Provider Portal (SPP) account
- SPP is "the central hub that you use to manage your SP-API applications". https://developer-docs.amazon.com/sp-api/docs/onboarding-step-1-prepare-for-registration
- **Creating the account** (https://developer-docs.amazon.com/sp-api/docs/onboarding-step-2-create-an-spp-account):
  1. Sign in at `https://solutionproviderportal.amazon.com/` with an Amazon.com account.
  2. Choose "Build applications that use SP APIs".
  3. Verify identity:
     - business registration number and registered address;
     - government ID or passport;
     - recent bank or credit card statement;
     - SMS or phone PIN;
     - a **live video call with an Amazon associate**.
- **Must be done by the primary account user.** https://developer-docs.amazon.com/sp-api/docs/sp-api-registration-overview

### 1.3 Developer profile
- **Created in SPP** (Settings > Developer Profile, or Develop Apps > Proceed to Developer Profile). https://developer-docs.amazon.com/sp-api/docs/register-as-a-public-developer
- **The form collects:**
  - contact info: organization, website, country, primary contact;
  - Data Access, where we choose "Public Developer";
  - Roles;
  - Use Cases;
  - Security Controls (free-form answers under 500 characters);
  - acceptance of the AUP, DPP and Solution Provider Portal Agreement.
  - Source: same page.
- **Website requirement.** The website must be public and describe the services offered to sellers. Not accepted: under construction, security warnings, or login-only. https://developer-docs.amazon.com/sp-api/docs/register-as-a-public-developer
- **Detailed website guidelines** (https://developer-docs.amazon.com/sp-api/docs/website-guidelines):
  - HTTPS with a valid certificate;
  - a privacy policy covering collection, use, storage, sharing and deletion in line with the DPP;
  - visible pricing;
  - a direct contact method;
  - the company and app name must match the developer profile;
  - no generic-only app name.
- **Policies** (DPP, AUP, Solution Provider Portal Agreement, by locale): https://developer-docs.amazon.com/sp-api/docs/policies-and-agreements
- **Response deadline.** If Amazon asks questions on the case, we must answer within **five days** or the case is closed. https://developer-docs.amazon.com/sp-api/docs/register-as-a-public-developer
- **Review timeline** (https://developer-docs.amazon.com/sp-api/docs/onboarding-step-3-create-a-developer-profile):
  - Standard (non-restricted) roles: "typically takes one to two weeks."
  - Restricted roles: a business review, a security review, and a technical review with an Amazon solution architect. https://developer-docs.amazon.com/sp-api/docs/register-as-a-public-developer
- **Sandbox while waiting.** A Sandbox app client can be registered while the profile is under review. https://developer-docs.amazon.com/sp-api/docs/onboarding-step-4-register-your-first-sandbox-application

### 1.4 Roles
- **What roles do.** Roles gate operations; calling an operation without the role returns **403**. Roles are requested in the developer profile and then selected per app. https://developer-docs.amazon.com/sp-api/docs/roles-in-the-selling-partner-api
- **Restricted roles.** Restricted roles (marked "(Restricted)") can involve PII:
  - Direct-to-Consumer Shipping
  - Tax Invoicing
  - Tax Remittance
  - Professional Services
  - Selling Partner Support
  - Source: https://developer-docs.amazon.com/sp-api/docs/roles-in-the-selling-partner-api
  - Restricted roles also require an architecture or security review. https://developer-docs.amazon.com/sp-api/docs/register-as-a-public-developer
- **Roles relevant to us (all non-restricted)** — Product Listing, Inventory and Order Tracking, Amazon Fulfillment and Pricing are defined at https://developer-docs.amazon.com/sp-api/docs/roles-in-the-selling-partner-api . Operation mappings: https://developer-docs.amazon.com/sp-api/docs/role-mappings . Report and notification type mappings: https://developer-docs.amazon.com/sp-api/docs/role-mappings-for-types

  | Operation / type | Roles accepted (any one) |
  |---|---|
  | `getListingsItem`, `searchListingsItems`, `patchListingsItem`, `putListingsItem`, `deleteListingsItem` (2021-08-01) | Product Listing **or** Inventory and Order Tracking |
  | FBA Inventory `getInventorySummaries` | Amazon Fulfillment **or** Product Listing |
  | `getMarketplaceParticipations` (Sellers API) | Product Listing or Selling Partner Insights (NA/EU/FE) |
  | Report `GET_MERCHANT_LISTINGS_ALL_DATA` | Inventory and Order Tracking, Pricing, Product Listing, or DTC Shipping (Restricted) |
  | Report `GET_MERCHANT_LISTINGS_INACTIVE_DATA` | Inventory and Order Tracking, Pricing, Product Listing |
  | Report `GET_MERCHANTS_LISTINGS_FYP_REPORT` (suppressed listings) | Product Listing |
  | Reports `GET_STRANDED_INVENTORY_UI_DATA`, `GET_FBA_MYI_UNSUPPRESSED_INVENTORY_DATA` | Amazon Fulfillment or Pricing |
  | Notifications `LISTINGS_ITEM_ISSUES_CHANGE`, `LISTINGS_ITEM_STATUS_CHANGE`, `LISTINGS_ITEM_MFN_QUANTITY_CHANGE` | Product Listing |
  | Notification `FBA_INVENTORY_AVAILABILITY_CHANGES` | Amazon Fulfillment |
  | Notification `ITEM_INVENTORY_EVENT_CHANGE` | **Brand Analytics** (not needed; see §6) |

- **No PII needed.** None of the operations above needs a restricted role, so the use case needs no PII and no Restricted Data Token. Restricted operations are the ones that return PII and need an RDT. https://developer-docs.amazon.com/sp-api/docs/connecting-to-the-selling-partner-api
- **Adding a role later** requires all of the following (https://developer-docs.amazon.com/sp-api/docs/roles-in-the-selling-partner-api):
  1. Resubmit the developer profile.
  2. Apply the role to the app.
  3. Re-list the app.
  4. Have every seller re-authorize to get a new refresh token. Reauthorization is also triggered "anytime you add a role". https://developer-docs.amazon.com/sp-api/docs/reauthorize-applications
- **Choose all roles up front.**

### 1.5 App registration (production)
- **Prerequisite:** the developer profile must be approved first. https://developer-docs.amazon.com/sp-api/docs/onboarding-step-7-register-your-first-production-application
- **In SPP, "Add new app client":**
  - API type: SP-API
  - Application type: Production
  - User Access: Sellers
  - Roles: only roles already approved can be chosen
  - OAuth **Login URI** and **Redirect URI**. The redirect URI cannot be `localhost`. Several redirect URIs are allowed; the first is the default.
- **The app starts in Draft status.**
- Source: same page.

### 1.6 Appstore listing and approval timeline
- **Requirements to list** (https://developer-docs.amazon.com/sp-api/docs/list-your-app-on-the-selling-partner-appstore):
  - registered public developer;
  - a working OAuth flow (Appstore or website);
  - AUP and DPP compliance.
- **Listing form** (https://developer-docs.amazon.com/sp-api/docs/onboarding-step-10-list-your-application):
  - category, short description (200 characters max), detailed description, features, target audience, support contact;
  - pricing model;
  - logo (at least 300x300) and at least 3 screenshots;
  - no PII, customer quotes, Amazon trademarks, or claims like "best" or "only".
- **Timeline (Amazon's pages disagree):**
  - "After you submit your listing, Amazon reviews it within three to four weeks." https://developer-docs.amazon.com/sp-api/docs/onboarding-step-10-list-your-application
  - "If your app is approved … publish your app … in three to four weeks." https://developer-docs.amazon.com/sp-api/docs/list-your-app-on-the-selling-partner-appstore
  - "If your app is not published after 12 business days, contact … Developer Support." https://developer-docs.amazon.com/sp-api/docs/check-the-status-of-your-listing
  - Plan for about 3 to 4 weeks.
- **Listing statuses:** Draft, Submitted, Ready for Publishing, Published.
- **Ongoing compliance.** Amazon "conducts periodic Data Security Assessments"; non-compliant apps are suppressed. https://developer-docs.amazon.com/sp-api/docs/check-the-status-of-your-listing

### 1.7 Fees
- **History.** Amazon announced (Nov 2025) a third-party developer annual fee and GET-call usage fees.
- **Now cancelled.** Amazon's developer site now carries "Cancellation of Third-Party Developer Selling Partner API (SP-API) Fees": "we have decided that we will not move forward with the SP-API usage and annual fees at this time." https://developer.amazonservices.com/announcement-new-tier-advanced-solution-provider-portal
- **Date of the cancellation:** the page shows none. Third-party reports say May 12, 2026, but that date is **UNVERIFIED** from an Amazon source.
- **What remains in SPP.** SPP still asks for a payment method and shows a GET-call usage summary. https://developer-docs.amazon.com/sp-api/docs/spp-faq
- **Whether any fee applies today: UNVERIFIED (assume none, re-check before launch).**

---

## 2. Authorization (LWA OAuth)

### 2.1 Website authorization workflow
Source for this whole section: https://developer-docs.amazon.com/sp-api/docs/website-authorization-workflow

- **Consent URL.** Build it as `{Seller Central URL for the store}/apps/authorize/consent?application_id={appId}&state={csrfToken}`.
  - Add `&version=beta` to authorize the **Draft** app.
  - Example: `https://sellercentral.amazon.com/apps/authorize/consent?application_id=amzn1.sellerapps.app.…&state=ourStateToken`
- **Log-in URI.** Amazon may call our registered log-in URI with:
  - `amazon_callback_uri`
  - `amazon_state`
  - `selling_partner_id`
  - `version=beta` for Draft apps
- **Callback.** We then redirect the seller to `amazon_callback_uri` with `amazon_state`, `state`, and optionally `redirect_uri` and `version=beta`.
- **Redirect URI.** Amazon calls our redirect URI with:
  - `state`: must match the value we generated; reject the authorization if it does not.
  - `selling_partner_id`
  - `spapi_oauth_code`
- **Security requirements:**
  - set `Referrer-Policy: no-referrer`;
  - use a unique state per request;
  - use the regional Seller Central URL.
- **Timing:**
  - `spapi_oauth_code` **expires after five minutes**;
  - the whole flow breaks if it takes longer than 10 minutes.

### 2.2 Token endpoint and lifetimes
- **Code exchange.** `POST https://api.amazon.com/auth/o2/token` (form-encoded) with `grant_type=authorization_code`, `code`, `redirect_uri`, `client_id`, `client_secret`. The response contains `access_token`, `token_type=bearer`, `expires_in` (typically 3600) and `refresh_token`. https://developer-docs.amazon.com/sp-api/docs/website-authorization-workflow
- **Runtime refresh.** At runtime use `grant_type=refresh_token` with `refresh_token`, `client_id` and `client_secret`. https://developer-docs.amazon.com/sp-api/docs/website-authorization-workflow
- **Access token:**
  - "expires one hour after it is issued";
  - max size 2048 bytes;
  - grantless calls use `grant_type=client_credentials` with `scope=sellingpartnerapi::notifications` instead.
  - Source: https://developer-docs.amazon.com/sp-api/docs/connecting-to-the-selling-partner-api
- **Refresh token:**
  - long-lived;
  - the seller must re-authorize "every 365 days" and whenever a role is added;
  - Amazon emails a reminder 30 days before expiry.
  - Sources: https://developer-docs.amazon.com/sp-api/docs/reauthorize-applications , https://developer-docs.amazon.com/sp-api/docs/authorize-public-applications
- **Deactivation nuance.** The authorizations FAQ says Amazon deactivates only authorizations that were not renewed in over 365 days **and** had zero API calls in that time. https://developer-docs.amazon.com/sp-api/docs/seller-authorizations-faq
  - The two pages differ in emphasis. Treat the 365-day reauthorization as required, and build the reauthorization flow.

### 2.3 Request shape, and is SigV4 still required? No.
- **Required headers** (https://developer-docs.amazon.com/sp-api/docs/connecting-to-the-selling-partner-api):
  - `host`
  - `x-amz-access-token: <LWA access token>`
  - `x-amz-date`
  - `user-agent`: mandatory, max 500 characters, including app name, version and language
- **No signing.** The page shows an example call "with a URI and headers but no signing information".
- **Official announcement** (Amazon's `amzn/selling-partner-api-models` GitHub): "Starting October 2, 2023, SP-API no longer requires the use of AWS Identity and Access Management" (IAM).
  - Requests that still carry SigV4: "we'll disregard the signature and proceed with LWA authorization."
  - Source: https://github.com/amzn/selling-partner-api-models/discussions/3701
- **Changelog entry gone.** The matching changelog page (`https://developer-docs.amazon.com/sp-api/changelog/sp-api-will-no-longer-require-aws-iam-or-aws-signature-version-4`) now returns "Page Not Found".
- **Current state:** LWA access token only, no AWS IAM user or role, no SigV4.
- **Where AWS is still used:** for notification destinations (SQS or EventBridge); see §6.
- **Regional endpoints** (https://developer-docs.amazon.com/sp-api/docs/sp-api-endpoints):

  | Region | Endpoint | Stores |
  |---|---|---|
  | NA | `https://sellingpartnerapi-na.amazon.com` | US, CA, MX, BR |
  | EU | `https://sellingpartnerapi-eu.amazon.com` | EU, UK, IN, and others |
  | FE | `https://sellingpartnerapi-fe.amazon.com` | JP, AU, SG |

---

## 3. Listings Items API (current version 2021-08-01)
- **Version.** The current version is **v2021-08-01**; v2020-09-01 is legacy.
- **Sandbox:** "Static".
- **Availability:** sellers and vendors.
- Source: https://developer-docs.amazon.com/sp-api/docs/listings-items-api

### 3.1 getListingsItem
- **Path:** `GET /listings/2021-08-01/items/{sellerId}/{sku}?marketplaceIds=…&includedData=…&issueLocale=…`. https://developer-docs.amazon.com/sp-api/reference/getlistingsitem
- **Marketplaces.** Up to **12** `marketplaceIds` in the same region per request (sellers only). https://developer-docs.amazon.com/sp-api/docs/retrieve-details-about-a-listing
- **`includedData` values** (default `summaries`) (https://developer-docs.amazon.com/sp-api/reference/getlistingsitem):
  - `summaries`
  - `attributes`
  - `issues`
  - `offers`
  - `fulfillmentAvailability`
  - `procurement` (vendor)
  - `relationships`
  - `productTypes`
- **`summaries[]` fields** (https://developer-docs.amazon.com/sp-api/reference/getlistingsitem):
  - `marketplaceId`, `asin`, `productType`, `conditionType`, `fnSku`, `itemName`, `createdDate`, `lastUpdatedDate`, `mainImage`
  - `status[]`, with enum `BUYABLE` ("can be purchased by shoppers") and `DISCOVERABLE` ("visible to shoppers")
  - When a value is absent, that state does not apply. For example, no `BUYABLE` means not buyable. https://developer-docs.amazon.com/sp-api/docs/notification-type-values
- **`issues[]` fields** (https://developer-docs.amazon.com/sp-api/reference/getlistingsitem):
  - `code` (required)
  - `message` (required)
  - `severity` (required): `ERROR`, `WARNING` or `INFO`
  - `attributeNames[]`
  - `categories[]` (required), which can include: `INVALID_ATTRIBUTE`, `MISSING_ATTRIBUTE`, `INVALID_IMAGE`, `MISSING_IMAGE`, `INVALID_PRICE`, `MISSING_PRICE`, `DUPLICATE`, `QUALIFICATION_REQUIRED`, `PRODUCT`, `LISTING`
  - `enforcements`:
    - `actions[].action`, one of:
      - `LISTING_SUPPRESSED`: takes down buyability
      - `ATTRIBUTE_SUPPRESSED`
      - `CATALOG_ITEM_REMOVED`: all offers on the ASIN become non-buyable
      - `SEARCH_SUPPRESSED`
    - `exemption.status`: `EXEMPT`, `EXEMPT_UNTIL_EXPIRY_DATE` or `NOT_EXEMPT`, plus `expiryDate`
  - `marketplaceIds[]`
  - Example issue `18027`, main image has text or a logo, which is `ERROR`, `INVALID_IMAGE`, `SEARCH_SUPPRESSED`: https://developer-docs.amazon.com/sp-api/docs/retrieve-details-about-a-listing
- **`fulfillmentAvailability[]`:** `{fulfillmentChannelCode, quantity (integer ≥ 0)}`. https://developer-docs.amazon.com/sp-api/reference/getlistingsitem
- **`offers[]`:** `{marketplaceId, offerType B2C|B2B, price, points, audience}`. https://developer-docs.amazon.com/sp-api/reference/getlistingsitem
- **Attributes vs live data.** `attributes` shows the **latest data the seller submitted**. `fulfillmentAvailability` shows **live** data.
  - Example: if the seller submitted 1 and the unit sold, `attributes` still shows 1 while `fulfillmentAvailability` shows 0.
  - Amazon calls the latter the "source of truth for actual inventory levels".
  - Sources: https://developer-docs.amazon.com/sp-api/docs/listings-items-api , https://developer-docs.amazon.com/sp-api/docs/understanding-amazon-listing-status-and-seller-fulfilled-inventory-management
- **Coverage gap.** Not every listing problem has a defined issue: "this notification does not necessarily represent all problems with a listing (neither does the Selling Partner API for Listings Items)". https://developer-docs.amazon.com/sp-api/docs/notification-type-values

### 3.2 searchListingsItems (available)
- **Path:** `GET /listings/2021-08-01/items/{sellerId}?marketplaceIds=…`. https://developer-docs.amazon.com/sp-api/reference/searchlistingsitems
- **Filters:**
  - `identifiers` (max 20) with `identifiersType`: ASIN, EAN, FNSKU, GTIN, ISBN, JAN, MINSAN, SKU or UPC
  - `variationParentSku`, `packageHierarchySku`
  - `createdAfter` / `createdBefore`, `lastUpdatedAfter` / `lastUpdatedBefore`
  - **`withIssueSeverity`**: `WARNING` and/or `ERROR`
  - **`withStatus`** / **`withoutStatus`**: `BUYABLE` or `DISCOVERABLE`
  - `sortBy`: sku, createdDate or lastUpdatedDate; `sortOrder`
  - `pageSize`: max 20, default 10
  - `pageToken`
  - `includedData`: same set as getListingsItem
- **Example.** Discoverable but not buyable: `withoutStatus=BUYABLE&withStatus=DISCOVERABLE`. https://developer-docs.amazon.com/sp-api/docs/understanding-amazon-listing-status-and-seller-fulfilled-inventory-management
- **Limits** (https://developer-docs.amazon.com/sp-api/docs/search-for-listings-items-by-id):
  - **at most 1,000 results** can be paged through;
  - a `pageToken` expires after 24 hours and is bound to the original query parameters.
- **Consequence:** use reports for full catalogs (§5).

### 3.3 patchListingsItem
- **Path:** `PATCH /listings/2021-08-01/items/{sellerId}/{sku}?marketplaceIds=…&includedData=identifiers,issues&mode=VALIDATION_PREVIEW&issueLocale=…`. https://developer-docs.amazon.com/sp-api/reference/patchlistingsitem
- **Body:** `{ "productType": "...", "patches": [ { "op": "add"|"replace"|"merge"|"delete", "path": "/attributes/<name>", "value": [ ... ] } ] }`.
  - "Only top-level listings item attributes can be patched." https://developer-docs.amazon.com/sp-api/reference/patchlistingsitem
  - `productType: "PRODUCT"` is accepted for offer-only partial updates. https://developer-docs.amazon.com/sp-api/docs/listings-items-api
- **MFN quantity.** Use `op: "merge"` on `/attributes/fulfillment_availability`, giving the selector `fulfillment_channel_code` and a new `quantity`. Other fields such as `restock_date` and `lead_time_to_ship_max_days` stay unchanged. https://developer-docs.amazon.com/sp-api/docs/merge-a-listing
- **Fulfillment channel codes** (https://developer-docs.amazon.com/sp-api/docs/manage-amazon-haul-advanced-multiple-offer-multiple-fulfillment-use-cases):

  | Code | Meaning |
  |---|---|
  | `DEFAULT` | MFN, seller-fulfilled |
  | `AMAZON_NA` / `AMAZON_EU` / `AMAZON_JP` | FBA |

  - The values available for a given seller come from the Product Type Definitions API with `sellerId`.
  - When both MFN and FBA are enabled, FBA inventory is used first.
- **Price and offer.** Use `op: "merge"` (or `replace`) on `/attributes/purchasable_offer`, with selectors `marketplace_id`, `currency` and `audience`. https://developer-docs.amazon.com/sp-api/docs/manage-purchasable-offer
  - Sub-attributes include `our_price`, `start_at`, `end_at` (a past date soft-closes the offer), `discounted_price`, and `minimum_seller_allowed_price` / `maximum_seller_allowed_price`.
  - `our_price` cannot be set to null.
- **Response** (`ListingsItemSubmissionResponse`) (https://developer-docs.amazon.com/sp-api/reference/patchlistingsitem):
  - `sku`
  - `submissionId` (required)
  - `status`, one of:
    - `ACCEPTED`: accepted for processing
    - `INVALID`: not accepted
    - `VALID`: only returned in `VALIDATION_PREVIEW`
  - `issues[]`
  - `identifiers`
- **`VALIDATION_PREVIEW`** "validate[s] without persisting to the selling partner's catalog" and "synchronously performs the same checks that are done on production submissions". https://developer-docs.amazon.com/sp-api/reference/patchlistingsitem , https://developer-docs.amazon.com/sp-api/docs/listings-apis-faq
  - "This mode has lower rate limits and is intended for testing a small number of listings. It is not designed for production workflows." https://developer-docs.amazon.com/sp-api/docs/manage-listings-issues
  - It also surfaces pricing issues `100708` (WARNING), `19038`, `19037` and `18701` (ERROR). Same page.
  - **Error codes differ from production.** Error codes returned in preview are being renumbered; do not hard-code them. Same page.
- **Asynchronous processing:**
  - "Accepted does not mean the process is complete." Downstream processes can raise **asynchronous** issues after `ACCEPTED`. https://developer-docs.amazon.com/sp-api/docs/manage-listings-issues
  - The patch response does not include issues raised after acceptance. `getListingsItem` does. https://developer-docs.amazon.com/sp-api/docs/listings-items-api
- **When changes become visible** (https://developer-docs.amazon.com/sp-api/docs/listings-apis-faq):
  - `getListingsItem` reflects changes "faster (within 1-5 minutes)".
  - `LISTINGS_ITEM_*` notifications can lag: "a 15-20 minute delay … is normal" because the backend updates every 15 minutes.
- **No published guaranteed end-to-end SLA** for a patch to become live on the detail page: **UNVERIFIED**.

### 3.4 Bulk alternative
- **`JSON_LISTINGS_FEED`** (Feeds API) is the bulk equivalent: up to 25,000 messages per feed, 5 feeds every 5 minutes. The suggested minimum feed is about 1,500 items; below that, the Listings Items API is faster. https://developer-docs.amazon.com/sp-api/docs/building-listings-management-workflows-guide , https://developer-docs.amazon.com/sp-api/docs/listings-apis-faq
- **Legacy flat-file feeds removed.** Including `POST_FLAT_FILE_INVLOADER_DATA` and `POST_INVENTORY_AVAILABILITY_DATA`, they were removed on Dec 3, 2025. https://developer-docs.amazon.com/sp-api/docs/sp-api-deprecations

---

## 4. Inventory: who is authoritative

### 4.1 FBA (Amazon-authoritative)
- **Operation.** `GET /fba/inventory/v1/summaries` (getInventorySummaries). https://developer-docs.amazon.com/sp-api/reference/getinventorysummaries
- **Parameters:**
  - `granularityType=Marketplace` (the only value)
  - `granularityId={marketplaceId}`
  - `marketplaceIds` (exactly 1)
  - `details=true`
  - `sellerSkus` (up to 50) or `sellerSku`
  - `startDateTime`: changes since; at most 18 months back; inbound-quantity changes are not detected
  - `nextToken`: **expires 30 seconds** after creation
- **Fields** (`InventorySummary`): `asin`, `fnSku`, `sellerSku`, `condition`, `lastUpdatedTime`, `productName`, `totalQuantity`, `stores`, and `inventoryDetails`:
  - `fulfillableQuantity`
  - `inboundWorkingQuantity`, `inboundShippedQuantity`, `inboundReceivingQuantity`
  - `reservedQuantity`: total, pendingCustomerOrder, pendingTransshipment, fcProcessing
  - `researchingQuantity`
  - `unfulfillableQuantity`: total, customerDamaged, warehouseDamaged, distributorDamaged, carrierDamaged, defective, expired
  - Source: https://developer-docs.amazon.com/sp-api/reference/getinventorysummaries
- **Scope.** The API tracks "real-time availability of your inventory in Amazon's fulfillment network at the marketplace level"; "available in all marketplaces". https://developer-docs.amazon.com/sp-api/docs/fba-inventory-api
- **Stranded inventory is not a field here.** Use the report `GET_STRANDED_INVENTORY_UI_DATA`, which has `primary-action`, `date-stranded`, `stranded-reason`, `fulfillable-qty`, `unfulfillable-qty`, and more, "updated in near real-time". https://developer-docs.amazon.com/sp-api/docs/report-type-values-fba

### 4.2 MFN (seller-authoritative)
- **How quantity is set.** MFN quantity is whatever the seller submitted in `fulfillment_availability` for `DEFAULT` (or a Supply Source code), minus orders. "When a customer places an order, Amazon decrements … When the available quantity reaches zero, customers can no longer place orders … Selling partners typically update Amazon with the exact number of units available in their stock." https://developer-docs.amazon.com/sp-api/docs/notification-type-values
- **Physical stock is outside Amazon.** Amazon's number for MFN is only what the seller told Amazon minus sales. It is **not** a measurement of physical stock.
  - Our app must take MFN physical stock from an authoritative source the seller configures (their WMS, ERP, or another channel's inventory system).
  - It must **never** infer or guess a quantity to write to Amazon.
  - If no such source is configured, the correct action is to flag the issue for human review, not to write a number.
  - (This is a product rule we derive from the docs above, not an Amazon statement.)
- **Multi-location inventory.** For sellers using it (Supply Sources API), quantities are per supply-source `fulfillment_channel_code`, and `DEFAULT` must be set to 0. https://developer-docs.amazon.com/sp-api/docs/mli-integration-guide
- **Can FBA quantity be set through the API? (Inference)** `fulfillment_availability` cannot set FBA quantity. The docs show `AMAZON_NA` records with no quantity, and FBA quantities come from the fulfillment network. https://developer-docs.amazon.com/sp-api/docs/manage-amazon-haul-advanced-multiple-offer-multiple-fulfillment-use-cases
- **No explicit "FBA quantity cannot be patched" statement was found: UNVERIFIED.**

---

## 5. Reports (bulk reads)
- **Flow** (https://developer-docs.amazon.com/sp-api/docs/request-a-report , https://developer-docs.amazon.com/sp-api/docs/verify-that-report-processing-is-complete , https://developer-docs.amazon.com/sp-api/docs/retrieve-a-report):
  1. `POST /reports/2021-06-30/reports` with `{reportType, marketplaceIds, reportOptions?}`. Returns `reportId`.
  2. Poll `GET /reports/2021-06-30/reports/{reportId}` until `processingStatus` is `DONE`, `CANCELLED` or `FATAL`. `IN_QUEUE` and `IN_PROGRESS` mean keep polling. Alternatively, subscribe to `REPORT_PROCESSING_FINISHED`.
  3. `GET /reports/2021-06-30/documents/{reportDocumentId}` returns a pre-signed `url` (**expires after five minutes**) and an optional `compressionAlgorithm`.
  4. Download the file and keep it encrypted at rest. Amazon: "Unencrypted report content must never be stored on disk, even temporarily".
- **Report types** (https://developer-docs.amazon.com/sp-api/docs/report-type-values-inventory):

  | Report type | Contents | Request mode | Notable columns |
  |---|---|---|---|
  | `GET_MERCHANT_LISTINGS_ALL_DATA` | All listings: active, inactive and suppressed | Request-only; one store per report | `seller-sku`, `asin1`, `price`, `quantity`, `fulfillment-channel`, `status`, `pending-quantity`, `open-date`; tab-delimited with a UTF-8 BOM |
  | `GET_MERCHANT_LISTINGS_INACTIVE_DATA` | Zero quantity, blocked, suppressed, not-yet-open, and past-end-date listings | Request-only | — |
  | `GET_MERCHANTS_LISTINGS_FYP_REPORT` (Suppressed Listings Report) | Suppressed listings with "the reason each listing is suppressed, and instructions for removing each suppression" | Requestable or schedulable | `Status`, `Reason`, `SKU`, `ASIN`, `Status Change Date`, `Issue Description` |

- **FBA report types** (https://developer-docs.amazon.com/sp-api/docs/report-type-values-fba):
  - `GET_FBA_MYI_UNSUPPRESSED_INVENTORY_DATA`: `mfn-fulfillable-quantity`, `afn-fulfillable-quantity`, `afn-unsellable-quantity`, `afn-reserved-quantity`, `afn-researching-quantity`, and more; "near real-time".
  - `GET_STRANDED_INVENTORY_UI_DATA`.
  - `GET_STRANDED_INVENTORY_LOADER_DATA` is meant to be fixed via `POST_FLAT_FILE_INVLOADER_DATA`. That feed was removed on 2025-12-03 (https://developer-docs.amazon.com/sp-api/docs/sp-api-deprecations), so do not plan on the loader path.
- **Latency and freshness:**
  - "Inventory reports are not near real-time. The SLA for stock data freshness is 3 hours. For subsequent report calls from the same merchant account, data is 1 to 6 hours old, depending on inventory size." https://developer-docs.amazon.com/sp-api/docs/understanding-amazon-listing-status-and-seller-fulfilled-inventory-management
  - Reports are cached for "between one and six hours depending on the number of entries". https://developer-docs.amazon.com/sp-api/docs/report-type-values-inventory
  - Generation time depends on size and load. https://developer-docs.amazon.com/sp-api/docs/reports-faq
  - Some FBA reports can only be requested once per period; extra requests are `CANCELLED`. https://developer-docs.amazon.com/sp-api/docs/reports-faq
- **Report retention.** `getReport` only serves reports created in the last 90 days. https://developer-docs.amazon.com/sp-api/docs/verify-that-report-processing-is-complete

---

## 6. Notifications API (v1)
- **Model.** A destination is created once per app. That call is **grantless**: it uses an LWA `client_credentials` token with `scope=sellingpartnerapi::notifications`. https://developer-docs.amazon.com/sp-api/docs/grantless-operations , https://developer-docs.amazon.com/sp-api/docs/connecting-to-the-selling-partner-api
- **Per-seller subscriptions.** `createSubscription` is **not** grantless. It is called with each seller's own access token and needs the role tied to the notification type. "The selling partner is the party who authorizes an application to call the Notifications API on their behalf for the purpose of creating and managing notification subscriptions." https://developer-docs.amazon.com/sp-api/docs/notifications-api , https://developer-docs.amazon.com/sp-api/docs/notification-type-values
  - So **yes, a public app receives notifications per authorized seller**, through one destination.
  - Payloads carry `SellerId` and `NotificationMetadata.ApplicationId` / `SubscriptionId` / `NotificationId`.
- **`createSubscription`.** `POST /notifications/v1/subscriptions/{notificationType}` with body `{payloadVersion, destinationId, processingDirective?}`; returns 409 on conflict. https://developer-docs.amazon.com/sp-api/reference/createsubscription
- **`createDestination`.** `POST /notifications/v1/destinations` with body `{name, resourceSpecification: {sqs: {arn}} | {eventBridge: {accountId, region}}}`. https://developer-docs.amazon.com/sp-api/reference/createdestination
- **Destination type depends on the notification type** (https://developer-docs.amazon.com/sp-api/docs/set-up-notifications-with-amazon-eventbridge , https://developer-docs.amazon.com/sp-api/docs/set-up-notifications-with-amazon-sqs):
  - **EventBridge** carries `LISTINGS_ITEM_STATUS_CHANGE`, `LISTINGS_ITEM_ISSUES_CHANGE`, `LISTINGS_ITEM_MFN_QUANTITY_CHANGE`, `PRODUCT_TYPE_DEFINITIONS_CHANGE`, `BRANDED_ITEM_CONTENT_CHANGE`, `ITEM_PRODUCT_TYPE_CHANGE`, `SHIPMENT_TRACKING_MILESTONE_CHANGED`.
    - "You can only create one EventBridge destination per AWS account."
    - Setup: associate the partner event source `aws.partner/sellingpartnerapi.amazon/…` with an event bus, then add rules.
  - **SQS** carries all other types, including `FBA_INVENTORY_AVAILABILITY_CHANGES` and `REPORT_PROCESSING_FINISHED`.
    - Standard queues only; **FIFO is not supported**.
    - Delivery is at-least-once and unordered; deduplicate on `notificationId`.
    - The queue policy must allow SP-API to write; with SSE, grant KMS to `arn:aws:iam::437568002678:root`.
- **Relevant types** (https://developer-docs.amazon.com/sp-api/docs/notification-type-values):

  | Type | Who can subscribe | Payload | Destination | Role |
  |---|---|---|---|---|
  | `LISTINGS_ITEM_ISSUES_CHANGE` | Sellers and vendors | Use **`2023-12-13`** (`SellerId`, `MarketplaceId`, `Asin`, `Sku`, `Severities[]` = `ERROR` / `WARNING` / `NONE`, `EnforcementActions[]`). Payload 1.0 removal date is **August 26, 2026** (https://developer-docs.amazon.com/sp-api/docs/sp-api-deprecations) | EventBridge | Product Listing |
  | `LISTINGS_ITEM_STATUS_CHANGE` | Sellers | 1.0 (`SellerId`, `MarketplaceId`, `Asin`, `Sku`, `CreatedDate`, `Status[]` = `BUYABLE` / `DISCOVERABLE` / `DELETED`). Fires on create, delete, and buyability change | EventBridge | Product Listing |
  | `LISTINGS_ITEM_MFN_QUANTITY_CHANGE` | Sellers | 1.0 (`SellerId`, `FulfillmentChannelCode`, `Sku`, `Quantity`) | EventBridge | Product Listing |
  | `FBA_INVENTORY_AVAILABILITY_CHANGES` | Sellers | 1.0 (`SellerId`, `FNSKU`, `ASIN`, `SKU`, `FulfillmentInventoryByMarketplace[]` with `Fulfillable`, `Unfulfillable`, `Researching`, `InboundQuantityBreakdown`, `ReservedQuantityBreakdown`, `FutureSupplyBuyable`, `PendingCustomerOrderInTransit`). Supports CEL `filterExpression` | SQS | Amazon Fulfillment |
  | `ITEM_INVENTORY_EVENT_CHANGE` | Sellers and vendors | Hourly, ASIN-level `highlyAvailableInventory` in Amazon fulfillment centers | SQS | **Brand Analytics** |
  | `REPORT_PROCESSING_FINISHED` | — | Report-completion signal | SQS | Any of several, including Product Listing (https://developer-docs.amazon.com/sp-api/docs/role-mappings-for-types) |

- **Do not use `ITEM_INVENTORY_EVENT_CHANGE`.** It needs an extra role and is ASIN-level, not SKU-level. `FBA_INVENTORY_AVAILABILITY_CHANGES` is the better fit.
- **Backup polling.** "We recommend that you have a means to retrieve needed information in the event of an unexpected outage or delay in notification delivery." https://developer-docs.amazon.com/sp-api/docs/notifications-api

---

## 7. Rate limits and throttling
- **Algorithm.** A token bucket (rate plus burst) per **selling-partner and application pair** for most operations; per application for grantless operations. Getting more authorizations does not reduce per-seller throughput. https://developer-docs.amazon.com/sp-api/docs/usage-plans-and-rate-limits
- **Throttling** returns **HTTP 429**. It is retryable; use exponential backoff. https://developer-docs.amazon.com/sp-api/docs/usage-plans-and-rate-limits , https://developer-docs.amazon.com/sp-api/docs/resolve-common-http-and-authorization-error-codes
- **`x-amzn-RateLimit-Limit`:**
  - best effort; returned on 20x, 400 and 404 responses;
  - absent on unauthorized requests;
  - shows only the account-application limit;
  - do not depend on it.
  - Source: https://developer-docs.amazon.com/sp-api/docs/usage-plans-and-rate-limits
- **`x-amzn-RequestId`:** quote it in support cases. https://developer-docs.amazon.com/sp-api/docs/response-format
- **Defaults (requests per second / burst):**

  | Operation | Rate | Burst | Source |
  |---|---|---|---|
  | getListingsItem | 5 per account-app pair, 100 per app | 5 (reference page says 10) | https://developer-docs.amazon.com/sp-api/docs/listings-items-api-rate-limits , https://developer-docs.amazon.com/sp-api/reference/getlistingsitem |
  | searchListingsItems | 5 per pair, 100 per app | 5 | listings rate-limits page |
  | patchListingsItem | 5 per pair, 500 per app; product-data or relationship attributes 100 per app; **validation previews 20 per app** | 5 | listings rate-limits page |
  | getInventorySummaries | 2 | 2 | https://developer-docs.amazon.com/sp-api/reference/getinventorysummaries |
  | createReport | 0.0167 | 15 | https://developer-docs.amazon.com/sp-api/reference/createreport |
  | getReport | 2 | 15 | https://developer-docs.amazon.com/sp-api/reference/getreport |
  | getReportDocument | 0.0167 | 15 | https://developer-docs.amazon.com/sp-api/reference/getreportdocument |
  | createSubscription / createDestination | 1 | 5 | https://developer-docs.amazon.com/sp-api/reference/createsubscription , https://developer-docs.amazon.com/sp-api/reference/createdestination |
  | getMarketplaceParticipations | 0.016 | 15 | https://developer-docs.amazon.com/sp-api/reference/getmarketplaceparticipations |
  | getDefinitionsProductType | 5 (default; seller-specific plans variable) | 10 | https://developer-docs.amazon.com/sp-api/reference/getdefinitionsproducttype |

- **getListingsItem burst.** The rate-limits page says 5 and the reference page says 10. Code for 5.
- **Listings-specific 429 messages** distinguish application, relationship and product-data limits. https://developer-docs.amazon.com/sp-api/docs/listings-items-api-rate-limits

---

## 8. Problems detectable with Amazon data alone

| # | Problem | Evidence needed (all from SP-API) | Safe API correction? |
|---|---|---|---|
| A | **Listing issue with severity `ERROR`** | `getListingsItem?includedData=issues,summaries` returns `issues[]` with `severity=ERROR`, plus `categories`, `attributeNames`, `enforcements.actions`. Triggered by `LISTINGS_ITEM_ISSUES_CHANGE` with `Severities` containing `ERROR`. Bulk: `searchListingsItems?withIssueSeverity=ERROR` (max 1,000), or the suppressed-listings report for `Reason` and `Issue Description`. | **Sometimes.** Only for `INVALID_ATTRIBUTE` / `MISSING_ATTRIBUTE` / `INVALID_PRICE` / `MISSING_PRICE` where `attributeNames` points at a single attribute **and** the correct value comes from an authoritative seller source or the seller's approval. Validate first with `VALIDATION_PREVIEW`, then patch, then re-read. **Not safe to automate:** `QUALIFICATION_REQUIRED` (needs approval or ungating), `DUPLICATE`, `CATALOG_ITEM_REMOVED`, `INVALID_IMAGE` / `MISSING_IMAGE` (need new media from the seller), and `PRODUCT`-scope issues on ASINs the seller does not own. These need human intervention or Seller Central. Categories: https://developer-docs.amazon.com/sp-api/reference/getlistingsitem ; workflow: https://developer-docs.amazon.com/sp-api/docs/manage-listings-issues |
| B | **Listing not `BUYABLE`** (suppressed or inactive) | `summaries[].status` lacks `BUYABLE` for the marketplace, or `LISTINGS_ITEM_STATUS_CHANGE` with `Status` lacking `BUYABLE`. Then read `issues` (enforcement `LISTING_SUPPRESSED` / `SEARCH_SUPPRESSED`), `fulfillmentAvailability` (quantity 0?) and `offers` (missing offer or price?). Amazon names "a lack of inventory" as a common reason (https://developer-docs.amazon.com/sp-api/docs/retrieve-details-about-a-listing). Inactive reasons include out of stock, past sale period, no offer, blocked by Amazon (https://developer-docs.amazon.com/sp-api/docs/understanding-amazon-listing-status-and-seller-fulfilled-inventory-management). | **Depends on the root cause.** Missing offer, or `end_at` in the past: re-open via `purchasable_offer` merge, only with seller-approved price and dates. Quantity 0: see C. Issue-driven: see A. Blocked or policy suppression (for example pricing-rule violations, "Cancelled/Blocked"): **human**. Amazon's "Open a listing" requires a purchasable offer with price **and** positive fulfillment quantity (same page). |
| C | **MFN offer with quantity 0 while the seller expects it live** | `fulfillmentAvailability[]` with `fulfillmentChannelCode=DEFAULT` (or a supply source) and `quantity=0`; `summaries.status` lacks `BUYABLE`. Event: `LISTINGS_ITEM_MFN_QUANTITY_CHANGE` with `Quantity: 0`. **Plus a non-Amazon record:** the seller-configured authoritative stock source shows units on hand for that SKU, or the seller explicitly confirms a number. | **Yes, only with that external record.** `patchListingsItem` with `op: merge` on `/attributes/fulfillment_availability` `[{fulfillment_channel_code:"DEFAULT", quantity:N}]`, where N comes from the authoritative source and the seller approved it. Then verify with `getListingsItem?includedData=fulfillmentAvailability,summaries,issues` after about 1 to 5 minutes. **Without an authoritative source, never write a quantity:** report it as "needs stock confirmation". Amazon's 0 may be correct (the item sold out). |
| D | **FBA inventory unfulfillable** | `getInventorySummaries?details=true` returns `unfulfillableQuantity.total*` and its breakdown (customer damaged, warehouse damaged, defective, expired, and so on), or `FBA_INVENTORY_AVAILABILITY_CHANGES` `Unfulfillable`. Amazon-authoritative. | **No API correction in scope.** Removal or disposal orders are not covered by the APIs researched here (**UNVERIFIED** whether a public API path exists). Flag for the seller to act in Seller Central. |
| E | **FBA inventory stranded** | `GET_STRANDED_INVENTORY_UI_DATA` with `stranded-reason`, `primary-action`, `date-stranded`, `Date-to-take-auto-removal`, quantities. Cross-check the listing with `getListingsItem` (issues, offers). | **Sometimes.** If the cause is a listing or offer problem (for example no active offer or price), fix it through the Listings Items API (A or B) with seller approval. The flat-file loader fix path is gone (feed removed 2025-12-03). Other reasons: **human**. The full list of `stranded-reason` values is **UNVERIFIED** (Seller Central help not readable). |
| F | **FBA fulfillable 0 but inbound or reserved > 0** (informational) | `inventoryDetails.inbound*`, `reservedQuantity`, `researchingQuantity` | No correction. Inform only. |

**Rules across all corrections:**
- Read before writing.
- Validate with `VALIDATION_PREVIEW` only for low-volume, seller-initiated fixes, because of the 20 req/s app limit and Amazon's "not designed for production workflows" note.
- Patch only the top-level attribute involved.
- Store `submissionId`.
- Treat `ACCEPTED` as "queued", not "done".
- Verify by re-reading `getListingsItem` (1 to 5 minutes) and by the arrival of the matching `LISTINGS_ITEM_*` notification (15 to 20 minutes is normal).
- If new async `ERROR` issues appear, report the correction as failed.
- Sources: https://developer-docs.amazon.com/sp-api/docs/listings-apis-faq , https://developer-docs.amazon.com/sp-api/docs/manage-listings-issues

---

## Implications for our implementation

### Roles to request (all non-restricted; no PII)
- **Product Listing:** Listings Items read and write, listing notifications, suppressed-listings report, `getMarketplaceParticipations`.
- **Inventory and Order Tracking:** all-listings and inactive-listings reports; also an alternative role for Listings Items.
- **Amazon Fulfillment:** FBA Inventory, `FBA_INVENTORY_AVAILABILITY_CHANGES`, stranded and MYI reports.
- **Pricing:** optional, only if we want price-related reports. Note that Product Listing alone already covers `purchasable_offer` patches.
- **Do not request:** Direct-to-Consumer Shipping, Tax, Brand Analytics, or any other restricted role. This keeps us on the standard 1 to 2 week review with no PII architecture review.
- **Request every role up front.** Adding one later forces every seller to re-authorize.

### Recommended call shapes

```http
# Token refresh (per seller)
POST https://api.amazon.com/auth/o2/token
Content-Type: application/x-www-form-urlencoded
grant_type=refresh_token&refresh_token={sellerRefreshToken}&client_id={id}&client_secret={secret}

# Single listing read (detection + verification)
GET https://sellingpartnerapi-na.amazon.com/listings/2021-08-01/items/{sellerId}/{urlEncodedSku}?marketplaceIds=ATVPDKIKX0DER&includedData=summaries,issues,offers,fulfillmentAvailability&issueLocale=en_US
x-amz-access-token: {LWA access token}
user-agent: Deploi/1.0 (Language=TypeScript; Platform=Node)

# Targeted scan (<=1,000 results): listings with ERROR issues
GET https://sellingpartnerapi-na.amazon.com/listings/2021-08-01/items/{sellerId}?marketplaceIds=ATVPDKIKX0DER&withIssueSeverity=ERROR&includedData=summaries,issues&pageSize=20

# Targeted scan: discoverable but not buyable
GET .../listings/2021-08-01/items/{sellerId}?marketplaceIds=ATVPDKIKX0DER&withStatus=DISCOVERABLE&withoutStatus=BUYABLE&includedData=summaries,issues,fulfillmentAvailability,offers&pageSize=20

# Full catalog baseline (bulk)
POST https://sellingpartnerapi-na.amazon.com/reports/2021-06-30/reports
{"reportType":"GET_MERCHANT_LISTINGS_ALL_DATA","marketplaceIds":["ATVPDKIKX0DER"]}
# also: GET_MERCHANTS_LISTINGS_FYP_REPORT, GET_STRANDED_INVENTORY_UI_DATA (FBA sellers)
GET .../reports/2021-06-30/reports/{reportId}            # until DONE|CANCELLED|FATAL
GET .../reports/2021-06-30/documents/{reportDocumentId}  # url valid 5 minutes

# FBA inventory
GET https://sellingpartnerapi-na.amazon.com/fba/inventory/v1/summaries?granularityType=Marketplace&granularityId=ATVPDKIKX0DER&marketplaceIds=ATVPDKIKX0DER&details=true&sellerSkus=SKU1,SKU2

# Correction step 1 - validate only (low volume, seller-initiated)
PATCH https://sellingpartnerapi-na.amazon.com/listings/2021-08-01/items/{sellerId}/{sku}?marketplaceIds=ATVPDKIKX0DER&mode=VALIDATION_PREVIEW&includedData=issues
{"productType":"PRODUCT","patches":[{"op":"merge","path":"/attributes/fulfillment_availability",
  "value":[{"fulfillment_channel_code":"DEFAULT","quantity":12}]}]}
# expect {"status":"VALID", "issues":[...]}; any ERROR -> stop

# Correction step 2 - execute (same body, no mode), only after seller approval
PATCH https://sellingpartnerapi-na.amazon.com/listings/2021-08-01/items/{sellerId}/{sku}?marketplaceIds=ATVPDKIKX0DER&includedData=issues
# expect {"status":"ACCEPTED","submissionId":"...","issues":[]}; persist submissionId

# Correction step 3 - verify (after ~1-5 min, then on notification)
GET .../listings/2021-08-01/items/{sellerId}/{sku}?marketplaceIds=ATVPDKIKX0DER&includedData=summaries,issues,fulfillmentAvailability
# success = fulfillmentAvailability DEFAULT quantity == 12, status includes BUYABLE, no new ERROR issues
```

- **Quantity source.** The `quantity` in the MFN example must come from the seller's configured authoritative stock source and be shown to the seller for approval. It is never computed from Amazon data.
- **Price and offer fixes.** Use `op: "merge"` on `/attributes/purchasable_offer` with `marketplace_id`, `currency` and `audience` selectors.

### Notifications to subscribe (per seller, after authorization)
- **EventBridge destination**, created once, grantless:
  - `LISTINGS_ITEM_ISSUES_CHANGE` (payloadVersion `2023-12-13`)
  - `LISTINGS_ITEM_STATUS_CHANGE` (`1.0`)
  - `LISTINGS_ITEM_MFN_QUANTITY_CHANGE` (`1.0`)
- **SQS standard queue destination:**
  - `FBA_INVENTORY_AVAILABILITY_CHANGES` (`1.0`, FBA sellers)
  - `REPORT_PROCESSING_FINISHED`
- **Infrastructure needed:** an AWS account for these destinations. AWS is not needed for API signing.
- **Notifications are hints.** Always re-read via the API, and keep a periodic report or search reconciliation as backup.

### External approvals and steps that block a live launch
1. **SPP account with identity verification:** documents plus a **live video call**, done by the primary account user.
2. **Developer profile approval (public):**
   - website meeting the guidelines;
   - security-control answers;
   - AUP, DPP and SPP Agreement acceptance;
   - about 1 to 2 weeks for non-restricted roles;
   - questions must be answered within 5 days.
3. **Production app client:** Draft, with roles plus login and redirect URIs registered. While in Draft, end-to-end testing uses `version=beta`.
4. **Draft or unlisted app limits:** at most 25 seller OAuth authorizations (plus 10 self-authorizations). Fine for a pilot, but blocks general availability.
5. **Appstore listing review and publish:** about 3 to 4 weeks per Amazon. Required for unlimited authorizations and, per the registration page, mandatory for public developers.
6. **Seller-side authorization:** each seller must consent in Seller Central, then re-authorize every 365 days and after any role change.
7. **Ongoing:**
   - periodic Amazon Data Security Assessments (apps can be suppressed);
   - SP-API fees: currently cancelled per Amazon's notice. Re-check before launch (**UNVERIFIED** going forward).

### UNVERIFIED / open items
- Exact date of the fee cancellation, and whether any fee applies today.
- A guaranteed SLA for a patch becoming live. Only "within 1-5 minutes" for `getListingsItem` reflection is documented.
- The full enumeration of `stranded-reason` values and of suppression `Reason` values; the Seller Central help pages were not publicly readable.
- An explicit statement that FBA quantities cannot be set via `fulfillment_availability` (inferred).
- A public SP-API path for FBA removal or disposal orders (not researched).
- The getListingsItem burst: 5 on the rate-limits page vs 10 on the reference page.
