# Shopify App Store readiness: research notes for Deploi

Research date: 2026-10-29. Sources: shopify.dev official docs only, read as raw Markdown (`<page>.md`) on the research date. Shopify's pages carry no "last updated" date. Where a page states an API version, it is noted. Help-center (help.shopify.com/partners) pages were searched, but none added anything beyond shopify.dev.

Conventions:
- Every claim cites its source URL.
- **UNVERIFIED** marks anything that could not be confirmed on an official page. That includes community-forum statements and inferences.
- Deploi context: a public, embedded Next.js 15 app on Vercel. It is not built from a Shopify app template. It reads products, variants, inventory levels and locations, and publications. It writes only these: variant `inventoryPolicy`, publish/unpublish on one channel, variant `price`/`compareAtPrice`, and variant SKU. It reads no orders and no customer data. It also has its own OAuth code-grant install, an App Bridge session-token endpoint, a webhooks route and a billing module, plus Gmail/Microsoft mailbox connections for supplier email.

---

## 0. Headline findings (things that contradict or change the current implementation)

1. **Billing: Shopify App Pricing (formerly "Managed Pricing") is now the default for new public apps.** With it, the app must NOT call `appSubscriptionCreate`. Plans live in the Partner Dashboard. Shopify hosts the plan page. Subscription status comes from the **Partner API** `activeSubscription`, not the Admin API. Since April 28, 2026 there are no `app_subscriptions/update` webhooks and no `charge_id` for App Pricing. A Billing-API module is "Manual Pricing (Legacy)". https://shopify.dev/docs/apps/launch/billing , https://shopify.dev/docs/apps/launch/billing/shopify-app-pricing
2. **Expiring offline tokens are mandatory for public apps.** "Non-expiring offline access tokens aren't permitted" (requirement 3.1.2). "New public apps already can't use them", and existing public apps lose them on January 1, 2027. Token requests must send `expiring=1`, store the `refresh_token` and refresh roughly hourly (`expires_in` 3600). https://shopify.dev/docs/apps/launch/shopify-app-store/app-store-requirements , https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens
3. **Recommended auth for embedded apps is Shopify managed installation plus token exchange, not a hand-rolled authorization-code flow.** Scopes go in `shopify.app.toml`. Once managed install is on, the app "no longer needs OAuth callback routes" for install and scope updates. https://shopify.dev/docs/apps/build/authentication-authorization , https://shopify.dev/docs/apps/build/authentication-authorization/cli-app-authentication
4. **"Session tokens" are now called "ID tokens".** The validation rules are unchanged: HS256 with the client secret, `aud` = client ID, `iss`/`dest` hosts match, `exp`/`nbf`. On failure, return 401 with `X-Shopify-Retry-Invalid-Session-Request: 1`. https://shopify.dev/docs/apps/build/authentication-authorization/id-tokens , https://shopify.dev/docs/apps/build/authentication-authorization/implement-token-exchange
5. **Compliance webhooks are mandatory even though Deploi stores no customer data.** They are configured only in TOML or the Dev Dashboard, never via the Admin API. An invalid HMAC must get a 401. https://shopify.dev/docs/apps/build/compliance/privacy-law-compliance , https://shopify.dev/docs/apps/build/webhooks/subscribe
6. **Latest stable Admin API is `2026-10`.** `2027-01` is the release candidate. Versions `2025-04`, `2025-07` and `2025-10` are now unsupported. https://shopify.dev/docs/api/usage/versioning

---

## 1. App Store requirements checklist (applicable items)

Source for every item in this section unless noted: https://shopify.dev/docs/apps/launch/shopify-app-store/app-store-requirements (no date on the page; it says "These requirements are subject to change").

### 1.1 Policy / platform
| # | Requirement (paraphrased; quoted where exact) | Applies to Deploi? |
|---|---|---|
| 1.1.1 | "Use session tokens for authentication. Your embedded app must function properly without relying on third-party cookies or local storage, including when accessed in incognito mode on Chrome." | YES: the embedded UI under `/shopify/*` must not depend on cookies or `localStorage` for auth or state. |
| 1.1.4 | Only factual information in the app and listing. | Yes |
| 1.1.5 | App must not be identical to another app you published. | Yes |
| 1.1.12 | Must be web-based; no desktop app required. | Yes (OK) |
| 1.1.13 | Duplicate only product info the merchant may use. | N/A |
| 1.2 / 1.2.1 | "Your app must use Shopify App Pricing or the Shopify Billing API for all app charges". No off-platform billing. | YES |
| 1.2.2 | Implement billing correctly: "accept, decline and request approval for charges again on reinstall". | YES |
| 1.2.3 | "Allow merchants to upgrade and downgrade their pricing plan without having to contact your support team or having to reinstall the app". Charges must appear in the admin charge history. | YES |
| 1.3.1 | Neutral review requests; no incentives for reviews. | Yes |

### 1.2 Functionality
| # | Requirement | Applies? |
|---|---|---|
| 2.1.1 / 2.1.2 | No UI bugs or web errors (404/500/300) that fully or partly block review. | Yes |
| 2.1.3 | Must be operable through a UI. | Yes |
| 2.1.4 | Synchronized data must be accurate across the Shopify admin, the app and other platforms. | YES (inventory, price and publish writes) |
| 2.2.1 | Must use Shopify APIs. | Yes (OK) |
| 2.2.2 | "Provide a consistent embedded experience by ensuring that any off-platform features are integrated directly within the Shopify Admin." | YES: the standalone UI and the mailbox-connection settings should also be reachable inside the embedded app. |
| 2.2.3 | "As of March 13th, 2024, all apps must use the latest Shopify App Bridge by adding the `app-bridge.js` script tag before any other script tags." Recommended in the `<head>` of each document, or as the first script element. | YES |
| 2.2.4 | "As of April 1, 2025 all new public apps must be built exclusively with the GraphQL Admin API". REST has been legacy since Oct 1, 2024. | YES: no REST Admin calls. |
| 2.2.5–2.2.9 | Admin extensions, Max modal and Sidekick extension rules. | Only if Deploi adds extensions. |
| 2.3.1 | "Initiate installation from a Shopify-owned surface". Must not request manual entry of a myshopify.com URL or shop domain "during the installation or configuration flow". | YES: any "enter your shop domain" form must not be part of install. |
| 2.3.2 | "Authenticate immediately after install… Merchants should not be able to interact with the user interface (UI) before OAuth." | YES |
| 2.3.3 | "Redirect to the app UI after installation." | YES |
| 2.3.4 | "Require OAuth authentication immediately after reinstall", even after a prior uninstall. | YES |

### 1.3 Security
| # | Requirement | Applies? |
|---|---|---|
| 3.1.1 | Valid TLS/SSL certificate. | Yes (Vercel) |
| 3.1.2 | "Public apps must use expiring offline access tokens for the GraphQL Admin API and REST Admin API. Non-expiring offline access tokens aren't permitted." Migration guide: https://shopify.dev/docs/apps/build/authentication-authorization/migrate-to-expiring-offline-access-tokens | **YES: a likely gap.** |
| 3.2 | Request only necessary scopes. Optional scopes are recommended for scopes not every merchant needs. Shopify may ask for proof. | YES |
| 3.2.1–3.2.5 | `read_all_orders`, `write_payment_mandate`, `write_checkout_extensions_apis`, `read_advanced_dom_pixel_events`, `read_checkout_extensions_chat` require justification. | Not needed by Deploi. |

