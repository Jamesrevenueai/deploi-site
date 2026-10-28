# WooCommerce connector research

Researched on 2026-10-28 for the stock and listing correction connector (detect, propose, get approval, execute, verify).

**Sources and method**

- Primary sources are the official WooCommerce docs on developer.woocommerce.com and woocommerce.com, the old REST reference on woocommerce.github.io, and the WooCommerce source code.
- The old reference now redirects to developer.woocommerce.com. The content was moved without changes ([blog: REST docs moved][blog-docs-moved]).
- Where the docs are thin, I read the WooCommerce source at trunk commit `3ef69407beda276dd278088103752e16a0042948` (2026-10-28). Links to `github.com/.../blob/3ef6940…` point at exact lines in that commit.
- Some statements come only from source code. They are marked **(source)**. They describe current trunk, which is the same as or slightly newer than the current stable release, and should be checked on a test store.
- **UNVERIFIED** means I could not confirm the claim from official material.

Current stable WooCommerce is **11.2.1**: "Requires at least" WP 7.0, PHP 7.4, last updated 2026-10-09 ([wordpress.org plugin API][wporg-api]; [readme.txt stable tag][gh-readme]). Trunk is `11.4.0-dev` ([woocommerce.php][gh-main]). 11.3 is in pre-release ([11.3 pre-release post][blog-113-pre]).

---

## 1. REST API: version, base path, pagination, batch

| Topic | Finding | Source |
|---|---|---|
| Current version | "The current WP REST API integration version is v3". v3 requires WC 3.5+, WP 4.4+ and pretty permalinks. | [REST API intro][dev-rest] |
| Base path | `https://{store}/wp-json/wc/v3/...`. Example: `GET /wp-json/wc/v3/products`. The index `GET /wp-json/wc/v3` needs no auth. | [REST API intro][dev-rest]; [API reference index][dev-v3-index] |
| v4 | `wc/v4` exists in trunk but is **experimental** and needs the `rest-api-v4` feature flag. Breaking changes are expected. Do not target it. | [V4 Products README (source)][gh-v4-readme] |
| Dual API / GraphQL | Experimental. It was removed from core in 11.2 and moved to a separate plugin. Do not use it. | [blog: dual API plugin][blog-dualapi] |
| Pagination default | 10 items. Use `?per_page=`, `?page=` (1-based) and `?offset=`. | [REST API intro – Pagination][dev-rest-pagination] |
| Pagination headers | "The total number of resources and pages are always included in the `X-WP-Total` and `X-WP-TotalPages` HTTP headers." A `Link` header has `next`/`last`/`first`/`prev`. | [REST API intro – Pagination][dev-rest-pagination] |
| `per_page` max | The WC docs do not state a maximum. WordPress REST: "`per_page` is capped at 100 records". The WC CRUD controller schema sets `'minimum' => 1, 'maximum' => 100` **(source)**. | [WP REST pagination][wp-pagination]; [class-wc-rest-crud-controller.php L581-588][gh-crud-perpage] |
| Batch endpoints | `POST /wp-json/wc/v3/products/batch` and `POST /wp-json/wc/v3/products/<product_id>/variations/batch`. Body has `create`/`update`/`delete` arrays. | [Products – Batch][dev-products]; [Variations – Batch][dev-variations] |
| Batch limit | "By default it's limited to up to 100 objects to be created, updated or deleted." The limit is the filter `woocommerce_rest_batch_items_limit` (default 100). Over the limit: `WP_Error woocommerce_rest_request_entity_too_large`, HTTP **413** **(source)**. | [Products – Batch][dev-products]; [class-wc-rest-controller.php L179-201][gh-batch-limit] |
| Batch per-item errors | Each failed item comes back inside the batch response as `{"id":..,"error":{"code","message","data"}}`. The overall request still succeeds, so every item must be checked **(source)**. | [class-wc-rest-controller.php batch_items L209-275][gh-batch-items] |
| Error format | JSON `{code, message, data:{status}}`. Documented statuses: 400, 401, 404, 500. | [REST API intro – Errors][dev-rest-errors] |
| Smaller payloads | The WP global `_fields` parameter limits which fields are returned. WC product responses honour it via `get_fields_for_response` **(source)**. | [WP global parameters – _fields][wp-global-params]; [products controller L2155][gh-prod-fields] |
| Context | The `context` parameter accepts `view` (default) or `edit`. | [Products – List parameters][dev-products] |
| Incremental sync | `/products` accepts `modified_after`, `modified_before` and `dates_are_gmt`. It also accepts `include_status`, `exclude_status`, `include_types`, `stock_status`, `orderby` (incl. `id`, `modified`), `order` and `parent`. `/variations` accepts `stock_status` and `include_status`, but the docs list no `modified_after` for it. | [Products – List][dev-products]; [Variations – List][dev-variations] |

---

## 2. Stock and listing fields

### 2.1 Product properties (`/products`)

All from [Products – Product properties][dev-products], unless noted.

| Field | Type / values | Notes |
|---|---|---|
| `type` | `simple`, `grouped`, `external`, `variable` (default `simple`) | |
| `status` | `draft`, `pending`, `private`, `publish` (default `publish`) | List filters also accept `future`, `trash`, `any`. |
| `catalog_visibility` | `visible`, `catalog`, `search`, `hidden` (default `visible`) | |
| `manage_stock` | boolean, default `false` | REST returns `managing_stock()`. This is `false` whenever the global "Manage stock" option is off, whatever the product meta says **(source)** ([abstract-wc-product.php L1998-2003][gh-managing-stock]; [v2 controller L962-964][gh-v2-fields]). |
| `stock_quantity` | integer | No `minimum` in the schema. The type becomes `number` if `wc_is_stock_amount_integer()` is false **(source)** ([products controller schema L1486-1490][gh-prod-schema]). |
| `stock_status` | `instock`, `outofstock`, `onbackorder` (default `instock`) | |
| `backorders` | `no`, `notify`, `yes` (default `no`) | "If managing stock, this controls if backorders are allowed." |
| `backorders_allowed` | boolean, read-only | `true` when `backorders` is `yes` or `notify` (filterable) **(source)** ([L2010-2012][gh-backorders-allowed]). |
| `backordered` | boolean, read-only | `is_on_backorder()`: `stock_status == onbackorder`, OR managing stock + backorders allowed + qty < 0 **(source)** ([L2029-2035][gh-is-on-backorder]). |
| `low_stock_amount` | integer or null | **Not in the docs' property table.** It appears only in an example response ([Products – Duplicate example][dev-products]). It is present in the schema: `'type' => array('integer','null')` **(source)** ([L1517-1521][gh-prod-schema]). |
| `price` | string, read-only | `regular_price` and `sale_price` are writable. |
| `purchasable` | boolean, read-only | Core: `exists && is_viewable && get_price() !== ''` (filterable) **(source)** ([L1890-1899][gh-is-purchasable]). |
| `variations` | array of IDs, read-only | |

