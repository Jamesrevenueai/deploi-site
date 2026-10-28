# DNS for launch: getdeploi.com to the new site, and email that does not land in spam

The public DNS was read on 2026-10-28 through Google DNS, and the recommended records come from the Vercel domain-config API. Nothing has been changed. The DNS for `getdeploi.com` is hosted at **Squarespace** (`nsa1–4.squarespacedns.com`), so every change below is made in Squarespace → Domains → getdeploi.com → DNS.

## What the DNS says today

| Name | Type | Value today | Meaning |
|---|---|---|---|
| `getdeploi.com` | A | 198.185.159.144/145, 198.49.23.144/145 | Squarespace "Coming Soon" page |
| `www.getdeploi.com` | CNAME | `ext-sq.squarespace.com.` | Squarespace |
| `app.getdeploi.com` | CNAME | `1526939709879341.vercel-dns-016.com.` | Vercel (`deploi-app`), already correct |
| `getdeploi.com` | TXT (SPF) | `v=spf1 -all` | **No server may send mail as @getdeploi.com** |
| `_dmarc.getdeploi.com` | TXT | `v=DMARC1; p=reject; sp=reject; adkim=s; aspf=s` | Receivers **reject** mail that fails DMARC, for the domain *and every subdomain*, with strict alignment |
| `getdeploi.com` | MX | none | The domain receives no mail |

The SPF and DMARC records are a safe parked-domain setup. They also mean that, until the steps in section B are done, every email Deploi sends from `hello@getdeploi.com` (weekly summary, morning reports) or from an agent address will be rejected.

## A. Point getdeploi.com at the new website (Vercel project `deploi-site`)

The domains are already attached to the project in Vercel (`getdeploi.com` is primary; `www` 308-redirects to the apex). Only DNS is missing.

1. In Squarespace DNS, **delete** the four Squarespace A records on `@`, and the `www` CNAME to `ext-sq.squarespace.com`. If Squarespace keeps them locked under "Squarespace Defaults", turn off the Squarespace website on this domain first.
2. **Add**:

   | Host | Type | Value | Source |
   |---|---|---|---|
   | `@` | A | `216.150.1.1` | Vercel recommendation, rank 1 |
   | `@` | A | `216.150.16.1` | Vercel recommendation, rank 1 |
   | `www` | CNAME | `f7bab32ca6f31b92.vercel-dns-016.com.` | Vercel recommendation, rank 1 |

   Vercel's older generic values (`76.76.21.21` and `cname.vercel-dns.com`) also work. Use one set, not both.
3. Leave `app` (the CNAME to Vercel) as it is.
4. Wait for Vercel → `deploi-site` → Settings → Domains to show both names as **Valid Configuration**. Vercel then issues the certificates.
5. Check: `curl -sI https://getdeploi.com` should show `server: Vercel`, and `https://www.getdeploi.com` should 308-redirect to `https://getdeploi.com`.

Which deployment answers depends on the production alias, which is the rolled-back `dpl_8HAGqN8eJncDQ4JS6fbpWK7onHWY` today (`PRODUCTION-SAFETY.md`).

## B. Email: agent addresses on a subdomain, and hello@getdeploi.com

Use a **separate subdomain for agents**, `agents.getdeploi.com` (`AGENT_MAIL_DOMAIN=agents.getdeploi.com`). Agents and suppliers then have their own sending reputation and their own MX, and the main domain is not affected.

### B1. Resend: add and verify `agents.getdeploi.com` (sending and receiving)

