# Cookie Notice

> **DRAFT — NOT REVIEWED BY COUNSEL — DO NOT PUBLISH**
>
> Working draft. The cookie list below is taken from the code as of 2026-11-04 (`lib/auth.ts`,
> `middleware.ts`, `lib/supabase/*`, `app/api/shopify/auth/*`, `lib/client/preview-bypass.ts`).

| Field | Value |
|---|---|
| Document key | `cookies` |
| Version | 0.1.0-draft |
| Effective date | [EFFECTIVE DATE — set on publication] |
| Last updated | 2026-11-04 |

## Summary

Deploi uses **only strictly necessary cookies**: to keep you signed in, to protect sign-in and install
flows, and (on protected test deployments only) to pass the hosting provider's access check. We do
**not** use analytics, advertising, social-media or session-replay cookies or pixels, on the website or
in the app, and we do not set cookies on the storefronts of the stores you connect. Because the cookies
are strictly necessary, no consent banner is shown [COUNSEL: confirm for EEA/UK — REVIEW-CHECKLIST C-1].

## Cookies the app sets

| Cookie | Set by | Purpose | Duration |
|---|---|---|---|
| `sb-<project>-auth-token` (may be split into `.0`, `.1`) | Supabase Auth on `app.getdeploi.com` | Keeps you signed in after you open the one-time sign-in link | Session refresh; up to the Supabase refresh-token lifetime |
| `deploi_dev_session` | The app, **only on non-production test environments** with development sign-in | Test sign-in; refused in production | Session |
| `deploi_shopify_state` | `/api/shopify/auth` | Protects the Shopify install flow against forgery (random state value) | 10 minutes, limited to `/api/shopify/auth` |
| `_vercel_jwt` / Vercel protection-bypass cookie | Vercel, on protected preview deployments only | Lets invited testers reach a password-protected preview | Session |

Inside the Shopify admin, the embedded app authenticates each request with a short-lived session token
from Shopify (an `Authorization` header), not with a Deploi cookie.

## Other technologies

- **Session storage**: on protected preview deployments opened from the Shopify admin, the app keeps the
  preview access value from the launch link in the tab's session storage (`deploi.previewBypass`) so its
  own requests can pass the hosting provider's check. It is cleared when the tab closes and is never used
  for tracking.
- **Fonts**: the website requests the Inter typeface from Google Fonts, so your browser connects to
  Google's servers, which receive your IP address. [COUNSEL/ENGINEERING: consider self-hosting the font —
  REVIEW-CHECKLIST C-2.]
- **Stripe**: when you open Stripe Checkout or the Stripe customer portal you are on Stripe's own pages,
  which set Stripe's cookies for fraud prevention under Stripe's cookie policy.

## Managing cookies

You can block or delete cookies in your browser settings. If you block the sign-in cookie you cannot stay
signed in to the app.

## Changes

We will update this notice when the cookies change.