The undocumented write parameter `inventory_delta` adds to or subtracts from the current quantity. It is accepted on product and variation updates **(source)** ([products controller L1057-1061][gh-prod-write]; [variations controller L332-336][gh-var-write]). It is **UNVERIFIED** as a supported public contract.

### 2.2 Variation properties (`/products/{id}/variations`)

From [Product variations – properties][dev-variations]:

- `manage_stock`: "boolean, string … Possible values are either a boolean or `parent`. Default is `false`."
- `stock_quantity`, `stock_status`, `backorders`, `backorders_allowed` and `backordered` behave as on products. `status` is `draft`/`pending`/`private`/`publish`.

How `"parent"` works **(source)**:

- When reading in view context, a variation whose own `manage_stock` is false, under a parent that manages stock, reports `manage_stock: "parent"`. Its `stock_quantity` and `backorders` are then the **parent's** values ([class-wc-product-variation.php L390-432][gh-var-getters]).
- The REST variation response always uses view-context getters for stock ([variations controller L149-155][gh-var-response]). `context=edit` does **not** return raw variation stock fields.
- `set_manage_stock()` casts with `wc_string_to_bool`, so writing `"parent"` stores `false` ([abstract-wc-product.php L1159-1161][gh-set-manage-stock]). "parent" is a derived read value. To change backorders for such a variation, you must update the **parent product**.

### 2.3 How `stock_status` is computed when stock is managed

**Docs.** "If a product has stock management enabled, the product's stock status will now be automatically managed. It will naturally go from in stock to out of stock or on backorder as the product's inventory runs out" ([blog: WC 3.3 backorders and stock management][blog-33-stock]). The Out of stock threshold setting: "Enter the inventory count that will trigger the out of stock status" ([Settings > Products > Inventory][wcom-settings-products]).

**Exact rule (source).** `WC_Product::validate_props()` runs on every `save()` ([abstract-wc-product.php L1628-1658][gh-validate-props]):

- If the product does **not** manage stock, it forces `stock_quantity = ''`, `backorders = 'no'` and `low_stock_amount = ''`, then returns.
- Otherwise, with `threshold = abs(woocommerce_notify_no_stock_amount)` (default `0`), the status is:
  - `instock` if `qty > threshold`
  - else `onbackorder` if `backorders != 'no'`
  - else `outofstock`

Consequences:

- **A `stock_status` sent in a write is overwritten** for stock-managed products.
- **Backorders cannot stay on while stock is unmanaged.**
- **Variable parent without product-level stock:** the status is synced from the children. It is `instock` if any child is `instock`, else `onbackorder` if any child is `onbackorder`, else `outofstock` ([class-wc-product-variable.php L561-567][gh-variable-validate]; [variable data store L989-998][gh-variable-sync]).
  - Child statuses are read from the `wc_product_meta_lookup` table, unless that table is being regenerated ([variable data store L811-828][gh-child-status]).
- **Variable parent with product-level stock:** saving it pushes its status to the variations that inherit stock ([L592-595][gh-variable-after-save]; [variable data store L873+][gh-sync-managed]).
- **Threshold changes are not retroactive.** The docs say the threshold "does not affect existing 'in stock' products" (setting description in source: [class-wc-settings-products.php L340-349][gh-settings-inventory]). A product can therefore look "inconsistent" against the current threshold without anything being broken.

### 2.4 Store-level inventory settings

From [Settings > Products > Inventory][wcom-settings-products]; option IDs and defaults from [class-wc-settings-products.php L258-368][gh-settings-inventory] **(source)**:

| Setting (option id) | Default | Meaning |
|---|---|---|
| Manage stock (`woocommerce_manage_stock`) | `yes` | Global switch. When off, REST product writes **ignore** `manage_stock`, `backorders`, `stock_quantity` and `low_stock_amount`, and only `stock_status` is applied **(source)** ([products controller L1026-1081][gh-prod-write]). The variation controller has no such global check ([L316-349][gh-var-write]). |
| Hold stock (`woocommerce_hold_stock_minutes`) | `60` | "Hold products (for unpaid orders) for X minutes … the pending order will be canceled and held stock released … only applies to orders in the 'Pending payment' status, and not orders that are 'On hold'." Held stock lives in a separate `wc_reserved_stock` table, **not** in `stock_quantity` **(source)** ([ReserveStock.php L100-115, L254][gh-reserve-stock]). |
| Low stock threshold (`woocommerce_notify_low_stock_amount`) | `2` | Notification only. It can be overridden per product or variation by `low_stock_amount`. |
| Out of stock threshold (`woocommerce_notify_no_stock_amount`) | `0` | Drives the `outofstock`/`onbackorder` transition (see 2.3). |
| Out of stock visibility (`woocommerce_hide_out_of_stock_items`) | `no` | "Hide out of stock items from the store catalog/customer view." Works even if stock management is off. In code: `is_visible()` returns false when this is `yes` and the product is not in stock **(source)** ([L1871-1883][gh-is-visible]). |

**Reading these via REST.** WC registers every section of each settings page (including `inventory`) as REST settings **(source)** ([class-wc-register-wp-admin-settings.php L142-170][gh-register-settings]; [inventory section id][gh-settings-inventory]). They should therefore be readable at `GET /wp-json/wc/v3/settings/products` or `/settings/products/<option_id>` ([Setting options][dev-setting-options]). The official docs do not list the products-group options. Treat this as **UNVERIFIED** until tested on a real store.

**Behaviour docs from the product editor** ([Product editor settings – Inventory][wcom-product-editor]):

- "Allow, but notify customer": a backorder notice appears on the product page, the block cart and checkout, the order, and emails.
- "Allow": "to customers it appears no different than an in-stock item."
- For variations: "Allow backorders? … if enabled, stock can go below zero" ([Variable products][wcom-variable]).

---

## 3. Writing a correction (`backorders: "no"`)

**Requests**

- Product: `PUT /wp-json/wc/v3/products/<id>` with a JSON body ([Products – Update][dev-products]).
- Variation: `PUT /wp-json/wc/v3/products/<product_id>/variations/<id>` ([Variations – Update][dev-variations]).
- Docs: "Successful requests will return a 200 OK" ([REST API intro][dev-rest]).

**Does the response show the new state?** Yes **(source)**. `update_item()` saves the object, reloads it with `get_object()`, sets `context=edit` and returns the full product or variation ([class-wc-rest-crud-controller.php L161-191, L245-278][gh-crud-update]). The response body therefore shows the state after `validate_props()` ran. That means:

- After `{"backorders":"no"}` on a stock-managed product with `qty <= threshold`, `stock_status` comes back as `outofstock`. Before, it was `onbackorder`.
- If the global "Manage stock" is off, the product controller **silently ignores** `backorders` and still returns 200. The response will show the old value. **Always compare the response to the requested change.**
- For a variation with `manage_stock: "parent"`, write to the parent product. Writing `backorders` on the variation changes its own stored value, but the value shown and used stays the parent's (see 2.2).

**Errors (source unless noted)**

| Case | Response |
|---|---|
| Product ID not found | `woocommerce_rest_product_invalid_id`, HTTP 400 or 404 ([crud controller L245-250][gh-crud-update]; [products controller L158][gh-prod-invalid]) |
| Variation not under that parent | `woocommerce_rest_product_variation_invalid_id`, 404 ([variations v2 controller L214-275][gh-var-perm]) |
| User lacks edit capability | `woocommerce_rest_cannot_edit`, 401/403 ([crud controller L68-76][gh-crud-perm]) |
| Read-only API key used for PUT | `woocommerce_rest_authentication_error` "does not have write permissions", 401 ([class-wc-rest-authentication.php L754-780][gh-auth-perms]) |
| Invalid enum value | Standard WP `rest_invalid_param`, 400. The schema enum for `backorders` is `no`/`notify`/`yes` ([schema L1498-1504][gh-prod-schema]). |

**No optimistic concurrency.** `update_item` does no version or ETag check ([L245-278][gh-crud-update]). The only conditional-request support is the experimental REST response cache's `ETag`/`If-None-Match` on **GET** ([blog: REST API caching][blog-rest-cache]).

---

## 4. Authentication

### 4.1 App authorization endpoint (recommended)

Docs: [Authentication – Auto generating API keys][dev-auth].

- **URL:** `https://{store}/wc-auth/v1/authorize?app_name=…&scope=…&user_id=…&return_url=…&callback_url=…`. All values must be URL-encoded.
- **Parameters** (all mandatory):
  - `app_name`
  - `scope`: `read`, `write` or `read_write`
  - `user_id`: "User ID in your APP … NOT THE USER ID IN WOOCOMMERCE"
  - `return_url`
  - `callback_url`: "should be over HTTPS"
- **Callback body.** WooCommerce POSTs JSON to `callback_url`: `{"key_id":1,"user_id":123,"consumer_key":"ck_…","consumer_secret":"cs_…","key_permissions":"read_write"}`. It is JSON, so in PHP it is not in `$_POST`.
- **Return redirect.** The user is sent back to `return_url?success=1|0&user_id=…`.
- **Enforced in code (source)** ([class-wc-auth.php][gh-auth]):
  - `callback_url` must start with `https://`, or the request fails with "The callback_url needs to be over SSL" ([L159-203][gh-auth-validate]).
  - Approval requires `current_user_can('manage_woocommerce')` ([L390, L413][gh-auth-cap]).
  - The key belongs to the approving WP user, and its description is `"{app_name} - API ({date})"` ([L216-262][gh-auth-keys]).
  - The callback POST uses `wp_safe_remote_post` with a 60s timeout. **It must answer exactly HTTP 200.** Any other code, or a transport error, deletes the key and shows "Access denied" ([L270-288, L415-445][gh-auth-post]).
  - The callback is **not signed**. Use an unguessable one-time `user_id` value as the correlation token, and match it on both the callback and the return redirect.
- The keys get that user's roles and capabilities. "If the WordPress user associated with an API key is deleted, the API key will cease to function." ([Authentication – REST API keys][dev-auth]).
- **Scope enforcement (source)** ([L754-780][gh-auth-perms]):
  - GET/HEAD need `read` or `read_write`.
  - POST/PUT/PATCH/DELETE need `write` or `read_write`.
  - **A `write`-only key cannot GET.** We need `read_write`.

### 4.2 Transport

Docs: [Authentication over HTTPS / HTTP][dev-auth].

- **HTTPS:** HTTP Basic, with consumer key as username and secret as password. If the server drops the `Authorization` header ("Consumer key is missing"), send `?consumer_key=…&consumer_secret=…` as query parameters.
- **Plain HTTP:** OAuth 1.0a "one-legged" is required.
  - Signature: HMAC-SHA1 or HMAC-SHA256.
  - Required parameters: `oauth_consumer_key`, `oauth_timestamp`, `oauth_nonce`, `oauth_signature`, `oauth_signature_method`.
  - Timestamps outside a 15-minute window are rejected. The body is not signed.
- **Basic vs OAuth is decided by `is_ssl()` on the server (source)** ([class-wc-rest-authentication.php L206-220][gh-auth-ssl]). A store behind a TLS-terminating proxy that does not set `is_ssl()` will try OAuth even over HTTPS. This is a known source of 401s. The fix is on the host side, or use the query-string fallback.

### 4.3 WordPress Application Passwords (alternative)

- Since WP 5.6. They are generated per user in wp-admin. They are sent as Basic Auth over `https://` ([WP REST authentication][wp-auth]).
- WC says it is "possible to authenticate using any WP REST API authentication plugin or method" ([Authentication][dev-auth]).
- Trade-off: no WooCommerce read/write scoping (the `check_permissions` scope check above applies to WC keys), and the user has to copy a password by hand. **UNVERIFIED** that every WC endpoint behaves identically under Application Passwords. This is inferred from the docs' general statement. Prefer `/wc-auth/v1/authorize`.

---

## 5. Webhooks

From [Webhooks (REST reference)][dev-webhooks] unless noted.

- **Core topics:** `coupon.*`, `customer.*`, `order.created|updated|deleted`, `product.created|updated|deleted`. Custom `action.<hook>` topics are also allowed. The source additionally defines `*.restored` and `product.published` **(source)** ([class-wc-webhook.php L1054-1088][gh-webhook-topics]).
- **What triggers product topics (source)** ([L1070-1086][gh-webhook-topics]):
  - `product.updated` fires on `woocommerce_update_product` **and** `woocommerce_update_product_variation`, so variation changes produce `product.updated` with the variation as the resource.
  - Stock reductions from orders call `wc_update_product_stock()`, which calls `save()` ([wc-stock-functions.php L30-81, L207][gh-stock-fn]). That fires `woocommerce_update_product` ([product data store L402][gh-ds-update]). So **order-driven stock changes do produce `product.updated`**. Verify this on a test store.