### 1.4 Listing
| # | Requirement | Applies? |
|---|---|---|
| 4.1.1 | App name in the Developer Dashboard (TOML `name`) must match or be similar to the submission-form name. | YES |
| 4.1.2 | Unique name that leads with your brand. Not confusingly similar to other apps, brands or Shopify. | YES |
| 4.2.1–4.2.3 | Accurate, complete pricing, only in the Pricing details section. No pricing in images or the icon. | YES |
| 4.3.1 | State whether the Online Store channel is required. | Probably not required for Deploi. |
| 4.3.2 | List only languages the UI fully supports. | Yes |
| 4.3.3/4.3.4 | No stats, data, guarantees or superlatives ("the first", "the best", "the only") in text or images. | Yes |
| 4.3.5 | Accurate tags. | Yes |
| 4.3.6/4.3.7 | No reviews or testimonials in listing text or images. | Yes |
| 4.3.8 | Disclose geographic or API-permission requirements. | Yes, if any. |
| 4.4.1–4.4.5 | Concise subtitle. Clear app details. No Shopify trademarks in graphics. Screenshots show the real UI with no browser frames or desktop backgrounds. All images unique. | Yes |
| 4.5.2 | If not a sales channel, remove sales-channel configuration. | Yes (Deploi is not a sales channel) |
| 4.5.3 | "Include a demo screencast… clear step-by-step instructions showing how to set up your apps core features… in English or have English subtitles." | YES |
| 4.5.4 | Include test account credentials in testing instructions and keep them current. | YES, if any Deploi login exists. |
| 4.5.5 | "If your app requires login credentials, you must provide valid credentials… that grant full feature access. Provide a dedicated test account that is exempted from 2FA, OTP, or SSO challenges, or supply static verification codes… Credentials must continue to work after your app is published." | YES: relevant to the Gmail/Microsoft mailbox connection. Reviewers need a way to test supplier email without their own Google or Microsoft account. |
| 4.5.6 | "Add an emergency developer contact to your Partner Dashboard." | YES |

### 1.5 Items asked about but NOT on the current requirements page
- **Mandatory compliance webhooks and privacy policy.** These are not numbered items on the requirements page. They are required by other official pages:
  - Compliance webhooks: https://shopify.dev/docs/apps/build/compliance/privacy-law-compliance and https://shopify.dev/docs/apps/launch/app-store-review/submit-app-for-review
  - Privacy policy: https://shopify.dev/docs/apps/launch/privacy-requirements and https://shopify.dev/docs/apps/launch/shopify-app-store/best-practices
