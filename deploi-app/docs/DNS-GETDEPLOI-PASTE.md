# getdeploi.com DNS: one table to paste (Squarespace → Domains → getdeploi.com → DNS)

Written 2026-11-01. The live DNS was read through Google DNS that day:
- `@` has 4 Squarespace A records;
- `www` is a CNAME to `ext-sq.squarespace.com`;
- SPF is `v=spf1 -all`;
- DMARC is `p=reject; sp=reject; adkim=s; aspf=s`;
- there is no MX;
- `app` is a CNAME to Vercel, which is already correct; leave it.

## Delete first

| Host | Type | Value |
|---|---|---|
| `@` | A | `198.185.159.144`, `198.185.159.145`, `198.49.23.144`, `198.49.23.145` (all four) |
| `www` | CNAME | `ext-sq.squarespace.com` |

If Squarespace locks them under "Squarespace Defaults", turn off the Squarespace website on this domain first.

## Add

| # | Host | Type | Priority | Value | Purpose |
|---|---|---|---|---|---|
| 1 | `@` | A | — | `76.76.21.21` | website (Vercel project `deploi-site`) |
| 2 | `www` | CNAME | — | `cname.vercel-dns.com` | www → Vercel (Vercel 308-redirects it to the apex) |
| 3 | `send` | MX | 10 | `feedback-smtp.us-east-1.amazonses.com` | Resend bounce / Return-Path |
| 4 | `send` | TXT | — | `v=spf1 include:amazonses.com ~all` | **SPF** for Resend's Return-Path |
| 5 | `resend._domainkey` | TXT | — | `p=…` **copied from Resend → Domains → getdeploi.com** | **DKIM** (`d=getdeploi.com`) |
| 6 | `_dmarc` | TXT (**replace** the existing value) | — | `v=DMARC1; p=quarantine; sp=reject; adkim=s; aspf=r; rua=mailto:hello@getdeploi.com` | **DMARC** |

Rows 3–5 assume the domain is added in Resend's default region, us-east-1:
- Resend → Domains → Add → `getdeploi.com`.
- Resend generates the DKIM key in row 5 for this domain. Nobody can know it before the domain is added, so copy it exactly.
- If Resend shows a different region in rows 3–4, use Resend's values.

Leave the root SPF (`@` TXT `v=spf1 -all`) as it is. Resend sends with a Return-Path on `send.getdeploi.com`, which row 4 covers.

Why this DMARC:
- `adkim=s` still passes, because Resend signs with `d=getdeploi.com`.
- `aspf=r` lets the `send.` SPF align.
- `p=quarantine` instead of `reject` keeps a mistake recoverable for the first weeks. Move it back to `p=reject` after a week of clean reports.
- `rua` only works once `hello@` receives mail (see below).

## Optional, not in the table above

- **Agent mailboxes** (`AGENT_MAIL_DOMAIN=agents.getdeploi.com`): add the same three Resend records with `.agents` appended to each host (`send.agents`, `resend._domainkey.agents`). Add the receiving MX on `agents` that Resend shows once Receiving is enabled. Add `_dmarc.agents` TXT `v=DMARC1; p=none; adkim=s; aspf=r`. Details are in `LAUNCH-DNS.md` §B1.
- **Receiving mail at hello@getdeploi.com:** there is no MX on `@`, so mail to hello@ bounces today. Add your mailbox provider's MX if you want it. Resend's records above are for sending only.

## Check after saving

```
curl -sI https://getdeploi.com | grep -i server       # server: Vercel
curl -sI https://www.getdeploi.com | grep -i location  # https://getdeploi.com/
```

Also check:
- Vercel → `deploi-site` → Domains shows both names as **Valid Configuration**;
- Resend → Domains → getdeploi.com shows **Verified**.