- **Create via API:** `POST /wp-json/wc/v3/webhooks` with `{"name","topic","delivery_url","secret"}`. Statuses are `active`, `paused` and `disabled` ("delivery paused by failure").
  - **Secret default.** The docs disagree with each other: "MD5 hash from the current user's ID" ([REST ref][dev-webhooks]) vs "the current API user's consumer secret" ([woocommerce.com Webhooks][wcom-webhooks]). The REST v3 controller actually uses `wp_generate_password(50)` when no secret is sent **(source)** ([v1 controller L375][gh-webhook-create]). **Always send our own secret.**
  - The response is 201. A ping is then POSTed to the URL ([L388-397][gh-webhook-create]). The ping is form-encoded `webhook_id=<id>` **with no signature header** ([class-wc-webhook.php L678-711][gh-webhook-ping]).
  - Payloads are built as the webhook's owner user, using the REST API version stored on the webhook (`wp_api_v3` for v3-created webhooks) **(source)** ([L460-503][gh-webhook-payload]; [v3 controller][gh-webhook-v3]).
- **Delivery headers (docs):**
  - `X-WC-Webhook-Source` (store home URL)
  - `X-WC-Webhook-Topic`
  - `X-WC-Webhook-Resource`
  - `X-WC-Webhook-Event`
  - `X-WC-Webhook-Signature`: "a base64 encoded HMAC-SHA256 hash of the payload"
  - `X-WC-Webhook-ID`
  - `X-WC-Webhook-Delivery-ID`
- **Signature details (source):** `base64_encode(hash_hmac('sha256', <raw body>, <secret>, true))`. The algorithm can be changed with the `woocommerce_webhook_hash_algorithm` filter ([L514-519][gh-webhook-sig]).
- **Delivery ID (source):** the docs say it is a "delivery log ID (a comment)". The code now sends `wp_hash(id . time)`, a unique hash ([L528-531][gh-webhook-sig]).
- **Delivery mechanics:**
  - Docs: "Delivery is performed using `wp_remote_post()` … processed in the background by default using wp-cron."
  - Source: delivery is queued through Action Scheduler (`WC()->queue()`, group `woocommerce-webhooks`). **A pending delivery for the same webhook and resource is not queued again within 10 minutes** ([wc-webhook-functions.php L15-45][gh-webhook-queue]).
  - Delivery uses `wp_safe_remote_request`, POST, timeout 60s, `redirection => 0` ([class-wc-webhook.php L362-403][gh-webhook-deliver]).
  - The payload is built **when delivered**, not when the event happened. It is "exactly the same as if requested via the REST API".
- **Failures and disabling:**
  - [REST ref][dev-webhooks]: "After 5 consecutive failed deliveries (as defined by a non HTTP 2xx response code), the webhook is disabled and must be edited via the REST API to re-enable."
  - [woocommerce.com][wcom-webhooks]: disabled "after more than five consecutive delivery failures … not a 2xx, 301, or 302". The threshold is the `woocommerce_max_webhook_delivery_failures` filter.
  - Source: success is `200 <= code < 303`. The failure count increments, and the status becomes `disabled` once the stored count is already above 5 ([L607-641][gh-webhook-fail]).
  - **No automatic redelivery of a failed event was found in docs or source.** A failed event is lost.

---

## 6. Known limitations that affect correctness

- **Rate limits.**
  - No rate limit for `wc/v3` is documented.
  - The documented rate limiting is for the **Store API** (a different API). It is optional and off by default: 25 requests / 10 s when enabled, POST only ([Store API rate limiting][dev-store-ratelimit]).
  - Host or WAF limits vary. The docs mention ModSecurity returning 501 for PUT/DELETE, and an `_method` workaround ([REST API intro – common issues][dev-rest-errors]).
  - Specific host limits are **UNVERIFIED**. Design for 429/5xx with backoff and low concurrency per store.
- **Caching.**
  - WC 10.5 added an **experimental, opt-in** REST response cache for `/v3/products`, `/v3/products/<id>`, `/v3/products/<id>/variations[/<id>]`. It is disabled by default.
  - When enabled: object-cache backed, 1-hour default TTL, invalidated when products are updated, and adds `Cache-Control`/`ETag`.
  - `_skip_cache=1` in the query string bypasses it ([blog: REST API caching call for testing][blog-rest-cache]). Whether it has graduated from experimental by 11.2 is **UNVERIFIED**.
  - Product object caching is on by default for new 11.0+ installs. It is request-scoped and non-persistent. However, "extensions that perform direct SQL queries against product data … may produce stale results" ([blog: product object caching][blog-product-cache]).
  - Third-party page caches or CDNs caching `/wp-json/` GETs: **UNVERIFIED** (no official doc found). Always verify with a fresh read that has `_skip_cache=1` and a unique query parameter.
- **HPOS.**
  - Orders are stored in custom tables (`wc_orders`, etc.) by default for new installs since 8.2. A `woocommerce_custom_orders_table_enabled` switch exists, with sync to the posts tables ([HPOS docs][dev-hpos]).
  - HPOS does not change **product** storage. Products use the CPT data store (`wp_posts`/`wp_postmeta` `_stock`, `_stock_status`, …) plus the `wc_product_meta_lookup` table **(source)** ([product data store update_product_stock L1872+][gh-ds-stock]).
  - Use only the REST API for orders. Never assume a table layout.
- **Lookup table drift.** Variable-parent stock status is derived from `wc_product_meta_lookup` ([L811-828][gh-child-status]).
  - If that table is stale, a parent can disagree with its children.
  - Fixing it means an admin runs the System Status tool `regenerate_product_lookup_tables` **(source)** ([system status tools controller L152, L615][gh-ss-tools]).
  - This is a human or admin action, not a per-product correction.
- **Plugins that override stock.**
  - Core getters are filterable in view context, for example `woocommerce_product_get_stock_quantity`, `woocommerce_product_is_in_stock`, `woocommerce_product_backorders_allowed` and `woocommerce_is_purchasable` **(source)** ([abstract-wc-data get_prop L952-962][gh-get-prop]; [L1948-1957, L2010-2012][gh-backorders-allowed]).
  - Multi-location or multi-inventory plugins can therefore make REST report values that differ from stored meta. They can also re-sync stock after our write.
  - How specific plugins behave: **UNVERIFIED**.
  - Mitigation:
    - Read `active_plugins` from `GET /wc/v3/system_status` ([System status][dev-system-status]).
    - For simple products, also read with `context=edit` (raw stored values) and compare with view ([v2 controller L962-981][gh-v2-fields]). This does not work for variations (see 2.2).
    - Re-verify after a delay.
- **Recent stock-semantics changes.**
  - From 11.0, stock is restored when an order moves to `failed` ([blog: failed order stock update][blog-failed-stock]).
  - Held stock for pending orders is not reflected in `stock_quantity` (see 2.4).
  - Oversell checks should therefore treat small negative or near-zero values cautiously.
