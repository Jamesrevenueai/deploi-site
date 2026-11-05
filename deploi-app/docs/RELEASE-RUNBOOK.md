# Release runbook: hotfix, then the platform release

Every step here needs the owner: it changes production, or needs credentials only the owner holds.
Nothing in this runbook has been run against preview or production. Each step lists its check and its
rollback.

Projects:

| Project | Supabase ref | Vercel project | Git branch |
|---|---|---|---|
| Production | `deploi-prod` (`makqaqzlylhckijdbjzi`) | `deploi-app` | `main` |
| Preview | `deploi-preview` (`bhddgjcefwasdyrrfptc`) | `deploi-app` | every other branch |

## 0. Today, before anything else: the F-02 hotfix (PR #17)

Follow `docs/HOTFIX-F02.md` (on the hotfix branch):
1. Turn off email sign-up.
2. Audit staff profiles.
3. Paste `docs/hotfix/F02-hotfix.sql` into the production SQL editor.
4. Merge PR #17 into `main`.

The checks are in that document. It is independent of everything below.

## 1. Preview database: apply both releases

On a machine with `SUPABASE_ACCESS_TOKEN` for the account (or the proxy that adds it), from `deploi-app/` on
the release branch:

```bash
npx tsx scripts/launch-migrations.ts status  --set=2026-11-04 --http=bhddgjcefwasdyrrfptc --confirm-production=bhddgjcefwasdyrrfptc
npx tsx scripts/launch-migrations.ts dry-run --set=2026-11-04 --http=bhddgjcefwasdyrrfptc --confirm-production=bhddgjcefwasdyrrfptc
npx tsx scripts/launch-migrations.ts apply   --set=2026-11-04 --http=bhddgjcefwasdyrrfptc --confirm-production=bhddgjcefwasdyrrfptc
npx tsx scripts/launch-migrations.ts dry-run --set=2026-11-05 --http=bhddgjcefwasdyrrfptc --confirm-production=bhddgjcefwasdyrrfptc
npx tsx scripts/launch-migrations.ts apply   --set=2026-11-05 --http=bhddgjcefwasdyrrfptc --confirm-production=bhddgjcefwasdyrrfptc
# then any later sets listed in scripts/launch-migrations.ts (SETS), in date order
```

- **Check:** `status` lists every file as applied.
- **Rollback:** `rollback` set by set, newest first. The tool refuses an older set while a newer one is applied. Add `--discard-data` only when losing the rows those releases created is acceptable.

The same steps are rehearsed locally by `scripts/test-release-2026-11-04-migrations.sh` and
`scripts/test-release-2026-11-05-migrations.sh`, which run on every change.

## 2. Preview deployment: smoke test

The PR's Vercel preview builds automatically. Then:

```bash
npx tsx scripts/smoke-check.ts https://deploi-app-git-claude-deploi-operating-system-james-ai.vercel.app
```

The script is read-only. It checks:
- health;
- the sign-in redirect;
- a public page;
- the CSP header;
- that cron routes refuse without the secret.

Sign in on the preview with a test account and walk through:
1. Connect a test store, or the synthetic one.
2. Discovery: "We found work".
3. Set up the team.
4. Grant one agent at drafts only.
5. Open a case.
6. Approve.
7. Find it in Completed Work.

## 3. Production database

This needs a maintenance window. The migrations are additive: they change no existing row except where a
migration says so, and the rehearsals keep existing rows intact.

1. Take a backup: Supabase → Database → Backups → confirm the latest daily backup or point-in-time recovery position, and write the time down.
2. Run the same commands as step 1 with `--http=makqaqzlylhckijdbjzi --confirm-production=makqaqzlylhckijdbjzi`, dry-run before each apply.

- **Check:** `status` for every set.
- **Rollback:** as in step 1, newest set first; restore from the backup only as a last resort (`docs/BACKUP-RESTORE.md`).

## 4. Production environment variables (Vercel → deploi-app → Settings → Environment Variables → Production)

Required before the release is useful:
- `CREDENTIALS_ENCRYPTION_KEY` (base64 of 32 random bytes) and `CREDENTIALS_KEY_ID`.
- `CRON_SECRET` (already set).
- `NEXT_PUBLIC_APP_URL`.

Then per integration, as each one is set up: the variables named in `docs/SHOPIFY-SETUP.md`,
`docs/WOOCOMMERCE-SETUP.md`, `docs/EMAIL-SETUP.md`, `docs/OFFICE-SETUP.md` and `docs/QUICKBOOKS-SETUP.md`, plus Stripe
(`STRIPE_*`) for billing.

Keep these as they are until each one is deliberately changed:
- `EMAIL_LIVE_SENDS=off` until a mailbox domain is verified, then `allowlist`.
- `BILLING_MODE=off`.
- `LEGAL_GATE=off` until counsel signs off, then `enforce`.
- `AI_PROVIDER` unset.

## 5. Production deployment

Merge PR #16 into `main`. Vercel builds and promotes it. Then run `scripts/smoke-check.ts` against
`https://app.getdeploi.com`.

**Rollback:** Vercel → deploi-app → Deployments → the previous production deployment → Promote. This
reverts the app instantly, and the database can stay on the new migrations.

`scripts/test-app-rollback-compat.sh` proves this: `main` plus the hotfix passed its whole suite (304/304) on a
database migrated with every migration on this branch (2026-11-05). Rerun the script before the release.

## 6. After the release

- Uptime checks and log drains: `docs/MONITORING.md`.
- The first live runs: readiness report §5, items 4–7.