- **App icon size.** 1200 x 1200 px, JPEG or PNG (https://shopify.dev/docs/apps/launch/app-store-review/submit-app-for-review). Guidelines: no text, no screenshots, no Shopify trademarks (https://shopify.dev/docs/apps/launch/shopify-app-store/best-practices).
- **Screenshots.** 1600 x 900 px (16:9), 3–6 desktop screenshots with at least one of the app UI. Alt text, no PII, no pricing, reviews or guarantees. Feature image or video is optional: a 2–3 minute promotional video or a 1600x900 image. Source: https://shopify.dev/docs/apps/launch/shopify-app-store/best-practices
- **Demo store URL.** Optional: a link to a development store showing the app. Source: https://shopify.dev/docs/apps/launch/shopify-app-store/best-practices
- **Support email.** "All public apps are required to provide at least one support channel… Having a valid support email address on file is always required." Optional extras: a support portal URL and a phone number. Source: https://shopify.dev/docs/apps/launch/distribution/support-your-customers
- **URLs and contact emails.** App URLs must not contain "Shopify" or "Example". The API contact email must not contain "Shopify". Source: https://shopify.dev/docs/apps/launch/app-store-review/submit-app-for-review
- **Performance / Lighthouse.** "Your app shouldn't reduce Lighthouse performance scores by more than 10 points." Shopify tests this for "apps that affect storefronts directly", with weights Home 17%, Product 40%, Collection 43%. Source: https://shopify.dev/docs/apps/launch/shopify-app-store/best-practices . **Deploi has no storefront code, so this test should not apply.** This is an inference from the "affect storefronts directly" wording. Admin performance is measured with Web Vitals (LCP, CLS, INP) via App Bridge. It is a Built for Shopify criterion, not a listing requirement. Source: https://shopify.dev/docs/apps/build/performance/admin-installation-oauth
- **Apps that send email.** No App Store requirement covers apps that send email through merchant-connected mailboxes. The Built for Shopify "Email marketing apps" category (web pixels, segments, customer sync) is about marketing to buyers, so it does not apply to supplier emails. Source: https://shopify.dev/docs/apps/launch/built-for-shopify/requirements . Built for Shopify 3.1.5 says connection settings to third-party systems "must be available inside the Shopify embedded app interface", with connect and disconnect "through the Shopify admin at any time". **UNVERIFIED** whether reviewers treat the Gmail/Microsoft OAuth popup or redirect specially. Note that best practices advise against "pop-up windows for essential app functionality, like running OAuth". Source: https://shopify.dev/docs/apps/launch/shopify-app-store/best-practices
- **AI / LLM.** No App Store requirement specifically addresses AI or LLM features.
  - Built for Shopify 4.3.5 rejects using "the Shopify Sidekick icon and/or a color similar to Shopify's magic purple color to denote an AI related feature" (https://shopify.dev/docs/apps/launch/built-for-shopify/requirements).
  - Sidekick extension rules (2.2.8/2.2.9) apply only if Deploi builds one.
  - Shopify offers an AI self-review of a codebase against the requirements, via the Shopify AI Toolkit (https://shopify.dev/docs/apps/launch/app-store-review/pass-app-review).
  - **UNVERIFIED:** any policy on sending Shopify data to third-party LLMs. The Partner Program Agreement and API Terms live on shopify.com/legal, which was outside the allowed source set and was not read.
- **Requiring an external account or sign-up before use.**
  - The requirements page has no outright ban. It does require immediate OAuth before any UI (2.3.2). It also requires off-platform features to be integrated in the admin (2.2.2) and test credentials with full access if a login exists (4.5.4/4.5.5).
  - Built for Shopify 3.1.3: "Apps should make sign up seamless for merchants, without requiring an additional login or sign-up prompt. Users should be able to start using the app immediately after installing it". There is an exception for B2B-contract apps. Source: https://shopify.dev/docs/apps/launch/built-for-shopify/requirements
  - Conclusion: a separate Deploi account is allowed for listing, but blocks Built for Shopify, and reviewers must be given working credentials.

### 1.6 Built for Shopify (optional) — brief
Source: https://shopify.dev/docs/apps/launch/built-for-shopify/requirements
- **Prerequisites:** meet the App Store requirements; good Partner standing; at least 50 net installs from active paid-plan shops; at least 5 reviews; a minimum recent rating.
- **Admin performance at p75, with at least 100 calls in 28 days:** LCP ≤ 2.5s, CLS ≤ 0.1, INP ≤ 200ms. Requires the latest App Bridge. Storefront Lighthouse drop ≤ 10 points. Checkout criteria apply only to carrier-rate apps.
- **Integration:**
  - Embedded with the App Bridge script in the `<head>` of every document, using ID tokens (3.1.1).
  - Primary workflows inside Shopify (3.1.2).
  - Seamless sign-up with no extra login (3.1.3).
  - Simplified metrics on the home page (3.1.4).
  - Third-party connection settings inside the embedded app (3.1.5).
  - Theme app extensions for storefront code (3.2.1).
  - No Asset API writes (3.2.2).
- **Design:** Polaris/UX practices; mobile-friendly; concise name; nav menu; contextual save bar; appropriate modals; helpful onboarding, homepage and errors; no false claims, pressure or impersonation of Shopify; dismissible ads; premium features labelled and disabled.

---

## 2. Recommended authentication today

### 2.1 Approach
- "Building one with Shopify CLI is the recommended path. CLI apps use managed installation, so you don't implement the authorization code grant yourself." Source: https://shopify.dev/docs/apps/build/authentication-authorization
- **Token exchange** is for apps that run inside the Shopify admin. **Authorization code grant** is for apps that run outside it. Source: https://shopify.dev/docs/apps/build/authentication-authorization
- Public distribution: "If embedded, token exchange. If not embedded, the authorization code grant". Source: https://shopify.dev/docs/apps/launch/distribution
- **Managed installation:**
  - Declare scopes in `[access_scopes] scopes` in `shopify.app.toml` and run `shopify app deploy`. Shopify then "installs your app and updates its access scopes without calling your app" (https://shopify.dev/docs/apps/build/authentication-authorization).
  - Migrating from legacy OAuth: link the config, declare scopes and deploy. "After migration, Shopify handles installation and scope updates, and your app no longer needs OAuth callback routes for these operations." Source: https://shopify.dev/docs/apps/build/authentication-authorization/cli-app-authentication
- `use_legacy_install_flow`: "When omitted or `false`… scopes… are automatically requested when the app is installed… This is referred to as Shopify managed installation. When `true`, the legacy installation flow requests scopes through a URL parameter during the OAuth flow… still supported, but isn't recommended because your app can end up with different scopes for each installation." Source: https://shopify.dev/docs/apps/build/cli-for-apps/app-configuration
- Pass-app-review: with CLI-configured apps "your app will automatically use Shopify managed installation. You can skip this step", meaning the OAuth redirect checks. Source: https://shopify.dev/docs/apps/launch/app-store-review/pass-app-review
- A non-template, custom-frontend embedded app (Deploi's case) is covered by "Authenticate an embedded app without a template": https://shopify.dev/docs/apps/build/authentication-authorization/implement-token-exchange (reference implementation: https://github.com/Shopify/example-auth--token-exchange)
- **UNVERIFIED:** the exact query parameters Shopify appends when it first loads `application_url` after a managed install (for example `shop`, `host`, `embedded`, `id_token`). No official page read today lists them. Rely on App Bridge plus `shopify.idToken()` rather than on URL parameters.

### 2.2 Token exchange request
Sources: https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens , https://shopify.dev/docs/apps/build/authentication-authorization/implement-token-exchange

`POST https://{shop}.myshopify.com/admin/oauth/access_token`, `Content-Type: application/x-www-form-urlencoded`

| Param | Value |
|---|---|
| `client_id` | app client ID (required) |
| `client_secret` | app client secret (required) |
| `grant_type` | `urn:ietf:params:oauth:grant-type:token-exchange` (required) |
| `subject_token` | the ID token from App Bridge (required) |
| `subject_token_type` | `urn:ietf:params:oauth:token-type:id_token` (required) |
| `requested_token_type` | `urn:shopify:params:oauth:token-type:offline-access-token` (default) or `urn:shopify:params:oauth:token-type:online-access-token` |
| `expiring` | offline only: `1` = expiring, `0` (default) = non-expiring. **Public apps must send `1`.** |

**Responses and errors:**
- Offline response fields: `access_token`, `scope`, `expires_in` (3600), `refresh_token`, `refresh_token_expires_in` (7776000 = 90 days).
- Online response adds `associated_user` and `associated_user_scope`. It lasts 24h or until the user logs out of the admin, and has no refresh token.
- An invalid or expired ID token returns `400 Bad Request`. Get a fresh ID token and retry. Do not cache ID tokens.
- The token endpoint is unversioned. "OAuth endpoints" are listed as unversioned in https://shopify.dev/docs/api/usage/versioning

**Token-store rule:** Shopify keeps one current expiring offline token per app and store. Acquiring a new one retires older ones, which stay valid until their `expires_in`. Source: https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens

### 2.3 Expiring offline tokens and refresh
Sources: https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens , https://shopify.dev/docs/apps/build/authentication-authorization/migrate-to-expiring-offline-access-tokens , https://shopify.dev/docs/apps/build/authentication-authorization/implement-token-exchange

- **Requirement:** "Public apps must use expiring offline access tokens for GraphQL Admin API requests by January 1, 2027… New public apps already can't use non-expiring tokens". After that date Shopify "rejects a GraphQL Admin API request that presents a non-expiring offline token". Requirement 3.1.2 already applies at review.
- The authorization-code grant also accepts `expiring=1`.
- **Refresh request:** `POST https://{shop}.myshopify.com/admin/oauth/access_token` with `client_id`, `client_secret`, `grant_type=refresh_token` and `refresh_token`. It returns a new access token AND a new refresh token; store both.
- **Rotation:** the presented refresh token stays usable until the earliest of:
  - the app uses the newer refresh token;
  - the app acquires a new token;
  - 30 days after its first use;
  - its original 90-day expiry.
- **Retries:** network errors, timeouts, 5xx and 429 are safe to retry with the same refresh token. A terminal failure is `401` with `{"error": "invalid_request"}` and "This request requires an active refresh_token". Treat it as final and re-run token exchange the next time the merchant opens the app.
- **Concurrency:** "Refresh one store at a time." Don't refresh and acquire concurrently for the same store. This matters on Vercel serverless, so use a lock (for example a DB row lock).
- Read `expires_in` from the response rather than hard-coding a lifetime.

### 2.4 ID token (session token) validation
Sources: https://shopify.dev/docs/apps/build/authentication-authorization/id-tokens , https://shopify.dev/docs/apps/build/authentication-authorization/implement-token-exchange

- "An ID token, previously called a session token, is a short-lived JWT".
- Verify the signature with **HS256 using the client secret**.
- Check claims:
  - `exp` in the future;
  - `nbf` in the past;
  - `aud` = app client ID;
  - `iss` and `dest` hostnames match. The shop is `new URL(payload.dest).hostname`.
- `sub`, `sid`, `jti` and `iat` identify the user and session. They are not validated.
- On failure: return 401 before calling the token endpoint. For XHR/fetch requests, set the response header `X-Shopify-Retry-Invalid-Session-Request: 1` "App Bridge intercepts the response, fetches a fresh ID token, and retries the request once."
- Lifetime: tokens "expire one minute after they're issued". App Bridge may return a cached token with less time left.
- Clock skew: **no official guidance found (UNVERIFIED)**. A few seconds of leeway on `exp`/`nbf` is a common JWT practice, not a Shopify statement.
- Send ID tokens only to your own backend, never to a third party.
- Ad blockers can block App Bridge from issuing an ID token. This can stall the automated review check "on the automated authentication check".
- Embedded apps "must authenticate with ID tokens, because third-party cookies aren't reliably available". Risky cookie use flagged in quality checks "requires immediate action".

### 2.5 Loading App Bridge and getting the token
- Script tag, from https://shopify.dev/docs/api/app-home/apis:
  ```html
  <head>
    <meta name="shopify-api-key" content="%SHOPIFY_API_KEY%" />
    <script src="https://cdn.shopify.com/shopifycloud/app-bridge.js"></script>
  </head>
  ```
  The meta content is the app's client ID. Per requirement 2.2.3 the script must come before any other script tags.
- Loading from the CDN "installs the latest version of the library". App Bridge "isn't versioned with Polaris". TypeScript types come from `@shopify/app-bridge-types@latest`. Source: https://shopify.dev/docs/api/app-home/apis
- Manual token: `const idToken = await shopify.idToken();` then `fetch(url, { headers: { Authorization: \`Bearer ${idToken}\` } })`. Sources: https://shopify.dev/docs/apps/build/authentication-authorization/implement-token-exchange , https://shopify.dev/docs/api/app-home
- Automatic token: App Bridge intercepts `fetch()`. "For requests to your app's domain and subdomains, App Bridge automatically adds an OpenID Connect ID Token in the `Authorization` header, along with the shop's locale in `Accept-Language`". This can be disabled via `disabledFeatures`. Source: https://shopify.dev/docs/api/app-home/apis/authentication-and-data/resource-fetching-api
- Direct API access: `fetch('shopify:admin/api/2026-10/graphql.json')` works if `[access.admin] embedded_app_direct_api_access = true` is set in TOML. This is optional and lets the frontend call the Admin API directly. Sources: https://shopify.dev/docs/api/app-home/apis/authentication-and-data/resource-fetching-api , https://shopify.dev/docs/apps/build/cli-for-apps/app-configuration
- Next.js note: the script tag must be rendered in the server-rendered `<head>` of every document under `/shopify/*`, before other scripts. **UNVERIFIED** whether `next/script` with `strategy="beforeInteractive"` satisfies "before any other script tags". A plain `<script>` in the root layout `<head>` is the safest reading of 2.2.3.

---

## 3. `shopify.app.toml`

Source: https://shopify.dev/docs/apps/build/cli-for-apps/app-configuration (example uses `api_version = "2026-10"`)

| Section / field | Required | Notes |
|---|---|---|
| `name` | Yes | Must match or be similar to the listing name (req. 4.1.1). |
| `client_id` | Yes | Public identifier (not secret). |
| `application_url` | Yes | App URL. |
| `embedded` | Yes | `true` to render in the admin. |
| `handle` | No | App Home URL slug, `admin.shopify.com/store/<store>/apps/<handle>/app`. Changing it breaks admin links. It is also used in the App Pricing plan-page URL. |
| `[access_scopes] scopes` | Yes | Comma-separated string; requested at install under managed install. |
| `[access_scopes] optional_scopes` | No | Array; requested dynamically later. |
| `[access_scopes] use_legacy_install_flow` | No | Omit or `false` = managed install (recommended). |
| `[access.admin] direct_api_mode`, `embedded_app_direct_api_access` | No | Direct API access from the frontend. |
| `[auth] redirect_urls` | Yes | Array. "You must include at least one redirect URL before making your app public." Used for the authorization-code grant. |
| `[webhooks] api_version` | Yes | e.g. `"2026-10"`. Serializes payloads for app-specific subscriptions. |
| `[[webhooks.subscriptions]] topics` | Yes | e.g. `["app/uninstalled"]`. |
| `[[webhooks.subscriptions]] compliance_topics` | No in schema; required for the App Store | `["customers/data_request","customers/redact","shop/redact"]`. |
| `[[webhooks.subscriptions]] uri` | Yes | HTTPS URL, relative path (e.g. `/webhooks`), Pub/Sub or EventBridge ARN. |
| `[[webhooks.subscriptions]] filter`, `include_fields` | No | Delivery filtering and payload trimming. |
| `[pos] embedded` | No | Load the app in POS. |
| `[app_preferences] url` | No | Preferences page. |
| `[network_access]` | No | Storefront/checkout/admin external hosts. |
| `[build] automatically_update_urls_on_dev` | No | `false` "Recommended for production apps". |
| `[build] dev_store_url` | No | Dev store for `app dev`. |

- `shopify app config push` "is no longer supported". Use `shopify app deploy`, or `--allow-updates` in CI. Source: https://shopify.dev/docs/apps/build/cli-for-apps/app-configuration
- `shopify app deploy` creates and releases an app version (config plus extensions). It does NOT deploy the web app; Vercel still does that. Source: https://shopify.dev/docs/api/shopify-cli/app/app-deploy
- **Where compliance webhooks can be configured:** "in Dev Dashboard or by updating your app configuration file". For shop-specific (Admin API) subscriptions, compliance topics "**Cannot** be subscribed to using the Admin API". Source: https://shopify.dev/docs/apps/build/webhooks/subscribe . (The App Store review page's configuration step also walks through compliance webhooks: https://shopify.dev/docs/apps/launch/app-store-review/submit-app-for-review)
- **Latest stable Admin API version: `2026-10`**, released October 1, 2026 and accessible until October 16, 2027.
  - Release candidate: `2027-01`.
  - Supported: `2026-01`, `2026-04`, `2026-07`, `2026-10`.
  - Unsupported: `2025-10` and older.
  - "If your app targets an inaccessible version, Shopify falls forward".
  - Source: https://shopify.dev/docs/api/usage/versioning
- Best practices: "apps using APIs that will be deprecated within 90 days can't be submitted". Source: https://shopify.dev/docs/apps/launch/shopify-app-store/best-practices

Suggested shape for Deploi. Values are illustrative; no secrets, and the client ID is a placeholder:
```toml
name = "Deploi"
client_id = "<client id>"
application_url = "https://<deploi host>/shopify"
embedded = true
handle = "deploi"

[access_scopes]
scopes = "write_products,read_inventory,read_locations,write_publications"
# use_legacy_install_flow omitted => Shopify managed installation

[auth]
redirect_urls = ["https://<deploi host>/api/shopify/auth/callback"]

[webhooks]
api_version = "2026-10"

[[webhooks.subscriptions]]
topics = ["app/uninstalled", "app/scopes_update"]
uri = "/api/shopify/webhooks"

[[webhooks.subscriptions]]
compliance_topics = ["customers/data_request", "customers/redact", "shop/redact"]
uri = "/api/shopify/webhooks"

[build]
automatically_update_urls_on_dev = false
```
Whether `write_inventory` is also needed for SKU writes is unconfirmed; see §5.

---

## 4. Webhooks

### 4.1 Verification and headers
Sources: https://shopify.dev/docs/apps/build/webhooks/verify-deliveries (fetched via `/docs/apps/build/webhooks/subscribe/https`) and https://shopify.dev/docs/apps/build/webhooks/delivery-structure

- **HMAC check:**
  - `X-Shopify-Hmac-Sha256` is the base64 HMAC-SHA256 of the **raw request body**, keyed with the app's client secret.
  - Compare with a timing-safe equality check. On mismatch, return **401**.
  - Capture the raw body before any JSON parsing. In Next.js route handlers, use `await req.text()` or `arrayBuffer()` before `JSON.parse`.
  - After a client-secret rotation, HMACs may use the new secret only after up to an hour.
- Headers (treat names as case-insensitive):

  | Header | Meaning |
  |---|---|
  | `X-Shopify-Topic` | the topic name |
  | `X-Shopify-Hmac-Sha256` | HTTPS deliveries only |
  | `X-Shopify-Shop-Domain` | the `myshopify.com` domain |
  | `X-Shopify-API-Version` | the API version used for the payload |
  | `X-Shopify-Webhook-Id` | unique per delivery; use for dedup |
  | `X-Shopify-Triggered-At` | when Shopify triggered the delivery |
  | `X-Shopify-Event-Id` | shared across deliveries from the same merchant action |
  | `X-Shopify-Name` | optional subscription name |

- **Response:**
  - Return `200` quickly. "Any response outside the 200 range, including 3XX codes, is treated as an error."
  - Shopify allows a 1-second connection timeout and a 5-second total timeout.
  - Queue work rather than doing it inline. Shopify suggests a reconciliation job for missed data.
- **Retries:**
  - "it retries 8 times over the next 4 hours".
  - After 8 consecutive failures, Admin-API-created subscriptions are deleted.
  - Warning emails go to the emergency developer contact.
- **Dedup:** process idempotently, or store `X-Shopify-Webhook-Id` and skip repeats. Use `X-Shopify-Event-Id` to correlate deliveries from the same action.
- **Subscription model:** app-specific (TOML) subscriptions are recommended over shop-specific (Admin API) ones. Source: https://shopify.dev/docs/apps/build/webhooks/subscribe

### 4.2 Compliance topics
Source: https://shopify.dev/docs/apps/build/compliance/privacy-law-compliance (example `api_version = "2026-10"`)

- "Any app that you distribute through the Shopify App Store must respond to data subject requests, regardless of whether the app collects personal data."
- **Requirements:**
  - Subscribe to all three topics.
  - Handle `POST` with a JSON body and `Content-Type: application/json`.
  - Return **401 Unauthorized for an invalid HMAC**.
  - "If you don't provide URLs for the mandatory compliance webhooks, or your app doesn't respond… your app will be rejected".
- **Response:** acknowledge with a 2xx, and complete the action within **30 days**. Don't redact data you are legally required to keep.
- **`customers/data_request`:** sent to apps "granted access to customer or order data".
  - Payload: `shop_id`, `shop_domain`, `orders_requested[]`, `customer{id,email,phone}`, `data_request{id}`.
- **`customers/redact`:** sent if the app has customer or order data access.
  - Shopify sends it 10 days after the deletion request (held while a scheduled gift card is pending).
  - Payload: `shop_id`, `shop_domain`, `customer{id,email,phone}`, `orders_to_redact[]`.
- **`shop/redact`:** "48 hours after a store owner uninstalls your app".
  - Payload: `shop_id`, `shop_domain`. Erase that shop's data.
- **What Deploi must do although it stores no customer data:**
  - Subscribe to all three topics.
  - Verify HMAC (401 if invalid) and return 200 on valid requests.
  - For `customers/*`, respond with no data or no-op. Deploi has no customer or order scopes, so per the page it is unlikely to receive these in practice, but the endpoints must still exist and pass the checks.
  - For `shop/redact`, delete everything stored for the shop: tokens, product caches, settings and supplier-email data tied to that shop.
- **Testing:** `shopify app webhook trigger` sends a test delivery, but "Manually triggering webhooks doesn't test your webhook subscriptions". Source: https://shopify.dev/docs/apps/build/compliance/privacy-law-compliance

### 4.3 `app/uninstalled` and billing webhooks
- `app/uninstalled` is the standard topic in the official TOML examples (https://shopify.dev/docs/apps/build/webhooks/subscribe/get-started).
- Uninstall "ends the access of all your app's tokens for that store". Later requests return 401. Source: https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens
- The best-practices list includes "Remove customer data from a database for app uninstalls". Source: https://shopify.dev/docs/apps/build/webhooks/best-practices
- **UNVERIFIED:** an official, specific "must do X on app/uninstalled" requirement. The expectations are inferred: mark the shop inactive, delete tokens, stop background jobs and Gmail/MS sends for that shop, and fully purge on `shop/redact`.
- Reinstall must trigger OAuth immediately and re-request charge approval (requirements 2.3.4 and 1.2.2).
- `app_subscriptions/update` (`APP_SUBSCRIPTIONS_UPDATE`) applies only to the Billing API (Manual Pricing). "Triggered when the status, or capped amount, of an `AppSubscription` object is changed". Source: https://shopify.dev/docs/apps/launch/billing/manual-pricing
  - For Shopify App Pricing, "After April 28, 2026, Shopify App Pricing no longer sends webhooks for subscription changes". Use Partner API queries and redirect parameters instead. Source: https://shopify.dev/docs/apps/launch/billing/shopify-app-pricing
- On uninstall, Shopify automatically cancels the Billing API subscription with no credit for the rest of the period. Source: https://shopify.dev/docs/apps/launch/billing/manual-pricing/subscription-billing

---

## 5. Access scopes (minimal set for Deploi)

General rules, from https://shopify.dev/docs/apps/build/authentication-authorization/manage-access-scopes :
- "A write scope includes read."
- Declaring a read scope as optional while its write scope is required fails to deploy.

| Operation | Official scope statement | Source |
|---|---|---|
| `productVariantsBulkUpdate` (`inventoryPolicy`, `price`, `compareAtPrice`, `inventoryItem.sku`) | "Requires `write_products` access scope. Also: The user must have a permission to update product variants." | https://shopify.dev/docs/api/admin-graphql/latest/mutations/productVariantsBulkUpdate |
| SKU via `ProductVariantsBulkInput.inventoryItem` (`InventoryItemInput.sku`) | The input field is documented, but no extra scope is stated on the mutation. **UNVERIFIED** whether `write_inventory` is also required when `inventoryItem` is set; test on a dev store with only `write_products`. | https://shopify.dev/docs/api/admin-graphql/latest/input-objects/ProductVariantsBulkInput , https://shopify.dev/docs/api/admin-graphql/latest/input-objects/InventoryItemInput |
| Alternative SKU write via `inventoryItemUpdate` | "Requires `write_inventory` access scope." | https://shopify.dev/docs/api/admin-graphql/latest/mutations/inventoryItemUpdate |
| Read `InventoryItem` (incl. sku) | "Requires `read_inventory` access scope or `read_products` access scope." | https://shopify.dev/docs/api/admin-graphql/latest/objects/InventoryItem |
| Read `InventoryLevel` | "Requires `read_inventory` access scope." | https://shopify.dev/docs/api/admin-graphql/latest/objects/InventoryLevel |
| Read `Location` | "Requires `read_locations` access scope, `read_inventory` access scope or `read_markets_home` access scope." So `read_inventory` alone may suffice for locations. | https://shopify.dev/docs/api/admin-graphql/latest/objects/Location |
| `publications` query | "Requires `read_publications` access scope." | https://shopify.dev/docs/api/admin-graphql/latest/queries/publications |
| `publishablePublish` / `publishableUnpublish` | "Requires `write_publications` access scope." | https://shopify.dev/docs/api/admin-graphql/latest/mutations/publishablePublish , https://shopify.dev/docs/api/admin-graphql/latest/mutations/publishableUnpublish |
| `productPublish` | "Deprecated. Use publishablePublish instead." | https://shopify.dev/docs/api/admin-graphql/latest/mutations/productPublish |
| `PriceList` (incl. FIXED-origin prices) | "Requires `read_products` access scope. Also: The user must have a permission to view catalogs." `read_markets` covers the `Market` object only. | https://shopify.dev/docs/api/admin-graphql/latest/objects/PriceList , https://shopify.dev/docs/api/usage/access-scopes |
| `read_publications`/`write_publications` | Also accepted as `read_channels`/`write_channels`. | https://shopify.dev/docs/api/usage/access-scopes |

**Minimal declared set:** `write_products, read_inventory, write_publications`.
- Add `read_locations` only if a `Location` field needs it beyond `read_inventory`.
- Add `write_inventory` only if the SKU test shows it is needed.
- `read_products` and `read_publications` are implied by their write scopes.

**Approval scopes and protected data:**
- Scopes marked "Shopify approval required" include `read_all_orders`, `read_users`, payments scopes and others. Declaring one before approval fails app-version creation. Source: https://shopify.dev/docs/api/usage/access-scopes
- Protected customer data: Level 0, "No customer data", means "No action required". Product queries are explicitly not protected customer data. Source: https://shopify.dev/docs/apps/launch/protected-customer-data
- In the submission flow you "can choose to opt out" if the app doesn't need protected customer data. Source: https://shopify.dev/docs/apps/launch/app-store-review/submit-app-for-review
- **Deploi needs no approval scopes and no protected customer data access**, provided it never adds order, customer, draft-order or fulfillment scopes.

---

## 6. Billing

### 6.1 Which method
Sources: https://shopify.dev/docs/apps/launch/billing , https://shopify.dev/docs/apps/launch/billing/shopify-app-pricing

- **New public apps:** use Shopify App Pricing. "It's the default when you submit a new public app". Configure plans, usage and trials in the **Partner Dashboard** instead of writing billing code.
- **Manual Pricing (legacy, Billing API):** still supported for existing integrations, one-time purchases and unsupported models.
- "Managed Pricing has been renamed to Shopify App Pricing".
- All App Store apps must use a Shopify-provided billing solution.
- "Once you opt in to Shopify App Pricing, you can't create new recurring application charges using the Billing API."

### 6.2 Shopify App Pricing details
Sources: https://shopify.dev/docs/apps/launch/billing/shopify-app-pricing , https://shopify.dev/docs/apps/launch/billing/shopify-app-pricing/plans , https://shopify.dev/docs/apps/launch/billing/shopify-app-pricing/redirect-plan-selection-page

- **Plan selection page:** Shopify hosts it at `https://admin.shopify.com/store/:store_handle/charges/:app_handle/pricing_plans`. `app_handle` is the TOML `handle`.
- **Redirect from the embedded app:** the page is outside the app frame, so use a top-level redirect (`target: "_top"`). In plain App Bridge this is `window.open(url, '_top')`. **UNVERIFIED** for non-React-Router apps: the official example uses the React Router `redirect` helper.
- **Do not** call `appSubscriptionCreate` or `billing.request`. Shopify creates the subscription when the merchant picks a plan.
- **Check the active subscription:** Partner API `activeSubscription(appId:, shopId:)`.
  - It needs a Partner API client with the **Manage apps** permission and works for public apps only.
  - Rate limit is 4 requests/second per client. Cache only confirmed subscriptions, briefly (about 5 minutes).
  - It returns Billing API and App Pricing subscriptions alike.
  - It needs the shop GID from `shop { id }`.
- **Welcome link (redirection URL):** set per plan. It can be a relative App Home path such as `/welcome`; Shopify appends `plan_handle`, and also `shop` for external URLs.
- **Plans:**
  - Plan types: free, monthly, yearly, and monthly-with-yearly-option recurring plans; usage plans; and combinations.
  - Up to 8 public plans. Private plans are unlimited, but each store can be authorized for at most 8 of them.
  - Prices are set in USD.
- **Free and beta merchants:**
  - Add a free plan.
  - Or use **private plans** limited to specific store domains. This is the official way to give beta merchants special pricing.
  - Discounts and trial extensions for individual merchants are set "in the Dev Dashboard". Source: https://shopify.dev/docs/apps/launch/billing/shopify-app-pricing/subscription-billing/offer-free-trials
- **Testing:**
  - On dev stores in the same Partner org, every plan is available at no charge. Shopify creates a contract with $0 effective prices.
  - Other orgs' dev stores get free plans and plans marked "Free for partners and developers".
  - There is also a $0 private test plan.
  - "Don't use the Billing API `test` field for this flow."
  - Source: https://shopify.dev/docs/apps/launch/app-store-review/pass-app-review
- **Upgrades and downgrades:** Shopify automates "billing, trials, proration, upgrades, and downgrades". This satisfies requirement 1.2.3 if the app sends merchants to the plan page.
- **Changes without a redirect** (cancel, freeze): query the Partner API, or the Partner API `events` (`SUBSCRIPTION_*`) query.

### 6.3 Billing API (Manual Pricing), if kept
Sources: https://shopify.dev/docs/api/admin-graphql/latest/mutations/appSubscriptionCreate (api_version 2026-10), https://shopify.dev/docs/apps/launch/billing/manual-pricing , https://shopify.dev/docs/apps/launch/billing/manual-pricing/subscription-billing , https://shopify.dev/docs/apps/launch/billing/manual-pricing/subscription-billing/create-time-based-subscriptions

- **`appSubscriptionCreate` arguments:**
  - `name` (String!)
  - `returnUrl` (URL!)
  - `lineItems` ([AppSubscriptionLineItemInput!]!), with `plan.appRecurringPricingDetails { price { amount currencyCode } interval }`. `interval` is `EVERY_30_DAYS` (default) or `ANNUAL`.
  - `trialDays` (Int)
  - `test` (Boolean, default false)
  - `replacementBehavior` (`AppSubscriptionReplacementBehavior`, default `STANDARD`)
  - It returns `appSubscription`, `confirmationUrl` and `userErrors`.
- **Flow:**
  1. Create the charge.
  2. Redirect the merchant to `confirmationUrl`.
  3. On approval, Shopify redirects to `returnUrl`. On decline, it redirects to the admin with a notice.
  - Upgrades and downgrades go through the same flow. One active subscription per merchant.
- **Status:** check `currentAppInstallation` (e.g. `activeSubscriptions`). Shopify's `billing.check()` "queries `currentAppInstallation`". Source: https://shopify.dev/docs/apps/launch/billing/shopify-app-pricing/redirect-plan-selection-page . Also subscribe to `APP_SUBSCRIPTIONS_UPDATE`.
- **Test charges:** set `test: true` on dev stores, then set it to false for production, "Otherwise, app users who install your app aren't charged." Source: https://shopify.dev/docs/apps/launch/app-store-review/pass-app-review
- **Proration:** upgrades are prorated; downgrades get prorated credits; some changes are deferred. Uninstall auto-cancels without credit.

---

## 7. Development-store testing and pre-approval installs

- **Create a dev store:**
  - CLI: `shopify store create dev --name ... --plan basic|grow|advanced|plus [--demo-data] [--feature-preview] [--country]`.
  - Or Dev Dashboard → Stores → Create store → Dev.
  - Limit 250 per org. Always password protected. Can't be converted to production or transferred.
  - Source: https://shopify.dev/docs/apps/build/stores/development-stores
- **Install your app on a dev store:** Dev Dashboard → Apps → your app → Installs → Install app → pick the dev store. Or use the CLI. Source: https://shopify.dev/docs/apps/launch/app-store-review/pass-app-review
- **CLI:**
  - `shopify app dev` "Builds and previews your app on a dev store". TOML changes apply automatically to the chosen dev store during `app dev`; `--no-update` keeps TOML URLs. Sources: https://shopify.dev/docs/api/shopify-cli/app/app-dev , https://shopify.dev/docs/apps/build/cli-for-apps/app-configuration
  - `shopify app deploy` creates and releases a version. `--no-release` creates one without releasing it. Source: https://shopify.dev/docs/api/shopify-cli/app/app-deploy
  - `shopify app config link` "Pulls app configuration from the Developer Dashboard and creates or overwrites a configuration file". Use it to bring the existing Deploi app under TOML management. Source: https://shopify.dev/docs/api/shopify-cli/app/app-config-link
- **Distribution method:**
  - Selected once in the Dev Dashboard and "can't change… after you select it". Source: https://shopify.dev/docs/apps/launch/distribution/select-distribution-method
  - Public: multiple stores, approval required.
  - Custom: one store, stores in one Plus org, or development stores; no App Store, but can use Shopify billing. Source: https://shopify.dev/docs/apps/launch/distribution
  - "If you have separate apps for development and production, then select the distribution method on the production app."
- **Installing a public app on non-dev stores before approval:**
  - **UNVERIFIED** on shopify.dev. Shopify staff in community forums state that an unapproved draft public app can only be installed on development stores.
  - Official docs confirm that "Unpublished apps" (public apps installable without approval) were deprecated in December 2019, and that custom distribution is the way to install on a specific production store without review. Source: https://shopify.dev/docs/apps/launch/distribution
- **Beta / limited audience before full listing:**
  - Official **limited visibility**: "Merchants can install both fully visible and limited visibility apps from an app listing page that uses a Shopify App Store URL". Only fully visible apps are indexed in categories, search and search engines. Change it under Partner Dashboard → Distribution → Manage listing → App Store visibility. Source: https://shopify.dev/docs/apps/launch/distribution/visibility
  - "Shopify's app requirements are the same for both fully visible and limited visibility public apps". A limited-visibility app still goes through full review. Source: https://shopify.dev/docs/apps/launch/app-store-review/review-process
  - Privacy-policy requirements are the same for both. Source: https://shopify.dev/docs/apps/launch/privacy-requirements
  - App Pricing **private plans** give per-store pricing for beta merchants (see §6.2).
- **Protected customer data on dev stores:** "You don't need to submit a request for review for apps that are installed only on development stores." Source: https://shopify.dev/docs/apps/launch/protected-customer-data

---

## 8. App review process

- **Steps:** complete the Shopify App Store review page in the Partner Dashboard. Source: https://shopify.dev/docs/apps/launch/app-store-review/submit-app-for-review
  1. Configuration: URLs, compliance webhooks, a 1200x1200 icon, and an API contact email without "Shopify".
  2. Emergency contact (email and phone).
  3. A listing in at least one primary language.
  4. Protected customer data request or opt-out.
  5. **Automated checks for common errors**, which must pass before submitting. The page does not enumerate them.
  6. Submit.
- **Statuses:** Draft → Submitted → (Paused if core requirements are blocked) → Reviewed (fixes discussed) → Published. You can withdraw at any time. Source: https://shopify.dev/docs/apps/launch/app-store-review/review-process
- **Cooldown:** a "Paused" cooldown applies for repeated failed exchanges, growing issue counts, no response, or refusing exemption outcomes. Source: https://shopify.dev/docs/apps/launch/app-store-review/submit-app-for-review
- **Automated checks known from official text:**
  - The ID-token or authentication check: "If your app's Shopify App Store review stalls on the automated authentication check, disable your ad blocker and reopen your app". Source: https://shopify.dev/docs/apps/build/authentication-authorization/id-tokens
  - Compliance-webhook presence and HMAC 401 behaviour: "If a mandatory compliance webhook sends a request with an invalid Shopify HMAC header, then the app must return a 401". Source: https://shopify.dev/docs/apps/build/compliance/privacy-law-compliance
  - **UNVERIFIED:** the full current list of automated checks (e.g. "immediately authenticates after install", "redirects to app UI"). It is not published on the pages read.
- **What reviewers need:**
  - Testing instructions, test credentials with full access and no 2FA/OTP/SSO (or static codes), and a step-by-step English screencast. Source: https://shopify.dev/docs/apps/launch/shopify-app-store/app-store-requirements
  - Best practices add "If your app integrates with third-party platforms, include valid test credentials that grant full access". Source: https://shopify.dev/docs/apps/launch/shopify-app-store/best-practices
  - **UNVERIFIED:** that reviewers install the app on their own (development) stores. Official pages don't say which store type reviewers use. Community posts say reviewers may ask for collaborator access to your dev store. **So a "dev store = free/unlocked" check may or may not trigger for reviewers. Don't depend on it.** Use a private plan, a free plan or test credentials instead.
- **Timeline:** **UNVERIFIED.** No official SLA appears on the current pages. Community reports (not official) mention historical guidance of 5–10 business days, with current waits of about 30 days.
- **Common rejection reasons (official table):** Source: https://shopify.dev/docs/apps/launch/app-store-review/pass-app-review
  - Billing: inaccurate pricing; no upgrade/downgrade; not using Shopify billing.
  - Installation: no immediate redirect to the OAuth grant screen; fatal error after install; reinstall broken.
  - Embedding: the app switches between embedded and non-embedded versions. Use App Bridge and session tokens.
  - UI: broken UI; 404/500/300 errors.
  - Testing: missing testing instructions or credentials; unfinished or unstable app. Include a short screencast.
  - Online store: no theme app extensions; widgets broken.
  - Also: "Submitting apps with errors, beta versions of apps… can delay the process or cause your app not to be approved." Source: https://shopify.dev/docs/apps/launch/app-store-review/submit-app-for-review
- **AI self-review:** the Shopify AI Toolkit can check a codebase against the requirements before submission. Source: https://shopify.dev/docs/apps/launch/app-store-review/pass-app-review
- **After listing:** ongoing quality checks. Respond within 7 days or the app is demoted; fix within 30 days or it may be unpublished. Source: https://shopify.dev/docs/apps/launch/app-store-review/app-quality-checks

---

## 9. Required policy pages

- **Privacy policy:** **required.** "you must provide a privacy policy and link to it from your Shopify App Store listing… same for both full and limited visibility apps." Source: https://shopify.dev/docs/apps/launch/privacy-requirements . Best practices also say "Include a privacy policy (required)". Source: https://shopify.dev/docs/apps/launch/shopify-app-store/best-practices
- Recommended contents, from https://shopify.dev/docs/apps/launch/privacy-requirements :
  - what is collected via Shopify APIs;
  - what is collected directly from merchants, including contact details and automated logs;
  - what is collected from merchants' customers (cookies or tracking);
  - how the data is used, and any other purposes;
  - retention period;
  - whether you are established in, or process data outside, Europe;
  - how merchants can contact you (some jurisdictions require a physical address).
  - Also consider data-subject rights processes, cross-border transfer safeguards and a DPO.
- **Deploi-specific privacy contents:** the policy should disclose the Gmail/Microsoft mailbox OAuth data (tokens, message metadata or content sent) and supplier contact data. This is an inference from the recommended contents, not a separate Shopify rule.
- **Terms of service:** **UNVERIFIED / not required by any page read.** No shopify.dev page lists a ToS as a listing requirement.
- **Support:** a support email is always required; a support portal URL is optional. Source: https://shopify.dev/docs/apps/launch/distribution/support-your-customers
- **FAQ, changelog and tutorial links:** optional and recommended. Link to dedicated pages, not promotional landing pages or cloud docs. Source: https://shopify.dev/docs/apps/launch/shopify-app-store/best-practices
- **Data deletion statement:** no separate page is required. The obligation is functional: compliance webhooks, with action within 30 days and `shop/redact` 48h after uninstall. Source: https://shopify.dev/docs/apps/build/compliance/privacy-law-compliance . Describing deletion and retention in the privacy policy is recommended ("For how long do you store or retain the data"). Source: https://shopify.dev/docs/apps/launch/privacy-requirements

---

## 10. Development-store detection, gating and beta audiences (coordinator follow-up)

### 10.1 Detecting a development store
Source: https://shopify.dev/docs/api/admin-graphql/latest/objects/ShopPlan (api_version 2026-10)

- `shop { plan { partnerDevelopment publicDisplayName shopifyPlus } }`:
  - `partnerDevelopment: Boolean!`: "Whether the shop is a partner development shop for testing purposes." It is **not deprecated** and is the supported boolean.
  - `publicDisplayName: String!`: the **newer** field. Possible values include "Development", "Plus Trial", "Trial", "Basic", "Grow", "Advanced", "Plus", "Paused", "Inactive" and others.
  - `shopifyPlus: Boolean!`: still current.
  - `displayName`: **Deprecated.** Replace any use of `displayName` with `publicDisplayName`.
- Recommended query: `shop { plan { partnerDevelopment publicDisplayName shopifyPlus } }`.
- **UNVERIFIED:** whether dev stores created on a chosen plan (`--plan basic|grow|advanced|plus` in the new Dev Dashboard flow) always report `partnerDevelopment: true`. Plan tiers can now be selected for dev stores (https://shopify.dev/docs/apps/build/stores/development-stores), so verify on a real dev store before relying on `publicDisplayName == "Development"`.

### 10.2 Do App Store reviewers install on development stores?
- **UNVERIFIED.** No official page states which store type reviewers use. The requirements put the burden on the developer to provide "test credentials and instructions that work without external authentication… that grant full feature access" (4.5.5). Source: https://shopify.dev/docs/apps/launch/shopify-app-store/app-store-requirements
- Practical implication: a dev-store check (e.g. "free on dev stores") cannot be relied on to unlock the app for reviewers. Ensure the reviewer gets full access whatever the store type: through a free or private App Pricing plan, a trial, or documented test credentials.

### 10.3 Gating behind an invite, approval or waitlist
- **No official page explicitly addresses invite, waitlist or approval gating.** UNVERIFIED as a stated policy. Requirements that bear on it:
  - 2.3.2: authenticate immediately, before any UI.
  - 2.1.3: must be operable through a UI.
  - 4.5.5: reviewers must get "full feature access".
  - 1.2.1: any charges go through Shopify billing.
  - Built for Shopify 3.1.3: users "should be able to start using the app immediately after installing it".
  - "beta versions of apps… can delay the process or cause your app not to be approved." Source: https://shopify.dev/docs/apps/launch/app-store-review/submit-app-for-review
  - Sources for the numbered items: https://shopify.dev/docs/apps/launch/shopify-app-store/app-store-requirements , https://shopify.dev/docs/apps/launch/built-for-shopify/requirements
- **Inference (UNVERIFIED):** a waitlist screen that blocks a reviewer from the core features would likely fail review (2.1.x / 4.5.5).
  - During review, the reviewer's store must reach full functionality, e.g. via an allowlist that includes reviewer access or credentials given in the testing instructions.
  - Once listed, a hard waitlist that leaves installed merchants with no working UI risks quality-check failures and listing-accuracy issues (requirement 2: "Apps must deliver on the features described in their app store listing").
  - Official mechanisms for a limited audience are **limited visibility** listings (not indexed, installable from the listing URL) and **private plans**.

### 10.4 Limited visibility / unlisted listings for beta merchants
- Official: "Limit visibility" is set in Partner Dashboard → Apps → app → Distribution → Manage listing → App Store visibility. Source: https://shopify.dev/docs/apps/launch/distribution/visibility
- Merchants can still install from the App Store listing URL. The listing isn't indexed in categories, search or search engines.
- The same requirements and review apply as for fully visible apps. Source: https://shopify.dev/docs/apps/launch/app-store-review/review-process
- By default, approved listings are fully visible. Source: https://shopify.dev/docs/apps/launch/app-store-review/review-process
- Visibility can be changed "at any time". Source: https://shopify.dev/docs/apps/launch/distribution/visibility

---

## Implications for Deploi (priority order)

1. **Switch offline tokens to expiring tokens with refresh (blocking for review, requirement 3.1.2).**
   - Send `expiring=1` on every token request.
   - Persist `refresh_token`, `expires_at` and `refresh_token_expires_at`.
   - Refresh before expiry with `grant_type=refresh_token`, with a per-shop lock on Vercel.
   - Treat a refresh `401 invalid_request` as "re-run token exchange on next open".
   - Migrate existing installs.
2. **Move install and auth to managed installation plus token exchange.**
   - Create or link `shopify.app.toml` (`shopify app config link`): `embedded = true`, scopes, no `use_legacy_install_flow`.
   - Run `shopify app deploy`.
   - In the embedded UI, obtain tokens via `shopify.idToken()` and the backend `/exchange`.
   - Keep the code-grant `auth/start` and `auth/callback` only for the standalone (non-embedded) UI, if at all. Never ask for a shop domain during install or configuration (2.3.1).
   - Make sure the first load after install authenticates immediately and lands in the app UI (2.3.2/2.3.3), including after a reinstall (2.3.4).
3. **Harden the ID-token endpoint.**
   - HS256 with the client secret; check `aud`, `exp`, `nbf` and that the `iss`/`dest` hosts match.
   - On failure return 401 plus `X-Shopify-Retry-Invalid-Session-Request: 1`. Map a token-endpoint 400 to the same response.
   - Remove any reliance on cookies or `localStorage` in `/shopify/*` (1.1.1; test in Chrome incognito).
4. **Load App Bridge correctly.** Put `<meta name="shopify-api-key" content="<client id>">` and `<script src="https://cdn.shopify.com/shopifycloud/app-bridge.js">` as the first script in the `<head>` of every `/shopify/*` document (2.2.3).
5. **Compliance webhooks.**
   - Declare `compliance_topics` (all three) plus `app/uninstalled` in TOML with `api_version = "2026-10"`.
   - Verify HMAC on the raw body and return 401 on mismatch.
   - Return 200 within 5s. Dedup on `X-Shopify-Webhook-Id`.
   - `shop/redact` purges all shop data. `customers/*` are no-ops that log and return 200.
6. **Rework billing for Shopify App Pricing (default for new public apps).**
   - Define plans in the Partner Dashboard: a free plan or trial, plus private plans for beta merchants.
   - Remove `appSubscriptionCreate` calls.
   - Redirect to `admin.shopify.com/store/{store}/charges/{handle}/pricing_plans` at `_top`.
   - Gate features with Partner API `activeSubscription`, which requires a Partner API client token stored as a secret.
   - If Deploi must stay on the Billing API (Manual Pricing), implement `test: true` on dev stores, re-approval on reinstall, upgrade/downgrade without support (1.2.2/1.2.3) and the `APP_SUBSCRIPTIONS_UPDATE` webhook.
7. **Scopes.**
   - Declare `write_products, read_inventory, write_publications`, plus `read_locations` only if needed.
   - Verify on a dev store whether SKU via `productVariantsBulkUpdate.inventoryItem` needs `write_inventory`.
   - Replace any `productPublish`/`productUnpublish` with `publishablePublish`/`publishableUnpublish`.
   - GraphQL only, no REST (2.2.4). Pin `2026-10`.
8. **Use `shop.plan.partnerDevelopment` and `publicDisplayName`** for dev-store detection, replacing `displayName`. Do not rely on dev-store detection to unlock the app for reviewers.
9. **Embedded parity for off-platform features (2.2.2; Built for Shopify 3.1.5).** Gmail/Microsoft mailbox connect and disconnect, and the core workflows, should be reachable inside the embedded app. Avoid pop-ups for essential OAuth where possible. Give reviewers a way to test supplier email (test mailbox credentials without 2FA, or a sandbox mode) (4.5.5).
10. **Listing and submission assets.**
    - Privacy policy URL (cover mailbox data, retention and deletion).
    - Support email.
    - 1200x1200 icon.
    - 3–6 1600x900 screenshots.
    - English setup screencast.
    - Testing instructions and credentials.
    - Emergency developer contact.
    - App URL and contact email without "Shopify"/"Example".
    - Name consistent with TOML `name`.
    - Accurate pricing in Pricing details only.
11. **Beta strategy.** Use a limited-visibility listing (still fully reviewed) and/or private plans for beta merchants. Before approval, only development stores can be used. Shopify staff say this in community forums, but no shopify.dev page states it, so it is UNVERIFIED. For a live pilot store before approval, the official route is a separate custom-distribution app, because the distribution method can't be changed.