- **Self-hosted, many versions.**
  - Each store runs its own WC, WP and PHP versions. Read `environment.version`, `wp_version` and `php_version` from `GET /wc/v3/system_status` ([System status][dev-system-status]).
  - Releases ship about every 5 weeks ([blog: release cycle][blog-release-cycle]).
  - Security patches for CVSS >= 9 cover the last **21 major versions**: "If the current stable WooCommerce version is 11.2, that means version 9.2 and newer" ([Security patch support policy][dev-security]).
  - WC 11.6 (planned Feb 2027) will require PHP 8.1 ([blog: PHP 8.1 requirement][blog-php81]).
- **Variations are not returned by `/products`.** They need `/products/{id}/variations` per variable product ([Variations][dev-variations]). This costs at least one extra request per variable product.

---

## 7. Problems detectable with WooCommerce data alone

Definitions used below:

- `T` = `woocommerce_notify_no_stock_amount`, from `/settings/products`, default 0.
- `GMS` = global `woocommerce_manage_stock`.
- "Effective" values for a variation with `manage_stock: "parent"` are the parent's values.

| # | Problem | Evidence required | Could be intentional? | Correction path |
|---|---|---|---|---|
| P1 | **Backorders allowed while managed stock <= 0** | `manage_stock` true (or variation `"parent"`, then use the parent's values); `stock_quantity <= 0` (or `<= T`); `backorders` is `notify` or `yes`; `status=publish`; `stock_status=onbackorder` expected. Also record `catalog_visibility`, and `GMS=yes` (implied when REST shows `manage_stock:true` for a product). | **Yes, often.** Made-to-order, pre-orders, dropship and long-lead items. `notify` is visible to customers (notice on product page, cart, checkout, emails). `yes` is **silent**: customers see it as in stock ([product editor docs][wcom-product-editor]). So `yes` with deeply negative stock is the stronger risk signal. | **Safe API correction:** `PUT backorders:"no"` on the stock-owning object (the product, or the parent for `"parent"` variations). Effects: `stock_status` recomputes to `outofstock`; the product leaves the catalog if `woocommerce_hide_out_of_stock_items=yes`; existing orders are unaffected. Reversible by writing back the previous `backorders` value. Must go through merchant approval because it is a business-policy change. |
| P2 | **`stock_status` inconsistent with `stock_quantity` under managed stock** | `manage_stock` true; expected = `instock` if `qty > T`, else `onbackorder` if `backorders != no`, else `outofstock`; observed `stock_status` differs. Also need `T`. For simple products, compare `context=edit` vs `view`. | **Rarely intentional, but often benign.** WC recomputes on every save, so a stored mismatch means a write bypassed CRUD (direct SQL, import, plugin) **or** `T` changed later ("does not affect existing in-stock products"). A mismatch only in view context means a plugin filter is altering the value. | **Conditional API correction:** a save makes WC recompute. Do not write `stock_status`, because it is overwritten. Do not re-send `stock_quantity`, because it races with concurrent sales. Use a no-op save such as `PUT {"manage_stock": true}`. That this recomputes is **(source)** inference from L1026-1081 and L1628-1649 and is **UNVERIFIED** on a live store. If the mismatch is filter-driven, or comes from a variable parent's lookup table, it needs human or admin action. |
| P3 | **Negative `stock_quantity` (oversold)** | `manage_stock` true and `stock_quantity < 0`; plus `backorders`. Optionally recent orders via `order.*` and `/orders`. | **Expected when backorders are allowed.** Docs: "if enabled, stock can go below zero" ([Variable products][wcom-variable]). The negative number is the quantity owed. With `backorders=no` it is an anomaly (concurrent checkout, manual admin orders, imports, plugins). | **No safe automatic correction for the quantity.** Physical count is unknown; this needs the merchant or an external record. Our product can propose P1's `backorders:"no"` to stop further overselling. A quantity fix must be an absolute `stock_quantity` value **entered by the merchant**, written with read-compare-write and re-verified. |
| P4 | **Published product with no price** | `status=publish`; `type` simple, or variable with no priced variation; `price==""` (and `regular_price==""`); `purchasable=false`; `catalog_visibility != hidden`. Exclude `grouped`, whose price comes from children, and `external` (UNVERIFIED how external products report `purchasable`). | **Sometimes.** Enquiry or catalog-only stores, quote plugins. A pricing plugin may supply the price only in view context, so compare `context=edit`. | **No safe automatic price.** The price needs merchant input. The API can apply a merchant-approved price (`regular_price`), `status:"draft"`, or `catalog_visibility:"hidden"` (all documented writable fields, [Products][dev-products]). |
| P5 | **Variable product published but every variation out of stock** | Parent `type=variable`, `status=publish`; all published variations (`/variations?include_status=publish`) have `stock_status=outofstock`; parent `stock_status=outofstock`. Also variations with `price==""` are not purchasable: `variation_is_visible` needs publish + price ([L669-680][gh-var-visible]). Also need `woocommerce_hide_out_of_stock_items`: if `yes`, WC already hides it and severity is lower. | **Often.** Seasonal items or restock pending, and the merchant may want the page indexed. | **Human decision.** Options via the API (each needs approval): `catalog_visibility:"hidden"` or `status:"draft"`, both reversible. Enabling backorders is a policy change. There is no correct automatic stock value. If parent and children disagree, see lookup-table drift (§6). |
| P6 (extra) | Stock-managed variation inheriting parent stock where the parent itself has P1 or P3 | Variation `manage_stock:"parent"`. | Same as P1/P3. | Write to the parent only. |
| P7 (extra) | Unmanaged product manually set to `onbackorder` | `manage_stock` false, `stock_status=onbackorder`. Backorders are forced to `no`, but the status is merchant-controlled. | **Usually intentional.** The product-editor docs describe this mode. | Report only. |

---

## Implications for our implementation

**Connection and permissions**

- Use `GET https://{store}/wc-auth/v1/authorize` with `scope=read_write`, a one-time unguessable `user_id`, an HTTPS `callback_url` that answers **exactly 200**, and a `return_url` that checks `success=1` and the `user_id` ([Authentication][dev-auth]; [class-wc-auth.php][gh-auth]).
- `read_write` is required because write-only keys cannot GET. The approving user must have `manage_woocommerce` (admin or shop manager). That is also needed for `/settings` and `/system_status`.
- Require HTTPS stores and use Basic auth. On "Consumer key is missing", fall back to query-string credentials. Do not support plain-HTTP OAuth 1.0a in v1.
- Store `key_id`, `consumer_key` and `consumer_secret` encrypted. Treat a 401 `woocommerce_rest_authentication_error` as "key revoked or user deleted, reconnect".

**Reads (per store)**

1. On connect, and daily: `GET /wp-json/wc/v3/system_status`
   - Use `environment.version`, `wp_version`, `php_version` and `active_plugins`.
   - Block below the minimum version. Flag known stock-altering plugins for manual review.
2. `GET /wp-json/wc/v3/settings/products`
   - Need `woocommerce_manage_stock`, `woocommerce_notify_no_stock_amount`, `woocommerce_hide_out_of_stock_items`, `woocommerce_hold_stock_minutes`.
   - UNVERIFIED that these are exposed. Fall back to assuming defaults and marking findings "threshold assumed 0".
3. Full scan, paginated until `page > X-WP-TotalPages`:
   ```
   GET /wp-json/wc/v3/products?per_page=100&page={n}&orderby=id&order=asc
       &include_status=publish,private,draft,pending
       &_fields=id,name,type,status,catalog_visibility,manage_stock,stock_quantity,stock_status,backorders,backorders_allowed,backordered,low_stock_amount,price,regular_price,purchasable,variations,date_modified_gmt
   ```
   - Incremental scans add `&modified_after={ISO}&dates_are_gmt=true`.
   - For simple products under suspicion, re-read with `&context=edit` and compare.
4. For each variable product:
   ```
   GET /wp-json/wc/v3/products/{id}/variations?per_page=100&page={n}
       &_fields=id,status,manage_stock,stock_quantity,stock_status,backorders,backorders_allowed,backordered,price,purchasable,date_modified
   ```
5. Before executing an approved correction, re-read the single object with `&_skip_cache=1` plus a cache-busting parameter. Abort and re-propose if any evidence field or `date_modified_gmt` changed since approval. The server has no optimistic locking.

**Writes (only after merchant approval; one object per request)**

- Product or stock-owning parent:
  ```
  PUT /wp-json/wc/v3/products/{id}
  Content-Type: application/json

  {"backorders":"no"}
  ```
- Variation with its own stock (`manage_stock === true`):
  ```
  PUT /wp-json/wc/v3/products/{product_id}/variations/{id}
  {"backorders":"no"}
  ```
  If `manage_stock === "parent"`, write to `/products/{product_id}` instead.
- Other approved actions use the same shape with `{"catalog_visibility":"hidden"}`, `{"status":"draft"}` or merchant-entered `{"stock_quantity":N}`.
- Use `POST /products/batch` (max 100 per request) only for bulk-approved sets, and check every item for an `error` object.
- **Verify in two steps:**
  1. The 200 response body must show the requested field value. Also check that `stock_status` matches the expected recomputation (e.g. `onbackorder`→`outofstock` when `qty <= T`).
  2. A fresh `GET … &_skip_cache=1` after a short delay must show the same state. This catches plugins that re-sync stock.
  - A 200 response that still shows the old value means a silent no-op (e.g. global Manage stock off). Mark it **failed** and do not retry blindly.
- Keep the previous values for one-click revert.

**Webhooks**

- Create with:
  ```
  POST /wp-json/wc/v3/webhooks
  {"name":"<app> product.updated","topic":"product.updated","delivery_url":"https://…/wc/{store_id}","secret":"<32+ random bytes>"}
  ```
- Repeat for `product.created`, `product.deleted`, `product.restored` (the last is **(source)** only).
- Order topics (`order.created`, `order.updated`) are optional context. Stock changes from orders already arrive as `product.updated` **(source)**.
- Handling deliveries:
  - Verify `X-WC-Webhook-Signature` = base64(HMAC-SHA256(raw body, secret)) with a constant-time compare.
  - Accept the unsigned form-encoded ping (`webhook_id=…`) by returning 2xx without processing it.
  - Return 2xx quickly and dedupe on `X-WC-Webhook-Delivery-ID` plus resource id.
  - Treat each event as a "re-fetch this ID" hint. Payloads may be coalesced (10-minute window), built at delivery time, delayed by Action Scheduler or WP-Cron, or lost after failures.
- Poll `GET /webhooks/{id}` daily. If `status=disabled`, re-enable with `PUT {"status":"active"}` and run an incremental scan.
- Always keep a periodic `modified_after` reconciliation scan as the source of truth.

**Minimum supported version**

- Require **WooCommerce >= 9.2**, the floor of the official security-support window while 11.2 is stable ([Security patch support policy][dev-security]). Raise the floor by one with each new major release (rolling 21 majors).
- Everything we use (`wc/v3`, variations `manage_stock:"parent"`, `low_stock_amount`, `/wc-auth/v1`, webhooks v3) is far older than that ([REST API version history][dev-rest]).
- Test against current stable **11.2.x** and **11.3** (pre-release). Note the 11.0 change to failed-order stock restoration.
- Re-check the experimental REST cache and `wc/v4` status each quarter.

---

## Source links

[blog-docs-moved]: https://developer.woocommerce.com/2026/05/08/new-woo-rest-api-docs/
[wporg-api]: https://api.wordpress.org/plugins/info/1.2/?action=plugin_information&slug=woocommerce
[gh-readme]: https://github.com/woocommerce/woocommerce/blob/3ef69407beda276dd278088103752e16a0042948/plugins/woocommerce/readme.txt#L1-L7
[gh-main]: https://github.com/woocommerce/woocommerce/blob/3ef69407beda276dd278088103752e16a0042948/plugins/woocommerce/woocommerce.php#L1-L12
[blog-113-pre]: https://developer.woocommerce.com/2026/10/26/woocommerce-11-3-pre-release/
[dev-rest]: https://developer.woocommerce.com/docs/apis/rest-api/
[dev-rest-pagination]: https://developer.woocommerce.com/docs/apis/rest-api/#pagination
[dev-rest-errors]: https://developer.woocommerce.com/docs/apis/rest-api/#errors
[dev-v3-index]: https://developer.woocommerce.com/docs/apis/rest-api/v3/api-reference/
[gh-v4-readme]: https://github.com/woocommerce/woocommerce/blob/3ef69407beda276dd278088103752e16a0042948/plugins/woocommerce/src/Internal/RestApi/Routes/V4/Products/README.md
[blog-dualapi]: https://developer.woocommerce.com/2026/09/28/experimental-dual-api-plugin/
[wp-pagination]: https://developer.wordpress.org/rest-api/using-the-rest-api/pagination/
[wp-global-params]: https://developer.wordpress.org/rest-api/using-the-rest-api/global-parameters/#_fields
[gh-crud-perpage]: https://github.com/woocommerce/woocommerce/blob/3ef69407beda276dd278088103752e16a0042948/plugins/woocommerce/includes/rest-api/Controllers/Version3/class-wc-rest-crud-controller.php#L581-L588
[gh-batch-limit]: https://github.com/woocommerce/woocommerce/blob/3ef69407beda276dd278088103752e16a0042948/plugins/woocommerce/includes/rest-api/Controllers/Version3/class-wc-rest-controller.php#L179-L201
[gh-batch-items]: https://github.com/woocommerce/woocommerce/blob/3ef69407beda276dd278088103752e16a0042948/plugins/woocommerce/includes/rest-api/Controllers/Version3/class-wc-rest-controller.php#L209-L275
[gh-prod-fields]: https://github.com/woocommerce/woocommerce/blob/3ef69407beda276dd278088103752e16a0042948/plugins/woocommerce/includes/rest-api/Controllers/Version3/class-wc-rest-products-controller.php#L2151-L2160
[dev-products]: https://developer.woocommerce.com/docs/apis/rest-api/v3/products/
[dev-variations]: https://developer.woocommerce.com/docs/apis/rest-api/v3/product-variations/
[dev-webhooks]: https://developer.woocommerce.com/docs/apis/rest-api/v3/webhooks/
[dev-setting-options]: https://developer.woocommerce.com/docs/apis/rest-api/v3/setting-options/
[dev-system-status]: https://developer.woocommerce.com/docs/apis/rest-api/v3/system-status/
[dev-auth]: https://developer.woocommerce.com/docs/apis/rest-api/authentication/
[dev-store-ratelimit]: https://developer.woocommerce.com/docs/apis/store-api/rate-limiting/
[dev-hpos]: https://developer.woocommerce.com/docs/features/orders/high-performance-order-storage/
[dev-security]: https://developer.woocommerce.com/docs/contribution/releases/security-support/
[wp-auth]: https://developer.wordpress.org/rest-api/using-the-rest-api/authentication/#basic-authentication-with-application-passwords
[wcom-settings-products]: https://woocommerce.com/document/configuring-woocommerce-settings/products/
[wcom-product-editor]: https://woocommerce.com/document/managing-products/product-editor-settings/
[wcom-variable]: https://woocommerce.com/document/variable-product/
[wcom-webhooks]: https://woocommerce.com/document/webhooks/
[blog-33-stock]: https://developer.woocommerce.com/2017/12/06/wc-3-3-product-backorders-and-stock-management-improvements/
[blog-rest-cache]: https://developer.woocommerce.com/2026/01/23/call-for-testing-experimental-rest-api-caching-in-woocommerce-10-5/
[blog-product-cache]: https://developer.woocommerce.com/2026/06/17/product-object-caching/
[blog-failed-stock]: https://developer.woocommerce.com/2026/07/17/failed-order-stock-update/
[blog-release-cycle]: https://developer.woocommerce.com/2024/09/23/new-release-cycle/
[blog-php81]: https://developer.woocommerce.com/2026/09/29/php-8-1-requirement/
[gh-managing-stock]: https://github.com/woocommerce/woocommerce/blob/3ef69407beda276dd278088103752e16a0042948/plugins/woocommerce/includes/abstracts/abstract-wc-product.php#L1998-L2003
[gh-backorders-allowed]: https://github.com/woocommerce/woocommerce/blob/3ef69407beda276dd278088103752e16a0042948/plugins/woocommerce/includes/abstracts/abstract-wc-product.php#L1948-L2012
[gh-is-on-backorder]: https://github.com/woocommerce/woocommerce/blob/3ef69407beda276dd278088103752e16a0042948/plugins/woocommerce/includes/abstracts/abstract-wc-product.php#L2029-L2045
[gh-is-purchasable]: https://github.com/woocommerce/woocommerce/blob/3ef69407beda276dd278088103752e16a0042948/plugins/woocommerce/includes/abstracts/abstract-wc-product.php#L1890-L1899
[gh-is-visible]: https://github.com/woocommerce/woocommerce/blob/3ef69407beda276dd278088103752e16a0042948/plugins/woocommerce/includes/abstracts/abstract-wc-product.php#L1861-L1883
[gh-set-manage-stock]: https://github.com/woocommerce/woocommerce/blob/3ef69407beda276dd278088103752e16a0042948/plugins/woocommerce/includes/abstracts/abstract-wc-product.php#L1159-L1210
[gh-validate-props]: https://github.com/woocommerce/woocommerce/blob/3ef69407beda276dd278088103752e16a0042948/plugins/woocommerce/includes/abstracts/abstract-wc-product.php#L1628-L1658
[gh-v2-fields]: https://github.com/woocommerce/woocommerce/blob/3ef69407beda276dd278088103752e16a0042948/plugins/woocommerce/includes/rest-api/Controllers/Version2/class-wc-rest-products-v2-controller.php#L962-L982
[gh-prod-schema]: https://github.com/woocommerce/woocommerce/blob/3ef69407beda276dd278088103752e16a0042948/plugins/woocommerce/includes/rest-api/Controllers/Version3/class-wc-rest-products-controller.php#L1480-L1521
[gh-prod-write]: https://github.com/woocommerce/woocommerce/blob/3ef69407beda276dd278088103752e16a0042948/plugins/woocommerce/includes/rest-api/Controllers/Version3/class-wc-rest-products-controller.php#L1019-L1081
[gh-prod-invalid]: https://github.com/woocommerce/woocommerce/blob/3ef69407beda276dd278088103752e16a0042948/plugins/woocommerce/includes/rest-api/Controllers/Version3/class-wc-rest-products-controller.php#L158
[gh-var-write]: https://github.com/woocommerce/woocommerce/blob/3ef69407beda276dd278088103752e16a0042948/plugins/woocommerce/includes/rest-api/Controllers/Version3/class-wc-rest-product-variations-controller.php#L316-L349
[gh-var-response]: https://github.com/woocommerce/woocommerce/blob/3ef69407beda276dd278088103752e16a0042948/plugins/woocommerce/includes/rest-api/Controllers/Version3/class-wc-rest-product-variations-controller.php#L149-L155
[gh-var-perm]: https://github.com/woocommerce/woocommerce/blob/3ef69407beda276dd278088103752e16a0042948/plugins/woocommerce/includes/rest-api/Controllers/Version2/class-wc-rest-product-variations-v2-controller.php#L214-L275
[gh-var-getters]: https://github.com/woocommerce/woocommerce/blob/3ef69407beda276dd278088103752e16a0042948/plugins/woocommerce/includes/class-wc-product-variation.php#L390-L432
[gh-var-visible]: https://github.com/woocommerce/woocommerce/blob/3ef69407beda276dd278088103752e16a0042948/plugins/woocommerce/includes/class-wc-product-variation.php#L640-L680
[gh-variable-validate]: https://github.com/woocommerce/woocommerce/blob/3ef69407beda276dd278088103752e16a0042948/plugins/woocommerce/includes/class-wc-product-variable.php#L561-L567
[gh-variable-after-save]: https://github.com/woocommerce/woocommerce/blob/3ef69407beda276dd278088103752e16a0042948/plugins/woocommerce/includes/class-wc-product-variable.php#L592-L595
[gh-variable-sync]: https://github.com/woocommerce/woocommerce/blob/3ef69407beda276dd278088103752e16a0042948/plugins/woocommerce/includes/data-stores/class-wc-product-variable-data-store-cpt.php#L989-L998
[gh-child-status]: https://github.com/woocommerce/woocommerce/blob/3ef69407beda276dd278088103752e16a0042948/plugins/woocommerce/includes/data-stores/class-wc-product-variable-data-store-cpt.php#L811-L828
[gh-sync-managed]: https://github.com/woocommerce/woocommerce/blob/3ef69407beda276dd278088103752e16a0042948/plugins/woocommerce/includes/data-stores/class-wc-product-variable-data-store-cpt.php#L873-L905
[gh-settings-inventory]: https://github.com/woocommerce/woocommerce/blob/3ef69407beda276dd278088103752e16a0042948/plugins/woocommerce/includes/admin/settings/class-wc-settings-products.php#L247-L384
[gh-register-settings]: https://github.com/woocommerce/woocommerce/blob/3ef69407beda276dd278088103752e16a0042948/plugins/woocommerce/includes/class-wc-register-wp-admin-settings.php#L142-L170
[gh-reserve-stock]: https://github.com/woocommerce/woocommerce/blob/3ef69407beda276dd278088103752e16a0042948/plugins/woocommerce/src/Checkout/Helpers/ReserveStock.php#L100-L115
[gh-crud-update]: https://github.com/woocommerce/woocommerce/blob/3ef69407beda276dd278088103752e16a0042948/plugins/woocommerce/includes/rest-api/Controllers/Version3/class-wc-rest-crud-controller.php#L161-L278
[gh-crud-perm]: https://github.com/woocommerce/woocommerce/blob/3ef69407beda276dd278088103752e16a0042948/plugins/woocommerce/includes/rest-api/Controllers/Version3/class-wc-rest-crud-controller.php#L68-L76
[gh-auth]: https://github.com/woocommerce/woocommerce/blob/3ef69407beda276dd278088103752e16a0042948/plugins/woocommerce/includes/class-wc-auth.php
[gh-auth-validate]: https://github.com/woocommerce/woocommerce/blob/3ef69407beda276dd278088103752e16a0042948/plugins/woocommerce/includes/class-wc-auth.php#L159-L203
[gh-auth-cap]: https://github.com/woocommerce/woocommerce/blob/3ef69407beda276dd278088103752e16a0042948/plugins/woocommerce/includes/class-wc-auth.php#L390-L413
[gh-auth-keys]: https://github.com/woocommerce/woocommerce/blob/3ef69407beda276dd278088103752e16a0042948/plugins/woocommerce/includes/class-wc-auth.php#L216-L262
[gh-auth-post]: https://github.com/woocommerce/woocommerce/blob/3ef69407beda276dd278088103752e16a0042948/plugins/woocommerce/includes/class-wc-auth.php#L270-L445
[gh-auth-perms]: https://github.com/woocommerce/woocommerce/blob/3ef69407beda276dd278088103752e16a0042948/plugins/woocommerce/includes/class-wc-rest-authentication.php#L754-L780
[gh-auth-ssl]: https://github.com/woocommerce/woocommerce/blob/3ef69407beda276dd278088103752e16a0042948/plugins/woocommerce/includes/class-wc-rest-authentication.php#L206-L220
[gh-webhook-topics]: https://github.com/woocommerce/woocommerce/blob/3ef69407beda276dd278088103752e16a0042948/plugins/woocommerce/includes/class-wc-webhook.php#L1054-L1088
[gh-webhook-deliver]: https://github.com/woocommerce/woocommerce/blob/3ef69407beda276dd278088103752e16a0042948/plugins/woocommerce/includes/class-wc-webhook.php#L362-L403
[gh-webhook-payload]: https://github.com/woocommerce/woocommerce/blob/3ef69407beda276dd278088103752e16a0042948/plugins/woocommerce/includes/class-wc-webhook.php#L460-L503
[gh-webhook-sig]: https://github.com/woocommerce/woocommerce/blob/3ef69407beda276dd278088103752e16a0042948/plugins/woocommerce/includes/class-wc-webhook.php#L514-L531
[gh-webhook-fail]: https://github.com/woocommerce/woocommerce/blob/3ef69407beda276dd278088103752e16a0042948/plugins/woocommerce/includes/class-wc-webhook.php#L607-L641
[gh-webhook-ping]: https://github.com/woocommerce/woocommerce/blob/3ef69407beda276dd278088103752e16a0042948/plugins/woocommerce/includes/class-wc-webhook.php#L678-L711
[gh-webhook-queue]: https://github.com/woocommerce/woocommerce/blob/3ef69407beda276dd278088103752e16a0042948/plugins/woocommerce/includes/wc-webhook-functions.php#L15-L45
[gh-webhook-create]: https://github.com/woocommerce/woocommerce/blob/3ef69407beda276dd278088103752e16a0042948/plugins/woocommerce/includes/rest-api/Controllers/Version1/class-wc-rest-webhooks-v1-controller.php#L360-L400
[gh-webhook-v3]: https://github.com/woocommerce/woocommerce/blob/3ef69407beda276dd278088103752e16a0042948/plugins/woocommerce/includes/rest-api/Controllers/Version3/class-wc-rest-webhooks-controller.php
[gh-stock-fn]: https://github.com/woocommerce/woocommerce/blob/3ef69407beda276dd278088103752e16a0042948/plugins/woocommerce/includes/wc-stock-functions.php#L30-L81
[gh-ds-update]: https://github.com/woocommerce/woocommerce/blob/3ef69407beda276dd278088103752e16a0042948/plugins/woocommerce/includes/data-stores/class-wc-product-data-store-cpt.php#L327-L403
[gh-ds-stock]: https://github.com/woocommerce/woocommerce/blob/3ef69407beda276dd278088103752e16a0042948/plugins/woocommerce/includes/data-stores/class-wc-product-data-store-cpt.php#L1872-L1925
[gh-ss-tools]: https://github.com/woocommerce/woocommerce/blob/3ef69407beda276dd278088103752e16a0042948/plugins/woocommerce/includes/rest-api/Controllers/Version2/class-wc-rest-system-status-tools-v2-controller.php#L152
[gh-get-prop]: https://github.com/woocommerce/woocommerce/blob/3ef69407beda276dd278088103752e16a0042948/plugins/woocommerce/includes/abstracts/abstract-wc-data.php#L952-L962