1. Resend → Domains → Add domain → `agents.getdeploi.com`, then enable **Receiving** on the domain page.
2. Resend shows the exact records for this domain. Copy them **exactly as Resend shows them**; its docs say the values are generated per domain. They are normally:

   | Host (in Squarespace, relative to getdeploi.com) | Type | Value | Purpose |
   |---|---|---|---|
   | `resend._domainkey.agents` | TXT | the `p=…` DKIM key from Resend | **DKIM** (signs as `d=agents.getdeploi.com`) |
   | `send.agents` | MX | `feedback-smtp.<region>.amazonses.com`, priority 10 (as shown) | bounce handling for the Return-Path |
   | `send.agents` | TXT | `v=spf1 include:amazonses.com ~all` (as shown) | **SPF** for the Return-Path domain |
   | `agents` | MX | the receiving host Resend shows (for example `inbound-smtp.<region>.amazonaws.com`), the **lowest** priority on this name | **inbound** mail to agent addresses |

   Do not proxy anything; this matters only if DNS ever moves to Cloudflare.
3. **DMARC** for the subdomain. Add a record that overrides the parent's `sp=reject` with a policy you can watch first:

   | Host | Type | Value |
   |---|---|---|
   | `_dmarc.agents` | TXT | `v=DMARC1; p=none; rua=mailto:dmarc@getdeploi.com; adkim=s; aspf=r` |

   - `adkim=s` passes, because Resend signs with `d=agents.getdeploi.com`, which matches the From domain exactly.
   - `aspf=r` lets SPF on `send.agents.getdeploi.com` align. Under the parent's `aspf=s` it would not align, and DMARC would then rest on DKIM alone.
   - After a week of clean reports, move to `p=quarantine`, then to `p=reject`.
   - `rua` needs a mailbox that receives mail. Use any address you read, or remove the tag.
4. Wait for Resend to show the domain **Verified** (often minutes, up to 72 hours).

### B2. hello@getdeploi.com (weekly summary and system mail)

The root domain says `v=spf1 -all` and has no DKIM, so this mail is rejected today. Either:

- **Option 1 (recommended): verify `getdeploi.com` itself in Resend.**
  - Add Resend's `resend._domainkey` TXT, plus the `send` MX and TXT it shows.
  - Leave the root SPF at `v=spf1 -all`: Resend's Return-Path is `send.getdeploi.com`, which gets its own SPF record.
  - DKIM with `d=getdeploi.com` passes the strict `adkim=s`.
- **Option 2:** send system mail from the agents subdomain (for example `deploi@agents.getdeploi.com`). Set `COMPANY_EMAIL` accordingly; this is a code constant in `lib/env.ts` today.

### B3. App configuration (Vercel → `deploi-app` → Production)

| Variable | Value |
|---|---|
| `AGENT_MAIL_DOMAIN` | `agents.getdeploi.com` |
| `RESEND_API_KEY` | a Resend API key with send permission |
| `AGENT_MAIL_WEBHOOK_SECRET` | signing secret of the webhook below (`whsec_…`) |
| `EMAIL_LIVE_SENDS` | `off` until tested, then `allowlist` with `EMAIL_TEST_RECIPIENTS` set to **your dedicated test address**, then `all` only with your approval |

Resend → Webhooks → Add endpoint `https://app.getdeploi.com/api/webhooks/agent-mail`, event **`email.received`**. Without the secret, the endpoint refuses every delivery (503). With it, unsigned or more than 5-minute-old deliveries are refused (403).

### B4. Verify (needs your test address; not done)

1. Create an agent from the Supplier Chaser template with your test address as the supplier, grant it, and widen email to "After my approval".
2. Run it, approve the restock request, and check that it arrives at the test address **in the inbox, not spam**. In the message headers, `Authentication-Results` should show `dkim=pass header.d=agents.getdeploi.com` and `dmarc=pass`.
3. Reply from the test address. On the agent page → Agent mailbox, the reply should show as **Reply · Accepted**, and the original message's reply count goes to 1.
4. Send from a different address. It should show as **Quarantined**.

## C. Gmail and Microsoft 365

These connectors stay in the code. They are **not live-verified** and are **off by default**: they appear only when `EMAIL_OAUTH_PROVIDERS=on` and their OAuth clients are configured. No Gmail restricted scope is requested by the agent-mailbox path.
